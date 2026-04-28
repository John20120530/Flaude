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
    };

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

    // Plain user/assistant message.
    messages.push({
      role: m.role === 'system' ? 'user' : (m.role as 'user' | 'assistant'),
      content: translateContent(m.content),
    });
  }

  const out: AnthropicRequest = {
    model: req.model,
    max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };

  if (systemParts.length > 0) out.system = systemParts.join('\n\n');
  if (typeof req.temperature === 'number') out.temperature = req.temperature;
  if (typeof req.top_p === 'number') out.top_p = req.top_p;
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
  // Concat all text blocks; collect tool_use blocks separately.
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of resp.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
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
        | { type: 'tool_use'; id: string; name: string; input: object };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta?: { stop_reason?: AnthropicResponse['stop_reason'] };
      usage?: { output_tokens?: number };
    }
  | { type: 'message_stop' };
