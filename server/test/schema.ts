/**
 * Schema bootstrap for tests.
 *
 * We can't read schema.sql off the filesystem from inside the Workers runtime,
 * so the DDL lives inline here. It must stay in sync with the real
 * ../schema.sql — when that file changes, paste the CREATE TABLE / CREATE
 * INDEX statements here. (Schema changes are rare and always reviewed; the
 * risk of drift is lower than the complexity of `?raw` imports + split logic
 * inside the pool.)
 *
 * Only the tables the tests touch are included: users + sync-related
 * (conversations, messages, projects, artifacts) + usage_log (admin
 * dashboard LEFT JOINs it when listing users, so even zero-usage tests
 * need the table to exist for the join to bind).
 */
import type { D1Database } from '@cloudflare/workers-types';

const STATEMENTS: string[] = [
  // users
  `CREATE TABLE IF NOT EXISTS users (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    email                  TEXT NOT NULL UNIQUE,
    password_hash          TEXT NOT NULL,
    display_name           TEXT NOT NULL,
    role                   TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    monthly_quota_tokens   INTEGER,
    disabled               INTEGER NOT NULL DEFAULT 0,
    created_at             INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at             INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  // usage_log — mirrors schema.sql exactly (per-request LLM accounting).
  // Tests don't exercise quota enforcement, but the /admin/users LEFT JOINs
  // this table, so it has to exist.
  `CREATE TABLE IF NOT EXISTS usage_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ts                INTEGER NOT NULL DEFAULT (unixepoch()),
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    cost_micro_usd    INTEGER,
    conversation_id   TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_log(user_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_log(ts)`,
  // conversations
  `CREATE TABLE IF NOT EXISTS conversations (
    id                 TEXT PRIMARY KEY,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title              TEXT NOT NULL DEFAULT '',
    mode               TEXT NOT NULL DEFAULT 'chat',
    pinned             INTEGER NOT NULL DEFAULT 0,
    starred            INTEGER NOT NULL DEFAULT 0,
    model_id           TEXT,
    project_id         TEXT,
    summary            TEXT,
    summary_msg_count  INTEGER,
    summarized_at      INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    deleted_at         INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
    ON conversations(user_id, updated_at DESC)`,
  // messages
  `CREATE TABLE IF NOT EXISTS messages (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL,
    content          TEXT NOT NULL,
    reasoning        TEXT,
    metadata_json    TEXT,
    model_id         TEXT,
    tokens_in        INTEGER,
    tokens_out       INTEGER,
    created_at       INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at)`,
  // projects
  `CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL DEFAULT '',
    description   TEXT,
    instructions  TEXT,
    sources_json  TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    deleted_at    INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_user_updated
    ON projects(user_id, updated_at DESC)`,
  // artifacts
  `CREATE TABLE IF NOT EXISTS artifacts (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id   TEXT,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    language     TEXT,
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_user_updated
    ON artifacts(user_id, updated_at DESC)`,
];

export async function applySchema(db: D1Database): Promise<void> {
  // D1.batch() takes an array of PreparedStatements and runs them in a single
  // implicit transaction — perfect for schema init (all-or-nothing).
  await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
}
