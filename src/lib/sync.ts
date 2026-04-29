/**
 * Client-side sync manager (Phase 3).
 *
 * Drives /sync/pull + /sync/push against the Flaude server. The store owns
 * the dirty bookkeeping (see useAppStore.dirtyConversationIds and friends);
 * this module just reads that state, hits the network, and updates the
 * cursor.
 *
 * Responsibilities:
 *   - pullNow()   — fetch everything since `lastSyncAt` and merge into store.
 *   - pushNow()   — drain `dirtyConversationIds` + `pendingDeletions`.
 *   - schedulePush() — debounced wrapper so a burst of edits (streaming reply,
 *                      rapid renames) collapses into one request.
 *   - startSync() — first-run orchestration for the auth-gate: pull, then if
 *                   this is the very first sync (no cursor, but we have local
 *                   data), seed-push everything.
 *
 * What this does NOT do:
 *   - Poll periodically. Single-device single-user (the common case) doesn't
 *     need it; multi-device users get fresh data on next login. If that ever
 *     becomes a real complaint, add a 30s interval here.
 *   - Handle conflict resolution beyond LWW. Server does the real enforcement
 *     (see server/src/sync.ts "LWW" comments).
 *
 * What this DOES do for transient failures:
 *   - Exponential backoff retry: 1s → 5s → 30s → 2min, then give up and
 *     flip to 'error' state. Only retryable errors count (network-layer
 *     throws, server 5xx); 4xx means the client sent something wrong and
 *     retrying won't help. 401/403 are already redirected by authFetch.
 *   - During the retry window the syncState stays as 'pulling'/'pushing'
 *     so the sidebar spinner keeps spinning — from the user's POV it's
 *     "still trying", not "failed".
 *   - A fresh explicit trigger (user edit → schedulePush, or another
 *     pullNow call) cancels the pending retry timer. Users always beat
 *     the backoff clock.
 *
 * All network calls route through flaudeApi.authFetch, so 401/403 already
 * auto-drops to the login screen. We never need to check auth inline here.
 */
import {
  FlaudeApiError,
  syncPull,
  syncPush,
  type SyncArtifact,
  type SyncConversation,
  type SyncMessage,
  type SyncProject,
} from '@/lib/flaudeApi';
import { useAppStore } from '@/store/useAppStore';
import type { Artifact } from '@/lib/artifacts';
import type { Conversation, Message, Project } from '@/types';

// -----------------------------------------------------------------------------
// Debounce. 800ms is the compromise between "don't re-push on every streamed
// token" and "don't make the user stare at 'saving...' for seconds after they
// rename a conversation". Picked by feel; raise if the server logs are noisy,
// lower if syncs feel sluggish.
// -----------------------------------------------------------------------------
const PUSH_DEBOUNCE_MS = 800;

let pushDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * In-flight guards. Without these, two near-simultaneous pull triggers (login
 * + focus-restored) would race and each apply the same merge twice. Idempotent
 * for correctness, wasteful for bandwidth.
 */
let pullInFlight: Promise<void> | null = null;
let pushInFlight: Promise<void> | null = null;
/**
 * `startSync` is wired to App.tsx's auth-change useEffect. In React.StrictMode
 * (dev only, but also any future callsite that re-fires on remount) useEffect
 * runs twice, so without a guard we'd do pull+seed twice in parallel. The
 * second run isn't harmful — LWW on the server makes the seed push a no-op —
 * but it doubles network traffic on every login. Track the in-flight promise
 * and return it on re-entry, same pattern as pullInFlight/pushInFlight above.
 */
let startSyncInFlight: Promise<void> | null = null;

// -----------------------------------------------------------------------------
// Retry state. Separate counters/timers for pull and push so a flapping push
// doesn't delay a perfectly-fine pull (or vice versa). Counter is reset on
// a successful round-trip; schedulePull/PushRetry increments.
// -----------------------------------------------------------------------------
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000];

let pullRetryTimer: ReturnType<typeof setTimeout> | null = null;
let pullRetryAttempt = 0;
let pushRetryTimer: ReturnType<typeof setTimeout> | null = null;
let pushRetryAttempt = 0;

/**
 * Transient-vs-permanent error classification. `FlaudeApiError` carries a
 * status, so we branch on it; anything else came from the fetch layer
 * (network unreachable, DNS, TLS handshake, abort) and is worth retrying.
 *
 * 401/403 never reach us — authFetch intercepts and clears auth.
 * 400 / 404 / 422 are client bugs — retrying won't fix them.
 * 5xx is transient server state — retry.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof FlaudeApiError) return err.status >= 500;
  return true;
}

function clearPullRetry(): void {
  if (pullRetryTimer) {
    clearTimeout(pullRetryTimer);
    pullRetryTimer = null;
  }
}

function clearPushRetry(): void {
  if (pushRetryTimer) {
    clearTimeout(pushRetryTimer);
    pushRetryTimer = null;
  }
}

// -----------------------------------------------------------------------------
// Client-local → wire shape conversion. Kept in this file (not in the store)
// because it's network-layer concern: the store never touches SyncConversation.
//
// Exported so `lib/accountExport.ts` can build a round-trip-compatible JSON
// bundle using the same schema the /sync/pull/push endpoints speak — that way
// a future "import backup" path can feed the bundle into applyPulled* without
// a second, bespoke schema.
// -----------------------------------------------------------------------------
export function toWireMessage(m: Message): SyncMessage {
  // attachments and toolCalls go into metadata_json on the server. We strip
  // any `data:` base64 blobs from attachments before sending — they're too
  // big for the wire and the UI already discards them in partialize().
  const metadata: Record<string, unknown> = {};
  if (m.attachments && m.attachments.length > 0) {
    metadata.attachments = m.attachments.map((a) => ({
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      // deliberately drop `data` and `url` — transient per-session.
    }));
  }
  if (m.toolCalls && m.toolCalls.length > 0) {
    metadata.toolCalls = m.toolCalls;
  }
  // v0.1.52 — Anthropic Extended Thinking signature. Server schema doesn't
  // have a column for it, so it rides in metadata alongside attachments /
  // toolCalls. The pull path below mirrors this and reads it back out.
  if (m.reasoningSignature) {
    metadata.reasoningSignature = m.reasoningSignature;
  }
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? null,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    modelId: m.modelId ?? null,
    tokensIn: m.tokensIn ?? null,
    tokensOut: m.tokensOut ?? null,
    createdAt: m.createdAt,
  };
}

export function toWireProject(p: Project): SyncProject {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    instructions: p.instructions ?? null,
    // Pass sources through as an opaque array — the server doesn't validate
    // the element shape and the client is the authoritative schema.
    sources: p.sources ?? [],
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    // Live push; deletions go via the projectDeletions[] array.
    deletedAt: null,
  };
}

export function toWireArtifact(a: Artifact): SyncArtifact {
  return {
    id: a.id,
    messageId: a.messageId ?? null,
    type: a.type,
    title: a.title,
    language: a.language ?? null,
    content: a.content,
    createdAt: a.createdAt,
    // Pre-migration rows may lack updatedAt; the store stamps it on every
    // upsert, but a first-sync seed path might hit an artifact that was
    // rehydrated without ever being touched. Fall back to createdAt so the
    // server gets a monotonic-enough value (worst case: the row's LWW guard
    // never wins until the user next edits it, which is acceptable).
    updatedAt: a.updatedAt ?? a.createdAt,
    deletedAt: null,
  };
}

export function toWireConversation(c: Conversation): SyncConversation {
  return {
    id: c.id,
    title: c.title,
    mode: c.mode,
    pinned: !!c.pinned,
    starred: !!c.starred,
    modelId: c.modelId ?? null,
    projectId: c.projectId ?? null,
    summary: c.summary ?? null,
    summaryMessageCount: c.summaryMessageCount ?? null,
    summarizedAt: c.summarizedAt ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // Live conversations push deletedAt=null; deletions go via the deletions[]
    // array, not via upserts (see deleteConversation in the store).
    deletedAt: null,
    messages: c.messages.map(toWireMessage),
  };
}

// -----------------------------------------------------------------------------
// Pull
// -----------------------------------------------------------------------------
export async function pullNow(): Promise<void> {
  if (pullInFlight) return pullInFlight;
  const store = useAppStore.getState();
  if (!store.auth) return;

  // Any explicit call preempts a scheduled retry — we're trying right now,
  // no reason to keep the old timer pending. The counter is preserved; it
  // only resets on success (so a sequence of "user keeps clicking retry
  // while the server is down" still caps at 4 attempts total).
  clearPullRetry();

  store.setSyncState('pulling');
  const since = store.lastSyncAt ?? 0;

  pullInFlight = (async () => {
    try {
      const res = await syncPull(since);
      const s = useAppStore.getState();
      s.applyPulledConversations(res.conversations);
      // projects was introduced in Phase 3.1 — an older server will omit the
      // field. Treat missing as empty so we don't crash talking to a stale
      // Worker deployment.
      if (res.projects && res.projects.length > 0) {
        s.applyPulledProjects(res.projects);
      }
      // artifacts: introduced in Phase 3.2. Same story.
      if (res.artifacts && res.artifacts.length > 0) {
        s.applyPulledArtifacts(res.artifacts);
      }
      s.setLastSyncAt(res.server_time);
      s.setSyncState('idle');
      pullRetryAttempt = 0; // clean round-trip → fresh budget next time
    } catch (err) {
      const msg =
        err instanceof FlaudeApiError ? err.message : (err as Error).message;

      if (isRetryable(err) && pullRetryAttempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[pullRetryAttempt];
        pullRetryAttempt++;
        console.warn(
          `[sync] pull failed (${msg}); retry ${pullRetryAttempt}/${RETRY_DELAYS_MS.length} in ${delay}ms`,
        );
        // Stay in 'pulling' so the spinner keeps turning. Users shouldn't
        // see a red error flash for a hiccup we're about to recover from.
        pullRetryTimer = setTimeout(() => {
          pullRetryTimer = null;
          void pullNow();
        }, delay);
      } else {
        console.error('[sync] pull failed permanently:', msg);
        pullRetryAttempt = 0;
        useAppStore.getState().setSyncState('error', msg);
      }
      // Don't rethrow — pull failures shouldn't crash the app. Next trigger
      // (next login, next manual retry) tries again.
    } finally {
      pullInFlight = null;
    }
  })();

  return pullInFlight;
}

// -----------------------------------------------------------------------------
// Push
// -----------------------------------------------------------------------------
export async function pushNow(): Promise<void> {
  if (pushInFlight) return pushInFlight;
  const store = useAppStore.getState();
  if (!store.auth) return;

  const dirtyIds = [...store.dirtyConversationIds];
  const deletionIds = [...store.pendingDeletions];
  const dirtyProjectIds = [...store.dirtyProjectIds];
  const projectDeletionIds = [...store.pendingProjectDeletions];
  const dirtyArtifactIds = [...store.dirtyArtifactIds];
  const artifactDeletionIds = [...store.pendingArtifactDeletions];
  if (
    dirtyIds.length === 0 &&
    deletionIds.length === 0 &&
    dirtyProjectIds.length === 0 &&
    projectDeletionIds.length === 0 &&
    dirtyArtifactIds.length === 0 &&
    artifactDeletionIds.length === 0
  ) {
    return;
  }

  // Preempt pending retry — see the matching comment in pullNow.
  clearPushRetry();

  store.setSyncState('pushing');

  const dirtySet = new Set(dirtyIds);
  const upserts = store.conversations
    .filter((c) => dirtySet.has(c.id))
    .map(toWireConversation);

  const dirtyProjectSet = new Set(dirtyProjectIds);
  const projectUpserts = store.projects
    .filter((p) => dirtyProjectSet.has(p.id))
    .map(toWireProject);

  const dirtyArtifactSet = new Set(dirtyArtifactIds);
  const artifactUpserts = Object.values(store.artifacts)
    .filter((a) => dirtyArtifactSet.has(a.id))
    .map(toWireArtifact);

  pushInFlight = (async () => {
    try {
      await syncPush({
        upserts,
        deletions: deletionIds,
        projectUpserts,
        projectDeletions: projectDeletionIds,
        artifactUpserts,
        artifactDeletions: artifactDeletionIds,
      });

      // Only clear what we actually sent — a new edit might have landed
      // during the in-flight push, which should stay queued for the next
      // round. Same for new deletions.
      const s = useAppStore.getState();
      s.clearDirty(dirtyIds);
      s.clearPendingDeletions(deletionIds);
      s.clearProjectDirty(dirtyProjectIds);
      s.clearPendingProjectDeletions(projectDeletionIds);
      s.clearArtifactDirty(dirtyArtifactIds);
      s.clearPendingArtifactDeletions(artifactDeletionIds);
      s.setSyncState('idle');
      pushRetryAttempt = 0;

      // After a successful push, the server now has newer rows than our
      // cursor. Pulling would return the rows we just pushed (wasted round
      // trip) UNLESS we advance the cursor locally. We don't have a precise
      // "what server_time does the server consider those upserts to have"
      // reading — server uses the client-sent updatedAt, not "now" — so
      // advancing lastSyncAt past the latest pushed updatedAt is safe: any
      // concurrent edit from another device will have a later updatedAt
      // and still come down on the next pull.
      //
      // Include projects in the max so a projects-only push also advances
      // the cursor.
      const convMax = upserts.reduce(
        (m, c) => (c.updatedAt > m ? c.updatedAt : m),
        0,
      );
      const projMax = projectUpserts.reduce(
        (m, p) => (p.updatedAt > m ? p.updatedAt : m),
        0,
      );
      const artMax = artifactUpserts.reduce(
        (m, a) => (a.updatedAt > m ? a.updatedAt : m),
        0,
      );
      const maxUpdatedAt = Math.max(
        convMax,
        projMax,
        artMax,
        s.lastSyncAt ?? 0,
      );
      if (maxUpdatedAt > (s.lastSyncAt ?? 0)) {
        s.setLastSyncAt(maxUpdatedAt);
      }
    } catch (err) {
      const msg =
        err instanceof FlaudeApiError ? err.message : (err as Error).message;

      if (isRetryable(err) && pushRetryAttempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[pushRetryAttempt];
        pushRetryAttempt++;
        console.warn(
          `[sync] push failed (${msg}); retry ${pushRetryAttempt}/${RETRY_DELAYS_MS.length} in ${delay}ms`,
        );
        pushRetryTimer = setTimeout(() => {
          pushRetryTimer = null;
          void pushNow();
        }, delay);
      } else {
        console.error('[sync] push failed permanently:', msg);
        pushRetryAttempt = 0;
        useAppStore.getState().setSyncState('error', msg);
      }
      // dirty/pendingDeletions stay intact; next trigger retries.
    } finally {
      pushInFlight = null;
    }
  })();

  return pushInFlight;
}

// -----------------------------------------------------------------------------
// Debounced push. Call this from the store subscription (below) whenever the
// dirty set changes.
// -----------------------------------------------------------------------------
export function schedulePush(): void {
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(() => {
    pushDebounceTimer = null;
    void pushNow();
  }, PUSH_DEBOUNCE_MS);
}

// -----------------------------------------------------------------------------
// First-run orchestration, called by App.tsx after the auth gate flips open.
// Semantics:
//   1. Pull to get whatever the server already has.
//   2. If this was a fresh install (lastSyncAt was null before the pull) AND
//      we have local conversations the pull didn't cover, seed-push them.
//      We use "conversations with messages" as the filter so we don't push
//      empty 新对话 shells.
//   3. Otherwise: just flush any dirty rows left over from a crashed session.
// -----------------------------------------------------------------------------
export async function startSync(): Promise<void> {
  // Coalesce concurrent calls (e.g. React.StrictMode double-invoking the
  // auth-change useEffect in dev). Both callers get the same promise back.
  if (startSyncInFlight) return startSyncInFlight;

  startSyncInFlight = (async () => {
    try {
      const before = useAppStore.getState();
      const isFirstRun = before.lastSyncAt === null;
      const hadLocalData =
        before.conversations.some((c) => c.messages.length > 0) ||
        before.projects.length > 0 ||
        Object.keys(before.artifacts).length > 0;

      await pullNow();

      const after = useAppStore.getState();
      if (after.syncState === 'error') return; // pull failed, don't compound

      if (isFirstRun && hadLocalData) {
        // Seed: every local conv with content that the pull didn't just replace
        // gets marked dirty and pushed. We can't just markAllConversationsDirty
        // because applyPulledConversations cleared the dirty flag for anything
        // it canonicalised — so we'd be pushing stale versions of server rows.
        // Cross-reference: only mark convs the server didn't return.
        const afterIds = new Set(after.conversations.map((c) => c.id));
        // Find convs that are in the (post-pull) store but that the server
        // didn't send back — those are the purely-local ones. The ones with
        // messages are the ones worth pushing.
        //
        // NB: applyPulledConversations already dropped dirty marks for any row
        // the server canonicalised. What we mark here are the convs the server
        // has never seen.
        for (const c of after.conversations) {
          // The server roundtripped convs come back with updatedAt matching
          // what the server has. Locally-unique convs retain their pre-pull
          // identity. Rather than trying to distinguish, we just re-mark every
          // conv with messages that existed before the pull — the server's LWW
          // guard will no-op the ones that are actually in sync.
          if (c.messages.length > 0 && afterIds.has(c.id)) {
            useAppStore.getState().markConversationDirty(c.id);
          }
        }
        // Same logic for projects — mark everything we still have locally.
        // Unlike convs we don't filter by "has content"; an empty project
        // shell is still meaningful (the user will pour instructions into
        // it over multiple sessions).
        for (const p of after.projects) {
          useAppStore.getState().markProjectDirty(p.id);
        }
        // And artifacts. No "has content" filter either — every artifact
        // by definition carries content (empty ones wouldn't have been
        // upserted), and the 800ms debounce already collapses the burst.
        for (const aid of Object.keys(after.artifacts)) {
          useAppStore.getState().markArtifactDirty(aid);
        }
        await pushNow();
      } else if (
        after.dirtyConversationIds.length > 0 ||
        after.pendingDeletions.length > 0 ||
        after.dirtyProjectIds.length > 0 ||
        after.pendingProjectDeletions.length > 0 ||
        after.dirtyArtifactIds.length > 0 ||
        after.pendingArtifactDeletions.length > 0
      ) {
        await pushNow();
      }
    } finally {
      startSyncInFlight = null;
    }
  })();

  return startSyncInFlight;
}

// -----------------------------------------------------------------------------
// Store subscription: whenever the dirty set or pending deletions change,
// schedule a debounced push. Installing it once at module-import time is
// fine — the store is a singleton.
//
// We compare by reference identity on the array (works because the store's
// write actions always produce a new array via spread) rather than length,
// so rapid same-length changes still trigger a push.
// -----------------------------------------------------------------------------
let previousDirty: string[] | null = null;
let previousDeletions: string[] | null = null;
let previousProjectDirty: string[] | null = null;
let previousProjectDeletions: string[] | null = null;
let previousArtifactDirty: string[] | null = null;
let previousArtifactDeletions: string[] | null = null;
useAppStore.subscribe((state) => {
  const dirtyChanged = state.dirtyConversationIds !== previousDirty;
  const deletionsChanged = state.pendingDeletions !== previousDeletions;
  const projectDirtyChanged = state.dirtyProjectIds !== previousProjectDirty;
  const projectDeletionsChanged =
    state.pendingProjectDeletions !== previousProjectDeletions;
  const artifactDirtyChanged =
    state.dirtyArtifactIds !== previousArtifactDirty;
  const artifactDeletionsChanged =
    state.pendingArtifactDeletions !== previousArtifactDeletions;
  previousDirty = state.dirtyConversationIds;
  previousDeletions = state.pendingDeletions;
  previousProjectDirty = state.dirtyProjectIds;
  previousProjectDeletions = state.pendingProjectDeletions;
  previousArtifactDirty = state.dirtyArtifactIds;
  previousArtifactDeletions = state.pendingArtifactDeletions;
  if (
    !dirtyChanged &&
    !deletionsChanged &&
    !projectDirtyChanged &&
    !projectDeletionsChanged &&
    !artifactDirtyChanged &&
    !artifactDeletionsChanged
  ) {
    return;
  }
  // Only schedule when auth is present — otherwise we'd burn a timer on every
  // edit made while logged out (can't happen in the current auth gate, but
  // defensive).
  if (!state.auth) return;
  if (
    state.dirtyConversationIds.length === 0 &&
    state.pendingDeletions.length === 0 &&
    state.dirtyProjectIds.length === 0 &&
    state.pendingProjectDeletions.length === 0 &&
    state.dirtyArtifactIds.length === 0 &&
    state.pendingArtifactDeletions.length === 0
  ) {
    return;
  }
  schedulePush();
});
