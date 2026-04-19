/**
 * ConflictToasts — renders a stack of dismissible cards at the bottom-right
 * whenever sync pulled a server version that clobbered unpushed local edits.
 *
 * Why here and not a generic Toast library: we only have one kind of toast
 * in the app today (sync conflicts), and the affordances are specific —
 * "restore local" vs "accept server". Once we have 2+ kinds we'll factor
 * out a generic Toast host.
 *
 * TTL (1h) is enforced in the store's applyPulledConversations, so this
 * component doesn't need its own timer.
 */
import { useMemo } from 'react';
import { AlertTriangle, X, RotateCcw } from 'lucide-react';
import { useAppStore, CONFLICT_TTL_MS } from '@/store/useAppStore';

/** Format "X seconds / minutes ago" in Chinese. Short form. */
function formatAgo(ms: number): string {
  const d = Math.max(0, Date.now() - ms);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  return `${h} 小时前`;
}

export default function ConflictToasts() {
  const conflictRecords = useAppStore((s) => s.conflictRecords);
  const dismissConflict = useAppStore((s) => s.dismissConflict);
  const restoreConflict = useAppStore((s) => s.restoreConflict);

  // Client-side TTL filter: the store lazy-expires on pull, but we also
  // filter here so a user sitting idle with a stale record doesn't see it
  // indefinitely. Memoised so identity is stable when nothing changed.
  const active = useMemo(
    () =>
      conflictRecords.filter(
        (r) => Date.now() - r.detectedAt < CONFLICT_TTL_MS,
      ),
    [conflictRecords],
  );

  if (active.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="同步冲突通知"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none"
    >
      {active.map((r) => (
        <div
          key={r.conversationId + ':' + r.detectedAt}
          className={
            'pointer-events-auto rounded-lg shadow-lg border p-3 text-sm ' +
            'bg-claude-surface dark:bg-night-surface ' +
            'border-amber-400/60 dark:border-amber-500/50'
          }
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-claude-ink dark:text-night-ink">
                该会话已在另一设备修改
              </div>
              <div className="mt-0.5 text-xs text-claude-muted dark:text-night-muted truncate">
                「{r.localCopy.title || '未命名会话'}」
                · 检测于 {formatAgo(r.detectedAt)}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => restoreConflict(r.conversationId)}
                  className={
                    'inline-flex items-center gap-1 px-2 py-1 rounded text-xs ' +
                    'bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 ' +
                    'dark:text-amber-300'
                  }
                  title="用本地版本覆盖另一设备的改动（会重新上传）"
                >
                  <RotateCcw className="w-3 h-3" />
                  保留本地版本
                </button>
                <button
                  type="button"
                  onClick={() => dismissConflict(r.conversationId)}
                  className={
                    'inline-flex items-center gap-1 px-2 py-1 rounded text-xs ' +
                    'text-claude-muted hover:text-claude-ink ' +
                    'dark:hover:text-night-ink'
                  }
                  title="关闭提示，接受另一设备的版本"
                >
                  <X className="w-3 h-3" />
                  忽略
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
