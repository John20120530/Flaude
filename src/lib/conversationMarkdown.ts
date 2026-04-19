/**
 * Convert a conversation to a standalone Markdown document.
 *
 * Goals:
 *  - A human reading the exported file can reconstruct the full chat: every
 *    message, reasoning block, tool call, attachment reference, and the M6
 *    summary (if any).
 *  - Artifacts are inlined as fenced code blocks so the file is self-
 *    contained and doesn't depend on Flaude's artifact store.
 *  - Output stays valid GitHub-flavored Markdown — no fragile HTML soup.
 *    GFM `<details>` is GitHub's own extension and is widely supported
 *    (VS Code preview, Obsidian, many static site generators), so we use it
 *    for long/noisy sections (reasoning, tool calls) without sacrificing
 *    readability when rendered by a bare Markdown viewer.
 *
 * Pure function: takes all dependencies as arguments (artifacts map, project
 * name, clock) so it's trivial to unit test without touching the store, DOM,
 * or the system clock.
 */

import type { Conversation, Message, ToolCall, Attachment } from '@/types';
import type { Artifact } from '@/lib/artifacts';

export interface ExportOptions {
  /** Map of artifact id → Artifact. Used to inline `[[ARTIFACT:id]]` tokens. */
  artifacts?: Record<string, Artifact>;
  /** Project display name, if the conversation is inside a project. */
  projectName?: string;
  /** Drop reasoning blocks from the output. Default: keep them. */
  includeReasoning?: boolean;
  /** Cap for tool-call result length in characters. Default 4000. */
  toolResultCap?: number;
  /**
   * Clock for the export footer. Defaulted via argument (not inline) so
   * tests can pin the timestamp and assert exact output.
   */
  now?: () => number;
}

const ROLE_LABELS: Record<Message['role'], string> = {
  user: '👤 用户',
  assistant: '🤖 Flaude',
  system: '⚙️ 系统',
  tool: '🔧 工具',
};

export function buildConversationMarkdown(
  conversation: Conversation,
  options: ExportOptions = {}
): string {
  const {
    artifacts = {},
    projectName,
    includeReasoning = true,
    toolResultCap = 4000,
    now = Date.now,
  } = options;

  const lines: string[] = [];

  // H1: conversation title.
  lines.push(`# ${conversation.title || '未命名对话'}`);
  lines.push('');

  // Metadata as a compact table — renders as an actual table in GitHub /
  // Obsidian, and as a readable key/value list in plain text.
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| 模式 | ${conversation.mode} |`);
  lines.push(`| 模型 | ${conversation.modelId || '—'} |`);
  if (projectName) lines.push(`| 项目 | ${projectName} |`);
  lines.push(`| 创建 | ${formatTimestamp(conversation.createdAt)} |`);
  lines.push(`| 最后更新 | ${formatTimestamp(conversation.updatedAt)} |`);
  lines.push(`| 消息数 | ${conversation.messages.length} |`);
  lines.push('');

  // M6 summary section — emitted ABOVE the full transcript so a reader
  // skimming the file gets the gist before diving into the raw messages.
  if (
    conversation.summary &&
    conversation.summary.trim() &&
    conversation.summaryMessageCount
  ) {
    lines.push('## 📚 已归档摘要');
    lines.push('');
    lines.push(
      `> 此摘要压缩了会话最早的 **${conversation.summaryMessageCount}** 条消息。原始消息仍保留在下方 "对话" 区，便于回溯。`
    );
    if (conversation.summarizedAt) {
      lines.push(`> 生成时间：${formatTimestamp(conversation.summarizedAt)}`);
    }
    lines.push('');
    lines.push(conversation.summary.trim());
    lines.push('');
  }

  lines.push('## 对话');
  lines.push('');

  // Fold each tool-role message's content into the assistant message that
  // called it, keyed by the shared call id. This mirrors how the chat UI
  // shows tool results inline on the calling message's card.
  const toolResultByCallId = new Map<string, string>();
  for (const m of conversation.messages) {
    if (m.role === 'tool' && m.toolCalls?.[0]) {
      toolResultByCallId.set(m.toolCalls[0].id, m.content);
    }
  }

  for (const m of conversation.messages) {
    // Tool-role messages are absorbed into their caller's toolCalls block —
    // rendering them as standalone entries would duplicate the payload.
    if (m.role === 'tool') continue;

    lines.push(`### ${ROLE_LABELS[m.role] ?? m.role}`);

    // Sub-line: timestamp · model · tokens. Only show what we have.
    const subParts: string[] = [formatTimestamp(m.createdAt)];
    if (m.role === 'assistant' && m.modelId) subParts.push(`模型: ${m.modelId}`);
    if (m.tokensIn || m.tokensOut) {
      subParts.push(`tokens: ${m.tokensIn ?? 0}↓/${m.tokensOut ?? 0}↑`);
    }
    lines.push(`*${subParts.join(' · ')}*`);
    lines.push('');

    if (includeReasoning && m.reasoning && m.reasoning.trim()) {
      lines.push('<details>');
      lines.push(
        `<summary>💭 推理过程（${m.reasoning.length} 字）</summary>`
      );
      lines.push('');
      lines.push(m.reasoning.trim());
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    if (m.content && m.content.trim()) {
      lines.push(expandArtifactTokens(m.content.trim(), artifacts));
      lines.push('');
    }

    if (m.attachments && m.attachments.length > 0) {
      lines.push(
        `**📎 附件：** ${m.attachments.map(formatAttachment).join(', ')}`
      );
      lines.push('');
    }

    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        const resolved = toolResultByCallId.get(tc.id) ?? tc.result;
        lines.push(formatToolCall(tc, resolved, toolResultCap));
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`*导出自 Flaude · ${formatTimestamp(now())}*`);

  // Collapse trailing blank lines but always end with a single newline.
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/**
 * Stable, sortable, locale-free timestamp: `YYYY-MM-DD HH:MM:SS` in local
 * time. We avoid `toLocaleString` because different OS locales produce
 * different orderings, which breaks test snapshots and the "file diffs
 * nicely" property we want for exports.
 */
function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function formatAttachment(a: Attachment): string {
  const kb = a.size ? `, ${Math.max(1, Math.round(a.size / 1024))} KB` : '';
  return `\`${a.name}\` (${a.mimeType || '?'}${kb})`;
}

function formatToolCall(
  tc: ToolCall,
  resolvedResult: string | undefined,
  cap: number
): string {
  const lines: string[] = [];
  const statusIcon =
    tc.status === 'success'
      ? '✓'
      : tc.status === 'error'
        ? '✗'
        : tc.status === 'running'
          ? '⏳'
          : '…';

  lines.push('<details>');
  lines.push(`<summary>🔧 ${statusIcon} <code>${tc.name}</code></summary>`);
  lines.push('');
  lines.push('**参数：**');
  lines.push('');
  lines.push('```json');
  try {
    lines.push(JSON.stringify(tc.arguments ?? {}, null, 2));
  } catch {
    // Circular / non-JSON-serializable — fall back to the raw toString.
    lines.push(String(tc.arguments));
  }
  lines.push('```');
  lines.push('');

  const result = resolvedResult ?? tc.result;
  if (result != null && result !== '') {
    lines.push('**结果：**');
    lines.push('');
    lines.push('```');
    lines.push(truncate(result, cap));
    lines.push('```');
    lines.push('');
  }
  if (tc.error) {
    lines.push('**错误：**');
    lines.push('');
    lines.push('```');
    lines.push(tc.error);
    lines.push('```');
    lines.push('');
  }

  lines.push('</details>');
  return lines.join('\n');
}

/**
 * Replace `[[ARTIFACT:id]]` tokens in message content with inline fenced
 * blocks so the exported file stands on its own. Unknown ids are kept as a
 * visible warning so the reader notices the gap rather than silently
 * dropping content.
 */
function expandArtifactTokens(
  content: string,
  artifacts: Record<string, Artifact>
): string {
  return content.replace(/\[\[ARTIFACT:([^\]]+)\]\]/g, (_, id: string) => {
    const art = artifacts[id];
    if (!art) return `> ⚠️ 缺失的 artifact: \`${id}\``;
    // Pick a sensible fence language: explicit language wins, then type
    // when it's a real grammar (html/svg), blank otherwise.
    const lang =
      art.language ??
      (art.type === 'html' || art.type === 'svg' || art.type === 'markdown'
        ? art.type
        : art.type === 'mermaid'
          ? 'mermaid'
          : '');
    const header = `**📦 Artifact: ${art.title}** (\`${art.type}\`${art.language && art.language !== art.type ? `, \`${art.language}\`` : ''})`;
    return `${header}\n\n\`\`\`${lang}\n${art.content}\n\`\`\``;
  });
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…[已截断，原文共 ${s.length} 字符]`;
}

/**
 * Produce a safe cross-platform filename from a conversation title.
 *
 * - Strips Windows-disallowed chars `\/:*?"<>|` and C0 controls.
 * - Preserves CJK, spaces, letters, digits, hyphens, dots.
 * - Collapses whitespace/underscore runs so we don't get `___` stutter.
 * - Trims leading/trailing dots/underscores (Windows silently strips them).
 * - Caps length so the resulting path stays under typical OS limits.
 */
export function sanitizeFilename(
  title: string,
  fallback = 'conversation'
): string {
  // eslint-disable-next-line no-control-regex
  const stripped = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  const collapsed = stripped.replace(/[\s_]+/g, '_');
  const trimmed = collapsed.replace(/^[._]+|[._]+$/g, '').slice(0, 80);
  return trimmed || fallback;
}
