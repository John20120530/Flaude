/**
 * Shared Env/Bindings type for the Worker.
 *
 * Kept in its own file so routes and middleware can import without creating
 * circular deps with index.ts.
 */
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  // D1 binding from wrangler.toml.
  DB: D1Database;

  // R2 binding from wrangler.toml. Mirror target for image_generate
  // (server/src/imageProxy.ts) — turns 24h-expiring upstream signed URLs
  // into permanent /api/image/<sha256>.png URLs. Optional at the type
  // level so production worker keeps responding even if the bucket binding
  // is forgotten — image_generate gracefully falls back to passing the
  // upstream URL through unchanged when IMAGES is undefined.
  IMAGES?: R2Bucket;

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
  QWEN_API_KEY?: string;      // DashScope (Alibaba). Get at https://dashscope.console.aliyun.com
  // v0.1.61: Tongyi Wanxiang image-gen reuses the DashScope key. Optional
  // because most users have only set QWEN_API_KEY for chat — tools.ts
  // falls back to QWEN_API_KEY when DASHSCOPE_API_KEY is unset, since
  // both come from the same console and share auth scope.
  DASHSCOPE_API_KEY?: string;
  // ZHIPU_API_KEY removed in v0.1.51 (Zhipu provider dropped). Leaving the
  // wrangler secret in production is harmless — nothing references it.
  MOONSHOT_API_KEY?: string;  // Moonshot Kimi. Get at https://platform.moonshot.cn

  // Tool provider keys.
  //   BOCHA_API_KEY — 博查 Web Search. Shared across all users of this server,
  //   so quota sits at the operator's account, not per-user. Omit to disable
  //   web_search server-wide.
  BOCHA_API_KEY?: string;

  // PPIO_API_KEY — PPIO platform key, used by /tools/image_generate to
  // call GPT Image 2 (https://api.ppio.com/v3/gpt-image-2-text-to-image).
  // Same shared-quota model as BOCHA above: one operator-paid key,
  // billing happens on PPIO's side. Omit to return 503 from
  // /tools/image_generate (Design mode then falls back to code-only).
  PPIO_API_KEY?: string;

  // GitHub PAT for the Skills marketplace federated-search endpoint
  //   (`/api/skills/search`). Only needs `public_repo` read scope — we just
  //   call /search/code, /repos/.../license, and raw.githubusercontent.com.
  //
  //   Without a token: GitHub allows ~10 search reqs/min from a Worker IP,
  //   which the Cache API absorbs for repeated queries but is tight.
  //   With a token:    5000 reqs/hour shared across all users — comfortable.
  //
  //   Generate at https://github.com/settings/tokens (classic, public_repo)
  //   and `pnpm wrangler secret put GITHUB_TOKEN` to install on production.
  GITHUB_TOKEN?: string;
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
