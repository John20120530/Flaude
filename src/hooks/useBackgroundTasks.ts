/**
 * Polling hook for the background-tasks panel.
 *
 * Why polling vs. push events: the bgshell module on the Rust side doesn't
 * emit `App::emit` events when a process exits — it just buffers stdout/
 * stderr in a ring and flips a `running: false` flag the next time anyone
 * calls `shell_list`. Adding an event-emit channel would require a Rust
 * change; cheap polling on a 2 s cadence covers the use case (humans
 * tolerate 2 s for "did my watcher die" updates) and self-pauses when the
 * panel isn't visible.
 *
 * Detection of newly-completed tasks is done by diffing the previous
 * snapshot against the current one — any id whose `running` flipped from
 * true to false in this poll gets pushed to `newlyCompleted`. The caller
 * (the panel) drains that buffer when it's safe to clear the visual
 * highlight (e.g. after rendering a "done" toast or once the user clicks
 * the row).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri, shellList, shellRemove, shellKill, type BgShellInfo } from '@/lib/tauri';

/**
 * Pure helper: given the previous (id → running) snapshot and the latest
 * task list, return the subset of tasks that just transitioned from
 * running=true to running=false. Extracted so it can be unit-tested
 * without spinning up a React renderer.
 *
 * Tasks that appear for the first time already-done are NOT counted as
 * "just finished" — they were never observed as running, so the
 * transition wasn't witnessed by us. That's the intended behavior on
 * app start: a registry full of old finished tasks shouldn't badge as
 * "12 things just completed!"
 */
export function diffNewlyCompleted(
  prevSnapshot: Map<string, boolean>,
  latest: BgShellInfo[],
): BgShellInfo[] {
  const out: BgShellInfo[] = [];
  for (const t of latest) {
    if (!t.running && prevSnapshot.get(t.id) === true) {
      out.push(t);
    }
  }
  return out;
}

/** Build the snapshot map (id → running) consumed by diffNewlyCompleted. */
export function snapshotOf(tasks: BgShellInfo[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const t of tasks) out.set(t.id, t.running);
  return out;
}

export interface UseBackgroundTasksOptions {
  /**
   * When false, polling pauses. Used to suspend updates when the panel
   * isn't the active bottom tab — there's no point re-rendering or
   * making IPC calls if the user can't see them anyway.
   */
  active: boolean;
  /** ms between polls. Default 2000. */
  intervalMs?: number;
}

export interface UseBackgroundTasksReturn {
  tasks: BgShellInfo[];
  /** Subset of `tasks` that flipped from running → done in the latest poll. */
  newlyCompleted: BgShellInfo[];
  /** Manual refresh; bypasses the interval. */
  refresh: () => Promise<void>;
  /** Send SIGTERM/SIGKILL via the bgshell IPC. */
  kill: (id: string) => Promise<void>;
  /** Drop the handle from the registry; kills first if still running. */
  remove: (id: string) => Promise<void>;
  /** Clear the `newlyCompleted` buffer — call after acknowledging the badge. */
  clearNewlyCompleted: () => void;
  /** True while the very first poll is in flight (no data yet). */
  loading: boolean;
  /** Last error string from a failed poll, if any. */
  error: string | null;
}

export function useBackgroundTasks({
  active,
  intervalMs = 2000,
}: UseBackgroundTasksOptions): UseBackgroundTasksReturn {
  const [tasks, setTasks] = useState<BgShellInfo[]>([]);
  const [newlyCompleted, setNewlyCompleted] = useState<BgShellInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Last seen snapshot, used for the running→done diff. Lives in a ref
  // (not state) because we read it inside the polling closure and don't
  // want every poll to schedule a re-render just to swap this.
  const prevSnapshotRef = useRef<Map<string, boolean>>(new Map());

  const poll = useCallback(async () => {
    if (!isTauri()) {
      // Browser mode: no shell, nothing to poll. Stay loading=false with
      // an empty list so the panel can render a "desktop only" empty state.
      setTasks([]);
      setLoading(false);
      return;
    }
    try {
      const list = await shellList();
      setTasks(list);
      setError(null);

      // Diff: anything we previously knew as running that's now `running:
      // false` just transitioned. See diffNewlyCompleted's docstring for
      // why brand-new already-finished tasks are NOT counted.
      const justFinished = diffNewlyCompleted(prevSnapshotRef.current, list);
      if (justFinished.length > 0) {
        setNewlyCompleted((cur) => [...cur, ...justFinished]);
      }
      // Update snapshot AFTER the diff so we compare against the prior
      // poll's view, not against ourselves.
      prevSnapshotRef.current = snapshotOf(list);
    } catch (e) {
      setError((e as Error).message ?? 'failed to list bg shells');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    // Fire one immediately so the panel doesn't show "loading…" for 2s
    // when the user opens the tab.
    void poll();
    const id = setInterval(() => {
      void poll();
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, poll]);

  const kill = useCallback(async (id: string) => {
    if (!isTauri()) return;
    await shellKill(id);
    void poll();
  }, [poll]);

  const remove = useCallback(async (id: string) => {
    if (!isTauri()) return;
    await shellRemove(id);
    void poll();
  }, [poll]);

  const clearNewlyCompleted = useCallback(() => setNewlyCompleted([]), []);

  return {
    tasks,
    newlyCompleted,
    refresh: poll,
    kill,
    remove,
    clearNewlyCompleted,
    loading,
    error,
  };
}
