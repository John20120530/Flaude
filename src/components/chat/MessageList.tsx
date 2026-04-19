import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import type { Message } from '@/types';
import { cn } from '@/lib/utils';
import { User, Sparkles, Loader2, FileCode, Archive, ChevronDown, ChevronRight, Trash2, Eye, EyeOff } from 'lucide-react';
import MessageActions from './MessageActions';
import CodeBlock from './CodeBlock';
import ToolCallCard from './ToolCallCard';
import { useAppStore } from '@/store/useAppStore';

interface Props {
  messages: Message[];
  conversationId: string;
  streaming?: boolean;
  onRegenerate?: () => void;
  /**
   * M6: when non-empty, show a collapsible chip at the top of the message
   * list indicating that the first `summaryMessageCount` messages have
   * been compressed into this summary. Clicking the chip expands it so the
   * user can review the summary text. Omit to disable the UI entirely.
   */
  summary?: string;
  summaryMessageCount?: number;
  summarizedAt?: number;
  /** Invoked when the user clicks "撤销" on the summary chip. */
  onClearSummary?: () => void;
}

export default function MessageList({
  messages,
  conversationId,
  streaming,
  onRegenerate,
  summary,
  summaryMessageCount,
  summarizedAt,
  onClearSummary,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  // Fallback flash state — used only when we can't find the matched query
  // inside the rendered message DOM (e.g. the query spans markdown inline
  // boundaries). In that case we pulse the whole message so the user at
  // least gets visual confirmation they landed on the right one.
  const [flashId, setFlashId] = useState<string | null>(null);
  // M6: once the user compresses, the archived messages are hidden from view
  // by default. Click the eye on the summary chip to peek at the raw
  // originals (grayed out, prefixed with a "仅本地可见" banner).
  const [showArchived, setShowArchived] = useState(false);

  // Does the summary cover any messages that actually exist right now?
  // (Clamping because summaryMessageCount may have drifted past messages.length
  // if the user manually deleted later messages.)
  const effectiveSummaryCount =
    summary && summaryMessageCount
      ? Math.min(summaryMessageCount, messages.length)
      : 0;

  // Auto-reveal archived section when the sidebar search lands on a message
  // that lives inside the archived range — otherwise scrollIntoView would have
  // no element to target and the user would stare at a chip wondering why
  // nothing happened.
  useEffect(() => {
    if (!location.hash.startsWith('#msg-')) return;
    if (effectiveSummaryCount <= 0) return;
    const id = location.hash.slice(5);
    const idx = messages.findIndex((m) => m.id === id);
    if (idx >= 0 && idx < effectiveSummaryCount && !showArchived) {
      setShowArchived(true);
    }
  }, [location.hash, messages, effectiveSummaryCount, showArchived]);

  // Jump-to-hash effect — independent of messages updating. Markdown, code
  // highlight, and KaTeX each run async passes that shift layout; one
  // `requestAnimationFrame` is not enough. Retry a few times until the target
  // shows up, then stop.
  useEffect(() => {
    const hash = location.hash;
    if (!hash.startsWith('#msg-')) return;
    const id = hash.slice(5);
    // `flashQuery` is the exact string typed into the sidebar search. When
    // present, we try to wrap just that substring in an ephemeral <span>
    // and animate it, so only those characters light up (not the whole
    // bubble). See Sidebar.tsx → SearchResultItem.go().
    const state = location.state as { flashQuery?: string } | null;
    const query = state?.flashQuery?.trim() ?? '';

    let cancelled = false;
    const delays = [0, 80, 200, 500]; // ~ms; enough for markdown + highlight passes
    const timers: ReturnType<typeof setTimeout>[] = [];
    let done = false;
    let wrappedSpan: HTMLSpanElement | null = null;

    const attempt = () => {
      if (cancelled || done) return;
      const el = document.getElementById(`msg-${id}`);
      if (!el) return;
      // `start` aligns the message's TOP to the viewport — crucial for long
      // assistant replies, where `center` would land halfway through the
      // body and miss the match entirely. `scroll-mt-6` on the element adds
      // a bit of visual breathing room so it's not glued to the top edge.
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      done = true;

      if (query) wrappedSpan = wrapFirstMatch(el, query);

      if (wrappedSpan) {
        timers.push(
          setTimeout(() => {
            if (wrappedSpan && wrappedSpan.isConnected) unwrapSpan(wrappedSpan);
            wrappedSpan = null;
          }, 2200)
        );
      } else {
        // No query, or query not found in rendered DOM — pulse the whole
        // message as a fallback.
        setFlashId(id);
        timers.push(setTimeout(() => setFlashId(null), 2200));
      }
    };

    for (const d of delays) timers.push(setTimeout(attempt, d));

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      // If the user navigates away mid-flash, undo the DOM mutation so we
      // don't leave a stray <span> behind on next visit.
      if (wrappedSpan && wrappedSpan.isConnected) unwrapSpan(wrappedSpan);
    };
  }, [location.hash, location.state, conversationId]);

  // Bottom-scroll on new content — but skip when we're handling a hash jump,
  // otherwise the jump would fight the bottom-scroll.
  useEffect(() => {
    if (location.hash.startsWith('#msg-')) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content, location.hash]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
        <div className="w-14 h-14 rounded-2xl bg-claude-accent/10 flex items-center justify-center mb-4">
          <Sparkles className="w-6 h-6 text-claude-accent" />
        </div>
        <h2 className="text-xl font-semibold mb-2">你今天想做点什么？</h2>
        <p className="text-sm text-claude-muted dark:text-night-muted max-w-md">
          Flaude 基于中国开源模型（DeepSeek / Qwen / GLM / Kimi），帮你对话、协作、写代码。
        </p>
      </div>
    );
  }

  // Map each assistant message's tool calls to the subsequent tool-role
  // messages so the card can show the paired result inline. This lets us hide
  // tool-role messages from the main flow (their content lives in the card).
  const toolResultsByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCalls?.[0]) {
      toolResultsByCallId.set(m.toolCalls[0].id, m.content);
    }
  }

  // Split at the archive boundary *before* filtering tool messages, so the
  // count semantics (raw-message index) stay consistent with what the hook
  // used when deciding the cut.
  const archivedMessages = messages
    .slice(0, effectiveSummaryCount)
    .filter((m) => m.role !== 'tool');
  const liveMessages = messages
    .slice(effectiveSummaryCount)
    .filter((m) => m.role !== 'tool');

  // Last-visible bookkeeping: if there are live messages, the regenerate /
  // streaming affordances attach to the final live one. If everything is
  // archived (rare edge case, e.g. user cleared recent), fall back to the
  // final archived one — but only when the archived section is actually
  // being rendered.
  const lastLiveMessage = liveMessages[liveMessages.length - 1];
  const lastArchivedMessage = archivedMessages[archivedMessages.length - 1];
  const lastVisibleMessage =
    lastLiveMessage ?? (showArchived ? lastArchivedMessage : undefined);

  const renderMessage = (m: Message, opts: { archived: boolean }) => (
    <MessageItem
      key={m.id}
      message={m}
      conversationId={conversationId}
      toolResults={toolResultsByCallId}
      onRegenerate={
        m === lastVisibleMessage && m.role === 'assistant' && !streaming
          ? onRegenerate
          : undefined
      }
      isLast={m === lastVisibleMessage}
      streaming={streaming && m === lastVisibleMessage}
      flashing={flashId === m.id}
      archived={opts.archived}
    />
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {effectiveSummaryCount > 0 && summary && showArchived && (
          <div className="rounded-lg border border-dashed border-claude-border dark:border-night-border bg-claude-surface/40 dark:bg-night-surface/40 px-3 py-2 text-xs text-claude-muted dark:text-night-muted">
            以下 {archivedMessages.length} 条为已摘要的原始消息，仅本地可见，不再发送给模型。
          </div>
        )}
        {effectiveSummaryCount > 0 && summary && showArchived &&
          archivedMessages.map((m) => renderMessage(m, { archived: true }))}
        {effectiveSummaryCount > 0 && summary && (
          <SummaryChip
            summary={summary}
            count={effectiveSummaryCount}
            at={summarizedAt}
            onClear={onClearSummary}
            showArchived={showArchived}
            onToggleArchived={() => setShowArchived((v) => !v)}
          />
        )}
        {liveMessages.map((m) => renderMessage(m, { archived: false }))}
        {streaming && messages[messages.length - 1]?.content === '' && (
          <div className="flex items-center gap-2 text-sm text-claude-muted dark:text-night-muted animate-pulse-subtle">
            <Loader2 className="w-4 h-4 animate-spin" />
            思考中...
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

interface ItemProps {
  message: Message;
  conversationId: string;
  toolResults: Map<string, string>;
  onRegenerate?: () => void;
  isLast: boolean;
  streaming?: boolean;
  /** True while this message is being flashed (jumped-to from search). */
  flashing?: boolean;
  /**
   * M6: true when this message falls in the archived (summarized) range and
   * is being shown via the eye toggle. Renders dimmer so the user can tell
   * at a glance "this isn't in the live context anymore."
   */
  archived?: boolean;
}

function MessageItem({
  message,
  conversationId,
  toolResults,
  onRegenerate,
  streaming,
  flashing,
  archived,
}: ItemProps) {
  const isUser = message.role === 'user';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  const updateMessage = useAppStore((s) => s.updateMessage);
  const deleteMessage = useAppStore((s) => s.deleteMessage);
  const branchConversation = useAppStore((s) => s.branchConversation);
  const artifacts = useAppStore((s) => s.artifacts);
  const setActiveArtifact = useAppStore((s) => s.setActiveArtifact);

  const save = () => {
    updateMessage(conversationId, message.id, { content: draft });
    setEditing(false);
  };

  // Split rendered content at [[ARTIFACT:id]] tokens so we can embed cards inline.
  const segments = splitWithArtifacts(message.content);

  return (
    <div
      id={`msg-${message.id}`}
      className={cn(
        // `scroll-mt-6` gives a bit of breathing room when `scrollIntoView`
        // aligns us to the top. `rounded-xl` matters because the flash
        // animation paints box-shadow + bg on this wrapper — matching the
        // bubble's corner radius keeps the ring looking intentional.
        'group flex gap-3 animate-fade-in scroll-mt-6 rounded-xl',
        isUser ? 'flex-row-reverse' : 'flex-row',
        // Pure keyframe animation (see tailwind.config.js → flashPop). We
        // avoid Tailwind custom-color + /alpha here because JIT has silently
        // produced empty rules in practice; literal rgba() inside keyframes
        // is bulletproof.
        flashing && 'animate-flash-pop',
        // Archived (summarized) messages render dimmer so the user can tell
        // at a glance these aren't in the live context anymore. We don't
        // disable interaction — edits / deletes still work locally.
        archived && 'opacity-60'
      )}
    >
      <div
        className={cn(
          'w-7 h-7 shrink-0 rounded-lg flex items-center justify-center text-xs font-semibold',
          isUser
            ? 'bg-claude-ink text-claude-bg dark:bg-night-ink dark:text-night-bg'
            : 'bg-claude-accent text-white'
        )}
      >
        {isUser ? <User className="w-3.5 h-3.5" /> : 'F'}
      </div>

      <div className={cn('flex-1 min-w-0', isUser && 'flex flex-col items-end')}>
        <div className={cn(isUser ? 'chat-bubble-user max-w-[80%]' : 'chat-bubble-assistant w-full')}>
          {/*
            推理 (extended thinking) UI. Three states:

            (a) Streaming, but neither reasoning nor content yet → model is
                "warming up" (network latency + first-token). Show a subtle
                "思考中…" pulser so the user knows something's happening.
            (b) Reasoning exists → render collapsible `<details>`. Auto-open
                while the answer hasn't started yet so the user can watch the
                CoT stream in; auto-close once real content starts so the
                eventual answer isn't buried under walls of thought.
            (c) Streaming done → details starts closed; user can still expand.

            We don't force any fancy animation — browser `<details>` toggle
            is cheap + accessible.
          */}
          {!isUser && streaming && !message.reasoning && !message.content && (
            <div className="mb-2 flex items-center gap-2 text-xs text-claude-muted dark:text-night-muted">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500/70 animate-pulse" />
              <span>思考中…</span>
            </div>
          )}
          {message.reasoning && (
            <details
              className="mb-2 text-xs text-claude-muted dark:text-night-muted"
              // Open while the CoT is still actively streaming AND no final
              // answer has started; close automatically thereafter.
              open={streaming && !message.content}
            >
              <summary className="cursor-pointer select-none hover:text-claude-ink dark:hover:text-night-ink inline-flex items-center gap-1.5">
                {streaming && !message.content ? (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500/70 animate-pulse" />
                ) : (
                  <span>💭</span>
                )}
                <span>
                  {streaming && !message.content
                    ? `思考中… (${message.reasoning.length} 字)`
                    : `推理过程（${message.reasoning.length} 字）`}
                </span>
              </summary>
              <div className="mt-2 pl-3 border-l-2 border-claude-border dark:border-night-border whitespace-pre-wrap leading-relaxed">
                {message.reasoning}
              </div>
            </details>
          )}

          {editing ? (
            <div className="space-y-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="w-full min-h-[80px] bg-transparent border border-claude-border dark:border-night-border rounded-lg p-2 text-sm focus:outline-none focus:border-claude-accent"
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setEditing(false)} className="btn-ghost">
                  取消
                </button>
                <button onClick={save} className="btn-primary">
                  保存
                </button>
              </div>
            </div>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:my-0 prose-pre:p-0 prose-pre:bg-transparent prose-code:before:content-none prose-code:after:content-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2">
              {segments.map((seg, i) =>
                seg.kind === 'text' ? (
                  <ReactMarkdown
                    key={i}
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeHighlight, rehypeKatex]}
                    components={{ pre: CodeBlock }}
                  >
                    {seg.content || (message.role === 'assistant' && !streaming ? '' : '…')}
                  </ReactMarkdown>
                ) : seg.id ? (
                  <ArtifactCard
                    key={i}
                    artifactId={seg.id}
                    artifact={artifacts[seg.id]}
                    streaming={streaming}
                    onOpen={() => setActiveArtifact(seg.id!)}
                  />
                ) : null
              )}
            </div>
          )}

          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.attachments.map((a) => (
                <div
                  key={a.id}
                  className="text-xs px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/10 truncate max-w-[200px]"
                  title={a.name}
                >
                  📎 {a.name}
                </div>
              ))}
            </div>
          )}

          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="mt-2">
              {message.toolCalls.map((t) => (
                <ToolCallCard
                  key={t.id}
                  call={t}
                  resultContent={toolResults.get(t.id)}
                />
              ))}
            </div>
          )}
        </div>

        {!editing && !streaming && (
          <div className={cn('w-full', isUser ? 'flex justify-end' : '')}>
            <MessageActions
              message={message}
              align={isUser ? 'right' : 'left'}
              onCopy={() => {}}
              onEdit={() => {
                setDraft(message.content);
                setEditing(true);
              }}
              onDelete={() => {
                if (confirm('删除这条消息？')) deleteMessage(conversationId, message.id);
              }}
              onRegenerate={onRegenerate}
              onBranch={() => branchConversation(conversationId, message.id)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible header shown above the message list when the conversation has
 * a stored summary. Closed by default (it's a reassurance, not the main
 * content). Expanding it reveals the summary markdown so the user can audit
 * what the model will see instead of the raw early messages.
 */
function SummaryChip({
  summary,
  count,
  at,
  onClear,
  showArchived,
  onToggleArchived,
}: {
  summary: string;
  count: number;
  at?: number;
  onClear?: () => void;
  /**
   * Whether the parent is currently rendering the archived raw messages.
   * The chip shows an Eye/EyeOff toggle that flips this.
   */
  showArchived?: boolean;
  onToggleArchived?: () => void;
}) {
  const [open, setOpen] = useState(false);

  const fmtAt = at
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(at))
    : null;

  return (
    <div className="rounded-xl border border-claude-border dark:border-night-border bg-claude-accent/5 text-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <Archive className="w-3.5 h-3.5 text-claude-accent shrink-0" />
        <span className="text-claude-ink dark:text-night-ink">
          已摘要前 <strong>{count}</strong> 条较早消息
          {fmtAt && (
            <span className="text-claude-muted dark:text-night-muted ml-1.5 text-xs">
              · {fmtAt}
            </span>
          )}
        </span>
        <button
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-xs text-claude-muted dark:text-night-muted hover:text-claude-ink dark:hover:text-night-ink flex items-center gap-0.5"
          aria-expanded={open}
          aria-label={open ? '收起摘要' : '展开摘要'}
        >
          {open ? (
            <>
              <ChevronDown className="w-3.5 h-3.5" />
              收起
            </>
          ) : (
            <>
              <ChevronRight className="w-3.5 h-3.5" />
              展开
            </>
          )}
        </button>
        {onToggleArchived && (
          <button
            onClick={onToggleArchived}
            className="text-xs text-claude-muted dark:text-night-muted hover:text-claude-ink dark:hover:text-night-ink flex items-center gap-0.5"
            title={showArchived ? '隐藏原文（已摘要的消息）' : '显示原文（已摘要的消息）'}
            aria-label={showArchived ? '隐藏已摘要的原始消息' : '显示已摘要的原始消息'}
            aria-pressed={showArchived}
          >
            {showArchived ? (
              <EyeOff className="w-3.5 h-3.5" />
            ) : (
              <Eye className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        {onClear && (
          <button
            onClick={() => {
              // Confirm — undoing puts the full early history back on the
              // wire, which could blow past the context limit the user
              // just worked around.
              if (confirm('撤销摘要？早期消息将恢复发送给模型（可能超出上下文）。')) {
                onClear();
              }
            }}
            className="text-xs text-claude-muted dark:text-night-muted hover:text-red-500 flex items-center gap-0.5"
            title="撤销摘要，恢复发送完整历史"
            aria-label="撤销摘要"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="px-3 pb-3 border-t border-claude-border/60 dark:border-night-border/60 pt-2">
          <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Walk text nodes under `root`, find the first case-insensitive occurrence of
 * `query`, and replace that slice with a `<span class="animate-flash-match">`.
 * Returns the injected span (or null if no match in visible text).
 *
 * Caveats:
 *  - We only match within a single text node. Markdown inline formatting
 *    (`pn**p**m`) splits text across nodes, in which case we fall back to
 *    whole-message flash. Handling cross-node matches needs `Range`
 *    spanning, which is a rabbit hole for marginal gain.
 *  - Ancestor `<details>` (e.g. collapsed reasoning blocks) are forced open,
 *    otherwise the flash would animate inside a display:none subtree and
 *    the user would see nothing.
 */
function wrapFirstMatch(root: HTMLElement, query: string): HTMLSpanElement | null {
  const qLower = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const text = textNode.textContent ?? '';
    const idx = text.toLowerCase().indexOf(qLower);
    if (idx < 0) continue;

    // Open any collapsed ancestor <details> so the flash is actually visible.
    for (let a: HTMLElement | null = textNode.parentElement; a && a !== root; a = a.parentElement) {
      if (a instanceof HTMLDetailsElement) a.open = true;
    }

    // Split: [prefix] [match] [tail]. splitText keeps the original node as
    // prefix and returns the remainder; a second call isolates the match.
    const matchOnly = textNode.splitText(idx);
    matchOnly.splitText(query.length);

    const span = document.createElement('span');
    // `rounded px-0.5` gives the background a bit of breathing room around
    // the letters; `animate-flash-match` is a pure background-color pulse
    // (see tailwind.config.js → flashMatch).
    span.className = 'animate-flash-match rounded px-0.5';
    span.textContent = matchOnly.textContent;
    matchOnly.replaceWith(span);
    return span;
  }
  return null;
}

/** Reverse of `wrapFirstMatch` — restore the original text node. */
function unwrapSpan(span: HTMLElement) {
  const parent = span.parentNode;
  if (!parent) return;
  parent.replaceChild(document.createTextNode(span.textContent ?? ''), span);
  // Merge the just-restored text with its now-adjacent siblings (prefix and
  // tail text nodes from the original split), so the DOM looks pristine.
  parent.normalize();
}

interface Segment {
  kind: 'text' | 'artifact';
  content?: string;
  id?: string;
}

function splitWithArtifacts(raw: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[\[ARTIFACT:([^\]]+)\]\]/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > lastIdx) {
      out.push({ kind: 'text', content: raw.slice(lastIdx, m.index) });
    }
    out.push({ kind: 'artifact', id: m[1] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < raw.length) out.push({ kind: 'text', content: raw.slice(lastIdx) });
  if (out.length === 0) out.push({ kind: 'text', content: raw });
  return out;
}

/**
 * Inline card that stands in for an artifact inside the assistant's message.
 *
 * Three visual states:
 *   1. **Normal** — artifact exists in the store. Clickable, opens it in the
 *      panel.
 *   2. **Streaming** — artifact is missing but this message is still being
 *      emitted. Almost always a transient tick between the `[[ARTIFACT:id]]`
 *      placeholder landing in text and `parseMessage` committing the artifact
 *      to the store; shows a muted "生成中..." hint.
 *   3. **Deleted (tombstone)** — artifact is missing AND the message is
 *      done streaming, which means the user deleted it from the panel.
 *      Rendered as a non-interactive, dashed-border, muted card with a
 *      trash icon — clear signal that there's nothing to open here anymore,
 *      without removing the placeholder (which would silently rewrite the
 *      assistant's message history).
 */
function ArtifactCard({
  artifactId,
  artifact,
  streaming,
  onOpen,
}: {
  artifactId: string;
  artifact?: import('@/lib/artifacts').Artifact;
  streaming?: boolean;
  onOpen: () => void;
}) {
  // Deleted: missing AND no longer streaming → tombstone.
  if (!artifact && !streaming) {
    return (
      <div
        className="my-2 w-full p-3 rounded-xl border border-dashed border-claude-border dark:border-night-border bg-claude-surface/40 dark:bg-night-surface/40 text-claude-muted dark:text-night-muted not-prose cursor-default select-none"
        title={`此工件已被删除（ID：${artifactId}）`}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-black/5 dark:bg-white/5 flex items-center justify-center">
            <Trash2 className="w-4 h-4 opacity-60" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium line-through opacity-80">
              工件已删除
            </div>
            <div className="text-xs truncate opacity-70">
              该工件已从工件面板中移除，无法再打开。
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={onOpen}
      className="my-2 w-full text-left p-3 rounded-xl border border-claude-border dark:border-night-border bg-claude-surface dark:bg-night-surface hover:border-claude-accent transition group/art not-prose"
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-claude-accent/10 flex items-center justify-center">
          <FileCode className="w-4 h-4 text-claude-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {artifact?.title || '生成中的工件...'}
          </div>
          <div className="text-xs text-claude-muted dark:text-night-muted truncate">
            {artifact?.type ? `类型：${artifact.type}` : `ID：${artifactId}`}
            {artifact?.content && ` · ${artifact.content.length} 字符`}
          </div>
        </div>
        <div className="text-xs text-claude-accent opacity-0 group-hover/art:opacity-100 transition">
          打开 →
        </div>
      </div>
    </button>
  );
}
