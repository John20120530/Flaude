/**
 * Bridge between the `exit_plan_mode` tool handler (outside React) and the
 * PlanApprovalModal (inside React).
 *
 * Mirrors writeApproval.ts: the tool handler awaits a Promise, the modal
 * resolves it from a click. The visible payload (the markdown plan) goes
 * through the store; the resolver lives in a module-level Map because
 * functions don't round-trip through zustand/persist.
 *
 * Three terminal states for an approval, encoded as a discriminated union:
 *
 *   - 'approved'        → user accepts the plan; tool returns "已批准" and
 *                         the runtime unlocks destructive tools for the
 *                         remainder of this turn.
 *   - 'feedback'        → user wants revisions; tool returns the user's
 *                         feedback verbatim and the agent re-plans (still
 *                         in plan mode).
 *   - 'rejected'        → user kills the plan; tool returns a rejection
 *                         message and the runtime keeps destructive tools
 *                         locked. Effectively ends the turn productively.
 *
 * Why the three-way split (vs. just yes/no): the most common reaction to a
 * proposed plan isn't "approve or kill" — it's "almost right, but change X".
 * Without an explicit feedback channel the user has to either approve a
 * plan they're not happy with, or reject and re-prompt manually.
 */
import { useAppStore, type PendingPlan } from '@/store/useAppStore';
import { uid } from '@/lib/utils';

export type PlanApprovalResult =
  | { kind: 'approved' }
  | { kind: 'feedback'; feedback: string }
  | { kind: 'rejected'; reason?: string };

export interface PlanApprovalRequest {
  conversationId: string;
  plan: string;
}

const resolvers = new Map<string, (result: PlanApprovalResult) => void>();

export function requestPlanApproval(
  req: PlanApprovalRequest,
): Promise<PlanApprovalResult> {
  const id = uid('plan');
  const pp: PendingPlan = {
    id,
    conversationId: req.conversationId,
    plan: req.plan,
    submittedAt: Date.now(),
  };
  return new Promise<PlanApprovalResult>((resolve) => {
    resolvers.set(id, resolve);
    useAppStore.getState().enqueuePendingPlan(pp);
  });
}

export function resolvePlanApproval(id: string, result: PlanApprovalResult): void {
  const resolver = resolvers.get(id);
  resolvers.delete(id);
  useAppStore.getState().removePendingPlan(id);
  resolver?.(result);
}

/** Test-only helper. Mirrors __resetWriteApprovalForTests. */
export function __resetPlanApprovalForTests(): void {
  resolvers.clear();
  useAppStore.setState((s) => ({ ...s, pendingPlans: [] }));
}
