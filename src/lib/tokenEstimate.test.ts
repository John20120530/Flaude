import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessagesTokens } from './tokenEstimate';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('treats CJK characters as 1 token each', () => {
    // 10 Chinese characters → 10 tokens.
    expect(estimateTokens('你好世界今天天气很好')).toBe(10);
  });

  it('treats Latin text as ~1 token per 4 characters', () => {
    // "hello world" = 11 chars → ceil(11/4) = 3.
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('mixes CJK and Latin additively', () => {
    // "你好 world" = 2 CJK + 6 other → 2 + ceil(6/4) = 2 + 2 = 4.
    expect(estimateTokens('你好 world')).toBe(4);
  });

  it('counts Japanese kana as CJK', () => {
    // 5 hiragana
    expect(estimateTokens('ありがとう')).toBe(5);
  });

  it('counts Korean hangul as CJK', () => {
    // 4 hangul syllables
    expect(estimateTokens('안녕하세')).toBe(4);
  });

  it('scales roughly linearly with length', () => {
    const short = estimateTokens('a'.repeat(100));
    const long = estimateTokens('a'.repeat(1000));
    // Should be ~10x — allow for ceil rounding.
    expect(long).toBeGreaterThanOrEqual(short * 9);
    expect(long).toBeLessThanOrEqual(short * 11);
  });

  it('handles punctuation and whitespace without exploding', () => {
    // Ensures the function doesn't choke on real-world input.
    const text = 'Hello, world! How are you?\n\nI am fine.';
    expect(estimateTokens(text)).toBeGreaterThan(0);
    expect(estimateTokens(text)).toBeLessThan(text.length);
  });
});

describe('estimateMessagesTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('sums content tokens plus per-message overhead', () => {
    // Each message gets +4 for role/framing overhead.
    const msgs = [
      { role: 'user', content: 'hi' }, // ceil(2/4)=1 + 4 = 5
      { role: 'assistant', content: 'hello' }, // ceil(5/4)=2 + 4 = 6
    ];
    expect(estimateMessagesTokens(msgs)).toBe(11);
  });

  it('includes reasoning when present', () => {
    const withReasoning = [
      { role: 'assistant', content: 'hi', reasoning: 'thinking about it' },
    ];
    const withoutReasoning = [{ role: 'assistant', content: 'hi' }];
    expect(estimateMessagesTokens(withReasoning)).toBeGreaterThan(
      estimateMessagesTokens(withoutReasoning)
    );
  });

  it('ignores missing reasoning silently', () => {
    // reasoning: undefined should not throw
    expect(() =>
      estimateMessagesTokens([{ role: 'user', content: 'x' }])
    ).not.toThrow();
  });

  it('is sensitive to content length (not just count)', () => {
    const short = estimateMessagesTokens([{ role: 'user', content: 'a' }]);
    const long = estimateMessagesTokens([
      { role: 'user', content: 'a'.repeat(4000) },
    ]);
    expect(long).toBeGreaterThan(short * 100);
  });
});
