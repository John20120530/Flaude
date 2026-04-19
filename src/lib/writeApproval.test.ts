/**
 * Tests for the write-approval bridge.
 *
 * Unlike the diff tests, which are pure, these exercise the handoff
 * between a handler-side await and a modal-side resolve call. The test
 * impersonates the modal: call `requestWriteApproval(...)`, inspect the
 * store to see the pending entry, then call `resolveWriteApproval(id, ok)`
 * and assert the returned promise settles to the expected value.
 *
 * We also verify FIFO queueing — if two requests are in flight, each
 * gets its own id and can be resolved independently, which is the
 * contract the modal relies on to pop one entry at a time.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import {
  __resetWriteApprovalForTests,
  requestWriteApproval,
  resolveWriteApproval,
} from './writeApproval';

afterEach(() => {
  __resetWriteApprovalForTests();
});

describe('writeApproval bridge', () => {
  it('enqueues a PendingWrite on request and clears it on resolve', async () => {
    const promise = requestWriteApproval({
      path: 'src/foo.ts',
      oldContent: 'old',
      newContent: 'new',
      isNewFile: false,
      createDirs: false,
    });

    // Synchronously after request, the store should show exactly one entry.
    const queue = useAppStore.getState().pendingWrites;
    expect(queue).toHaveLength(1);
    expect(queue[0].path).toBe('src/foo.ts');
    expect(queue[0].oldContent).toBe('old');
    expect(queue[0].newContent).toBe('new');
    expect(queue[0].isNewFile).toBe(false);

    resolveWriteApproval(queue[0].id, true);
    expect(await promise).toBe(true);
    expect(useAppStore.getState().pendingWrites).toHaveLength(0);
  });

  it('resolves false when user rejects', async () => {
    const promise = requestWriteApproval({
      path: 'a.txt',
      oldContent: '',
      newContent: 'x',
      isNewFile: true,
      createDirs: false,
    });
    const { id } = useAppStore.getState().pendingWrites[0];
    resolveWriteApproval(id, false);
    expect(await promise).toBe(false);
    expect(useAppStore.getState().pendingWrites).toHaveLength(0);
  });

  it('preserves FIFO order for concurrent requests and resolves each independently', async () => {
    const p1 = requestWriteApproval({
      path: 'first.ts',
      oldContent: '',
      newContent: 'a',
      isNewFile: true,
      createDirs: false,
    });
    const p2 = requestWriteApproval({
      path: 'second.ts',
      oldContent: '',
      newContent: 'b',
      isNewFile: true,
      createDirs: false,
    });

    const queue = useAppStore.getState().pendingWrites;
    expect(queue).toHaveLength(2);
    // FIFO: the oldest request is at index 0.
    expect(queue[0].path).toBe('first.ts');
    expect(queue[1].path).toBe('second.ts');

    // Resolve out of order to make sure each promise is keyed to its own id.
    resolveWriteApproval(queue[1].id, true);
    expect(await p2).toBe(true);
    expect(useAppStore.getState().pendingWrites).toHaveLength(1);
    expect(useAppStore.getState().pendingWrites[0].path).toBe('first.ts');

    resolveWriteApproval(queue[0].id, false);
    expect(await p1).toBe(false);
    expect(useAppStore.getState().pendingWrites).toHaveLength(0);
  });

  it('resolve on an unknown id is a silent no-op', () => {
    // No throw, no state change. Nothing to await here since there's no
    // matching resolver.
    expect(() => resolveWriteApproval('does-not-exist', true)).not.toThrow();
    expect(useAppStore.getState().pendingWrites).toHaveLength(0);
  });

  it('each request gets a unique id', () => {
    requestWriteApproval({
      path: '1', oldContent: '', newContent: '', isNewFile: true, createDirs: false,
    });
    requestWriteApproval({
      path: '2', oldContent: '', newContent: '', isNewFile: true, createDirs: false,
    });
    const ids = useAppStore.getState().pendingWrites.map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
  });
});
