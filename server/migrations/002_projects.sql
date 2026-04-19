-- Phase 3.1: projects sync.
--
-- Projects are collections of conversations with shared instructions and
-- knowledge sources (file/folder/url/text). Before this migration they lived
-- only in the client's Zustand persist — so a project created on device A
-- was invisible on device B, and any conversation whose project_id pointed
-- at such a project showed a broken ref after sync.
--
-- Schema mirrors conversations: client-generated TEXT primary key, ms-epoch
-- timestamps to match the client, deleted_at tombstone for soft-delete.
-- sources (Project.sources: ProjectSource[]) is JSON-encoded into sources_json
-- because D1 has no native JSON type; the client owns the shape.
--
-- user_id FK cascades on user delete so a removed account takes its projects
-- with it.
--
-- Apply locally:   pnpm db:migrate:projects
-- Apply remote:    pnpm db:migrate:projects:remote
--
-- No FK from conversations.project_id → projects.id on purpose. Conversations
-- predate this migration, and we want `project_id` to degrade to a dangling
-- string ref rather than block a conv sync if the project row hasn't arrived
-- yet (push ordering isn't guaranteed).

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  description   TEXT,
  instructions  TEXT,
  sources_json  TEXT,        -- JSON-encoded ProjectSource[]
  created_at    INTEGER NOT NULL,       -- ms, client-supplied
  updated_at    INTEGER NOT NULL,       -- ms, client-supplied
  deleted_at    INTEGER                 -- ms, NULL = live
);

CREATE INDEX IF NOT EXISTS idx_projects_user_updated
  ON projects(user_id, updated_at DESC);
