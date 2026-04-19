/**
 * Cheap, provider-agnostic token counting for threshold decisions.
 *
 * We don't ship a real tokenizer (tiktoken / sentencepiece) for two reasons:
 *   1. Bundle size — real BPE tables are 1–3 MB per model family, ballooning
 *      the app for a purely advisory number.
 *   2. We only need an estimate to decide "should we auto-summarize before
 *      sending?" — off by ±20% is fine for that.
 *
 * Heuristic used:
 *   - CJK characters (Chinese / Japanese / Korean): ~1 character per token.
 *     BPE tokenizers for Chinese models typically emit one token per 1–2
 *     Han characters; being conservative (1 char = 1 token) keeps us on the
 *     safe side of the context window.
 *   - Everything else (Latin, punctuation, code, etc.): ~4 characters per
 *     token, the classic OpenAI rule of thumb.
 *
 * We count these separately and sum.
 */

/**
 * Estimate tokens for a single string. Always returns a positive integer.
 * Empty string → 0.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs + Hiragana + Katakana + Hangul ranges.
    // These are the most common ones; exotic supplements (e.g. CJK Ext-B)
    // aren't worth the extra check for an estimate.
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
      (code >= 0xac00 && code <= 0xd7af)    // Hangul Syllables
    ) {
      cjk++;
    } else {
      other++;
    }
  }

  // 1 token per CJK char + 1 token per 4 other chars (rounded up).
  return cjk + Math.ceil(other / 4);
}

/**
 * Estimate tokens for a conversation payload the way the API sees it —
 * roles, content, reasoning, attachments metadata. Attachments' image
 * data is NOT counted here: vision tokens are billed separately by most
 * providers and we don't want to inflate the estimate 10x.
 */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string; reasoning?: string }>
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content);
    if (m.reasoning) total += estimateTokens(m.reasoning);
    // Overhead for role tag, content wrapper, etc. ~4 tokens per message
    // is the figure OpenAI themselves quote for ChatML framing.
    total += 4;
  }
  return total;
}
