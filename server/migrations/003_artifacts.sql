-- Phase 3.2: artifacts sync.
--
-- Artifacts are Claude-style deliverable blobs (HTML page, React component,
-- SVG, Mermaid diagram, markdown doc, code dump) extracted from assistant
-- replies. Before this migration they lived only in the client's Zustand
-- persist — so an artifact produced on device A was invisible on device B,
-- and deleting one on device A wouldn't remove it from device B.
--
-- Same LWW + tombstone pattern as conversations / projects. Client-generated
-- TEXT primary key, ms-epoch timestamps, deleted_at tombstone.
--
-- message_id is a loose ref to messages.id — we do NOT enforce it as a FK
-- because (a) push ordering can't be guaranteed (an artifact can arrive
-- before the message it references), and (b) auto-promoted artifacts may be
-- constructed with an ad-hoc id ("msg-xxx-auto-0") that isn't guaranteed to
-- match a real message row. Clients should tolerate dangling message_id
-- rather than blow up.
--
-- user_id FK cascades on user delete so purging an account takes its
-- artifacts with it. We intentionally do NOT cascade-delete artifacts when
-- a conversation or message is deleted — artifacts outlive their owning
-- message today (see upsertArtifact + deleteArtifact in useAppStore), and
-- the 90d soft-delete cron is where long-tail cleanup belongs.
--
-- Apply locally:   pnpm db:migrate:artifacts
-- Apply remote:    pnpm db:migrate:artifacts:remote

CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id   TEXT,                        -- loose ref; no FK on purpose
  type         TEXT NOT NULL,               -- html | react | svg | mermaid | markdown | code
  title        TEXT NOT NULL DEFAULT '',
  language     TEXT,                        -- only set for type=code
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,            -- ms, client-supplied
  updated_at   INTEGER NOT NULL,            -- ms, client-supplied (stamped on each upsert)
  deleted_at   INTEGER                      -- ms, NULL = live
);

CREATE INDEX IF NOT EXISTS idx_artifacts_user_updated
  ON artifacts(user_id, updated_at DESC);
