/**
 * DELETE /admin/users/:id integration tests.
 *
 * Covers the guards and cascading delete behavior:
 *   - admin can delete a regular user → 200 + cascade wipes their data
 *   - admin cannot delete another admin → 403
 *   - admin cannot delete themselves → 400
 *   - delete of non-existent user → 404
 *   - non-admin user cannot reach the endpoint → 403 (admin gate)
 *
 * Drives the full Hono app via `app.fetch` against an in-memory D1 shim,
 * so it exercises the real route + middleware + JWT verify + SQL stack.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { hashPassword, signToken } from '../src/auth';
import type { Env } from '../src/env';
import worker from '../src/index';
import { createTestD1 } from './d1Shim';
import { applySchema } from './schema';

const JWT_SECRET = 'test-jwt-secret-at-least-32-bytes-long-for-HS256-use';
const JWT_ISSUER = 'flaude-test';

interface SeededUser {
  id: number;
  email: string;
  token: string;
}

function stubCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

let env: Env;
let admin1: SeededUser; // primary admin (the actor)
let admin2: SeededUser; // a second admin (delete target — should be blocked)
let alice: SeededUser; // regular user (delete target — should succeed)

async function fetchApp(req: Request): Promise<Response> {
  return worker.fetch(req, env, stubCtx());
}

async function seedUser(
  email: string,
  role: 'admin' | 'user',
): Promise<SeededUser> {
  const hash = await hashPassword('password-aaaaaa');
  const result = await env.DB
    .prepare(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES (?, ?, ?, ?) RETURNING id`,
    )
    .bind(email, hash, email.split('@')[0]!, role)
    .first<{ id: number }>();
  const id = result!.id;
  const token = await signToken(
    { id, email, role },
    JWT_SECRET,
    JWT_ISSUER,
  );
  return { id, email, token };
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

  admin1 = await seedUser('admin1@test.local', 'admin');
  admin2 = await seedUser('admin2@test.local', 'admin');
  alice = await seedUser('alice@test.local', 'user');
});

function deleteReq(targetId: number, actorToken: string): Request {
  return new Request(`http://test/admin/users/${targetId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${actorToken}` },
  });
}

describe('DELETE /admin/users/:id', () => {
  it('admin can delete a regular user', async () => {
    const res = await fetchApp(deleteReq(alice.id, admin1.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deleted_id: number };
    expect(body.ok).toBe(true);
    expect(body.deleted_id).toBe(alice.id);

    // Row really gone.
    const row = await env.DB
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(alice.id)
      .first();
    expect(row).toBeNull();
  });

  it('cascade wipes the deleted user\'s conversations + messages + usage_log', async () => {
    // Seed a conversation, a message, and a usage_log row for alice.
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO conversations (id, user_id, title, mode, created_at, updated_at)
         VALUES ('conv-1', ?, 'hi', 'chat', ?, ?)`,
      )
      .bind(alice.id, now, now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, created_at)
         VALUES ('msg-1', 'conv-1', 'user', 'hello', ?)`,
      )
      .bind(now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO usage_log (user_id, model, prompt_tokens, completion_tokens, total_tokens)
         VALUES (?, 'deepseek-chat', 10, 20, 30)`,
      )
      .bind(alice.id)
      .run();

    const res = await fetchApp(deleteReq(alice.id, admin1.token));
    expect(res.status).toBe(200);

    // FK CASCADE should have wiped all of alice's rows from every table.
    for (const sql of [
      'SELECT id FROM conversations WHERE user_id = ?',
      'SELECT id FROM messages WHERE conversation_id = ?',
      'SELECT id FROM usage_log WHERE user_id = ?',
    ]) {
      const param = sql.includes('messages') ? 'conv-1' : alice.id;
      const row = await env.DB.prepare(sql).bind(param).first();
      expect(row).toBeNull();
    }
  });

  it('refuses to delete another admin (403)', async () => {
    const res = await fetchApp(deleteReq(admin2.id, admin1.token));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/管理员/);

    // admin2 still exists.
    const row = await env.DB
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(admin2.id)
      .first();
    expect(row).toBeTruthy();
  });

  it('refuses to delete self (400)', async () => {
    const res = await fetchApp(deleteReq(admin1.id, admin1.token));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/自己/);
  });

  it('returns 404 for a non-existent user', async () => {
    const res = await fetchApp(deleteReq(99999, admin1.token));
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-numeric user id', async () => {
    const res = await fetchApp(
      new Request('http://test/admin/users/abc', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${admin1.token}` },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('non-admin (regular user) cannot reach the endpoint (403 from admin gate)', async () => {
    const res = await fetchApp(deleteReq(admin2.id, alice.token));
    expect(res.status).toBe(403);
  });

  it('unauthenticated request returns 401 (auth gate fires before admin gate)', async () => {
    const res = await fetchApp(
      new Request(`http://test/admin/users/${alice.id}`, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(401);
  });
});
