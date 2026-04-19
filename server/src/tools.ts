/**
 * Tool proxies — server-side handlers for tools whose credentials we don't
 * want to ship to the client.
 *
 * Why this exists:
 *   - Before Phase 4, the Tauri client called 博查's web-search API directly
 *     using a per-user key stored in Settings. That meant every friend needed
 *     their own 博查 account + credits.
 *   - After Phase 4, the client calls our /tools/web_search, which forwards
 *     to 博查 with a single shared server key. Quota tracking happens in the
 *     operator's 博查 dashboard.
 *
 * Contract: the client sends { query, count, freshness } (our compact
 * freshness enum: day/week/month/year). We map to 博查's native enum, call,
 * and return a normalized result shape so the client doesn't have to know
 * anything about 博查.
 */
import { Hono } from 'hono';

import type { AppContext } from './env';
import { requireAuth } from './middleware';

const tools = new Hono<AppContext>();

tools.use('*', requireAuth);

interface WebSearchBody {
  query?: unknown;
  count?: unknown;
  freshness?: unknown;
}

// 博查 freshness enum mapping. Kept as a switch (not a map) so the default
// branch is explicit — anything we don't recognize falls through to "noLimit"
// rather than silently breaking the request.
function mapFreshness(input: unknown): string {
  if (typeof input !== 'string') return 'noLimit';
  switch (input) {
    case 'day':   return 'oneDay';
    case 'week':  return 'oneWeek';
    case 'month': return 'oneMonth';
    case 'year':  return 'oneYear';
    default:      return 'noLimit';
  }
}

interface BochaWebPageResult {
  name?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  siteName?: string;
  dateLastCrawled?: string;
}

interface BochaResponse {
  code?: number;
  msg?: string | null;
  data?: {
    webPages?: {
      value?: BochaWebPageResult[];
    };
  };
}

tools.post('/tools/web_search', async (c) => {
  const apiKey = c.env.BOCHA_API_KEY;
  if (!apiKey) {
    // 503 (not 500) because the feature is intentionally disabled, not broken.
    // Client can surface this as "ask the admin to enable web search".
    return c.json({ error: 'web_search not configured on this server' }, 503);
  }

  const body = (await c.req.json().catch(() => null)) as WebSearchBody | null;
  if (!body) return c.json({ error: 'invalid json body' }, 400);

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return c.json({ error: 'query is required' }, 400);

  // Clamp count to [1, 10]. The client should already do this, but we defend
  // against misbehaving clients (or future MCP tools reusing this endpoint)
  // to avoid accidentally ordering 100 results from 博查.
  const rawCount = Number(body.count);
  const count = Number.isFinite(rawCount)
    ? Math.max(1, Math.min(10, Math.floor(rawCount)))
    : 5;

  const freshness = mapFreshness(body.freshness);

  // 博查 occasionally takes 10+ seconds under load; cap it so we don't pin a
  // Worker isolate forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);

  let upstream: Response;
  try {
    upstream = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        count,
        freshness,
        // Pre-summarized snippets — terser than raw `snippet`, saves tokens
        // in the tool result we feed back to the model.
        summary: true,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    const aborted = (err as { name?: string }).name === 'AbortError';
    console.error('bocha fetch failed', { aborted, err });
    return c.json(
      { error: aborted ? 'web_search timed out' : 'web_search upstream unreachable' },
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status === 401 || upstream.status === 403) {
    console.error('bocha auth failed — rotate BOCHA_API_KEY');
    return c.json({ error: 'web_search upstream auth failed' }, 502);
  }
  if (upstream.status === 429) {
    return c.json({ error: 'web_search rate limited, retry later' }, 429);
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return c.json(
      { error: `web_search upstream HTTP ${upstream.status}`, detail: text.slice(0, 300) },
      502,
    );
  }

  const json = (await upstream.json()) as BochaResponse;

  // 博查 puts business errors in `code` even on HTTP 200 — arrears, invalid
  // key, malformed query, etc. Unwrap and bubble up cleanly.
  if (typeof json.code === 'number' && json.code !== 200) {
    return c.json(
      { error: `web_search provider error code=${json.code}`, detail: json.msg ?? '' },
      502,
    );
  }

  const value = json.data?.webPages?.value ?? [];
  return c.json({
    query,
    count,
    freshness,
    results: value.map((r) => ({
      name: r.name ?? '',
      url: r.url ?? '',
      snippet: r.snippet ?? '',
      summary: r.summary ?? '',
      site_name: r.siteName ?? '',
      date_last_crawled: r.dateLastCrawled ?? '',
    })),
  });
});

export default tools;
