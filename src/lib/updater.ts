/**
 * Auto-updater bridge.
 *
 * Wraps `@tauri-apps/plugin-updater` so the rest of the app sees a narrow
 * Promise API instead of plugin internals. Safe to call in the browser —
 * every function returns null / throws a helpful message outside Tauri.
 *
 * Lifecycle of an update:
 *   1. App startup → AppShell calls checkForUpdates(). On a fresh
 *      binary, this hits the `endpoints` URL in tauri.conf.json (our
 *      GitHub Release's latest.json), compares versions, returns the
 *      manifest for anything newer — or null when we're current.
 *   2. AppShell surfaces the result via a dismissible UpdateBanner.
 *   3. User clicks 「立即更新」 → downloadAndInstall(onProgress) streams
 *      the NSIS/MSI bundle, verifies its ed25519 signature against the
 *      `pubkey` in tauri.conf.json, runs the installer.
 *   4. We call relaunch() and the new binary takes over.
 *
 * Why a custom dialog instead of the plugin's built-in `dialog: true`:
 *   - It pops before our app has even rendered, which looks unbranded and
 *     jarring.
 *   - We want a "稍后" option that respects an ignore-for-this-version
 *     flag, which the built-in dialog can't express.
 *   - Banner fits better into the existing conflict-toast pattern.
 */

import { isTauri } from './tauri';

export interface UpdateManifest {
  version: string;
  currentVersion: string;
  /** Release notes from latest.json — markdown. */
  body: string;
  /** ISO8601 when the release was published. */
  date: string | null;
}

/** Internal handle — we don't export the plugin's shape. */
interface UpdateInstance {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
  downloadAndInstall: (
    onEvent?: (ev: { event: string; data?: { chunkLength?: number; contentLength?: number } }) => void
  ) => Promise<void>;
}

// Cache the `check()` result across the process so a user who dismisses the
// banner doesn't trigger a second network round-trip if we re-check. Cleared
// only when the window reloads — which, after a successful install, it does.
let cached: { at: number; instance: UpdateInstance | null } | null = null;

/**
 * Returns the available update manifest, or null when the installed
 * binary is already current. Returns null unconditionally in the browser
 * (no installer to update).
 *
 * `force: true` skips the cache — used by an explicit "再次检查" button.
 */
export async function checkForUpdates(opts?: { force?: boolean }): Promise<UpdateManifest | null> {
  if (!isTauri()) return null;

  // 5-minute TTL on the cache — long enough that clicking between views
  // doesn't re-hit the network, short enough that a user who left the app
  // open overnight gets a fresh check on their next interaction.
  const TTL = 5 * 60 * 1000;
  if (!opts?.force && cached && Date.now() - cached.at < TTL) {
    return cached.instance ? toManifest(cached.instance) : null;
  }

  const { check } = await import('@tauri-apps/plugin-updater');
  const instance = (await check()) as UpdateInstance | null;
  cached = { at: Date.now(), instance };
  return instance ? toManifest(instance) : null;
}

function toManifest(inst: UpdateInstance): UpdateManifest {
  return {
    version: inst.version,
    currentVersion: inst.currentVersion,
    body: inst.body ?? '',
    date: inst.date ?? null,
  };
}

/**
 * Download + install the most recent update candidate, then relaunch.
 * Emits progress events via `onProgress(bytesDone, bytesTotal)`.
 * Throws on signature verification failure or a bad HTTP response.
 *
 * Contract: `checkForUpdates()` must have returned a non-null manifest
 * recently enough that the cached instance is still valid (<5 min). We
 * don't re-`check()` inside this function to avoid a surprise "wait, now
 * the server says we're current" race during the install progress UI.
 */
export async function applyUpdate(
  onProgress?: (bytesDone: number, bytesTotal: number | null) => void
): Promise<void> {
  if (!isTauri()) {
    throw new Error('自动更新仅在桌面版可用。');
  }
  if (!cached?.instance) {
    // Shouldn't happen in normal flow — the banner only renders after a
    // successful check. If someone calls this directly, force a fresh
    // check rather than silently failing.
    const { check } = await import('@tauri-apps/plugin-updater');
    cached = { at: Date.now(), instance: (await check()) as UpdateInstance | null };
    if (!cached.instance) throw new Error('未发现可用更新。');
  }

  let done = 0;
  let total: number | null = null;
  await cached.instance.downloadAndInstall((ev) => {
    if (ev.event === 'Started') {
      total = ev.data?.contentLength ?? null;
      onProgress?.(0, total);
    } else if (ev.event === 'Progress') {
      done += ev.data?.chunkLength ?? 0;
      onProgress?.(done, total);
    } else if (ev.event === 'Finished') {
      onProgress?.(total ?? done, total);
    }
  });

  // Installer exited 0 — swap in the new binary by relaunching.
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
