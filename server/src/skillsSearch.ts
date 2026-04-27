/**
 * Skills marketplace federated search.
 *
 * The static `SKILLS_MARKET` manifest in the client (8 curated entries)
 * gives users an immediate "推荐" baseline, but doesn't grow without a
 * Flaude release. This endpoint gives the user a search box that hits
 * GitHub directly and returns matching SKILL.md files with strict
 * license filtering — so Flaude can install something the day someone
 * publishes it.
 *
 * Why GitHub Code Search and not the 5 platforms (SkillsMP / claudeskills.info /
 * Skills Directory / awesome lists / etc.)? They're all aggregators on top of
 * GitHub. Searching GitHub directly is the union of what they index, minus
 * the moderation layer they each add — which we replace with a strict MIT/
 * Apache license filter (per the user's choice when scoping this feature).
 *
 * Flow per cache miss:
 *   1. GET /search/code?q=<user>+filename:SKILL.md+language:Markdown   (1 req)
 *   2. For each hit (up to 30), in parallel:
 *      a. /repos/{owner}/{repo}/license  → spdx_id check
 *      b. raw.githubusercontent.com/.../<path>  → frontmatter peek
 *   3. Drop hits that fail license whitelist OR fail to parse frontmatter
 *      OR have an empty name/description (the SKILL.md spec requires both,
 *      so a missing one means the file isn't actually a Flaude-compatible
 *      skill).
 *   4. Return up to 20 in the order GitHub gave us (best-match).
 *
 * Cache: Cloudflare Cache API, 1h TTL, key = canonical URL (?q=...). With
 * 30+ unique queries per hour the GitHub call rate stays under the
 * authenticated-PAT limit (5000/h) by an order of magnitude.
 *
 * Auth: requireAuth — same as every other Flaude endpoint. Anonymous
 * search would let anyone burn our shared GITHUB_TOKEN quota.
 *
 * Anthropic-published skills are filtered out by repo path: the LICENSE
 * is "Other / Proprietary" so the spdx_id check already drops them, but
 * we also explicitly skip `anthropics/skills` as belt-and-suspenders.
 */
import { Hono } from 'hono';

import type { AppContext } from './env';
import { requireAuth } from './middleware';

const skillsSearch = new Hono<AppContext>();

skillsSearch.use('/api/skills/search', requireAuth);

// Strict license whitelist. The user explicitly scoped this to MIT + Apache
// when picking the federated-search design — no BSD, no LGPL, no "Other".
const ALLOWED_SPDX = new Set(['MIT', 'Apache-2.0']);

// Hard cap on what we return to the client. Anything more is noise — the UI
// is a vertical list and beyond ~20 the user is going to refine the query.
const MAX_RESULTS = 20;

// How many GitHub hits to consider before license/frontmatter filtering.
// Some hits will be filtered out (proprietary license, malformed
// frontmatter), so we ask for more than we plan to return.
const SEARCH_FETCH_LIMIT = 30;

// Cache TTL. 1h is a reasonable balance: skill repos don't change minute-
// to-minute, but a popular new skill should surface within an hour of
// publication for users who haven't seen it before.
const CACHE_TTL_S = 3600;

// Per-request safety: if a single GitHub call hangs, abort it so the whole
// endpoint doesn't pin the Worker isolate. 8s × 2 phases (search + parallel
// per-result) = 16s worst case end-to-end.
const UPSTREAM_TIMEOUT_MS = 8_000;

// Repos we explicitly never return. Currently just Anthropic's official
// skills — proprietary license forbids redistribution. Belt-and-suspenders
// since the spdx check already drops them.
const REPO_BLOCKLIST = new Set(['anthropics/skills']);

interface SkillSearchResult {
  id: string;
  title: string;
  description: string;
  publisher: string;
  publisherUrl: string;
  source: string;
  sourceUrl: string;
  rawUrl: string;
  license: string;
  modes: string[];
  tags: string[];
}

interface SearchResponse {
  query: string;
  results: SkillSearchResult[];
  fromCache: boolean;
}

interface GitHubCodeSearchItem {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: {
    full_name?: string;
    name?: string;
    html_url?: string;
    owner?: { login?: string };
    default_branch?: string;
  };
}

interface GitHubCodeSearchResponse {
  total_count?: number;
  items?: GitHubCodeSearchItem[];
}

interface GitHubLicenseResponse {
  license?: {
    spdx_id?: string;
    name?: string;
  } | null;
}

skillsSearch.get('/api/skills/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) {
    return c.json<SearchResponse>({ query: '', results: [], fromCache: false });
  }
  // Reject pathologically long queries — protect against URL-blowup attacks.
  if (q.length > 200) {
    return c.json({ error: 'query too long (max 200 chars)' }, 400);
  }

  // Cache lookup — by canonical URL with only the q param so different auth
  // tokens share the same cached result. We construct a fresh Request object
  // (not c.req.raw) because the original carries an Authorization header,
  // which would normally make the response uncacheable.
  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = `q=${encodeURIComponent(q)}`;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    // Fast path: cache hit. We mark fromCache=true for diagnostics by
    // re-constructing the body. Cheap — already JSON in cache.
    const body = (await cached.json()) as SearchResponse;
    return c.json({ ...body, fromCache: true });
  }

  // Cache miss — do the real work.
  let results: SkillSearchResult[];
  try {
    results = await searchGitHub(q, c.env.GITHUB_TOKEN);
  } catch (err) {
    console.error('skills/search failed', { q, err });
    return c.json(
      { error: `GitHub upstream failed: ${(err as Error).message}` },
      502,
    );
  }

  const responseBody: SearchResponse = {
    query: q,
    results,
    fromCache: false,
  };

  // Cache for 1h. We construct an explicit Response with Cache-Control so
  // the Cloudflare cache backend respects our TTL. waitUntil so the cache
  // write doesn't block the user's response — the put can complete on a
  // best-effort basis after we've already replied.
  const cacheableResponse = new Response(JSON.stringify(responseBody), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_S}`,
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, cacheableResponse.clone()));

  return c.json(responseBody);
});

/**
 * Run the search → license-filter → frontmatter-peek pipeline. Pulled out
 * for testability — the route handler is mostly Hono boilerplate around
 * this. Kept network calls explicit so a test can mock global fetch.
 */
async function searchGitHub(
  q: string,
  token: string | undefined,
): Promise<SkillSearchResult[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'flaude-server/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const searchQ = `${q} filename:SKILL.md`;
  const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(searchQ)}&per_page=${SEARCH_FETCH_LIMIT}`;

  const searchRes = await fetchWithTimeout(searchUrl, { headers });
  if (!searchRes.ok) {
    const body = await searchRes.text().catch(() => '');
    throw new Error(`/search/code ${searchRes.status}: ${body.slice(0, 200)}`);
  }

  const searchData = (await searchRes.json()) as GitHubCodeSearchResponse;
  const items = searchData.items ?? [];

  // Resolve license + frontmatter for each hit in parallel. `Promise.all`
  // not `Promise.allSettled` because one failed inner fetch shouldn't
  // sink the whole search — we map errors to null inside the inner async
  // and filter later.
  const tasks = items.map((item) => resolveOne(item, headers));
  const resolved = await Promise.all(tasks);

  return resolved
    .filter((r): r is SkillSearchResult => r !== null)
    .slice(0, MAX_RESULTS);
}

async function resolveOne(
  item: GitHubCodeSearchItem,
  headers: Record<string, string>,
): Promise<SkillSearchResult | null> {
  const owner = item.repository?.owner?.login;
  const repoName = item.repository?.name;
  const fullName = item.repository?.full_name;
  const path = item.path;

  if (!owner || !repoName || !fullName || !path) return null;
  if (REPO_BLOCKLIST.has(fullName)) return null;

  const branch = item.repository?.default_branch || 'HEAD';

  try {
    const [licRes, mdRes] = await Promise.all([
      fetchWithTimeout(
        `https://api.github.com/repos/${owner}/${repoName}/license`,
        { headers },
      ),
      fetchWithTimeout(
        `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${path}`,
        // raw.githubusercontent doesn't accept the GitHub API auth header
        // form; it allows unauthenticated fetches and the 60/h IP limit
        // is per-user-IP, not Worker-IP. Skip auth here.
        {},
      ),
    ]);

    if (!licRes.ok || !mdRes.ok) return null;

    const lic = (await licRes.json()) as GitHubLicenseResponse;
    const spdx = lic.license?.spdx_id;
    if (!spdx || !ALLOWED_SPDX.has(spdx)) return null;

    const md = await mdRes.text();
    const fm = parseSkillFrontmatter(md);
    if (!fm.name || !fm.description) return null;

    return {
      id: `${fullName}:${path}`,
      title: fm.name,
      description: truncate(fm.description, 280),
      publisher: `@${owner}`,
      publisherUrl: `https://github.com/${owner}`,
      source: `${fullName} · GitHub`,
      sourceUrl: item.repository?.html_url ?? `https://github.com/${fullName}`,
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repoName}/${branch}/${path}`,
      license: spdx,
      modes: [],
      tags: ['github-search'],
    };
  } catch {
    // Per-result failure: ignore and let the other hits go through.
    return null;
  }
}

/**
 * Tiny YAML frontmatter parser — extracts name + description from the
 * `---`-delimited header of a SKILL.md file. Mirrors the client-side
 * parser in src/lib/skillsImport.ts (kept duplicated rather than shared
 * as a separate package, because the cross-server-client-package boundary
 * isn't worth introducing for ~50 lines of code).
 */
function parseSkillFrontmatter(md: string): {
  name?: string;
  description?: string;
} {
  const trimmed = md.replace(/^﻿/, '').replace(/^\s+/, '');
  if (!trimmed.startsWith('---')) return {};

  const m = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return {};
  const fmText = m[1] ?? '';

  const out: Record<string, string> = {};
  const lines = fmText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const km = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!km) {
      i++;
      continue;
    }
    const key = km[1]!;
    let rest = (km[2] ?? '').trim();

    // Block scalar — collect indented continuation lines.
    if (rest === '|' || rest === '|-' || rest === '>') {
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const bl = lines[i] ?? '';
        if (/^\s+/.test(bl) || bl === '') {
          collected.push(bl.replace(/^\s{0,2}/, ''));
          i++;
        } else {
          break;
        }
      }
      out[key] = collected.join('\n').replace(/\n+$/, '');
      continue;
    }

    // Strip surrounding quotes (single or double).
    if (rest.length >= 2) {
      const first = rest[0];
      const last = rest[rest.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        rest = rest.slice(1, -1);
      }
    }
    out[key] = rest;
    i++;
  }

  return { name: out.name?.trim(), description: out.description?.trim() };
}

/**
 * Truncate a string to at most `maxChars` user-visible characters,
 * appending `…` when shortened. Codepoint-safe: the spread operator
 * iterates the string by Unicode codepoint (combining surrogate pairs
 * into single elements), so we never split a 4-byte emoji or a Chinese
 * character represented as a UTF-16 surrogate pair. Plain `slice`
 * counts UTF-16 code units, which can leave an unpaired surrogate at
 * the cut and produce broken bytes in the JSON response.
 */
function truncate(s: string, maxChars: number): string {
  const chars = [...s];
  if (chars.length <= maxChars) return s;
  return chars.slice(0, maxChars - 1).join('').trimEnd() + '…';
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Visible-for-tests exports — let unit tests exercise the parser and the
// search pipeline against fake fetch implementations without going through
// the Hono router.
export const __test = {
  parseSkillFrontmatter,
  truncate,
  searchGitHub,
};

export default skillsSearch;
