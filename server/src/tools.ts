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

// =============================================================================
// /tools/image_generate
//
// Proxies PPIO's GPT Image 2 text-to-image endpoint with the operator's
// shared `PPIO_API_KEY`. Same shared-key model as web_search above —
// users don't manage their own provider key; they go through us.
//
// Wire (PPIO docs 2026-04-24):
//   POST https://api.ppio.com/v3/gpt-image-2-text-to-image
//   { prompt, n?, size?, quality?, background?, output_format?, ... }
//   → { images: string[] }    // array of CDN URLs
//
// Our shape (for the client tool handler):
//   POST /tools/image_generate
//   { prompt, size?, quality?, n?, background?, output_format? }
//   → { prompt, urls: string[], model: 'gpt-image-2', size, quality }
//
// We log each successful call to usage_log so admin dashboards reflect
// image-gen activity alongside chat. Image gens aren't token-based;
// we record total_tokens=0 + a representative cost per image based on
// the quality tier (PPIO public pricing as of 2026-04 — adjust the
// constants below if pricing shifts).
// =============================================================================

interface ImageGenerateBody {
  prompt?: unknown;
  size?: unknown;
  quality?: unknown;
  n?: unknown;
  background?: unknown;
  output_format?: unknown;
}

const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high']);
const ALLOWED_BACKGROUNDS = new Set(['transparent', 'opaque', 'auto']);
const ALLOWED_FORMATS = new Set(['png', 'jpeg']);

// Approximate per-image cost in micro-USD by quality tier. These are
// rough — PPIO's exact pricing varies by promo and isn't part of the
// API response, so we record an estimate for billing visibility, not
// a chargeback figure. Tune when pricing changes.
const COST_MICRO_USD_BY_QUALITY: Record<string, number> = {
  low: 11_000, // ~$0.011 per image
  medium: 42_000, // ~$0.042
  high: 167_000, // ~$0.167
};

interface PPIOImageResponse {
  images?: string[];
  error?: { message?: string } | string;
}

tools.post('/tools/image_generate', async (c) => {
  const apiKey = c.env.PPIO_API_KEY;
  if (!apiKey) {
    return c.json(
      { error: 'image_generate not configured on this server' },
      503,
    );
  }

  const body = (await c.req.json().catch(() => null)) as ImageGenerateBody | null;
  if (!body) return c.json({ error: 'invalid json body' }, 400);

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return c.json({ error: 'prompt is required' }, 400);
  if (prompt.length > 32_000) {
    return c.json({ error: 'prompt too long (max 32000 chars)' }, 400);
  }

  // Sanitize optional fields. Anything off-list falls back to a sane
  // default rather than 400ing, because the model might emit slightly-
  // off values ("HD" instead of "high") that we don't want to bounce.
  const size =
    typeof body.size === 'string' && ALLOWED_SIZES.has(body.size)
      ? body.size
      : 'auto';
  const quality =
    typeof body.quality === 'string' && ALLOWED_QUALITIES.has(body.quality)
      ? body.quality
      : 'medium';
  const background =
    typeof body.background === 'string' && ALLOWED_BACKGROUNDS.has(body.background)
      ? body.background
      : undefined;
  const output_format =
    typeof body.output_format === 'string' && ALLOWED_FORMATS.has(body.output_format)
      ? body.output_format
      : undefined;

  const rawN = Number(body.n);
  const n = Number.isFinite(rawN) ? Math.max(1, Math.min(4, Math.floor(rawN))) : 1;

  // Cap at 60s — high-quality generations can take 30s+. Beyond 60s
  // the user has almost certainly given up and a hung Worker isolate
  // is wasted money.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);

  let upstream: Response;
  try {
    upstream = await fetch(
      'https://api.ppio.com/v3/gpt-image-2-text-to-image',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          prompt,
          size,
          quality,
          n,
          ...(background !== undefined ? { background } : {}),
          ...(output_format !== undefined ? { output_format } : {}),
        }),
        signal: ctrl.signal,
      },
    );
  } catch (err) {
    const aborted = (err as { name?: string }).name === 'AbortError';
    console.error('ppio fetch failed', { aborted, err });
    return c.json(
      {
        error: aborted
          ? 'image_generate timed out'
          : 'image_generate upstream unreachable',
      },
      502,
    );
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status === 401 || upstream.status === 403) {
    console.error('ppio auth failed — rotate PPIO_API_KEY');
    return c.json({ error: 'image_generate upstream auth failed' }, 502);
  }
  if (upstream.status === 429) {
    return c.json({ error: 'image_generate rate limited, retry later' }, 429);
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return c.json(
      {
        error: `image_generate upstream HTTP ${upstream.status}`,
        detail: text.slice(0, 300),
      },
      502,
    );
  }

  const json = (await upstream.json()) as PPIOImageResponse;

  // PPIO sometimes returns 200 with an `error` field instead of a
  // proper non-2xx — defend against that.
  if (json.error) {
    const detail =
      typeof json.error === 'string' ? json.error : (json.error.message ?? '');
    return c.json(
      { error: `image_generate provider error`, detail: detail.slice(0, 300) },
      502,
    );
  }

  const urls = (json.images ?? []).filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );

  if (urls.length === 0) {
    return c.json(
      { error: 'image_generate returned 0 images', detail: 'check prompt + try a different quality' },
      502,
    );
  }

  // Best-effort usage logging. Don't block the response on it — if D1
  // is slow we'd rather ship the image URLs and let the row write
  // settle in waitUntil.
  const userId = c.get('userId');
  const cost = (COST_MICRO_USD_BY_QUALITY[quality] ?? 50_000) * urls.length;
  c.executionCtx.waitUntil(
    c.env.DB
      .prepare(
        `INSERT INTO usage_log
           (user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_micro_usd, conversation_id)
         VALUES (?, ?, 0, 0, 0, ?, NULL)`,
      )
      .bind(userId, 'gpt-image-2', cost)
      .run()
      .catch((err) =>
        console.error('image_generate usage_log insert failed', err),
      ),
  );

  return c.json({
    prompt,
    urls,
    model: 'gpt-image-2',
    size,
    quality,
    n: urls.length,
  });
});

export default tools;
