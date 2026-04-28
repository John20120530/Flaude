import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Terminal as TerminalIcon,
  GitBranch,
  Activity,
  FolderOpen,
  Wrench,
  FolderPlus,
  Eye,
  EyeOff,
  X,
  FileText,
  RefreshCw,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import MessageList from '@/components/chat/MessageList';
import Composer from '@/components/chat/Composer';
import ToolActivityPanel from '@/components/chat/ToolActivityPanel';
import FileTree from '@/components/code/FileTree';
import Terminal from '@/components/code/Terminal';
import BackgroundTasksPanel from '@/components/code/BackgroundTasksPanel';
import { useBackgroundTasks } from '@/hooks/useBackgroundTasks';
import TodoPanel from '@/components/code/TodoPanel';
import { useStreamedChat } from '@/hooks/useStreamedChat';
import { cn } from '@/lib/utils';
import { isTauri, pickFolder } from '@/lib/tauri';
import { composeSystemPrompt } from '@/lib/systemPrompt';
import {
  loadWorkspaceMemory,
  WORKSPACE_MEMORY_FILENAMES,
  type WorkspaceMemory,
} from '@/lib/workspaceMemory';

// Code-mode base prompts moved to src/config/codeSystemPrompt.ts so the
// subagent runtime (src/lib/subagent.ts) can use them without importing
// from a view module.
import {
  CODE_BASE_PROMPT_WITH_WORKSPACE,
  CODE_BASE_PROMPT_NO_WORKSPACE,
} from '@/config/codeSystemPrompt';

export default function CodeView() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const conversations = useAppStore((s) => s.conversations);
  const projects = useAppStore((s) => s.projects);
  const globalMemory = useAppStore((s) => s.globalMemory);
  const skills = useAppStore((s) => s.skills);
  const newConversation = useAppStore((s) => s.newConversation);
  const setActiveConversation = useAppStore((s) => s.setActiveConversation);
  const setConversationSummary = useAppStore((s) => s.setConversationSummary);
  const workspacePath = useAppStore((s) => s.workspacePath);
  const setWorkspacePath = useAppStore((s) => s.setWorkspacePath);

  const conversation = useMemo(
    () => conversations.find((c) => c.id === conversationId && c.mode === 'code'),
    [conversations, conversationId]
  );

  const project = useMemo(
    () => (conversation?.projectId ? projects.find((p) => p.id === conversation.projectId) : undefined),
    [conversation?.projectId, projects]
  );

  // Workspace memory (FLAUDE.md / CLAUDE.md at the workspace root). Reloaded
  // when the workspace changes and when the window is focused — that second
  // trigger means edits made in an external editor show up the next time
  // the user clicks back into Flaude, no manual refresh required. We also
  // expose a manual refresh button on the badge for users who want to
  // verify a change before sending.
  const [workspaceMemory, setWorkspaceMemory] = useState<WorkspaceMemory | null>(
    null
  );
  const [memoryLoading, setMemoryLoading] = useState(false);

  const reloadWorkspaceMemory = useCallback(async () => {
    setMemoryLoading(true);
    try {
      const mem = await loadWorkspaceMemory(workspacePath);
      setWorkspaceMemory(mem);
    } finally {
      setMemoryLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    void reloadWorkspaceMemory();
  }, [reloadWorkspaceMemory]);

  // Re-read on window focus so external edits to FLAUDE.md show up without
  // a manual refresh. Cheap (a single Tauri IPC + small file read), runs
  // only when the window genuinely regained focus.
  useEffect(() => {
    if (!workspacePath) return;
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void reloadWorkspaceMemory();
      }
    };
    window.addEventListener('focus', onVis);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', onVis);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [workspacePath, reloadWorkspaceMemory]);

  const systemPrompt = useMemo(
    () =>
      composeSystemPrompt({
        // Swap the base prompt based on whether a workspace is set. Without
        // one, fs_* / shell_exec will throw at call time — cheaper to tell
        // the model up front than to burn a round trip on the error.
        basePrompt: workspacePath
          ? CODE_BASE_PROMPT_WITH_WORKSPACE
          : CODE_BASE_PROMPT_NO_WORKSPACE,
        mode: 'code',
        globalMemory,
        workspaceMemory: workspaceMemory
          ? { filename: workspaceMemory.filename, content: workspaceMemory.content }
          : undefined,
        skills,
        project,
      }),
    [project, globalMemory, skills, workspacePath, workspaceMemory]
  );

  useEffect(() => {
    if (!conversationId) {
      const id = newConversation('code');
      navigate(`/code/${id}`, { replace: true });
    } else if (!conversation) {
      navigate('/code', { replace: true });
    } else {
      setActiveConversation(conversationId);
    }
  }, [conversationId, conversation, newConversation, navigate, setActiveConversation]);

  // Restore the conversation's bound workspace when the user clicks back
  // to it from the sidebar. Each Code conversation stamps the active
  // workspace at creation time (see store.newConversation), so re-opening
  // an old conversation should pop you back to its folder — otherwise
  // the agent's previous file references become invalid.
  //
  // Guards:
  //   - only fires when conversation actually changes (not on every render)
  //   - skips if the conversation has no workspacePath (legacy) — leaves
  //     the global state alone in that case rather than clearing
  //   - skips if it's already the same path (no-op idempotency)
  useEffect(() => {
    if (!conversation || conversation.mode !== 'code') return;
    const bound = conversation.workspacePath ?? '';
    const current = workspacePath || '';
    if (bound && bound !== current) {
      setWorkspacePath(bound);
    }
    // workspacePath intentionally NOT in deps — we only react to the
    // conversation switching, not to subsequent workspace changes within
    // the same conversation (which only happen via openWorkspace, which
    // already spawns a new conversation).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id]);

  const [bottomTab, setBottomTab] = useState<'tools' | 'terminal' | 'git' | 'background'>(
    'tools'
  );
  const [showHidden, setShowHidden] = useState(false);

  // Drag-to-resize the bottom panel (Tools/Terminal/Git/后台任务). Same
  // closure-captures-startY pattern as the artifacts panel in AppShell —
  // store action clamps to [80, 800] so we don't have to re-clamp here.
  const bottomPanelHeight = useAppStore((s) => s.codeBottomPanelHeight);
  const setBottomPanelHeight = useAppStore((s) => s.setCodeBottomPanelHeight);
  const onBottomDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = bottomPanelHeight;
    const onMove = (ev: MouseEvent) => {
      // Divider sits ABOVE the bottom panel — moving the mouse UP grows the
      // panel (more room for output), DOWN shrinks it.
      setBottomPanelHeight(startH + (startY - ev.clientY));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  // We poll bgshell from CodeView (not just the panel) so the tab badge
  // shows a running count even when the user is on the Tools/Terminal tab.
  // Cost: one IPC call every 2s. Pays for itself the first time someone
  // forgets they left a `pnpm test --watch` running and the panel beckons.
  const bgTasks = useBackgroundTasks({ active: true });
  const runningCount = bgTasks.tasks.filter((t) => t.running).length;

  const chat = useStreamedChat({
    conversation: conversation ?? {
      id: '__placeholder__',
      title: '',
      mode: 'code',
      modelId: '',
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    },
    systemPrompt,
  });

  // When the workspace changes (or is closed), the agent's accumulated
  // context — file paths it has read, FLAUDE.md content, the project's
  // build/test commands — all become stale. Continuing the same
  // conversation under a new workspace produces confusing replies that
  // mix old + new state, and the agent might still try to read paths
  // that no longer exist.
  //
  // Solution: spawn a fresh code conversation when the workspace
  // actually transitions. Skip the spawn if the user picked the same
  // folder they already had open (idempotent reselect).
  const switchWorkspaceWithNewConversation = (newPath: string) => {
    const wasDifferent = (workspacePath || '') !== newPath;
    setWorkspacePath(newPath);
    if (wasDifferent) {
      const id = newConversation('code');
      navigate(`/code/${id}`, { replace: true });
    }
  };

  const openWorkspace = async () => {
    if (!isTauri()) {
      alert(
        'Flaude 当前运行在浏览器中，只能用 MCP 工具。\n要操作本地文件请用 `pnpm tauri dev` 启动桌面版。'
      );
      return;
    }
    try {
      const picked = await pickFolder('选择工作区');
      if (picked) switchWorkspaceWithNewConversation(picked);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const closeWorkspace = () => {
    switchWorkspaceWithNewConversation('');
  };

  if (!conversation) return <div className="flex-1" />;

  return (
    <div className="flex-1 flex min-h-0">
      {/* File explorer */}
      <aside className="w-[260px] shrink-0 border-r border-claude-border dark:border-night-border bg-claude-surface dark:bg-night-surface flex flex-col min-h-0">
        <div className="h-10 px-3 flex items-center gap-2 border-b border-claude-border dark:border-night-border text-sm font-medium shrink-0">
          <FolderOpen className="w-4 h-4" />
          <span className="truncate">文件浏览器</span>
          {workspacePath && (
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="ml-auto text-claude-muted hover:text-claude-ink dark:hover:text-night-ink"
              title={showHidden ? '隐藏 dotfiles' : '显示 dotfiles'}
            >
              {showHidden ? (
                <Eye className="w-3.5 h-3.5" />
              ) : (
                <EyeOff className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {workspacePath ? (
            <>
              <div
                className="px-3 py-1.5 text-[11px] font-mono text-claude-muted dark:text-night-muted truncate border-b border-claude-border/50 dark:border-night-border/50"
                title={workspacePath}
              >
                {workspacePath}
              </div>
              <WorkspaceMemoryBadge
                memory={workspaceMemory}
                loading={memoryLoading}
                onRefresh={reloadWorkspaceMemory}
              />
              <FileTree
                key={workspacePath + (showHidden ? ':hidden' : '')}
                workspace={workspacePath}
                showHidden={showHidden}
              />
            </>
          ) : (
            <button
              type="button"
              onClick={openWorkspace}
              className="w-full p-4 text-center text-xs text-claude-muted dark:text-night-muted hover:bg-claude-bg/50 dark:hover:bg-night-bg/50 active:bg-claude-bg dark:active:bg-night-bg transition-colors cursor-pointer"
              title={isTauri() ? '点击选择一个文件夹' : '仅桌面版可用'}
            >
              <FolderPlus className="w-6 h-6 mx-auto mb-2 opacity-50" />
              <div className="font-medium text-claude-ink dark:text-night-ink">
                {isTauri() ? '点击打开工作区' : '尚未打开工作区'}
              </div>
              <div className="mt-1 opacity-70">
                {isTauri()
                  ? '选择一个文件夹让 Flaude 读/写文件'
                  : '浏览器模式不可用；请用 pnpm tauri:dev 启动桌面版'}
              </div>
            </button>
          )}
        </div>

        <div className="p-2 border-t border-claude-border dark:border-night-border shrink-0 flex items-center gap-1">
          <button
            onClick={openWorkspace}
            className="btn-ghost flex-1 justify-center text-xs"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            {workspacePath ? '更换工作区' : '打开工作区'}
          </button>
          {workspacePath && (
            <button
              onClick={closeWorkspace}
              className="btn-ghost shrink-0 px-2 justify-center text-xs"
              title="关闭工作区（不会删除任何文件，会开新对话）"
              aria-label="关闭工作区"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </aside>

      {/* Main chat + bottom panel.
          `min-w-0` on BOTH levels is essential: CodeView sits inside a flex
          row (sidebar · chat · ArtifactsPanel), and a wide child — like a
          MessageList CodeBlock with long HTML lines — would otherwise push
          this column wider than its allotted share, visually bleeding into
          the right-side panel. */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/*
            Agent-maintained TODO list. Sits above the message list so the
            user can always see the plan without scrolling. The panel self-
            hides when the list is empty, so there's no visible cost when
            the model isn't using `todo_write`.
          */}
          <TodoPanel conversationId={conversation.id} />
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
            placeholder="描述代码任务，Flaude 会读文件、改代码、跑命令..."
          />
        </div>

        {/* Drag handle for resizing the bottom panel. Sits above the tab
            strip; user drags up to grow the panel, down to shrink. We
            give it a generous hit area (h-1.5) but no visual noise — only
            the cursor change + a subtle accent on hover signals that it
            grabs. */}
        <div
          onMouseDown={onBottomDragStart}
          className="h-1.5 shrink-0 cursor-row-resize bg-claude-border dark:bg-night-border hover:bg-claude-accent/60 transition-colors"
          aria-label="拖动调整面板高度"
          role="separator"
          aria-orientation="horizontal"
        />
        {/* Bottom tabs */}
        <div
          className="shrink-0 border-t border-claude-border dark:border-night-border bg-claude-surface dark:bg-night-surface"
          style={{ height: `${bottomPanelHeight}px` }}
        >
          <div className="h-8 flex items-center border-b border-claude-border dark:border-night-border">
            {(['tools', 'terminal', 'git', 'background'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setBottomTab(t)}
                className={cn(
                  'px-3 h-full text-xs flex items-center gap-1.5',
                  bottomTab === t
                    ? 'border-b-2 border-claude-accent text-claude-ink dark:text-night-ink'
                    : 'text-claude-muted dark:text-night-muted'
                )}
              >
                {t === 'tools' ? (
                  <>
                    <Wrench className="w-3.5 h-3.5" /> 工具
                  </>
                ) : t === 'terminal' ? (
                  <>
                    <TerminalIcon className="w-3.5 h-3.5" /> Terminal
                  </>
                ) : t === 'git' ? (
                  <>
                    <GitBranch className="w-3.5 h-3.5" /> Git
                  </>
                ) : (
                  <>
                    <Activity className="w-3.5 h-3.5" /> 后台任务
                    {runningCount > 0 && (
                      <span
                        className="ml-0.5 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full text-[10px] font-medium bg-emerald-500 text-white"
                        aria-label={`${runningCount} 个后台任务正在运行`}
                      >
                        {runningCount}
                      </span>
                    )}
                  </>
                )}
              </button>
            ))}
          </div>
          {/*
            All three panes stay mounted — we just hide the inactive ones with
            `hidden`. The Terminal in particular needs to keep its PTY alive
            across tab flips, otherwise your running shell (and whatever's
            scrolled back) evaporates when you peek at the Tools tab.
            The Terminal's ResizeObserver also silently skips fit() when the
            element is display:none, so no extra gating needed.
          */}
          {/* Tab content fills whatever height remains after the 32px tab
              strip. Using inset-0 inside `flex-1` keeps the absolute-
              positioned tab panes (Terminal, ToolActivityPanel) sized
              correctly at any height. */}
          <div className="relative" style={{ height: `${bottomPanelHeight - 32}px` }}>
            <div className={cn('absolute inset-0 overflow-y-auto', bottomTab !== 'tools' && 'hidden')}>
              <ToolActivityPanel messages={conversation.messages} />
            </div>
            <div className={cn('absolute inset-0', bottomTab !== 'terminal' && 'hidden')}>
              <Terminal workspace={workspacePath || undefined} />
            </div>
            <div className={cn('absolute inset-0 p-3 font-mono text-xs text-claude-muted dark:text-night-muted', bottomTab !== 'git' && 'hidden')}>
              {workspacePath
                ? '让 Agent 调用 shell_exec 跑 `git status` 查看状态。'
                : '打开工作区后可通过 shell_exec 使用 git。'}
            </div>
            <div className={cn('absolute inset-0 overflow-hidden', bottomTab !== 'background' && 'hidden')}>
              <BackgroundTasksPanel active={bottomTab === 'background'} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Small status pill shown above the FileTree in Code mode. Its job is to
 * make the (otherwise invisible) workspace-memory injection legible:
 * the user should be able to glance at it and know whether a FLAUDE.md /
 * CLAUDE.md is being merged into the system prompt right now.
 *
 * States:
 *   - loading            → refresh icon spins, label still reflects last state
 *   - found, normal      → green "FLAUDE.md · 2.1 KB"
 *   - found, truncated   → amber "FLAUDE.md · 102 KB · 已截断"
 *   - not found          → muted "未找到 FLAUDE.md / CLAUDE.md"
 */
function WorkspaceMemoryBadge({
  memory,
  loading,
  onRefresh,
}: {
  memory: WorkspaceMemory | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const candidates = WORKSPACE_MEMORY_FILENAMES.join(' / ');
  const sizeLabel = memory
    ? memory.sizeBytes < 1024
      ? `${memory.sizeBytes} B`
      : `${(memory.sizeBytes / 1024).toFixed(1)} KB`
    : '';

  return (
    <div
      className={cn(
        'px-3 py-1.5 text-[11px] flex items-center gap-1.5',
        'border-b border-claude-border/50 dark:border-night-border/50',
        memory
          ? memory.truncated
            ? 'bg-amber-50/40 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300'
            : 'bg-emerald-50/40 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300'
          : 'text-claude-muted dark:text-night-muted'
      )}
      title={
        memory
          ? `${memory.filename} 已注入到 Code 模式 system prompt（${sizeLabel}${memory.truncated ? '，已截断' : ''}）。外部编辑器改这个文件、回到 Flaude 时会自动重新加载；点刷新按钮也可立即重读。`
          : `在工作区根目录创建 ${candidates}（前者优先），写下项目约定（构建命令、命名规范、避免改动的目录等），Flaude 会自动注入到 Code 模式 system prompt。`
      }
    >
      <FileText className="w-3 h-3 shrink-0" />
      <span className="truncate flex-1 min-w-0">
        {memory
          ? `${memory.filename} · ${sizeLabel}${memory.truncated ? ' · 已截断' : ''}`
          : `未找到 ${candidates}`}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className={cn(
          'shrink-0 p-0.5 rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.06]',
          'disabled:opacity-50',
          loading && 'animate-spin'
        )}
        title={memory ? '重新加载' : '检查文件是否已创建'}
        aria-label="重新加载 workspace memory"
      >
        <RefreshCw className="w-3 h-3" />
      </button>
    </div>
  );
}
