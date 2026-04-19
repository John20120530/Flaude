import { useState } from 'react';
import { Copy, Check, Edit3, Trash2, RefreshCw, GitBranch, Pencil, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';
import { hasSpeechSynthesis, speak, stopSpeaking, useSpeakingId } from '@/lib/speech';

interface Props {
  message: Message;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRegenerate?: () => void;
  onBranch?: () => void;
  align: 'left' | 'right';
}

/**
 * Row of lightweight action buttons shown below each message on hover.
 * Actions available depend on message role:
 *  - user:    copy, edit, delete, branch
 *  - assistant: copy, regenerate, delete, branch
 */
export default function MessageActions({
  message,
  onCopy,
  onEdit,
  onDelete,
  onRegenerate,
  onBranch,
  align,
}: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
      onCopy();
    } catch {
      /* clipboard may be blocked; silent */
    }
  };

  const isAssistant = message.role === 'assistant';

  // TTS — only for assistant messages, and only if the browser/WebView has it.
  // We track "is THIS message currently speaking" by comparing the module's
  // currently-speaking id with this message's id.
  const speakingId = useSpeakingId();
  const isSpeakingThis = speakingId === message.id;
  const ttsAvailable = isAssistant && hasSpeechSynthesis() && message.content.trim().length > 0;
  const toggleSpeak = () => {
    if (isSpeakingThis) stopSpeaking();
    else speak(message.id, message.content);
  };

  return (
    <div
      className={cn(
        // Keep the speak button persistently visible while speaking — otherwise
        // the row hides on mouseout and the user loses their "stop" control
        // mid-playback, which is infuriating.
        'flex items-center gap-0.5 mt-1 transition-opacity',
        isSpeakingThis ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        align === 'right' && 'justify-end'
      )}
    >
      <IconBtn label={copied ? '已复制' : '复制'} onClick={copy}>
        {copied ? (
          <Check className="w-3.5 h-3.5 text-green-600" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </IconBtn>

      {ttsAvailable && (
        <IconBtn
          label={isSpeakingThis ? '停止朗读' : '朗读'}
          onClick={toggleSpeak}
          active={isSpeakingThis}
        >
          {isSpeakingThis ? (
            <VolumeX className="w-3.5 h-3.5 text-claude-accent" />
          ) : (
            <Volume2 className="w-3.5 h-3.5" />
          )}
        </IconBtn>
      )}

      {isAssistant && onRegenerate && (
        <IconBtn label="重新生成" onClick={onRegenerate}>
          <RefreshCw className="w-3.5 h-3.5" />
        </IconBtn>
      )}

      {!isAssistant && (
        <IconBtn label="编辑" onClick={onEdit}>
          <Edit3 className="w-3.5 h-3.5" />
        </IconBtn>
      )}

      {isAssistant && (
        <IconBtn label="修改回复" onClick={onEdit}>
          <Pencil className="w-3.5 h-3.5" />
        </IconBtn>
      )}

      {onBranch && (
        <IconBtn label="从这里分支" onClick={onBranch}>
          <GitBranch className="w-3.5 h-3.5" />
        </IconBtn>
      )}

      <IconBtn label="删除" onClick={onDelete}>
        <Trash2 className="w-3.5 h-3.5" />
      </IconBtn>

      {message.modelId && (
        <span className="ml-2 text-[10px] text-claude-muted dark:text-night-muted font-mono">
          {message.modelId}
          {typeof message.tokensOut === 'number' && ` · ${message.tokensOut}t`}
        </span>
      )}
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  /** Sticky-highlighted (e.g. while speaking). Separate from hover. */
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'p-1.5 rounded-md transition',
        active
          ? 'text-claude-accent bg-claude-accent/10 hover:bg-claude-accent/15'
          : 'text-claude-muted hover:text-claude-ink hover:bg-black/5 dark:text-night-muted dark:hover:text-night-ink dark:hover:bg-white/5'
      )}
    >
      {children}
    </button>
  );
}
