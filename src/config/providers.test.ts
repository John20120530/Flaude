import { describe, it, expect } from 'vitest';
import { isThinkingVariant, REASONER_PAIRS } from './providers';

describe('isThinkingVariant', () => {
  // The whole point of v0.1.53's introduction of this helper: distinguish
  // "this id is the thinking-mode side of a reasoner pair" (used by
  // Composer's 「思考」 toggle to draw the ON pill) from "this model is
  // good at reasoning" (used by TopBar's 推理 marketing badge). Conflating
  // the two stuck the toggle on for Opus/Sonnet 4.6 — `capabilities.
  // reasoning = true` on both sides of the pair.
  it('returns true for Anthropic -thinking suffixed ids', () => {
    expect(isThinkingVariant('pa/claude-sonnet-4-6-thinking')).toBe(true);
    expect(isThinkingVariant('pa/claude-opus-4-6-thinking')).toBe(true);
  });

  it('returns true for the DeepSeek reasoner alias', () => {
    expect(isThinkingVariant('deepseek-reasoner')).toBe(true);
  });

  it('returns false for the non-thinking sides of the same pairs', () => {
    expect(isThinkingVariant('pa/claude-sonnet-4-6')).toBe(false);
    expect(isThinkingVariant('pa/claude-opus-4-6')).toBe(false);
    expect(isThinkingVariant('deepseek-chat')).toBe(false);
  });

  it('returns false for empty / unknown ids', () => {
    expect(isThinkingVariant('')).toBe(false);
    expect(isThinkingVariant('qwen3-vl-plus')).toBe(false);
    expect(isThinkingVariant('moonshot-v1-32k')).toBe(false);
  });

  it('every REASONER_PAIRS key/value where it should be ON is detected', () => {
    // Sanity check: every paired id we expose in the catalog should be
    // classifiable in EXACTLY one direction. The "OFF" side and the "ON"
    // side together form the pair; flipping one to the other (which is
    // what the toggle does) MUST move isThinkingVariant from false → true
    // or vice versa, never stay the same — otherwise the toggle visually
    // doesn't change and the user sees "stuck".
    for (const [a, b] of Object.entries(REASONER_PAIRS)) {
      expect(isThinkingVariant(a)).not.toBe(isThinkingVariant(b));
    }
  });
});
