-- Flaude D1 schema.
--
-- Apply locally:   pnpm db:init
-- Apply remote:    pnpm db:init:remote
--
-- Safe to re-run: every CREATE uses IF NOT EXISTS. For destructive migrations
-- we'll add numbered migration files later; for now schema.sql IS the truth.

-- -----------------------------------------------------------------------------
-- users
--   - email is the login identity (we don't do username/email split for 5-10
--     users, it's overkill).
--   - password_hash is bcrypt; we pay the ~200ms cost per login, which is fine
--     at this scale and much better than rolling our own.
--   - role is a CHECK-constrained string rather than a separate table because
--     we only have two roles and no plans to add more. If that changes, migrate
--     to a roles table; don't bolt on more string values.
--   - monthly_quota_tokens NULL means "fall back to env MONTHLY_QUOTA_TOKENS".
--     A non-null value (including 0!) overrides the default for that user.
--   - disabled is a soft-delete / lockout flag. We keep rows around so
--     usage_log FKs stay valid and historical reporting still works.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  email                  TEXT NOT NULL UNIQUE,
  password_hash          TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  monthly_quota_tokens   INTEGER,
  disabled               INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at             INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- -----------------------------------------------------------------------------
-- usage_log
--   One row per successful LLM completion. We don't log failures here (they
--   don't count against quota) but we may add an errors table later.
--
--   - ts is unix seconds at the moment the response was finalized server-side.
--   - model is the upstream model string we forwarded to the provider
--     (e.g. "deepseek-chat", "qwen-max"). Kept verbatim so we can slice by it.
--   - cost_micro_usd stores cost in micro-USD (1e-6 USD). A 1M-token DeepSeek
--     completion at $0.28 = 280000 micros. We use micros instead of cents so a
--     single 200-token reply doesn't round to zero and disappear from cost
--     reporting; aggregate with SUM / 1e6 to get dollars. Nullable because we
--     might log usage for a model we don't have a price for yet.
--   - conversation_id is a loose FK to conversations(id) -- loose because
--     conversations will land in Phase 3; for now we still want the column so
--     we don't need a migration when that lands.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts                INTEGER NOT NULL DEFAULT (unixepoch()),
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd    INTEGER,
  conversation_id   TEXT
);

-- Index pair optimized for the two hot paths:
--   (1) "how much has user X used this month" -- quota check, per request
--   (2) admin dashboard "show all usage in range" -- rare, full-table scan ok
CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_log(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_log(ts);

-- -----------------------------------------------------------------------------
-- conversations (Phase 3)
--   id is a client-generated UUID/short-uid string, NOT an autoincrement integer,
--   so offline clients can create conversations without round-tripping first.
--
--   Timestamps are stored in **milliseconds** (matches the client's Date.now()).
--   This diverges from usage_log.ts / users.created_at which use seconds —
--   intentional: sync tables round-trip to the client, which is all-ms; admin
--   / usage tables stay in seconds to match existing queries. Every column here
--   that holds a ts carries a comment saying "ms" as a reminder.
--
--   deleted_at IS NULL  → live conversation
--   deleted_at NOT NULL → soft-deleted; a daily cron (see scheduled() in
--                        src/index.ts) purges rows older than 90 days.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id                 TEXT PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title              TEXT NOT NULL DEFAULT '',
  mode               TEXT NOT NULL DEFAULT 'chat',   -- 'chat' | 'code'
  pinned             INTEGER NOT NULL DEFAULT 0,
  starred            INTEGER NOT NULL DEFAULT 0,
  model_id           TEXT,
  project_id         TEXT,     -- loose ref; projects aren't synced yet
  summary            TEXT,
  summary_msg_count  INTEGER,
  summarized_at      INTEGER,  -- ms
  created_at         INTEGER NOT NULL,                -- ms, client-supplied
  updated_at         INTEGER NOT NULL,                -- ms, client-supplied
  deleted_at         INTEGER                          -- ms, NULL = live
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
  ON conversations(user_id, updated_at DESC);

-- -----------------------------------------------------------------------------
-- messages (Phase 3)
--   role: 'user' | 'assistant' | 'system' | 'tool' -- we don't CHECK-constrain
--   because the tool-calling spec is still evolving; validate in app code.
--
--   content    — the primary text body (what the UI renders as the bubble).
--   reasoning  — thinking-model trace, shown collapsed under the reply.
--   metadata_json — JSON-encoded { attachments?, toolCalls? }. D1 has no JSON
--                   type; it's TEXT with an app-layer contract.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL,
  reasoning        TEXT,
  metadata_json    TEXT,
  model_id         TEXT,
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  created_at       INTEGER NOT NULL                   -- ms, client-supplied
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);
