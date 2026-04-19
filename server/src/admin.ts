/**
 * Admin routes — user CRUD + quota management.
 *
 * For a friends-group deployment (5-10 users, no self-signup), the admin
 * dashboard is the only way new users get in and the primary lever for
 * dealing with abuse / rebalancing quota. Everything here requires an
 * authenticated admin; that's enforced at the sub-app level so we can't
 * accidentally ship a public admin route.
 *
 * Routes:
 *   GET    /admin/users               — list users + current-month usage
 *   POST   /admin/users               — create user
 *   PATCH  /admin/users/:id           — update disabled / role / display_name
 *                                       / monthly_quota_tokens
 *   POST   /admin/users/:id/password  — reset password
 *
 * Self-modification guard:
 *   Admins can edit most of their own fields, but not `disabled` or `role`.
 *   If the sole admin disabled or demoted themselves, they'd be locked out
 *   of admin forever (no self-signup). We fail these with 400 and let the
 *   UI hide the controls for the self-row; server enforcement is the real
 *   gate.
 *
 * We don't implement DELETE: usage_log ON DELETE CASCADE would wipe
 * historical rows, which is never what the operator actually wants. `disabled=1`
 * + `monthly_quota_tokens=0` is functionally equivalent and reversible.
 */
import { Hono } from 'hono';

import { hashPassword } from './auth';
import type { AppContext } from './env';
import { requireAdmin, requireAuth } from './middleware';
import { currentPeriodBounds } from './usage';

const admin = new Hono<AppContext>();

// Order matters: requireAuth populates c.get('userRole'); requireAdmin reads it.
admin.use('*', requireAuth);
admin.use('*', requireAdmin);

// -----------------------------------------------------------------------------
// GET /admin/users
//   Returns all users joined against this month's usage in a single query so
//   the dashboard can render a table without N+1ing the DB. We LEFT JOIN so
//   users with zero usage this month still appear.
// -----------------------------------------------------------------------------
interface UserListRow {
  id: number;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  disabled: number;
  monthly_quota_tokens: number | null;
  created_at: number;
  used_tokens: number; // SUM of this month's total_tokens, 0 if none
}

admin.get('/admin/users', async (c) => {
  const { start } = currentPeriodBounds();
  const { results } = await c.env.DB
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.disabled,
              u.monthly_quota_tokens, u.created_at,
              COALESCE(SUM(CASE WHEN l.ts >= ? THEN l.total_tokens END), 0) AS used_tokens
       FROM users u
       LEFT JOIN usage_log l ON l.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at ASC`,
    )
    .bind(start)
    .all<UserListRow>();

  // Env default is surfaced so the client can show "quota: <n> (default)"
  // instead of "(unset)" for users who don't have a per-user override.
  const envDefault = parseInt(c.env.MONTHLY_QUOTA_TOKENS, 10);

  return c.json({
    users: results,
    period_start: start,
    env_default_quota: Number.isFinite(envDefault) && envDefault > 0
      ? envDefault
      : 300_000,
  });
});

// -----------------------------------------------------------------------------
// POST /admin/users
//   Create a new user. Admin supplies initial password out-of-band; we just
//   hash and insert. Returns the new row (minus password hash) so the UI can
//   slot it into the table without a refetch.
// -----------------------------------------------------------------------------
interface CreateUserBody {
  email?: unknown;
  password?: unknown;
  display_name?: unknown;
  role?: unknown;
  monthly_quota_tokens?: unknown;
}

admin.post('/admin/users', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateUserBody;

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName =
    typeof body.display_name === 'string' && body.display_name.trim()
      ? body.display_name.trim()
      : email.split('@')[0];
  const role: 'admin' | 'user' =
    body.role === 'admin' ? 'admin' : 'user';

  // Quota: null = fall back to env default. Admin can explicitly set 0
  // to disable LLM access without flipping the disabled flag, which is
  // useful for "keep the account alive but no new spending this month".
  let quota: number | null = null;
  if (body.monthly_quota_tokens !== undefined && body.monthly_quota_tokens !== null) {
    const n = Number(body.monthly_quota_tokens);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return c.json({ error: 'monthly_quota_tokens must be a non-negative integer' }, 400);
    }
    quota = n;
  }

  if (!email.includes('@') || email.length > 254) {
    return c.json({ error: 'invalid email' }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: 'password must be at least 8 characters' }, 400);
  }

  const hash = await hashPassword(password);

  let result;
  try {
    result = await c.env.DB
      .prepare(
        `INSERT INTO users (email, password_hash, display_name, role, monthly_quota_tokens)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id, email, display_name, role, disabled, monthly_quota_tokens, created_at`,
      )
      .bind(email, hash, displayName, role, quota)
      .first<{
        id: number;
        email: string;
        display_name: string;
        role: 'admin' | 'user';
        disabled: number;
        monthly_quota_tokens: number | null;
        created_at: number;
      }>();
  } catch (err) {
    // SQLite UNIQUE violation on email. D1 surfaces this as a message
    // containing "UNIQUE constraint failed"; we don't have a structured
    // error code to branch on.
    const msg = (err as Error).message ?? '';
    if (/UNIQUE/i.test(msg)) {
      return c.json({ error: '邮箱已被注册' }, 409);
    }
    throw err;
  }

  if (!result) {
    return c.json({ error: 'failed to create user' }, 500);
  }

  return c.json({ user: { ...result, used_tokens: 0 } }, 201);
});

// -----------------------------------------------------------------------------
// PATCH /admin/users/:id
//   Partial update. Only the fields present in the body are touched, so the
//   UI can send { disabled: 1 } without having to re-send the whole row.
// -----------------------------------------------------------------------------
interface PatchUserBody {
  disabled?: unknown;
  role?: unknown;
  display_name?: unknown;
  monthly_quota_tokens?: unknown;
}

admin.patch('/admin/users/:id', async (c) => {
  const targetId = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(targetId)) {
    return c.json({ error: 'invalid id' }, 400);
  }
  const selfId = c.get('userId');
  const body = (await c.req.json().catch(() => ({}))) as PatchUserBody;

  // Collect only the fields that were actually present in the request,
  // validated. SQL is built dynamically so unspecified fields stay put.
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (body.disabled !== undefined) {
    if (targetId === selfId) {
      return c.json({ error: '不能禁用自己的账户' }, 400);
    }
    const flag = body.disabled ? 1 : 0;
    sets.push('disabled = ?');
    binds.push(flag);
  }

  if (body.role !== undefined) {
    if (targetId === selfId) {
      return c.json({ error: '不能改自己的角色' }, 400);
    }
    if (body.role !== 'admin' && body.role !== 'user') {
      return c.json({ error: 'role must be "admin" or "user"' }, 400);
    }
    sets.push('role = ?');
    binds.push(body.role);
  }

  if (body.display_name !== undefined) {
    if (typeof body.display_name !== 'string' || !body.display_name.trim()) {
      return c.json({ error: 'display_name must be a non-empty string' }, 400);
    }
    sets.push('display_name = ?');
    binds.push(body.display_name.trim());
  }

  if (body.monthly_quota_tokens !== undefined) {
    // null = clear override, fall back to env default
    if (body.monthly_quota_tokens === null) {
      sets.push('monthly_quota_tokens = NULL');
    } else {
      const n = Number(body.monthly_quota_tokens);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        return c.json({ error: 'monthly_quota_tokens must be a non-negative integer or null' }, 400);
      }
      sets.push('monthly_quota_tokens = ?');
      binds.push(n);
    }
  }

  if (sets.length === 0) {
    return c.json({ error: 'no fields to update' }, 400);
  }

  // Bump updated_at every time so the UI can show last-modified if it wants.
  sets.push('updated_at = unixepoch()');
  binds.push(targetId);

  const row = await c.env.DB
    .prepare(
      `UPDATE users SET ${sets.join(', ')} WHERE id = ?
       RETURNING id, email, display_name, role, disabled, monthly_quota_tokens, created_at`,
    )
    .bind(...binds)
    .first();

  if (!row) {
    return c.json({ error: 'user not found' }, 404);
  }
  return c.json({ user: row });
});

// -----------------------------------------------------------------------------
// POST /admin/users/:id/password
//   Admin-initiated password reset. Admin types the new password in the UI
//   and communicates it to the user out-of-band (Telegram/WeChat). No email
//   flow — the scale doesn't warrant SES/SendGrid yet.
// -----------------------------------------------------------------------------
interface ResetPasswordBody {
  password?: unknown;
}

admin.post('/admin/users/:id/password', async (c) => {
  const targetId = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(targetId)) {
    return c.json({ error: 'invalid id' }, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as ResetPasswordBody;
  const password = typeof body.password === 'string' ? body.password : '';

  if (password.length < 8) {
    return c.json({ error: 'password must be at least 8 characters' }, 400);
  }

  const hash = await hashPassword(password);

  const row = await c.env.DB
    .prepare(
      `UPDATE users SET password_hash = ?, updated_at = unixepoch()
       WHERE id = ?
       RETURNING id`,
    )
    .bind(hash, targetId)
    .first<{ id: number }>();

  if (!row) {
    return c.json({ error: 'user not found' }, 404);
  }

  // We intentionally don't invalidate outstanding JWTs here — with stateless
  // tokens there's no blacklist. A reset-then-impersonate attack requires the
  // attacker to already hold an admin JWT and the target's old one, which
  // means they have bigger problems. If this matters later, rotate JWT_SECRET
  // to force a global logout (all users, including admin).
  return c.json({ ok: true });
});

export default admin;
