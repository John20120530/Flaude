/**
 * Server integration-test config.
 *
 * Runs in plain node. We tried @cloudflare/vitest-pool-workers (which spins
 * up a real workerd runtime) but it blew up on this repo's non-ASCII path
 * (`C:\D\4 研究\...`) because workerd's module fallback service gets confused
 * by percent-encoded Chinese characters in the referrer. The pool has no
 * config knob for that, and the only fix is relocating the repo to ASCII-
 * only — not portable for anyone cloning this project.
 *
 * Instead we drive the Hono app directly via `app.fetch(request, env)` with
 * a better-sqlite3-backed D1 shim. Every sync test exercises the same
 * route handler a Cloudflare Worker would — same Hono, same sync.ts, same
 * validation — we just replace D1+workerd with an in-memory SQLite.
 *
 * What we lose: workerd-specific behaviours (request/response limits,
 * isolate memory caps, true `cloudflare:workers` API shape). For the sync
 * code those aren't exercised anyway — it's Hono routing + SQL + crypto.
 * For anything that relies on Workers-specific runtime (Durable Objects,
 * Queues, R2) we'd need to revisit, but sync.ts is pure D1 + JWT + JSON.
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
    globals: false,
    reporters: 'default',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
