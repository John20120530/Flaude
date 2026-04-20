/**
 * Vitest setup — runs once before every test file.
 *
 * 1. Stub a no-op `localStorage` in Node so zustand/persist has something
 *    to talk to. Storage is session-scoped (Map) — tests drive the store
 *    via `setState(initialState, true)` in their own beforeEach, so we
 *    don't need persistence to survive across tests.
 *
 * 2. Silence the specific `[zustand persist middleware] Unable to update
 *    item ...` warning. It fires because zustand's `createJSONStorage`
 *    captures the `localStorage` reference at module-load time — which
 *    happens BEFORE the stub above in import-hoisting order, so the
 *    captured reference is undefined even though we fix it here. The
 *    warning is cosmetic (writes are no-ops anyway); filter it so test
 *    output stays readable without hiding real console.error calls.
 */
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = fake;
}

const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : '';
  if (msg.includes('[zustand persist middleware] Unable to update item')) {
    return;
  }
  originalWarn.apply(console, args);
};
