/**
 * OpenAI ↔ Anthropic protocol translator.
 *
 * Flaude's client speaks one wire format (OpenAI-compatible /v1/chat/completions).
 * PPIO's Claude models live on `https://api.ppio.com/anthropic/v1/messages`
 * which speaks Anthropic's native protocol — different request shape,
 * different streaming events, different content model. Rather than fork
 * the client into two paths, this module translates at the Worker edge
 * so the client stays single-protocol.
 *
 * Three pure entry points:
 *   - translateRequest   OpenAI request body → Anthropic request body
 *   - translateResponse  Anthropic JSON response → OpenAI JSON response
 *   - translateStream    Anthropic SSE stream → OpenAI SSE stream (TransformStream)
 *
 * No network here — chat.ts does the actual fetch. This module is
 * tested with synthetic inputs.
 *
 * **Key translation rules** (the surprises):
 *   - Anthropic separates `system` to a top-level field; we sweep all
 *     `role: 'system'` messages out of `messages[]` into one concatenated
 *     `system` string.
 *   - `role: 'tool'` messages (tool results) become `user` messages with
 *     a `tool_result` content block.
 *   - Assistant `tool_calls` array is unfolded into `tool_use` content blocks.
 *   - OpenAI `image_url` content parts become Anthropic `image` blocks
 *     with either `url` or base64 source (data URIs split here).
 *   - `max_tokens` is REQUIRED by Anthropic; we default to 8192 if the
 *     client didn't specify (matches the soft cap most clients use).
 *   - DeepSeek-specific fields (`reasoning_content`, `stream_options`)
 *     are dropped — Anthropic doesn't know them and would 400.
 *   - `stop_reason: 'end_turn'/'tool_use'/'max_tokens'/'stop_sequence'`
 *     maps to OpenAI's `'stop'/'tool_calls'/'length'/'stop'` respectively.
 *   - For streaming: tool_use input_json arrives as `partial_json` chunks
 *     in `input_json_delta` events; we forward them as OpenAI tool_call
 *     argument deltas one-to-one.
 */

// =============================================================================
// Types — the OpenAI side
// =============================================================================

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: OpenAIToolDef[];
  tool_choice?: OpenAIToolChoice;
  // Pass-through-not-translated fields (we drop):
  stream_options?: unknown;
  // Anything else passes through to debug; harmless if Anthropic ignores it.
  [extra: string]: unknown;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
  reasoning_content?: string;
  /**
   * Anthropic Extended Thinking proof-of-thinking signature, opaque base64.
   * The upstream emits this in `signature_delta` events at the end of each
   * thinking block; v0.1.51 dropped it on the floor, but Anthropic enforces
   * its presence on the *next* turn — the broken request the user reported
   * was `messages.1.content.0.thinking.signature: Field required` after a
   * second send into a thinking-mode conversation. v0.1.52 roundtrips it:
   * translateStream surfaces it on the assistant message, the client
   * persists it (`Message.reasoningSignature`), and translateRequest
   * re-attaches it when reconstructing the leading thinking block on
   * subsequent turns.
   *
   * Old conversations that pre-date the fix won't have this field — when
   * it's missing we drop the thinking block reconstruction entirely so the
   * request still goes through. Reasoning continuity is lost (the model
   * re-derives) but the user gets a response instead of a 400.
   */
  reasoning_signature?: string;
}

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } };

// =============================================================================
// Types — the Anthropic side
// =============================================================================

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicToolDef[];
  tool_choice?: AnthropicToolChoice;
  /**
   * Anthropic Extended Thinking. When set with `type: 'enabled'`, the
   * model emits `thinking` content blocks (signed CoT) before the final
   * response. v0.1.50: enabled by translateRequest when the client
   * sends a model id ending in `-thinking` (the suffix is stripped
   * before forwarding so the upstream model name stays valid). The
   * budget_tokens cap how much thinking the model can do before it
   * MUST emit user-visible content. 16k is comfortable for hard
   * reasoning without runaway cost.
   */
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source:
        | { type: 'base64'; media_type: string; data: string }
        | { type: 'url'; url: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
    }
  /**
   * Extended Thinking content block. The `signature` field is opaque
   * proof-of-thinking that the upstream requires us to echo back on
   * subsequent turns when continuing the conversation — without it the
   * thinking gets discarded by the model in the next round-trip and
   * reasoning continuity is lost.
   */
  | { type: 'thinking'; thinking: string; signature?: string };

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// =============================================================================
// translateRequest: OpenAI → Anthropic
// =============================================================================

const DEFAULT_MAX_TOKENS = 8192;

/**
 * Default thinking budget when the client picked a `-thinking` model.
 * 16K tokens is comfortable headroom for the kind of multi-step
 * reasoning users actually invoke thinking mode for (proofs, hard
 * code-review, multi-file architectural questions). The model will
 * not consume the whole budget on simple turns — it self-paces and
 * stops thinking when ready.
 */
const DEFAULT_THINKING_BUDGET_TOKENS = 16_000;

const THINKING_SUFFIX = '-thinking';

/**
 * If the client model id ends in `-thinking`, return the upstream
 * model name (suffix stripped) plus a flag enabling thinking mode.
 * Otherwise pass through unchanged.
 */
function resolveThinkingModel(modelId: string): {
  upstreamModel: string;
  thinkingEnabled: boolean;
} {
  if (modelId.endsWith(THINKING_SUFFIX)) {
    return {
      upstreamModel: modelId.slice(0, -THINKING_SUFFIX.length),
      thinkingEnabled: true,
    };
  }
  return { upstreamModel: modelId, thinkingEnabled: false };
}

export function translateRequest(req: OpenAIRequest): AnthropicRequest {
  // Sweep system messages into a single top-level `system` string. We
  // concatenate with double newlines so multi-system chats (rare, but
  // legal) preserve their separation.
  const systemParts: string[] = [];
  const nonSystem: OpenAIMessage[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      const text = stringifyContent(m.content);
      if (text) systemParts.push(text);
    } else {
      nonSystem.push(m);
    }
  }

  // Translate the remaining messages, paying attention to tool roles +
  // assistant tool_calls + multi-modal content.
  const messages: AnthropicMessage[] = [];
  for (const m of nonSystem) {
    if (m.role === 'tool') {
      // OpenAI 'tool' role becomes a user message with tool_result block.
      // tool_call_id is required to pair with the assistant's tool_use.
      if (!m.tool_call_id) {
        // Defense: silently drop a malformed tool message rather than
        // sending Anthropic a half-paired request that 400s.
        continue;
      }
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: stringifyContent(m.content),
          },
        ],
      });
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      // Assistant turn that called tools. Anthropic embeds tool_use as
      // content blocks alongside any preceding text.
      const blocks: AnthropicContentBlock[] = [];
      // Thinking comes FIRST in the content array — preserve reasoning
      // continuity on multi-turn thinking conversations. Without this,
      // continuing a thinking-mode conversation drops the prior round's
      // reasoning and the model re-derives from scratch (or, worse,
      // contradicts its own earlier work). See translateResponse for
      // the matching extraction direction.
      //
      // v0.1.52: only reconstruct the thinking block when we ALSO have its
      // `signature` — Anthropic enforces signature presence on every
      // thinking block in subsequent requests. Without it the call 400s
      // with `messages[i].content[j].thinking.signature: Field required`.
      // Old conversations from before the fix won't have a signature
      // (v0.1.51 silently dropped the signature_delta stream events) so
      // we drop the thinking block entirely there — reasoning continuity
      // is lost on the legacy turn but at least the next turn succeeds.
      if (
        m.reasoning_content &&
        m.reasoning_content.length > 0 &&
        m.reasoning_signature
      ) {
        blocks.push({
          type: 'thinking',
          thinking: m.reasoning_content,
          signature: m.reasoning_signature,
        });
      }
      const text = stringifyContent(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls) {
        let input: Record<string, unknown> = {};
        try {
          input = tc.function.arguments
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          // Anthropic requires `input` to be a parsed object. Bad JSON
          // from a previous turn (rare) → empty object so the conversation
          // can still progress; the assistant typically self-corrects.
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    // Plain user/assistant message — but assistant messages may carry
    // reasoning_content (DeepSeek thinking-mode echo). Reconstruct
    // a thinking content block at the head so Anthropic preserves
    // the reasoning chain across turns.
    //
    // v0.1.52: same signature-required gate as the tool-call branch above.
    // Without `reasoning_signature` Anthropic 400s on the next turn.
    if (
      m.role === 'assistant' &&
      m.reasoning_content &&
      m.reasoning_content.length > 0 &&
      m.reasoning_signature
    ) {
      const blocks: AnthropicContentBlock[] = [
        {
          type: 'thinking',
          thinking: m.reasoning_content,
          signature: m.reasoning_signature,
        },
      ];
      const text = stringifyContent(m.content);
      if (text) blocks.push({ type: 'text', text });
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    messages.push({
      role: m.role === 'system' ? 'user' : (m.role as 'user' | 'assistant'),
      content: translateContent(m.content),
    });
  }

  const { upstreamModel, thinkingEnabled } = resolveThinkingModel(req.model);

  // max_tokens MUST exceed budget_tokens when thinking is on — Anthropic
  // 400s otherwise. Bump to budget + 4096 if the client's max_tokens is
  // too low (or unset) for thinking turns.
  const effectiveMaxTokens = req.max_tokens ?? DEFAULT_MAX_TOKENS;
  const finalMaxTokens = thinkingEnabled
    ? Math.max(effectiveMaxTokens, DEFAULT_THINKING_BUDGET_TOKENS + 4096)
    : effectiveMaxTokens;

  const out: AnthropicRequest = {
    model: upstreamModel,
    max_tokens: finalMaxTokens,
    messages,
  };

  if (systemParts.length > 0) out.system = systemParts.join('\n\n');
  // Temperature note: Anthropic's extended-thinking spec requires
  // temperature=1 (the default). Setting any other value alongside
  // `thinking: enabled` returns 400 with "extended thinking requires
  // temperature: 1". So we drop the client's temperature when
  // thinkingEnabled — DeepSeek-style temperature tuning doesn't
  // apply to Claude's thinking mode anyway.
  if (typeof req.temperature === 'number' && !thinkingEnabled) {
    out.temperature = req.temperature;
  }
  if (typeof req.top_p === 'number' && !thinkingEnabled) out.top_p = req.top_p;
  if (req.stream) out.stream = true;
  if (req.stop !== undefined) {
    out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  if (req.tool_choice !== undefined) {
    out.tool_choice = translateToolChoice(req.tool_choice);
  }
  if (thinkingEnabled) {
    out.thinking = {
      type: 'enabled',
      budget_tokens: DEFAULT_THINKING_BUDGET_TOKENS,
    };
  }

  return out;
}

function translateToolChoice(c: OpenAIToolChoice): AnthropicToolChoice | undefined {
  if (c === 'auto') return { type: 'auto' };
  if (c === 'required') return { type: 'any' };
  if (c === 'none') return undefined; // Anthropic has no direct "none";
  // by omitting tool_choice and not setting tools, we get the same effect.
  if (typeof c === 'object' && c.type === 'function') {
    return { type: 'tool', name: c.function.name };
  }
  return undefined;
}

/**
 * Convert OpenAI content (string | array of parts) to Anthropic content
 * (string | array of blocks). String input passes through unchanged
 * because Anthropic also accepts raw strings.
 */
function translateContent(
  c: string | OpenAIContentPart[] | null,
): string | AnthropicContentBlock[] {
  if (c === null) return '';
  if (typeof c === 'string') return c;
  const blocks: AnthropicContentBlock[] = [];
  for (const part of c) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      blocks.push(translateImageUrl(part.image_url.url));
    }
  }
  return blocks;
}

/**
 * Convert OpenAI's `image_url` (which can be a public URL or a
 * `data:image/png;base64,...` URI) into Anthropic's image block.
 *
 * For data URIs we split out media_type + base64 payload; for public
 * URLs we use Anthropic's URL source (added 2024 — predates Claude 4.x
 * so all supported models accept it).
 */
type ImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

function translateImageUrl(
  url: string,
): { type: 'image'; source: ImageSource } {
  if (url.startsWith('data:')) {
    // data:image/png;base64,iVBORw0KGgo...
    const m = url.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: m[1]!, data: m[2]! },
      };
    }
    // Malformed data URI — pass through as URL and let Anthropic complain.
  }
  return { type: 'image', source: { type: 'url', url } };
}

function stringifyContent(c: string | OpenAIContentPart[] | null | undefined): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  return c
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
}

// =============================================================================
// translateResponse: Anthropic → OpenAI (non-streaming)
// =============================================================================

export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
      tool_calls?: OpenAIToolCall[];
      reasoning_content?: string;
      // Anthropic Extended Thinking signature (opaque proof-of-thinking).
      // Surfaced on the response so the client can persist it and
      // translateRequest can re-attach it on the next turn.
      reasoning_signature?: string;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function translateResponse(resp: AnthropicResponse): OpenAIResponse {
  // Concat all text blocks; collect tool_use blocks separately;
  // extract thinking blocks into reasoning_content (DeepSeek-style
  // field the client already knows how to render in the 推理 panel).
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  // v0.1.52: collect signature alongside thinking content so the client
  // can persist it for the next turn. Anthropic emits one signature per
  // thinking block; on the rare chance of multiple thinking blocks we
  // only keep the last (it carries the proof for the full chain).
  let lastSignature: string | undefined;
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of resp.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'thinking') {
      thinkingParts.push(block.thinking);
      if (block.signature) lastSignature = block.signature;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // tool_result blocks shouldn't appear in assistant responses; ignore
    // image blocks here (Claude doesn't generate them outbound).
  }

  return {
    id: resp.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textParts.join(''),
          ...(thinkingParts.length > 0
            ? { reasoning_content: thinkingParts.join('') }
            : {}),
          ...(lastSignature ? { reasoning_signature: lastSignature } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(resp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
    },
  };
}

function mapStopReason(
  reason: AnthropicResponse['stop_reason'],
): 'stop' | 'length' | 'tool_calls' {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}

// =============================================================================
// translateStream: Anthropic SSE → OpenAI SSE (TransformStream)
// =============================================================================

/**
 * Parse Anthropic's SSE event stream and emit OpenAI-style chunks.
 *
 * Anthropic events are typed: each `event:` line names the event type
 * and the `data:` payload contains the structured event. We track a
 * small state machine:
 *   - per-content-block: index → kind (text | tool_use), and for tool_use
 *     the id/name accumulated from `content_block_start`.
 *   - aggregate usage: input_tokens at message_start, output_tokens at
 *     message_delta. Emitted with the final `finish_reason` chunk.
 *
 * We emit one OpenAI chunk per Anthropic delta — text deltas become
 * content deltas, input_json_delta becomes tool_calls.arguments delta.
 *
 * Output format is the same OpenAI SSE the client already consumes,
 * including the `data: [DONE]` terminator.
 *
 * Returns a `TransformStream<Uint8Array, Uint8Array>` that the caller
 * pipes the upstream body through.
 */
export function translateStream(modelHint: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = '';
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);

  // Per-block state
  const blocks: Record<
    number,
    | { kind: 'text' }
    | { kind: 'thinking' }
    | { kind: 'tool_use'; toolIndex: number; toolId: string; toolName: string; argsBuf: string }
  > = {};
  let nextToolIndex = 0;

  // Accumulated usage — emitted at the very end with finish_reason.
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: AnthropicResponse['stop_reason'] = null;
  // Whether we've emitted the role:'assistant' header chunk yet.
  let emittedRoleHeader = false;

  function chunk(payload: object): string {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  function deltaChunk(delta: Record<string, unknown>) {
    return chunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelHint,
      choices: [{ index: 0, delta, finish_reason: null }],
    });
  }

  function finalChunk() {
    return chunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelHint,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: mapStopReason(stopReason),
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    });
  }

  return new TransformStream({
    transform(input, controller) {
      sseBuffer += decoder.decode(input, { stream: true });
      // Process complete events (separated by blank lines) one at a time.
      let idx: number;
      while ((idx = sseBuffer.indexOf('\n\n')) >= 0) {
        const eventChunk = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        const out = processEvent(eventChunk);
        if (out) controller.enqueue(encoder.encode(out));
      }
    },
    flush(controller) {
      // Flush any remaining buffered event.
      if (sseBuffer.trim().length > 0) {
        const out = processEvent(sseBuffer);
        if (out) controller.enqueue(encoder.encode(out));
        sseBuffer = '';
      }
      // Emit final + [DONE].
      controller.enqueue(encoder.encode(finalChunk()));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });

  /**
   * Parse one SSE event chunk (`event: ...\ndata: ...`) and produce
   * zero or more OpenAI-format chunks. Returns the concatenated
   * OpenAI SSE string, or empty if no client-visible output.
   */
  function processEvent(raw: string): string {
    // Anthropic events look like:
    //   event: content_block_delta
    //   data: {"type":"content_block_delta",...}
    const lines = raw.split('\n');
    let dataLine = '';
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLine += line.slice(5).trimStart();
      }
    }
    if (!dataLine) return '';
    let evt: AnthropicStreamEvent;
    try {
      evt = JSON.parse(dataLine) as AnthropicStreamEvent;
    } catch {
      return '';
    }

    let out = '';

    // Emit the role:assistant header on the very first content event.
    const ensureHeader = () => {
      if (!emittedRoleHeader) {
        out += deltaChunk({ role: 'assistant', content: '' });
        emittedRoleHeader = true;
      }
    };

    switch (evt.type) {
      case 'message_start': {
        // Capture initial input_tokens. output_tokens here is usually 1
        // (just the role token); we'll overwrite at message_delta.
        const u = evt.message?.usage;
        if (u) {
          inputTokens = u.input_tokens ?? 0;
          outputTokens = u.output_tokens ?? 0;
        }
        return '';
      }
      case 'content_block_start': {
        ensureHeader();
        const block = evt.content_block;
        if (block.type === 'text') {
          blocks[evt.index] = { kind: 'text' };
        } else if (block.type === 'thinking') {
          blocks[evt.index] = { kind: 'thinking' };
        } else if (block.type === 'tool_use') {
          const toolIndex = nextToolIndex++;
          blocks[evt.index] = {
            kind: 'tool_use',
            toolIndex,
            toolId: block.id,
            toolName: block.name,
            argsBuf: '',
          };
          // Emit the tool_call header chunk: id + name, empty arguments.
          out += deltaChunk({
            tool_calls: [
              {
                index: toolIndex,
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: '' },
              },
            ],
          });
        }
        return out;
      }
      case 'content_block_delta': {
        const state = blocks[evt.index];
        if (!state) return '';
        if (state.kind === 'text' && evt.delta.type === 'text_delta') {
          ensureHeader();
          out += deltaChunk({ content: evt.delta.text });
        } else if (
          state.kind === 'thinking' &&
          evt.delta.type === 'thinking_delta'
        ) {
          ensureHeader();
          // Stream as `reasoning_content` so the existing client
          // already knows what to do with it (DeepSeek thinking-mode
          // uses the same field). The 推理 panel populates from
          // `chunk.reasoningDelta` which providerClient.ts maps from
          // exactly this delta key.
          out += deltaChunk({ reasoning_content: evt.delta.thinking });
        } else if (
          state.kind === 'tool_use' &&
          evt.delta.type === 'input_json_delta'
        ) {
          state.argsBuf += evt.delta.partial_json;
          out += deltaChunk({
            tool_calls: [
              {
                index: state.toolIndex,
                function: { arguments: evt.delta.partial_json },
              },
            ],
          });
        } else if (
          state.kind === 'thinking' &&
          evt.delta.type === 'signature_delta'
        ) {
          // v0.1.52: surface the thinking block's proof-of-thinking so the
          // client persists it on the assistant message. Without it, a
          // second send into the same conversation 400s with
          // `messages[i].content[j].thinking.signature: Field required`.
          // We pass the signature through verbatim — it's an opaque base64
          // string the client doesn't parse, just stores and echoes back.
          // Anthropic emits it as one delta per thinking block (often as a
          // single chunk at the block end). The client concatenates if
          // multiple deltas arrive.
          ensureHeader();
          out += deltaChunk({ reasoning_signature: evt.delta.signature });
        }
        return out;
      }
      case 'content_block_stop':
        return '';
      case 'message_delta': {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage?.output_tokens != null) {
          outputTokens = evt.usage.output_tokens;
        }
        return '';
      }
      case 'message_stop':
        // Final chunk + [DONE] are emitted in flush(), so transitions
        // before the upstream half-closes don't double-send.
        return '';
      default:
        return '';
    }
  }
}

// Anthropic stream event union.
type AnthropicStreamEvent =
  | {
      type: 'message_start';
      message: {
        id: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
    }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'text'; text: string }
        | { type: 'thinking'; thinking: string }
        | { type: 'tool_use'; id: string; name: string; input: object };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'signature_delta'; signature: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta?: { stop_reason?: AnthropicResponse['stop_reason'] };
      usage?: { output_tokens?: number };
    }
  | { type: 'message_stop' };
