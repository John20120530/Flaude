import { useState } from 'react';
import {
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolCall } from '@/types';

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
