import { describe, it, expect } from 'vitest';
import type { Conversation, Message } from '@/types';
import { extractSnippet, searchConversations } from './conversationSearch';

const msg = (over: Partial<Message> = {}): Message => ({
  id: over.id ?? 'm' + Math.random().toString(36).slice(2, 7),
  role: over.role ?? 'user',
  content: over.content ?? '',
  createdAt: over.createdAt ?? 0,
  reasoning: over.reasoning,
  toolCalls: over.toolCalls,
});

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: over.id ?? 'c' + Math.random().toString(36).slice(2, 7),
  title: over.title ?? '',
  mode: over.mode ?? 'chat',
  modelId: over.modelId ?? 'deepseek-v3',
  messages: over.messages ?? [],
  createdAt: over.createdAt ?? 0,
  updatedAt: over.updatedAt ?? 0,
  pinned: over.pinned,
  starred: over.starred,
});

describe('extractSnippet', () => {
  it('returns the whole string when it fits in the window', () => {
    const text = 'hello world';
    const { snippet, highlightStart } = extractSnippet(text, 6, 5);
    expect(snippet).toBe('hello world');
    expect(text.slice(highlightStart, highlightStart + 5)).toBe('world');
  });

  it('adds left ellipsis when the match is far into the text', () => {
    const text = 'a'.repeat(200) + 'NEEDLE' + 'a'.repeat(200);
    const { snippet, highlightStart } = extractSnippet(text, 200, 6);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.slice(highlightStart, highlightStart + 6)).toBe('NEEDLE');
  });

  it('adds right ellipsis when text extends past the window', () => {
    const text = 'NEEDLE' + 'a'.repeat(200);
    const { snippet } = extractSnippet(text, 0, 6);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('collapses whitespace but keeps match alignment', () => {
    const text = 'line1\n\n\n   line2 NEEDLE tail';
    const { snippet, highlightStart } = extractSnippet(text, text.indexOf('NEEDLE'), 6);
    expect(snippet).not.toMatch(/\s{2,}/);
    expect(snippet.slice(highlightStart, highlightStart + 6)).toBe('NEEDLE');
  });

  it('keeps match near the start (asymmetric radius) so 2-line clamps still show it', () => {
    // Simulate a long message where the match is buried 100+ chars in.
    const text = 'a'.repeat(120) + ' NEEDLE ' + 'b'.repeat(120);
    const matchIdx = text.indexOf('NEEDLE');
    const { snippet, highlightStart } = extractSnippet(text, matchIdx, 6);

    // The match should live in the first third of the snippet, not the middle.
    expect(highlightStart).toBeLessThan(snippet.length / 2);
    expect(snippet.slice(highlightStart, highlightStart + 6)).toBe('NEEDLE');

    // Still has plenty of context AFTER the match (the point of asymmetry).
    const tail = snippet.slice(highlightStart + 6);
    expect(tail.length).toBeGreaterThan(30);
  });

  it('preserves mixed-case match text while still matching case-insensitively', () => {
    // Reproduces the real bug: user searches "Pytorch" and original content
    // says "PyTorch". The snippet should contain the original casing.
    const text = 'Hey, I prefer PyTorch over TensorFlow for this task.';
    const q = 'pytorch';
    const matchIdx = text.toLowerCase().indexOf(q);
    const { snippet, highlightStart } = extractSnippet(text, matchIdx, q.length);
    expect(snippet.slice(highlightStart, highlightStart + 7)).toBe('PyTorch');
  });
});

describe('searchConversations', () => {
  it('returns empty for empty or whitespace query', () => {
    const cs = [conv({ title: 'hello' })];
    expect(searchConversations(cs, '')).toEqual([]);
    expect(searchConversations(cs, '   ')).toEqual([]);
  });

  it('matches on title (case-insensitive)', () => {
    const c = conv({ title: 'Flaude Roadmap', updatedAt: 1_000_000_000 });
    const hits = searchConversations([c], 'flaude');
    expect(hits).toHaveLength(1);
    expect(hits[0].messageId).toBeUndefined();
    expect(hits[0].conversation.id).toBe(c.id);
  });

  it('matches on message content and returns a snippet', () => {
    const m = msg({ role: 'user', content: 'I prefer pnpm not npm for install' });
    const c = conv({ title: 'Unrelated title', messages: [m] });
    const hits = searchConversations([c], 'pnpm');
    expect(hits).toHaveLength(1);
    expect(hits[0].messageId).toBe(m.id);
    expect(hits[0].snippet).toContain('pnpm');
    const { start, end } = hits[0].highlight;
    expect(hits[0].snippet.slice(start, end).toLowerCase()).toBe('pnpm');
  });

  it('prefers title matches over content matches (score ordering)', () => {
    const withTitle = conv({
      id: 'A',
      title: 'pnpm guide',
      updatedAt: 1,
    });
    const withContent = conv({
      id: 'B',
      title: 'Unrelated',
      messages: [msg({ content: 'use pnpm everywhere' })],
      updatedAt: 99999,
    });
    const hits = searchConversations([withContent, withTitle], 'pnpm');
    expect(hits.map((h) => h.conversation.id)).toEqual(['A', 'B']);
  });

  it('tiebreaks by recency within the same match tier', () => {
    const older = conv({ id: 'old', title: 'pnpm old', updatedAt: 1 });
    const newer = conv({ id: 'new', title: 'pnpm new', updatedAt: 1_000_000_000 });
    const hits = searchConversations([older, newer], 'pnpm');
    expect(hits[0].conversation.id).toBe('new');
    expect(hits[1].conversation.id).toBe('old');
  });

  it('returns only one hit per conversation even with multiple matches', () => {
    const c = conv({
      messages: [
        msg({ content: 'pnpm first' }),
        msg({ content: 'pnpm second' }),
        msg({ content: 'pnpm third' }),
      ],
    });
    const hits = searchConversations([c], 'pnpm');
    expect(hits).toHaveLength(1);
  });

  it('skips tool-role messages (JSON noise)', () => {
    const c = conv({
      title: 'clean',
      messages: [
        msg({ role: 'tool', content: '{"tool_result": "found pnpm"}' }),
      ],
    });
    const hits = searchConversations([c], 'pnpm');
    expect(hits).toEqual([]);
  });

  it('searches reasoning when content does not match', () => {
    const c = conv({
      title: 'unrelated',
      messages: [
        msg({
          role: 'assistant',
          content: 'short answer',
          reasoning: 'thinking about pnpm vs npm tradeoffs',
        }),
      ],
    });
    const hits = searchConversations([c], 'pnpm');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('pnpm');
  });

  it('searches across all modes (not just one)', () => {
    const cs = [
      conv({ id: 'chat', mode: 'chat', title: 'pnpm in chat' }),
      conv({ id: 'code', mode: 'code', title: 'pnpm in code' }),
    ];
    const hits = searchConversations(cs, 'pnpm');
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.conversation.mode))).toEqual(
      new Set(['chat', 'code'])
    );
  });

  it('respects the limit parameter', () => {
    const cs = Array.from({ length: 100 }, (_, i) =>
      conv({ id: 'c' + i, title: 'pnpm ' + i, updatedAt: i })
    );
    const hits = searchConversations(cs, 'pnpm', 5);
    expect(hits).toHaveLength(5);
  });

  it('is case-insensitive in both directions', () => {
    const c = conv({ title: 'HELLO WORLD', messages: [msg({ content: 'aBcDeF' })] });
    expect(searchConversations([c], 'hello')).toHaveLength(1);
    expect(searchConversations([c], 'ABCDEF')).toHaveLength(1);
  });

  it('highlights the exact match span', () => {
    const c = conv({ messages: [msg({ content: 'prefix NEEDLE suffix' })] });
    const [hit] = searchConversations([c], 'needle');
    const highlighted = hit.snippet.slice(hit.highlight.start, hit.highlight.end);
    expect(highlighted.toLowerCase()).toBe('needle');
  });
});
