import { useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAppStore } from '@/store/useAppStore';
import MessageList from '@/components/chat/MessageList';
import Composer from '@/components/chat/Composer';
import { useStreamedChat } from '@/hooks/useStreamedChat';
import { ARTIFACT_SYSTEM_HINT } from '@/lib/artifacts';
import { composeSystemPrompt } from '@/lib/systemPrompt';
import { FolderKanban } from 'lucide-react';

const CHAT_BASE_PROMPT = `你是 Flaude，一个基于中国开源模型的智能助手。你的风格类似 Claude：思考清晰、表达简洁、诚实可靠。
- 回答中文时用中文，回答英文时用英文，保持自然。
- 使用 Markdown 格式，代码块加语言标注。
- 数学公式用 KaTeX 语法（$...$ 或 $$...$$）。
- 不确定时直说「我不确定」，不要编造。

${ARTIFACT_SYSTEM_HINT}`;

export default function ChatView() {
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
    () => conversations.find((c) => c.id === conversationId && c.mode === 'chat'),
    [conversations, conversationId]
  );

  const project = useMemo(
    () => (conversation?.projectId ? projects.find((p) => p.id === conversation.projectId) : undefined),
    [conversation?.projectId, projects]
  );

  const systemPrompt = useMemo(
    () =>
      composeSystemPrompt({
        basePrompt: CHAT_BASE_PROMPT,
        mode: 'chat',
        globalMemory,
        skills,
        project,
      }),
    [project, globalMemory, skills]
  );

  useEffect(() => {
    if (!conversationId) {
      const id = newConversation('chat');
      navigate(`/chat/${id}`, { replace: true });
    } else if (!conversation) {
      navigate('/chat', { replace: true });
    } else {
      setActiveConversation(conversationId);
    }
  }, [conversationId, conversation, newConversation, navigate, setActiveConversation]);

  const chat = useStreamedChat({
    conversation: conversation ?? {
      id: '__placeholder__',
      title: '',
      mode: 'chat',
      modelId: '',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    },
    systemPrompt,
  });

  if (!conversation) {
    return <div className="flex-1" />;
  }

  return (
    // `min-w-0` is non-obvious but essential: without it, a wide child
    // (e.g. a MessageList CodeBlock containing a long HTML source line)
    // forces this flex item wider than its parent, visually bleeding into
    // the right-side ArtifactsPanel when it's open.
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {project && (
        <div className="px-4 py-1.5 border-b border-claude-border dark:border-night-border bg-claude-accent/5 flex items-center gap-2 text-xs">
          <FolderKanban className="w-3.5 h-3.5 text-claude-accent" />
          <span>
            项目：<strong>{project.name}</strong> · 项目指令与 {project.sources.length} 个知识源已加载
          </span>
          <button
            onClick={() => navigate(`/projects/${project.id}`)}
            className="ml-auto text-claude-accent hover:underline"
          >
            管理
          </button>
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
        placeholder={
          project ? `在「${project.name}」项目中提问...` : '问 Flaude 任何问题...'
        }
      />
    </div>
  );
}
