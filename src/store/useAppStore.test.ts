/**
 * Tests for useAppStore — the single source of truth for conversations,
 * projects, artifacts, and the Phase-3 sync bookkeeping (dirty queues + LWW
 * apply-pulled helpers).
 *
 * Strategy:
 *   - Snapshot the initial state at module load; beforeEach resets via
 *     `setState(initialState, true)` so each test gets a clean slate without
 *     rebuilding the store (which would lose the persist wrapper and the
 *     subscribe listeners we don't want to reinstall).
 *   - `vi.setSystemTime` locks Date.now() so `updatedAt` comparisons are
 *     deterministic across the LWW tests that care about ordering.
 *
 * We don't mock `@/lib/tools` or `@/lib/mcp` — the actions that reach into
 * those modules (setToolDisabled, connectMCPServer) are NOT exercised here;
 * we focus on pure state transitions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore, type AuthUser } from './useAppStore';
import type { Conversation, Message, Project } from '@/types';
import type { Artifact } from '@/lib/artifacts';

// Snapshot the initial state AFTER module load so every action function +
// default value is captured by reference. setState(snapshot, true) replaces
// the whole state in one shot — actions survive because they're fields on
// the snapshot object.
const INITIAL_STATE = useAppStore.getState();

function resetStore(): void {
  useAppStore.setState(INITIAL_STATE, true);
}

function makeMessage(id: string, content = 'hi', role: Message['role'] = 'user'): Message {
  return { id, role, content, createdAt: Date.now() };
}

function makeConversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  const now = Date.now();
  return {
    id,
    title: 'conv',
    mode: 'chat',
    modelId: 'test-model',
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    id,
    name: 'proj',
    sources: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeArtifact(id: string, overrides: Partial<Artifact> = {}): Artifact {
  const now = Date.now();
  return {
    id,
    type: 'html',
    title: 't',
    content: '<p/>',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const fakeAuth = {
  token: 'tok',
  user: { id: 1, email: 'a@b', display_name: 'A', role: 'user' } as AuthUser,
};

beforeEach(() => {
  resetStore();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-19T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================================
// Conversations
// =============================================================================

describe('newConversation', () => {
  it('prepends a new conversation with a generated id', () => {
    const id = useAppStore.getState().newConversation();
    const s = useAppStore.getState();
    expect(s.conversations).toHaveLength(1);
    expect(s.conversations[0].id).toBe(id);
    expect(s.activeConversationId).toBe(id);
  });

  it('does NOT mark the fresh shell dirty (no empty-draft pollution)', () => {
    useAppStore.getState().newConversation();
    expect(useAppStore.getState().dirtyConversationIds).toEqual([]);
  });

  it('uses the requested mode and sets activeMode to match', () => {
    useAppStore.setState({ activeMode: 'chat' });
    useAppStore.getState().newConversation('code');
    const s = useAppStore.getState();
    expect(s.activeMode).toBe('code');
    expect(s.conversations[0].mode).toBe('code');
  });

  it('falls back to DEFAULT_MODEL_BY_MODE when modelByMode lacks the requested mode', () => {
    // Repro for the v0.1.9 "model is required" bug: a v0.1.8 user upgrades, the
    // persisted modelByMode lacks the design key, and newConversation('design')
    // would otherwise stamp modelId=undefined and cause the next send to 400.
    // Simulate the upgrade state by deleting the design key from modelByMode.
    useAppStore.setState({
      modelByMode: { chat: 'deepseek-chat', code: 'deepseek-chat' } as unknown as
        ReturnType<typeof useAppStore.getState>['modelByMode'],
    });
    useAppStore.getState().newConversation('design');
    const s = useAppStore.getState();
    expect(s.conversations[0].modelId).toBe('deepseek-v4-pro');
  });
});

describe('appendMessage', () => {
  it('appends, marks dirty, bumps updatedAt, and auto-titles from first user msg', () => {
    const id = useAppStore.getState().newConversation();
    vi.advanceTimersByTime(1000);
    useAppStore.getState().appendMessage(id, makeMessage('m1', '你好世界 — 一段长话以测试截断行为', 'user'));
    const conv = useAppStore.getState().conversations.find((c) => c.id === id)!;
    expect(conv.messages).toHaveLength(1);
    expect(conv.title).toBe('你好世界 — 一段长话以测试截断行为'); // <= 40 chars
    expect(conv.updatedAt).toBe(Date.now());
    expect(useAppStore.getState().dirtyConversationIds).toContain(id);
  });

  it('does not auto-rewrite the title once messages exist', () => {
    // Auto-title only fires on the FIRST user message (messages.length === 0).
    // Once there's already a message, appendMessage must not touch title —
    // that'd wipe out any manual rename or an earlier auto-title.
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(id, makeMessage('m1', '第一条消息'));
    useAppStore.getState().renameConversation(id, '手动命名');
    useAppStore.getState().appendMessage(id, makeMessage('m2', '第二条消息'));
    const conv = useAppStore.getState().conversations.find((c) => c.id === id)!;
    expect(conv.title).toBe('手动命名');
  });
});

describe('deleteConversation', () => {
  it('queues a tombstone when the conv has messages', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(id, makeMessage('m1'));
    useAppStore.getState().deleteConversation(id);
    const s = useAppStore.getState();
    expect(s.conversations.find((c) => c.id === id)).toBeUndefined();
    expect(s.pendingDeletions).toContain(id);
  });

  it('does NOT queue a tombstone for an empty unsynced shell', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().deleteConversation(id);
    expect(useAppStore.getState().pendingDeletions).not.toContain(id);
  });

  it('queues a tombstone when the conv is dirty even if empty', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().markConversationDirty(id);
    useAppStore.getState().deleteConversation(id);
    expect(useAppStore.getState().pendingDeletions).toContain(id);
  });

  it('clears activeConversationId when the active conv is deleted', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().deleteConversation(id);
    expect(useAppStore.getState().activeConversationId).toBeNull();
  });
});

describe('clearConversation', () => {
  it('drops messages but keeps the shell and marks dirty', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(id, makeMessage('m1'));
    useAppStore.getState().clearConversation(id);
    const conv = useAppStore.getState().conversations.find((c) => c.id === id)!;
    expect(conv.messages).toEqual([]);
    expect(useAppStore.getState().dirtyConversationIds).toContain(id);
  });
});

describe('truncateFrom', () => {
  it('slices up to (but not including) the target when inclusive=true', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(id, makeMessage('m1'));
    useAppStore.getState().appendMessage(id, makeMessage('m2'));
    useAppStore.getState().appendMessage(id, makeMessage('m3'));
    useAppStore.getState().truncateFrom(id, 'm2', true);
    const conv = useAppStore.getState().conversations.find((c) => c.id === id)!;
    expect(conv.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('keeps the target when inclusive=false', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(id, makeMessage('m1'));
    useAppStore.getState().appendMessage(id, makeMessage('m2'));
    useAppStore.getState().appendMessage(id, makeMessage('m3'));
    useAppStore.getState().truncateFrom(id, 'm2', false);
    const conv = useAppStore.getState().conversations.find((c) => c.id === id)!;
    expect(conv.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('is a no-op if the target id is missing (no dirty mark)', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(id, makeMessage('m1'));
    // clear dirty from appendMessage to isolate
    useAppStore.getState().clearDirty([id]);
    useAppStore.getState().truncateFrom(id, 'nonexistent');
    expect(useAppStore.getState().dirtyConversationIds).not.toContain(id);
  });
});

describe('branchConversation', () => {
  it('creates a new conv with messages up to (and including) the target and marks dirty', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(id, makeMessage('m1'));
    useAppStore.getState().appendMessage(id, makeMessage('m2'));
    useAppStore.getState().appendMessage(id, makeMessage('m3'));
    const newId = useAppStore.getState().branchConversation(id, 'm2');
    expect(newId).not.toBe(id);
    const s = useAppStore.getState();
    const branch = s.conversations.find((c) => c.id === newId)!;
    expect(branch.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(branch.title).toMatch(/\(分支\)$/);
    expect(s.dirtyConversationIds).toContain(newId);
  });
});

describe('setConversationModel', () => {
  it('swaps model without bumping updatedAt or marking dirty', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().appendMessage(id, makeMessage('m1'));
    useAppStore.getState().clearDirty([id]);
    const before = useAppStore.getState().conversations.find((c) => c.id === id)!.updatedAt;
    vi.advanceTimersByTime(5000);
    useAppStore.getState().setConversationModel(id, 'new-model');
    const after = useAppStore.getState().conversations.find((c) => c.id === id)!;
    expect(after.modelId).toBe('new-model');
    expect(after.updatedAt).toBe(before);
    expect(useAppStore.getState().dirtyConversationIds).not.toContain(id);
  });
});

// =============================================================================
// Projects
// =============================================================================

describe('createProject', () => {
  it('prepends a project, sets active, and marks dirty immediately', () => {
    const id = useAppStore.getState().createProject('Alpha', 'desc');
    const s = useAppStore.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].name).toBe('Alpha');
    expect(s.activeProjectId).toBe(id);
    expect(s.dirtyProjectIds).toContain(id);
  });
});

describe('updateProject / addProjectSource / removeProjectSource', () => {
  it('marks the project dirty on every edit', () => {
    const id = useAppStore.getState().createProject('P');
    useAppStore.getState().clearProjectDirty([id]);

    useAppStore.getState().updateProject(id, { instructions: 'test' });
    expect(useAppStore.getState().dirtyProjectIds).toContain(id);
    useAppStore.getState().clearProjectDirty([id]);

    useAppStore
      .getState()
      .addProjectSource(id, { id: 's1', kind: 'text', name: 'note', content: 'x' });
    expect(useAppStore.getState().dirtyProjectIds).toContain(id);
    useAppStore.getState().clearProjectDirty([id]);

    useAppStore.getState().removeProjectSource(id, 's1');
    expect(useAppStore.getState().dirtyProjectIds).toContain(id);
  });
});

describe('deleteProject', () => {
  it('cascades projectId=undefined on affected convs AND marks those convs dirty', () => {
    const pid = useAppStore.getState().createProject('P');
    const cid = useAppStore.getState().newConversation();
    useAppStore.getState().setConversationProject(cid, pid);
    useAppStore.getState().clearDirty([cid]);

    useAppStore.getState().deleteProject(pid);
    const s = useAppStore.getState();
    const conv = s.conversations.find((c) => c.id === cid)!;
    expect(conv.projectId).toBeUndefined();
    expect(s.dirtyConversationIds).toContain(cid);
    expect(s.projects).toEqual([]);
    expect(s.activeProjectId).toBeNull();
  });

  it('queues a tombstone when the project was ever synced (lastSyncAt set)', () => {
    const pid = useAppStore.getState().createProject('P');
    useAppStore.getState().setLastSyncAt(123);
    useAppStore.getState().clearProjectDirty([pid]);
    useAppStore.getState().deleteProject(pid);
    expect(useAppStore.getState().pendingProjectDeletions).toContain(pid);
  });

  it('does NOT queue a tombstone when the project is purely local (dirty + never synced)', () => {
    const pid = useAppStore.getState().createProject('P');
    // lastSyncAt is still null AND the project is still in dirtyProjectIds
    useAppStore.getState().deleteProject(pid);
    expect(useAppStore.getState().pendingProjectDeletions).not.toContain(pid);
  });
});

// =============================================================================
// Artifacts
// =============================================================================

describe('upsertArtifact', () => {
  it('inserts a new artifact, reveals the panel, marks dirty, stamps updatedAt', () => {
    vi.setSystemTime(new Date('2026-04-19T00:00:00.000Z'));
    useAppStore.getState().upsertArtifact(makeArtifact('a1', { createdAt: 100 }));
    const s = useAppStore.getState();
    expect(s.artifacts['a1']).toBeDefined();
    expect(s.artifacts['a1'].updatedAt).toBe(Date.now());
    expect(s.activeArtifactId).toBe('a1');
    expect(s.artifactsOpen).toBe(true);
    expect(s.dirtyArtifactIds).toContain('a1');
  });

  it('preserves original createdAt across streaming updates (fix for Date.now() jitter)', () => {
    const originalCreatedAt = 100;
    useAppStore.getState().upsertArtifact(makeArtifact('a1', { createdAt: originalCreatedAt, content: 'v1' }));
    vi.advanceTimersByTime(1000);
    // Parser re-calls upsert with a fresh Date.now() createdAt — store must ignore.
    useAppStore
      .getState()
      .upsertArtifact(makeArtifact('a1', { createdAt: Date.now(), content: 'v2 longer' }));
    const a = useAppStore.getState().artifacts['a1'];
    expect(a.createdAt).toBe(originalCreatedAt);
    expect(a.content).toBe('v2 longer');
    expect(a.updatedAt).toBe(Date.now()); // fresh on every upsert
  });

  it('does NOT yank the panel open on updates to an existing id', () => {
    useAppStore.getState().upsertArtifact(makeArtifact('a1'));
    useAppStore.setState({ artifactsOpen: false, activeArtifactId: null });
    useAppStore.getState().upsertArtifact(makeArtifact('a1', { content: 'v2' }));
    const s = useAppStore.getState();
    expect(s.artifactsOpen).toBe(false);
    expect(s.activeArtifactId).toBeNull();
  });
});

describe('deleteArtifact', () => {
  it('queues a tombstone when the artifact was not purely local', () => {
    useAppStore.getState().upsertArtifact(makeArtifact('a1'));
    useAppStore.getState().setLastSyncAt(999); // implies it was pushed
    useAppStore.getState().clearArtifactDirty(['a1']);

    useAppStore.getState().deleteArtifact('a1');
    expect(useAppStore.getState().pendingArtifactDeletions).toContain('a1');
  });

  it('does NOT queue a tombstone for a dirty-and-never-synced artifact', () => {
    useAppStore.getState().upsertArtifact(makeArtifact('a1'));
    // lastSyncAt null AND still in dirtyArtifactIds from the upsert
    useAppStore.getState().deleteArtifact('a1');
    expect(useAppStore.getState().pendingArtifactDeletions).not.toContain('a1');
  });

  it('promotes the most-recent-remaining artifact when the active one is deleted', () => {
    useAppStore.getState().upsertArtifact(makeArtifact('old', { createdAt: 100 }));
    useAppStore.getState().upsertArtifact(makeArtifact('newer', { createdAt: 500 }));
    useAppStore.getState().upsertArtifact(makeArtifact('active', { createdAt: 200 }));
    useAppStore.getState().setActiveArtifact('active');

    useAppStore.getState().deleteArtifact('active');
    expect(useAppStore.getState().activeArtifactId).toBe('newer');
    expect(useAppStore.getState().artifactsOpen).toBe(true);
  });

  it('closes the panel when the last artifact is deleted', () => {
    useAppStore.getState().upsertArtifact(makeArtifact('a1'));
    useAppStore.getState().deleteArtifact('a1');
    const s = useAppStore.getState();
    expect(s.artifactsOpen).toBe(false);
    expect(s.activeArtifactId).toBeNull();
  });
});

// =============================================================================
// applyPulledConversations — LWW + tombstone + conflict detection
// =============================================================================

describe('applyPulledConversations', () => {
  it('is a no-op on empty array', () => {
    const id = useAppStore.getState().newConversation();
    useAppStore.getState().applyPulledConversations([]);
    expect(useAppStore.getState().conversations.map((c) => c.id)).toEqual([id]);
  });

  it('adds a brand-new conv from the server', () => {
    useAppStore.getState().applyPulledConversations([
      {
        id: 'srv1',
        title: 'from server',
        mode: 'chat',
        pinned: false,
        starred: false,
        modelId: 'x',
        createdAt: 100,
        updatedAt: 200,
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'hi',
            createdAt: 150,
          },
        ],
      },
    ]);
    const conv = useAppStore.getState().conversations.find((c) => c.id === 'srv1')!;
    expect(conv.title).toBe('from server');
    expect(conv.messages.map((m) => m.content)).toEqual(['hi']);
  });

  it('keeps local when local.updatedAt > server.updatedAt (LWW)', () => {
    useAppStore.setState({
      conversations: [
        makeConversation('c1', { title: 'local', updatedAt: 1_000 }),
      ],
    });
    useAppStore.getState().applyPulledConversations([
      {
        id: 'c1',
        title: 'server',
        mode: 'chat',
        pinned: false,
        starred: false,
        createdAt: 100,
        updatedAt: 500, // older than local
        messages: [],
      },
    ]);
    const conv = useAppStore.getState().conversations.find((c) => c.id === 'c1')!;
    expect(conv.title).toBe('local');
  });

  it('drops a tombstoned conv and records a conflict if the local copy was dirty', () => {
    useAppStore.setState({
      conversations: [makeConversation('c1', { title: 'local dirty' })],
      dirtyConversationIds: ['c1'],
    });
    useAppStore.getState().applyPulledConversations([
      {
        id: 'c1',
        title: '',
        mode: 'chat',
        pinned: false,
        starred: false,
        createdAt: 100,
        updatedAt: 200,
        deletedAt: 300,
        messages: [],
      },
    ]);
    const s = useAppStore.getState();
    expect(s.conversations.find((c) => c.id === 'c1')).toBeUndefined();
    expect(s.conflictRecords).toHaveLength(1);
    expect(s.conflictRecords[0].localCopy.title).toBe('local dirty');
  });

  it('records a conflict when server overwrites a dirty local copy (non-tombstone)', () => {
    useAppStore.setState({
      conversations: [
        makeConversation('c1', { title: 'local', updatedAt: 100 }),
      ],
      dirtyConversationIds: ['c1'],
    });
    useAppStore.getState().applyPulledConversations([
      {
        id: 'c1',
        title: 'server wins',
        mode: 'chat',
        pinned: false,
        starred: false,
        createdAt: 50,
        updatedAt: 500, // newer than local
        messages: [],
      },
    ]);
    const s = useAppStore.getState();
    expect(s.conversations.find((c) => c.id === 'c1')!.title).toBe('server wins');
    expect(s.conflictRecords).toHaveLength(1);
    expect(s.conflictRecords[0].localCopy.title).toBe('local');
    expect(s.conflictRecords[0].serverUpdatedAt).toBe(500);
  });

  it('does NOT record a conflict when local was not dirty', () => {
    useAppStore.setState({
      conversations: [
        makeConversation('c1', { title: 'local', updatedAt: 100 }),
      ],
      dirtyConversationIds: [],
    });
    useAppStore.getState().applyPulledConversations([
      {
        id: 'c1',
        title: 'server',
        mode: 'chat',
        pinned: false,
        starred: false,
        createdAt: 50,
        updatedAt: 500,
        messages: [],
      },
    ]);
    expect(useAppStore.getState().conflictRecords).toEqual([]);
  });

  it('clears activeConversationId when the active conv is tombstoned by pull', () => {
    useAppStore.setState({
      conversations: [makeConversation('c1')],
      activeConversationId: 'c1',
    });
    useAppStore.getState().applyPulledConversations([
      {
        id: 'c1',
        title: '',
        mode: 'chat',
        pinned: false,
        starred: false,
        createdAt: 0,
        updatedAt: 100,
        deletedAt: 200,
        messages: [],
      },
    ]);
    expect(useAppStore.getState().activeConversationId).toBeNull();
  });

  it('drops dirty + pendingDeletions marks for any pulled id', () => {
    useAppStore.setState({
      conversations: [makeConversation('c1', { updatedAt: 10 })],
      dirtyConversationIds: ['c1', 'c2'],
      pendingDeletions: ['c1', 'c3'],
    });
    useAppStore.getState().applyPulledConversations([
      {
        id: 'c1',
        title: 'srv',
        mode: 'chat',
        pinned: false,
        starred: false,
        createdAt: 0,
        updatedAt: 100,
        deletedAt: 200,
        messages: [],
      },
    ]);
    const s = useAppStore.getState();
    expect(s.dirtyConversationIds).toEqual(['c2']);
    expect(s.pendingDeletions).toEqual(['c3']);
  });
});

// =============================================================================
// applyPulledProjects — LWW + tombstone + conv cascade
// =============================================================================

describe('applyPulledProjects', () => {
  it('adds and LWW-merges server projects', () => {
    useAppStore.setState({
      projects: [makeProject('p1', { name: 'local', updatedAt: 500 })],
    });
    useAppStore.getState().applyPulledProjects([
      // local is newer → keep local
      { id: 'p1', name: 'server-older', createdAt: 0, updatedAt: 100 },
      // brand-new → add
      { id: 'p2', name: 'brand-new', createdAt: 10, updatedAt: 50 },
    ]);
    const projects = useAppStore.getState().projects;
    expect(projects.find((p) => p.id === 'p1')!.name).toBe('local');
    expect(projects.find((p) => p.id === 'p2')!.name).toBe('brand-new');
  });

  it('tombstones a project, cascades projectId=undefined on linked convs, marks convs dirty', () => {
    useAppStore.setState({
      projects: [makeProject('p1')],
      conversations: [
        makeConversation('c1', { projectId: 'p1' }),
        makeConversation('c2', { projectId: 'p1' }),
      ],
      activeProjectId: 'p1',
    });
    useAppStore.getState().applyPulledProjects([
      {
        id: 'p1',
        name: '',
        createdAt: 0,
        updatedAt: 100,
        deletedAt: 200,
      },
    ]);
    const s = useAppStore.getState();
    expect(s.projects).toEqual([]);
    expect(s.activeProjectId).toBeNull();
    expect(s.conversations.every((c) => c.projectId === undefined)).toBe(true);
    expect(s.dirtyConversationIds).toEqual(expect.arrayContaining(['c1', 'c2']));
  });

  it('falls back to [] for malformed sources (server corruption safety)', () => {
    useAppStore.getState().applyPulledProjects([
      {
        id: 'p1',
        name: 'n',
        // SyncProject.sources is typed `unknown`; pass a string to exercise
        // the Array.isArray guard for server-corruption safety.
        sources: 'not an array',
        createdAt: 0,
        updatedAt: 100,
      },
    ]);
    const p = useAppStore.getState().projects.find((x) => x.id === 'p1')!;
    expect(p.sources).toEqual([]);
  });
});

// =============================================================================
// applyPulledArtifacts — LWW + tombstone + type fallback
// =============================================================================

describe('applyPulledArtifacts', () => {
  it('LWW-merges and inserts, using updatedAt ?? createdAt on the local side', () => {
    useAppStore.setState({
      artifacts: {
        // No updatedAt — represents a pre-migration rehydrated row.
        a1: { ...makeArtifact('a1', { createdAt: 500 }), updatedAt: undefined },
      },
    });
    useAppStore.getState().applyPulledArtifacts([
      // Server older than local createdAt → keep local
      {
        id: 'a1',
        type: 'html',
        title: 'server',
        content: 'server',
        createdAt: 0,
        updatedAt: 400,
      },
      // Brand-new from server
      {
        id: 'a2',
        type: 'svg',
        title: 'server',
        content: '<svg/>',
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    const s = useAppStore.getState();
    expect(s.artifacts['a1'].title).not.toBe('server'); // local won
    expect(s.artifacts['a2'].type).toBe('svg');
  });

  it('falls back to type=code for unknown server types', () => {
    useAppStore.getState().applyPulledArtifacts([
      {
        id: 'a1',
        type: 'unknown-future-type',
        title: 't',
        content: 'x',
        createdAt: 0,
        updatedAt: 100,
      },
    ]);
    expect(useAppStore.getState().artifacts['a1'].type).toBe('code');
  });

  it('drops tombstoned artifacts and promotes a fallback active when the active one dies', () => {
    useAppStore.setState({
      artifacts: {
        a1: makeArtifact('a1', { createdAt: 100 }),
        a2: makeArtifact('a2', { createdAt: 500 }),
      },
      activeArtifactId: 'a1',
      artifactsOpen: true,
    });
    useAppStore.getState().applyPulledArtifacts([
      {
        id: 'a1',
        type: 'html',
        title: '',
        content: '',
        createdAt: 100,
        updatedAt: 200,
        deletedAt: 300,
      },
    ]);
    const s = useAppStore.getState();
    expect(s.artifacts['a1']).toBeUndefined();
    expect(s.activeArtifactId).toBe('a2');
    expect(s.artifactsOpen).toBe(true);
  });

  it('closes the panel when every artifact is tombstoned', () => {
    useAppStore.setState({
      artifacts: { a1: makeArtifact('a1') },
      activeArtifactId: 'a1',
      artifactsOpen: true,
    });
    useAppStore.getState().applyPulledArtifacts([
      {
        id: 'a1',
        type: 'html',
        title: '',
        content: '',
        createdAt: 0,
        updatedAt: 100,
        deletedAt: 200,
      },
    ]);
    const s = useAppStore.getState();
    expect(s.artifactsOpen).toBe(false);
    expect(s.activeArtifactId).toBeNull();
  });
});

// =============================================================================
// Dirty-queue bookkeeping
// =============================================================================

describe('dirty-queue bookkeeping', () => {
  it('markConversationDirty is idempotent', () => {
    useAppStore.getState().markConversationDirty('c1');
    useAppStore.getState().markConversationDirty('c1');
    expect(useAppStore.getState().dirtyConversationIds).toEqual(['c1']);
  });

  it('clearDirty removes only the specified ids', () => {
    useAppStore.setState({ dirtyConversationIds: ['a', 'b', 'c'] });
    useAppStore.getState().clearDirty(['b']);
    expect(useAppStore.getState().dirtyConversationIds).toEqual(['a', 'c']);
  });

  it('markAllArtifactsDirty captures every artifact id', () => {
    useAppStore.setState({
      artifacts: {
        a: makeArtifact('a'),
        b: makeArtifact('b'),
      },
    });
    useAppStore.getState().markAllArtifactsDirty();
    expect(useAppStore.getState().dirtyArtifactIds.sort()).toEqual(['a', 'b']);
  });
});

// =============================================================================
// Auth — clearAuth resets all sync state
// =============================================================================

describe('clearAuth', () => {
  it('resets every sync bookkeeping field so a new user starts clean', () => {
    useAppStore.getState().setAuth(fakeAuth);
    useAppStore.setState({
      lastSyncAt: 12345,
      dirtyConversationIds: ['c1'],
      pendingDeletions: ['c2'],
      dirtyProjectIds: ['p1'],
      pendingProjectDeletions: ['p2'],
      dirtyArtifactIds: ['a1'],
      pendingArtifactDeletions: ['a2'],
      syncState: 'pushing',
      syncError: 'boom',
      conflictRecords: [
        {
          conversationId: 'c9',
          localCopy: makeConversation('c9'),
          serverUpdatedAt: 100,
          detectedAt: Date.now(),
        },
      ],
    });

    useAppStore.getState().clearAuth();

    const s = useAppStore.getState();
    expect(s.auth).toBeNull();
    expect(s.lastSyncAt).toBeNull();
    expect(s.dirtyConversationIds).toEqual([]);
    expect(s.pendingDeletions).toEqual([]);
    expect(s.dirtyProjectIds).toEqual([]);
    expect(s.pendingProjectDeletions).toEqual([]);
    expect(s.dirtyArtifactIds).toEqual([]);
    expect(s.pendingArtifactDeletions).toEqual([]);
    expect(s.syncState).toBe('idle');
    expect(s.syncError).toBeNull();
    expect(s.conflictRecords).toEqual([]);
  });

  it('wipes the previous user content so the next user does not inherit it', () => {
    // Regression: logging out then logging in as a different user was
    // rendering the previous account's conversations because clearAuth
    // only touched sync state, not the cached content. localStorage
    // persistence made it survive across the account switch.
    useAppStore.getState().setAuth(fakeAuth);
    useAppStore.setState({
      conversations: [makeConversation('c1', { title: 'user-a private' })],
      activeConversationId: 'c1',
      projects: [makeProject('p1', { name: 'user-a proj' })],
      activeProjectId: 'p1',
      artifacts: {
        a1: {
          id: 'a1',
          type: 'html',
          title: 'secret',
          content: '<p/>',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as Artifact,
      },
      activeArtifactId: 'a1',
      globalMemory: 'remember alice lives at 221B',
      mcpServers: [
        {
          id: 'm1',
          name: 'private',
          url: 'http://x',
          enabled: true,
          status: 'disconnected',
        },
      ],
      disabledToolNames: ['web_fetch'],
      conversationTodos: { c1: [{ content: 'x', activeForm: 'X', status: 'pending' }] },
    });

    useAppStore.getState().clearAuth();

    const s = useAppStore.getState();
    expect(s.conversations).toEqual([]);
    expect(s.activeConversationId).toBeNull();
    expect(s.projects).toEqual([]);
    expect(s.activeProjectId).toBeNull();
    expect(s.artifacts).toEqual({});
    expect(s.activeArtifactId).toBeNull();
    expect(s.globalMemory).toBe('');
    expect(s.mcpServers).toEqual([]);
    expect(s.disabledToolNames).toEqual([]);
    expect(s.conversationTodos).toEqual({});
    // Skills + slash commands reset to the built-in seed (user-authored
    // ones are gone; built-ins stay because they ship with the client).
    expect(s.skills.every((sk) => sk.builtin === true)).toBe(true);
    expect(s.slashCommands.every((sc) => sc.builtin === true)).toBe(true);
  });

  it('preserves machine-local preferences that are not tied to user identity', () => {
    // Counterpart to the wipe test: theme / layout / per-device permissions
    // stay so a user logging back in on the same machine keeps their setup
    // and does not have to re-grant shell/file-write permissions.
    useAppStore.getState().setAuth(fakeAuth);
    useAppStore.setState({
      theme: 'dark',
      sidebarOpen: false,
      artifactsPanelWidth: 600,
      activeMode: 'code',
      modelByMode: { chat: 'x', code: 'y', design: 'z' },
      workspacePath: 'C:/ws',
      allowFileWrites: true,
      allowShellExec: true,
    });

    useAppStore.getState().clearAuth();

    const s = useAppStore.getState();
    expect(s.theme).toBe('dark');
    expect(s.sidebarOpen).toBe(false);
    expect(s.artifactsPanelWidth).toBe(600);
    expect(s.activeMode).toBe('code');
    expect(s.modelByMode).toEqual({ chat: 'x', code: 'y', design: 'z' });
    expect(s.workspacePath).toBe('C:/ws');
    expect(s.allowFileWrites).toBe(true);
    expect(s.allowShellExec).toBe(true);
  });
});

// =============================================================================
// Conflict resolution
// =============================================================================

describe('restoreConflict / dismissConflict', () => {
  it('dismissConflict removes the record without touching the conv', () => {
    useAppStore.setState({
      conversations: [makeConversation('c1', { title: 'server' })],
      conflictRecords: [
        {
          conversationId: 'c1',
          localCopy: makeConversation('c1', { title: 'local-stashed' }),
          serverUpdatedAt: 100,
          detectedAt: Date.now(),
        },
      ],
    });
    useAppStore.getState().dismissConflict('c1');
    const s = useAppStore.getState();
    expect(s.conflictRecords).toEqual([]);
    expect(s.conversations[0].title).toBe('server');
  });

  it('restoreConflict swaps in the stashed local copy, bumps updatedAt, marks dirty, clears tombstone', () => {
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    useAppStore.setState({
      conversations: [makeConversation('c1', { title: 'server' })],
      pendingDeletions: ['c1'],
      conflictRecords: [
        {
          conversationId: 'c1',
          localCopy: makeConversation('c1', { title: 'local-stashed', updatedAt: 1 }),
          serverUpdatedAt: 100,
          detectedAt: Date.now(),
        },
      ],
    });
    useAppStore.getState().restoreConflict('c1');
    const s = useAppStore.getState();
    expect(s.conversations[0].title).toBe('local-stashed');
    expect(s.conversations[0].updatedAt).toBe(Date.now());
    expect(s.pendingDeletions).toEqual([]);
    expect(s.dirtyConversationIds).toContain('c1');
    expect(s.conflictRecords).toEqual([]);
  });

  it('restoreConflict resurrects the conv when it was dropped by a tombstone pull', () => {
    useAppStore.setState({
      conversations: [],
      conflictRecords: [
        {
          conversationId: 'c1',
          localCopy: makeConversation('c1', { title: 'brought-back' }),
          serverUpdatedAt: 100,
          detectedAt: Date.now(),
        },
      ],
    });
    useAppStore.getState().restoreConflict('c1');
    const s = useAppStore.getState();
    expect(s.conversations).toHaveLength(1);
    expect(s.conversations[0].title).toBe('brought-back');
  });
});
