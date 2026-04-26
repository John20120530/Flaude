import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetPlanApprovalForTests,
  requestPlanApproval,
  resolvePlanApproval,
} from './planMode';
import { useAppStore } from '@/store/useAppStore';

afterEach(() => {
  __resetPlanApprovalForTests();
});

describe('planMode bridge', () => {
  it('enqueues a PendingPlan in the store and resolves with approved', async () => {
    const promise = requestPlanApproval({
      conversationId: 'conv-1',
      plan: '## 目标\n做点事情',
    });

    // Should land in the store immediately, before resolution.
    const queue = useAppStore.getState().pendingPlans;
    expect(queue).toHaveLength(1);
    expect(queue[0]?.conversationId).toBe('conv-1');
    expect(queue[0]?.plan).toContain('做点事情');

    const id = queue[0]!.id;
    resolvePlanApproval(id, { kind: 'approved' });
    const result = await promise;
    expect(result).toEqual({ kind: 'approved' });

    // Queue should be empty after resolution.
    expect(useAppStore.getState().pendingPlans).toHaveLength(0);
  });

  it('resolves with feedback and returns the user text', async () => {
    const promise = requestPlanApproval({ conversationId: 'c', plan: 'p' });
    const id = useAppStore.getState().pendingPlans[0]!.id;
    resolvePlanApproval(id, { kind: 'feedback', feedback: '步骤 2 改一下' });
    const result = await promise;
    expect(result).toEqual({ kind: 'feedback', feedback: '步骤 2 改一下' });
  });

  it('resolves with rejected (no reason)', async () => {
    const promise = requestPlanApproval({ conversationId: 'c', plan: 'p' });
    const id = useAppStore.getState().pendingPlans[0]!.id;
    resolvePlanApproval(id, { kind: 'rejected' });
    const result = await promise;
    expect(result).toEqual({ kind: 'rejected' });
  });

  it('resolves with rejected (with reason)', async () => {
    const promise = requestPlanApproval({ conversationId: 'c', plan: 'p' });
    const id = useAppStore.getState().pendingPlans[0]!.id;
    resolvePlanApproval(id, { kind: 'rejected', reason: '太激进' });
    const result = await promise;
    expect(result).toEqual({ kind: 'rejected', reason: '太激进' });
  });

  it('handles concurrent requests in FIFO order with independent ids', async () => {
    const p1 = requestPlanApproval({ conversationId: 'c', plan: 'first' });
    const p2 = requestPlanApproval({ conversationId: 'c', plan: 'second' });

    const queue = useAppStore.getState().pendingPlans;
    expect(queue).toHaveLength(2);
    expect(queue[0]?.plan).toBe('first');
    expect(queue[1]?.plan).toBe('second');
    expect(queue[0]?.id).not.toBe(queue[1]?.id);

    resolvePlanApproval(queue[1]!.id, { kind: 'approved' });
    resolvePlanApproval(queue[0]!.id, { kind: 'feedback', feedback: 'fb' });

    expect(await p1).toEqual({ kind: 'feedback', feedback: 'fb' });
    expect(await p2).toEqual({ kind: 'approved' });
  });

  it('is a no-op when resolving an unknown id (idempotent / safe-on-double-click)', () => {
    expect(() =>
      resolvePlanApproval('nope', { kind: 'approved' }),
    ).not.toThrow();
  });
});
