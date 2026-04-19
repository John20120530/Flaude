/**
 * Conversation history summarization.
 *
 * Long conversations hit context limits. We compress leading messages into a
 * dense text summary that's prepended to the system prompt; remaining
 * messages are sent verbatim.
 *
 * Trade-offs explicit here:
 *   - We call the same provider/model the conversation uses, not a separate
 *     "cheap summarizer" model. Simpler config, consistent language/style,
 *     and for Chinese open-source models the cost difference is negligible.
 *   - We keep the last N messages verbatim (default 4) so the near-term
 *     context — the active thread — isn't compressed and loses nuance.
 *   - The summary format is plain markdown with section headings. Models
 *     read this much better than a paragraph soup.
 */

import type { Conversation, Message } from '@/types';
import { streamChat } from '@/services/providerClient';

export interface SummarizeOptions {
  /** Minimum number of recent messages to keep verbatim (never summarized). */
  keepRecent?: number;
  /** Max tokens for the summary output (cap on completion length). */
  maxSummaryTokens?: number;
  /** Abort the summarization call. */
  signal?: AbortSignal;
}

export interface SummarizeResult {
  /** The generated summary text (markdown). */
  summary: string;
  /** How many messages (from index 0) are now covered by the summary. */
  summaryMessageCount: number;
}

/**
 * Cook the messages we want compressed into a single user-visible prompt.
 * We intentionally do NOT pass them through the normal chat history — the
 * summarizer is a one-shot meta-task, not a conversational turn. Sending
 * the archive as a big user message also dodges any quirky provider
 * behavior around mixed roles.
 */
export function buildSummaryPrompt(
  messagesToSummarize: Message[],
  existingSummary?: string
): string {
  const lines: string[] = [];
  lines.push(
    '下面是一段用户与助手的历史对话记录。请把它压缩成一份**密集、事实性的摘要**，供后续对话继续使用。'
  );
  lines.push('');
  lines.push('摘要必须保留以下内容（按节组织）：');
  lines.push('');
  lines.push('- **用户目标 / 偏好**：用户在这段对话里想做什么、喜欢什么风格、有什么约束');
  lines.push('- **关键决策与结论**：已经达成的共识、选定的方案、拒绝的选项');
  lines.push('- **技术事实**：具体的文件名、函数名、版本号、数字、URL、引用');
  lines.push('- **进行中 / 未决**：还没完成的任务、待确认的问题、遗留 bug');
  lines.push('- **已产出的代码 / artifacts**：简要说明"做了什么"，不要复制全部代码');
  lines.push('');
  lines.push('风格要求：');
  lines.push('');
  lines.push('- 使用 Markdown 标题和列表。');
  lines.push('- 保持对话的原始语言（中文对话用中文，英文对话用英文）。');
  lines.push('- 尽量密集、无寒暄、无元评论（不要写"这段对话是关于……"）。');
  lines.push('- 目标长度 300–800 字；宁可简洁也不要冗长。');
  lines.push('');

  if (existingSummary && existingSummary.trim()) {
    lines.push('此前已经有一份摘要，新摘要应把它与下方的新增对话合并为一份连贯记录：');
    lines.push('');
    lines.push('```markdown');
    lines.push(existingSummary.trim());
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 需要压缩的对话片段');
  lines.push('');
  for (const m of messagesToSummarize) {
    const roleLabel =
      m.role === 'user' ? '用户' :
      m.role === 'assistant' ? '助手' :
      m.role === 'tool' ? '工具' :
      m.role;
    lines.push(`### ${roleLabel}`);
    lines.push('');
    if (m.reasoning) {
      lines.push(`> 推理过程：${m.reasoning.slice(0, 500)}${m.reasoning.length > 500 ? '…' : ''}`);
      lines.push('');
    }
    // Cap extremely long messages so a single 50KB paste doesn't dominate
    // the summarization call. Summaries of summaries still make sense for
    // the high-level gist.
    const content = m.content.length > 4000 ? m.content.slice(0, 4000) + '\n[…内容过长，已截断]' : m.content;
    lines.push(content);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('现在请直接输出摘要本体。**只输出摘要 markdown，不要任何前后说明文字。**');
  return lines.join('\n');
}

/**
 * Run the summarization. Reads the entire stream, accumulates content,
 * returns the final text. Throws on stream error.
 *
 * Notes:
 *   - The model's `reasoning_content` (if any) is discarded — we only want
 *     the final summary text.
 *   - If the provider returns nothing we throw with a human message.
 */
async function callSummarizer(
  modelId: string,
  prompt: string,
  opts: { maxTokens?: number; signal?: AbortSignal } = {}
): Promise<string> {
  let out = '';
  let err: string | undefined;

  for await (const chunk of streamChat({
    modelId,
    // We send the entire payload as a single user message — no history.
    messages: [
      {
        id: 'summarize-req',
        role: 'user',
        content: prompt,
        createdAt: Date.now(),
      },
    ],
    // Give the summarizer a tight, focused system role rather than
    // inheriting the conversation's (which includes Flaude persona, skills,
    // etc. — irrelevant noise for this one-shot task).
    system:
      '你是一个专业的对话摘要器。只输出用户要求的摘要内容，不要寒暄，不要元评论。',
    temperature: 0.3, // lower = more factual / less creative compression
    maxTokens: opts.maxTokens ?? 1200,
    signal: opts.signal,
  })) {
    if (chunk.delta) out += chunk.delta;
    if (chunk.finish === 'error') err = chunk.error;
    if (chunk.finish) break;
  }

  if (err) throw new Error(err);
  const trimmed = out.trim();
  if (!trimmed) throw new Error('摘要生成失败：模型未返回任何内容');
  return trimmed;
}

/**
 * Summarize a conversation's leading messages, keeping the last `keepRecent`
 * verbatim. Returns the new summary text and how many messages are covered.
 *
 * If the conversation already has a summary, we merge: the new summary
 * supersedes the old and additionally covers any messages added since.
 *
 * Returns `null` when there's nothing to compress (fewer than keepRecent+1
 * unsummarized messages). Callers should treat `null` as a no-op, not error.
 */
export async function summarizeConversation(
  conversation: Conversation,
  opts: SummarizeOptions = {}
): Promise<SummarizeResult | null> {
  const keepRecent = Math.max(1, opts.keepRecent ?? 4);
  const alreadyCovered = Math.min(
    conversation.summaryMessageCount ?? 0,
    conversation.messages.length
  );

  // The cut point: everything below this index (exclusive) gets summarized.
  const cutAt = conversation.messages.length - keepRecent;
  if (cutAt <= alreadyCovered) {
    // Nothing new to compress.
    return null;
  }

  // Only pass the NEW (not-yet-summarized) slice to the model. The existing
  // summary is injected via `buildSummaryPrompt`'s "merge" branch.
  const toSummarize = conversation.messages.slice(alreadyCovered, cutAt);

  // Skip tool-role messages when building the prompt — their content is
  // usually verbose JSON that bloats the payload without adding signal.
  // The calling assistant message's `toolCalls` metadata already tells the
  // summarizer what was invoked.
  const filtered = toSummarize.filter((m) => m.role !== 'tool');

  if (filtered.length === 0) {
    // Only tool messages to compress — nothing meaningful for the summary.
    // Bump the count anyway so we don't keep retrying.
    return {
      summary: conversation.summary ?? '',
      summaryMessageCount: cutAt,
    };
  }

  const prompt = buildSummaryPrompt(filtered, conversation.summary);
  const summary = await callSummarizer(conversation.modelId, prompt, {
    maxTokens: opts.maxSummaryTokens ?? 1200,
    signal: opts.signal,
  });

  return { summary, summaryMessageCount: cutAt };
}
