/**
 * WriteApprovalModal — shows a diff for each pending fs_write_file call
 * and lets the user Apply or Reject. Mounted once at the AppShell level.
 *
 * Why a queue instead of "one at a time": during a long agent turn the
 * model may fire multiple fs_write_file calls before the user reacts.
 * Each gets its own pending entry and its own diff; we process
 * pendingWrites[0] and the next one surfaces automatically after the
 * current is resolved. The chat loop awaits each handler sequentially
 * anyway, so in practice the queue length is almost always 0 or 1, but
 * the shape is robust.
 *
 * Keyboard:
 *   Esc          → reject
 *   Ctrl/⌘+Enter → apply
 *
 * We deliberately don't auto-focus Apply. The whole point of this modal
 * is to get the user to actually read the diff before clicking; a
 * pre-focused primary button invites reflexive Enter-mashing.
 */
import { useEffect, useMemo } from 'react';
import { Check, X, FilePlus2, FilePenLine, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { resolveWriteApproval } from '@/lib/writeApproval';
import { diffLines, diffStats, DiffTooLargeError } from '@/lib/diff';
import { cn } from '@/lib/utils';

export default function WriteApprovalModal() {
  const pendingWrites = useAppStore((s) => s.pendingWrites);
  const current = pendingWrites[0];

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolveWriteApproval(current.id, false);
      } else if (
        (e.metaKey || e.ctrlKey) &&
        e.key === 'Enter'
      ) {
        e.preventDefault();
        resolveWriteApproval(current.id, true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);

  if (!current) return null;
  return <ApprovalCard key={current.id} write={current} />;
}

function ApprovalCard({
  write,
}: {
  write: NonNullable<ReturnType<typeof useAppStore.getState>['pendingWrites'][number]>;
}) {
  // Compute the diff once per pending entry — the content is immutable
  // while the modal is open, so no need to re-run on every render.
  const result = useMemo(() => {
    try {
      const lines = diffLines(write.oldContent, write.newContent);
      return { kind: 'ok' as const, lines, stats: diffStats(lines) };
    } catch (err) {
      if (err instanceof DiffTooLargeError) {
        return { kind: 'too-large' as const, error: err };
      }
      throw err;
    }
  }, [write.oldContent, write.newContent]);

  const queueLength = useAppStore((s) => s.pendingWrites.length);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="write-approval-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
    >
      <div
        className={cn(
          'flex flex-col w-full max-w-3xl max-h-[85vh] rounded-xl shadow-xl overflow-hidden',
          'bg-claude-surface dark:bg-night-surface',
          'border border-claude-border dark:border-night-border',
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-3 border-b border-claude-border dark:border-night-border">
          {write.isNewFile ? (
            <FilePlus2 className="w-5 h-5 mt-0.5 shrink-0 text-green-600" />
          ) : (
            <FilePenLine className="w-5 h-5 mt-0.5 shrink-0 text-blue-500" />
          )}
          <div className="flex-1 min-w-0">
            <h2
              id="write-approval-title"
              className="font-semibold text-claude-ink dark:text-night-ink"
            >
              {write.isNewFile ? '创建文件' : '修改文件'}
            </h2>
            <div className="text-xs font-mono text-claude-muted dark:text-night-muted truncate mt-0.5">
              {write.path}
            </div>
            {result.kind === 'ok' && (
              <div className="mt-1 flex items-center gap-3 text-xs">
                <span className="text-green-600 dark:text-green-400">
                  +{result.stats.added}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  −{result.stats.removed}
                </span>
                <span className="text-claude-muted dark:text-night-muted">
                  {result.stats.unchanged} 未变
                </span>
                {queueLength > 1 && (
                  <span className="ml-auto text-claude-muted dark:text-night-muted">
                    队列还有 {queueLength - 1} 个
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Diff body */}
        <div className="flex-1 overflow-auto">
          {result.kind === 'ok' ? (
            <DiffView lines={result.lines} />
          ) : (
            <TooLargePreview
              error={result.error}
              isNewFile={write.isNewFile}
              newContent={write.newContent}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className={cn(
            'flex items-center gap-3 px-5 py-3 border-t',
            'border-claude-border dark:border-night-border',
            'bg-black/[0.02] dark:bg-white/[0.02]',
          )}
        >
          <div className="text-[11px] text-claude-muted dark:text-night-muted">
            Esc 拒绝 · Ctrl/⌘+Enter 应用
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => resolveWriteApproval(write.id, false)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm',
              'text-claude-ink dark:text-night-ink',
              'hover:bg-black/[0.06] dark:hover:bg-white/[0.06]',
            )}
          >
            <X className="w-4 h-4" />
            拒绝
          </button>
          <button
            type="button"
            onClick={() => resolveWriteApproval(write.id, true)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium',
              'bg-claude-accent text-white hover:bg-claude-accent/90',
            )}
          >
            <Check className="w-4 h-4" />
            应用
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Render the line-level diff as a monospace column with line-number
 * gutters and per-line bg tint. Long lines are horizontally scrollable
 * via the parent overflow-auto. We render every line unconditionally —
 * the diff is already capped at MAX_LINES_PER_SIDE (5000) per side, so
 * worst case is ~10K divs in a single render, which React handles in
 * < 200ms. Not worth adding virtualisation for this path.
 */
function DiffView({
  lines,
}: {
  lines: import('@/lib/diff').DiffLine[];
}) {
  return (
    <div className="font-mono text-[12px] leading-[1.5] py-1">
      {lines.map((line, idx) => {
        const bg =
          line.op === 'add'
            ? 'bg-green-50 dark:bg-green-950/30'
            : line.op === 'del'
            ? 'bg-red-50 dark:bg-red-950/30'
            : '';
        const marker =
          line.op === 'add' ? '+' : line.op === 'del' ? '−' : ' ';
        const markerColor =
          line.op === 'add'
            ? 'text-green-700 dark:text-green-400'
            : line.op === 'del'
            ? 'text-red-700 dark:text-red-400'
            : 'text-claude-muted dark:text-night-muted';
        const textColor =
          line.op === 'add'
            ? 'text-green-900 dark:text-green-100'
            : line.op === 'del'
            ? 'text-red-900 dark:text-red-100'
            : 'text-claude-ink dark:text-night-ink';
        return (
          <div
            key={idx}
            className={cn('flex items-start px-2', bg)}
          >
            <span className="w-10 shrink-0 text-right pr-2 text-claude-muted dark:text-night-muted select-none">
              {line.oldLine ?? ''}
            </span>
            <span className="w-10 shrink-0 text-right pr-2 text-claude-muted dark:text-night-muted select-none">
              {line.newLine ?? ''}
            </span>
            <span className={cn('w-4 shrink-0 select-none', markerColor)}>
              {marker}
            </span>
            <span className={cn('whitespace-pre', textColor)}>
              {line.text || '\u00A0'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TooLargePreview({
  error,
  isNewFile,
  newContent,
}: {
  error: DiffTooLargeError;
  isNewFile: boolean;
  newContent: string;
}) {
  const PREVIEW_LINES = 200;
  const preview = newContent.split('\n').slice(0, PREVIEW_LINES).join('\n');
  const total = newContent.split('\n').length;
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-100 text-xs">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          文件太大（旧 {error.oldLines} 行 / 新 {error.newLines} 行），无法完整对比。
          {isNewFile ? '下面是新文件的前' : '下面是新内容的前'} {PREVIEW_LINES} 行预览。
          如果需要完整审查，请拒绝后让 agent 分段写入或手动操作。
        </div>
      </div>
      <pre className="font-mono text-[12px] leading-[1.5] p-3 rounded bg-black/[0.04] dark:bg-white/[0.04] whitespace-pre overflow-x-auto">
        {preview}
        {total > PREVIEW_LINES && `\n… (还有 ${total - PREVIEW_LINES} 行未显示)`}
      </pre>
    </div>
  );
}
