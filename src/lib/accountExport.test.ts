/**
 * Tests for the full-account export bundle builder.
 *
 * Scope:
 *   - shape / schema-version guard so future importers can trust the envelope
 *   - the pure `buildAccountBundle` mapping (store slices → wire shapes)
 *   - what's excluded (per-device knobs, transient state) — important because
 *     it's the part future-me will silently break when adding new store fields
 *   - filename generator (timezone-independent via fake timers)
 *   - countBundleContents matches the bundle it describes
 *
 * We don't exercise the download step — `downloadTextFile` is already tested
 * via its own path (and in node the Blob/DOM path no-ops by design).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore, type AuthUser } from '@/store/useAppStore';
import type { Conversation, Message, Project, Skill } from '@/types';
import type { Artifact } from '@/lib/artifacts';
import {
  BUNDLE_SCHEMA_VERSION,
  buildAccountBundle,
  bundleFilename,
  countBundleContents,
} from './accountExport';

const INITIAL_STATE = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(INITIAL_STATE, true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-20T09:05:30.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- fixtures ---------------------------------------------------------------

function msg(id: string, role: Message['role'] = 'user', content = 'hi'): Message {
  return { id, role, content, createdAt: Date.now() };
}

function conv(id: string, overrides: Partial<Conversation> = {}): Conversation {
  const now = Date.now();
  return {
    id,
    title: 'c',
    mode: 'chat',
    modelId: 'm',
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function proj(id: string, overrides: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    id,
    name: 'p',
    sources: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function art(id: string, overrides: Partial<Artifact> = {}): Artifact {
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

function skill(id: string, overrides: Partial<Skill> = {}): Skill {
  const now = Date.now();
  return {
    id,
    name: 'sk',
    title: 'Sk',
    description: 'd',
    instructions: 'body',
    modes: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const fakeAuth = {
  token: 'tok',
  user: { id: 1, email: 'a@b', display_name: 'A', role: 'user' } as AuthUser,
};

// ---- envelope / schema ------------------------------------------------------

describe('buildAccountBundle envelope', () => {
  it('stamps kind / schemaVersion / exportedAt / flaudeVersion', () => {
    const b = buildAccountBundle({ flaudeVersion: '9.9.9' });
    expect(b.kind).toBe('flaude-account-backup');
    expect(b.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(b.exportedAt).toBe(Date.now());
    expect(b.flaudeVersion).toBe('9.9.9');
  });

  it('defaults flaudeVersion to "unknown" when not supplied (keeps node tests deterministic)', () => {
    const b = buildAccountBundle();
    expect(b.flaudeVersion).toBe('unknown');
  });

  it('exportedBy picks up the signed-in user, null when logged out', () => {
    expect(buildAccountBundle().exportedBy).toBeNull();
    useAppStore.setState({ auth: { ...fakeAuth, loggedInAt: Date.now() } });
    const b = buildAccountBundle();
    expect(b.exportedBy).toEqual({ email: 'a@b', displayName: 'A' });
  });
});

// ---- content coverage -------------------------------------------------------

describe('buildAccountBundle content', () => {
  it('serialises conversations via the wire converter (incl. messages)', () => {
    useAppStore.setState({
      conversations: [
        conv('c1', { title: 'first', messages: [msg('m1'), msg('m2', 'assistant', 'ok')] }),
        conv('c2', { title: 'empty' }),
      ],
    });
    const b = buildAccountBundle();
    expect(b.conversations).toHaveLength(2);
    expect(b.conversations[0].id).toBe('c1');
    expect(b.conversations[0].title).toBe('first');
    expect(b.conversations[0].messages).toHaveLength(2);
    expect(b.conversations[0].messages[1].role).toBe('assistant');
    // The wire shape uses `deletedAt: null` for live rows — round-trippable
    // through applyPulledConversations without special-casing.
    expect(b.conversations[0].deletedAt).toBeNull();
  });

  it('serialises projects + artifacts', () => {
    useAppStore.setState({
      projects: [proj('p1', { name: 'My proj', description: 'about' })],
      artifacts: {
        a1: art('a1', { title: 'Chart' }),
        a2: art('a2', { type: 'mermaid' }),
      },
    });
    const b = buildAccountBundle();
    expect(b.projects.map((p) => p.id)).toEqual(['p1']);
    expect(b.projects[0].description).toBe('about');
    expect(b.artifacts.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect(b.projects[0].deletedAt).toBeNull();
    expect(b.artifacts[0].deletedAt).toBeNull();
  });

  it('carries skills (user + builtin) verbatim', () => {
    useAppStore.setState({
      skills: [
        skill('user-1', { builtin: false, title: 'Mine' }),
        skill('builtin-1', { builtin: true, title: 'Built-in' }),
      ],
    });
    const b = buildAccountBundle();
    expect(b.skills).toHaveLength(2);
    expect(b.skills.map((s) => s.id).sort()).toEqual(['builtin-1', 'user-1']);
  });

  it('settings block carries theme / model map / memory / mcp / slash / disabled tools', () => {
    useAppStore.setState({
      theme: 'dark',
      activeMode: 'code',
      modelByMode: { chat: 'x', code: 'y' },
      sidebarOpen: false,
      artifactsPanelWidth: 600,
      globalMemory: 'remember stuff',
      mcpServers: [
        {
          id: 'mcp1',
          name: 'local',
          url: 'http://x',
          enabled: true,
          status: 'disconnected',
        },
      ],
      slashCommands: [
        { id: 'sc1', trigger: '/x', description: 'd', kind: 'template', template: '...' },
      ],
      disabledToolNames: ['web_fetch'],
    });
    const b = buildAccountBundle();
    expect(b.settings.theme).toBe('dark');
    expect(b.settings.activeMode).toBe('code');
    expect(b.settings.modelByMode).toEqual({ chat: 'x', code: 'y' });
    expect(b.settings.sidebarOpen).toBe(false);
    expect(b.settings.artifactsPanelWidth).toBe(600);
    expect(b.settings.globalMemory).toBe('remember stuff');
    expect(b.settings.mcpServers).toHaveLength(1);
    expect(b.settings.slashCommands).toHaveLength(1);
    expect(b.settings.disabledToolNames).toEqual(['web_fetch']);
  });

  it('deliberately excludes per-device knobs and transient state', () => {
    useAppStore.setState({
      workspacePath: 'C:/ws',
      allowFileWrites: true,
      allowShellExec: true,
      auth: { ...fakeAuth, loggedInAt: Date.now() },
      lastSyncAt: 12345,
      dirtyConversationIds: ['c1'],
      pendingDeletions: ['c2'],
      pendingWrites: [
        {
          id: 'pw1',
          path: 'f',
          oldContent: '',
          newContent: 'x',
          isNewFile: true,
          createDirs: false,
          submittedAt: Date.now(),
        },
      ],
      agentTodos: { c1: [{ content: 'x', activeForm: 'X', status: 'pending' }] },
      conflictRecords: [
        {
          conversationId: 'c1',
          localCopy: conv('c1'),
          serverUpdatedAt: 1,
          detectedAt: Date.now(),
        },
      ],
    });
    const b = buildAccountBundle();
    const keys = Object.keys(b);
    expect(keys).not.toContain('workspacePath');
    expect(keys).not.toContain('auth');
    expect(keys).not.toContain('lastSyncAt');
    expect(keys).not.toContain('dirtyConversationIds');
    expect(keys).not.toContain('pendingWrites');
    expect(keys).not.toContain('agentTodos');
    expect(keys).not.toContain('conflictRecords');
    // And the settings sub-block too — this is the more likely place for a
    // regression where someone adds a new per-device flag to partialize and
    // forgets to keep it out of the bundle.
    const settingsKeys = Object.keys(b.settings);
    for (const forbidden of [
      'workspacePath',
      'allowFileWrites',
      'allowShellExec',
      'auth',
    ]) {
      expect(settingsKeys).not.toContain(forbidden);
    }
  });

  it('round-trips through JSON without losing fidelity', () => {
    useAppStore.setState({
      conversations: [
        conv('c1', {
          messages: [msg('m1'), msg('m2', 'assistant', 'out')],
          pinned: true,
          summary: 'sum',
          summaryMessageCount: 1,
        }),
      ],
      projects: [proj('p1', { instructions: 'do X' })],
      artifacts: { a1: art('a1', { messageId: 'm2' }) },
    });
    const b1 = buildAccountBundle();
    const b2 = JSON.parse(JSON.stringify(b1));
    expect(b2).toEqual(b1);
  });
});

// ---- filename ---------------------------------------------------------------

describe('bundleFilename', () => {
  it('uses local-time YYYY-MM-DD-HHMM so a user sees "their" clock', () => {
    // Locale-independent assertion: just pattern-match the shape, not the
    // specific digits (those depend on the CI runner's timezone, which we
    // can't pin without polluting other tests).
    const name = bundleFilename(Date.now());
    expect(name).toMatch(/^flaude-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  });

  it('uses the provided timestamp, not the current clock', () => {
    const fixed = new Date('2000-01-02T03:04:00.000Z').getTime();
    const name = bundleFilename(fixed);
    expect(name).toMatch(/^flaude-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    // The fixed timestamp differs from Date.now() — so the name should too.
    expect(name).not.toBe(bundleFilename(Date.now()));
  });
});

// ---- counts -----------------------------------------------------------------

describe('countBundleContents', () => {
  it('matches the bundle the user is about to download', () => {
    useAppStore.setState({
      conversations: [
        conv('c1', { messages: [msg('m1'), msg('m2')] }),
        conv('c2', { messages: [msg('m3')] }),
      ],
      projects: [proj('p1'), proj('p2')],
      artifacts: { a1: art('a1') },
      skills: [skill('s1'), skill('s2'), skill('s3')],
      slashCommands: [
        { id: 'sc1', trigger: '/x', description: 'd', kind: 'action', action: 'clear' },
      ],
      mcpServers: [],
    });
    const counts = countBundleContents();
    const b = buildAccountBundle();
    expect(counts.conversations).toBe(b.conversations.length);
    expect(counts.messages).toBe(
      b.conversations.reduce((acc, c) => acc + c.messages.length, 0)
    );
    expect(counts.projects).toBe(b.projects.length);
    expect(counts.artifacts).toBe(b.artifacts.length);
    expect(counts.skills).toBe(b.skills.length);
    expect(counts.slashCommands).toBe(b.settings.slashCommands.length);
    expect(counts.mcpServers).toBe(b.settings.mcpServers.length);
  });
});
