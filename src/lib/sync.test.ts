/**
 * Tests for lib/sync.ts — the pull/push/debounce/retry orchestration layer.
 *
 * Strategy:
 *   1. `vi.mock('@/lib/flaudeApi', ...)` replaces syncPull/syncPush with
 *      vi.fn() stubs, keeping the real FlaudeApiError class so isRetryable()
 *      still branches correctly on status.
 *   2. Every test uses `vi.resetModules()` + dynamic re-import of the store
 *      and sync modules. This is necessary because sync.ts holds module-level
 *      state (in-flight guards, retry attempt counters, debounce timer id,
 *      previousDirty reference caches) and a top-level `subscribe()` that
 *      binds to the store singleton. Without the reset, leaking timers from
 *      test N would fire in test N+1.
 *   3. Fake timers let us drive the 800ms debounce and the exponential-backoff
 *      retry delays (1s → 5s → 30s → 2min) without actually waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock flaudeApi — hoisted before any import so sync.ts sees the mocked
// syncPull/syncPush. importActual preserves the FlaudeApiError class so
// sync.ts's `isRetryable(err)` still receives a real FlaudeApiError with a
// .status field (not just a Mock).
vi.mock('@/lib/flaudeApi', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/flaudeApi')>('@/lib/flaudeApi');
  return {
    ...actual,
    syncPull: vi.fn(),
    syncPush: vi.fn(),
  };
});

type SyncModule = typeof import('@/lib/sync');
type StoreModule = typeof import('@/store/useAppStore');
type ApiModule = typeof import('@/lib/flaudeApi');

// Re-bound in beforeEach after resetModules. Tests read through these refs
// rather than pinning the top-of-file import — they'd otherwise point at the
// stale pre-reset module.
let sync: SyncModule;
let useAppStore: StoreModule['useAppStore'];
let api: ApiModule;

// A valid-looking auth payload so authFetch-gated sync paths proceed. The
// fetch itself never hits the network — we've mocked syncPull/syncPush.
const fakeAuth = {
  token: 'tok',
  user: {
    id: 1,
    email: 'a@b',
    display_name: 'A',
    role: 'user' as const,
  },
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  // Import order matters: the store first, so sync.ts's top-level
  // useAppStore.subscribe(...) binds to the fresh store instance. Then the
  // mocked flaudeApi (so we can reach into vi.mocked(api.syncPull) from
  // tests). Finally sync.ts itself, which installs the subscribe listener.
  useAppStore = (await import('@/store/useAppStore')).useAppStore;
  api = await import('@/lib/flaudeApi');
  sync = await import('@/lib/sync');
  useAppStore.getState().setAuth(fakeAuth);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function mockPullResponse(server_time: number, overrides: Partial<{
  conversations: unknown[];
  projects: unknown[];
  artifacts: unknown[];
}> = {}) {
  return {
    conversations: overrides.conversations ?? [],
    projects: overrides.projects ?? [],
    artifacts: overrides.artifacts ?? [],
    server_time,
  } as Awaited<ReturnType<ApiModule['syncPull']>>;
}

// =============================================================================
// pullNow
// =============================================================================

describe('pullNow', () => {
  it('calls syncPull with the current cursor and applies the result', async () => {
    useAppStore.getState().setLastSyncAt(12_345);
    vi.mocked(api.syncPull).mockResolvedValue(
      mockPullResponse(99_999, {
        conversations: [
          {
            id: 'c1',
            title: 'hi',
            mode: 'chat',
            pinned: false,
            starred: false,
            createdAt: 1,
            updatedAt: 2,
            messages: [],
          },
        ],
      }),
    );

    await sync.pullNow();

    expect(vi.mocked(api.syncPull)).toHaveBeenCalledWith(12_345);
    const s = useAppStore.getState();
    expect(s.conversations.map((c) => c.id)).toEqual(['c1']);
    expect(s.lastSyncAt).toBe(99_999);
    expect(s.syncState).toBe('idle');
  });

  it('treats missing cursor as since=0 (first-run path)', async () => {
    vi.mocked(api.syncPull).mockResolvedValue(mockPullResponse(1));
    await sync.pullNow();
    expect(vi.mocked(api.syncPull)).toHaveBeenCalledWith(0);
  });

  it('is a no-op when auth is null (logged out)', async () => {
    useAppStore.getState().clearAuth();
    await sync.pullNow();
    expect(vi.mocked(api.syncPull)).not.toHaveBeenCalled();
  });

  it('coalesces concurrent calls (in-flight guard)', async () => {
    let resolve: (value: ReturnType<typeof mockPullResponse>) => void = () => {};
    vi.mocked(api.syncPull).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );

    // Two near-simultaneous calls (e.g. login + focus-restored) must share
    // the in-flight request. We can't compare the returned promises with
    // `toBe` — pullNow is declared `async`, so each call wraps the shared
    // pullInFlight in a fresh Promise. The observable contract is that the
    // underlying network call happens exactly once.
    const first = sync.pullNow();
    const second = sync.pullNow();

    resolve(mockPullResponse(1));
    await Promise.all([first, second]);
    expect(vi.mocked(api.syncPull)).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 (retryable) with 1s backoff then succeeds', async () => {
    vi.mocked(api.syncPull)
      .mockRejectedValueOnce(new api.FlaudeApiError(500, 'boom'))
      .mockResolvedValueOnce(mockPullResponse(42));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sync.pullNow();
    // After the first failure, a 1_000ms retry timer is armed. The state
    // stays in 'pulling' (not 'error') during the retry window.
    expect(useAppStore.getState().syncState).toBe('pulling');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(vi.mocked(api.syncPull)).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().syncState).toBe('idle');
    expect(useAppStore.getState().lastSyncAt).toBe(42);
    warn.mockRestore();
  });

  it('flips to error state on a non-retryable 400', async () => {
    vi.mocked(api.syncPull).mockRejectedValue(
      new api.FlaudeApiError(400, 'bad request'),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sync.pullNow();
    expect(useAppStore.getState().syncState).toBe('error');
    expect(useAppStore.getState().syncError).toContain('bad request');
    err.mockRestore();
  });
});

// =============================================================================
// pushNow
// =============================================================================

describe('pushNow', () => {
  it('no-ops when nothing is dirty (no network call)', async () => {
    await sync.pushNow();
    expect(vi.mocked(api.syncPush)).not.toHaveBeenCalled();
  });

  it('ships dirty conversations and clears dirty on success', async () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(id, {
      id: 'm1',
      role: 'user',
      content: 'hello',
      createdAt: 1000,
    });
    // appendMessage marks dirty; schedulePush's 800ms timer is armed via
    // the store subscriber. Fast-forward past it, OR just call pushNow
    // directly. We use direct calls for precision.
    vi.mocked(api.syncPush).mockResolvedValue({ accepted_at: 55_555 });
    await sync.pushNow();

    expect(vi.mocked(api.syncPush)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(api.syncPush).mock.calls[0][0];
    expect(arg.upserts).toHaveLength(1);
    expect(arg.upserts[0].id).toBe(id);
    expect(arg.upserts[0].messages).toHaveLength(1);
    expect(useAppStore.getState().dirtyConversationIds).toEqual([]);
    expect(useAppStore.getState().syncState).toBe('idle');
  });

  it('ships every queue in a single request (convs + projects + artifacts + deletions)', async () => {
    const pid = useAppStore.getState().createProject('P');
    const cid = useAppStore.getState().newConversation();
    useAppStore.getState().setConversationProject(cid, pid);
    useAppStore.getState().upsertArtifact({
      id: 'a1',
      type: 'html',
      title: 't',
      content: '<p/>',
      createdAt: 1,
      updatedAt: 2,
    });
    useAppStore.setState({
      pendingDeletions: ['old-conv'],
      pendingProjectDeletions: ['old-proj'],
      pendingArtifactDeletions: ['old-art'],
    });

    vi.mocked(api.syncPush).mockResolvedValue({ accepted_at: 1 });
    await sync.pushNow();

    const arg = vi.mocked(api.syncPush).mock.calls[0][0];
    expect(arg.projectUpserts!.map((p) => p.id)).toEqual([pid]);
    expect(arg.upserts.map((c) => c.id)).toEqual([cid]);
    expect(arg.artifactUpserts!.map((a) => a.id)).toEqual(['a1']);
    expect(arg.deletions).toEqual(['old-conv']);
    expect(arg.projectDeletions).toEqual(['old-proj']);
    expect(arg.artifactDeletions).toEqual(['old-art']);

    // All queues drained after success.
    const s = useAppStore.getState();
    expect(s.dirtyConversationIds).toEqual([]);
    expect(s.dirtyProjectIds).toEqual([]);
    expect(s.dirtyArtifactIds).toEqual([]);
    expect(s.pendingDeletions).toEqual([]);
    expect(s.pendingProjectDeletions).toEqual([]);
    expect(s.pendingArtifactDeletions).toEqual([]);
  });

  it('advances lastSyncAt to max(upserted.updatedAt) to avoid re-pulling what we pushed', async () => {
    useAppStore.setState({
      conversations: [
        {
          id: 'c1',
          title: 't',
          mode: 'chat',
          modelId: 'm',
          messages: [],
          createdAt: 0,
          updatedAt: 500,
        },
      ],
      projects: [
        { id: 'p1', name: 'p', sources: [], createdAt: 0, updatedAt: 900 },
      ],
      artifacts: {
        a1: {
          id: 'a1',
          type: 'html',
          title: 't',
          content: '',
          createdAt: 0,
          updatedAt: 700,
        },
      },
      dirtyConversationIds: ['c1'],
      dirtyProjectIds: ['p1'],
      dirtyArtifactIds: ['a1'],
      lastSyncAt: 100,
    });
    vi.mocked(api.syncPush).mockResolvedValue({ accepted_at: 1 });
    await sync.pushNow();
    expect(useAppStore.getState().lastSyncAt).toBe(900);
  });

  it('does NOT clear dirty ids that landed DURING the in-flight push', async () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().markConversationDirty(id);

    // Simulate a push that resolves after we've added another dirty id.
    let resolvePush: (value: { accepted_at: number }) => void = () => {};
    vi.mocked(api.syncPush).mockImplementation(
      () =>
        new Promise((r) => {
          resolvePush = r;
        }),
    );

    const inflight = sync.pushNow();
    // New dirty id lands while push is in-flight.
    useAppStore.getState().markConversationDirty('arrived-mid-push');

    resolvePush({ accepted_at: 1 });
    await inflight;

    // The original id is cleared, the mid-push one stays queued for the next round.
    expect(useAppStore.getState().dirtyConversationIds).toEqual(['arrived-mid-push']);
  });

  it('retries a retryable failure with backoff', async () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().markConversationDirty(id);

    vi.mocked(api.syncPush)
      .mockRejectedValueOnce(new api.FlaudeApiError(503, 'down'))
      .mockResolvedValueOnce({ accepted_at: 1 });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sync.pushNow();
    expect(useAppStore.getState().syncState).toBe('pushing');
    expect(useAppStore.getState().dirtyConversationIds).toContain(id);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(api.syncPush)).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().syncState).toBe('idle');
    expect(useAppStore.getState().dirtyConversationIds).toEqual([]);
    warn.mockRestore();
  });

  it('flips to error on a non-retryable 413 (payload too large)', async () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().markConversationDirty(id);

    vi.mocked(api.syncPush).mockRejectedValue(
      new api.FlaudeApiError(413, 'too big'),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sync.pushNow();
    expect(useAppStore.getState().syncState).toBe('error');
    // Dirty stays intact — user can retry after fixing whatever blew the cap.
    expect(useAppStore.getState().dirtyConversationIds).toContain(id);
    err.mockRestore();
  });
});

// =============================================================================
// schedulePush debounce + store subscription
// =============================================================================

describe('schedulePush', () => {
  it('coalesces rapid schedule calls into a single push after 800ms', async () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().markConversationDirty(id);
    vi.mocked(api.syncPush).mockResolvedValue({ accepted_at: 1 });

    // Three rapid "dirty" signals — the subscriber auto-schedules on each.
    // Combined with explicit schedulePush calls, we should still see exactly
    // one syncPush fire after the debounce elapses.
    sync.schedulePush();
    sync.schedulePush();
    sync.schedulePush();

    expect(vi.mocked(api.syncPush)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(vi.mocked(api.syncPush)).toHaveBeenCalledTimes(1);
  });

  it('auto-schedules on store dirty change via the top-level subscriber', async () => {
    vi.mocked(api.syncPush).mockResolvedValue({ accepted_at: 1 });
    // Marking dirty is what the store does on every edit — the subscription
    // attached at sync.ts import time should see the array-identity change
    // and call schedulePush under the hood.
    useAppStore.getState().markConversationDirty('c1');
    await vi.advanceTimersByTimeAsync(800);
    expect(vi.mocked(api.syncPush)).toHaveBeenCalledTimes(1);
  });

  it('subscriber does not schedule when auth is null', async () => {
    useAppStore.getState().clearAuth();
    useAppStore.getState().markConversationDirty('c1');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(vi.mocked(api.syncPush)).not.toHaveBeenCalled();
  });
});

// =============================================================================
// startSync — first-run seed vs subsequent-flush branching
// =============================================================================

describe('startSync', () => {
  it('coalesces concurrent calls (StrictMode double-invoke guard)', async () => {
    vi.mocked(api.syncPull).mockResolvedValue(mockPullResponse(1));
    // StrictMode re-runs the auth-change effect synchronously, so two
    // startSync() calls land back-to-back. We can't compare promise identity
    // (startSync is async, each call wraps the shared in-flight promise in a
    // new Promise) — instead verify the network-call invariant: only one
    // pull, regardless of how many start calls pile on.
    const a = sync.startSync();
    const b = sync.startSync();
    await Promise.all([a, b]);
    expect(vi.mocked(api.syncPull)).toHaveBeenCalledTimes(1);
  });

  it('first-run seed: pulls, then marks + pushes every local conv w/ messages, every project, every artifact', async () => {
    // Pre-populate local state BEFORE auth flip; mirrors the "installed the
    // app, typed into it, then logged in" flow.
    const cid = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(cid, {
      id: 'm1',
      role: 'user',
      content: 'hi',
      createdAt: 100,
    });
    useAppStore.getState().createProject('P');
    useAppStore.getState().upsertArtifact({
      id: 'a1',
      type: 'html',
      title: 't',
      content: 'x',
      createdAt: 10,
      updatedAt: 20,
    });
    // Pre-conditions: lastSyncAt null (first run), dirty flags already set
    // from the create*/upsert* calls.
    useAppStore.setState({ lastSyncAt: null });

    vi.mocked(api.syncPull).mockResolvedValue(mockPullResponse(999));
    vi.mocked(api.syncPush).mockResolvedValue({ accepted_at: 1 });

    await sync.startSync();

    // pull happens first, then push
    expect(vi.mocked(api.syncPull)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.syncPush)).toHaveBeenCalledTimes(1);
    const pushArg = vi.mocked(api.syncPush).mock.calls[0][0];
    expect(pushArg.upserts.map((c) => c.id)).toContain(cid);
    expect(pushArg.projectUpserts!).toHaveLength(1);
    expect(pushArg.artifactUpserts!.map((a) => a.id)).toEqual(['a1']);
  });

  it('first-run with NO local data just pulls and stops', async () => {
    useAppStore.setState({ lastSyncAt: null });
    vi.mocked(api.syncPull).mockResolvedValue(mockPullResponse(1));
    await sync.startSync();
    expect(vi.mocked(api.syncPush)).not.toHaveBeenCalled();
  });

  it('subsequent run (cursor set): pull, flush any residual dirty, no seed', async () => {
    useAppStore.setState({ lastSyncAt: 12_345 });
    const cid = useAppStore.getState().newConversation();
    useAppStore.getState().markConversationDirty(cid);

    vi.mocked(api.syncPull).mockResolvedValue(mockPullResponse(20_000));
    vi.mocked(api.syncPush).mockResolvedValue({ accepted_at: 1 });

    await sync.startSync();

    expect(vi.mocked(api.syncPull)).toHaveBeenCalledWith(12_345);
    expect(vi.mocked(api.syncPush)).toHaveBeenCalledTimes(1);
  });

  it('subsequent run with no dirty does not push', async () => {
    useAppStore.setState({ lastSyncAt: 100 });
    vi.mocked(api.syncPull).mockResolvedValue(mockPullResponse(1));
    await sync.startSync();
    expect(vi.mocked(api.syncPush)).not.toHaveBeenCalled();
  });

  it('bails out of the push phase if the pull failed', async () => {
    const cid = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(cid, {
      id: 'm',
      role: 'user',
      content: 'x',
      createdAt: 0,
    });

    vi.mocked(api.syncPull).mockRejectedValue(
      new api.FlaudeApiError(400, 'malformed'),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await sync.startSync();

    expect(useAppStore.getState().syncState).toBe('error');
    expect(vi.mocked(api.syncPush)).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
