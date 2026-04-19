import { describe, it, expect } from 'vitest';
import type { Message } from '@/types';
import { buildSummaryPrompt } from './conversationSummary';

const msg = (over: Partial<Message> = {}): Message => ({
  id: over.id ?? 'm' + Math.random().toString(36).slice(2, 7),
  role: over.role ?? 'user',
  content: over.content ?? '',
  createdAt: over.createdAt ?? 0,
  reasoning: over.reasoning,
  toolCalls: over.toolCalls,
});

describe('buildSummaryPrompt', () => {
  it('includes the instruction to output only the summary', () => {
    const p = buildSummaryPrompt([msg({ content: 'hi' })]);
    expect(p).toContain('只输出摘要');
  });

  it('labels roles in Chinese', () => {
    const p = buildSummaryPrompt([
      msg({ role: 'user', content: 'Q' }),
      msg({ role: 'assistant', content: 'A' }),
    ]);
    expect(p).toContain('### 用户');
    expect(p).toContain('### 助手');
  });

  it('renders each message content verbatim', () => {
    const p = buildSummaryPrompt([
      msg({ role: 'user', content: 'I prefer pnpm over npm' }),
    ]);
    expect(p).toContain('I prefer pnpm over npm');
  });

  it('truncates extremely long messages to avoid blowing the summarizer context', () => {
    const huge = 'x'.repeat(10_000);
    const p = buildSummaryPrompt([msg({ content: huge })]);
    expect(p.length).toBeLessThan(huge.length + 2000); // not the full 10k
    expect(p).toContain('[…内容过长，已截断]');
  });

  it('merges an existing summary when provided', () => {
    const p = buildSummaryPrompt(
      [msg({ content: 'new turn' })],
      '## Previous gist\n- user likes pytest'
    );
    expect(p).toContain('此前已经有一份摘要');
    expect(p).toContain('user likes pytest');
  });

  it('skips the merge branch when no existing summary', () => {
    const p = buildSummaryPrompt([msg({ content: 'x' })]);
    expect(p).not.toContain('此前已经有一份摘要');
  });

  it('includes reasoning (truncated) when present on a message', () => {
    const p = buildSummaryPrompt([
      msg({
        role: 'assistant',
        content: 'answer',
        reasoning: 'long chain of thought'.repeat(50),
      }),
    ]);
    expect(p).toContain('推理过程');
  });

  it('keeps message order', () => {
    const p = buildSummaryPrompt([
      msg({ role: 'user', content: 'FIRST' }),
      msg({ role: 'assistant', content: 'SECOND' }),
      msg({ role: 'user', content: 'THIRD' }),
    ]);
    const iFirst = p.indexOf('FIRST');
    const iSecond = p.indexOf('SECOND');
    const iThird = p.indexOf('THIRD');
    expect(iFirst).toBeGreaterThan(-1);
    expect(iSecond).toBeGreaterThan(iFirst);
    expect(iThird).toBeGreaterThan(iSecond);
  });

  it('asks for same language as the conversation', () => {
    // The prompt should tell the model to keep the original language so a
    // Chinese conversation doesn't get summarized in English.
    const p = buildSummaryPrompt([msg({ content: '你好' })]);
    expect(p).toContain('原始语言');
  });
});
