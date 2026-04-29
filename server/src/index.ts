/**
 * Flaude Worker entry point.
 *
 * Routes live here if they're tiny (auth) or are mounted from sibling files
 * when they're bigger (chat proxy).
 *
 *   POST /setup                          — one-time admin bootstrap; 403s after it runs.
 *   POST /auth/login                     — email+password -> JWT.
 *   POST /auth/logout                    — no-op server-side; client-side convention.
 *   GET  /auth/me                        — current user; auth smoke test.
 *   GET  /usage                          — this-month token usage + quota.
 *   POST /v1/chat/completions            — OpenAI-compatible LLM proxy with accounting.
 *   POST /tools/web_search               — 博查 web search proxy (shared server key).
 *   GET  /admin/users                    — list users with current-month usage.
 *   POST /admin/users                    — create user (admin-only).
 *   PATCH /admin/users/:id               — update disabled / role / quota / name.
 *   POST /admin/users/:id/password       — admin-initiated password reset.
 *   GET  /sync/pull                      — conversations+messages since <ts>.
 *   POST /sync/push                      — bulk upsert conversations + tombstone deletions.
 *
 * Cron (see wrangler.toml [triggers]):
 *   @daily 03:17 UTC — purge conversations soft-deleted more than 90 days ago.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import admin from './admin';
import {
  DUMMY_BCRYPT_HASH,
  hashPassword,
  signToken,
  verifyPassword,
} from './auth';
import chat from './chat';
import type { AppContext, Env } from './env';
import imageProxy from './imageProxy';
import mcpDemo from './mcpDemo';
import mcpsSearch from './mcpsSearch';
import { requireAuth } from './middleware';
import skillsBundle from './skillsBundle';
import skillsSearch from './skillsSearch';
import sync from './sync';
import tools from './tools';

const app = new Hono<AppContext>();

// -----------------------------------------------------------------------------
// Global middleware
// -----------------------------------------------------------------------------
app.use('*', logger());

// CORS: the Tauri client sends Origin: tauri://localhost (on Windows it's
// https://tauri.localhost), and the future web client sends its deployed
// origin. For a 5-10 user deployment we accept any origin and rely on the
// Bearer token for auth — locking origins down buys little when tokens are
// the actual gate.
app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
    credentials: false, // we use Bearer headers, not cookies
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
    maxAge: 86400,
  }),
);

// -----------------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------------
app.get('/', (c) =>
  c.json({
    name: 'flaude-server',
    env: c.env.APP_ENV,
    ok: true,
  }),
);

// -----------------------------------------------------------------------------
// POST /setup
// One-time admin bootstrap. Allowed only when users table is empty. After
// the first admin exists, returns 403 forever — further users must be
// created via the (Phase 5) admin dashboard.
// -----------------------------------------------------------------------------
interface SetupBody {
  email?: unknown;
  password?: unknown;
  display_name?: unknown;
}

app.post('/setup', async (c) => {
  const countRow = await c.env.DB
    .prepare('SELECT COUNT(*) as n FROM users')
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) > 0) {
    return c.json({ error: 'setup already complete' }, 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as SetupBody;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName =
    typeof body.display_name === 'string' && body.display_name.trim()
      ? body.display_name.trim()
      : email.split('@')[0];

  if (!email.includes('@') || email.length > 254) {
    return c.json({ error: 'invalid email' }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: 'password must be at least 8 characters' }, 400);
  }

  const hash = await hashPassword(password);

  // Race: another request could sneak in between the COUNT and the INSERT.
  // The UNIQUE constraint on email + the CHECK on role won't save us from
  // a second admin getting created; in practice this is a one-shot bootstrap
  // from a single operator, so we accept the risk. If it becomes a real
  // concern later, wrap in a transaction with `WHERE NOT EXISTS (SELECT 1
  // FROM users)`.
  const result = await c.env.DB
    .prepare(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES (?, ?, ?, 'admin')
       RETURNING id`,
    )
    .bind(email, hash, displayName)
    .first<{ id: number }>();

  if (!result) {
    return c.json({ error: 'failed to create admin' }, 500);
  }

  const token = await signToken(
    { id: result.id, email, role: 'admin' },
    c.env.JWT_SECRET,
    c.env.JWT_ISSUER,
  );

  return c.json({
    token,
    user: {
      id: result.id,
      email,
      display_name: displayName,
      role: 'admin' as const,
    },
  });
});

// -----------------------------------------------------------------------------
// POST /auth/login
// -----------------------------------------------------------------------------
interface LoginBody {
  email?: unknown;
  password?: unknown;
}

app.post('/auth/login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as LoginBody;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return c.json({ error: 'email and password required' }, 400);
  }

  const row = await c.env.DB
    .prepare(
      `SELECT id, email, password_hash, display_name, role, disabled
       FROM users WHERE email = ?`,
    )
    .bind(email)
    .first<{
      id: number;
      email: string;
      password_hash: string;
      display_name: string;
      role: 'admin' | 'user';
      disabled: number;
    }>();

  // Always run verifyPassword, even if user is missing, to equalize timing.
  const hashToCheck = row?.password_hash ?? DUMMY_BCRYPT_HASH;
  const ok = await verifyPassword(password, hashToCheck);

  if (!row || !ok) {
    return c.json({ error: 'invalid credentials' }, 401);
  }
  if (row.disabled) {
    // Different from "invalid credentials" on purpose — admin disabling
    // someone should produce an explicit message, not look like a typo.
    return c.json({ error: 'account disabled' }, 403);
  }

  const token = await signToken(
    { id: row.id, email: row.email, role: row.role },
    c.env.JWT_SECRET,
    c.env.JWT_ISSUER,
  );

  return c.json({
    token,
    user: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
    },
  });
});

// -----------------------------------------------------------------------------
// POST /auth/logout
// With stateless JWTs there's nothing to invalidate server-side. This
// endpoint exists so the client has one URL to POST to for "I'm done".
// If we add a token blacklist later, it plugs in here without any client
// changes.
// -----------------------------------------------------------------------------
app.post('/auth/logout', (c) => c.json({ ok: true }));

// -----------------------------------------------------------------------------
// GET /auth/me
// -----------------------------------------------------------------------------
app.get('/auth/me', requireAuth, async (c) => {
  const row = await c.env.DB
    .prepare(
      `SELECT id, email, display_name, role, monthly_quota_tokens, created_at
       FROM users WHERE id = ?`,
    )
    .bind(c.get('userId'))
    .first();

  if (!row) {
    return c.json({ error: 'user not found' }, 404);
  }
  return c.json({ user: row });
});

// -----------------------------------------------------------------------------
// MCP demo endpoint (./mcpDemo.ts). Public — no auth.
//
// IMPORTANT: must be mounted BEFORE the auth-gated sub-apps. Hono evaluates
// route registrations in order, and `chat.use('*', requireAuth)` would
// short-circuit any request that walks into the chat sub-app — even ones
// that *would* match a later sub-app's route, because the auth middleware
// runs before the (failed) sub-app route lookup falls through. By
// registering this open route first, /mcp/echo is matched + handled before
// the chat sub-app gets a chance to 401 it.
//
//   POST /mcp/echo   — minimal MCP HTTP server with one `echo` tool.
// -----------------------------------------------------------------------------
app.route('/', mcpDemo);

// -----------------------------------------------------------------------------
// Skills marketplace federated search (./skillsSearch.ts).
//   GET /api/skills/search?q=<keyword>
//
// Same mount-order rule as mcpDemo: must come before chat's '*' middleware
// so the path-specific requireAuth inside skillsSearch is what gates this
// endpoint, not chat's blanket auth (which would fire first and 401 us).
// -----------------------------------------------------------------------------
app.route('/', skillsSearch);

// -----------------------------------------------------------------------------
// MCP marketplace federated search (./mcpsSearch.ts).
//   GET /api/mcps/search?q=<keyword>
//
// Federates 4 sources: PulseMCP / Glama / npm registry / GitHub Code Search.
// Same mount-before-chat rule as siblings above.
// -----------------------------------------------------------------------------
app.route('/', mcpsSearch);

// -----------------------------------------------------------------------------
// Skills folder-bundle fetch (./skillsBundle.ts).
//   GET /api/skills/fetch-bundle?rawUrl=<encoded SKILL.md raw URL>
//
// Walks the repo tree, returns SKILL.md + sibling text files in one shot
// so the client can install a skill folder (templates/scripts/config) in
// a single network round-trip. Same mount-before-chat rule.
// -----------------------------------------------------------------------------
app.route('/', skillsBundle);

// -----------------------------------------------------------------------------
// Image proxy (./imageProxy.ts).
//   GET /api/image/<sha256>.<ext>
//
// Public read endpoint for R2-mirrored generated images. Mounted before
// chat so requireAuth (which is wired inside the chat sub-app's '*'
// middleware) doesn't gate <img> requests — the design canvas iframe
// is null-origin and won't carry a Bearer token. The URL is content-
// addressable so leaking it leaks the bytes (which the user generated
// + chose to embed in their design), not a credential.
// -----------------------------------------------------------------------------
app.route('/', imageProxy);

// -----------------------------------------------------------------------------
// Chat proxy + /usage (mounted from ./chat.ts — requireAuth is applied inside
// that sub-app so we don't have to duplicate it here).
// -----------------------------------------------------------------------------
app.route('/', chat);

// -----------------------------------------------------------------------------
// Tool proxies (mounted from ./tools.ts).
//   POST /tools/web_search   — 博查 search proxy with shared server key.
// -----------------------------------------------------------------------------
app.route('/', tools);

// -----------------------------------------------------------------------------
// Admin routes (mounted from ./admin.ts — requireAuth + requireAdmin applied
// inside that sub-app).
//   GET    /admin/users
//   POST   /admin/users
//   PATCH  /admin/users/:id
//   POST   /admin/users/:id/password
// -----------------------------------------------------------------------------
app.route('/', admin);

// -----------------------------------------------------------------------------
// Sync routes (mounted from ./sync.ts — requireAuth applied inside that
// sub-app). These carry the full conversation history round-trip.
//   GET   /sync/pull
//   POST  /sync/push
// -----------------------------------------------------------------------------
app.route('/', sync);

// -----------------------------------------------------------------------------
// 404 + error fallback
// -----------------------------------------------------------------------------
app.notFound((c) => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  console.error('[onError]', err);
  return c.json({ error: 'internal error' }, 500);
});

// -----------------------------------------------------------------------------
// Scheduled handler (cron trigger from wrangler.toml).
//
// Runs daily to hard-delete any conversations that were soft-deleted >90 days
// ago. Messages cascade via the FK ON DELETE. 90d is chosen so:
//   - A user who accidentally deletes a conversation has time to notice on
//     whichever device they mostly use.
//   - Clients that have been offline for weeks (vacation, broken laptop) still
//     receive the tombstone on their next pull and clear their local copy,
//     rather than having it silently resurrect.
// If you raise this past what a client's pull cursor covers, tombstoned rows
// start coming back on old clients — pick a window strictly longer than any
// reasonable offline period.
// -----------------------------------------------------------------------------
const SOFT_DELETE_GRACE_MS = 90 * 24 * 60 * 60 * 1000;

async function purgeTombstones(env: Env): Promise<{ deleted: number }> {
  const cutoff = Date.now() - SOFT_DELETE_GRACE_MS;
  const result = await env.DB
    .prepare(
      `DELETE FROM conversations
       WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
    )
    .bind(cutoff)
    .run();
  // D1 returns meta.changes on run(); type-wise it's loose, narrow defensively.
  const deleted = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  console.log(`[scheduled] purged ${deleted} tombstoned conversations older than 90d`);
  return { deleted };
}

// Hono's `app` is itself a fetch handler, so we wrap both `fetch` and
// `scheduled` into the default export shape Cloudflare Workers expects.
// Without this, wrangler registers only `fetch` and the cron trigger silently
// no-ops.
export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // waitUntil so a slow D1 DELETE doesn't get cut off when the scheduled
    // function returns — it's fire-and-forget from CF's perspective.
    ctx.waitUntil(purgeTombstones(env));
  },
};
