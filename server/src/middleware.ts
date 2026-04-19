/**
 * Auth middleware.
 *
 * requireAuth  — verifies JWT, loads fresh user row, stashes (id, role, email)
 *                on the Hono context for downstream handlers.
 * requireAdmin — chains after requireAuth, 403s if role != 'admin'.
 *
 * We re-read the users row on every request (rather than trusting the JWT
 * claims) so that disabling a user via the DB takes effect immediately, even
 * if they still hold a non-expired token. The cost is one indexed PK lookup
 * per request — fine at our scale, and D1 caches hot rows anyway.
 */
import type { Context, MiddlewareHandler } from 'hono';

import { verifyToken } from './auth';
import type { AppContext } from './env';

interface UserRow {
  id: number;
  email: string;
  role: 'admin' | 'user';
  disabled: number;
}

function extractBearer(c: Context<AppContext>): string | null {
  const header = c.req.header('Authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token.trim();
}

export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = extractBearer(c);
  if (!token) {
    return c.json({ error: 'missing bearer token' }, 401);
  }

  let payload;
  try {
    payload = await verifyToken(token, c.env.JWT_SECRET, c.env.JWT_ISSUER);
  } catch {
    // Don't echo the specific failure reason — bad signature vs. expired vs.
    // issuer mismatch all look the same to the client to avoid helping
    // attackers probe our setup.
    return c.json({ error: 'invalid token' }, 401);
  }

  const row = await c.env.DB
    .prepare('SELECT id, email, role, disabled FROM users WHERE id = ?')
    .bind(payload.sub)
    .first<UserRow>();

  if (!row) {
    // Token is valid but the user has been deleted. Treat as logged-out.
    return c.json({ error: 'user not found' }, 401);
  }
  if (row.disabled) {
    return c.json({ error: 'account disabled' }, 403);
  }

  c.set('userId', row.id);
  c.set('userRole', row.role);
  c.set('userEmail', row.email);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
  // Assumes requireAuth ran first; if it didn't, userRole will be undefined
  // and we fail closed.
  if (c.get('userRole') !== 'admin') {
    return c.json({ error: 'admin only' }, 403);
  }
  await next();
};
