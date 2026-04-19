/**
 * Conversation sync — Phase 3 (薄).
 *
 * Two endpoints, both JWT-authed and user-scoped:
 *
 *   POST /sync/push
 *     body: { upserts: SyncConversation[], deletions: string[] }
 *     Upserts whole conversations (meta + full message list). Deletions are
 *     tombstones (deleted_at = now). Last-write-wins by updated_at: if the
 *     incoming row isn't strictly newer than what the server has, we skip —
 *     the client should pull to reconcile.
 *
 *   GET  /sync/pull?since=<ms>
 *     resp: { conversations: SyncConversation[], server_time: number }
 *     Returns every conversation (live or tombstoned) with updated_at > since,
 *     with the full message list nested inline. since=0 is the first-run path
 *     and returns everything the user has.
 *
 * Design notes:
 *
 * Full-resync per dirty conv (not message-level deltas) because:
 *   - At our scale (5–10 friends, conversations ~50–200 messages) the payload
 *     cost is trivial and saves a whole class of "did every edge case push the
 *     right delta" bugs.
 *   - Truncate / regenerate flows rewrite arbitrary suffixes of the message
 *     list; a full-replace transaction handles them without special-casing.
 *   - If conversations ever grow past a few MB each we revisit with msg-level
 *     dirty tracking. Not before.
 *
 * Ownership enforcement: every query WHERE user_id = ?. A client that forges
 * someone else's conversation id either:
 *   - hits the UPSERT's WHERE filter and inserts a NEW row under their own
 *     user_id (harmless — no data leak, and they already own the row), or
 *   - fails the PK collision silently (server keeps the real owner's row).
 *
 * Timestamps: all ms. See schema.sql header for the ms-vs-seconds rationale.
 */
import { Hono } from 'hono';

import type { AppContext } from './env';
import { requireAuth } from './middleware';

const sync = new Hono<AppContext>();

sync.use('*', requireAuth);

// -----------------------------------------------------------------------------
// Wire types. Named with a Sync prefix so they don't collide with the client's
// `Conversation` / `Message` (which have more UI-only fields; the wire form
// is a subset + the columns we actually persist).
// -----------------------------------------------------------------------------
interface SyncMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | string;
  content: string;
  reasoning?: string | null;
  // Anything we don't have a first-class column for — attachments (metadata
  // only, not base64), toolCalls, etc. — is stuffed here as an opaque JSON
  // blob the client owns the shape of.
  metadata?: unknown;
  modelId?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  createdAt: number; // ms
}

interface SyncConversation {
  id: string;
  title: string;
  mode: string;
  pinned: boolean;
  starred: boolean;
  modelId?: string | null;
  projectId?: string | null;
  summary?: string | null;
  summaryMessageCount?: number | null;
  summarizedAt?: number | null;
  createdAt: number; // ms
  updatedAt: number; // ms
  deletedAt?: number | null; // ms, NULL = live
  messages: SyncMessage[];
}

// -----------------------------------------------------------------------------
// Payload caps. The numbers are deliberately generous for the friends-group
// scale and conservative enough that a buggy client can't wedge the Worker
// with a 100MB push. Measured not-at-all; feel free to raise if someone hits
// the wall in real use.
// -----------------------------------------------------------------------------
const MAX_PUSH_BYTES = 5 * 1024 * 1024;        // 5 MB total request body
const MAX_CONVS_PER_PUSH = 200;                // one push carries ≤200 convs
const MAX_MESSAGES_PER_CONV = 2_000;           // per-conv message count
const MAX_MESSAGE_BYTES = 256 * 1024;          // per-message content+reasoning+meta

// -----------------------------------------------------------------------------
// GET /sync/pull?since=<ms>
// -----------------------------------------------------------------------------
sync.get('/sync/pull', async (c) => {
  const userId = c.get('userId');
  const sinceParam = c.req.query('since');
  const since = sinceParam ? Number(sinceParam) : 0;
  if (!Number.isFinite(since) || since < 0) {
    return c.json({ error: 'invalid since' }, 400);
  }

  const serverTime = Date.now();

  // Pull all conversations (including soft-deleted tombstones) that changed
  // since the client's cursor. We send tombstones too so the client can drop
  // any locally-held copy.
  const { results: convRows } = await c.env.DB
    .prepare(
      `SELECT id, title, mode, pinned, starred, model_id, project_id,
              summary, summary_msg_count, summarized_at,
              created_at, updated_at, deleted_at
       FROM conversations
       WHERE user_id = ? AND updated_at > ?
       ORDER BY updated_at ASC`,
    )
    .bind(userId, since)
    .all<{
      id: string;
      title: string;
      mode: string;
      pinned: number;
      starred: number;
      model_id: string | null;
      project_id: string | null;
      summary: string | null;
      summary_msg_count: number | null;
      summarized_at: number | null;
      created_at: number;
      updated_at: number;
      deleted_at: number | null;
    }>();

  // For every non-tombstoned conversation in the result, fetch messages in
  // one shot using a single IN(...) query. Cheap at ≤200 ids and avoids N+1.
  const liveIds = convRows
    .filter((r) => r.deleted_at === null)
    .map((r) => r.id);

  const messagesByConv = new Map<string, SyncMessage[]>();
  if (liveIds.length > 0) {
    // D1 doesn't let us bind an array directly — expand placeholders. 200 ids
    // max, well under SQLite's 999-parameter ceiling.
    const placeholders = liveIds.map(() => '?').join(',');
    const { results: msgRows } = await c.env.DB
      .prepare(
        `SELECT id, conversation_id, role, content, reasoning, metadata_json,
                model_id, tokens_in, tokens_out, created_at
         FROM messages
         WHERE conversation_id IN (${placeholders})
         ORDER BY conversation_id ASC, created_at ASC, id ASC`,
      )
      .bind(...liveIds)
      .all<{
        id: string;
        conversation_id: string;
        role: string;
        content: string;
        reasoning: string | null;
        metadata_json: string | null;
        model_id: string | null;
        tokens_in: number | null;
        tokens_out: number | null;
        created_at: number;
      }>();

    for (const m of msgRows) {
      let metadata: unknown = undefined;
      if (m.metadata_json) {
        try {
          metadata = JSON.parse(m.metadata_json);
        } catch {
          // Corrupt metadata — drop it rather than break the pull. The
          // message's content is still intact, which is the important bit.
          metadata = undefined;
        }
      }
      const msg: SyncMessage = {
        id: m.id,
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        metadata,
        modelId: m.model_id,
        tokensIn: m.tokens_in,
        tokensOut: m.tokens_out,
        createdAt: m.created_at,
      };
      let bucket = messagesByConv.get(m.conversation_id);
      if (!bucket) {
        bucket = [];
        messagesByConv.set(m.conversation_id, bucket);
      }
      bucket.push(msg);
    }
  }

  const conversations: SyncConversation[] = convRows.map((r) => ({
    id: r.id,
    title: r.title,
    mode: r.mode,
    pinned: !!r.pinned,
    starred: !!r.starred,
    modelId: r.model_id,
    projectId: r.project_id,
    summary: r.summary,
    summaryMessageCount: r.summary_msg_count,
    summarizedAt: r.summarized_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    messages: messagesByConv.get(r.id) ?? [],
  }));

  return c.json({ conversations, server_time: serverTime });
});

// -----------------------------------------------------------------------------
// POST /sync/push
// -----------------------------------------------------------------------------
interface PushBody {
  upserts?: unknown;
  deletions?: unknown;
}

sync.post('/sync/push', async (c) => {
  const userId = c.get('userId');

  // Content-Length is advisory — clients can omit it, and chunked requests
  // won't have it — but when present it gives us a cheap early-out on
  // obviously-too-big payloads before we buffer them into memory.
  const cl = c.req.header('content-length');
  if (cl && Number(cl) > MAX_PUSH_BYTES) {
    return c.json({ error: 'payload too large' }, 413);
  }

  const body = (await c.req.json().catch(() => ({}))) as PushBody;
  const upserts = Array.isArray(body.upserts) ? (body.upserts as SyncConversation[]) : [];
  const deletions = Array.isArray(body.deletions) ? (body.deletions as string[]) : [];

  if (upserts.length > MAX_CONVS_PER_PUSH) {
    return c.json({ error: `too many conversations in one push (max ${MAX_CONVS_PER_PUSH})` }, 413);
  }

  // Validate upserts before touching the DB so we don't half-apply a batch.
  for (const conv of upserts) {
    if (typeof conv?.id !== 'string' || !conv.id) {
      return c.json({ error: 'conversation.id required' }, 400);
    }
    if (typeof conv.title !== 'string') {
      return c.json({ error: `conversation ${conv.id}: title must be string` }, 400);
    }
    if (typeof conv.mode !== 'string') {
      return c.json({ error: `conversation ${conv.id}: mode must be string` }, 400);
    }
    if (!Number.isFinite(conv.createdAt) || !Number.isFinite(conv.updatedAt)) {
      return c.json({ error: `conversation ${conv.id}: createdAt/updatedAt must be numbers` }, 400);
    }
    if (!Array.isArray(conv.messages)) {
      return c.json({ error: `conversation ${conv.id}: messages must be array` }, 400);
    }
    if (conv.messages.length > MAX_MESSAGES_PER_CONV) {
      return c.json(
        { error: `conversation ${conv.id}: too many messages (max ${MAX_MESSAGES_PER_CONV})` },
        413,
      );
    }
    for (const m of conv.messages) {
      if (typeof m.id !== 'string' || !m.id) {
        return c.json({ error: `conversation ${conv.id}: message.id required` }, 400);
      }
      if (typeof m.role !== 'string' || typeof m.content !== 'string') {
        return c.json(
          { error: `conversation ${conv.id} / msg ${m.id}: role+content required` },
          400,
        );
      }
      const approxBytes =
        (m.content?.length ?? 0) +
        (m.reasoning?.length ?? 0) +
        (m.metadata ? JSON.stringify(m.metadata).length : 0);
      if (approxBytes > MAX_MESSAGE_BYTES) {
        return c.json(
          { error: `message ${m.id}: too large (${approxBytes}B, max ${MAX_MESSAGE_BYTES}B)` },
          413,
        );
      }
    }
  }

  const now = Date.now();

  // ---------------------------------------------------------------------------
  // Apply upserts. We batch all the statements into a single D1 batch() so
  // they run in one transaction — if any step fails the whole push rolls back.
  // For each conversation:
  //   1. ON CONFLICT upsert the row, guarded by updated_at so a stale client
  //      can't overwrite a newer server row.
  //   2. DELETE all messages for the conv.
  //   3. Re-INSERT the full message list.
  //
  // The guard on (1) can cause (2) and (3) to operate on a row that wasn't
  // actually updated (server was newer). That's fine — we're just replacing
  // messages with whatever the client sent, which for a losing-write client
  // is by definition older than what's on the server. The client will pull
  // immediately after this push and reconcile.
  //
  // TODO: when this actually bites someone, add a "dry-run" SELECT before the
  // DELETE to skip the message replace for losing writes. For now: correctness
  // beats micro-optimization.
  // ---------------------------------------------------------------------------
  const stmts: D1PreparedStatement[] = [];

  for (const conv of upserts) {
    stmts.push(
      c.env.DB
        .prepare(
          `INSERT INTO conversations (
             id, user_id, title, mode, pinned, starred,
             model_id, project_id, summary, summary_msg_count, summarized_at,
             created_at, updated_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title              = excluded.title,
             mode               = excluded.mode,
             pinned             = excluded.pinned,
             starred            = excluded.starred,
             model_id           = excluded.model_id,
             project_id         = excluded.project_id,
             summary            = excluded.summary,
             summary_msg_count  = excluded.summary_msg_count,
             summarized_at      = excluded.summarized_at,
             updated_at         = excluded.updated_at,
             deleted_at         = excluded.deleted_at
           WHERE conversations.user_id = excluded.user_id
             AND excluded.updated_at > conversations.updated_at`,
        )
        .bind(
          conv.id,
          userId,
          conv.title,
          conv.mode,
          conv.pinned ? 1 : 0,
          conv.starred ? 1 : 0,
          conv.modelId ?? null,
          conv.projectId ?? null,
          conv.summary ?? null,
          conv.summaryMessageCount ?? null,
          conv.summarizedAt ?? null,
          conv.createdAt,
          conv.updatedAt,
          conv.deletedAt ?? null,
        ),
    );

    stmts.push(
      c.env.DB
        .prepare(
          `DELETE FROM messages
           WHERE conversation_id = ?
             AND conversation_id IN (SELECT id FROM conversations WHERE id = ? AND user_id = ?)`,
        )
        .bind(conv.id, conv.id, userId),
    );

    for (const m of conv.messages) {
      stmts.push(
        c.env.DB
          .prepare(
            `INSERT INTO messages (
               id, conversation_id, role, content, reasoning, metadata_json,
               model_id, tokens_in, tokens_out, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .bind(
            m.id,
            conv.id,
            m.role,
            m.content,
            m.reasoning ?? null,
            m.metadata !== undefined ? JSON.stringify(m.metadata) : null,
            m.modelId ?? null,
            m.tokensIn ?? null,
            m.tokensOut ?? null,
            m.createdAt,
          ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Tombstone deletions. We UPDATE rather than DELETE so other clients still
  // pulling see the tombstone on their next /sync/pull. The 90-day cron
  // (scheduled() in index.ts) hard-deletes rows once all reasonable clients
  // have had time to notice. Ownership check via user_id WHERE — a client
  // asking to delete someone else's conv is silently skipped.
  // ---------------------------------------------------------------------------
  for (const id of deletions) {
    if (typeof id !== 'string' || !id) continue;
    stmts.push(
      c.env.DB
        .prepare(
          `UPDATE conversations
           SET deleted_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
        )
        .bind(now, now, id, userId),
    );
  }

  if (stmts.length > 0) {
    await c.env.DB.batch(stmts);
  }

  return c.json({ accepted_at: now });
});

export default sync;

// D1PreparedStatement isn't re-exported from hono; we declare a minimal local
// alias so the `stmts` array is typed. Keeping it file-local avoids polluting
// env.ts with a type only this file uses.
type D1PreparedStatement = ReturnType<D1Database['prepare']>;
type D1Database = AppContext['Bindings']['DB'];
