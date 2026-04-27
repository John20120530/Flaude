/**
 * Reverse direction of accountExport — read a previously-exported bundle
 * and merge it into the current account.
 *
 * Three-step flow, kept separate so the UI can show a preview before
 * mutating anything:
 *
 *   1. parseImportBundle(raw) → validates JSON, kind, schemaVersion.
 *      Returns either the typed bundle or a discriminated error.
 *   2. previewImportBundle(bundle) → walks the bundle vs. current store
 *      and reports counts: "X added, Y updated (server wins LWW), Z kept
 *      local (local newer)". Pure read — does NOT mutate.
 *   3. applyImportBundle(bundle, options?) → fires the existing
 *      applyPulled* store actions, which already implement LWW + tombstone
 *      + conflict detection. Settings (theme/modelByMode/globalMemory/
 *      MCP/slash) are imported only when the caller opts in, on the
 *      principle that someone re-importing onto a fresh device usually
 *      wants the data, not necessarily the per-device preferences.
 *
 * Why reuse applyPulled* instead of writing fresh import logic:
 *   - LWW semantics, tombstone propagation, conflict-toast detection are
 *     already battle-tested in the sync path.
 *   - The bundle format IS the wire format (toWire* round-trips through
 *     the same converters), so feeding it to applyPulled* is type-safe.
 *   - Anything we'd hand-write here would drift from the sync path over
 *     time. Same code path = same correctness guarantees.
 *
 * Cross-account warning: the bundle carries `exportedBy.email`. If that
 * doesn't match the currently-logged-in user, the preview surfaces a
 * warning — importing someone else's bundle into your account is almost
 * always a mistake, but if a user really wants to (e.g. forensics, copy a
 * teammate's setup), we let them through after confirming.
 */
import { useAppStore } from '@/store/useAppStore';
import type { Hook, Skill, SlashCommand } from '@/types';
import {
  type AccountBundle,
  type BundledSettings,
  BUNDLE_SCHEMA_VERSION,
} from './accountExport';

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; bundle: AccountBundle }
  | { ok: false; error: ImportError };

export type ImportError =
  | { kind: 'invalid_json'; message: string }
  | { kind: 'wrong_kind'; received: unknown }
  | { kind: 'schema_too_new'; received: number; supported: number }
  | { kind: 'schema_too_old'; received: number; supported: number }
  | { kind: 'corrupt'; message: string };

/**
 * Parse a raw JSON string into a validated bundle. Returns a discriminated
 * union so the caller can render specific error UIs without needing to
 * stringify exceptions.
 *
 * Validation depth: shape-checks the top level + the array fields. Doesn't
 * deep-validate every conversation/project record — those go through
 * applyPulled* which is already defensive against unexpected shapes (it
 * defaults missing fields and skips non-objects).
 */
export function parseImportBundle(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: { kind: 'invalid_json', message: (e as Error).message },
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      error: { kind: 'corrupt', message: '根对象不是一个 JSON object' },
    };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.kind !== 'flaude-account-backup') {
    return { ok: false, error: { kind: 'wrong_kind', received: obj.kind } };
  }

  const sv = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : -1;
  if (sv > BUNDLE_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        kind: 'schema_too_new',
        received: sv,
        supported: BUNDLE_SCHEMA_VERSION,
      },
    };
  }
  if (sv < 1) {
    return {
      ok: false,
      error: {
        kind: 'schema_too_old',
        received: sv,
        supported: BUNDLE_SCHEMA_VERSION,
      },
    };
  }

  if (!Array.isArray(obj.conversations)) {
    return { ok: false, error: { kind: 'corrupt', message: 'conversations 不是数组' } };
  }
  if (!Array.isArray(obj.projects)) {
    return { ok: false, error: { kind: 'corrupt', message: 'projects 不是数组' } };
  }
  if (!Array.isArray(obj.artifacts)) {
    return { ok: false, error: { kind: 'corrupt', message: 'artifacts 不是数组' } };
  }
  if (!Array.isArray(obj.skills)) {
    return { ok: false, error: { kind: 'corrupt', message: 'skills 不是数组' } };
  }

  return { ok: true, bundle: obj as unknown as AccountBundle };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface ImportEntityCounts {
  /** Items only in the bundle (new to this device). */
  added: number;
  /** Items in both — bundle version newer (will overwrite local). */
  updated: number;
  /** Items in both — local version newer or equal (will skip). */
  localKept: number;
  /** Items the bundle marks as deleted; existed locally and will be removed. */
  tombstoned: number;
}

export interface ImportPreview {
  conversations: ImportEntityCounts;
  projects: ImportEntityCounts;
  artifacts: ImportEntityCounts;
  /** Skills are append-only by id; no LWW (Skill.updatedAt is internal-only). */
  skills: { added: number; updated: number; localKept: number };
  /** SlashCommands have no timestamps — added if id is new, otherwise skipped. */
  slashCommands: { added: number; skipped: number };
  exportedBy: { email: string; displayName: string } | null;
  exportedAt: number;
  flaudeVersion: string;
  /** True when bundle was exported by a different email than the current user. */
  isOtherAccount: boolean;
  /** The bundle itself, so the caller can pass it to applyImportBundle without re-parsing. */
  bundle: AccountBundle;
}

/** Compute counts for the preview UI. Read-only — does not mutate the store. */
export function previewImportBundle(bundle: AccountBundle): ImportPreview {
  const s = useAppStore.getState();

  const convs = countSyncEntities(
    bundle.conversations,
    new Map(s.conversations.map((c) => [c.id, c.updatedAt])),
  );
  const projs = countSyncEntities(
    bundle.projects,
    new Map(s.projects.map((p) => [p.id, p.updatedAt])),
  );
  const arts = countSyncEntities(
    bundle.artifacts,
    new Map(
      Object.values(s.artifacts).map((a) => [a.id, a.updatedAt ?? a.createdAt]),
    ),
  );

  const localSkillIds = new Map(s.skills.map((sk) => [sk.id, sk]));
  let skillAdded = 0;
  let skillUpdated = 0;
  let skillKept = 0;
  for (const sk of bundle.skills) {
    if (sk.builtin) {
      // Builtins re-register on every load — bundle copy is just a snapshot.
      // Treat as kept-local (we never replace builtins from bundles).
      skillKept++;
      continue;
    }
    const local = localSkillIds.get(sk.id);
    if (!local) {
      skillAdded++;
    } else if (sk.updatedAt > local.updatedAt) {
      skillUpdated++;
    } else {
      skillKept++;
    }
  }

  const localSlashIds = new Set(s.slashCommands.map((c) => c.id));
  let slashAdded = 0;
  let slashSkipped = 0;
  const incomingSlashes =
    (bundle.settings as BundledSettings | undefined)?.slashCommands ?? [];
  for (const cmd of incomingSlashes) {
    if (cmd.builtin) {
      slashSkipped++;
      continue;
    }
    if (localSlashIds.has(cmd.id)) {
      slashSkipped++;
    } else {
      slashAdded++;
    }
  }

  const isOtherAccount = !!(
    bundle.exportedBy &&
    s.auth &&
    bundle.exportedBy.email.toLowerCase() !== s.auth.user.email.toLowerCase()
  );

  return {
    conversations: convs,
    projects: projs,
    artifacts: arts,
    skills: { added: skillAdded, updated: skillUpdated, localKept: skillKept },
    slashCommands: { added: slashAdded, skipped: slashSkipped },
    exportedBy: bundle.exportedBy,
    exportedAt: bundle.exportedAt,
    flaudeVersion: bundle.flaudeVersion,
    isOtherAccount,
    bundle,
  };
}

/**
 * Generic helper for the three sync entities that all share a `{ id,
 * updatedAt, deletedAt? }` shape on the wire.
 */
function countSyncEntities(
  bundleEntities: Array<{ id: string; updatedAt: number; deletedAt?: number | null }>,
  localById: Map<string, number>,
): ImportEntityCounts {
  const counts: ImportEntityCounts = {
    added: 0,
    updated: 0,
    localKept: 0,
    tombstoned: 0,
  };
  for (const b of bundleEntities) {
    const localUpdatedAt = localById.get(b.id);
    if (b.deletedAt != null) {
      // Tombstone: applies if we have it locally, otherwise drops silently.
      if (localUpdatedAt !== undefined) counts.tombstoned++;
      continue;
    }
    if (localUpdatedAt === undefined) {
      counts.added++;
    } else if (b.updatedAt > localUpdatedAt) {
      counts.updated++;
    } else {
      counts.localKept++;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /**
   * Merge in the bundle's settings (theme, modelByMode, sidebarOpen,
   * artifactsPanelWidth, globalMemory, providers, MCP servers, slash
   * commands, disabledToolNames).
   *
   * Default false — most "restore on a new device" cases want the data
   * (conversations, projects, artifacts) but not the per-device
   * preferences. Toggle on for "I really want to mirror device A".
   */
  importSettings?: boolean;
}

/**
 * Apply the bundle to the current store. Conversations / projects /
 * artifacts go through applyPulled* which already does LWW. Skills and
 * slash commands are merged conservatively (add new, never overwrite).
 */
export function applyImportBundle(
  bundle: AccountBundle,
  options?: ImportOptions,
): void {
  const s = useAppStore.getState();

  s.applyPulledConversations(bundle.conversations);
  s.applyPulledProjects(bundle.projects);
  s.applyPulledArtifacts(bundle.artifacts);

  // Skills: add user-authored skills not already present, LWW on duplicates.
  // Builtins stay local (they re-register on every app load, so the bundle
  // snapshot is irrelevant).
  const newOrUpdated: Skill[] = [];
  const existingById = new Map(s.skills.map((sk) => [sk.id, sk]));
  for (const sk of bundle.skills) {
    if (sk.builtin) continue;
    const existing = existingById.get(sk.id);
    if (!existing || sk.updatedAt > existing.updatedAt) {
      newOrUpdated.push(sk);
    }
  }
  if (newOrUpdated.length > 0) {
    useAppStore.setState((cur) => {
      const map = new Map(cur.skills.map((sk) => [sk.id, sk]));
      for (const sk of newOrUpdated) map.set(sk.id, sk);
      return { ...cur, skills: [...map.values()] };
    });
  }

  // Hooks: same LWW pattern as skills. Bundle field is optional (older
  // bundles, pre-v0.1.28, don't have it) so default to [].
  const hooksFromBundle: Hook[] = Array.isArray(bundle.hooks) ? bundle.hooks : [];
  const hookExisting = new Map(s.hooks.map((h) => [h.id, h]));
  const hookNewOrUpdated: Hook[] = [];
  for (const h of hooksFromBundle) {
    const existing = hookExisting.get(h.id);
    if (!existing || h.updatedAt > existing.updatedAt) {
      hookNewOrUpdated.push(h);
    }
  }
  if (hookNewOrUpdated.length > 0) {
    useAppStore.setState((cur) => {
      const map = new Map(cur.hooks.map((h) => [h.id, h]));
      for (const h of hookNewOrUpdated) map.set(h.id, h);
      return { ...cur, hooks: [...map.values()] };
    });
  }

  if (options?.importSettings) {
    applySettings(bundle.settings);
  }
}

function applySettings(settings: BundledSettings | undefined): void {
  if (!settings || typeof settings !== 'object') return;
  useAppStore.setState((cur) => {
    // Preserve identity-side state (auth, persisted sync cursors, etc.) —
    // we only swap the user-pref slice.
    const merged = { ...cur };
    if (settings.theme) merged.theme = settings.theme;
    if (settings.activeMode) merged.activeMode = settings.activeMode;
    if (settings.modelByMode) merged.modelByMode = { ...settings.modelByMode };
    if (typeof settings.sidebarOpen === 'boolean') merged.sidebarOpen = settings.sidebarOpen;
    if (typeof settings.artifactsPanelWidth === 'number') {
      merged.artifactsPanelWidth = settings.artifactsPanelWidth;
    }
    if (typeof settings.globalMemory === 'string') merged.globalMemory = settings.globalMemory;
    if (Array.isArray(settings.mcpServers)) merged.mcpServers = settings.mcpServers;

    // Slash commands: union by id, keep local on collision (so the user's
    // custom version wins over an older bundle copy).
    if (Array.isArray(settings.slashCommands)) {
      const byId = new Map<string, SlashCommand>();
      for (const c of settings.slashCommands) byId.set(c.id, c);
      for (const c of cur.slashCommands) byId.set(c.id, c);
      merged.slashCommands = [...byId.values()];
    }
    if (Array.isArray(settings.disabledToolNames)) {
      merged.disabledToolNames = [...new Set(settings.disabledToolNames)];
    }
    return merged;
  });
}

// ---------------------------------------------------------------------------
// Human-readable error text (for the UI)
// ---------------------------------------------------------------------------

export function describeImportError(e: ImportError): string {
  switch (e.kind) {
    case 'invalid_json':
      return `这个文件不是有效的 JSON：${e.message}`;
    case 'wrong_kind':
      return `这不是一个 Flaude 备份文件（kind=${JSON.stringify(e.received)}）。导出文件的 kind 应该是 "flaude-account-backup"。`;
    case 'schema_too_new':
      return `备份文件的 schema 版本（${e.received}）比当前 Flaude 支持的（${e.supported}）新。请升级 Flaude 到能识别这个版本的版本，再尝试导入。`;
    case 'schema_too_old':
      return `备份文件的 schema 版本（${e.received}）太旧或无效。当前最低支持 1。`;
    case 'corrupt':
      return `备份文件结构损坏：${e.message}`;
  }
}
