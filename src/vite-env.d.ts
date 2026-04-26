/// <reference types="vite/client" />

/**
 * Typed Vite env-var schema. Anything with a `VITE_` prefix here is baked into
 * the bundle at build time (and substituted in dev). Add an entry whenever a
 * new one shows up so `import.meta.env.X` is checked by tsc instead of
 * silently `any`.
 */
interface ImportMetaEnv {
  /** Flaude server base URL (e.g. `https://flaude.example.com`). Optional — we
   * fall back to `http://127.0.0.1:8787` for local dev. */
  readonly VITE_FLAUDE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Inlined at build time from `package.json.version` (see vite.config.ts →
 * `define`). Use this anywhere we want to surface the running version
 * (sidebar header, debug logs, telemetry, etc.) — kept as a global rather
 * than a module import so it works unchanged in both dev and prod, and so
 * tree-shaking handles it cleanly without any deferred runtime fetch.
 */
declare const __APP_VERSION__: string;
