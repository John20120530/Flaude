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
