/**
 * Image proxy / KV mirror — root-cause fix for the "OSS URL expires in 24h
 * and the design canvas <img> goes broken" bug (v0.1.65).
 *
 * Pipeline:
 *   1. image_generate handler (tools.ts) calls an upstream provider:
 *        - PPIO GPT Image 2 → returns CDN URLs (TTL ~weeks, but still a
 *          third-party we don't control).
 *        - Aliyun DashScope wanx → returns OSS signed URLs (TTL **24h**,
 *          hard-coded by Aliyun, can't extend).
 *   2. Before returning to the client, we fetch each URL once, hash the
 *      bytes (sha256), upload to KV under `gen/<sha256>.<ext>`, and
 *      rewrite the response so `urls[]` points at our own
 *      `/api/image/<key>`.
 *   3. Public GET /api/image/:filename serves bytes back out of KV with
 *      a 1-year immutable Cache-Control. Browsers + Cloudflare's edge
 *      cache absorb repeat reads; the design canvas iframe sees a stable
 *      URL forever.
 *
 * Why KV instead of R2 (the natural choice for binary blobs):
 *   - R2 requires a credit card on file even on the free tier (Cloudflare
 *     enforces a "Purchase R2 Plan" click-through that needs payment info,
 *     even for $0/month usage). Operator declined.
 *   - KV is included in the Workers Free plan with no credit card. Limits:
 *     1 GB storage / 1k writes-day / 100k reads-day / 25 MB per value. For
 *     a 5-10 user team where each gen costs $0.04-0.20 and takes 60-120s,
 *     daily gen volume is ~50 → 20× headroom on writes. Storage holds
 *     ~1000 unique 1MB images permanently (with sha256 dedup, more).
 *   - The KV API is shaped close enough to R2 that the only differences
 *     are: no `head()` for cheap dedup (we skip the check; KV PUT is
 *     idempotent so re-uploading same bytes is just wasted bandwidth, not
 *     corruption), metadata is a top-level option not nested under
 *     `httpMetadata`, and the value comes back as ArrayBuffer not stream.
 *
 * Why content-addressable (sha256) instead of a UUID:
 *   - Two users generating the same image → one KV value, half the storage.
 *     Rare in practice but free, so we take it.
 *   - The bytes ARE the identity → URL is verifiable + safe to cache as
 *     `immutable` (a different sha256 would mean different bytes by
 *     definition).
 *   - We don't need to track "which conversation owns which image" for GC.
 *     KV storage is free up to 1 GB; if we exceed that we revisit with
 *     either the credit-card-R2 path or a cron-driven GC pass that walks
 *     conversations + diffs against KV keys.
 *
 * Failure mode: if the mirror fails (KV binding missing, network blip,
 * upstream URL already 404'd, value > 25 MB), `mirrorImageUrl` returns
 * the **original URL unchanged**. The caller transparently falls back to
 * pre-v0.1.65 behavior — image works for the upstream's TTL, then breaks.
 * Strictly better than today; never worse.
 *
 * Why we don't lazily mirror at /api/image/:key serve-time instead:
 *   - Original URL is signed → if we tried to fetch it >24h later it's
 *     already 404. We have to capture bytes at generation time, not on
 *     first read. This module is read-write, not read-only proxy.
 */
import { Hono } from 'hono';

import type { AppContext, Env } from './env';

/** Cap mirror time per image. Beyond this, fall back to original URL. */
const MIRROR_TIMEOUT_MS = 8000;

/** Allowed file extensions for the public serve route. We only ever WRITE
 *  png/jpg/webp from upstream, but the regex on read defends against weird
 *  paths (`../`, double-dot, query strings, etc.) at the routing layer. */
const FILENAME_RE = /^[a-f0-9]{64}\.(png|jpe?g|webp)$/;

/** Cap the bytes we'll hold in memory + push to KV from one upstream image.
 *  KV's hard ceiling is 25 MB per value. We cap at 6 MB because:
 *    - GPT Image 2 + wanx both produce <=2 MB at the sizes we allow.
 *    - 6 MB gives headroom for `quality: high` + future larger sizes.
 *    - Smaller blobs = faster KV propagation across PoPs (the path that
 *      bites us on read-after-write consistency, see comment in the
 *      serve handler). */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** Metadata blob we store alongside each KV value. We need contentType to
 *  serve the right MIME, and the cacheControl is fixed but stored anyway
 *  in case we ever want to vary it per image (e.g. a "preview" tier with
 *  shorter TTL). */
interface ImageMetadata {
  contentType: string;
  cacheControl: string;
}

/**
 * Fetch the upstream image, hash + upload to KV, return a stable URL we
 * own. On any failure returns the original URL unchanged.
 *
 * @param env       Worker bindings. Reads `env.IMAGES` (KVNamespace).
 * @param ctx       ExecutionContext — only used to set `waitUntil` on a
 *                  background-write fallback path. May be null in tests.
 * @param sourceUrl The provider-returned URL (PPIO CDN / OSS signed).
 * @param origin    The public origin to base the rewritten URL on. Pass
 *                  `new URL(c.req.url).origin` so production picks up
 *                  api.flaude.net automatically and local dev picks up
 *                  http://127.0.0.1:8787.
 */
export async function mirrorImageUrl(
  env: Env,
  ctx: ExecutionContext | null,
  sourceUrl: string,
  origin: string,
): Promise<string> {
  // Graceful no-op when KV binding hasn't been added yet (e.g. an older
  // wrangler.toml in production). Caller still sees the original URL and
  // image_generate works exactly as before — just without the 24h fix.
  if (!env.IMAGES) {
    return sourceUrl;
  }

  // Don't mirror something that's already on us. image_generate could
  // theoretically be invoked with a URL we already mirrored (e.g. model
  // re-using a prior turn's URL), and re-fetching our own bucket via
  // public HTTPS just to re-upload would be silly.
  try {
    const u = new URL(sourceUrl);
    const ours = new URL(origin);
    if (u.host === ours.host && u.pathname.startsWith('/api/image/')) {
      return sourceUrl;
    }
  } catch {
    // Source URL is malformed — let the fetch below fail, fall back to
    // returning sourceUrl as-is. Don't crash here.
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MIRROR_TIMEOUT_MS);
  let bytes: ArrayBuffer;
  let contentType: string;
  try {
    const res = await fetch(sourceUrl, { signal: ctrl.signal });
    if (!res.ok) {
      console.warn('mirrorImageUrl: upstream non-2xx', {
        status: res.status,
        sourceUrl,
      });
      return sourceUrl;
    }
    contentType = res.headers.get('content-type') ?? 'image/png';

    // Reject obviously-bad content types up front — if upstream served us
    // an HTML error page we don't want to enshrine it as a "permanent" image.
    if (!contentType.startsWith('image/')) {
      console.warn('mirrorImageUrl: non-image content-type', {
        contentType,
        sourceUrl,
      });
      return sourceUrl;
    }

    bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      console.warn('mirrorImageUrl: bad size', {
        size: bytes.byteLength,
        sourceUrl,
      });
      return sourceUrl;
    }
  } catch (err) {
    const aborted = (err as { name?: string }).name === 'AbortError';
    console.warn('mirrorImageUrl: fetch failed', { aborted, err, sourceUrl });
    return sourceUrl;
  } finally {
    clearTimeout(timer);
  }

  // sha256 → hex
  const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(hashBuf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Pick a sane extension from content-type. We accept jpeg/png/webp;
  // anything else falls back to png (the URL extension is mostly cosmetic
  // — we still record + echo the actual content-type via metadata).
  let ext = 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
  else if (contentType.includes('webp')) ext = 'webp';

  const key = `gen/${hex}.${ext}`;
  const cacheControl = 'public, max-age=31536000, immutable';

  // No HEAD-before-PUT here. R2 has a cheap `head()` for dedup but KV
  // doesn't — the closest thing (`getWithMetadata`) reads the full value.
  // Reading 1 MB just to skip a 1 MB write is a wash. Plus content-
  // addressable PUT is idempotent: writing the same bytes to the same
  // key produces the same value. So we just put unconditionally; on a
  // dedup hit we waste one PUT (out of the 1k/day allowance) which is
  // fine for our user count.
  try {
    await env.IMAGES.put(key, bytes, {
      metadata: { contentType, cacheControl } satisfies ImageMetadata,
    });
  } catch (err) {
    console.error('mirrorImageUrl: KV put failed', { err, key });
    // Best-effort retry in the background after we've returned to the
    // user. If THIS retry also fails the image still works (caller has
    // sourceUrl), it just won't survive >24h. Worth one shot.
    if (ctx) {
      ctx.waitUntil(
        env.IMAGES.put(key, bytes, {
          metadata: { contentType, cacheControl } satisfies ImageMetadata,
        }).catch((e) =>
          console.error('mirrorImageUrl: background retry failed', e),
        ),
      );
    }
    return sourceUrl;
  }

  return `${origin}/api/image/${hex}.${ext}`;
}

// =============================================================================
// Public read endpoint: GET /api/image/:filename
//
// No auth — image URLs are pasted into HTML <img> tags inside the design
// canvas iframe (and likely shared with collaborators), so requireAuth
// would break the whole point. The URL is content-addressable — leaking
// it leaks the bytes (which the user just generated and chose to embed
// in their design); not a credential.
// =============================================================================

const imageProxy = new Hono<AppContext>();

imageProxy.get('/api/image/:filename', async (c) => {
  const filename = c.req.param('filename');
  if (!FILENAME_RE.test(filename)) {
    return c.json({ error: 'invalid image key' }, 400);
  }
  if (!c.env.IMAGES) {
    return c.json({ error: 'image storage not configured on this server' }, 503);
  }

  const key = `gen/${filename}`;

  // KV.getWithMetadata returns { value, metadata } in one round-trip.
  // Asking for 'arrayBuffer' avoids a string-decoding step we'd just
  // re-encode for the response body.
  //
  // Note on read-after-write: KV is eventually consistent across PoPs
  // (~60s). For our case the user generates an image, gets back our
  // /api/image URL, and the browser fetches it within seconds. Most of
  // the time the read hits the same PoP that did the write so it's
  // immediately visible; for cross-PoP reads (e.g. another device
  // pulling the conversation 60s+ later) propagation has caught up. If
  // the read does miss in that narrow window, the response is 404 and
  // the user gets a broken image for one refresh — acceptable since
  // the alternative (synchronous global propagation) doesn't exist.
  const got = await c.env.IMAGES.getWithMetadata<ImageMetadata>(key, {
    type: 'arrayBuffer',
  });
  if (!got.value) {
    return c.json({ error: 'image not found' }, 404);
  }

  return new Response(got.value, {
    headers: {
      'Content-Type': got.metadata?.contentType ?? 'image/png',
      'Cache-Control':
        got.metadata?.cacheControl ?? 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // Allow embedding from any origin — the design canvas iframe is
      // null-origin by sandbox, so we can't whitelist meaningfully here.
      // The image is public anyway.
      'Access-Control-Allow-Origin': '*',
    },
  });
});

export default imageProxy;
