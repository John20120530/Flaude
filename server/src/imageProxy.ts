/**
 * Image proxy / R2 mirror — root-cause fix for the "OSS URL expires in 24h
 * and the design canvas <img> goes broken" bug (v0.1.64).
 *
 * Pipeline:
 *   1. image_generate handler (tools.ts) calls an upstream provider:
 *        - PPIO GPT Image 2 → returns CDN URLs (TTL ~weeks, but still a
 *          third-party we don't control).
 *        - Aliyun DashScope wanx → returns OSS signed URLs (TTL **24h**,
 *          hard-coded by Aliyun, can't extend).
 *   2. Before returning to the client, we fetch each URL once, hash the
 *      bytes (sha256), upload to R2 under `gen/<sha256>.<ext>`, and rewrite
 *      the response so `urls[]` points at our own `/api/image/<key>`.
 *   3. Public GET /api/image/:filename serves bytes back out of R2 with
 *      a 1-year immutable Cache-Control. Browsers + Cloudflare's edge
 *      cache absorb repeat reads; the design canvas iframe sees a stable
 *      URL forever.
 *
 * Why content-addressable (sha256) instead of a UUID:
 *   - Two users generating the same image → one R2 object, half the storage.
 *     Rare in practice but free, so we take it.
 *   - The bytes ARE the identity → URL is verifiable + safe to cache as
 *     `immutable` (a different sha256 would mean different bytes by
 *     definition).
 *   - We don't need to track "which conversation owns which image" for GC.
 *     R2 storage is $0.015/GB/month; even 10k images of 1MB each is
 *     ~$0.15/month forever. We don't currently delete; if we ever need to,
 *     a separate GC pass that walks conversations + diffs against R2 keys
 *     can decide what's orphaned.
 *
 * Failure mode: if the mirror fails (R2 binding missing, network blip,
 * upstream URL already 404'd), `mirrorImageUrl` returns the **original
 * URL unchanged**. The caller transparently falls back to pre-v0.1.64
 * behavior — image works for the upstream's TTL, then breaks. Strictly
 * better than today; never worse.
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

/** Cap the bytes we'll hold in memory + push to R2 from one upstream image.
 *  GPT Image 2 + wanx both produce <=2MB at the sizes we allow. 6MB gives
 *  headroom for `quality: high` + 1536x1536 future expansion without
 *  blowing past Worker memory limits. */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * Fetch the upstream image, hash + upload to R2, return a stable URL we
 * own. On any failure returns the original URL unchanged.
 *
 * @param env       Worker bindings. Reads `env.IMAGES` (R2Bucket).
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
  // Graceful no-op when R2 binding hasn't been added yet (e.g. an older
  // wrangler.toml in production). Caller still sees the original URL and
  // image_generate works exactly as before — just without the 24h fix.
  if (!env.IMAGES) {
    return sourceUrl;
  }

  // Don't mirror something that's already on us. Image_generate could
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
  // anything else falls back to png (R2 will still serve it correctly
  // because we record the actual content-type in object metadata, but
  // the URL extension is mostly cosmetic).
  let ext = 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = 'jpg';
  else if (contentType.includes('webp')) ext = 'webp';

  const key = `gen/${hex}.${ext}`;

  // HEAD before PUT — if the object's already there (same bytes from a
  // prior gen), we save an upload. R2 PUTs are cheap but not free, and
  // this is the kind of optimization that pays for itself on retries.
  try {
    const existing = await env.IMAGES.head(key);
    if (!existing) {
      await env.IMAGES.put(key, bytes, {
        httpMetadata: {
          contentType,
          // 1y immutable — content-addressable so the object behind a
          // given key NEVER changes. Cloudflare's edge cache + every
          // browser will keep it for as long as they want.
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });
    }
  } catch (err) {
    console.error('mirrorImageUrl: R2 put failed', { err, key });
    // Best-effort retry in the background after we've returned to the
    // user. If THIS retry also fails the image still works (caller has
    // sourceUrl), it just won't survive >24h. Worth one shot.
    if (ctx) {
      ctx.waitUntil(
        env.IMAGES.put(key, bytes, {
          httpMetadata: { contentType },
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
  const obj = await c.env.IMAGES.get(key);
  if (!obj) {
    return c.json({ error: 'image not found' }, 404);
  }

  // R2 object stream → Response. Echo the stored content-type and the
  // long cache hint we wrote at PUT-time. CF's edge will absorb repeat
  // reads → most page-loads after the first won't even reach this
  // Worker invocation.
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
      'Cache-Control':
        obj.httpMetadata?.cacheControl ?? 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // Allow embedding from any origin — the design canvas iframe is
      // null-origin by sandbox, so we can't whitelist meaningfully here.
      // The image is public anyway.
      'Access-Control-Allow-Origin': '*',
    },
  });
});

export default imageProxy;
