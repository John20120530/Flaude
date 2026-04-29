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
import { Hono, type Context } from 'hono';

import type { AppContext } from './env';
import { mirrorImageUrl } from './imageProxy';
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
  model?: unknown;
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

// v0.1.61: Aliyun Tongyi Wanxiang (DashScope) cost estimates. Public
// pricing is in CNY/image and varies by model — wanx2.1-t2i-turbo is
// roughly ¥0.14/image (~$0.020) and wanx2.1-t2i-plus ~¥0.40 (~$0.057).
// Higher than PPIO's `low` tier but uniformly faster (5-15s vs 60-120s
// of GPT Image 2 under load) and far more reliable for Chinese prompts.
const COST_MICRO_USD_BY_WANX_MODEL: Record<string, number> = {
  'wanx2.1-t2i-turbo': 20_000, // ~$0.020/image
  'wanx2.1-t2i-plus': 57_000, // ~$0.057/image
};

interface PPIOImageResponse {
  images?: string[];
  error?: { message?: string } | string;
}

interface WanxSubmitResponse {
  output?: {
    task_id?: string;
    task_status?: string;
  };
  code?: string;
  message?: string;
  request_id?: string;
}

interface WanxTaskResponse {
  output?: {
    task_id?: string;
    task_status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'UNKNOWN';
    results?: Array<{ url?: string; code?: string; message?: string }>;
    code?: string;
    message?: string;
  };
  code?: string;
  message?: string;
}

tools.post('/tools/image_generate', async (c) => {
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

  // v0.1.61: route by model id.
  //   - 'gpt-image-2' (default for back-compat) → PPIO synchronous API
  //   - 'wanx2.1-t2i-turbo' / 'wanx2.1-t2i-plus' → Aliyun DashScope async
  //
  // Each branch normalizes to the same `{prompt, urls, model, size, quality}`
  // response shape so the client tool handler is provider-agnostic.
  const requestedModel =
    typeof body.model === 'string' ? body.model : 'gpt-image-2';
  const isWanx = requestedModel.startsWith('wanx');

  if (isWanx) {
    return handleWanx(c, requestedModel, prompt, size, n);
  }

  // Default path: PPIO GPT Image 2.
  const apiKey = c.env.PPIO_API_KEY;
  if (!apiKey) {
    return c.json(
      { error: 'image_generate not configured on this server' },
      503,
    );
  }

  // Cap at 120s. v0.1.57: live measurement on prod showed simple
  // prompts ("a red apple on a white table") landing at exactly 60s
  // and complex Chinese prompts (~450 chars: Confucius + Socrates +
  // detailed scene) consistently exceeding 60s — ours was the bottleneck,
  // not PPIO. 120s comfortably covers the 99th percentile of detailed
  // medium-quality generations while still bailing on a wedged isolate
  // before Cloudflare's ~100s subrequest cap kicks in (effective ceiling
  // is min of these two; 120s just means we never tighten it ourselves).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);

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

  // v0.1.64: mirror to R2 so the URL outlives the upstream's signed-URL
  // TTL. mirrorImageUrl returns the original URL on any failure, so a
  // missing R2 binding / network blip / oversized image just degrades
  // back to pre-v0.1.64 behavior without throwing. Run the N (typically 1)
  // mirrors in parallel — each is bounded by MIRROR_TIMEOUT_MS internally
  // so the worst case adds ~8s to the response time, well within the
  // 100s subrequest cap on top of PPIO's 60-120s gen latency.
  const origin = new URL(c.req.url).origin;
  const mirroredUrls = await Promise.all(
    urls.map((u) => mirrorImageUrl(c.env, c.executionCtx, u, origin)),
  );

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
    urls: mirroredUrls,
    model: 'gpt-image-2',
    size,
    quality,
    n: urls.length,
  });
});

// =============================================================================
// Aliyun Tongyi Wanxiang (DashScope) — fallback image-gen provider, v0.1.61.
//
// Why we added this: PPIO's GPT Image 2 is excellent for English prompts but
// degrades sharply on busy days — we measured 75s → 126s+ within 24 hours
// for the same simple prompt. Cloudflare's 100s subrequest cap means we
// physically can't wait longer. Tongyi Wanxiang is the same image quality
// tier (turbo gives gpt-image-2-low results in ~5-10s) and uses an async
// task API so the wait time on each individual subrequest stays bounded.
//
// Wire (DashScope docs 2026-04):
//   POST https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis
//   Header: X-DashScope-Async: enable
//   Body: { model, input: { prompt }, parameters: { n, size? } }
//   → { output: { task_id, task_status: 'PENDING' } }
//
//   GET https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}
//   → { output: { task_status: 'SUCCEEDED'|'FAILED'|..., results: [{url}] } }
//
// We poll every 1.5s for up to ~80s (well inside the Workers subrequest
// cap; turbo finishes in 5-10s, plus in 15-30s, so the upper bound only
// kicks in on a wedged DashScope job).
//
// Auth: DASHSCOPE_API_KEY if set; otherwise falls back to QWEN_API_KEY,
// because DashScope issues a single API key that works for both chat
// and image. Most users have only QWEN_API_KEY set from the chat catalog,
// and we don't want to make them go fish for "another" key that's the
// same string.
// =============================================================================

async function handleWanx(
  c: Context<AppContext>,
  model: string,
  prompt: string,
  size: string,
  n: number,
) {
  const apiKey =
    (c.env as { DASHSCOPE_API_KEY?: string }).DASHSCOPE_API_KEY ??
    c.env.QWEN_API_KEY;
  if (!apiKey) {
    return c.json(
      { error: 'wanx image_generate not configured (set DASHSCOPE_API_KEY or QWEN_API_KEY)' },
      503,
    );
  }

  // DashScope wanx accepts size as e.g. "1024*1024" (asterisk, NOT 'x').
  // We accept the same gpt-image-2-style sizes from the client and
  // translate. 'auto' falls back to 1024*1024.
  //
  // v0.1.64: wanx2.1 rejects width OR height >1440 with HTTP 400
  // "Either width or height should be between 512 and 1440." The
  // gpt-image-2 sizes 1024x1536 / 1536x1024 hit that ceiling, so when
  // the user (or model) picks them we clamp the long edge to 1440. The
  // ratio shifts from 3:2 to ~1.4:1 — visually similar enough that
  // we'd rather quietly downsize than hard-fail.
  const wanxSize =
    size === '1024x1024' || size === 'auto'
      ? '1024*1024'
      : size === '1024x1536'
        ? '1024*1440'
        : size === '1536x1024'
          ? '1440*1024'
          : '1024*1024';

  // Step 1 — submit. AbortController ceiling 30s for the submit alone;
  // submit should be <2s, this just guards against a stuck DNS / TLS.
  const submitCtrl = new AbortController();
  const submitTimer = setTimeout(() => submitCtrl.abort(), 30_000);
  let submitRes: Response;
  try {
    submitRes = await fetch(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-DashScope-Async': 'enable',
        },
        body: JSON.stringify({
          model,
          input: { prompt },
          parameters: { n: Math.max(1, Math.min(4, n)), size: wanxSize },
        }),
        signal: submitCtrl.signal,
      },
    );
  } catch (err) {
    const aborted = (err as { name?: string }).name === 'AbortError';
    console.error('wanx submit failed', { aborted, err });
    return c.json(
      {
        error: aborted ? 'wanx submit timed out' : 'wanx submit unreachable',
      },
      502,
    );
  } finally {
    clearTimeout(submitTimer);
  }

  if (submitRes.status === 401 || submitRes.status === 403) {
    return c.json({ error: 'wanx upstream auth failed' }, 502);
  }
  if (submitRes.status === 429) {
    return c.json({ error: 'wanx rate limited, retry later' }, 429);
  }
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => '');
    return c.json(
      { error: `wanx submit HTTP ${submitRes.status}`, detail: text.slice(0, 300) },
      502,
    );
  }

  const submit = (await submitRes.json()) as WanxSubmitResponse;
  const taskId = submit.output?.task_id;
  if (!taskId) {
    return c.json(
      {
        error: 'wanx submit returned no task_id',
        detail: (submit.message ?? submit.code ?? '').slice(0, 300),
      },
      502,
    );
  }

  // Step 2 — poll. 80s ceiling; turbo typically 5-10s, plus 15-30s. We
  // keep total subrequest count well under Cloudflare's 50/req limit
  // (80s / 1.5s = ~53 polls worst-case → tighten to 1.8s to stay below).
  const POLL_INTERVAL_MS = 1_800;
  const POLL_DEADLINE_MS = 80_000;
  const startedAt = Date.now();
  let urls: string[] = [];
  let lastStatus = 'PENDING';
  let lastError = '';
  while (Date.now() - startedAt < POLL_DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const taskRes = await fetch(
      `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    ).catch((e) => {
      console.warn('wanx poll fetch errored', e);
      return null;
    });
    if (!taskRes || !taskRes.ok) continue;
    const task = (await taskRes.json()) as WanxTaskResponse;
    lastStatus = task.output?.task_status ?? lastStatus;
    if (task.output?.task_status === 'SUCCEEDED') {
      urls = (task.output.results ?? [])
        .map((r) => r.url)
        .filter((u): u is string => typeof u === 'string' && u.length > 0);
      break;
    }
    if (
      task.output?.task_status === 'FAILED' ||
      task.output?.task_status === 'CANCELED'
    ) {
      lastError =
        task.output?.message ??
        (task.output?.results ?? [])[0]?.message ??
        task.message ??
        '';
      break;
    }
    // Otherwise PENDING/RUNNING — keep polling.
  }

  if (urls.length === 0) {
    return c.json(
      {
        error:
          lastStatus === 'FAILED' || lastStatus === 'CANCELED'
            ? `wanx task ${lastStatus.toLowerCase()}`
            : 'wanx polling timed out',
        detail: (lastError || `last status: ${lastStatus}`).slice(0, 300),
      },
      502,
    );
  }

  // v0.1.64: mirror to R2. Critical here because wanx's OSS URLs hard-
  // expire after 24h — the original 24h-broken-image bug we set out to
  // root-cause. Same Promise.all + per-image timeout shape as the PPIO
  // path so wanx doesn't get a different fallback policy.
  const origin = new URL(c.req.url).origin;
  const mirroredUrls = await Promise.all(
    urls.map((u) => mirrorImageUrl(c.env, c.executionCtx, u, origin)),
  );

  // Best-effort usage log — same shape as gpt-image-2 path so admin
  // dashboards can sum image-gen activity across providers without a
  // schema change.
  const userId = c.get('userId');
  const perImageCost = COST_MICRO_USD_BY_WANX_MODEL[model] ?? 30_000;
  const cost = perImageCost * urls.length;
  c.executionCtx.waitUntil(
    c.env.DB
      .prepare(
        `INSERT INTO usage_log
           (user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_micro_usd, conversation_id)
         VALUES (?, ?, 0, 0, 0, ?, NULL)`,
      )
      .bind(userId, model, cost)
      .run()
      .catch((err) => console.error('wanx usage_log insert failed', err)),
  );

  return c.json({
    prompt,
    urls: mirroredUrls,
    model,
    size,
    quality: 'auto', // wanx doesn't expose a quality tier; echo something stable
    n: urls.length,
  });
}

export default tools;
