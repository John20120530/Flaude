/**
 * Tests for the OpenAI ↔ Anthropic protocol translator.
 *
 * Three layers:
 *   1. translateRequest  — pure function, lots of edge cases (system,
 *      tool roles, multi-modal, max_tokens default)
 *   2. translateResponse — non-streaming Anthropic JSON → OpenAI JSON
 *   3. translateStream   — TransformStream that converts Anthropic SSE
 *      events into OpenAI SSE chunks. We feed synthetic Anthropic
 *      events and assert the output text matches the expected OpenAI
 *      sequence including [DONE].
 *
 * No live PPIO calls — that lives in the integration smoke step.
 */
import { describe, expect, it } from 'vitest';

import {
  translateRequest,
  translateResponse,
  translateStream,
  type AnthropicResponse,
  type OpenAIRequest,
} from '../src/anthropicAdapter';

// =============================================================================
// translateRequest
// =============================================================================

describe('translateRequest', () => {
  it('moves system messages to top-level field, concat with double newlines', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(out.system).toBe('You are helpful.\n\nBe concise.');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('defaults max_tokens when client omits it (Anthropic requires it)', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.max_tokens).toBe(8192);
  });

  it('passes through max_tokens when client sets it', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.max_tokens).toBe(256);
  });

  it('converts assistant tool_calls into tool_use content blocks', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'what time is it?' },
        {
          role: 'assistant',
          content: 'Let me check.',
          tool_calls: [
            {
              id: 'call_xyz',
              type: 'function',
              function: { name: 'current_time', arguments: '{"tz":"UTC"}' },
            },
          ],
        },
      ],
    });
    const asst = out.messages[1]!;
    expect(asst.role).toBe('assistant');
    expect(asst.content).toEqual([
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool_use',
        id: 'call_xyz',
        name: 'current_time',
        input: { tz: 'UTC' },
      },
    ]);
  });

  it('handles malformed tool_call arguments by emitting empty input object', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_bad',
              type: 'function',
              function: { name: 'foo', arguments: '{not json}' },
            },
          ],
        },
      ],
    });
    const asst = out.messages[0]!;
    expect((asst.content as Array<{ type: string }>)[0]).toMatchObject({
      type: 'tool_use',
      input: {},
    });
  });

  it('converts tool role messages into user messages with tool_result blocks', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'what time is it?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_xyz',
              type: 'function',
              function: { name: 'current_time', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_xyz',
          content: '2026-04-28T15:00:00Z',
        },
      ],
    });
    const toolResult = out.messages[2]!;
    expect(toolResult.role).toBe('user');
    expect(toolResult.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_xyz',
        content: '2026-04-28T15:00:00Z',
      },
    ]);
  });

  it('drops tool messages without tool_call_id (defensive against malformed inputs)', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'hi' },
        // Missing tool_call_id — should be silently dropped rather than
        // making us send a half-paired tool_result that 400s.
        { role: 'tool', content: 'orphan result' },
      ],
    });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]!.role).toBe('user');
  });

  it('translates image_url content parts into Anthropic image blocks (base64 data URI)', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,iVBORw0KGgo=',
              },
            },
          ],
        },
      ],
    });
    const blocks = out.messages[0]!.content as Array<unknown>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('translates image_url content parts into Anthropic image blocks (public URL)', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'caption this' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
      ],
    });
    const blocks = out.messages[0]!.content as Array<unknown>;
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/cat.png' },
    });
  });

  it('translates tools (function definitions) into Anthropic input_schema shape', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Return current weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
            },
          },
        },
      ],
    });
    expect(out.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Return current weather',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    ]);
  });

  it('translates tool_choice values', () => {
    const auto = translateRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'auto',
    });
    expect(auto.tool_choice).toEqual({ type: 'auto' });

    const required = translateRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'required',
    });
    expect(required.tool_choice).toEqual({ type: 'any' });

    const specific = translateRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'function', function: { name: 'foo' } },
    });
    expect(specific.tool_choice).toEqual({ type: 'tool', name: 'foo' });

    const none = translateRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'none',
    });
    expect(none.tool_choice).toBeUndefined();
  });

  it('passes through stream / temperature / top_p / stop', () => {
    const out = translateRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      temperature: 0.3,
      top_p: 0.95,
      stop: ['END'],
    });
    expect(out.stream).toBe(true);
    expect(out.temperature).toBe(0.3);
    expect(out.top_p).toBe(0.95);
    expect(out.stop_sequences).toEqual(['END']);
  });

  it('drops DeepSeek-specific stream_options', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      stream_options: { include_usage: true },
    } as OpenAIRequest);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('stream_options');
  });
});

// =============================================================================
// translateRequest — Extended Thinking (v0.1.50)
// =============================================================================

describe('translateRequest — extended thinking', () => {
  it('strips -thinking suffix and enables thinking with default budget', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6-thinking',
      messages: [{ role: 'user', content: 'hard problem' }],
    });
    expect(out.model).toBe('pa/claude-sonnet-4-6');
    expect(out.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 16_000,
    });
  });

  it('non-thinking model passes through with no thinking field', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.model).toBe('pa/claude-sonnet-4-6');
    expect(out.thinking).toBeUndefined();
  });

  it('bumps max_tokens above thinking budget when client max_tokens is too small', () => {
    const out = translateRequest({
      model: 'pa/claude-opus-4-6-thinking',
      max_tokens: 1024, // below the 16k budget — would 400 if forwarded
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.max_tokens).toBe(16_000 + 4_096);
  });

  it('respects client max_tokens when already above thinking budget', () => {
    const out = translateRequest({
      model: 'pa/claude-opus-4-6-thinking',
      max_tokens: 32_000,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.max_tokens).toBe(32_000);
  });

  it('drops temperature and top_p when thinking is enabled (Anthropic 400s otherwise)', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6-thinking',
      temperature: 0.3,
      top_p: 0.9,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
  });

  it('translates assistant.reasoning_content into a leading thinking content block (with signature)', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6-thinking',
      messages: [
        { role: 'user', content: 'first turn' },
        {
          role: 'assistant',
          content: "Here's my answer.",
          reasoning_content: 'Step 1: ...\nStep 2: ...',
          reasoning_signature: 'sig-base64-blob',
        },
        { role: 'user', content: 'now follow up' },
      ],
    });
    const asst = out.messages[1]!;
    expect(asst.role).toBe('assistant');
    const blocks = asst.content as Array<{
      type: string;
      thinking?: string;
      text?: string;
      signature?: string;
    }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: 'thinking',
      thinking: 'Step 1: ...\nStep 2: ...',
      signature: 'sig-base64-blob',
    });
    expect(blocks[1]).toEqual({ type: 'text', text: "Here's my answer." });
  });

  it('drops the thinking block when reasoning_content has no signature (v0.1.51 legacy turns)', () => {
    // Pre-v0.1.52 conversations recorded reasoning_content but never the
    // matching signature. Anthropic 400s if a thinking block is sent without
    // a signature, so for those legacy turns we drop the thinking block
    // entirely — reasoning continuity is lost on the legacy turn but the
    // request still goes through (instead of permanently failing).
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6-thinking',
      messages: [
        {
          role: 'assistant',
          content: 'Final answer.',
          reasoning_content: 'Some pre-v0.1.52 reasoning',
          // no reasoning_signature
        },
        { role: 'user', content: 'follow up' },
      ],
    });
    const asst = out.messages[0]!;
    // Should fall through to the plain-message branch with NO thinking block.
    expect(typeof asst.content === 'string' || Array.isArray(asst.content)).toBe(
      true,
    );
    if (Array.isArray(asst.content)) {
      expect(asst.content.find((b) => b.type === 'thinking')).toBeUndefined();
    }
  });

  it('preserves thinking block alongside tool_calls (thinking goes first, signature attached)', () => {
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6-thinking',
      messages: [
        {
          role: 'assistant',
          content: 'Calling tool now.',
          reasoning_content: 'Need to look this up.',
          reasoning_signature: 'sig-tool-turn',
          tool_calls: [
            {
              id: 'tu_a',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"x"}' },
            },
          ],
        },
      ],
    });
    const blocks = out.messages[0]!.content as Array<{
      type: string;
      signature?: string;
    }>;
    expect(blocks[0]!.type).toBe('thinking');
    expect(blocks[0]!.signature).toBe('sig-tool-turn');
    expect(blocks[1]!.type).toBe('text');
    expect(blocks[2]!.type).toBe('tool_use');
  });

  it('drops the thinking block on a tool-call assistant turn with no signature', () => {
    // Same legacy graceful-degrade as above, but for the tool-call branch.
    const out = translateRequest({
      model: 'pa/claude-sonnet-4-6-thinking',
      messages: [
        {
          role: 'assistant',
          content: 'Calling tool.',
          reasoning_content: 'Need lookup.',
          tool_calls: [
            {
              id: 'tu_b',
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
      ],
    });
    const blocks = out.messages[0]!.content as Array<{ type: string }>;
    expect(blocks.find((b) => b.type === 'thinking')).toBeUndefined();
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[1]!.type).toBe('tool_use');
  });
});

// =============================================================================
// translateResponse — Extended Thinking
// =============================================================================

describe('translateResponse — extended thinking', () => {
  it('extracts thinking block content into reasoning_content field', () => {
    const out = translateResponse({
      id: 'msg_t',
      type: 'message',
      role: 'assistant',
      model: 'pa/claude-sonnet-4-6',
      content: [
        { type: 'thinking', thinking: 'Pondering... 2 + 2 must be 4.' },
        { type: 'text', text: 'The answer is 4.' },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 10 },
    });
    expect(out.choices[0]!.message.reasoning_content).toBe(
      'Pondering... 2 + 2 must be 4.',
    );
    expect(out.choices[0]!.message.content).toBe('The answer is 4.');
  });

  it('omits reasoning_content when no thinking blocks in response', () => {
    const out = translateResponse({
      id: 'msg_n',
      type: 'message',
      role: 'assistant',
      model: 'x',
      content: [{ type: 'text', text: 'just text' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(out.choices[0]!.message.reasoning_content).toBeUndefined();
  });

  it('extracts the signature off thinking blocks into reasoning_signature', () => {
    // v0.1.52 — without this, the second send into a thinking conversation
    // 400s on the missing signature.
    const out = translateResponse({
      id: 'msg_s',
      type: 'message',
      role: 'assistant',
      model: 'x',
      content: [
        {
          type: 'thinking',
          thinking: 'reasoning trace',
          signature: 'sig-abc-123',
        },
        { type: 'text', text: 'final' },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 5 },
    });
    expect(out.choices[0]!.message.reasoning_signature).toBe('sig-abc-123');
  });

  it('roundtrips signature: response → request preserves the thinking block intact', () => {
    // End-to-end check that the v0.1.52 fix actually closes the loop. If the
    // client persists what translateResponse hands back and feeds it into
    // the next translateRequest, the resulting Anthropic message should
    // carry the signature unchanged.
    const apiResp = translateResponse({
      id: 'msg_rt',
      type: 'message',
      role: 'assistant',
      model: 'pa/claude-sonnet-4-6',
      content: [
        {
          type: 'thinking',
          thinking: 'first-turn reasoning',
          signature: 'first-turn-sig',
        },
        { type: 'text', text: 'first-turn answer' },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 8 },
    });
    const persistedAssistant = apiResp.choices[0]!.message;
    const nextReq = translateRequest({
      model: 'pa/claude-sonnet-4-6-thinking',
      messages: [
        { role: 'user', content: 'turn 1' },
        {
          role: 'assistant',
          content: persistedAssistant.content,
          reasoning_content: persistedAssistant.reasoning_content,
          reasoning_signature: persistedAssistant.reasoning_signature,
        },
        { role: 'user', content: 'turn 2 (the one that used to 400)' },
      ],
    });
    const asst = nextReq.messages[1]!;
    const blocks = asst.content as Array<{
      type: string;
      thinking?: string;
      signature?: string;
    }>;
    const thinkingBlock = blocks.find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.thinking).toBe('first-turn reasoning');
    expect(thinkingBlock!.signature).toBe('first-turn-sig');
  });
});

// =============================================================================
// translateStream — Extended Thinking
// =============================================================================

describe('translateStream — extended thinking', () => {
  it('emits thinking_delta as reasoning_content delta chunks', async () => {
    const out = await streamThrough([
      {
        type: 'message_start',
        message: { id: 'm', usage: { input_tokens: 3, output_tokens: 1 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Hmm...' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: ' got it!' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Answer: 4' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 12 },
      },
      { type: 'message_stop' },
    ]);

    // Both thinking deltas should appear as reasoning_content fields.
    expect(out).toContain('"reasoning_content":"Hmm..."');
    expect(out).toContain('"reasoning_content":" got it!"');
    // Then the text delta separately.
    expect(out).toContain('"content":"Answer: 4"');
    // Final stop chunk has finish_reason + usage.
    expect(out).toContain('"finish_reason":"stop"');
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('surfaces signature_delta as a reasoning_signature delta chunk', async () => {
    // v0.1.52 fix: pre-v0.1.52 we silently dropped signature_delta and
    // a second send into the same conversation 400'd. Now the signature
    // flows through as a delta the client can persist on the assistant
    // message and echo back on the next turn.
    const out = await streamThrough([
      {
        type: 'message_start',
        message: { id: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'thinking' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'opaque-signature' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ]);

    expect(out).toContain('"reasoning_content":"thinking"');
    expect(out).toContain('"reasoning_signature":"opaque-signature"');
  });
});

// =============================================================================
// translateResponse (non-streaming)
// =============================================================================

describe('translateResponse', () => {
  it('builds OpenAI shape with text + usage', () => {
    const resp: AnthropicResponse = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'pa/claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Hi there!' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const out = translateResponse(resp);
    expect(out.choices[0]!.message.content).toBe('Hi there!');
    expect(out.choices[0]!.finish_reason).toBe('stop');
    expect(out.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
    });
  });

  it('extracts tool_use blocks into tool_calls + sets finish_reason=tool_calls', () => {
    const resp: AnthropicResponse = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'pa/claude-sonnet-4-6',
      content: [
        { type: 'text', text: 'Calling tool now.' },
        {
          type: 'tool_use',
          id: 'toolu_a',
          name: 'get_weather',
          input: { city: 'SF' },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 7 },
    };
    const out = translateResponse(resp);
    expect(out.choices[0]!.finish_reason).toBe('tool_calls');
    expect(out.choices[0]!.message.content).toBe('Calling tool now.');
    expect(out.choices[0]!.message.tool_calls).toEqual([
      {
        id: 'toolu_a',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: JSON.stringify({ city: 'SF' }),
        },
      },
    ]);
  });

  it('maps stop_reason variants', () => {
    const base: AnthropicResponse = {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'x',
      content: [{ type: 'text', text: 'x' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    expect(translateResponse({ ...base, stop_reason: 'end_turn' }).choices[0]!.finish_reason).toBe('stop');
    expect(translateResponse({ ...base, stop_reason: 'stop_sequence' }).choices[0]!.finish_reason).toBe('stop');
    expect(translateResponse({ ...base, stop_reason: 'tool_use' }).choices[0]!.finish_reason).toBe('tool_calls');
    expect(translateResponse({ ...base, stop_reason: 'max_tokens' }).choices[0]!.finish_reason).toBe('length');
  });
});

// =============================================================================
// translateStream
// =============================================================================

/**
 * Helper: build an Anthropic SSE byte stream from a list of events,
 * pipe it through the translator, collect the OpenAI SSE output as a
 * string, and return.
 */
async function streamThrough(events: Array<Record<string, unknown>>, model = 'pa/claude-sonnet-4-6'): Promise<string> {
  const encoder = new TextEncoder();
  const chunks = events.map(
    (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
  );

  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });

  const out = upstream.pipeThrough(translateStream(model));
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  return buf;
}

describe('translateStream', () => {
  it('emits role header + content delta + final stop chunk + [DONE]', async () => {
    const out = await streamThrough([
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'x',
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 8 },
      },
      { type: 'message_stop' },
    ]);

    // Must have `data: ` prefix per chunk + `data: [DONE]\n\n` terminator.
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
    // Role header in first chunk.
    expect(out).toContain('"role":"assistant"');
    // Both text deltas.
    expect(out).toContain('"content":"Hello"');
    expect(out).toContain('"content":" world"');
    // Final chunk with finish_reason + usage.
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"prompt_tokens":5');
    expect(out).toContain('"completion_tokens":8');
    expect(out).toContain('"total_tokens":13');
  });

  it('emits tool_calls header + arguments deltas for tool_use blocks', async () => {
    const out = await streamThrough([
      {
        type: 'message_start',
        message: {
          id: 'msg_2',
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_z',
          name: 'get_weather',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"SF"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 12 },
      },
      { type: 'message_stop' },
    ]);

    // Tool call header chunk: id + name + empty args.
    expect(out).toContain('"id":"toolu_z"');
    expect(out).toContain('"name":"get_weather"');
    // Two argument deltas with the partial JSON pieces.
    expect(out).toContain('"arguments":"{\\"city\\":"');
    expect(out).toContain('"arguments":"\\"SF\\"}"');
    // Final stop reason mapped.
    expect(out).toContain('"finish_reason":"tool_calls"');
  });

  it('handles mixed text + tool_use content blocks in one message', async () => {
    const out = await streamThrough([
      {
        type: 'message_start',
        message: { id: 'm3', usage: { input_tokens: 8, output_tokens: 1 } },
      },
      // First a text block.
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Looking up...' },
      },
      { type: 'content_block_stop', index: 0 },
      // Then a tool_use block.
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't1', name: 'lookup', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 9 },
      },
      { type: 'message_stop' },
    ]);

    expect(out).toContain('"content":"Looking up..."');
    expect(out).toContain('"id":"t1"');
    expect(out).toContain('"name":"lookup"');
    expect(out).toContain('"finish_reason":"tool_calls"');
  });

  it('handles SSE events split across input chunks', async () => {
    // Simulate the Workers runtime delivering one Anthropic event in
    // two pieces (network coalescing happens in real life).
    const encoder = new TextEncoder();
    const event1Half1 = `event: message_start\ndata: {"type":"messag`;
    const event1Half2 =
      `e_start","message":{"id":"x","usage":{"input_tokens":1,"output_tokens":1}}}\n\n`;
    const event2 =
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`;
    const event3 =
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`;
    const event4 =
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;

    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(event1Half1));
        controller.enqueue(encoder.encode(event1Half2 + event2));
        controller.enqueue(encoder.encode(event3));
        controller.enqueue(encoder.encode(event4));
        controller.close();
      },
    });

    const out = upstream.pipeThrough(translateStream('x'));
    const reader = out.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
    expect(buf).toContain('"content":"hi"');
    expect(buf).toContain('"finish_reason":"stop"');
    expect(buf.endsWith('data: [DONE]\n\n')).toBe(true);
  });
});
