/**
 * Tests for /tools/image_generate.
 *
 * Drives the full Hono app via `app.fetch` against a mocked PPIO
 * upstream (via global fetch stub). Covers:
 *   - happy path: PPIO returns URLs → we return them in normalized shape
 *   - missing API key → 503 (feature off)
 *   - missing prompt → 400
 *   - oversized prompt → 400
 *   - PPIO auth failure → 502
 *   - PPIO 429 → bubble as 429
 *   - PPIO returns empty images → 502 with explainer
 *   - PPIO returns error field on 200 → 502
 *   - sanitization of bad enum values (size/quality) → upstream gets safe defaults
 *   - usage_log row is recorded on success
 *
 * Auth-gate test (anonymous request → 401) is implicit since
 * `tools.use('*', requireAuth)` wraps every route — same as web_search.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hashPassword, signToken } from '../src/auth';
import type { Env } from '../src/env';
import worker from '../src/index';
import { createTestD1 } from './d1Shim';
import { applySchema } from './schema';

const JWT_SECRET = 'test-jwt-secret-at-least-32-bytes-long-for-HS256-use';
const JWT_ISSUER = 'flaude-test';

let env: Env;
let userToken: string;
let userId: number;

function stubCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

async function fetchApp(req: Request): Promise<Response> {
  return worker.fetch(req, env, stubCtx());
}

beforeEach(async () => {
  vi.unstubAllGlobals();

  const db = createTestD1();
  env = {
    DB: db,
    APP_ENV: 'development',
    JWT_ISSUER,
    MONTHLY_QUOTA_TOKENS: '300000',
    JWT_SECRET,
    PPIO_API_KEY: 'test-ppio-key',
  } as Env;
  await applySchema(db);

  // Seed a user.
  const hash = await hashPassword('password-aaaaaa');
  const r = await db
    .prepare(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .bind('alice@test.local', hash, 'Alice', 'user')
    .first<{ id: number }>();
  userId = r!.id;
  userToken = await signToken(
    { id: userId, email: 'alice@test.local', role: 'user' },
    JWT_SECRET,
    JWT_ISSUER,
  );
});

function imageGenReq(body: unknown): Request {
  return new Request('http://test/tools/image_generate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function ppioMock(impl: (init: RequestInit | undefined) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://api.ppio.com/v3/gpt-image-2-text-to-image')) {
      return impl(init);
    }
    return new Response('not mocked: ' + url, { status: 404 });
  });
}

describe('POST /tools/image_generate', () => {
  it('happy path: returns normalized urls + model/size/quality echo', async () => {
    vi.stubGlobal(
      'fetch',
      ppioMock(() =>
        new Response(
          JSON.stringify({
            images: [
              'https://ppio-cdn/abc.png',
              'https://ppio-cdn/def.png',
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const res = await fetchApp(
      imageGenReq({ prompt: 'a cat astronaut', n: 2, size: '1024x1024', quality: 'high' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompt: string;
      urls: string[];
      model: string;
      size: string;
      quality: string;
      n: number;
    };
    expect(body.urls).toEqual([
      'https://ppio-cdn/abc.png',
      'https://ppio-cdn/def.png',
    ]);
    expect(body.model).toBe('gpt-image-2');
    expect(body.size).toBe('1024x1024');
    expect(body.quality).toBe('high');
    expect(body.n).toBe(2);
    expect(body.prompt).toBe('a cat astronaut');
  });

  it('missing PPIO_API_KEY → 503', async () => {
    env.PPIO_API_KEY = undefined;
    const res = await fetchApp(imageGenReq({ prompt: 'foo' }));
    expect(res.status).toBe(503);
  });

  it('missing prompt → 400', async () => {
    const res = await fetchApp(imageGenReq({}));
    expect(res.status).toBe(400);
  });

  it('empty-string prompt → 400', async () => {
    const res = await fetchApp(imageGenReq({ prompt: '   ' }));
    expect(res.status).toBe(400);
  });

  it('oversized prompt (>32k chars) → 400', async () => {
    const res = await fetchApp(imageGenReq({ prompt: 'x'.repeat(32_001) }));
    expect(res.status).toBe(400);
  });

  it('invalid size value falls back to "auto" instead of erroring', async () => {
    let capturedBody: string | undefined;
    vi.stubGlobal(
      'fetch',
      ppioMock((init) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ images: ['https://x/1.png'] }), {
          status: 200,
        });
      }),
    );
    await fetchApp(imageGenReq({ prompt: 'foo', size: 'enormous' }));
    expect(capturedBody).toBeDefined();
    expect(JSON.parse(capturedBody!).size).toBe('auto');
  });

  it('invalid quality value falls back to "medium"', async () => {
    let capturedBody: string | undefined;
    vi.stubGlobal(
      'fetch',
      ppioMock((init) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ images: ['https://x/1.png'] }), {
          status: 200,
        });
      }),
    );
    await fetchApp(imageGenReq({ prompt: 'foo', quality: 'HD' }));
    expect(capturedBody).toBeDefined();
    expect(JSON.parse(capturedBody!).quality).toBe('medium');
  });

  it('PPIO 401 → 502 (so the agent doesn\'t see auth flow exposed)', async () => {
    vi.stubGlobal(
      'fetch',
      ppioMock(() => new Response('unauthorized', { status: 401 })),
    );
    const res = await fetchApp(imageGenReq({ prompt: 'foo' }));
    expect(res.status).toBe(502);
  });

  it('PPIO 429 → 429 (rate-limit pass-through)', async () => {
    vi.stubGlobal(
      'fetch',
      ppioMock(() => new Response('too many', { status: 429 })),
    );
    const res = await fetchApp(imageGenReq({ prompt: 'foo' }));
    expect(res.status).toBe(429);
  });

  it('PPIO 500 → 502 with detail', async () => {
    vi.stubGlobal(
      'fetch',
      ppioMock(() => new Response('boom', { status: 500 })),
    );
    const res = await fetchApp(imageGenReq({ prompt: 'foo' }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toMatch(/HTTP 500/);
  });

  it('PPIO returns error field on 200 → 502', async () => {
    vi.stubGlobal(
      'fetch',
      ppioMock(() =>
        new Response(
          JSON.stringify({ error: { message: 'content policy violation' } }),
          { status: 200 },
        ),
      ),
    );
    const res = await fetchApp(imageGenReq({ prompt: 'foo' }));
    expect(res.status).toBe(502);
  });

  it('PPIO returns 0 images → 502 with explainer', async () => {
    vi.stubGlobal(
      'fetch',
      ppioMock(() => new Response(JSON.stringify({ images: [] }), { status: 200 })),
    );
    const res = await fetchApp(imageGenReq({ prompt: 'foo' }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/0 images/);
  });

  it('clamps n to [1, 4]', async () => {
    let capturedBody: string | undefined;
    vi.stubGlobal(
      'fetch',
      ppioMock((init) => {
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ images: ['https://x/1.png'] }), {
          status: 200,
        });
      }),
    );
    await fetchApp(imageGenReq({ prompt: 'foo', n: 99 }));
    expect(JSON.parse(capturedBody!).n).toBe(4);

    capturedBody = undefined;
    await fetchApp(imageGenReq({ prompt: 'foo', n: 0 }));
    expect(JSON.parse(capturedBody!).n).toBe(1);
  });

  it('records a usage_log row on success', async () => {
    vi.stubGlobal(
      'fetch',
      ppioMock(() =>
        new Response(
          JSON.stringify({ images: ['https://x/1.png', 'https://x/2.png'] }),
          { status: 200 },
        ),
      ),
    );

    // The endpoint uses waitUntil for the log insert, but our test
    // ExecutionContext.waitUntil is a no-op. Override it to await.
    const ctxWithWait: ExecutionContext = {
      waitUntil: async (p: Promise<unknown>) => {
        await p;
      },
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    const res = await worker.fetch(
      imageGenReq({ prompt: 'foo', quality: 'high', n: 2 }),
      env,
      ctxWithWait,
    );
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare(
        `SELECT model, total_tokens, cost_micro_usd FROM usage_log WHERE user_id = ?`,
      )
      .bind(userId)
      .first<{ model: string; total_tokens: number; cost_micro_usd: number }>();
    expect(row).toBeTruthy();
    expect(row!.model).toBe('gpt-image-2');
    // 2 images × ~$0.167 each = $0.334 ≈ 334000 micro-USD.
    expect(row!.cost_micro_usd).toBeGreaterThan(300_000);
    expect(row!.cost_micro_usd).toBeLessThan(400_000);
  });

  it('rejects unauthenticated requests (auth gate inherited from tools sub-app)', async () => {
    const res = await fetchApp(
      new Request('http://test/tools/image_generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'foo' }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
