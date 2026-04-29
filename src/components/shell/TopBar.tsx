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
  const setConversationModel = useAppStore((s) => s.setConversationModel);
  const designVisionModelId = useAppStore((s) => s.designVisionModelId);
  const setDesignVisionModelId = useAppStore(
    (s) => s.setDesignVisionModelId,
  );
  const designImageGenModelId = useAppStore((s) => s.designImageGenModelId);
  const setDesignImageGenModelId = useAppStore(
    (s) => s.setDesignImageGenModelId,
  );
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const conversations = useAppStore((s) => s.conversations);

  // Three filtered candidate lists used by Design mode's 3-slot picker. Cheap
  // re-derivation; mirrors the logic in SettingsView's <DefaultModelsSection>
  // so the two places never drift in what each slot accepts.
  const { languageProviders, visionProviders, imageGenProviders, allModels } =
    useMemo(() => {
      const enabled = providers.filter((p) => p.enabled);
      const language = enabled
        .map((p) => ({
          ...p,
          models: p.models.filter((m) => !m.capabilities.imageGen),
        }))
        .filter((p) => p.models.length > 0);
      const vision = enabled
        .map((p) => ({
          ...p,
          models: p.models.filter((m) => m.capabilities.vision),
        }))
        .filter((p) => p.models.length > 0);
      const imageGen = enabled
        .map((p) => ({
          ...p,
          models: p.models.filter((m) => m.capabilities.imageGen),
        }))
        .filter((p) => p.models.length > 0);
      const flat = enabled.flatMap((p) =>
        p.models.map((m) => ({ ...m, providerName: p.displayName })),
      );
      return {
        languageProviders: language,
        visionProviders: vision,
        imageGenProviders: imageGen,
        allModels: flat,
      };
    }, [providers]);

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === conversationId),
    [conversations, conversationId],
  );

  // Show the currently-active conversation's stamped modelId if one exists,
  // otherwise the per-mode default (which becomes the next new conversation's
  // model). Until v0.1.51 this only read modelByMode, which made the badge
  // lie when the user opened an old conversation: TopBar said "Claude Opus"
  // but the conversation's stamped modelId was still 'deepseek-v4-pro' from
  // when it was created, so the request silently went to DeepSeek and the
  // response metadata correctly read deepseek-v4-pro. Reading the conv first
  // makes the badge match what's actually being sent.
  const currentModelId =
    activeConv?.modelId ?? modelByMode[activeMode];
  const currentModel = allModels.find((m) => m.id === currentModelId);

  // Picking a new language model from the TopBar should affect both:
  //   1. The active conversation immediately (so the very next send uses the
  //      newly-picked model), and
  //   2. The per-mode default (so the next new conversation in this mode also
  //      starts on it).
  // Without #1 the user picks Claude, sees the badge flip, fires a message,
  // and gets DeepSeek back — confusing as hell. Without #2 they'd have to
  // re-pick on every new conversation.
  const onPickLanguageModel = (mode: typeof activeMode, modelId: string) => {
    setModelForMode(mode, modelId);
    if (activeConv && activeConv.mode === mode) {
      setConversationModel(activeConv.id, modelId);
    }
  };

  const cycleTheme = () => {
    const order = ['light', 'dark', 'system'] as const;
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  };

  const isDesign = activeMode === 'design';

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

      <div
        className={cn(
          'ml-2 text-sm truncate',
          // Design mode squeezes the title harder so the 3 model selectors
          // have room to breathe on a 1280×720 default window.
          isDesign ? 'max-w-[20%]' : 'max-w-[40%]',
        )}
      >
        {activeConv ? (
          <span className="font-medium">{activeConv.title}</span>
        ) : (
          <span className="text-claude-muted dark:text-night-muted">
            {activeMode === 'chat'
              ? 'Chat 对话'
              : activeMode === 'code'
                ? 'Code 代码'
                : 'Design 设计'}
          </span>
        )}
      </div>

      {/* Model picker — single select for Chat/Code; three-slot panel for
          Design (语言 / 视觉 / 生图). The reasoning badge follows the active
          mode's primary language model in both layouts. */}
      <div className="ml-auto flex items-center gap-2">
        <DownloadDesktopButton />

        {isDesign ? (
          <>
            <ModelSlot
              label="语言"
              title="语言模型 — 生成 HTML/SVG/解释"
              value={
                activeConv?.mode === 'design'
                  ? (activeConv.modelId ?? modelByMode.design)
                  : modelByMode.design
              }
              onChange={(v) => onPickLanguageModel('design', v)}
              groups={languageProviders}
              emptyHint="无可用模型"
            />
            <ModelSlot
              label="视觉"
              title="视觉模型 — 理解上传图片"
              value={designVisionModelId}
              onChange={setDesignVisionModelId}
              groups={visionProviders}
              emptyHint="无视觉模型"
            />
            <ModelSlot
              label="生图"
              title="生图模型 — agent 调用 image_generate 工具时使用"
              value={designImageGenModelId}
              onChange={setDesignImageGenModelId}
              groups={imageGenProviders}
              emptyHint="无生图模型"
            />
          </>
        ) : (
          <div className="relative">
            <select
              value={currentModelId}
              onChange={(e) => onPickLanguageModel(activeMode, e.target.value)}
              className={cn(
                'appearance-none text-sm pl-3 pr-8 py-1.5 rounded-lg',
                'bg-transparent border border-claude-border dark:border-night-border',
                'hover:border-claude-accent focus:outline-none focus:border-claude-accent',
                'cursor-pointer',
              )}
              aria-label="选择模型"
            >
              {allModels.length === 0 && <option value="">未配置模型</option>}
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
        )}

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

// One compact slot of the Design mode 3-picker. Pulls the label tight against
// the select so 3 of these still fit on a 1280px window without horizontal
// scroll. The label doubles as a click target for the select for the same
// reason a regular <label> does — but we wrap the whole pill so the entire
// rounded control feels like one widget.
function ModelSlot({
  label,
  title,
  value,
  onChange,
  groups,
  emptyHint,
}: {
  label: string;
  title: string;
  value: string;
  onChange: (v: string) => void;
  groups: Array<{ id: string; displayName: string; models: Array<{ id: string; displayName: string }> }>;
  emptyHint: string;
}) {
  return (
    <label
      title={title}
      className={cn(
        'relative inline-flex items-center gap-1.5 pl-2 pr-7 py-1 rounded-lg',
        'border border-claude-border dark:border-night-border',
        'hover:border-claude-accent focus-within:border-claude-accent',
        'cursor-pointer',
      )}
    >
      <span className="text-[11px] font-medium text-claude-muted dark:text-night-muted shrink-0">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none bg-transparent text-sm pr-1 focus:outline-none cursor-pointer max-w-[140px] truncate"
        disabled={groups.length === 0}
        aria-label={title}
      >
        {groups.length === 0 && <option value="">{emptyHint}</option>}
        {groups.map((p) => (
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
    </label>
  );
}
