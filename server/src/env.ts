/**
 * Shared Env/Bindings type for the Worker.
 *
 * Kept in its own file so routes and middleware can import without creating
 * circular deps with index.ts.
 */
import type { D1Database } from '@cloudflare/workers-types';

export interface Env {
  // D1 binding from wrangler.toml.
  DB: D1Database;

  // Public config (vars in wrangler.toml).
  APP_ENV: 'development' | 'production';
  JWT_ISSUER: string;
  MONTHLY_QUOTA_TOKENS: string; // bindings are always strings; parseInt at use.

  // Secrets (wrangler secret put / .dev.vars).
  //   JWT_SECRET — HS256 signing key, minimum 32 bytes of entropy. Generate with
  //   `openssl rand -base64 48` or `node -e "console.log(crypto.randomBytes(48).toString('base64'))"`.
  JWT_SECRET: string;

  // Upstream LLM provider keys. Optional at the type level because only the
  // providers we actually route to need to be set; providers.ts looks these
  // up by name and returns "server not configured" (500) if the resolved
  // model's key is missing.
  DEEPSEEK_API_KEY?: string;

  // Tool provider keys.
  //   BOCHA_API_KEY — 博查 Web Search. Shared across all users of this server,
  //   so quota sits at the operator's account, not per-user. Omit to disable
  //   web_search server-wide.
  BOCHA_API_KEY?: string;
}

/**
 * Hono variable map — values we attach to the context inside middleware and
 * read downstream. Using `c.set/c.get` with this generic keeps TS honest about
 * what's been populated.
 */
export interface Variables {
  userId: number;
  userRole: 'admin' | 'user';
  userEmail: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: Variables;
};
