/**
 * Client wrapper for the Worker's `/api/skills/search` federated search.
 *
 * The Worker hits GitHub Code Search, filters by license (MIT/Apache only)
 * and frontmatter validity, and returns up to 20 results in a shape
 * compatible with `SkillsMarketEntry` so the existing `SkillsMarketSection`
 * card UI renders both static-curated and search-result entries uniformly.
 *
 * Caching: the Worker caches per-query for 1h via the Cloudflare Cache API.
 * On the client we additionally short-circuit duplicate queries during a
 * single typing session (50ms debounce in the UI; this module is stateless).
 */

import { authGetJson } from './flaudeApi';
import type { SkillsMarketEntry } from '@/config/skillsMarket';

interface SearchResponse {
  query: string;
  results: SkillsMarketEntry[];
  fromCache: boolean;
}

/**
 * Federated search across GitHub for SKILL.md files matching `q`.
 *
 * Throws on network / 5xx upstream failure (caller decides whether to fall
 * back to the static manifest or surface the error). Empty `q` returns
 * `{results: []}` without making a network call.
 */
export async function searchSkillsMarket(q: string): Promise<{
  results: SkillsMarketEntry[];
  fromCache: boolean;
}> {
  const trimmed = q.trim();
  if (!trimmed) return { results: [], fromCache: false };

  const url = `/api/skills/search?q=${encodeURIComponent(trimmed)}`;
  const body = await authGetJson<SearchResponse>(url);
  return {
    results: body.results ?? [],
    fromCache: body.fromCache ?? false,
  };
}
