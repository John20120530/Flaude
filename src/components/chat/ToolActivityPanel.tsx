/**
 * Compact feed of tool calls for the current conversation. Designed for the
 * right-side panel in Code mode. Unlike the inline ToolCallCard
 * (which lives in the message stream), this shows an at-a-glance summary:
 * newest first, with status icons and a tiny arg preview.
 */

import { useMemo, useState } from 'react';
import {
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  ChevronRight,
} from 'lucide-react';
import type { ToolCall, Message } from '@/types';
import { cn } from '@/lib/utils';

interface Props {
  messages: Message[];
}

export default function ToolActivityPanel({ messages }: Props) {
  // Flatten all tool calls across all assistant messages.
  const calls = useMemo(() => {
    const out: { call: ToolCall; msgId: string; time: number }[] = [];
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.toolCalls) continue;
      for (const tc of m.toolCalls) {
        out.push({ call: tc, msgId: m.id, time: m.createdAt });
      }
    }
    return out.reverse(); // newest first
  }, [messages]);

  const counts = useMemo(() => {
    const c: Record<ToolCall['status'], number> = {
      pending: 0,
      running: 0,
      success: 0,
      error: 0,
    };
    for (const { call } of calls) c[call.status]++;
    return c;
  }, [calls]);

  if (calls.length === 0) {
    return (
      <div className="p-6 text-center">
        <Wrench className="w-6 h-6 mx-auto mb-2 text-claude-muted/50 dark:text-night-muted/50" />
        <div className="text-xs text-claude-muted dark:text-night-muted">
          暂无工具调用
        </div>
        <div className="mt-1 text-[10px] text-claude-muted/70 dark:text-night-muted/70">
          Agent 会在需要时自动调用工具
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-3 text-xs">
        <span className="text-claude-muted dark:text-night-muted">
          共 {calls.length} 次
        </span>
        {counts.success > 0 && (
          <span className="text-green-600 flex items-center gap-0.5">
            <CheckCircle2 className="w-3 h-3" /> {counts.success}
          </span>
        )}
        {counts.error > 0 && (
          <span className="text-red-500 flex items-center gap-0.5">
            <XCircle className="w-3 h-3" /> {counts.error}
          </span>
        )}
        {(counts.running > 0 || counts.pending > 0) && (
          <span className="text-blue-500 flex items-center gap-0.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            {counts.running + counts.pending}
          </span>
        )}
      </div>

      <div className="space-y-1">
        {calls.map(({ call }, i) => (
          <Row key={`${call.id}-${i}`} call={call} />
        ))}
      </div>
    </div>
  );
}

function Row({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={cn(
        'rounded-md border overflow-hidden',
        call.status === 'error'
          ? 'border-red-200/60 dark:border-red-900/40 bg-red-50/30 dark:bg-red-950/10'
          : 'border-claude-border dark:border-night-border bg-claude-surface/40 dark:bg-night-surface/40'
      )}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
      >
        <ChevronRight
          className={cn(
            'w-3 h-3 shrink-0 transition-transform text-claude-muted',
            open && 'rotate-90'
          )}
        />
        <StatusIcon status={call.status} />
        <span className="font-mono truncate flex-1 min-w-0">{call.name}</span>
      </button>
      {open && (
        <div className="px-2 pb-2 pt-0.5 space-y-1.5">
          <Field label="参数">
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-words p-1.5 rounded bg-black/[0.05] dark:bg-white/[0.05] max-h-32 overflow-y-auto">
              {prettyArgs(call.arguments)}
            </pre>
          </Field>
          {(call.result || call.error) && (
            <Field label={call.error ? '错误' : '结果'}>
              <pre
                className={cn(
                  'text-[10px] font-mono whitespace-pre-wrap break-words p-1.5 rounded max-h-40 overflow-y-auto',
                  call.error
                    ? 'bg-red-100/60 dark:bg-red-950/30 text-red-800 dark:text-red-200'
                    : 'bg-black/[0.05] dark:bg-white/[0.05]'
                )}
              >
                {(call.error ?? call.result ?? '').slice(0, 2000)}
              </pre>
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-claude-muted dark:text-night-muted mb-0.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function StatusIcon({ status }: { status: ToolCall['status'] }) {
  switch (status) {
    case 'pending':
      return (
        <Clock className="w-3 h-3 shrink-0 text-claude-muted dark:text-night-muted" />
      );
    case 'running':
      return <Loader2 className="w-3 h-3 shrink-0 text-blue-500 animate-spin" />;
    case 'success':
      return <CheckCircle2 className="w-3 h-3 shrink-0 text-green-600" />;
    case 'error':
      return <XCircle className="w-3 h-3 shrink-0 text-red-500" />;
  }
}

function prettyArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const o = args as Record<string, unknown>;
  if ('__raw' in o) return String((o as { __raw?: string }).__raw ?? '');
  try {
    return JSON.stringify(o, null, 2);
  } catch {
    return String(o);
  }
}
