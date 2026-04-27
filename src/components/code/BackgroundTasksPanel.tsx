/**
 * BackgroundTasksPanel — bottom-tab content for "what's running in the
 * background?" Visualizes the bgshell registry the agent populates via
 * shell_start / shell_read / shell_kill.
 *
 * Why a separate panel vs. surfacing in the chat: the agent calls
 * shell_start for things like `pnpm test --watch`, `docker logs -f`,
 * dev servers, etc. These can run for hours. Without a panel, the user
 * has to scroll back through chat history to find the original tool
 * call, and there's no way to inspect *current* output without asking
 * the agent to call shell_read. With a panel, the user owns visibility
 * — they see what's alive, what's done, can read live output, and kill
 * anything they don't want anymore (without needing the agent in the
 * loop).
 *
 * Polling cadence is 2 s — fast enough that "is my watcher still
 * running?" feels live, slow enough that we don't burn CPU on every
 * conversation render. The hook self-pauses when this tab isn't active.
 *
 * Output viewer is on-demand: clicking a row's "查看输出" toggles an
 * expanded section that fires shell_read once. Re-clicking refreshes.
 * We don't poll output continuously because (a) the bgshell ring buffer
 * already retains 256 KB, (b) two-fold polling (list + per-row read)
 * scales badly with many tasks, and (c) most users only want output on
 * the one task they're investigating, not all of them.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Skull,
  Trash2,
} from 'lucide-react';
import { useBackgroundTasks } from '@/hooks/useBackgroundTasks';
import { isTauri, shellRead, type BgShellInfo, type BgShellReadResult } from '@/lib/tauri';
import { cn } from '@/lib/utils';

export default function BackgroundTasksPanel({ active }: { active: boolean }) {
  const { tasks, refresh, kill, remove, loading, error } = useBackgroundTasks({
    active,
  });

  if (!isTauri()) {
    return (
      <div className="p-4 text-xs text-claude-muted dark:text-night-muted">
        后台任务仅在桌面版可用。浏览器版没有 shell 子系统。
      </div>
    );
  }

  const running = tasks.filter((t) => t.running);
  const finished = tasks.filter((t) => !t.running);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-claude-border/50 dark:border-night-border/50">
        <span className="text-claude-ink dark:text-night-ink">
          {running.length} 运行
          {finished.length > 0 && ` · ${finished.length} 完成`}
        </span>
        {loading && <Loader2 className="w-3 h-3 animate-spin text-claude-muted" />}
        {error && (
          <span className="text-red-600 dark:text-red-400 truncate" title={error}>
            <AlertCircle className="w-3 h-3 inline mr-0.5" />
            {error}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => void refresh()}
          className="btn-ghost text-xs"
          title="立即刷新"
          aria-label="刷新"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0 && !loading && (
          <div className="p-4 text-center text-xs text-claude-muted dark:text-night-muted">
            暂无后台任务。Agent 调用 <code>shell_start</code> 起后台进程时会出现在这里——
            常见场景：<code>pnpm test --watch</code>、dev server、docker logs。
          </div>
        )}
        {/* Running first, then finished. Within each group, latest first
            (largest startedMs) so the most recent action is at the top. */}
        {[...running, ...finished]
          .sort((a, b) => {
            // Primary: running status (running on top).
            if (a.running !== b.running) return a.running ? -1 : 1;
            // Secondary: most recently started first.
            return b.startedMs - a.startedMs;
          })
          .map((t) => (
            <BackgroundTaskRow
              key={t.id}
              task={t}
              onKill={() => kill(t.id)}
              onRemove={() => remove(t.id)}
            />
          ))}
      </div>
    </div>
  );
}

function BackgroundTaskRow({
  task,
  onKill,
  onRemove,
}: {
  task: BgShellInfo;
  onKill: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState<BgShellReadResult | null>(null);
  const [readBusy, setReadBusy] = useState(false);

  const loadOutput = useCallback(async () => {
    setReadBusy(true);
    try {
      const r = await shellRead(task.id, 0);
      setOutput(r);
    } catch (e) {
      // Most likely the handle was forgotten — surface as error in the
      // expanded panel rather than crashing the row.
      setOutput({
        stdout: '',
        stderr: `读取输出失败：${(e as Error).message}`,
        running: task.running,
        code: task.code,
        killed: task.killed,
        stdoutDropped: 0,
        stderrDropped: 0,
      });
    } finally {
      setReadBusy(false);
    }
  }, [task]);

  // Auto-load on first expand. Subsequent expands re-fetch (output may
  // have grown since last view).
  useEffect(() => {
    if (expanded) void loadOutput();
  }, [expanded, loadOutput]);

  const fullCommand =
    task.args.length > 0 ? `${task.command} ${task.args.join(' ')}` : task.command;
  const startedAgo = formatDuration(Date.now() - task.startedMs);
  const runtimeColor = task.running
    ? 'text-emerald-600 dark:text-emerald-400'
    : task.code === 0
      ? 'text-claude-muted dark:text-night-muted'
      : 'text-red-600 dark:text-red-400';

  return (
    <div className="border-b border-claude-border/40 dark:border-night-border/40 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 shrink-0 p-0.5 rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
          title={expanded ? '折叠' : '展开看输出'}
          aria-label={expanded ? '折叠' : '展开'}
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <StatusBadge task={task} />
            <span className="font-mono truncate" title={fullCommand}>
              {fullCommand}
            </span>
          </div>
          <div className={cn('text-[11px] mt-0.5', runtimeColor)}>
            {task.running
              ? `运行 ${startedAgo}`
              : task.killed
                ? `被杀（运行了 ${startedAgo}）`
                : task.code === 0
                  ? `完成（运行了 ${startedAgo}）`
                  : `退出码 ${task.code ?? '?'}（运行了 ${startedAgo}）`}
            <span className="ml-2 font-mono text-claude-muted dark:text-night-muted">
              #{task.id.slice(-6)}
            </span>
          </div>
        </div>
        {task.running ? (
          <button
            onClick={() => void onKill()}
            className="shrink-0 p-0.5 rounded text-claude-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
            title="结束这个进程"
            aria-label="kill"
          >
            <Skull className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            onClick={() => void onRemove()}
            className="shrink-0 p-0.5 rounded text-claude-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
            title="从列表移除"
            aria-label="remove"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-2 ml-5 pl-3 border-l border-claude-border/40 dark:border-night-border/40">
          <div className="flex items-center gap-2 text-[11px] text-claude-muted dark:text-night-muted mb-1">
            <span>输出</span>
            {readBusy && <Loader2 className="w-3 h-3 animate-spin" />}
            {output && (output.stdoutDropped > 0 || output.stderrDropped > 0) && (
              <span className="text-amber-600 dark:text-amber-400">
                ⚠ 缓冲区溢出（stdout 丢 {output.stdoutDropped} B / stderr 丢 {output.stderrDropped} B）
              </span>
            )}
            <div className="flex-1" />
            <button
              onClick={() => void loadOutput()}
              className="hover:text-claude-ink dark:hover:text-night-ink"
              title="重新读取"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
          {output && (
            <div className="space-y-2">
              {output.stdout && (
                <div>
                  <div className="text-[10px] text-claude-muted dark:text-night-muted uppercase tracking-wider">stdout</div>
                  <pre className="font-mono text-[11px] whitespace-pre-wrap break-words bg-black/[0.03] dark:bg-white/[0.03] rounded p-2 max-h-48 overflow-y-auto">{tail(output.stdout, 4000)}</pre>
                </div>
              )}
              {output.stderr && (
                <div>
                  <div className="text-[10px] text-red-700 dark:text-red-400 uppercase tracking-wider">stderr</div>
                  <pre className="font-mono text-[11px] whitespace-pre-wrap break-words bg-red-50/50 dark:bg-red-950/20 rounded p-2 max-h-48 overflow-y-auto">{tail(output.stderr, 4000)}</pre>
                </div>
              )}
              {!output.stdout && !output.stderr && !readBusy && (
                <div className="text-[11px] text-claude-muted dark:text-night-muted italic">
                  还没有输出。
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ task }: { task: BgShellInfo }) {
  if (task.running) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        运行中
      </span>
    );
  }
  if (task.killed) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-700 dark:text-red-400">
        <Skull className="w-2.5 h-2.5" /> 被杀
      </span>
    );
  }
  if (task.code === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.07] text-claude-muted dark:text-night-muted">
        <CheckCircle2 className="w-2.5 h-2.5" /> 完成
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-700 dark:text-red-400">
      <AlertCircle className="w-2.5 h-2.5" /> 失败
    </span>
  );
}

/** Show the LAST N chars rather than the first — recent output is what
 *  the user almost always wants to see when they open this panel. The
 *  bgshell ring buffer is itself FIFO-truncated (256 KB), so its head
 *  may already be missing; we further trim for display. */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `[... 前 ${s.length - max} 字符已折叠]\n${s.slice(s.length - max)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '<1 秒';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分${seconds % 60 > 0 ? ` ${seconds % 60} 秒` : ''}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 时 ${minutes % 60} 分`;
}
