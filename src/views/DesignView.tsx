/**
 * DesignView — third sibling of ChatView and CodeView.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────┐
 *   │ AppShell TopBar (model picker / mode switch)   │
 *   ├──────────────┬─────────────────────────────────┤
 *   │  Messages    │                                 │
 *   │  +           │       DesignCanvas (iframe)     │
 *   │  Composer    │                                 │
 *   │ (left ~440)  │       (right, fills rest)       │
 *   └──────────────┴─────────────────────────────────┘
 *
 * The chat side is intentionally narrower than ChatView's full-width chat:
 * design-mode messages are short ("make it more playful"), and the canvas
 * is the star of the show. We don't currently make the divider draggable —
 * Phase 2 work; for Phase 1 a fixed split keeps focus on the actual canvas.
 *
 * Model routing:
 *   - Default per-mode model is `deepseek-v4-pro` (see DEFAULT_MODEL_BY_MODE).
 *   - When a turn includes image attachments, we transparently route just
 *     that turn through `qwen-max` (vision-capable) — see
 *     `DESIGN_VISION_FALLBACK_MODEL`. After the turn, the conversation falls
 *     back to its stored modelId for subsequent text-only messages. That
 *     auto-route logic lives in the streaming layer, NOT in this view; this
 *     view just displays the conversation as-is.
 */
import { useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '@/store/useAppStore';
import MessageList from '@/components/chat/MessageList';
import Composer from '@/components/chat/Composer';
import DesignCanvas from '@/components/design/DesignCanvas';
import { useStreamedChat } from '@/hooks/useStreamedChat';
import { composeSystemPrompt } from '@/lib/systemPrompt';
import { DESIGN_BASE_PROMPT } from '@/config/designSystemPrompt';
import { allDesignBlocks } from '@/lib/designExtract';

export default function DesignView() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const conversations = useAppStore((s) => s.conversations);
  const projects = useAppStore((s) => s.projects);
  const globalMemory = useAppStore((s) => s.globalMemory);
  const skills = useAppStore((s) => s.skills);
  const newConversation = useAppStore((s) => s.newConversation);
  const setActiveConversation = useAppStore((s) => s.setActiveConversation);
  const setConversationSummary = useAppStore((s) => s.setConversationSummary);

  const conversation = useMemo(
    () => conversations.find((c) => c.id === conversationId && c.mode === 'design'),
    [conversations, conversationId]
  );

  const project = useMemo(
    () =>
      conversation?.projectId
        ? projects.find((p) => p.id === conversation.projectId)
        : undefined,
    [conversation?.projectId, projects]
  );

  const systemPrompt = useMemo(
    () =>
      composeSystemPrompt({
        basePrompt: DESIGN_BASE_PROMPT,
        mode: 'design',
        globalMemory,
        skills,
        project,
      }),
    [project, globalMemory, skills]
  );

  useEffect(() => {
    if (!conversationId) {
      const id = newConversation('design');
      navigate(`/design/${id}`, { replace: true });
    } else if (!conversation) {
      navigate('/design', { replace: true });
    } else {
      setActiveConversation(conversationId);
    }
  }, [conversationId, conversation, newConversation, navigate, setActiveConversation]);

  const chat = useStreamedChat({
    conversation: conversation ?? {
      id: '__placeholder__',
      title: '',
      mode: 'design',
      modelId: '',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    },
    systemPrompt,
  });

  // Every assistant turn that produced a renderable block becomes a "version"
  // the user can flip back to. We compute the full list here and let the
  // canvas pick which one to display (it auto-tracks the latest until the
  // user manually steps backwards). Cheap re-derivation on every render —
  // the message array is normally small and the regex scan is microseconds.
  const designBlocks = useMemo(
    () => (conversation ? allDesignBlocks(conversation) : []),
    [conversation]
  );

  // (v0.1.51) The "switch to Flash to save money" banner was removed — model
  // pricing tradeoffs are now surfaced inline in the TopBar 3-slot picker
  // (语言 / 视觉 / 生图), and most Design users in v0.1.49+ are routing through
  // Claude or Qwen anyway, where the V4-Pro-vs-Flash dichotomy doesn't apply.

  if (!conversation) {
    return <div className="flex-1" />;
  }

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left: chat column */}
      <div className="w-[440px] shrink-0 flex flex-col min-h-0 border-r border-claude-border dark:border-night-border bg-claude-surface dark:bg-night-surface">
        <MessageList
          messages={conversation.messages}
          conversationId={conversation.id}
          streaming={chat.streaming}
          onRegenerate={chat.regenerate}
          summary={conversation.summary}
          summaryMessageCount={conversation.summaryMessageCount}
          summarizedAt={conversation.summarizedAt}
          onClearSummary={() => setConversationSummary(conversation.id, undefined, undefined)}
          // Design mode: keep the chat column readable. The right-hand canvas
          // already renders the full HTML; doubling it inline (especially on
          // a 200-line palette/poster page) buries the user's prompt + any
          // model commentary under a wall of source. We replace each design
          // fence with a one-line "已生成设计稿 · 见右侧画布" chip.
          hideDesignBlocks
        />
        <Composer
          onSend={chat.send}
          onStop={chat.stop}
          streaming={chat.streaming}
          onCompressHistory={chat.compress}
          compressing={chat.compressing}
          messageCount={conversation.messages.length}
          placeholder="描述你想要的页面（贴一张截图也行）..."
        />
      </div>

      {/* Right: canvas. `relative` lets the streaming overlay inside the
          canvas position absolutely against this column. */}
      <div className="flex-1 flex min-h-0 relative">
        <DesignCanvas blocks={designBlocks} streaming={chat.streaming} />
      </div>
    </div>
  );
}
