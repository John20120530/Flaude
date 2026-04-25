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
import { Sparkles, Zap } from 'lucide-react';

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
  const setConversationModel = useAppStore((s) => s.setConversationModel);
  const setModelForMode = useAppStore((s) => s.setModelForMode);

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

  // Default for design is V4 Pro — we surface a "切到 Flash 省钱" hint so
  // users who don't need flagship-level polish can knock the cost down ~12x
  // by switching. Hidden for non-Pro models (the user already escaped the
  // default), and hidden once they've sent at least one message in this
  // conversation (the hint is decision-time UX, not a permanent banner).
  const showFlashHint =
    conversation?.modelId === 'deepseek-v4-pro' &&
    (conversation?.messages.length ?? 0) === 0;

  const switchToFlash = () => {
    if (!conversation) return;
    setConversationModel(conversation.id, 'deepseek-chat');
    // Update the per-mode default too so the next new design conversation
    // starts on Flash without the user having to click again. They can flip
    // back from the TopBar picker if they regret it.
    setModelForMode('design', 'deepseek-chat');
  };

  if (!conversation) {
    return <div className="flex-1" />;
  }

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left: chat column */}
      <div className="w-[440px] shrink-0 flex flex-col min-h-0 border-r border-claude-border dark:border-night-border bg-claude-surface dark:bg-night-surface">
        {showFlashHint && (
          <div className="px-3 py-2 border-b border-claude-border dark:border-night-border bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
            <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1">
              当前用 <strong>DeepSeek V4 Pro</strong> —— 设计稿质量更高，但每 1M tokens 约 $1.74。
              简单设计可以
              <button
                type="button"
                onClick={switchToFlash}
                className="mx-1 underline decoration-dotted hover:decoration-solid inline-flex items-center gap-0.5"
              >
                <Zap className="w-3 h-3" />
                切到 V4 Flash
              </button>
              省 ~12 倍 token 费。
            </div>
          </div>
        )}
        <MessageList
          messages={conversation.messages}
          conversationId={conversation.id}
          streaming={chat.streaming}
          onRegenerate={chat.regenerate}
          summary={conversation.summary}
          summaryMessageCount={conversation.summaryMessageCount}
          summarizedAt={conversation.summarizedAt}
          onClearSummary={() => setConversationSummary(conversation.id, undefined, undefined)}
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
