/**
 * Cross-mode conversation search.
 *
 * Strategy: plain case-insensitive substring match. We don't do fuzzy / fts
 * because:
 *   - Corpus is small (100s of conversations × ~50 messages) — linear scan is
 *     trivially fast (<10ms).
 *   - Users type what they remember literally; fuzzy matches surprise them.
 *   - No index = no stale-index bugs when messages update mid-stream.
 *
 * Scoring: title match ≫ message match ≫ recency tiebreaker. At most one hit
 * per conversation (we don't flood the result list with 20 matches from the
 * same long conversation — the first match leads the user into it).
 */

import type { Conversation } from '@/types';

export interface SearchHit {
  conversation: Conversation;
  /** Which message matched. Undefined when the title matched. */
  messageId?: string;
  messageRole?: 'user' | 'assistant' | 'system' | 'tool';
  /** Text around the match, trimmed with ellipses. */
  snippet: string;
  /** Character offsets inside `snippet` that should be highlighted. */
  highlight: { start: number; end: number };
  /** Higher = better. Callers sort descending. */
  score: number;
}

// Asymmetric radius: keep the match near the START of the snippet so it stays
// visible even if CSS clamps to 2 lines. A bit of context before helps users
// locate the match in a sentence; plenty of context after completes the
// surrounding thought.
const SNIPPET_BEFORE = 14;
const SNIPPET_AFTER = 80;

/**
 * Search across all conversations. Returns up to `limit` hits, sorted by
 * relevance. Empty query returns []. The `query` is lowercased once; matching
 * is plain substring.
 */
export function searchConversations(
  conversations: Conversation[],
  query: string,
  limit = 50
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: SearchHit[] = [];

  for (const c of conversations) {
    // 1) Title match wins big — cap at one result per conv.
    const titleIdx = c.title.toLowerCase().indexOf(q);
    if (titleIdx >= 0) {
      hits.push({
        conversation: c,
        snippet: c.title,
        highlight: { start: titleIdx, end: titleIdx + q.length },
        score: 1000 + normalizeTime(c.updatedAt),
      });
      continue;
    }

    // 2) Else scan messages; first match provides the snippet. We intentionally
    //    don't merge multiple hits from one conv — it's noisy in a sidebar.
    for (const m of c.messages) {
      // Search `content`; skip tool-role messages (JSON dumps blow up snippets)
      // but still surface user/assistant text. `reasoning` searched too since
      // some models put substance there.
      if (m.role === 'tool') continue;
      const haystacks: string[] = [m.content];
      if (m.reasoning) haystacks.push(m.reasoning);

      let matched: { text: string; idx: number } | null = null;
      for (const h of haystacks) {
        const idx = h.toLowerCase().indexOf(q);
        if (idx >= 0) {
          matched = { text: h, idx };
          break;
        }
      }
      if (!matched) continue;

      const { snippet, highlightStart } = extractSnippet(matched.text, matched.idx, q.length);
      hits.push({
        conversation: c,
        messageId: m.id,
        messageRole: m.role,
        snippet,
        highlight: { start: highlightStart, end: highlightStart + q.length },
        score: 100 + normalizeTime(c.updatedAt),
      });
      break;
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Pull a readable window around the match. Uses asymmetric radii so the match
 * is near the start of the snippet (visible inside a 2-line clamp). Reports
 * the highlight offset inside the returned snippet.
 */
export function extractSnippet(
  text: string,
  matchIdx: number,
  matchLen: number
): { snippet: string; highlightStart: number } {
  const rawStart = Math.max(0, matchIdx - SNIPPET_BEFORE);
  const rawEnd = Math.min(text.length, matchIdx + matchLen + SNIPPET_AFTER);

  // Extract three regions by direct indexing — never lose the match by
  // regex-chewing across its span.
  const rawBefore = text.slice(rawStart, matchIdx);
  const rawMatch = text.slice(matchIdx, matchIdx + matchLen);
  const rawAfter = text.slice(matchIdx + matchLen, rawEnd);

  // Collapse whitespace for readability. `trimStart` on `before` avoids a
  // snippet that begins with "  …" when the match is near the left cutoff.
  const before = rawBefore.replace(/\s+/g, ' ').trimStart();
  const after = rawAfter.replace(/\s+/g, ' ');

  let snippet = before + rawMatch + after;
  let highlightStart = before.length;

  if (rawStart > 0) {
    snippet = '…' + snippet;
    highlightStart += 1;
  }
  if (rawEnd < text.length) {
    snippet = snippet + '…';
  }
  return { snippet, highlightStart };
}

/**
 * Map an epoch ms into [0, 1) so it serves as a stable tiebreaker inside a
 * fixed score band without ever flipping the band order.
 */
function normalizeTime(ms: number): number {
  // 2^53 safely covers ms up to year ~285K, but we only need relative order.
  return ms / 1e14;
}
