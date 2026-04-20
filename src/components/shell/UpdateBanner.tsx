/**
 * UpdateBanner — discreet "new version available" affordance in the bottom-
 * right corner of the app shell. Appears only on desktop (Tauri), only when
 * the updater manifest reports a newer version than what's installed.
 *
 * Design:
 *   - One card at a time (like ConflictToasts), same visual family so the
 *     two don't look like different systems.
 *   - Three actions: 立即更新 (download + install + relaunch), 稍后
 *     (dismiss for this session), 忽略此版本 (dismiss until a NEWER
 *     version appears — remembered in localStorage).
 *   - Progress bar while the download is running. The install step itself
 *     is short (spawns the NSIS/MSI installer which then replaces the
 *     binary); we don't have a granular progress for it, so we just say
 *     "安装中…" before the process restarts us.
 */

import { useEffect, useState } from 'react';
import { Download, X, Loader2, Sparkles } from 'lucide-react';
import { isTauri } from '@/lib/tauri';
import { applyUpdate, checkForUpdates, type UpdateManifest } from '@/lib/updater';
import { cn } from '@/lib/utils';

/**
 * LocalStorage key for "the user clicked 忽略此版本 on version X." If the
 * manifest later reports version Y > X, we ignore the ignore and prompt
 * again — so a user who dismissed 0.2.0 still sees a banner for 0.3.0.
 */
const IGNORED_VERSION_KEY = 'flaude-updater-ignored-version';

function getIgnoredVersion(): string | null {
  try {
    return localStorage.getItem(IGNORED_VERSION_KEY);
  } catch {
    return null;
  }
}

function setIgnoredVersion(v: string): void {
  try {
    localStorage.setItem(IGNORED_VERSION_KEY, v);
  } catch {
    // Private-browsing or quota — not actionable, just drop the write.
  }
}

export default function UpdateBanner() {
  const [manifest, setManifest] = useState<UpdateManifest | null>(null);
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One-shot check on mount. Silent: a failure here (network, stale mirror,
  // self-signed cert error) shouldn't show the user anything — they'd see a
  // red banner every app launch for weeks if GitHub was having a bad day.
  // Updates are discovered on the next successful poll.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    // Delay 5s so the check doesn't fight the initial sync round-trip for
    // bandwidth on a cold start.
    const timer = setTimeout(async () => {
      try {
        const m = await checkForUpdates();
        if (cancelled) return;
        if (!m) return;
        if (getIgnoredVersion() === m.version) return;
        setManifest(m);
      } catch (e) {
        // Dev + initial release — when pubkey is a placeholder the check will
        // throw "signature error" or a 404 against the example URL. That's
        // fine; don't spam the user.
        console.warn('[updater] check failed:', (e as Error).message);
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!manifest || dismissedThisSession) return null;

  const onInstall = async () => {
    setInstalling(true);
    setError(null);
    try {
      await applyUpdate((done, total) => setProgress({ done, total }));
      // If applyUpdate returns (rather than relaunching), the install was
      // skipped — nothing more to do in the UI.
    } catch (e) {
      setError((e as Error).message || '更新失败');
      setInstalling(false);
    }
  };

  const onIgnore = () => {
    setIgnoredVersion(manifest.version);
    setDismissedThisSession(true);
  };

  const onLater = () => setDismissedThisSession(true);

  const pct =
    progress && progress.total && progress.total > 0
      ? Math.min(100, (progress.done / progress.total) * 100)
      : null;

  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-50 w-[360px]',
        'rounded-xl border border-claude-border dark:border-night-border',
        'bg-white dark:bg-night-bg shadow-lg p-4 text-sm',
      )}
      role="dialog"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <Sparkles className="w-4 h-4 text-claude-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium">
            Flaude {manifest.version} 可用
            <span className="text-xs text-claude-muted dark:text-night-muted ml-1.5">
              (当前 {manifest.currentVersion})
            </span>
          </div>
          {manifest.body && (
            <div className="mt-1 text-xs text-claude-muted dark:text-night-muted whitespace-pre-wrap max-h-24 overflow-y-auto">
              {manifest.body}
            </div>
          )}
        </div>
        {!installing && (
          <button
            onClick={onLater}
            className="text-claude-muted hover:text-claude-ink dark:text-night-muted dark:hover:text-night-ink"
            aria-label="稍后"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {installing ? (
        <div className="mt-3">
          <div className="flex items-center gap-2 text-xs text-claude-muted dark:text-night-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {progress && progress.total
              ? `下载中 ${formatBytes(progress.done)} / ${formatBytes(progress.total)}`
              : '准备安装……'}
          </div>
          {pct !== null && (
            <div className="mt-2 h-1 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
              <div
                className="h-full bg-claude-accent transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button onClick={onIgnore} className="btn-ghost text-xs">
            忽略此版本
          </button>
          <button
            onClick={onInstall}
            className="btn-primary text-xs flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            立即更新
          </button>
        </div>
      )}

      {error && (
        <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
