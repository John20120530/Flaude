import { useState } from 'react';
import {
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Wrench,
  Circle,
  ListChecks,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentTodo, ToolCall } from '@/types';

interface Props {
  call: ToolCall;
  /**
   * The tool result (from a paired `role: 'tool'` message). When supplied, the
   * card lets the user expand to see the full output. When absent, we fall
   * back to call.result / call.error.
   */
  resultContent?: string;
}

/**
 * Auto-collapse thresholds. Chosen empirically: 20 lines is about a screen
 * worth, 2000 chars catches long one-liners (e.g. stringified JSON
 * responses). When exceeded, the pane shows a truncated preview + a "show
 * all" button. The user can still manually toggle the whole card closed;
 * this is a second, finer gate inside an already-opened card.
 *
 * Why do this: `fs_read_file` on a 1000-line source file, or `shell_exec`
 * tailing a build log, used to blow up the card height and drown the
 * conversation scrollback even though max-h-80 + scroll kept it bounded.
 * A fold + hint reads much better: "got 847 lines, click if you care".
 */
const AUTO_COLLAPSE_MAX_LINES = 20;
const AUTO_COLLAPSE_MAX_CHARS = 2000;
const AUTO_COLLAPSE_PREVIEW_LINES = 12;

/**
 * A compact card showing one tool invocation: name, status, and expandable
 * arguments / result. Mimics Claude's "Using X..." affordance.
 */
export default function ToolCallCard({ call, resultContent }: Props) {
  const [open, setOpen] = useState(false);

  const statusIcon = {
    pending: <Clock className="w-3.5 h-3.5 text-claude-muted dark:text-night-muted" />,
    running: <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />,
    success: <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />,
    error: <XCircle className="w-3.5 h-3.5 text-red-500" />,
  }[call.status];

  const statusLabel = {
    pending: '等待',
    running: '运行中',
    success: '完成',
    error: '失败',
  }[call.status];

  const argsPretty = formatArgs(call.arguments);
  const displayResult = resultContent ?? call.result ?? call.error ?? '';

  // Special-case todo_write: instead of the generic "args / result" panes,
  // render a checklist so the user can scan the agent's plan at a glance.
  // Falls through to the normal card layout while the call is still
  // pending (arguments haven't parsed yet) or if parsing fails.
  if (call.name === 'todo_write' && call.status !== 'pending') {
    const todos = extractTodos(call.arguments);
    if (todos) {
      return (
        <TodoListCard
          todos={todos}
          status={call.status}
          statusIcon={statusIcon}
          statusLabel={statusLabel}
        />
      );
    }
  }

  return (
    <div
      className={cn(
        'my-2 rounded-lg border text-sm not-prose overflow-hidden transition-colors',
        call.status === 'error'
          ? 'border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20'
          : 'border-claude-border dark:border-night-border bg-claude-surface/60 dark:bg-night-surface/60'
      )}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
      >
        <ChevronRight
          className={cn('w-3.5 h-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <Wrench className="w-3.5 h-3.5 text-claude-accent shrink-0" />
        <span className="font-mono text-xs truncate">
          <span className="text-claude-accent">{call.name}</span>
          <span className="text-claude-muted dark:text-night-muted">
            ({argsSummary(call.arguments)})
          </span>
        </span>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {statusIcon}
          <span className="text-xs text-claude-muted dark:text-night-muted">
            {statusLabel}
          </span>
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          <Section title="参数">
            <FoldablePre
              text={argsPretty || '(无参数)'}
              maxHeightClass="max-h-60"
            />
          </Section>
          {(call.status === 'success' || call.status === 'error') && displayResult && (
            <Section title={call.status === 'error' ? '错误' : '结果'}>
              <FoldablePre
                text={displayResult}
                maxHeightClass="max-h-80"
                tone={call.status === 'error' ? 'error' : 'default'}
              />
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pull the todos array off a `todo_write` call's arguments. We accept both
 * the already-parsed shape (`arguments: { todos: [...] }`) and the mid-
 * stream `{ __raw: "..." }` we get while the model is still emitting JSON,
 * returning null in the latter case so the caller falls back to the
 * generic card until the parse completes.
 */
function extractTodos(args: Record<string, unknown> | unknown): AgentTodo[] | null {
  if (!args || typeof args !== 'object') return null;
  const obj = args as Record<string, unknown>;
  if ('__raw' in obj) return null;
  const raw = obj.todos;
  if (!Array.isArray(raw)) return null;
  const out: AgentTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const t = item as Record<string, unknown>;
    const content = typeof t.content === 'string' ? t.content : '';
    const activeForm = typeof t.activeForm === 'string' ? t.activeForm : content;
    const status = t.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      return null;
    }
    if (!content) return null;
    out.push({ content, activeForm, status });
  }
  return out;
}

function TodoListCard({
  todos,
  status,
  statusIcon,
  statusLabel,
}: {
  todos: AgentTodo[];
  status: ToolCall['status'];
  statusIcon: React.ReactNode;
  statusLabel: string;
}) {
  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  return (
    <div
      className={cn(
        'my-2 rounded-lg border text-sm not-prose overflow-hidden',
        status === 'error'
          ? 'border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20'
          : 'border-claude-border dark:border-night-border bg-claude-surface/60 dark:bg-night-surface/60'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-claude-border/60 dark:border-night-border/60">
        <ListChecks className="w-3.5 h-3.5 text-claude-accent shrink-0" />
        <span className="font-mono text-xs text-claude-accent">todo_write</span>
        <span className="text-xs text-claude-muted dark:text-night-muted">
          {done}/{total} 已完成
        </span>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {statusIcon}
          <span className="text-xs text-claude-muted dark:text-night-muted">
            {statusLabel}
          </span>
        </div>
      </div>
      {todos.length === 0 ? (
        <div className="px-3 py-2 text-xs text-claude-muted dark:text-night-muted italic">
          任务列表已清空
        </div>
      ) : (
        <ul className="px-3 py-2 space-y-1">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <TodoIcon status={t.status} />
              <span
                className={cn(
                  'leading-tight',
                  t.status === 'completed' &&
                    'line-through text-claude-muted dark:text-night-muted',
                  t.status === 'in_progress' && 'font-medium'
                )}
              >
                {t.status === 'in_progress' ? t.activeForm : t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TodoIcon({ status }: { status: AgentTodo['status'] }) {
  if (status === 'completed') {
    return (
      <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-600" />
    );
  }
  if (status === 'in_progress') {
    return <Loader2 className="w-4 h-4 mt-0.5 shrink-0 text-blue-500 animate-spin" />;
  }
  return (
    <Circle className="w-4 h-4 mt-0.5 shrink-0 text-claude-muted dark:text-night-muted" />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-claude-muted dark:text-night-muted mb-1">
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * A <pre> that auto-folds if `text` is too long. Small outputs (<= thresholds)
 * render in full exactly like before. Large outputs start truncated with a
 * "show all N lines" toggle. Keeps the existing max-h-* + scroll for the
 * expanded state so very long results still don't hijack the viewport.
 */
function FoldablePre({
  text,
  maxHeightClass,
  tone = 'default',
}: {
  text: string;
  maxHeightClass: string;
  tone?: 'default' | 'error';
}) {
  const [expanded, setExpanded] = useState(false);

  const lines = text.split('\n');
  const lineCount = lines.length;
  const charCount = text.length;
  const needsFold =
    lineCount > AUTO_COLLAPSE_MAX_LINES || charCount > AUTO_COLLAPSE_MAX_CHARS;

  const shown = !needsFold || expanded
    ? text
    : lines.slice(0, AUTO_COLLAPSE_PREVIEW_LINES).join('\n');

  const preClass = cn(
    'text-[11px] font-mono whitespace-pre-wrap break-words p-2 rounded overflow-y-auto',
    // Only cap the height when fully expanded — the preview is already short
    // enough that a max-height would just add an unnecessary inner scrollbar.
    (!needsFold || expanded) && maxHeightClass,
    tone === 'error'
      ? 'bg-red-100/60 dark:bg-red-950/30 text-red-800 dark:text-red-200'
      : 'bg-black/[0.04] dark:bg-white/[0.04] text-claude-ink dark:text-night-ink'
  );

  return (
    <div>
      <pre className={preClass}>{shown}</pre>
      {needsFold && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-claude-accent hover:underline"
        >
          {expanded
            ? '收起'
            : `显示全部（共 ${lineCount} 行 / ${charCount} 字符）`}
        </button>
      )}
    </div>
  );
}

/** One-line arg summary for the collapsed header. */
function argsSummary(args: Record<string, unknown> | unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  if ('__raw' in obj) return '...'; // mid-stream, not parsed yet
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  // Show first arg value truncated, then "+N more"
  const first = keys[0];
  const val = obj[first];
  const valStr =
    typeof val === 'string'
      ? `"${val.length > 24 ? val.slice(0, 24) + '…' : val}"`
      : JSON.stringify(val).slice(0, 28);
  const rest = keys.length > 1 ? `, +${keys.length - 1}` : '';
  return `${first}: ${valStr}${rest}`;
}

/** Pretty-printed JSON for the expanded panel. */
function formatArgs(args: Record<string, unknown> | unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  if ('__raw' in obj) {
    return String((obj as { __raw?: string }).__raw ?? '');
  }
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}
