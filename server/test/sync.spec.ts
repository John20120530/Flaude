/**
 * Server integration tests — sync round-trip, LWW, tombstones, cross-user
 * isolation, payload caps, auth.
 *
 * Drives the live Hono app via `app.fetch(request, env)`, hitting the same
 * route handlers a Cloudflare Worker would, against a better-sqlite3-backed
 * D1 shim. No mocks at the handler level — the whole stack runs: routing,
 * middleware, JWT verify, SQL, LWW guards, tombstone UPDATEs.
 *
 * Test-isolation model: each `it` gets a fresh in-memory SQLite DB via
 * beforeEach, so there's no state leakage between tests. The schema is
 * applied once per test; at ~80KB of DDL the cost is negligible.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import type { Env } from '../src/env';
import { hashPassword, signToken } from '../src/auth';
import { applySchema } from './schema';
import { createTestD1 } from './d1Shim';

// -----------------------------------------------------------------------------
// Fixture scaffolding
// -----------------------------------------------------------------------------
interface TestUser {
  id: number;
  email: string;
  token: string;
}

const JWT_SECRET = 'test-jwt-secret-at-least-32-bytes-long-for-HS256-use';
const JWT_ISSUER = 'flaude-test';

let env: Env;
let alice: TestUser;
let bob: TestUser;

function stubCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

async function fetchApp(req: Request): Promise<Response> {
  // `worker` is the default export from src/index.ts — { fetch, scheduled }.
  // The Hono app.fetch handler accepts (request, env, ctx). ctx is only used
  // by the scheduled handler's waitUntil; a stub is fine for route tests.
  return worker.fetch(req, env, stubCtx());
}

beforeEach(async () => {
  const db = createTestD1();
  env = {
    DB: db,
    APP_ENV: 'development',
    JWT_ISSUER,
    MONTHLY_QUOTA_TOKENS: '300000',
    JWT_SECRET,
  } as Env;

  await applySchema(db);

  // Seed two users: alice (admin, via /setup) and bob (user, direct insert).
  // Going through /setup for alice also exercises the bootstrap path end-to-end.
  const setupRes = await fetchApp(
    new Request('http://test/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@test.local',
        password: 'password-aaaaaa',
        display_name: 'Alice',
      }),
    }),
  );
  if (setupRes.status !== 200) {
    throw new Error(`setup failed: ${setupRes.status} ${await setupRes.text()}`);
  }
  const aliceBody = (await setupRes.json()) as {
    token: string;
    user: { id: number };
  };
  alice = {
    id: aliceBody.user.id,
    email: 'alice@test.local',
    token: aliceBody.token,
  };

  const bobHash = await hashPassword('password-bbbbbb');
  const bobRow = await db
    .prepare(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES (?, ?, ?, 'user') RETURNING id`,
    )
    .bind('bob@test.local', bobHash, 'Bob')
    .first<{ id: number }>();
  if (!bobRow) throw new Error('failed to seed bob');

  const bobToken = await signToken(
    { id: bobRow.id, email: 'bob@test.local', role: 'user' },
    JWT_SECRET,
    JWT_ISSUER,
  );
  bob = { id: bobRow.id, email: 'bob@test.local', token: bobToken };
});

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------
function authHeaders(user: TestUser): HeadersInit {
  return {
    Authorization: `Bearer ${user.token}`,
    'Content-Type': 'application/json',
  };
}

async function push(user: TestUser, body: unknown): Promise<Response> {
  return fetchApp(
    new Request('http://test/sync/push', {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify(body),
    }),
  );
}

interface PullResponse {
  conversations: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  server_time: number;
}

async function pull(user: TestUser, since = 0): Promise<PullResponse> {
  const res = await fetchApp(
    new Request(`http://test/sync/pull?since=${since}`, {
      headers: { Authorization: `Bearer ${user.token}` },
    }),
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<PullResponse>;
}

// -----------------------------------------------------------------------------
// Fixture factories. Return plain JSON-ready objects so tests can spread over
// them for LWW / validation overrides.
// -----------------------------------------------------------------------------
function makeConv(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  return {
    id: 'conv-1',
    title: 'Hello',
    mode: 'chat',
    pinned: false,
    starred: false,
    modelId: 'deepseek-chat',
    projectId: null,
    summary: null,
    summaryMessageCount: null,
    summarizedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    messages: [
      { id: 'm1', role: 'user', content: 'hi', createdAt: now },
      {
        id: 'm2',
        role: 'assistant',
        content: 'hello back',
        reasoning: 'short thought',
        createdAt: now + 1,
      },
    ],
    ...overrides,
  };
}

function makeProject(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  return {
    id: 'proj-1',
    name: 'Research',
    description: 'my project',
    instructions: 'be concise',
    sources: [{ type: 'text', content: 'a note' }],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<Record<string, unknown>> = {}) {
  const now = Date.now();
  return {
    id: 'art-1',
    messageId: 'm2',
    type: 'code',
    title: 'snippet',
    language: 'ts',
    content: 'export const x = 1;',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

// =============================================================================
// Auth
// =============================================================================
describe('auth', () => {
  it('/setup returns 403 after bootstrap is complete', async () => {
    const res = await fetchApp(
      new Request('http://test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'intruder@test.local',
          password: 'password-xxxxxx',
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('/auth/login succeeds with correct password', async () => {
    const res = await fetchApp(
      new Request('http://test/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@test.local',
          password: 'password-aaaaaa',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { role: string } };
    expect(body.token).toBeTruthy();
    expect(body.user.role).toBe('admin');
  });

  it('/auth/login returns 401 on wrong password', async () => {
    const res = await fetchApp(
      new Request('http://test/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'alice@test.local',
          password: 'WRONG-password',
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('/auth/login returns 403 for a disabled user', async () => {
    await env.DB.prepare('UPDATE users SET disabled = 1 WHERE id = ?')
      .bind(bob.id)
      .run();
    const res = await fetchApp(
      new Request('http://test/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'bob@test.local',
          password: 'password-bbbbbb',
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('/sync/pull returns 401 without a bearer token', async () => {
    const res = await fetchApp(new Request('http://test/sync/pull?since=0'));
    expect(res.status).toBe(401);
  });

  it('/sync/pull returns 401 with a garbage token', async () => {
    const res = await fetchApp(
      new Request('http://test/sync/pull?since=0', {
        headers: { Authorization: 'Bearer not-a-real-token' },
      }),
    );
    expect(res.status).toBe(401);
  });

  // These two pin down the admin.use('/admin/*', ...) scope. Earlier the
  // admin sub-app used `use('*', requireAdmin)` which, because admin is
  // mounted at '/', matched every request — non-admin users were getting
  // 'admin only' 403s on /sync/pull. Lock the correct behaviour in.
  it('admin routes require admin role: bob → 403', async () => {
    const res = await fetchApp(
      new Request('http://test/admin/users', {
        headers: { Authorization: `Bearer ${bob.token}` },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('admin only');
  });

  it('admin routes allow admin role: alice → 200', async () => {
    const res = await fetchApp(
      new Request('http://test/admin/users', {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[] };
    expect(Array.isArray(body.users)).toBe(true);
  });
});

// =============================================================================
// Conversation sync round-trip + LWW + tombstones
// =============================================================================
describe('conversations sync', () => {
  it('round-trips a conversation with messages', async () => {
    const conv = makeConv();
    const res = await push(alice, { upserts: [conv] });
    expect(res.status).toBe(200);

    const pulled = await pull(alice, 0);
    expect(pulled.conversations).toHaveLength(1);
    const got = pulled.conversations[0] as Record<string, unknown> & {
      messages: Array<{ id: string; content: string; reasoning?: string | null }>;
    };
    expect(got.id).toBe('conv-1');
    expect(got.title).toBe('Hello');
    expect(got.modelId).toBe('deepseek-chat');
    expect(got.messages).toHaveLength(2);
    expect(got.messages[0].content).toBe('hi');
    expect(got.messages[1].reasoning).toBe('short thought');
  });

  it('pull with since >= server_time returns empty', async () => {
    await push(alice, { upserts: [makeConv()] });
    const firstPull = await pull(alice, 0);
    const secondPull = await pull(alice, firstPull.server_time);
    expect(secondPull.conversations).toHaveLength(0);
  });

  it('LWW: a stale upsert does NOT overwrite a newer server row', async () => {
    const now = Date.now();
    await push(alice, {
      upserts: [makeConv({ title: 'Fresh', updatedAt: now + 1000 })],
    });
    const staleRes = await push(alice, {
      upserts: [makeConv({ title: 'Stale', updatedAt: now })],
    });
    expect(staleRes.status).toBe(200); // skip is silent

    const pulled = await pull(alice, 0);
    expect(pulled.conversations).toHaveLength(1);
    expect((pulled.conversations[0] as { title: string }).title).toBe('Fresh');
  });

  it('LWW: a newer upsert DOES overwrite the existing row', async () => {
    const now = Date.now();
    await push(alice, { upserts: [makeConv({ title: 'Old', updatedAt: now })] });
    await push(alice, {
      upserts: [makeConv({ title: 'New', updatedAt: now + 1000 })],
    });
    const pulled = await pull(alice, 0);
    expect((pulled.conversations[0] as { title: string }).title).toBe('New');
  });

  it('tombstones: deletions[] soft-deletes and the row returns as tombstone on next pull', async () => {
    await push(alice, { upserts: [makeConv()] });
    await push(alice, { deletions: ['conv-1'] });

    const pulled = await pull(alice, 0);
    expect(pulled.conversations).toHaveLength(1);
    const tomb = pulled.conversations[0] as {
      deletedAt: number | null;
      messages: unknown[];
    };
    expect(typeof tomb.deletedAt).toBe('number');
    expect(tomb.deletedAt! > 0).toBe(true);
    // Tombstoned rows don't ship their messages — client drops the whole
    // conv locally anyway.
    expect(tomb.messages).toEqual([]);
  });

  it('cross-user isolation: alice pushes, bob sees nothing', async () => {
    await push(alice, { upserts: [makeConv()] });
    const bobPull = await pull(bob, 0);
    expect(bobPull.conversations).toHaveLength(0);
  });

  it("cross-user tombstone: bob cannot delete alice's conversation", async () => {
    await push(alice, { upserts: [makeConv()] });
    const bobDelete = await push(bob, { deletions: ['conv-1'] });
    expect(bobDelete.status).toBe(200);
    const alicePull = await pull(alice, 0);
    expect(alicePull.conversations).toHaveLength(1);
    expect(
      (alicePull.conversations[0] as { deletedAt: number | null }).deletedAt,
    ).toBeNull();
  });

  it('validates: conversation without id → 400', async () => {
    const bad = makeConv() as Record<string, unknown>;
    delete bad.id;
    const res = await push(alice, { upserts: [bad] });
    expect(res.status).toBe(400);
  });

  it('validates: too many conversations in one push → 413', async () => {
    const many = Array.from({ length: 201 }, (_, i) =>
      makeConv({ id: `conv-${i}`, messages: [] }),
    );
    const res = await push(alice, { upserts: many });
    expect(res.status).toBe(413);
  });
});

// =============================================================================
// Projects
// =============================================================================
describe('projects sync', () => {
  it('round-trips a project with opaque sources JSON', async () => {
    const proj = makeProject();
    const res = await push(alice, { projectUpserts: [proj] });
    expect(res.status).toBe(200);

    const pulled = await pull(alice, 0);
    expect(pulled.projects).toHaveLength(1);
    const got = pulled.projects[0] as {
      name: string;
      sources: unknown;
      instructions: string | null;
    };
    expect(got.name).toBe('Research');
    expect(got.instructions).toBe('be concise');
    expect(got.sources).toEqual([{ type: 'text', content: 'a note' }]);
  });

  it('LWW: stale project upsert ignored', async () => {
    const now = Date.now();
    await push(alice, {
      projectUpserts: [makeProject({ name: 'Fresh', updatedAt: now + 1000 })],
    });
    await push(alice, {
      projectUpserts: [makeProject({ name: 'Stale', updatedAt: now })],
    });
    const pulled = await pull(alice, 0);
    expect((pulled.projects[0] as { name: string }).name).toBe('Fresh');
  });

  it('projectDeletions soft-deletes and pull returns the tombstone', async () => {
    await push(alice, { projectUpserts: [makeProject()] });
    await push(alice, { projectDeletions: ['proj-1'] });
    const pulled = await pull(alice, 0);
    expect(pulled.projects).toHaveLength(1);
    expect(
      typeof (pulled.projects[0] as { deletedAt: number | null }).deletedAt,
    ).toBe('number');
  });

  it("cross-user isolation: alice's projects are invisible to bob", async () => {
    await push(alice, { projectUpserts: [makeProject()] });
    const bobPull = await pull(bob, 0);
    expect(bobPull.projects).toHaveLength(0);
  });
});

// =============================================================================
// Artifacts
// =============================================================================
describe('artifacts sync', () => {
  it('round-trips an artifact', async () => {
    const art = makeArtifact();
    const res = await push(alice, { artifactUpserts: [art] });
    expect(res.status).toBe(200);

    const pulled = await pull(alice, 0);
    expect(pulled.artifacts).toHaveLength(1);
    const got = pulled.artifacts[0] as {
      title: string;
      language: string | null;
      content: string;
    };
    expect(got.title).toBe('snippet');
    expect(got.language).toBe('ts');
    expect(got.content).toBe('export const x = 1;');
  });

  it('LWW: stale artifact upsert ignored', async () => {
    const now = Date.now();
    await push(alice, {
      artifactUpserts: [makeArtifact({ title: 'Fresh', updatedAt: now + 1000 })],
    });
    await push(alice, {
      artifactUpserts: [makeArtifact({ title: 'Stale', updatedAt: now })],
    });
    const pulled = await pull(alice, 0);
    expect((pulled.artifacts[0] as { title: string }).title).toBe('Fresh');
  });

  it('tombstoned artifact has empty content on pull (bandwidth saver)', async () => {
    await push(alice, { artifactUpserts: [makeArtifact()] });
    await push(alice, { artifactDeletions: ['art-1'] });

    const pulled = await pull(alice, 0);
    expect(pulled.artifacts).toHaveLength(1);
    const tomb = pulled.artifacts[0] as {
      deletedAt: number | null;
      content: string;
    };
    expect(typeof tomb.deletedAt).toBe('number');
    // sync.ts deliberately ships '' for tombstones — we know the client is
    // dropping the row, no point paying bytes for the old content.
    expect(tomb.content).toBe('');
  });

  it('cross-user isolation: artifacts', async () => {
    await push(alice, { artifactUpserts: [makeArtifact()] });
    const bobPull = await pull(bob, 0);
    expect(bobPull.artifacts).toHaveLength(0);
  });
});
