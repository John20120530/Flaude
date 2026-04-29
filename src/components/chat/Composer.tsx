import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Paperclip,
  ArrowUp,
  Square,
  Slash,
  X,
  Archive,
  Loader2,
  Brain,
  Mic,
  MicOff,
  Image as ImageIcon,
  FileText,
  Map as MapIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Attachment, SlashCommand } from '@/types';
import { uid } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { REASONER_PAIRS, isThinkingVariant } from '@/config/providers';
import {
  expandTemplate,
  parseSlashInput,
  suggestCommands,
} from '@/lib/slashCommands';
import { useSpeechRecognition } from '@/lib/speech';
import { extractAttachment } from '@/lib/fileExtraction';

interface Props {
  onSend: (
    text: string,
    attachments: Attachment[],
    options?: { planMode?: boolean },
  ) => void;
  onStop?: () => void;
  streaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Manual "compress history" action from M6 context management. When
   * provided, a button appears in the toolbar that calls this and leaves
   * the last few turns verbatim. Hidden if undefined (e.g. in a view that
   * doesn't use a chat hook).
   */
  onCompressHistory?: () => void;
  /** True while summarization is running — we show a spinner + disable send. */
  compressing?: boolean;
  /**
   * How many user+assistant turns exist right now. Used to decide whether
   * compression is even meaningful (with very short history we just hide
   * the button). Optional — defaults to a permissive "always show".
   */
  messageCount?: number;
}

export default function Composer({
  onSend,
  onStop,
  streaming,
  placeholder = '问 Flaude 任何问题...',
  disabled,
  onCompressHistory,
  compressing,
  messageCount,
}: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  /**
   * Per-message Plan-mode toggle. Resets to false after each send so the
   * mode applies to exactly one turn — matching how the user expects "I
   * want a plan for this specific request" to work. If they want plan
   * mode for the whole conversation, they re-toggle each message.
   */
  const [planMode, setPlanMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const navigate = useNavigate();
  const slashCommands = useAppStore((s) => s.slashCommands);
  const clearConversation = useAppStore((s) => s.clearConversation);
  const activeConversationId = useAppStore((s) => s.activeConversationId);
  const appendGlobalMemory = useAppStore((s) => s.appendGlobalMemory);

  // —— 深度思考 toggle (Extended Thinking) ——————————————————————————
  // Flip between the active conversation's base model and its reasoner
  // sibling (e.g. deepseek-chat ↔ deepseek-reasoner). We flip both:
  //  1. the conversation's stored modelId (so *this* conversation persists
  //     the choice), and
  //  2. modelByMode[activeMode] (so the TopBar picker and the next new
  //     conversation in the same mode reflect the choice too — otherwise
  //     the UI looks self-contradictory).
  const conversations = useAppStore((s) => s.conversations);
  const providers = useAppStore((s) => s.providers);
  const setConversationModel = useAppStore((s) => s.setConversationModel);
  const setModelForMode = useAppStore((s) => s.setModelForMode);

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeConversationId),
    [conversations, activeConversationId]
  );
  const activeModel = useMemo(() => {
    if (!activeConv) return undefined;
    for (const p of providers) {
      const m = p.models.find((x) => x.id === activeConv.modelId);
      if (m) return m;
    }
    return undefined;
  }, [providers, activeConv]);
  // Only show the toggle when the current model has a reasoning sibling.
  // v0.1.53: `thinkingOn` is driven by `isThinkingVariant(modelId)` — a
  // hard-coded list of "this id is the thinking side" — NOT by
  // `capabilities.reasoning`. The capability flag is for marketing the
  // model's general strength (e.g. Opus 4.6 is a strong reasoner whether
  // or not extended-thinking is enabled), and conflating the two meant
  // the toggle stuck on for Opus/Sonnet 4.6: Opus had reasoning=true,
  // toggle showed ON, clicking flipped to `-thinking` variant which ALSO
  // had reasoning=true → indistinguishable → "关不掉了".
  const pairedModelId = activeConv
    ? REASONER_PAIRS[activeConv.modelId]
    : undefined;
  const thinkingOn = isThinkingVariant(activeConv?.modelId ?? '');
  const hasPair = pairedModelId !== undefined;

  const toggleThinking = () => {
    if (!activeConv || !pairedModelId) return;
    setConversationModel(activeConv.id, pairedModelId);
    setModelForMode(activeConv.mode, pairedModelId);
  };

  // —— 语音输入 (Speech-to-Text) ——————————————————————————————————
  // When the user taps Mic, we snapshot whatever they'd already typed into
  // `dictationPrefix`. Interim transcripts render as (prefix + interim) so
  // they see a live preview; final transcripts grow the prefix, committing.
  // This lets typing + dictation mix naturally: type "写一封信给", hit mic,
  // say "张三", release → final text is "写一封信给张三".
  const dictationPrefix = useRef('');
  const {
    listening,
    error: sttError,
    start: startDictation,
    stop: stopDictation,
    supported: sttSupported,
  } = useSpeechRecognition({
    lang: 'zh-CN',
    onResult: (transcript, isFinal) => {
      if (isFinal) {
        const committed = dictationPrefix.current + transcript;
        dictationPrefix.current = committed;
        setText(committed);
      } else {
        setText(dictationPrefix.current + transcript);
      }
    },
  });

  const toggleMic = () => {
    if (listening) {
      stopDictation();
    } else {
      // Seed prefix with existing text so interim-preview doesn't clobber it.
      dictationPrefix.current = text;
      startDictation();
    }
  };

  // Surface STT errors as a one-shot alert so mic-denied doesn't fail silently.
  // Intentionally lightweight — a toast system is out of scope here.
  useEffect(() => {
    if (!sttError) return;
    const zh: Record<string, string> = {
      'not-allowed': '麦克风权限被拒绝。请在系统设置中允许 Flaude 访问麦克风。',
      'audio-capture': '未检测到麦克风。请检查设备连接。',
      'no-speech': '没有检测到语音。',
      'network': '语音识别需要网络连接（Chromium 的 SpeechRecognition 走云端）。',
      'not-supported': '当前浏览器不支持语音识别。',
    };
    alert(zh[sttError] ?? `语音识别错误：${sttError}`);
  }, [sttError]);

  // Keep the textarea auto-sized when text changes programmatically (dictation
  // appends). The onChange path does this too, but setText from dictation
  // doesn't go through onChange.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }, [text]);

  // Dropdown visible while the user is typing a slash trigger (no space yet).
  // Once they type a space, we stop suggesting — they're in "input" territory.
  const trimmed = text.trimStart();
  const showingTrigger = /^\/\S*$/.test(trimmed);
  const suggestions = showingTrigger
    ? suggestCommands(trimmed, slashCommands)
    : [];
  const slashOpen = suggestions.length > 0;

  // Reset dropdown selection when suggestions or query change.
  useEffect(() => {
    setSlashIdx(0);
  }, [trimmed, suggestions.length]);

  const resetComposer = () => {
    setText('');
    setAttachments([]);
    // Plan mode is a per-message intent — reset on every send. If the user
    // wants the next message to also be planned, they re-toggle.
    setPlanMode(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const runAction = (cmd: SlashCommand, input = '') => {
    switch (cmd.action) {
      case 'clear':
        if (activeConversationId) clearConversation(activeConversationId);
        break;
      case 'help':
        setHelpOpen(true);
        break;
      case 'memory-open':
        navigate('/settings#memory');
        break;
      case 'memory-append': {
        const fact = input.trim();
        if (!fact) {
          // No argument → act like /memory and take the user to the editor.
          navigate('/settings#memory');
          break;
        }
        appendGlobalMemory(fact);
        // Lightweight confirmation. Could upgrade to a toast later.
        // eslint-disable-next-line no-alert
        alert(`已加入全局记忆：\n\n${fact}`);
        break;
      }
      default:
        // Unknown action — be loud in dev but don't crash the UI.
        console.warn('未知 slash action:', cmd.action);
    }
  };

  const send = async () => {
    if (!text.trim() && attachments.length === 0) return;
    const parsed = parseSlashInput(text, slashCommands);
    if (parsed) {
      // Action commands execute locally — nothing goes to the model.
      // Some actions (e.g. /remember <fact>) use the text after the trigger.
      if (parsed.command.kind === 'action') {
        runAction(parsed.command, parsed.input);
        resetComposer();
        return;
      }
      // Template: expand {{input}} / {{clipboard}} and send the result.
      let clipboard = '';
      try {
        clipboard = (await navigator.clipboard.readText()) ?? '';
      } catch {
        /* clipboard may be unavailable without a prior gesture */
      }
      const expanded = expandTemplate(parsed.command.template ?? '', {
        input: parsed.input,
        clipboard,
      });
      onSend(expanded, attachments, { planMode });
      resetComposer();
      return;
    }
    onSend(text, attachments, { planMode });
    resetComposer();
  };

  const pickSlash = (cmd: SlashCommand) => {
    // Most actions fire with no argument — but `memory-append` needs the user
    // to type the fact first, so treat it like a template (insert trigger + space).
    const needsInput = cmd.kind === 'template' || cmd.action === 'memory-append';
    if (cmd.kind === 'action' && !needsInput) {
      runAction(cmd);
      setText('');
      return;
    }
    // Rewrite the textarea to just the trigger + space so the user
    // can fill in the {{input}} portion. Cursor ends at the end so they can
    // keep typing naturally.
    const next = cmd.trigger + ' ';
    setText(next);
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
      }
    }, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Dropdown-specific keys take priority while it's open.
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const picked = suggestions[slashIdx];
        if (picked) pickSlash(picked);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        // Exact-match trigger? Pick from dropdown. Otherwise fall through
        // to send so the user can still send arbitrary text starting with `/`.
        e.preventDefault();
        const exact = suggestions.find((c) => c.trigger === trimmed);
        if (exact) {
          pickSlash(exact);
          return;
        }
        const picked = suggestions[slashIdx];
        if (picked) {
          pickSlash(picked);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const onFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const list: Attachment[] = [];
    const rejected: string[] = [];
    for (const f of arr) {
      try {
        const result = await extractAttachment(f);
        if (result.kind === 'unsupported') {
          rejected.push(result.reason);
          continue;
        }
        if (result.kind === 'image') {
          list.push({
            id: uid('att'),
            name: f.name,
            mimeType: f.type || 'application/octet-stream',
            size: f.size,
            kind: 'image',
            data: result.dataUrl,
          });
        } else {
          list.push({
            id: uid('att'),
            // Pasted screenshots and clipboard images often arrive as 'image.png'
            // with no real name; pasted text files inherit the OS-set name.
            // For text attachments without a name we synthesize one so the
            // model has something to reference.
            name: f.name || 'pasted.txt',
            mimeType: f.type || 'application/octet-stream',
            size: f.size,
            kind: 'text',
            text: result.text,
            textTruncated: result.truncated,
          });
        }
      } catch (e) {
        rejected.push(`${f.name}：读取失败（${(e as Error).message}）`);
      }
    }
    if (rejected.length > 0) alert(rejected.join('\n'));
    if (list.length > 0) setAttachments((prev) => [...prev, ...list]);
  };

  /**
   * Ctrl+V paste support: when the clipboard carries one or more files
   * (screenshot tools, copy-from-Explorer, etc.), preventDefault and route
   * them through the normal attachment path. Pure-text pastes fall through
   * to the textarea's default behavior.
   */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    void onFiles(files);
  };

  const removeAttachment = (id: string) =>
    setAttachments((p) => p.filter((a) => a.id !== id));

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="max-w-3xl mx-auto">
        {helpOpen && (
          <div className="mb-2 rounded-xl border border-claude-border dark:border-night-border bg-claude-surface dark:bg-night-surface p-3 text-sm animate-fade-in">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 font-medium">
                <Slash className="w-3.5 h-3.5 text-claude-accent" />
                可用斜杠命令
              </div>
              <button
                onClick={() => setHelpOpen(false)}
                className="text-claude-muted hover:text-claude-ink dark:hover:text-night-ink"
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {slashCommands.map((c) => (
                <div key={c.id} className="flex items-baseline gap-3">
                  <span className="font-mono text-claude-accent min-w-[96px] shrink-0">
                    {c.trigger}
                  </span>
                  <span className="text-claude-muted dark:text-night-muted flex-1">
                    {c.description}
                  </span>
                  {c.kind === 'action' && (
                    <span className="text-[10px] uppercase tracking-wider text-claude-muted/70 shrink-0">
                      动作
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => {
              const isImage = a.kind === 'image' || (!a.kind && a.mimeType.startsWith('image/'));
              const Icon = isImage ? ImageIcon : FileText;
              const meta = a.kind === 'text'
                ? `${(a.text?.length ?? 0).toLocaleString()} 字符${a.textTruncated ? ' · 已截断' : ''}`
                : '';
              return (
                <div
                  key={a.id}
                  className="flex items-center gap-2 px-2 py-1 rounded-md bg-claude-surface dark:bg-night-surface border border-claude-border dark:border-night-border text-xs"
                  title={meta || a.name}
                >
                  <Icon className="w-3 h-3 shrink-0" />
                  <span className="truncate max-w-[160px]">{a.name}</span>
                  {meta && (
                    <span className="text-claude-muted dark:text-night-muted shrink-0">
                      {meta}
                    </span>
                  )}
                  <button
                    onClick={() => removeAttachment(a.id)}
                    className="text-claude-muted hover:text-red-500"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="relative">
          {slashOpen && (
            <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-claude-border dark:border-night-border bg-claude-surface dark:bg-night-surface shadow-lg overflow-hidden animate-fade-in z-10">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-claude-muted dark:text-night-muted border-b border-claude-border dark:border-night-border">
                斜杠命令 · ↑↓ 选择 · Tab/Enter 确认 · Esc 取消
              </div>
              <div className="max-h-60 overflow-y-auto">
                {suggestions.map((c, i) => (
                  <button
                    key={c.id}
                    onClick={() => pickSlash(c)}
                    onMouseEnter={() => setSlashIdx(i)}
                    className={cn(
                      'w-full text-left px-3 py-2 flex items-center gap-3 text-sm',
                      i === slashIdx
                        ? 'bg-claude-accent/10'
                        : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]'
                    )}
                  >
                    <span className="font-mono text-claude-accent shrink-0 min-w-[80px]">
                      {c.trigger}
                    </span>
                    <span className="text-claude-muted dark:text-night-muted flex-1 truncate">
                      {c.description}
                    </span>
                    {c.kind === 'action' && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-claude-muted/70">
                        动作
                      </span>
                    )}
                    {!c.builtin && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-claude-accent/70">
                        自定义
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            className={cn(
              'rounded-2xl border border-claude-border dark:border-night-border',
              'bg-claude-surface dark:bg-night-surface',
              'focus-within:border-claude-accent transition-colors',
              'shadow-sm'
            )}
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                const t = e.target;
                t.style.height = 'auto';
                t.style.height = Math.min(t.scrollHeight, 240) + 'px';
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={placeholder}
              disabled={disabled}
              className={cn(
                'w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm',
                'focus:outline-none placeholder:text-claude-muted/60 dark:placeholder:text-night-muted/60'
              )}
            />

            <div className="flex items-center gap-1 px-2 pb-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="btn-ghost"
                aria-label="上传文件"
                disabled={disabled}
              >
                <Paperclip className="w-4 h-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                // Loose accept: hint the OS picker but don't restrict —
                // the actual filter happens in extractAttachment, which
                // also accepts code/config files the OS reports with an
                // empty mime type.
                accept="image/*,text/*,.pdf,.md,.json,.yaml,.yml,.toml,.csv,.tsv,.html,.css,.js,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.c,.h,.cpp,.cs,.swift,.php,.sh,.sql,.xml,.ini,.conf,.log"
                className="hidden"
                onChange={(e) => {
                  onFiles(e.target.files);
                  // Reset so selecting the same file twice fires onChange.
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => {
                  setText('/');
                  setTimeout(() => textareaRef.current?.focus(), 0);
                }}
                className="btn-ghost"
                aria-label="斜杠命令"
                title="斜杠命令（输入 / 查看）"
                disabled={disabled}
              >
                <Slash className="w-4 h-4" />
              </button>

              {/*
                Mic button — STT via Web Speech API. Hidden entirely when the
                WebView doesn't expose SpeechRecognition (e.g. older build of
                a non-Chromium embed). When listening, we tint red and swap
                the icon so the recording state is obvious at a glance.
              */}
              {sttSupported && (
                <button
                  onClick={toggleMic}
                  className={cn(
                    'btn-ghost',
                    listening &&
                      'bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/15'
                  )}
                  aria-label={listening ? '停止听写' : '开始语音输入'}
                  aria-pressed={listening}
                  title={
                    listening
                      ? '正在听写…点击停止（或暂停说话会自动提交）'
                      : '语音输入（zh-CN）'
                  }
                  disabled={disabled}
                >
                  {listening ? (
                    <MicOff className="w-4 h-4 animate-pulse" />
                  ) : (
                    <Mic className="w-4 h-4" />
                  )}
                </button>
              )}

              {/*
                深度思考 toggle — only rendered for model families that have
                a base/reasoner pair in our catalog (today: DeepSeek).
                Visual language cribbed from Claude: purple-tinted pill when
                on, neutral ghost when off. We don't disable during streaming
                because the toggle changes the *next* turn's model; flipping
                mid-stream doesn't interrupt the one in flight.
              */}
              {hasPair && (
                <button
                  onClick={toggleThinking}
                  className={cn(
                    'btn-ghost',
                    thinkingOn &&
                      'bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-500/15'
                  )}
                  aria-label={thinkingOn ? '关闭深度思考' : '开启深度思考'}
                  aria-pressed={thinkingOn}
                  title={
                    thinkingOn
                      ? `深度思考：开（模型 ${activeModel?.displayName ?? activeConv?.modelId}）· 点击关闭`
                      : `深度思考：关 · 点击切到推理模式（${pairedModelId}）`
                  }
                  disabled={disabled}
                >
                  <Brain className="w-4 h-4" />
                  {thinkingOn && (
                    <span className="ml-1 text-xs">思考</span>
                  )}
                </button>
              )}
              {/*
                Plan-mode toggle — only meaningful in Code mode (where there
                ARE destructive tools to gate). One-shot: applies to the next
                message and auto-resets on send. Visual language: blue-tint
                pill when on, matches the thinking toggle pattern.
              */}
              {activeConv?.mode === 'code' && (
                <button
                  onClick={() => setPlanMode((v) => !v)}
                  className={cn(
                    'btn-ghost',
                    planMode &&
                      'bg-sky-500/10 text-sky-600 dark:text-sky-400 hover:bg-sky-500/15'
                  )}
                  aria-label={planMode ? '关闭 Plan 模式' : '开启 Plan 模式'}
                  aria-pressed={planMode}
                  title={
                    planMode
                      ? 'Plan 模式：开 · 下一条消息会先出计划等你批准，副作用工具锁定。再点关闭。'
                      : 'Plan 模式：关 · 点击开启，下一条消息会让 agent 先列计划再执行'
                  }
                  disabled={disabled}
                >
                  <MapIcon className="w-4 h-4" />
                  {planMode && <span className="ml-1 text-xs">Plan</span>}
                </button>
              )}
              {/* Compress history — hidden for short conversations where it
                  wouldn't help. We show at 6+ messages (~3 turns), enough
                  that compression produces a meaningful summary. */}
              {onCompressHistory && (messageCount === undefined || messageCount >= 6) && (
                <button
                  onClick={() => onCompressHistory()}
                  className="btn-ghost"
                  aria-label="压缩历史"
                  title="把较早的对话压缩成摘要（保留最近几轮原文）"
                  disabled={disabled || streaming || compressing}
                >
                  {compressing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Archive className="w-4 h-4" />
                  )}
                </button>
              )}

              <div className="flex-1" />

              {compressing && (
                <span className="text-xs text-claude-muted dark:text-night-muted mr-2 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  正在压缩历史…
                </span>
              )}

              {streaming ? (
                <button onClick={onStop} className="btn-primary">
                  <Square className="w-3.5 h-3.5" />
                  停止
                </button>
              ) : (
                <button
                  onClick={() => void send()}
                  disabled={
                    disabled ||
                    compressing ||
                    (!text.trim() && attachments.length === 0)
                  }
                  className="btn-primary"
                >
                  <ArrowUp className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-2 text-center text-xs text-claude-muted/70 dark:text-night-muted/70">
          Flaude 可能产生错误。请核实关键信息。 · 输入 <code className="font-mono">/</code> 查看命令
        </div>
      </div>
    </div>
  );
}

