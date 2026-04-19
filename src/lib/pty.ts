/**
 * PTY (pseudo-terminal) bridge.
 *
 * Thin typed wrappers over the Rust `pty_*` commands in src-tauri/src/pty.rs,
 * plus two helpers for subscribing to the data/exit event channels that the
 * Rust side emits. The Terminal component ties these together with xterm.js.
 *
 * All calls throw outside Tauri — interactive shells require the native
 * backend.
 */

import { tauriInvoke } from './tauri';

export interface CreatePtyOptions {
  /** Working directory for the shell. If omitted, shell default is used. */
  workspace?: string;
  /**
   * Shell executable. Defaults: `powershell.exe` on Windows, `$SHELL` (or
   * `/bin/bash`) elsewhere. Override for e.g. bash on Windows or zsh on macOS.
   */
  shell?: string;
  /** Initial column count. xterm.js will resize to its measured fit shortly after. */
  cols?: number;
  /** Initial row count. */
  rows?: number;
}

/** Spawn a shell under a PTY and return its id. */
export function ptyCreate(opts: CreatePtyOptions = {}): Promise<string> {
  return tauriInvoke<string>('pty_create', {
    workspace: opts.workspace,
    shell: opts.shell,
    cols: opts.cols,
    rows: opts.rows,
  });
}

/** Send raw bytes (usually a keystroke or pasted text) to the PTY's stdin. */
export function ptyWrite(id: string, data: string): Promise<void> {
  return tauriInvoke<void>('pty_write', { id, data });
}

/**
 * Inform the PTY that its window size changed. Without this call, line-wrap,
 * TUI redraws (vim, htop), and `$(tput cols)` will all use the old size.
 */
export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return tauriInvoke<void>('pty_resize', { id, cols, rows });
}

/** Kill the child process and drop the PTY handle. Safe to call multiple times. */
export function ptyKill(id: string): Promise<void> {
  return tauriInvoke<void>('pty_kill', { id });
}

/**
 * Subscribe to the PTY's output stream. The callback receives UTF-8 chunks
 * as they arrive (typically within a few ms of the shell writing them).
 * Returns an unlisten function — always call it in your cleanup to avoid
 * leaking event handlers across component remounts.
 */
export async function ptyListenData(
  id: string,
  onData: (chunk: string) => void
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<string>(`pty:data:${id}`, (ev) => onData(ev.payload));
}

/**
 * Subscribe to the PTY's exit event. Fires once, when the child process
 * closes its stdout (natural exit, crash, or kill). Useful for rendering a
 * "[process exited]" marker in the terminal.
 */
export async function ptyListenExit(
  id: string,
  onExit: () => void
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen(`pty:exit:${id}`, () => onExit());
}
