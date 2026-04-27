/**
 * MCP marketplace federated search.
 *
 * The static `MCP_MARKET` manifest in the client (6 curated entries — Echo
 * demo + 5 modelcontextprotocol/* stdio servers) gave users an immediate
 * baseline. This endpoint adds a search box that hits four MCP discovery
 * platforms and merges results into a unified, dedup'd list with trust
 * tiers so users can pick what to install.
 *
 * **Critical safety difference from Skills marketplace**: a Skill is text
 * that gets injected into a prompt — the worst it can do is suggest bad
 * code. An MCP server runs as a child process on the user's machine
 * (stdio MCPs) or sends arbitrary network requests on their behalf (HTTP
 * MCPs). One-click installing an arbitrary search result = handing your
 * machine to whoever wrote the package. Per the user-agreed design we
 * mitigate by:
 *   - Trust tiers (official / popular / unaudited) shown as badges
 *   - For 🔴 unaudited, the client requires an explicit "I understand"
 *     checkbox before install. (Server-side returns the trust tier in
 *     the result; UI gates accordingly.)
 *   - License is informational, not a filter — many quality MCP
 *     repositories have no LICENSE file but the npm package itself is
 *     MIT. License-strictness here would block too many legitimate
 *     servers; trust tier is the better gate.
 *
 * Sources federated (4):
 *   1. **PulseMCP** — `api.pulsemcp.com/v0beta/servers?query=` — public
 *      REST, ~13k servers indexed. Best for github_stars, package
 *      registry/name/downloads, and HTTP `remotes` URLs.
 *   2. **Glama** — `glama.ai/api/mcp/v1/servers?query=` — public, ~22k
 *      servers, biggest index. Best for spdxLicense + envVars schema.
 *   3. **npm registry** — `registry.npmjs.org/-/v1/search?text=...` —
 *      direct npm search filtered to MCP keywords. Has weekly download
 *      counts, license, repo URL, last publish date in one response.
 *   4. **GitHub Code Search** — `topic:mcp-server` repositories
 *      matching the keyword. Wider net for unindexed servers + native
 *      stargazer count.
 *
 * **Tools list preview** is deliberately NOT done in v1 (per user
 * decision). Glama exposes a `tools[]` field but it's empirically empty
 * for ~95% of entries; PulseMCP has no per-server detail endpoint at
 * all. Honest "unknown" beats a falsely-empty preview. v2 candidate:
 * sandbox-based real `tools/list` probe.
 *
 * Skipped sources:
 *   - **Smithery** — requires API key auth, unsuitable for the
 *     federated-search backend. Their hosted-server install path is
 *     also OAuth-flavored which we'd need to wire up separately.
 *   - **mcp.so** — no public search API found.
 *   - **McpMux / MCP Market** — smaller, fully covered by the four
 *     above.
 *
 * Caching: Cloudflare Cache API, 1h TTL, key = canonical URL with only
 * the `q` parameter so all authed users share the same cached result.
 *
 * Auth: requireAuth so anonymous abuse can't drain the GITHUB_TOKEN
 * quota or the (unauthenticated but rate-limited) PulseMCP / Glama / npm
 * endpoints.
 */
import { Hono } from 'hono';

import type { AppContext } from './env';
import { requireAuth } from './middleware';

const mcpsSearch = new Hono<AppContext>();

mcpsSearch.use('/api/mcps/search', requireAuth);

// Hard caps to bound worst-case work. With 4 adapters × 30 results = 120
// per-source items max, dedup to ~50-80 unique, return up to 30. Beyond
// that the UI is unwieldy and the user is going to refine the query.
const PER_SOURCE_LIMIT = 30;
const MAX_RESULTS = 30;

const CACHE_TTL_S = 3600;
const UPSTREAM_TIMEOUT_MS = 10_000;

// Trust tier thresholds — these are the heuristics we use to decide
// whether to surface a 🟢/🟡/🔴 badge and whether the client should
// require a confirmation checkbox before install. Numbers picked from
// looking at the npm popularity distribution for `keywords:mcp-server`:
// ~50 packages have ≥1000 weekly downloads (the "popular" cliff),
// ~5 have ≥10000 (the head). 1000 is a meaningful "real users" floor
// without being so high it excludes credible-but-niche servers.
const POPULAR_DOWNLOADS_THRESHOLD = 1000;
const POPULAR_STARS_THRESHOLD = 500;

// Publishers we treat as 🟢 official without further vetting. Matched
// against the npm package name prefix (slash-terminated for safety —
// `@anthropic` would otherwise also match `@anthropicfake`).
const OFFICIAL_NPM_PREFIXES = [
  '@modelcontextprotocol/',
  '@anthropic-ai/',
  '@anthropic/',
];

// And the source-of-truth GitHub repo for the official server set.
// Anyone publishing under `modelcontextprotocol/servers` is also 🟢.
const OFFICIAL_GITHUB_REPOS = new Set(['modelcontextprotocol/servers']);

// Hardcoded list of well-known `@modelcontextprotocol/*` packages. None of
// the four search engines (PulseMCP / Glama / npm / GitHub) reliably surface
// these on page 1 for keyword queries — npm ranks `mongodb-memory-server`
// way above `@modelcontextprotocol/server-memory` for "memory" because of
// download count, and the registries don't fix the ordering. So we
// stem-match the query against this list and probe matching packages
// directly to GUARANTEE they show up when relevant.
//
// Maintenance: bump this list when Anthropic publishes new servers. ~10
// minute job, can be automated v2 by walking npm scope `@modelcontextprotocol`
// once per day. Today the list is short enough to manage by hand.
const OFFICIAL_MCP_PACKAGES = [
  '@modelcontextprotocol/server-memory',
  '@modelcontextprotocol/server-filesystem',
  '@modelcontextprotocol/server-github',
  '@modelcontextprotocol/server-gitlab',
  '@modelcontextprotocol/server-slack',
  '@modelcontextprotocol/server-postgres',
  '@modelcontextprotocol/server-sqlite',
  '@modelcontextprotocol/server-gdrive',
  '@modelcontextprotocol/server-google-maps',
  '@modelcontextprotocol/server-time',
  '@modelcontextprotocol/server-fetch',
  '@modelcontextprotocol/server-everart',
  '@modelcontextprotocol/server-aws-kb-retrieval',
  '@modelcontextprotocol/server-brave-search',
  '@modelcontextprotocol/server-everything',
  '@modelcontextprotocol/server-puppeteer',
  '@modelcontextprotocol/server-git',
  '@modelcontextprotocol/server-sentry',
  '@modelcontextprotocol/server-redis',
  '@modelcontextprotocol/server-sequentialthinking',
  '@modelcontextprotocol/server-pdf',
] as const;

export type TrustTier = 'official' | 'popular' | 'unaudited';
export type EndpointType = 'http' | 'stdio-tauri' | 'stdio-instructions';

export interface McpSearchResult {
  /** Canonical id for dedup: `npm:<pkg>` or `gh:<owner>/<repo>`. */
  id: string;
  title: string;
  description: string;
  publisher: string;
  publisherUrl?: string;
  /** Which adapters returned this entry. Useful for "found in N of 4 sources" UI hints. */
  sources: Array<'pulsemcp' | 'glama' | 'npm' | 'github'>;
  /** Per-source URLs to view this MCP on its source site. */
  sourceUrls: {
    pulsemcp?: string;
    glama?: string;
    npm?: string;
    github?: string;
  };

  endpointType: EndpointType;
  /** For `endpointType: 'http'`. */
  endpointUrl?: string;
  /** For `endpointType: 'stdio-tauri'` (i.e. Flaude can spawn it). */
  stdioCommand?: {
    command: string; // 'npx' | 'uvx' | etc.
    args: string[];
    /** env vars the user needs to provide (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`). */
    envKeys?: string[];
  };
  /** For `endpointType: 'stdio-instructions'` (manual install). */
  installInstructions?: string;

  trustTier: TrustTier;
  signals: {
    npmWeeklyDownloads?: number;
    githubStars?: number;
    isOfficialPublisher: boolean;
    license?: string;
    lastUpdate?: string; // ISO date
  };

  tags: string[];
}

interface SearchResponse {
  query: string;
  results: McpSearchResult[];
  fromCache: boolean;
  /** How many entries each adapter contributed before dedup — useful for ops dashboards. */
  sourceCounts: Record<'pulsemcp' | 'glama' | 'npm' | 'github', number>;
}

mcpsSearch.get('/api/mcps/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) {
    return c.json<SearchResponse>({
      query: '',
      results: [],
      fromCache: false,
      sourceCounts: { pulsemcp: 0, glama: 0, npm: 0, github: 0 },
    });
  }
  if (q.length > 200) {
    return c.json({ error: 'query too long (max 200 chars)' }, 400);
  }

  // Cache key: canonical URL with only `q`. Auth header is intentionally
  // NOT part of the key — we want all authenticated users to share cache
  // hits.
  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = `q=${encodeURIComponent(q)}`;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = (await cached.json()) as SearchResponse;
    return c.json({ ...body, fromCache: true });
  }

  const ghToken = c.env.GITHUB_TOKEN;

  const [pulse, glama, npmResults, github, official] = await Promise.allSettled([
    searchPulseMCP(q),
    searchGlama(q),
    searchNpm(q),
    searchGitHub(q, ghToken),
    searchOfficialMcpPackages(q),
  ]);

  // Per-source debug info. Using allSettled so one slow/broken upstream
  // doesn't sink the rest. Failed adapters log + contribute 0 entries.
  // Note: official-direct entries are tagged source='npm' since they
  // come straight from the npm registry; we just discover them via stem
  // matching rather than full-text search.
  const officialResults = settledOrEmpty(official, 'official-direct');
  const buckets = {
    pulsemcp: settledOrEmpty(pulse, 'pulsemcp'),
    glama: settledOrEmpty(glama, 'glama'),
    npm: [...settledOrEmpty(npmResults, 'npm'), ...officialResults],
    github: settledOrEmpty(github, 'github'),
  };

  const sourceCounts = {
    pulsemcp: buckets.pulsemcp.length,
    glama: buckets.glama.length,
    npm: buckets.npm.length,
    github: buckets.github.length,
  };

  const merged = mergeAndScore(buckets);
  const ranked = rankResults(merged, q).slice(0, MAX_RESULTS);

  const responseBody: SearchResponse = {
    query: q,
    results: ranked,
    fromCache: false,
    sourceCounts,
  };

  const cacheableResponse = new Response(JSON.stringify(responseBody), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_S}`,
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, cacheableResponse.clone()));

  return c.json(responseBody);
});

function settledOrEmpty<T>(
  result: PromiseSettledResult<T[]>,
  source: string,
): T[] {
  if (result.status === 'fulfilled') return result.value;
  console.error(`mcps/search adapter "${source}" failed:`, result.reason);
  return [];
}

// =============================================================================
// Adapters — each returns a list of partial results with canonical id.
// =============================================================================

interface PartialResult {
  id: string;
  title: string;
  description: string;
  publisher: string;
  publisherUrl: string | undefined;
  source: 'pulsemcp' | 'glama' | 'npm' | 'github';
  sourceUrl: string;

  // Install info (any source can fill these; merger picks best). All
  // optional via `| undefined` rather than `?` so TS doesn't widen the
  // mapped object type when an adapter returns concrete strings.
  npmPackageName?: string;
  endpointUrl?: string; // for HTTP MCPs
  envKeys?: string[];
  installInstructionsHint?: string;

  // Trust signals.
  npmWeeklyDownloads?: number;
  githubStars?: number;
  license?: string;
  lastUpdate?: string;
  githubFullName?: string;
}

interface PulseServer {
  name?: string;
  url?: string;
  external_url?: string | null;
  short_description?: string;
  source_code_url?: string | null;
  github_stars?: number | null;
  package_registry?: string | null;
  package_name?: string | null;
  package_download_count?: number | null;
  remotes?: Array<{
    url_direct?: string | null;
    transport?: string;
    authentication_method?: string;
  }>;
}

async function searchPulseMCP(q: string): Promise<PartialResult[]> {
  const url = `https://api.pulsemcp.com/v0beta/servers?query=${encodeURIComponent(q)}&count_per_page=${PER_SOURCE_LIMIT}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'flaude-server/1.0',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`pulsemcp ${res.status}`);
  }
  const data = (await res.json()) as { servers?: PulseServer[] };
  const servers = data.servers ?? [];

  return servers
    .map((s): PartialResult | null => {
      const ghPath = parseGitHubPath(s.source_code_url ?? '');
      const id = canonicalIdFrom({
        npmPackageName: s.package_name ?? undefined,
        githubFullName: ghPath ?? undefined,
      });
      if (!id) return null;

      // First HTTP/SSE remote (if any) → endpointUrl. We prefer ones
      // without auth requirements but the client UI surfaces auth needs
      // separately, so for v1 we just take the first.
      const remote = (s.remotes ?? []).find(
        (r) => r.url_direct && (r.transport === 'sse' || r.transport === 'http' || r.transport === 'streamable-http'),
      );

      return {
        id,
        title: s.name?.trim() || ghPath || s.package_name || 'Unknown',
        description: s.short_description?.trim() || '',
        publisher: ghPath?.split('/')[0] ?? '',
        publisherUrl: ghPath ? `https://github.com/${ghPath.split('/')[0]}` : undefined,
        source: 'pulsemcp',
        sourceUrl: s.url ?? '',
        npmPackageName: s.package_name ?? undefined,
        endpointUrl: remote?.url_direct ?? undefined,
        npmWeeklyDownloads:
          s.package_download_count != null
            ? Math.round(s.package_download_count / 4) // pulsemcp gives monthly-ish; approximate weekly
            : undefined,
        githubStars: s.github_stars ?? undefined,
        githubFullName: ghPath ?? undefined,
      };
    })
    .filter((r): r is PartialResult => r !== null);
}

interface GlamaServer {
  id?: string;
  name?: string;
  namespace?: string;
  description?: string;
  repository?: { url?: string } | null;
  slug?: string;
  spdxLicense?: { name?: string } | null;
  url?: string;
  attributes?: string[];
  environmentVariablesJsonSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  } | null;
}

async function searchGlama(q: string): Promise<PartialResult[]> {
  const url = `https://glama.ai/api/mcp/v1/servers?query=${encodeURIComponent(q)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'flaude-server/1.0',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`glama ${res.status}`);
  }
  const data = (await res.json()) as { servers?: GlamaServer[] };
  const servers = (data.servers ?? []).slice(0, PER_SOURCE_LIMIT);

  return servers
    .map((s): PartialResult | null => {
      const ghPath = parseGitHubPath(s.repository?.url ?? '');
      // Glama doesn't directly tell us the npm package name; we'd need
      // to fetch their detail endpoint. For dedup to work we need to
      // share a canonical id with PulseMCP/npm — which means we have
      // to use github path here. Acceptable: 90% of MCPs have a github
      // repo even if they're also on npm.
      const id = canonicalIdFrom({
        githubFullName: ghPath ?? undefined,
      });
      if (!id) return null;

      const envKeys = s.environmentVariablesJsonSchema?.properties
        ? Object.keys(s.environmentVariablesJsonSchema.properties)
        : undefined;

      return {
        id,
        title: s.name?.trim() || s.slug || 'Unknown',
        description: s.description?.trim() || '',
        publisher: s.namespace ?? ghPath?.split('/')[0] ?? '',
        publisherUrl: s.namespace ? `https://github.com/${s.namespace}` : undefined,
        source: 'glama',
        sourceUrl: s.url ?? '',
        envKeys: envKeys && envKeys.length > 0 ? envKeys : undefined,
        license: s.spdxLicense?.name?.replace(/ License$/i, '') ?? undefined,
        githubFullName: ghPath ?? undefined,
      };
    })
    .filter((r): r is PartialResult => r !== null);
}

interface NpmSearchObject {
  package?: {
    name?: string;
    description?: string;
    version?: string;
    keywords?: string[];
    publisher?: { username?: string };
    license?: string;
    date?: string;
    links?: {
      homepage?: string;
      repository?: string;
      npm?: string;
    };
  };
  downloads?: { weekly?: number; monthly?: number };
}

async function searchNpm(q: string): Promise<PartialResult[]> {
  // We hit npm twice and union the results:
  //   1. `<q> keywords:mcp` — high-precision: catches community packages
  //      that bothered to tag themselves correctly (most do).
  //   2. `<q>` plain — broader; catches official `@modelcontextprotocol/*`
  //      packages which empirically have NO `keywords` field at all.
  //      We post-filter to entries whose name or description mentions
  //      `mcp`, OR are in our official scopes — drops generic noise like
  //      `mongodb-memory-server-core` while keeping legit MCP servers.
  const taggedUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`${q} keywords:mcp`)}&size=${PER_SOURCE_LIMIT}`;
  const broadUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=${PER_SOURCE_LIMIT}`;
  const headers = {
    'User-Agent': 'flaude-server/1.0',
    Accept: 'application/json',
  };

  const [taggedRes, broadRes] = await Promise.all([
    fetchWithTimeout(taggedUrl, { headers }),
    fetchWithTimeout(broadUrl, { headers }),
  ]);
  if (!taggedRes.ok) throw new Error(`npm tagged ${taggedRes.status}`);
  if (!broadRes.ok) throw new Error(`npm broad ${broadRes.status}`);

  const taggedData = (await taggedRes.json()) as { objects?: NpmSearchObject[] };
  const broadData = (await broadRes.json()) as { objects?: NpmSearchObject[] };

  // Filter the broad results: keep only entries whose name or description
  // includes "mcp" (case-insensitive) OR is in an official scope. This
  // drops `mongodb-memory-server-core` and similar generic noise.
  const broadFiltered = (broadData.objects ?? []).filter((o) => {
    const name = o.package?.name ?? '';
    const desc = (o.package?.description ?? '').toLowerCase();
    if (OFFICIAL_NPM_PREFIXES.some((p) => name.startsWith(p))) return true;
    if (/\bmcp\b/i.test(name) || /\bmcp\b/i.test(desc)) return true;
    return false;
  });

  // Union by package name. Tagged results take precedence (they've shown
  // intent to be tagged as MCP).
  const seen = new Set<string>();
  const objects: NpmSearchObject[] = [];
  for (const o of [...(taggedData.objects ?? []), ...broadFiltered]) {
    const name = o.package?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    objects.push(o);
    if (objects.length >= PER_SOURCE_LIMIT) break;
  }

  return objects
    .map((o): PartialResult | null => {
      const pkg = o.package;
      if (!pkg?.name) return null;
      const ghPath = parseGitHubPath(pkg.links?.repository ?? pkg.links?.homepage ?? '');
      const id = canonicalIdFrom({
        npmPackageName: pkg.name,
        githubFullName: ghPath ?? undefined,
      });
      if (!id) return null;

      return {
        id,
        title: pkg.name,
        description: pkg.description?.trim() || '',
        publisher: pkg.publisher?.username ?? ghPath?.split('/')[0] ?? '',
        publisherUrl: pkg.publisher?.username
          ? `https://www.npmjs.com/~${pkg.publisher.username}`
          : undefined,
        source: 'npm',
        sourceUrl: pkg.links?.npm ?? `https://www.npmjs.com/package/${pkg.name}`,
        npmPackageName: pkg.name,
        npmWeeklyDownloads: o.downloads?.weekly,
        license: pkg.license,
        lastUpdate: pkg.date,
        githubFullName: ghPath ?? undefined,
      };
    })
    .filter((r): r is PartialResult => r !== null);
}

/**
 * 5th adapter: stem-match the query against `OFFICIAL_MCP_PACKAGES` and
 * directly probe matching packages from the npm registry. Bypasses
 * keyword search ranking which empirically buries the official ones
 * under generic-but-popular libraries (e.g. `mongodb-memory-server-core`
 * outranks `@modelcontextprotocol/server-memory` for query "memory" by
 * a factor of 50x).
 *
 * Cost: 0-3 npm fetches per query (most queries match 0 stems). Cached
 * by the parent endpoint's Cache API so repeats are free.
 */
async function searchOfficialMcpPackages(q: string): Promise<PartialResult[]> {
  // Tokenize query — match against the part of the package name after
  // `server-`, case-insensitive substring.
  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9-]/g, ''))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];

  // Match direction: token must be a substring of the stem. This catches
  // both "git" → server-git/github/gitlab and "github" → server-github.
  // The reverse direction (stem ⊂ token) is intentionally excluded to
  // avoid false positives like searching "github" matching server-git
  // (because "git" is a substring of "github").
  const candidates = OFFICIAL_MCP_PACKAGES.filter((pkg) => {
    const stem = (pkg.split('/')[1] ?? '').replace(/^server-/, '').toLowerCase();
    return tokens.some((t) => stem.includes(t));
  });
  if (candidates.length === 0) return [];

  const headers = {
    'User-Agent': 'flaude-server/1.0',
    Accept: 'application/json',
  };

  const fetched = await Promise.all(
    candidates.map(async (name): Promise<PartialResult | null> => {
      try {
        // npm registry tolerates literal `@` and `/` in the URL path —
        // they're not "reserved" components per RFC 3986 in this context.
        // Encoding `/` to %2F actually breaks some downstream proxies.
        // We DO need to be careful that `name` was statically-defined
        // (no user input) so this is safe — `OFFICIAL_MCP_PACKAGES` is
        // a hardcoded constant.
        const [pkgRes, dlRes] = await Promise.all([
          fetchWithTimeout(`https://registry.npmjs.org/${name}`, { headers }),
          fetchWithTimeout(
            `https://api.npmjs.org/downloads/point/last-week/${name}`,
            { headers },
          ),
        ]);
        if (!pkgRes.ok) return null;
        const pkg = (await pkgRes.json()) as {
          name?: string;
          description?: string;
          repository?: { url?: string };
          time?: Record<string, string>;
          'dist-tags'?: { latest?: string };
          license?: string;
        };
        const dl = dlRes.ok
          ? ((await dlRes.json()) as { downloads?: number })
          : null;

        const ghPath = parseGitHubPath(pkg.repository?.url ?? '');
        const id = canonicalIdFrom({
          npmPackageName: name,
          githubFullName: ghPath ?? undefined,
        });
        if (!id) return null;

        const latest = pkg['dist-tags']?.latest;
        const lastUpdate = latest ? pkg.time?.[latest] : undefined;

        return {
          id,
          title: name,
          description: (pkg.description ?? '').trim(),
          publisher: 'modelcontextprotocol',
          publisherUrl: 'https://github.com/modelcontextprotocol',
          // Tag as npm — the entry is from the npm registry, just
          // discovered via direct probe instead of search.
          source: 'npm',
          sourceUrl: `https://www.npmjs.com/package/${name}`,
          npmPackageName: name,
          npmWeeklyDownloads: dl?.downloads ?? undefined,
          license: pkg.license,
          lastUpdate,
          githubFullName: ghPath ?? undefined,
        };
      } catch {
        return null;
      }
    }),
  );

  return fetched.filter((r): r is PartialResult => r !== null);
}

interface GitHubRepoSearchItem {
  name?: string;
  full_name?: string;
  description?: string | null;
  html_url?: string;
  stargazers_count?: number;
  pushed_at?: string;
  license?: { spdx_id?: string | null } | null;
  owner?: { login?: string; html_url?: string };
}

async function searchGitHub(
  q: string,
  token: string | undefined,
): Promise<PartialResult[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'flaude-server/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Repository search rather than code search — we want the server's
  // repo as a unit, not individual files. The `topic:mcp-server` filter
  // catches ~70% of intentionally-published MCP servers; without it
  // generic "filesystem"/"memory" keywords dominate.
  const ghQ = `${q} topic:mcp-server`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(ghQ)}&per_page=${PER_SOURCE_LIMIT}`;

  const res = await fetchWithTimeout(url, { headers });
  if (!res.ok) {
    throw new Error(`github ${res.status}`);
  }
  const data = (await res.json()) as { items?: GitHubRepoSearchItem[] };
  const items = data.items ?? [];

  return items
    .map((it): PartialResult | null => {
      const fullName = it.full_name;
      if (!fullName) return null;
      const id = canonicalIdFrom({ githubFullName: fullName });
      if (!id) return null;

      return {
        id,
        title: it.name ?? fullName,
        description: it.description?.trim() || '',
        publisher: it.owner?.login ?? '',
        publisherUrl: it.owner?.html_url ?? undefined,
        source: 'github',
        sourceUrl: it.html_url ?? `https://github.com/${fullName}`,
        githubStars: it.stargazers_count ?? undefined,
        githubFullName: fullName,
        license: it.license?.spdx_id ?? undefined,
        lastUpdate: it.pushed_at ?? undefined,
        installInstructionsHint:
          'Source-only entry — see the repository README for install instructions.',
      };
    })
    .filter((r): r is PartialResult => r !== null);
}

// =============================================================================
// Merge & score
// =============================================================================

interface BucketSet {
  pulsemcp: PartialResult[];
  glama: PartialResult[];
  npm: PartialResult[];
  github: PartialResult[];
}

/**
 * Group all per-source partials by canonical id, picking richer fields
 * across sources, and emit unified `McpSearchResult`s.
 *
 * Priority for description: pulsemcp.short_description > glama.description
 * > npm.description > github.description. Hand-curated descriptions on
 * the registries beat npm's bare `description` field.
 *
 * Priority for npmWeeklyDownloads: npm > pulsemcp.package_download_count.
 * npm has it directly per-week; pulsemcp gives a monthly-ish number we
 * approximate by /4.
 */
function mergeAndScore(buckets: BucketSet): McpSearchResult[] {
  const groups = new Map<string, PartialResult[]>();
  const allParts: PartialResult[] = [
    ...buckets.pulsemcp,
    ...buckets.glama,
    ...buckets.npm,
    ...buckets.github,
  ];
  for (const p of allParts) {
    const arr = groups.get(p.id) ?? [];
    arr.push(p);
    groups.set(p.id, arr);
  }

  const out: McpSearchResult[] = [];
  for (const [id, parts] of groups) {
    const merged = mergeOne(id, parts);
    if (merged) out.push(merged);
  }
  return out;
}

/** Pick the first truthy value across a per-source priority order. */
function pick<T>(parts: PartialResult[], get: (p: PartialResult) => T | undefined, sources: PartialResult['source'][]): T | undefined {
  for (const src of sources) {
    const part = parts.find((p) => p.source === src);
    if (!part) continue;
    const v = get(part);
    if (v !== undefined && v !== '' && v !== null) return v;
  }
  // Fallback: any source.
  for (const part of parts) {
    const v = get(part);
    if (v !== undefined && v !== '' && v !== null) return v;
  }
  return undefined;
}

function mergeOne(id: string, parts: PartialResult[]): McpSearchResult | null {
  const sources = Array.from(new Set(parts.map((p) => p.source)));
  const sourceUrls: McpSearchResult['sourceUrls'] = {};
  for (const p of parts) sourceUrls[p.source] = p.sourceUrl || undefined;

  const title = pick(parts, (p) => p.title, ['pulsemcp', 'glama', 'npm', 'github']) ?? 'Unknown';
  const description =
    pick(parts, (p) => p.description, ['pulsemcp', 'glama', 'npm', 'github']) ?? '';
  const publisher = pick(parts, (p) => p.publisher, ['pulsemcp', 'glama', 'npm', 'github']) ?? '';
  const publisherUrl = pick(parts, (p) => p.publisherUrl, ['glama', 'pulsemcp', 'npm', 'github']);

  const npmPackageName = pick(parts, (p) => p.npmPackageName, ['npm', 'pulsemcp']);
  const endpointUrl = pick(parts, (p) => p.endpointUrl, ['pulsemcp', 'glama', 'npm', 'github']);
  const envKeys = pick(parts, (p) => p.envKeys, ['glama', 'pulsemcp', 'npm', 'github']);
  const githubFullName = pick(parts, (p) => p.githubFullName, ['npm', 'pulsemcp', 'glama', 'github']);

  const npmWeeklyDownloads = pick(parts, (p) => p.npmWeeklyDownloads, ['npm', 'pulsemcp']);
  const githubStars = pick(parts, (p) => p.githubStars, ['pulsemcp', 'github']);
  const license = pick(parts, (p) => p.license, ['npm', 'glama', 'github']);
  const lastUpdate = pick(parts, (p) => p.lastUpdate, ['npm', 'github']);
  const installInstructionsHint = pick(
    parts,
    (p) => p.installInstructionsHint,
    ['github', 'pulsemcp', 'glama', 'npm'],
  );

  // Endpoint type: hosted HTTP MCP > one-click stdio (npm package
  // available) > instructions-only.
  let endpointType: EndpointType;
  let stdioCommand: McpSearchResult['stdioCommand'] | undefined;
  let installInstructions: string | undefined;

  if (endpointUrl) {
    endpointType = 'http';
  } else if (npmPackageName) {
    endpointType = 'stdio-tauri';
    stdioCommand = {
      command: 'npx',
      args: ['-y', npmPackageName],
      envKeys,
    };
  } else if (githubFullName) {
    endpointType = 'stdio-instructions';
    installInstructions =
      installInstructionsHint ??
      `See README at https://github.com/${githubFullName} for install instructions.`;
  } else {
    // No way to install — drop. Shouldn't happen since canonicalIdFrom
    // requires at least one of npm or github, but defense in depth.
    return null;
  }

  // Trust tier — official > popular > unaudited. Computed from npm
  // package name OR github full_name signals.
  const isOfficialNpm = npmPackageName
    ? OFFICIAL_NPM_PREFIXES.some((p) => npmPackageName.startsWith(p))
    : false;
  const isOfficialGh = githubFullName ? OFFICIAL_GITHUB_REPOS.has(githubFullName) : false;
  const isOfficialPublisher = isOfficialNpm || isOfficialGh;

  const isPopular =
    (npmWeeklyDownloads ?? 0) >= POPULAR_DOWNLOADS_THRESHOLD ||
    (githubStars ?? 0) >= POPULAR_STARS_THRESHOLD;

  const trustTier: TrustTier = isOfficialPublisher
    ? 'official'
    : isPopular
      ? 'popular'
      : 'unaudited';

  // Tags: source-of-discovery markers + license + endpoint-type for filtering.
  const tags: string[] = [];
  if (sources.includes('pulsemcp')) tags.push('pulsemcp');
  if (sources.includes('glama')) tags.push('glama');
  if (sources.includes('npm')) tags.push('npm');
  if (sources.includes('github')) tags.push('github');
  if (endpointType === 'http') tags.push('http');
  if (endpointType === 'stdio-tauri') tags.push('stdio');
  if (endpointType === 'stdio-instructions') tags.push('manual');

  return {
    id,
    title,
    description,
    publisher,
    publisherUrl,
    sources,
    sourceUrls,
    endpointType,
    endpointUrl,
    stdioCommand,
    installInstructions,
    trustTier,
    signals: {
      npmWeeklyDownloads,
      githubStars,
      isOfficialPublisher,
      license,
      lastUpdate,
    },
    tags,
  };
}

/**
 * Score function — higher = better. Used to rank merged results before
 * we slice to MAX_RESULTS. Mostly emphasizes trust + popularity, with
 * a small bonus for cross-source presence (signals quality / wide use).
 */
function rankResults(results: McpSearchResult[], _q: string): McpSearchResult[] {
  return results
    .map((r) => ({ r, score: scoreOf(r) }))
    .sort((a, b) => b.score - a.score)
    .map(({ r }) => r);
}

function scoreOf(r: McpSearchResult): number {
  // Tier weights are large enough that they strictly dominate within-tier
  // signal scores. An obscure official package always beats the most
  // popular unaudited one — the trust gate is intentionally absolute, not
  // a soft preference. Within a tier, stars + downloads + cross-source
  // presence break ties.
  let s = 0;
  if (r.trustTier === 'official') s += 1_000_000;
  else if (r.trustTier === 'popular') s += 10_000;
  s += Math.min(r.signals.githubStars ?? 0, 5000);
  s += Math.min((r.signals.npmWeeklyDownloads ?? 0) / 10, 5000);
  s += r.sources.length * 50; // small cross-source bonus
  return s;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract `<owner>/<repo>` from any GitHub URL form. Returns null if the
 * URL isn't a github.com URL or can't be normalized.
 *
 * Handles:
 *   - https://github.com/foo/bar
 *   - https://github.com/foo/bar.git
 *   - git+https://github.com/foo/bar.git
 *   - github:foo/bar  (npm shorthand)
 *   - https://github.com/foo/bar/tree/main/path  → foo/bar (strips path)
 */
export function parseGitHubPath(url: string): string | null {
  if (!url) return null;
  const cleaned = url.trim().replace(/^git\+/, '').replace(/\.git$/, '');

  // npm shorthand: `github:foo/bar`
  const shortMatch = cleaned.match(/^github:([^/]+)\/([^/?#]+)/);
  if (shortMatch) return `${shortMatch[1]}/${shortMatch[2]}`;

  const httpsMatch = cleaned.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/,
  );
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;

  return null;
}

interface CanonicalIdInput {
  npmPackageName?: string;
  githubFullName?: string;
}

/**
 * Compute the canonical id used for cross-source dedup.
 *
 * Priority: `npm:<pkg>` if npm package name available, else
 * `gh:<owner>/<repo>`. We prefer npm because:
 *   - It's globally unique (npm registry namespacing)
 *   - One github repo can publish multiple npm packages (mono-repo)
 *   - Two different repos publishing the same npm name = same install,
 *     even if they're forks
 */
export function canonicalIdFrom(input: CanonicalIdInput): string | null {
  if (input.npmPackageName) return `npm:${input.npmPackageName}`;
  if (input.githubFullName) return `gh:${input.githubFullName.toLowerCase()}`;
  return null;
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

// Visible-for-tests exports.
export const __test = {
  parseGitHubPath,
  canonicalIdFrom,
  searchPulseMCP,
  searchGlama,
  searchNpm,
  searchGitHub,
  searchOfficialMcpPackages,
  mergeAndScore,
  scoreOf,
};

export default mcpsSearch;
