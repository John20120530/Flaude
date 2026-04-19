/**
 * Interactive PTY terminal (D7).
 *
 * Mounts xterm.js into a container, spawns a shell under a PTY via the Rust
 * backend, and wires the two together bi-directionally:
 *   PTY stdout → `pty:data:{id}` Tauri event → term.write()
 *   term.onData (keystrokes) → pty_write command
 *   term.onResize (window changed) → pty_resize command
 *
 * Lifecycle is effect-scoped: one PTY per Terminal instance. When the
 * workspace prop changes or the component unmounts, we kill the PTY and
 * dispose the xterm instance. There's a subtle ordering trap — if the user
 * unmounts during the async create, we must NOT leak a live PTY, so the
 * effect sets a `disposed` flag the create-chain checks before wiring up.
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { isTauri } from '@/lib/tauri';
import {
  ptyCreate,
  ptyWrite,
  ptyResize,
  ptyKill,
  ptyListenData,
  ptyListenExit,
} from '@/lib/pty';

interface Props {
  /** Working directory for the shell. Undefined = shell default (usually HOME). */
  workspace?: string;
}

export default function Terminal({ workspace }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const container = containerRef.current;
    if (!container) return;

    // Disposal flag captured by the async chain below. Any await point has
    // to check this before mutating state — otherwise a fast
    // mount/unmount during shell startup leaves an orphaned child process.
    let disposed = false;

    let term: XTerminal | null = null;
    let fitAddon: FitAddon | null = null;
    let ptyId: string | null = null;
    const unsubs: Array<() => void> = [];
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      term = new XTerminal({
        // Same stack as the code blocks in messages — visually consistent
        // when the user flips between chat and terminal.
        fontFamily: "'JetBrains Mono', Consolas, 'Cascadia Mono', monospace",
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        // PowerShell / cmd send \n only on Enter; convertEol makes xterm
        // treat bare \n as \r\n so lines don't "stair-step" off the screen.
        convertEol: true,
        scrollback: 5000,
        theme: {
          background: '#1b1b19',
          foreground: '#e6e1cf',
          cursor: '#d97757',
          cursorAccent: '#1b1b19',
          selectionBackground: '#d9775755',
          black: '#2b2b29',
          red: '#e5484d',
          green: '#6c9a6c',
          yellow: '#d4b87a',
          blue: '#7a9ec4',
          magenta: '#c48cb8',
          cyan: '#7abfbf',
          white: '#e6e1cf',
          brightBlack: '#6b6b68',
          brightRed: '#f26a6f',
          brightGreen: '#8cbc8c',
          brightYellow: '#e6d09a',
          brightBlue: '#9abfdf',
          brightMagenta: '#d9aacf',
          brightCyan: '#9ad4d4',
          brightWhite: '#fafaf7',
        },
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      if (disposed) {
        term.dispose();
        return;
      }
      term.open(container);

      // First fit — the container already has layout at this point. If it
      // doesn't (container:0x0), fit() will throw; that's usually fine,
      // ResizeObserver will retry when a real size lands.
      try {
        fitAddon.fit();
      } catch {
        /* ignore, observer retries */
      }

      try {
        ptyId = await ptyCreate({
          workspace: workspace || undefined,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (e) {
        if (!disposed) setError((e as Error).message);
        return;
      }

      if (disposed) {
        // Mount/unmount raced — kill the PTY we just created.
        if (ptyId) void ptyKill(ptyId);
        return;
      }

      // PTY → xterm
      unsubs.push(
        await ptyListenData(ptyId, (chunk) => {
          term?.write(chunk);
        })
      );
      unsubs.push(
        await ptyListenExit(ptyId, () => {
          // Dim gray marker so the user knows the shell exited and
          // keystrokes won't go anywhere. `\x1b[0m` resets the color.
          term?.writeln('\r\n\x1b[90m[进程已退出]\x1b[0m');
        })
      );

      // xterm → PTY
      const dataDisp = term.onData((data) => {
        if (ptyId) void ptyWrite(ptyId, data);
      });
      const resizeDisp = term.onResize(({ cols, rows }) => {
        if (ptyId) void ptyResize(ptyId, cols, rows);
      });
      // xterm's onData/onResize return IDisposables; clean them up on
      // effect teardown so we don't post writes to a dead PTY id.
      unsubs.push(() => dataDisp.dispose());
      unsubs.push(() => resizeDisp.dispose());

      // Keep xterm sized to the container. `fit()` is cheap; letting the
      // observer debounce is unnecessary for typical panel resizes.
      resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon?.fit();
        } catch {
          /* container transiently 0x0, ignore */
        }
      });
      resizeObserver.observe(container);

      // Nudge focus so the user can start typing immediately without a
      // second click. Harmless if the tab isn't visible yet.
      term.focus();
    })();

    return () => {
      disposed = true;
      for (const u of unsubs) {
        try {
          u();
        } catch {
          /* ignore disposal errors */
        }
      }
      resizeObserver?.disconnect();
      if (ptyId) void ptyKill(ptyId);
      term?.dispose();
    };
  }, [workspace]);

  if (!isTauri()) {
    return (
      <div className="p-3 font-mono text-xs text-claude-muted dark:text-night-muted">
        $ 终端仅在桌面版可用（pnpm tauri dev）。
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 font-mono text-xs text-red-500">
        终端启动失败：{error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      // xterm needs a concrete-sized block; the h-full inherits from the
      // tab panel's 148px fixed height in CodeView. The inner `.xterm`
      // canvas fills this box.
      className="w-full h-full bg-[#1b1b19] p-1 overflow-hidden"
    />
  );
}
