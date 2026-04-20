/**
 * TodoPanel — renders the agent's self-managed TODO list for the current
 * conversation. Populated by the `todo_write` builtin tool; invisible when
 * there's no list.
 *
 * Design decisions:
 *
 * 1. **Mount in CodeView, not in AppShell.** The todo list is scoped to a
 *    conversation and only populated in code mode. Mounting at shell scope
 *    (like WriteApprovalModal) would force every view to carry the
 *    conversation-lookup logic. Putting it one level down, where we already
 *    have `conversation` in hand, is cleaner.
 *
 * 2. **Collapsible, collapsed-by-default-past-the-first-glance.** We want the
 *    agent's plan to be visible, not vertically dominating. The collapsed
 *    header keeps status at a glance ("3/5 · 修改 store.ts") and the full
 *    list is a click away. First render on a fresh list is expanded so the
 *    user actually sees it appear.
 *
 * 3. **Empty list hides the whole panel.** The store drops the key when
 *    the tool passes an empty array, so we just check for existence.
 *
 * 4. **Manual clear button.** If the agent forgets to clear the list after a
 *    task is done (or dies mid-run), the user can wipe it themselves rather
 *    than waiting for the next agent turn.
 */
import { useEffect, useState } from 'react';
import { Check, Circle, Loader2, ListChecks, ChevronDown, X } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { cn } from '@/lib/utils';
import type { TodoItem } from '@/types';

interface Props {
  conversationId: string;
}

export default function TodoPanel({ conversationId }: Props) {
  const todos = useAppStore((s) => s.conversationTodos[conversationId]);
  const clearConversationTodos = useAppStore((s) => s.clearConversationTodos);

  // Start expanded whenever a list appears; collapse is a manual opt-out so
  // the first visibility is guaranteed. `JSON.stringify(todos)` as key would
  // reset on every write, which fights the user — so we key on length only.
  const listLength = todos?.length ?? 0;
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    // Auto-expand on first population. Subsequent same-length updates don't
    // trigger this (the effect only fires when length actually changes),
    // which means a user collapse sticks through in-place edits.
    if (listLength > 0) setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listLength === 0]);

  if (!todos || todos.length === 0) return null;

  const done = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  const allDone = done === todos.length;

  return (
    <div
      className={cn(
        'shrink-0 border-b border-claude-border dark:border-night-border',
        'bg-claude-surface dark:bg-night-surface',
      )}
    >
      {/* Header — click to toggle */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-xs',
          'hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors',
        )}
      >
        <ListChecks
          className={cn(
            'w-3.5 h-3.5 shrink-0',
            allDone
              ? 'text-green-600 dark:text-green-400'
              : 'text-claude-accent',
          )}
        />
        <span className="font-medium text-claude-ink dark:text-night-ink">
          TODO
        </span>
        <span className="text-claude-muted dark:text-night-muted">
          {done}/{todos.length}
        </span>
        {active && !expanded && (
          <span className="truncate text-claude-muted dark:text-night-muted">
            · {active.activeForm}
          </span>
        )}
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 ml-auto shrink-0 text-claude-muted dark:text-night-muted',
            'transition-transform',
            expanded ? 'rotate-0' : '-rotate-90',
          )}
        />
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            // Stop the click from bubbling to the parent button — otherwise
            // clearing also toggles expanded state, which feels glitchy.
            e.stopPropagation();
            clearConversationTodos(conversationId);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              clearConversationTodos(conversationId);
            }
          }}
          className={cn(
            'p-0.5 rounded hover:bg-black/[0.08] dark:hover:bg-white/[0.08]',
            'text-claude-muted dark:text-night-muted',
          )}
          title="清空 TODO 列表"
          aria-label="清空 TODO 列表"
        >
          <X className="w-3 h-3" />
        </span>
      </button>

      {/* Body — the list itself */}
      {expanded && (
        <ul className="px-3 pb-2 pt-0.5 space-y-0.5">
          {todos.map((t, idx) => (
            <TodoRow key={idx} todo={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const isActive = todo.status === 'in_progress';
  const isDone = todo.status === 'completed';
  return (
    <li
      className={cn(
        'flex items-start gap-2 text-xs leading-relaxed',
        isActive && 'font-medium',
      )}
    >
      <span className="mt-0.5 shrink-0">
        {isDone ? (
          <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
        ) : isActive ? (
          // Spinner makes "the agent is actively on this item right now" legible
          // at a glance, matching the cognitive model of a build/test indicator.
          <Loader2 className="w-3.5 h-3.5 text-claude-accent animate-spin" />
        ) : (
          <Circle className="w-3.5 h-3.5 text-claude-muted dark:text-night-muted" />
        )}
      </span>
      <span
        className={cn(
          isDone
            ? 'line-through text-claude-muted dark:text-night-muted'
            : isActive
            ? 'text-claude-ink dark:text-night-ink'
            : 'text-claude-ink/80 dark:text-night-ink/80',
        )}
      >
        {/* When in_progress, show the present-continuous form — reads like a
            status line ("Running the migration"). Otherwise show the
            imperative, which reads like a to-do item ("Run the migration"). */}
        {isActive ? todo.activeForm : todo.content}
      </span>
    </li>
  );
}
