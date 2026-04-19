/**
 * Quota + usage_log helpers.
 *
 * Operates on the raw D1 binding so it's easy to call from anywhere (chat
 * route, /usage route, future cron jobs for monthly rollup).
 *
 * Billing period is calendar month in UTC. Using UTC instead of each user's
 * local time keeps the boundary consistent across the team regardless of
 * timezone, and avoids DST edge cases.
 */
import type { D1Database } from '@cloudflare/workers-types';

export interface UsageSnapshot {
  used_tokens: number;
  quota_tokens: number;
  period_start: number; // unix seconds, inclusive
  period_end: number;   // unix seconds, exclusive
}

/**
 * Boundaries of the current billing month in UTC, as unix seconds.
 *   start: 00:00:00 on the 1st of this month (inclusive)
 *   end:   00:00:00 on the 1st of next  month (exclusive)
 */
export function currentPeriodBounds(now: Date = new Date()): {
  start: number;
  end: number;
} {
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return {
    start: Math.floor(startMs / 1000),
    end: Math.floor(endMs / 1000),
  };
}

/**
 * Sum of total_tokens for this user in the current month.
 * Indexed by (user_id, ts) — O(log n) seek + range scan, fast on D1.
 */
export async function getMonthlyUsage(
  db: D1Database,
  userId: number,
): Promise<number> {
  const { start } = currentPeriodBounds();
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS used
       FROM usage_log
       WHERE user_id = ? AND ts >= ?`,
    )
    .bind(userId, start)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

/**
 * Per-user quota with env fallback.
 *
 *   user.monthly_quota_tokens = NULL  → fall back to env MONTHLY_QUOTA_TOKENS
 *   user.monthly_quota_tokens = N     → N  (including 0, which means "no LLM
 *                                           access", useful for disabling
 *                                           someone without deleting their
 *                                           conversation history)
 */
export function resolveQuota(
  userQuota: number | null | undefined,
  envQuota: string,
): number {
  if (userQuota !== null && userQuota !== undefined) return userQuota;
  const parsed = parseInt(envQuota, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
}

export async function getUsageSnapshot(
  db: D1Database,
  userId: number,
  userQuota: number | null,
  envQuota: string,
): Promise<UsageSnapshot> {
  const { start, end } = currentPeriodBounds();
  const used = await getMonthlyUsage(db, userId);
  return {
    used_tokens: used,
    quota_tokens: resolveQuota(userQuota, envQuota),
    period_start: start,
    period_end: end,
  };
}

export interface UsageLogRow {
  userId: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number | null;
  conversationId: string | null;
}

export async function insertUsageLog(
  db: D1Database,
  row: UsageLogRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_log
         (user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_micro_usd, conversation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.userId,
      row.model,
      row.promptTokens,
      row.completionTokens,
      row.totalTokens,
      row.costMicroUsd,
      row.conversationId,
    )
    .run();
}
