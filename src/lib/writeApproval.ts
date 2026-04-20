/**
 * Bridge between the `fs_write_file` tool handler (outside React) and the
 * WriteApprovalModal (inside React).
 *
 * Why the split: the tool handler is invoked from the streamed chat loop
 * via async/await and needs a plain `Promise<boolean>` back. The modal
 * lives in the component tree and can only communicate via state. So we
 *   (a) push the visible data (path, old/new content) into zustand, where
 *       the modal can subscribe and render it;
 *   (b) keep the callable `resolve` in a module-level Map, since
 *       functions aren't serialisable and zustand's persist middleware
 *       would choke on them.
 *
 * Lifecycle of a single approval:
 *   1. handler calls `requestWriteApproval(req)`
 *   2. we mint an id, stash the resolver in `resolvers`, enqueue a
 *      `PendingWrite` in the store
 *   3. modal subscribes to `pendingWrites`, renders a diff for
 *      `pendingWrites[0]`
 *   4. user clicks Apply → modal calls `resolveWriteApproval(id, true)`
 *   5. we pop the store entry + invoke the resolver with `true` → the
 *      handler's await resolves, it proceeds to write
 *   6. if Reject, same path with `false`; handler throws "user rejected"
 *
 * Abandoned approvals: if the app is force-killed mid-approval, the
 * in-memory resolver and the store entry both vanish (store is
 * transient). The handler's promise never resolves — but by then the
 * chat loop is dead too, so it doesn't matter. The worst case on app
 * restart is a stale record in the model's conversation history; the
 * model will just retry or give up naturally.
 */
import { useAppStore, type PendingWrite } from '@/store/useAppStore';
import { uid } from '@/lib/utils';

/** Input to requestWriteApproval — everything except bookkeeping fields. */
export interface WriteApprovalRequest {
  path: string;
  oldContent: string;
  newContent: string;
  isNewFile: boolean;
  createDirs: boolean;
}

// Keyed by PendingWrite.id. Values are the resolver that completes the
// pending Promise. We never persist this — functions don't round-trip
// through JSON. If the app reloads, the Map is empty, and any
// unresolved requests die silently with their dead chat loop.
const resolvers = new Map<string, (approved: boolean) => void>();

/**
 * Paused until the user clicks Apply or Reject in the modal. Resolves
 * `true` for apply, `false` for reject.
 *
 * Safe to call multiple times concurrently — each gets its own id and
 * queues behind earlier ones in FIFO order.
 */
export function requestWriteApproval(
  req: WriteApprovalRequest,
): Promise<boolean> {
  const id = uid();
  const pw: PendingWrite = {
    id,
    path: req.path,
    oldContent: req.oldContent,
    newContent: req.newContent,
    isNewFile: req.isNewFile,
    createDirs: req.createDirs,
    submittedAt: Date.now(),
  };

  return new Promise<boolean>((resolve) => {
    resolvers.set(id, resolve);
    useAppStore.getState().enqueuePendingWrite(pw);
  });
}

/**
 * Called from the modal. Resolves the matching pending promise and
 * removes the entry from the store. Idempotent on unknown ids — if the
 * user somehow double-clicks or the entry was already cleared, we just
 * no-op.
 */
export function resolveWriteApproval(id: string, approved: boolean): void {
  const resolver = resolvers.get(id);
  resolvers.delete(id);
  useAppStore.getState().removePendingWrite(id);
  resolver?.(approved);
}

/**
 * Test-only hook. Not exported from any barrel — imported directly by
 * writeApproval.test.ts. Clears all in-flight approvals without
 * resolving them. Production code should never need this; if we're
 * tempted to call this from a real code path we've misunderstood the
 * lifecycle.
 */
export function __resetWriteApprovalForTests(): void {
  resolvers.clear();
  // Also clear the store queue, since tests can recreate the store
  // between runs but this module's singleton map persists across imports.
  useAppStore.setState((s) => ({
    ...s,
    pendingWrites: [],
  }));
}
