/**
 * Full-account export — "backup my whole Flaude, download one file."
 *
 * We reuse the sync wire types (SyncConversation / SyncProject / SyncArtifact)
 * so the bundle a user downloads is byte-for-byte the same shape the server
 * hands back from /sync/pull. A future import path can feed this bundle
 * straight into `applyPulledConversations` / `applyPulledProjects` /
 * `applyPulledArtifacts` with zero schema translation — and, because those
 * apply-pulled helpers already do LWW + tombstone, importing over an existing
 * account won't clobber newer live data.
 *
 * What's in the bundle:
 *   - conversations (full content, messages, reasoning, tool calls in metadata)
 *   - projects (name, instructions, sources)
 *   - artifacts (all, keyed by id)
 *   - skills (user-authored + built-ins — backwards-compat side-effect: if
 *     built-ins evolve, a restore still has a record of the skill as it was)
 *   - slashCommands (user-authored; built-ins re-register at load time)
 *   - settings (theme, modelByMode, globalMemory, providers, MCP servers,
 *     disabled tool names). NB: providers carry no API keys in Phase 4+
 *     (keys are server-side), so the bundle doesn't leak secrets unless the
 *     user has manually re-added custom providers with keys.
 *
 * What's deliberately NOT in the bundle:
 *   - Per-device: workspacePath, allowFileWrites, allowShellExec — a new
 *     machine has its own workspace; re-granting permissions is safer than
 *     silently inheriting them.
 *   - Session/transient: auth, sync cursor, dirty sets, tombstone queues,
 *     pendingWrites, conversationTodos, conflictRecords — none of these are meaningful
 *     after a restore onto a different client.
 *   - UI scratch: activeConversationId, activeProjectId, activeArtifactId —
 *     same argument; the user re-selects whatever they want to open.
 *
 * Schema versioning: the bundle carries `schemaVersion: 1`. Future breaking
 * changes bump the integer; the (yet-unwritten) import path can refuse
 * unknown versions rather than silently misapply data.
 */

import type {
  SyncArtifact,
  SyncConversation,
  SyncProject,
} from '@/lib/flaudeApi';
import {
  toWireArtifact,
  toWireConversation,
  toWireProject,
} from '@/lib/sync';
import { useAppStore } from '@/store/useAppStore';
import { downloadTextFile } from '@/lib/tauri';
import type { MCPServer, Skill, SlashCommand, WorkMode } from '@/types';

/** Bump when the bundle shape changes in a way older importers can't read. */
export const BUNDLE_SCHEMA_VERSION = 1;

/**
 * Subset of AppState we consider "settings" — user preferences + integrations
 * that should follow the user to a new machine. See the module docstring for
 * what's deliberately excluded (per-device permissions, transient state).
 *
 * We use a permissive `Pick` / index type rather than a separate interface so
 * the bundle keeps whatever shape the store uses, without a parallel schema
 * to keep in sync.
 */
export interface BundledSettings {
  theme: 'light' | 'dark' | 'system';
  activeMode: WorkMode;
  modelByMode: Record<WorkMode, string>;
  sidebarOpen: boolean;
  artifactsPanelWidth: number;
  globalMemory: string;
  /**
   * Provider configs. In Phase 4+ these are read-only mirrors of server
   * catalogs and carry no apiKey (per-user keys were removed). We still
   * round-trip the array so a user on a quirky self-hosted setup with local
   * custom providers keeps them after a restore.
   */
  providers: unknown[];
  /** MCP server list, including any bearer tokens the user saved. */
  mcpServers: MCPServer[];
  /** User-added slash commands (built-ins re-register at module load). */
  slashCommands: SlashCommand[];
  /** Names of tools the user has explicitly turned off. */
  disabledToolNames: string[];
}

export interface AccountBundle {
  /** Literal "flaude-account-backup" — lets an importer sanity-check the file. */
  kind: 'flaude-account-backup';
  schemaVersion: number;
  /** Unix ms of when the bundle was produced. */
  exportedAt: number;
  /** Identity of the account that produced the bundle, for the future importer to display. */
  exportedBy: { email: string; displayName: string } | null;
  /** App version string that generated the bundle. Human-readable only. */
  flaudeVersion: string;
  conversations: SyncConversation[];
  projects: SyncProject[];
  artifacts: SyncArtifact[];
  /**
   * Full skills list, built-in and user-authored. We don't filter by
   * `builtin` here: importers that already have the built-in set registered
   * can choose to keep theirs and only merge user-authored ones, but the
   * export itself captures the complete picture at the moment it was made.
   */
  skills: Skill[];
  settings: BundledSettings;
}

/**
 * Produce a bundle from the *current* store state. Pure — no side effects,
 * no I/O — so callers can pipe it through JSON.stringify to stream, compare
 * two bundles in tests, or hash it for an integrity footer later.
 *
 * Reads the store once; callers that want a guaranteed-stable snapshot under
 * concurrent edits should grab `useAppStore.getState()` themselves and pass
 * the relevant slices in — but in practice this runs from a button click,
 * which is single-threaded enough for "read once" to be indistinguishable.
 *
 * Passing a `flaudeVersion` is optional because the Vite env var isn't
 * available in the node test runner. When omitted we fall back to 'unknown'.
 */
export function buildAccountBundle(args?: {
  flaudeVersion?: string;
  /** Override `now()` for deterministic tests. */
  now?: number;
}): AccountBundle {
  const s = useAppStore.getState();
  const now = args?.now ?? Date.now();

  const conversations = s.conversations.map(toWireConversation);
  const projects = s.projects.map(toWireProject);
  const artifacts = Object.values(s.artifacts).map(toWireArtifact);

  const exportedBy = s.auth
    ? { email: s.auth.user.email, displayName: s.auth.user.display_name }
    : null;

  const settings: BundledSettings = {
    theme: s.theme,
    activeMode: s.activeMode,
    modelByMode: s.modelByMode,
    sidebarOpen: s.sidebarOpen,
    artifactsPanelWidth: s.artifactsPanelWidth,
    globalMemory: s.globalMemory,
    providers: s.providers,
    mcpServers: s.mcpServers,
    slashCommands: s.slashCommands,
    disabledToolNames: s.disabledToolNames,
  };

  return {
    kind: 'flaude-account-backup',
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    exportedAt: now,
    exportedBy,
    flaudeVersion: args?.flaudeVersion ?? 'unknown',
    conversations,
    projects,
    artifacts,
    skills: s.skills,
    settings,
  };
}

/**
 * Build a filename for the bundle. ISO-ish with hyphens + a compact HHMM
 * suffix — readable without being shell-hostile, and unique within the same
 * minute is usually enough (a user running two exports in one minute
 * probably wants overwrite anyway).
 */
export function bundleFilename(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `flaude-backup-${date}-${time}.json`;
}

/**
 * Full end-to-end: read store, build bundle, pretty-print, download. Returns
 * the saved path (Tauri) / filename (browser), or null if the user cancels
 * the save dialog.
 *
 * Pretty-printed with 2-space indent — the bundle is ~50 KB for a typical
 * user, so the readability win outweighs a few KB of gzip. A power user
 * who wants it minified can run `jq -c . flaude-backup-*.json`.
 */
export async function exportAccountBundle(args?: {
  flaudeVersion?: string;
}): Promise<string | null> {
  const bundle = buildAccountBundle({ flaudeVersion: args?.flaudeVersion });
  const json = JSON.stringify(bundle, null, 2);
  const filename = bundleFilename(bundle.exportedAt);
  return downloadTextFile(filename, json, 'application/json;charset=utf-8');
}

/**
 * Summary the UI shows in a "review before export" moment. Cheap to
 * compute, safe to call in render.
 */
export interface BundleCounts {
  conversations: number;
  messages: number;
  projects: number;
  artifacts: number;
  skills: number;
  slashCommands: number;
  mcpServers: number;
}

export function countBundleContents(): BundleCounts {
  const s = useAppStore.getState();
  return {
    conversations: s.conversations.length,
    messages: s.conversations.reduce((acc, c) => acc + c.messages.length, 0),
    projects: s.projects.length,
    artifacts: Object.keys(s.artifacts).length,
    skills: s.skills.length,
    slashCommands: s.slashCommands.length,
    mcpServers: s.mcpServers.length,
  };
}
