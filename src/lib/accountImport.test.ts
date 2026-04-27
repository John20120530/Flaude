import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import {
  buildAccountBundle,
  BUNDLE_SCHEMA_VERSION,
  type AccountBundle,
} from './accountExport';
import {
  applyImportBundle,
  describeImportError,
  parseImportBundle,
  previewImportBundle,
} from './accountImport';
import type { Conversation, Skill } from '@/types';

const initialState = useAppStore.getState();

beforeEach(() => {
  // Reset store to a clean baseline before every test. We touch only the
  // fields the import code reads/writes; auth + persistence stay alone.
  useAppStore.setState({
    ...initialState,
    conversations: [],
    projects: [],
    artifacts: {},
    skills: [],
    slashCommands: [],
    mcpServers: [],
    globalMemory: '',
    auth: null,
  });
});

afterEach(() => {
  useAppStore.setState(initialState);
});

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: over.id ?? 'c1',
  title: over.title ?? '会话',
  mode: over.mode ?? 'chat',
  modelId: over.modelId ?? 'deepseek-v4-pro',
  messages: over.messages ?? [],
  createdAt: over.createdAt ?? 100,
  updatedAt: over.updatedAt ?? 100,
});

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: over.id ?? 'sk1',
  name: over.name ?? 'a',
  title: over.title ?? 'A',
  description: over.description ?? 'd',
  instructions: over.instructions ?? '...',
  modes: over.modes ?? [],
  enabled: over.enabled ?? true,
  builtin: over.builtin,
  createdAt: over.createdAt ?? 100,
  updatedAt: over.updatedAt ?? 100,
});

// ---------------------------------------------------------------------------
// parseImportBundle
// ---------------------------------------------------------------------------

describe('parseImportBundle', () => {
  it('round-trips a bundle produced by buildAccountBundle()', () => {
    useAppStore.setState({ conversations: [conv()] });
    const bundle = buildAccountBundle({ flaudeVersion: '0.1.99' });
    const json = JSON.stringify(bundle);
    const result = parseImportBundle(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bundle.kind).toBe('flaude-account-backup');
      expect(result.bundle.flaudeVersion).toBe('0.1.99');
    }
  });

  it('rejects malformed JSON with an invalid_json error', () => {
    const r = parseImportBundle('not-json{');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_json');
  });

  it('rejects null / non-object root with corrupt', () => {
    expect(parseImportBundle('null').ok).toBe(false);
    expect(parseImportBundle('"a string"').ok).toBe(false);
    expect(parseImportBundle('42').ok).toBe(false);
  });

  it('rejects wrong kind (not a flaude-account-backup)', () => {
    const r = parseImportBundle(
      JSON.stringify({ kind: 'something-else', schemaVersion: 1 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('wrong_kind');
  });

  it('rejects schemaVersion newer than supported', () => {
    const r = parseImportBundle(
      JSON.stringify({
        kind: 'flaude-account-backup',
        schemaVersion: BUNDLE_SCHEMA_VERSION + 1,
        conversations: [],
        projects: [],
        artifacts: [],
        skills: [],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('schema_too_new');
  });

  it('rejects schemaVersion < 1 as too old / invalid', () => {
    const r = parseImportBundle(
      JSON.stringify({
        kind: 'flaude-account-backup',
        schemaVersion: 0,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('schema_too_old');
  });

  it('rejects when array fields are missing or wrong type', () => {
    for (const [missing, body] of [
      ['conversations', { kind: 'flaude-account-backup', schemaVersion: 1, projects: [], artifacts: [], skills: [] }],
      ['projects', { kind: 'flaude-account-backup', schemaVersion: 1, conversations: [], artifacts: [], skills: [] }],
      ['artifacts', { kind: 'flaude-account-backup', schemaVersion: 1, conversations: [], projects: [], skills: [] }],
      ['skills', { kind: 'flaude-account-backup', schemaVersion: 1, conversations: [], projects: [], artifacts: [] }],
    ] as const) {
      const r = parseImportBundle(JSON.stringify(body));
      expect(r.ok, `missing=${missing}`).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('corrupt');
    }
  });
});

describe('describeImportError', () => {
  it('produces a non-empty Chinese message for every error kind', () => {
    expect(describeImportError({ kind: 'invalid_json', message: 'x' })).toMatch(/JSON/);
    expect(describeImportError({ kind: 'wrong_kind', received: 'x' })).toMatch(/Flaude 备份/);
    expect(describeImportError({ kind: 'schema_too_new', received: 99, supported: 1 })).toMatch(/版本/);
    expect(describeImportError({ kind: 'schema_too_old', received: 0, supported: 1 })).toMatch(/旧/);
    expect(describeImportError({ kind: 'corrupt', message: 'x' })).toMatch(/损坏/);
  });
});

// ---------------------------------------------------------------------------
// previewImportBundle
// ---------------------------------------------------------------------------

describe('previewImportBundle', () => {
  it('counts new vs. updated vs. localKept correctly for conversations', () => {
    useAppStore.setState({
      conversations: [
        conv({ id: 'a', updatedAt: 200 }),
        conv({ id: 'b', updatedAt: 200 }),
        // 'c' missing locally
      ],
    });
    const bundle = baseBundle({
      conversations: [
        toWireConv({ id: 'a', updatedAt: 100 }),  // local newer → localKept
        toWireConv({ id: 'b', updatedAt: 300 }),  // bundle newer → updated
        toWireConv({ id: 'c', updatedAt: 100 }),  // not local → added
      ],
    });
    const p = previewImportBundle(bundle);
    expect(p.conversations).toEqual({
      added: 1,
      updated: 1,
      localKept: 1,
      tombstoned: 0,
    });
  });

  it('counts tombstones only when the local copy exists', () => {
    useAppStore.setState({
      conversations: [conv({ id: 'a', updatedAt: 100 })],
    });
    const bundle = baseBundle({
      conversations: [
        toWireConv({ id: 'a', updatedAt: 200, deletedAt: 200 }),  // local exists → tombstoned
        toWireConv({ id: 'gone', updatedAt: 200, deletedAt: 200 }), // not local → silent
      ],
    });
    const p = previewImportBundle(bundle);
    expect(p.conversations.tombstoned).toBe(1);
    expect(p.conversations.added).toBe(0);
  });

  it('skips builtin skills (treated as kept-local since builtins re-register)', () => {
    useAppStore.setState({ skills: [skill({ id: 'user1', updatedAt: 100 })] });
    const bundle = baseBundle({
      skills: [
        skill({ id: 'b', builtin: true, updatedAt: 999 }),
        skill({ id: 'user1', updatedAt: 50 }),  // older local-kept
        skill({ id: 'user2', updatedAt: 200 }), // new added
      ],
    });
    const p = previewImportBundle(bundle);
    expect(p.skills.added).toBe(1);
    expect(p.skills.localKept).toBeGreaterThanOrEqual(1); // user1 + builtin
  });

  it('detects cross-account by exportedBy.email vs. current auth', () => {
    useAppStore.setState({
      auth: {
        token: 't',
        user: { id: 1, email: 'me@example.com', display_name: 'me', role: 'user' },
        loggedInAt: 0,
      },
    });
    const bundle = baseBundle({
      exportedBy: { email: 'someone-else@example.com', displayName: 'Other' },
    });
    const p = previewImportBundle(bundle);
    expect(p.isOtherAccount).toBe(true);
  });

  it('does not flag cross-account when emails match (case-insensitive)', () => {
    useAppStore.setState({
      auth: {
        token: 't',
        user: { id: 1, email: 'me@example.com', display_name: 'me', role: 'user' },
        loggedInAt: 0,
      },
    });
    const bundle = baseBundle({
      exportedBy: { email: 'ME@EXAMPLE.COM', displayName: 'me' },
    });
    const p = previewImportBundle(bundle);
    expect(p.isOtherAccount).toBe(false);
  });

  it('does not flag cross-account when there is no current auth (e.g. local-only build)', () => {
    useAppStore.setState({ auth: null });
    const bundle = baseBundle({
      exportedBy: { email: 'someone@example.com', displayName: 'x' },
    });
    const p = previewImportBundle(bundle);
    expect(p.isOtherAccount).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyImportBundle
// ---------------------------------------------------------------------------

describe('applyImportBundle', () => {
  it('imports new conversations + projects + artifacts via applyPulled* (LWW)', () => {
    useAppStore.setState({ conversations: [], projects: [], artifacts: {} });
    const bundle = baseBundle({
      conversations: [toWireConv({ id: 'c-new', updatedAt: 500 })],
      projects: [
        { id: 'p-new', name: 'P', createdAt: 100, updatedAt: 500, sources: [] },
      ],
      artifacts: [
        {
          id: 'a-new',
          messageId: 'm1',
          type: 'html',
          title: 't',
          content: 'x',
          createdAt: 100,
          updatedAt: 500,
        },
      ],
    });
    applyImportBundle(bundle);
    const s = useAppStore.getState();
    expect(s.conversations.find((c) => c.id === 'c-new')).toBeDefined();
    expect(s.projects.find((p) => p.id === 'p-new')).toBeDefined();
    expect(s.artifacts['a-new']).toBeDefined();
  });

  it('keeps the local copy when local.updatedAt > bundle.updatedAt (LWW)', () => {
    useAppStore.setState({
      conversations: [conv({ id: 'c1', title: 'local-newer', updatedAt: 999 })],
    });
    const bundle = baseBundle({
      conversations: [toWireConv({ id: 'c1', title: 'bundle-old', updatedAt: 100 })],
    });
    applyImportBundle(bundle);
    const after = useAppStore.getState().conversations.find((c) => c.id === 'c1');
    expect(after?.title).toBe('local-newer');
  });

  it('skips builtin skills, adds user-authored ones, LWWs duplicates', () => {
    useAppStore.setState({
      skills: [
        skill({ id: 'existing', updatedAt: 100, instructions: 'old' }),
        skill({ id: 'untouched', updatedAt: 500, instructions: 'local' }),
      ],
    });
    const bundle = baseBundle({
      skills: [
        skill({ id: 'b', builtin: true, instructions: 'should-skip' }),
        skill({ id: 'existing', updatedAt: 200, instructions: 'newer' }), // updated
        skill({ id: 'fresh', updatedAt: 100, instructions: 'new-skill' }), // added
      ],
    });
    applyImportBundle(bundle);
    const after = useAppStore.getState().skills;
    expect(after.find((sk) => sk.id === 'existing')?.instructions).toBe('newer');
    expect(after.find((sk) => sk.id === 'fresh')).toBeDefined();
    expect(after.find((sk) => sk.id === 'untouched')?.instructions).toBe('local');
    // Builtin from bundle never lands.
    expect(after.find((sk) => sk.id === 'b')).toBeUndefined();
  });

  it('does NOT touch settings by default (importSettings off)', () => {
    useAppStore.setState({
      globalMemory: 'local memory',
      theme: 'light',
    });
    const bundle = baseBundle({
      settings: {
        theme: 'dark',
        activeMode: 'chat',
        modelByMode: { chat: 'x', code: 'y', design: 'z' },
        sidebarOpen: true,
        artifactsPanelWidth: 600,
        globalMemory: 'bundle memory',
        providers: [],
        mcpServers: [],
        slashCommands: [],
        disabledToolNames: [],
      },
    });
    applyImportBundle(bundle); // no importSettings
    const after = useAppStore.getState();
    expect(after.globalMemory).toBe('local memory');
    expect(after.theme).toBe('light');
  });

  it('imports settings when importSettings=true', () => {
    useAppStore.setState({
      globalMemory: 'local',
      theme: 'light',
    });
    const bundle = baseBundle({
      settings: {
        theme: 'dark',
        activeMode: 'code',
        modelByMode: { chat: 'x', code: 'y', design: 'z' },
        sidebarOpen: false,
        artifactsPanelWidth: 700,
        globalMemory: 'bundle memory',
        providers: [],
        mcpServers: [
          {
            id: 'm1',
            name: 'Test',
            url: 'http://x',
            enabled: true,
            status: 'disconnected',
          },
        ],
        slashCommands: [],
        disabledToolNames: ['some_tool'],
      },
    });
    applyImportBundle(bundle, { importSettings: true });
    const after = useAppStore.getState();
    expect(after.globalMemory).toBe('bundle memory');
    expect(after.theme).toBe('dark');
    expect(after.mcpServers).toHaveLength(1);
    expect(after.disabledToolNames).toContain('some_tool');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BundleOverrides {
  conversations?: AccountBundle['conversations'];
  projects?: AccountBundle['projects'];
  artifacts?: AccountBundle['artifacts'];
  skills?: AccountBundle['skills'];
  exportedBy?: AccountBundle['exportedBy'];
  settings?: AccountBundle['settings'];
}

function baseBundle(over: BundleOverrides = {}): AccountBundle {
  return {
    kind: 'flaude-account-backup',
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    exportedAt: 0,
    exportedBy: over.exportedBy ?? null,
    flaudeVersion: 'test',
    conversations: over.conversations ?? [],
    projects: over.projects ?? [],
    artifacts: over.artifacts ?? [],
    skills: over.skills ?? [],
    settings: over.settings ?? {
      theme: 'light',
      activeMode: 'chat',
      modelByMode: { chat: '', code: '', design: '' },
      sidebarOpen: true,
      artifactsPanelWidth: 480,
      globalMemory: '',
      providers: [],
      mcpServers: [],
      slashCommands: [],
      disabledToolNames: [],
    },
  };
}

interface WireConvOverrides {
  id?: string;
  title?: string;
  updatedAt?: number;
  deletedAt?: number;
}

function toWireConv(o: WireConvOverrides) {
  return {
    id: o.id ?? 'c',
    title: o.title ?? '',
    mode: 'chat' as const,
    pinned: false,
    starred: false,
    modelId: 'm',
    messages: [],
    createdAt: 0,
    updatedAt: o.updatedAt ?? 0,
    ...(o.deletedAt !== undefined ? { deletedAt: o.deletedAt } : {}),
  };
}
