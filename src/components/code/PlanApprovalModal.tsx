/**
 * PlanApprovalModal — renders the agent's proposed plan and lets the user
 * approve, give feedback (request revisions), or reject. Mounted once at
 * the AppShell level alongside WriteApprovalModal.
 *
 * Why a queue + FIFO: the architecture mirrors WriteApprovalModal — during
 * a long-running plan-mode turn the agent could (in theory) call
 * exit_plan_mode multiple times if the user kept asking for revisions.
 * Each call gets its own pending entry and resolves independently. In
 * practice the queue length is almost always 0 or 1.
 *
 * Three terminal actions:
 *   - 批准  → plan accepted, agent unlocks destructive tools
 *   - 反馈  → opens a small textarea, user types what to change, on
 *             confirm the agent re-plans (still in Plan mode)
 *   - 拒绝  → user gives up; agent stops touching anything destructive
 *
 * Keyboard:
 *   Esc          → reject (matches WriteApprovalModal)
 *   Ctrl/⌘+Enter → approve (when not in feedback mode)
 *
 * No auto-focus on Approve, on purpose: the user must read the plan
 * before pressing the primary action. Same rationale as the diff modal —
 * a pre-focused button invites Enter-mashing.
 */
import { useEffect, useState } from 'react';
import { Check, X, MessageSquare, Map as MapIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '@/store/useAppStore';
import { resolvePlanApproval } from '@/lib/planMode';
import { cn } from '@/lib/utils';

export default function PlanApprovalModal() {
  const pendingPlans = useAppStore((s) => s.pendingPlans);
  const current = pendingPlans[0];

  // Local "feedback" mode: when the user clicks 反馈, swap the action row
  // for a textarea + send/cancel. We don't lift this to store state because
  // it's purely UI-local and resets per-modal.
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState('');

  // Reset feedback UI whenever the active plan changes (queue advances).
  useEffect(() => {
    setFeedbackMode(false);
    setFeedback('');
  }, [current?.id]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (feedbackMode) {
        // In feedback mode, let the textarea handle its own keys.
        // Escape still cancels back to the action row.
        if (e.key === 'Escape') {
          e.preventDefault();
          setFeedbackMode(false);
          setFeedback('');
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        resolvePlanApproval(current.id, { kind: 'rejected' });
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        resolvePlanApproval(current.id, { kind: 'approved' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, feedbackMode]);

  if (!current) return null;

  const queueLength = pendingPlans.length;

  const sendFeedback = () => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    resolvePlanApproval(current.id, { kind: 'feedback', feedback: trimmed });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="审批 agent 计划"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
    >
      <div
        className={cn(
          'w-full max-w-3xl max-h-[90vh] flex flex-col',
          'rounded-xl border border-claude-border dark:border-night-border',
          'bg-claude-bg dark:bg-night-bg',
          'shadow-2xl',
        )}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-3 border-b border-claude-border dark:border-night-border">
          <MapIcon className="w-5 h-5 mt-0.5 shrink-0 text-sky-500" />
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-claude-ink dark:text-night-ink">
              Agent 提交了执行计划
            </h2>
            <div className="text-xs text-claude-muted dark:text-night-muted mt-0.5">
              批准后副作用工具（fs_write_file / shell_exec 等）解锁；反馈让 agent 修改后重新提交；拒绝则本轮停止动手。
              {queueLength > 1 && (
                <span className="ml-2">· 队列还有 {queueLength - 1} 个</span>
              )}
            </div>
          </div>
        </div>

        {/* Plan body — markdown rendered for readability */}
        <div className="flex-1 overflow-auto px-5 py-4">
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{current.plan}</ReactMarkdown>
          </div>
        </div>

        {/* Footer */}
        <div
          className={cn(
            'px-5 py-3 border-t border-claude-border dark:border-night-border',
            'bg-black/[0.02] dark:bg-white/[0.02]',
          )}
        >
          {feedbackMode ? (
            <div className="flex flex-col gap-2">
              <textarea
                autoFocus
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="告诉 agent 计划要怎么改——例如：「步骤 2 太激进，先只在 src/ 改动，不要碰 server/」"
                className={cn(
                  'w-full min-h-[88px] max-h-[200px] px-3 py-2 text-sm rounded-md resize-y',
                  'border border-claude-border dark:border-night-border',
                  'bg-white dark:bg-night-bg focus:outline-none focus:ring-2 focus:ring-sky-500/40',
                )}
              />
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-claude-muted dark:text-night-muted">
                  Esc 取消反馈
                </span>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => {
                    setFeedbackMode(false);
                    setFeedback('');
                  }}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm',
                    'text-claude-ink dark:text-night-ink',
                    'hover:bg-black/[0.06] dark:hover:bg-white/[0.06]',
                  )}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={sendFeedback}
                  disabled={!feedback.trim()}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium',
                    'bg-sky-600 text-white hover:bg-sky-600/90 disabled:opacity-50',
                  )}
                >
                  <MessageSquare className="w-4 h-4" />
                  发送反馈
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="text-[11px] text-claude-muted dark:text-night-muted">
                Esc 拒绝 · Ctrl/⌘+Enter 批准
              </div>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => resolvePlanApproval(current.id, { kind: 'rejected' })}
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
                onClick={() => setFeedbackMode(true)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm',
                  'text-claude-ink dark:text-night-ink',
                  'hover:bg-black/[0.06] dark:hover:bg-white/[0.06]',
                )}
              >
                <MessageSquare className="w-4 h-4" />
                反馈修改
              </button>
              <button
                type="button"
                onClick={() => resolvePlanApproval(current.id, { kind: 'approved' })}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium',
                  'bg-sky-600 text-white hover:bg-sky-600/90',
                )}
              >
                <Check className="w-4 h-4" />
                批准
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
