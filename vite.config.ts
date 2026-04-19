import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Tauri-aware Vite config. Tauri drives the dev server via `beforeDevCommand`
 * in tauri.conf.json, so we need a fixed port (1420) and we must not clear
 * the screen (Tauri logs compile errors in the same terminal).
 *
 * The config still works in plain `pnpm dev` — Tauri-specific env vars are
 * just unset there.
 */
// @ts-expect-error — `process` is available in Node but we haven't pulled in @types/node for it to narrow
const host: string | undefined = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Only expose VITE_* and TAURI_ENV_* to client code.
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // Tauri uses WebView2 on Windows (Chromium), WKWebView on macOS, WebKitGTK on Linux.
  // Targeting these keeps bundle smaller than "defaults".
  build: {
    target: ['es2022', 'chrome105', 'safari15'],
    minify: 'esbuild',
    sourcemap: false,
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? '127.0.0.1',
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Don't rebuild on Rust source changes — Tauri handles that side.
      ignored: ['**/src-tauri/**'],
    },
  },
});
