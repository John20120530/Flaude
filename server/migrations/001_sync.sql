-- Phase 3 (薄): conversation sync.
--
-- Extends the conversations + messages tables (scaffolded in schema.sql) with
-- the metadata required for full client↔server round-tripping:
--   - pinned / starred — sidebar affordances
--   - model_id         — which model produced the conversation
--   - project_id       — project association (NOT a FK; projects aren't synced yet)
--   - summary / summary_msg_count / summarized_at — M6 context-compaction state
--   - deleted_at       — soft-delete tombstone; a daily cron purges rows older
--                        than 90d (see scheduled() in src/index.ts)
--
-- messages gets:
--   - reasoning        — thinking-model trace, shown separately in the UI
--   - model_id         — which model produced this specific reply
--   - tokens_in / tokens_out — per-message usage, surfaced in the UI if we want
--
-- NB: we do NOT change existing column types or defaults here. schema.sql is
-- updated alongside so fresh deploys see the same end-state; this file is the
-- migration path for databases that were init'd before Phase 3.
--
-- Apply locally:   pnpm db:migrate
-- Apply remote:    pnpm db:migrate:remote
--
-- D1 doesn't support partial indexes, so we can't index only non-deleted rows.
-- The existing idx_conversations_user_updated is enough for the pull-since-ts
-- path; the cleanup cron is a once-a-day full scan which is fine.

ALTER TABLE conversations ADD COLUMN pinned             INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN starred            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN model_id           TEXT;
ALTER TABLE conversations ADD COLUMN project_id         TEXT;
ALTER TABLE conversations ADD COLUMN summary            TEXT;
ALTER TABLE conversations ADD COLUMN summary_msg_count  INTEGER;
ALTER TABLE conversations ADD COLUMN summarized_at      INTEGER;
ALTER TABLE conversations ADD COLUMN deleted_at         INTEGER;

ALTER TABLE messages ADD COLUMN reasoning  TEXT;
ALTER TABLE messages ADD COLUMN model_id   TEXT;
ALTER TABLE messages ADD COLUMN tokens_in  INTEGER;
ALTER TABLE messages ADD COLUMN tokens_out INTEGER;
