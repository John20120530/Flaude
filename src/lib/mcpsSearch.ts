/**
 * Client wrapper for the Worker's `/api/mcps/search` federated MCP search.
 *
 * The Worker hits 5 sources (PulseMCP, Glama, npm registry, GitHub Code
 * Search, plus a direct probe for known official `@modelcontextprotocol/*`
 * packages), dedupes by canonical id, classifies each result into a trust
 * tier (official / popular / unaudited), and returns up to 30 ranked.
 *
 * The client uses these for the search-box flow inside `McpMarketSection`:
 *   - Empty query → static `MCP_MARKET` baseline (6 curated entries)
 *   - Typed query → 350ms debounce → fetch → render with trust badges
 *
 * Install gate by trust tier (UX, not server-enforced):
 *   - 🟢 official    : one-click install, no checkbox
 *   - 🟡 popular     : install button enabled but expandable details
 *                      panel auto-shows command + signals
 *   - 🔴 unaudited   : install button disabled until user checks
 *                      "I understand this runs <author>'s code on my
 *                      machine"
 *
 * The trust tier itself is computed server-side; we just translate it to
 * UI affordances here.
 */

import { authGetJson } from './flaudeApi';

// =============================================================================
// Wire types — must stay in sync with `server/src/mcpsSearch.ts`
// =============================================================================

export type TrustTier = 'official' | 'popular' | 'unaudited';
export type EndpointType = 'http' | 'stdio-tauri' | 'stdio-instructions';

export interface McpSearchResult {
  id: string;
  title: string;
  description: string;
  publisher: string;
  publisherUrl?: string;
  sources: Array<'pulsemcp' | 'glama' | 'npm' | 'github'>;
  sourceUrls: {
    pulsemcp?: string;
    glama?: string;
    npm?: string;
    github?: string;
  };

  endpointType: EndpointType;
  endpointUrl?: string;
  stdioCommand?: {
    command: string;
    args: string[];
    envKeys?: string[];
  };
  installInstructions?: string;

  trustTier: TrustTier;
  signals: {
    npmWeeklyDownloads?: number;
    githubStars?: number;
    isOfficialPublisher: boolean;
    license?: string;
    lastUpdate?: string;
  };

  tags: string[];
}

export interface McpSearchResponse {
  query: string;
  results: McpSearchResult[];
  fromCache: boolean;
  sourceCounts: Record<'pulsemcp' | 'glama' | 'npm' | 'github', number>;
}

/**
 * Federated search across PulseMCP / Glama / npm / GitHub for MCP servers
 * matching `q`. Empty `q` returns `{results: []}` without making a network
 * call (UI shows the static manifest as the empty-state baseline instead).
 */
export async function searchMcpsMarket(q: string): Promise<{
  results: McpSearchResult[];
  fromCache: boolean;
  sourceCounts?: McpSearchResponse['sourceCounts'];
}> {
  const trimmed = q.trim();
  if (!trimmed) {
    return { results: [], fromCache: false };
  }

  const url = `/api/mcps/search?q=${encodeURIComponent(trimmed)}`;
  const body = await authGetJson<McpSearchResponse>(url);
  return {
    results: body.results ?? [],
    fromCache: body.fromCache ?? false,
    sourceCounts: body.sourceCounts,
  };
}
