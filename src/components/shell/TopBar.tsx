import {
  PanelLeft,
  PanelRight,
  ChevronDown,
  Sun,
  Moon,
  MonitorSmartphone,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { cn } from '@/lib/utils';
import { useParams } from 'react-router-dom';
import { useMemo } from 'react';
import DownloadDesktopButton from './DownloadDesktopButton';

export default function TopBar() {
  const { conversationId } = useParams();
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleArtifacts = useAppStore((s) => s.toggleArtifacts);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const artifactsOpen = useAppStore((s) => s.artifactsOpen);
  const activeMode = useAppStore((s) => s.activeMode);
  const modelByMode = useAppStore((s) => s.modelByMode);
  const providers = useAppStore((s) => s.providers);
  const setModelForMode = useAppStore((s) => s.setModelForMode);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const conversations = useAppStore((s) => s.conversations);

  const allModels = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
        .flatMap((p) =>
          p.models.map((m) => ({
            ...m,
            providerName: p.displayName,
          }))
        ),
    [providers]
  );

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === conversationId),
    [conversations, conversationId]
  );

  const currentModelId = modelByMode[activeMode];
  const currentModel = allModels.find((m) => m.id === currentModelId);

  const cycleTheme = () => {
    const order = ['light', 'dark', 'system'] as const;
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  };

  return (
    <header className="h-12 shrink-0 border-b border-claude-border dark:border-night-border flex items-center px-2 gap-1">
      <button
        onClick={toggleSidebar}
        className="btn-ghost"
        aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
        title={sidebarOpen ? '收起侧栏（隐藏对话列表）' : '展开侧栏（显示对话列表）'}
      >
        <PanelLeft className="w-4 h-4" />
      </button>

      <div className="ml-2 text-sm truncate max-w-[40%]">
        {activeConv ? (
          <span className="font-medium">{activeConv.title}</span>
        ) : (
          <span className="text-claude-muted dark:text-night-muted">
            {activeMode === 'chat' ? 'Chat 对话' : 'Code 代码'}
          </span>
        )}
      </div>

      {/* Model picker */}
      <div className="ml-auto flex items-center gap-2">
        <DownloadDesktopButton />
        <div className="relative">
          <select
            value={currentModelId}
            onChange={(e) => setModelForMode(activeMode, e.target.value)}
            className={cn(
              'appearance-none text-sm pl-3 pr-8 py-1.5 rounded-lg',
              'bg-transparent border border-claude-border dark:border-night-border',
              'hover:border-claude-accent focus:outline-none focus:border-claude-accent',
              'cursor-pointer'
            )}
            aria-label="选择模型"
          >
            {allModels.length === 0 && (
              <option value="">未配置模型</option>
            )}
            {providers
              .filter((p) => p.enabled)
              .map((p) => (
                <optgroup key={p.id} label={p.displayName}>
                  {p.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
          <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-claude-muted dark:text-night-muted" />
        </div>

        {currentModel?.capabilities?.reasoning && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">
            推理
          </span>
        )}

        <button
          onClick={cycleTheme}
          className="btn-ghost"
          aria-label="切换主题"
          title={
            theme === 'light'
              ? '主题：浅色 · 点击切换到 深色'
              : theme === 'dark'
                ? '主题：深色 · 点击切换到 跟随系统'
                : '主题：跟随系统 · 点击切换到 浅色'
          }
        >
          {theme === 'light' ? (
            <Sun className="w-4 h-4" />
          ) : theme === 'dark' ? (
            <Moon className="w-4 h-4" />
          ) : (
            <MonitorSmartphone className="w-4 h-4" />
          )}
        </button>

        <button
          onClick={toggleArtifacts}
          className={cn('btn-ghost', artifactsOpen && 'bg-black/5 dark:bg-white/5')}
          aria-label="工件面板"
          title={artifactsOpen ? '关闭工件面板' : '打开工件面板（查看代码 / 网页 / 图表等生成物）'}
        >
          <PanelRight className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
