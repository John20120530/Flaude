import { describe, it, expect } from 'vitest';
import type { Message } from '@/types';
import { serializeMessages, serializeToolArgs } from './wireFormat';

const userMsg = (over: Partial<Message> = {}): Message => ({
  id: over.id ?? 'm1',
  role: over.role ?? 'user',
  content: over.content ?? '',
  createdAt: over.createdAt ?? 0,
  ...over,
});

describe('serializeMessages — basics', () => {
  it('prepends a system message when one is provided', () => {
    const out = serializeMessages([userMsg({ content: 'hi' })], 'You are Flaude.');
    expect(out[0]).toEqual({ role: 'system', content: 'You are Flaude.' });
    expect(out[1]?.role).toBe('user');
    expect(out[1]?.content).toBe('hi');
  });

  it('omits system message when none is provided', () => {
    const out = serializeMessages([userMsg({ content: 'hi' })]);
    expect(out[0]?.role).toBe('user');
  });

  it('passes through plain text user/assistant turns as strings', () => {
    const out = serializeMessages([
      userMsg({ id: 'u', role: 'user', content: 'q' }),
      userMsg({ id: 'a', role: 'assistant', content: 'a' }),
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('echoes reasoning_content on assistant messages (DeepSeek thinking-mode requirement)', () => {
    const out = serializeMessages([
      userMsg({ role: 'assistant', content: 'final answer', reasoning: 'I thought hard' }),
    ]);
    expect(out[0]).toMatchObject({
      role: 'assistant',
      content: 'final answer',
      reasoning_content: 'I thought hard',
    });
  });

  it('does NOT echo reasoning_content on user messages', () => {
    const out = serializeMessages([
      userMsg({ role: 'user', content: 'q', reasoning: 'should be ignored' }),
    ]);
    expect(out[0]).not.toHaveProperty('reasoning_content');
  });
});

describe('serializeMessages — tool calls', () => {
  it('packages assistant tool_calls under the message and serializes args to a JSON string', () => {
    // History needs a matching tool result, otherwise the serializer drops
    // the tool_call as an orphan (see "orphan tool_calls" describe below).
    const out = serializeMessages([
      userMsg({
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'tc1',
            name: 'fs_read_file',
            arguments: { path: 'README.md' },
            status: 'success',
          },
        ],
      }),
      userMsg({
        role: 'tool',
        content: 'file contents',
        toolCalls: [{ id: 'tc1', name: 'fs_read_file', arguments: {}, status: 'success' }],
      }),
    ]);
    expect(out[0]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'fs_read_file', arguments: '{"path":"README.md"}' },
        },
      ],
    });
  });

  it('routes a tool result message via tool_call_id', () => {
    const out = serializeMessages([
      userMsg({
        role: 'tool',
        content: 'file contents here',
        toolCalls: [{ id: 'tc1', name: 'fs_read_file', arguments: {}, status: 'success' }],
      }),
    ]);
    expect(out[0]).toEqual({
      role: 'tool',
      tool_call_id: 'tc1',
      content: 'file contents here',
    });
  });

  it('echoes reasoning_content on the tool-call branch too', () => {
    const out = serializeMessages([
      userMsg({
        role: 'assistant',
        content: '',
        reasoning: 'plan',
        toolCalls: [{ id: 't', name: 'x', arguments: {}, status: 'success' }],
      }),
      userMsg({
        role: 'tool',
        content: 'r',
        toolCalls: [{ id: 't', name: 'x', arguments: {}, status: 'success' }],
      }),
    ]);
    expect(out[0]).toMatchObject({ reasoning_content: 'plan' });
  });
});

describe('serializeMessages — image attachments (legacy + explicit)', () => {
  it('legacy image attachment (no kind, image mime + data) → multimodal parts', () => {
    const out = serializeMessages([
      userMsg({
        content: 'what is this?',
        attachments: [
          {
            id: 'a',
            name: 'pic.png',
            mimeType: 'image/png',
            size: 100,
            data: 'data:image/png;base64,abc',
          },
        ],
      }),
    ]);
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ]);
  });

  it('explicit kind=image attachment serializes the same way', () => {
    const out = serializeMessages([
      userMsg({
        content: '?',
        attachments: [
          {
            id: 'a',
            name: 'pic.png',
            mimeType: 'image/png',
            size: 100,
            kind: 'image',
            data: 'data:image/png;base64,xyz',
          },
        ],
      }),
    ]);
    expect(out[0]?.content).toEqual([
      { type: 'text', text: '?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xyz' } },
    ]);
  });

  it('emits a text-only multimodal payload when an image has no data field (defensive — should not happen in practice)', () => {
    const out = serializeMessages([
      userMsg({
        content: 'hi',
        attachments: [
          { id: 'a', name: 'broken.png', mimeType: 'image/png', size: 0, kind: 'image' },
        ],
      }),
    ]);
    // The image is "claimed" so we still take the multimodal path, but the
    // image_url part is dropped (would be invalid). Result is a single
    // text part — model still gets the user's question intact.
    expect(out[0]?.content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('serializeMessages — text attachments (the new path)', () => {
  it('appends a single text attachment as a fenced block to the user content', () => {
    const out = serializeMessages([
      userMsg({
        content: '请帮我看看这个文件',
        attachments: [
          {
            id: 'a',
            name: 'requirements.txt',
            mimeType: 'text/plain',
            size: 30,
            kind: 'text',
            text: 'flask==2.0.0\ndjango==4.0.0',
          },
        ],
      }),
    ]);
    expect(typeof out[0]?.content).toBe('string');
    const c = out[0]?.content as string;
    expect(c).toContain('请帮我看看这个文件');
    expect(c).toContain('**附件: requirements.txt**');
    expect(c).toContain('flask==2.0.0');
    expect(c).toContain('django==4.0.0');
  });

  it('still works when the body text is empty (file dropped without a question)', () => {
    const out = serializeMessages([
      userMsg({
        content: '',
        attachments: [
          {
            id: 'a',
            name: 'data.csv',
            mimeType: 'text/csv',
            size: 10,
            kind: 'text',
            text: 'a,b\n1,2',
          },
        ],
      }),
    ]);
    const c = out[0]?.content as string;
    expect(c).toContain('**附件: data.csv**');
    expect(c).toContain('a,b\n1,2');
  });

  it('marks truncated attachments in the heading', () => {
    const out = serializeMessages([
      userMsg({
        content: 'analyze',
        attachments: [
          {
            id: 'a',
            name: 'huge.log',
            mimeType: 'text/plain',
            size: 9999999,
            kind: 'text',
            text: 'partial...',
            textTruncated: true,
          },
        ],
      }),
    ]);
    const c = out[0]?.content as string;
    expect(c).toContain('（已截断）');
  });

  it('infers a code-fence language hint from the extension', () => {
    const out = serializeMessages([
      userMsg({
        content: '',
        attachments: [
          {
            id: 'a',
            name: 'app.ts',
            mimeType: 'application/octet-stream',
            size: 1,
            kind: 'text',
            text: 'export const x = 1;',
          },
        ],
      }),
    ]);
    expect(out[0]?.content as string).toContain('```typescript');
  });

  it('renders multiple text attachments as separate fences', () => {
    const out = serializeMessages([
      userMsg({
        content: '',
        attachments: [
          {
            id: 'a',
            name: 'a.json',
            mimeType: 'application/json',
            size: 1,
            kind: 'text',
            text: '{"a":1}',
          },
          {
            id: 'b',
            name: 'b.yaml',
            mimeType: 'text/yaml',
            size: 1,
            kind: 'text',
            text: 'b: 2',
          },
        ],
      }),
    ]);
    const c = out[0]?.content as string;
    expect(c).toContain('**附件: a.json**');
    expect(c).toContain('**附件: b.yaml**');
    expect(c.indexOf('a.json')).toBeLessThan(c.indexOf('b.yaml'));
  });
});

describe('serializeMessages — mixed image + text attachments', () => {
  it('text gets merged into the text part, image stays as image_url', () => {
    const out = serializeMessages([
      userMsg({
        content: '看一下这两个',
        attachments: [
          {
            id: 'i',
            name: 'screenshot.png',
            mimeType: 'image/png',
            size: 1,
            kind: 'image',
            data: 'data:image/png;base64,XX',
          },
          {
            id: 't',
            name: 'config.yaml',
            mimeType: 'text/yaml',
            size: 1,
            kind: 'text',
            text: 'enabled: true',
          },
        ],
      }),
    ]);
    expect(Array.isArray(out[0]?.content)).toBe(true);
    const parts = out[0]?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]?.type).toBe('text');
    expect(parts[0]?.text).toContain('看一下这两个');
    expect(parts[0]?.text).toContain('**附件: config.yaml**');
    expect(parts[0]?.text).toContain('enabled: true');
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,XX' } });
  });
});

describe('serializeMessages — duplicate tool_call_id (regen race / stop overlap)', () => {
  it('drops earlier tool messages when a later one shares the same tool_call_id (last-write-wins)', () => {
    // Pathological history: two role=tool messages claim tool_call_id 'X'.
    // Upstream rejects with 400 "Duplicate value for 'tool_call_id' of
    // call_X in message[N]" — we emit only the freshest one.
    const out = serializeMessages([
      userMsg({ id: 'u', role: 'user', content: 'go' }),
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'X', name: 'fs_read_file', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't1',
        role: 'tool',
        content: 'STALE result',
        toolCalls: [{ id: 'X', name: 'fs_read_file', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't2',
        role: 'tool',
        content: 'FRESH result',
        toolCalls: [{ id: 'X', name: 'fs_read_file', arguments: {}, status: 'success' }],
      }),
    ]);
    const toolMessages = out.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'X',
      content: 'FRESH result',
    });
  });

  it('handles a triple duplicate (stop-cleanup synthesizing twice + real result) — emits exactly one', () => {
    const out = serializeMessages([
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'X', name: 't', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't1',
        role: 'tool',
        content: 'first',
        toolCalls: [{ id: 'X', name: 't', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't2',
        role: 'tool',
        content: 'second',
        toolCalls: [{ id: 'X', name: 't', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't3',
        role: 'tool',
        content: 'third',
        toolCalls: [{ id: 'X', name: 't', arguments: {}, status: 'success' }],
      }),
    ]);
    const toolMessages = out.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toBe('third');
  });

  it('keeps tool messages with distinct ids (no false positive dedup)', () => {
    const out = serializeMessages([
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'A', name: 't', arguments: {}, status: 'success' },
          { id: 'B', name: 't', arguments: {}, status: 'success' },
          { id: 'C', name: 't', arguments: {}, status: 'success' },
        ],
      }),
      userMsg({
        id: 't1', role: 'tool', content: 'a-result',
        toolCalls: [{ id: 'A', name: 't', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't2', role: 'tool', content: 'b-result',
        toolCalls: [{ id: 'B', name: 't', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't3', role: 'tool', content: 'c-result',
        toolCalls: [{ id: 'C', name: 't', arguments: {}, status: 'success' }],
      }),
    ]);
    const ids = out
      .filter((m) => m.role === 'tool')
      .map((m) => (m as { tool_call_id: string }).tool_call_id);
    expect(ids).toEqual(['A', 'B', 'C']);
  });
});

describe('serializeMessages — duplicate tool_call inside one assistant message', () => {
  // The other path: not duplicate ROLE=tool messages (handled above), but
  // the SAME id appearing twice in a single assistant.tool_calls array.
  // OpenAI then sees N tool_calls but only finds N-1 unique tool messages
  // and rejects with "insufficient tool messages following tool_calls".

  it('emits each tool_call_id exactly once even if it appears twice in the source array', () => {
    const out = serializeMessages([
      userMsg({ id: 'u', role: 'user', content: 'go' }),
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'A', name: 't', arguments: {}, status: 'success' },
          { id: 'B', name: 't', arguments: {}, status: 'success' },
          { id: 'B', name: 't', arguments: {}, status: 'success' }, // duplicate
          { id: 'C', name: 't', arguments: {}, status: 'success' },
        ],
      }),
      userMsg({
        id: 't1', role: 'tool', content: 'a',
        toolCalls: [{ id: 'A', name: 't', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't2', role: 'tool', content: 'b',
        toolCalls: [{ id: 'B', name: 't', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't3', role: 'tool', content: 'c',
        toolCalls: [{ id: 'C', name: 't', arguments: {}, status: 'success' }],
      }),
    ]);
    const assistant = out.find((m) => m.role === 'assistant') as { tool_calls?: Array<{ id: string }> };
    expect(assistant.tool_calls).toHaveLength(3);
    expect(assistant.tool_calls?.map((tc) => tc.id)).toEqual(['A', 'B', 'C']);
    // Tool messages: 3 (one per id), all present.
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(3);
  });

  it('keeps the FIRST occurrence when an assistant has the same id twice (deterministic)', () => {
    const out = serializeMessages([
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'X', name: 'first-version', arguments: { v: 1 }, status: 'success' },
          { id: 'X', name: 'second-version', arguments: { v: 2 }, status: 'success' },
        ],
      }),
      userMsg({
        id: 't', role: 'tool', content: 'r',
        toolCalls: [{ id: 'X', name: 'first-version', arguments: {}, status: 'success' }],
      }),
    ]);
    const assistant = out[0] as { tool_calls?: Array<{ id: string; function: { name: string } }> };
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls?.[0]?.function.name).toBe('first-version');
  });

  it('still strips orphans when combined with duplicates (defense in depth)', () => {
    // Mixed: A is good, B appears twice but is responded, C is orphan.
    const out = serializeMessages([
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'A', name: 't', arguments: {}, status: 'success' },
          { id: 'B', name: 't', arguments: {}, status: 'success' },
          { id: 'B', name: 't', arguments: {}, status: 'success' },
          { id: 'C', name: 't', arguments: {}, status: 'pending' }, // orphan
        ],
      }),
      userMsg({
        id: 't1', role: 'tool', content: 'a',
        toolCalls: [{ id: 'A', name: 't', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't2', role: 'tool', content: 'b',
        toolCalls: [{ id: 'B', name: 't', arguments: {}, status: 'success' }],
      }),
    ]);
    const assistant = out.find((m) => m.role === 'assistant') as { tool_calls?: Array<{ id: string }> };
    expect(assistant.tool_calls?.map((tc) => tc.id)).toEqual(['A', 'B']);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(2);
  });
});

describe('serializeMessages — orphan tool_calls (user clicked Stop mid-call)', () => {
  it('drops a tool_call that has no matching tool message — assistant becomes plain text', () => {
    // History: user → assistant with tool_calls but NO subsequent tool message.
    // This is exactly the state the conversation lands in when the user hits
    // Stop after the model emitted tool_call deltas but before execute ran.
    const out = serializeMessages([
      userMsg({ id: 'u', role: 'user', content: 'do X' }),
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '我开始了',
        toolCalls: [
          { id: 'tc-orphan', name: 'todo_write', arguments: {}, status: 'pending' },
        ],
      }),
    ]);
    // Must NOT include tool_calls in the wire payload — that would 400.
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'assistant', content: '我开始了' });
    expect(out[1]).not.toHaveProperty('tool_calls');
  });

  it('skips an empty assistant message whose only tool_calls were orphans', () => {
    // Same as above but with no text content the model produced before abort.
    const out = serializeMessages([
      userMsg({ id: 'u', role: 'user', content: 'do X' }),
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc-orphan', name: 'todo_write', arguments: {}, status: 'pending' },
        ],
      }),
      userMsg({ id: 'u2', role: 'user', content: '换个事' }),
    ]);
    expect(out).toHaveLength(2); // first user, second user — assistant dropped
    expect(out[0]?.role).toBe('user');
    expect(out[1]?.role).toBe('user');
    expect(out[1]?.content).toBe('换个事');
  });

  it('keeps an assistant message intact when ALL its tool_calls have matching tool messages', () => {
    const out = serializeMessages([
      userMsg({ id: 'u', role: 'user', content: 'do X' }),
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'todo_write', arguments: {}, status: 'success' },
          { id: 'tc-2', name: 'fs_read_file', arguments: {}, status: 'success' },
        ],
      }),
      userMsg({
        id: 't1',
        role: 'tool',
        content: 'result 1',
        toolCalls: [{ id: 'tc-1', name: 'todo_write', arguments: {}, status: 'success' }],
      }),
      userMsg({
        id: 't2',
        role: 'tool',
        content: 'result 2',
        toolCalls: [{ id: 'tc-2', name: 'fs_read_file', arguments: {}, status: 'success' }],
      }),
    ]);
    const assistant = out[1] as { tool_calls?: unknown[] };
    expect(assistant.tool_calls).toHaveLength(2);
  });

  it('partially keeps tool_calls — drops only the orphan, keeps the responded one', () => {
    const out = serializeMessages([
      userMsg({ id: 'u', role: 'user', content: 'do X' }),
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc-good', name: 'fs_read_file', arguments: {}, status: 'success' },
          { id: 'tc-orphan', name: 'todo_write', arguments: {}, status: 'pending' },
        ],
      }),
      userMsg({
        id: 't1',
        role: 'tool',
        content: 'file contents',
        toolCalls: [{ id: 'tc-good', name: 'fs_read_file', arguments: {}, status: 'success' }],
      }),
    ]);
    const assistant = out[1] as { tool_calls?: Array<{ id: string }> };
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls?.[0]?.id).toBe('tc-good');
  });

  it('preserves reasoning_content on the salvaged plain-text assistant message (DeepSeek thinking-mode)', () => {
    const out = serializeMessages([
      userMsg({
        id: 'a',
        role: 'assistant',
        content: '我想了一下',
        reasoning: 'reasoning trace',
        toolCalls: [
          { id: 'tc-orphan', name: 'todo_write', arguments: {}, status: 'pending' },
        ],
      }),
    ]);
    expect(out[0]).toMatchObject({
      role: 'assistant',
      content: '我想了一下',
      reasoning_content: 'reasoning trace',
    });
  });
});

describe('serializeToolArgs', () => {
  it('passes a string through unchanged', () => {
    expect(serializeToolArgs('{"a":1}')).toBe('{"a":1}');
  });
  it('JSON-encodes a plain object', () => {
    expect(serializeToolArgs({ a: 1, b: 'two' })).toBe('{"a":1,"b":"two"}');
  });
  it('uses __raw if present (mid-stream wrapper)', () => {
    expect(serializeToolArgs({ __raw: '{partial' })).toBe('{partial');
  });
  it('returns "{}" for null / undefined / non-encodable', () => {
    expect(serializeToolArgs(null)).toBe('{}');
    expect(serializeToolArgs(undefined)).toBe('{}');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(serializeToolArgs(cyclic)).toBe('{}');
  });
});
