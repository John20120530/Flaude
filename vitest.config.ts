import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Separate Vitest config so we don't entangle the dev/build config with test
 * concerns. We mirror the `@` alias so tests can import from `@/...` like
 * production code.
 *
 * Most of our unit-test target is pure logic (slash commands, system-prompt
 * composition, store reducers), so we default to the `node` environment. The
 * day we want React component tests, switch to `jsdom` and add
 * `@testing-library/react`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
    reporters: 'default',
    // Setup file stubs localStorage so zustand/persist doesn't log warnings
    // during store tests. Keeps test output clean enough to eyeball.
    setupFiles: ['./src/test/setup.ts'],
  },
});
