/**
 * Wire-format serialization for outgoing chat completions.
 *
 * This module exists separately from providerClient.ts so the (subtle, easy
 * to break) message-shaping logic can be unit-tested without spinning up
 * fetch / SSE plumbing. providerClient.ts re-exports `serializeMessages`
 * to keep the public surface untouched.
 *
 * Wire format target: OpenAI-compatible chat/completions. Quirks we work
 * around:
 *   - DeepSeek thinking-mode requires `reasoning_content` to be echoed on
 *     the next assistant message of every turn (and inside the
 *     tool-calls branch). Other providers ignore the field.
 *   - Multimodal `image_url` parts only work for vision-capable models.
 *     We send them when the user attached images and trust the routing
 *     layer to point at a vision model.
 *   - **Text attachments** (PDFs, code files, plain text) are rendered as
 *     a fenced section appended to the user message text — that path
 *     works on every provider, no vision support needed.
 */

import type { Attachment, Message } from '@/types';

export type WireMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: unknown;
  name?: string;
  /**
   * DeepSeek thinking-mode echo. Required on assistant messages whose
   * previous turn produced reasoning content; ignored by other providers.
   */
  reasoning_content?: string;
  /**
   * Anthropic Extended Thinking signature (v0.1.52). Required alongside
   * `reasoning_content` on the prior assistant turn when continuing a
   * Claude thinking-mode conversation — the Worker's anthropicAdapter
   * re-attaches it to the reconstructed thinking block. Without it the
   * upstream 400s on `messages[i].content[j].thinking.signature: Field
   * required`. Other providers (DeepSeek, Qwen) ignore it.
   */
  reasoning_signature?: string;
};

export function serializeMessages(messages: Message[], system?: string): WireMessage[] {
  const out: WireMessage[] = [];
  if (system) out.push({ role: 'system', content: system });

  // Pre-pass: collect every tool_call_id that has a matching role='tool'
  // result message. Any tool_call on an assistant message whose id is NOT
  // in this set is orphaned — almost always because the user clicked Stop
  // mid-call before the tool result was appended. The OpenAI-compatible
  // contract requires every assistant tool_call to be followed by a tool
  // message responding to it; sending an orphan triggers a 400 with
  // "An assistant message with 'tool_calls' must be followed by tool
  // messages responding to each 'tool_call_id'". We strip orphans here
  // so a user can resume a stopped conversation without seeing that
  // error — even if the message store wasn't cleaned up by the abort path.
  const respondedToolCallIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const tcid = m.toolCalls?.[0]?.id;
    if (tcid) respondedToolCallIds.add(tcid);
  }

  // Second defensive pass: if multiple role='tool' messages share the same
  // tool_call_id, the upstream returns 400 "Duplicate value for
  // 'tool_call_id' of call_X in message[N]". Causes we've seen in the wild:
  //   - regenerate races where the old tool message wasn't cleared before
  //     the new turn appended its replacement
  //   - stop-cleanup synthesizing a "用户取消" tool message while a real
  //     tool message for the same id was already in flight
  //   - imported / restored conversations from a backup with a corrupted
  //     state
  // Build the set of ids whose LATEST occurrence we want to keep, then
  // skip earlier copies during emission. Last-write-wins: the most recent
  // tool result is the most accurate state.
  const lastIndexById = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role !== 'tool') return;
    const tcid = m.toolCalls?.[0]?.id;
    if (tcid) lastIndexById.set(tcid, i);
  });

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'tool') {
      const tcid = m.toolCalls?.[0]?.id;
      // Skip every tool message whose tool_call_id has a LATER occurrence —
      // we'll emit the freshest one when we reach it.
      if (tcid && lastIndexById.get(tcid) !== i) continue;
      out.push({
        role: 'tool',
        tool_call_id: tcid,
        content: m.content,
      });
      continue;
    }

    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Two filters in one pass:
      //   1. Drop tool_calls that have NO matching tool message anywhere
      //      (orphans — see the v0.1.26 fix above).
      //   2. Drop DUPLICATE tool_call_ids within this single assistant
      //      message (in case the message store / DeepSeek streaming /
      //      regenerate path produced a tool_calls array that contains
      //      the same id twice). Without this dedup, the upstream emits
      //      `tool_calls: [A, B, B, C]` with 3 tool messages following,
      //      and OpenAI returns 400 "insufficient tool messages following
      //      tool_calls message" because it expects 4 tool messages but
      //      only finds 3 unique ids in the trailing tool messages.
      //      v0.1.26 + v0.1.30 caught the orphan + duplicate-tool-message
      //      cases; v0.1.33 closes the duplicate-on-assistant case.
      const seenIds = new Set<string>();
      const liveCalls: typeof m.toolCalls = [];
      for (const tc of m.toolCalls) {
        if (!respondedToolCallIds.has(tc.id)) continue;
        if (seenIds.has(tc.id)) continue;
        seenIds.add(tc.id);
        liveCalls.push(tc);
      }

      if (liveCalls.length === 0) {
        // Every tool_call was orphaned. Fall back to a plain assistant
        // message — preserving any partial text the model produced before
        // the abort. If there's neither content nor live calls, drop the
        // message entirely (it'd be an empty assistant turn the upstream
        // would also reject).
        const text = (m.content ?? '').trim();
        if (!text) continue;
        const msg: WireMessage = { role: 'assistant', content: text };
        if (m.reasoning) msg.reasoning_content = m.reasoning;
        if (m.reasoningSignature) msg.reasoning_signature = m.reasoningSignature;
        out.push(msg);
        continue;
      }

      // An assistant turn that requested tool calls. OpenAI wants `tool_calls`
      // on the message itself; `content` may be empty.
      const msg: WireMessage = {
        role: 'assistant',
        content: m.content || null,
        tool_calls: liveCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: serializeToolArgs(tc.arguments),
          },
        })),
      };
      if (m.reasoning) msg.reasoning_content = m.reasoning;
      if (m.reasoningSignature) msg.reasoning_signature = m.reasoningSignature;
      out.push(msg);
      continue;
    }

    out.push(serializeContentMessage(m));
  }
  return out;
}

/**
 * Build a non-tool-call message. Splits attachments into images (multimodal
 * `image_url` parts) and text (a markdown fence appended to the body).
 *
 * Output shape:
 *   - No attachments         → `{ content: string }`
 *   - Image-only attachments → `{ content: [text-part, image-part, ...] }`
 *   - Text-only attachments  → `{ content: string }` with appended fences
 *   - Mixed                  → `{ content: [merged-text-part, image-part, ...] }`
 *
 * The merged-text path matters for vision-capable models: when the user
 * pastes a screenshot AND a CSV, we want both to be visible — image as a
 * vision part, CSV as text inside the same multimodal message.
 */
function serializeContentMessage(m: Message): WireMessage {
  const attachments = m.attachments ?? [];
  const images = attachments.filter(isImageAttachment);
  const texts = attachments.filter(isTextAttachment);

  const bodyText = mergeAttachmentText(m.content ?? '', texts);

  if (images.length === 0) {
    const msg: WireMessage = { role: m.role, content: bodyText };
    if (m.role === 'assistant' && m.reasoning) msg.reasoning_content = m.reasoning;
    if (m.role === 'assistant' && m.reasoningSignature)
      msg.reasoning_signature = m.reasoningSignature;
    return msg;
  }

  const parts: unknown[] = [{ type: 'text', text: bodyText }];
  for (const a of images) {
    if (a.data) parts.push({ type: 'image_url', image_url: { url: a.data } });
  }
  const msg: WireMessage = { role: m.role, content: parts };
  if (m.role === 'assistant' && m.reasoning) msg.reasoning_content = m.reasoning;
  if (m.role === 'assistant' && m.reasoningSignature)
    msg.reasoning_signature = m.reasoningSignature;
  return msg;
}

/** Image attachment for wire purposes: explicit kind='image', or legacy (no kind, image mime). */
function isImageAttachment(a: Attachment): boolean {
  if (a.kind === 'image') return true;
  if (a.kind === 'text') return false;
  return a.mimeType.startsWith('image/') && !!a.data;
}

function isTextAttachment(a: Attachment): boolean {
  return a.kind === 'text' && typeof a.text === 'string' && a.text.length > 0;
}

/**
 * Append text attachments to the user's message content. Renders each as a
 * labeled fenced block; the model has been observed to handle this format
 * cleanly across DeepSeek / Qwen / GLM / Kimi without explicit prompt help.
 *
 * Empty body + text attachments is fine — the fences carry the content.
 */
function mergeAttachmentText(body: string, texts: Attachment[]): string {
  if (texts.length === 0) return body;
  const blocks: string[] = [];
  for (const a of texts) {
    const lang = languageHintFor(a);
    const truncatedNote = a.textTruncated ? '（已截断）' : '';
    blocks.push(
      `**附件: ${a.name}**${truncatedNote}\n\`\`\`${lang}\n${a.text ?? ''}\n\`\`\``,
    );
  }
  const merged = blocks.join('\n\n');
  return body.trim() ? `${body}\n\n${merged}` : merged;
}

/**
 * Best-effort code-fence language hint based on filename extension. The model
 * doesn't strictly need it (it can infer from content) but a correct hint
 * makes Markdown rendering on the *user's* side prettier when they revisit
 * the conversation.
 */
function languageHintFor(a: Attachment): string {
  const i = a.name.lastIndexOf('.');
  if (i < 0) return '';
  const ext = a.name.slice(i + 1).toLowerCase();
  // Only hint a few cases — over-mapping is worse than no hint, since wrong
  // hints get inherited into the chat-side renderer's syntax highlighter.
  const map: Record<string, string> = {
    js: 'javascript', cjs: 'javascript', mjs: 'javascript',
    jsx: 'jsx',
    ts: 'typescript', cts: 'typescript', mts: 'typescript',
    tsx: 'tsx',
    py: 'python', pyi: 'python',
    rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', php: 'php',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    xml: 'xml', html: 'html', css: 'css', scss: 'scss', less: 'less',
    sql: 'sql', md: 'markdown', csv: 'csv',
    pdf: '', // already extracted to plain text
    txt: '', log: '',
  };
  return map[ext] ?? '';
}

/**
 * Tool-call arguments round-trip as a JSON string over the wire. Internal
 * storage is either a parsed object, a `{__raw: string}` wrapper (mid-stream),
 * or a string. Normalize to a string.
 */
export function serializeToolArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') {
    const raw = (args as { __raw?: string }).__raw;
    if (typeof raw === 'string') return raw;
    try {
      return JSON.stringify(args);
    } catch {
      return '{}';
    }
  }
  return '{}';
}
