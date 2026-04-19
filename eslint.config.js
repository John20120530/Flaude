// ESLint flat config (ESLint 9+). TypeScript + React + Vite.
// Keep this minimal: surface real bugs, skip stylistic noise (TS covers most of it).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  // Don't lint generated / vendored / Rust output
  {
    ignores: [
      'dist/**',
      'dist-ssr/**',
      'node_modules/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      '.vite/**',
      '*.config.js',
      '*.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // React hooks — real bugs
      ...reactHooks.configs.recommended.rules,

      // React Compiler hints — useful but not bugs; keep as warnings so `pnpm lint`
      // exits clean. Flip to 'error' once we've fully compiler-optimized the app.
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/globals': 'warn',

      // Vite fast refresh — warn if a file exports mixed things
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],

      // TS: allow `_prefix` unused (we use `_d`, `_SYSTEM_PROMPT`, etc.)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // We use `any` in a few narrow places (Tauri IPC, MCP payloads) — warn not error
      '@typescript-eslint/no-explicit-any': 'warn',

      // `@ts-ignore` → prefer `@ts-expect-error`, but don't fail on it
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },

  // Node scripts / config files: enable Node globals
  {
    files: ['*.cjs', 'scripts/**/*.{js,cjs,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  }
);
