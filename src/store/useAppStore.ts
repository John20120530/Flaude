import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Attachment,
  Conversation,
  Hook,
  MCPServer,
  Message,
  Project,
  ProviderConfig,
  Skill,
  SlashCommand,
  TodoItem,
  ToolCall,
  WorkMode,
} from '@/types';
import type { Artifact, ArtifactType } from '@/lib/artifacts';
import {
  DEFAULT_DESIGN_IMAGE_GEN_MODEL,
  DEFAULT_DESIGN_VISION_MODEL,
  DEFAULT_MODEL_BY_MODE,
  DEFAULT_PROVIDERS,
} from '@/config/providers';
import { BUILTIN_SLASH_COMMANDS } from '@/lib/slashCommands';
import { BUILTIN_SKILLS } from '@/lib/builtinSkills';
import {
  connectMCPServer,
  connectStdioMCPServer,
  disconnectMCPServer,
  forgetStdioSession,
  getStdioSession,
  killStdioMCP,
  rememberStdioSession,
  spawnStdioMCP,
} from '@/lib/mcp';
import { setToolDisabled, setToolDisabledList } from '@/lib/tools';
import { uid } from '@/lib/utils';

type Theme = 'light' | 'dark' | 'system';

/**
 * Small helper — appends an id to a dirty-ids array without duplicates. Used
 * inline in most write actions so we don't have to call a separate action and
 * rebuild state twice per edit. Keeps the O(N) scan but N is the count of
 * dirty-but-unpushed convs, which is tiny in practice.
 */
function includeDirty(existing: string[], id: string): string[] {
  return existing.includes(id) ? existing : [...existing, id];
}

/**
 * Auth slice — populated after POST /auth/login, cleared on logout or on any
 * authFetch that comes back 401/403. When `auth === null`, App.tsx routes to
 * <LoginView /> and all authFetch calls throw immediately.
 *
 * We deliberately persist the token to localStorage. The threat model is a
 * 5–10-person deployment on trusted machines; the convenience of not retyping
 * a password after every restart outweighs the "attacker steals localStorage"
 * risk, which is identical to them stealing an API key (same blast radius).
 */
export interface AuthUser {
  id: number;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
}

export interface AuthState {
  token: string;
  user: AuthUser;
  /** unix ms when we last refreshed `/auth/me`. Used to detect stale persist. */
  loggedInAt: number;
}

/**
 * A conflict record is created when a pull brings a server version of a
 * conversation that overwrites local unpushed edits (dirty + server's
 * updatedAt ≥ ours). The local copy is stashed here so the user can either
 * restore it ("actually keep mine") or dismiss ("that other device was right").
 *
 * Not persisted: records are transient heads-up signals, not durable state.
 * If the app restarts with an unresolved conflict, we'd rather silently drop
 * it than surface a stale toast hours later.
 *
 * TTL: 1 hour from `detectedAt`. Expiry is lazy — we filter on read in
 * applyPulledConversations / selectors; no timer needed.
 */
export interface ConflictRecord {
  conversationId: string;
  /** Snapshot of the local conversation at the moment it was overwritten. */
  localCopy: Conversation;
  /** updatedAt of the server version that won. For showing "diff by X seconds". */
  serverUpdatedAt: number;
  /** When we detected this conflict (unix ms). */
  detectedAt: number;
}

/** 1 hour. After this, conflict records auto-expire. */
export const CONFLICT_TTL_MS = 60 * 60 * 1000;

/**
 * Idle auto-logout window. After the user has been "gone" (app closed,
 * tab closed, machine asleep) for this long, we scrub the auth token on
 * rehydrate and route them to the login screen.
 *
 * 5 minutes matches the user's request and is short enough that a
 * leaving-the-machine-and-coming-back-tomorrow scenario forces re-auth,
 * but generous enough that "close laptop lid for the meeting / open
 * back up" doesn't kick people out repeatedly.
 *
 * Note: this is a *convenience* feature, not a security boundary. An
 * attacker with file-system access to the machine could read the token
 * out of localStorage during the window. Treat it as "shared device
 * lock screen" parity, not as a real session cap — that'd require
 * server-side session timeouts on the JWT.
 */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Pure helper used by onRehydrateStorage to decide whether to scrub
 * `auth`. Lives outside the store closure so it can be unit-tested
 * without spinning up a persist round-trip.
 *
 * Returns true when:
 *   - There IS a persisted auth (otherwise nothing to clear)
 *   - lastActiveAt is a real timestamp (not 0/undefined — those mean
 *     "fresh state, never seen alive", which we leave alone to avoid
 *     kicking out users on first install / upgrade)
 *   - The timestamp is older than the idle window
 */
export function shouldClearAuthOnRehydrate(opts: {
  auth: AuthState | null;
  lastActiveAt: number | undefined | null;
  now: number;
  timeoutMs?: number;
}): boolean {
  if (!opts.auth) return false;
  const last = opts.lastActiveAt;
  if (typeof last !== 'number' || last <= 0) return false;
  return opts.now - last > (opts.timeoutMs ?? IDLE_TIMEOUT_MS);
}

/**
 * A pending `fs_write_file` call, paused at the approval modal. See
 * AppState.pendingWrites for lifecycle + persistence notes.
 */
export interface PendingWrite {
  /** Unique id; used to match the Apply/Reject click back to the correct promise. */
  id: string;
  /** Path the agent wants to write (relative to workspace or absolute inside it). */
  path: string;
  /** Current file contents, or '' if the file doesn't exist yet. */
  oldContent: string;
  /** New contents the agent wants to write. */
  newContent: string;
  /** True if the file didn't exist — the modal shows "create file" framing. */
  isNewFile: boolean;
  /** Whether the agent requested create_dirs=true. Passed through on approve. */
  createDirs: boolean;
  /** unix ms when the agent requested this write. Used if we later show a timer. */
  submittedAt: number;
}

/**
 * A pending `exit_plan_mode` tool call — the agent has produced a plan and
 * is waiting for the user to approve, ask for revisions, or reject. Same
 * lifecycle pattern as PendingWrite (see writeApproval.ts) — the resolver
 * lives in a module-level Map in src/lib/planMode.ts.
 */
export interface PendingPlan {
  id: string;
  /** Conversation this plan belongs to (so we don't surface plans on other tabs). */
  conversationId: string;
  /** Markdown text of the plan the agent produced. */
  plan: string;
  submittedAt: number;
}

interface AppState {
  // UI state
  theme: Theme;
  sidebarOpen: boolean;
  artifactsOpen: boolean;
  /** Width (px) of the right-side artifacts panel. Drag-resizable, persisted. */
  artifactsPanelWidth: number;
  /** Height (px) of the Code-mode bottom panel (Tools/Terminal/Git/后台任务).
   *  Drag-resizable via the divider above the tabs. */
  codeBottomPanelHeight: number;
  activeMode: WorkMode;

  // Data
  conversations: Conversation[];
  activeConversationId: string | null;
  projects: Project[];
  activeProjectId: string | null;
  providers: ProviderConfig[];
  modelByMode: Record<WorkMode, string>;
  /**
   * Design mode: model used when the active turn has image attachments
   * and the language model can't see images. v0.1.48 made this
   * user-configurable (was hardcoded to qwen3-vl-plus). useStreamedChat
   * auto-routes vision turns through this id.
   */
  designVisionModelId: string;
  /**
   * Design mode: model used when the agent calls the `image_generate`
   * builtin tool. Today only `gpt-image-2` (PPIO) ships, but the slot
   * exists so future image-gen models slot in cleanly.
   */
  designImageGenModelId: string;
  /** All artifacts indexed by id. Multiple versions of the same id overwrite. */
  artifacts: Record<string, Artifact>;
  activeArtifactId: string | null;

  // Tool / MCP / Slash
  mcpServers: MCPServer[];
  slashCommands: SlashCommand[];
  /** Tool names the user has explicitly disabled. Applied to the registry on
   *  rehydrate and whenever MCP tools auto-register. */
  disabledToolNames: string[];

  /** User-configured automation hooks (Code mode only — desktop only). */
  hooks: Hook[];

  // Desktop / workspace (only meaningful under Tauri)
  /** Absolute path of the folder the user picked. `null` in the browser. */
  workspacePath: string | null;
  /** Explicit opt-in: without this, fs_write and shell_exec stay off even
   *  though the model sees the tools. Protects against accidental writes
   *  on a fresh install.
   *
   *  Semantics (after the diff-preview landing): when true, every
   *  `fs_write_file` call still pops a per-call approval modal showing a
   *  diff against the current file contents. The model must wait for
   *  Apply/Reject before its tool call resolves. Flipping this to false
   *  rejects all writes outright (the original behaviour). There is no
   *  "trust everything silently" mode — we decided the safety win from
   *  always-preview is worth the extra click. If it becomes annoying in
   *  practice we'll add a second opt-in (e.g. `trustFileWrites`) but
   *  YAGNI for now. */
  allowFileWrites: boolean;
  allowShellExec: boolean;
  /**
   * Pending `fs_write_file` approvals. Each entry represents a paused
   * tool call waiting for the user to click Apply or Reject in the
   * WriteApprovalModal. FIFO — the modal processes `pendingWrites[0]`,
   * the rest queue. Transient (not persisted): if the app is force-killed
   * during an approval, the tool call is lost, which is the safe default.
   *
   * The promise-resolver for each entry lives in a module-level Map in
   * `src/lib/writeApproval.ts` — we can't persist callbacks, and we
   * don't want the store to know how to resolve things itself. See that
   * file for the bridge.
   */
  pendingWrites: PendingWrite[];

  /**
   * Pending `exit_plan_mode` approvals. Each entry represents a paused
   * tool call where the agent produced a plan and is waiting for the
   * user to approve / give feedback / reject. Same FIFO + transient
   * semantics as `pendingWrites`. Bridge lives in src/lib/planMode.ts.
   */
  pendingPlans: PendingPlan[];

  /**
   * Agent self-managed TODO lists, keyed by conversation id. Written by the
   * `todo_write` builtin tool and read by the TodoPanel. Scoped per-conversation
   * because each chat typically represents one task thread — switching
   * conversations should show the right list, not a shared global one.
   *
   * Transient (not in partialize): a todo list is a working-memory artifact for
   * the current agent turn, not durable state the user wants to survive a
   * reload. On restart the agent rebuilds it from context if the task resumes.
   * Also keeps the localStorage bill down — long agent sessions can accumulate
   * lots of conversations and we don't want each one carrying a stale list.
   */
  conversationTodos: Record<string, TodoItem[]>;

  // M4: Memory + Skills
  /**
   * Global persistent memory — CLAUDE.md-style. Injected into every
   * conversation's system prompt (regardless of mode or project). Use this for
   * "facts about the user" that should persist forever: preferred languages,
   * coding style, domain background, etc.
   *
   * Project-scoped memory lives on `Project.instructions` (already persisted).
   */
  globalMemory: string;
  /** User-defined + built-in skills. Filtered by mode at prompt-composition time. */
  skills: Skill[];

  /**
   * Auth — populated after successful /auth/login, null when logged out.
   * All server-routed calls (chat, web_search, usage) key off this; App.tsx
   * redirects to <LoginView /> when it's null.
   *
   * We dropped per-user API-key integrations in Phase 4 — every third-party
   * key (LLM providers, 博查) now lives on the server and is shared across
   * the team via a single admin-managed secret.
   */
  auth: AuthState | null;

  /**
   * Unix ms of the last "I'm alive" heartbeat. Refreshed once per minute
   * by App.tsx while the user is logged in, plus on visibilitychange /
   * pagehide / beforeunload so we capture the moment the user closed
   * the tab / quit the app.
   *
   * On rehydrate, if `Date.now() - lastActiveAt > IDLE_TIMEOUT_MS` we
   * scrub `auth` and force a re-login — implements the auto-logout
   * after the user's been gone for too long. Conversation/skill/etc.
   * data stays; only the session token is cleared.
   *
   * Default 0 (never seen alive) means "old persisted state predates
   * this field" — we treat that as fresh-enough to keep auth (no
   * surprise logout on upgrade). The first heartbeat after upgrade
   * sets a real value.
   */
  lastActiveAt: number;

  // ---------------------------------------------------------------------------
  // Sync (Phase 3 — conversation history round-trip).
  //
  // `lastSyncAt` is the ms cursor for the next /sync/pull. null means "first
  // run after install/login" and triggers a seed flow (see src/lib/sync.ts).
  // We persist it so a restart doesn't re-pull the whole history.
  //
  // `dirtyConversationIds` tracks conversations that have local edits the
  // server hasn't acked yet. `pendingDeletions` is the tombstone-push queue.
  // Both are stored as plain arrays (not Sets) to survive zustand/persist
  // serialization — we wrap them in Sets at use-site.
  //
  // `syncState` drives the subtle UI indicator (spinner in the sidebar); it's
  // not persisted because every state transition is re-derived at runtime.
  // ---------------------------------------------------------------------------
  lastSyncAt: number | null;
  dirtyConversationIds: string[];
  pendingDeletions: string[];
  /**
   * Project-side twins of dirtyConversationIds / pendingDeletions. Kept in
   * parallel (rather than a single dirty-set-of-entities) because the wire
   * format splits them and the caps differ — projects are much smaller and
   * we don't want to starve a big conversation push with project rows.
   */
  dirtyProjectIds: string[];
  pendingProjectDeletions: string[];
  /**
   * Artifact-side twins. Streaming triggers upsertArtifact every token,
   * which marks dirty every token — the existing 800ms push debounce is
   * what keeps this cheap. One push sends the CURRENT state of each dirty
   * artifact (not per-token deltas), so cost is bounded by artifact count
   * not token count.
   */
  dirtyArtifactIds: string[];
  pendingArtifactDeletions: string[];
  syncState: 'idle' | 'pulling' | 'pushing' | 'error';
  syncError: string | null;
  /**
   * Unresolved LWW conflicts — see ConflictRecord. Populated by
   * applyPulledConversations when it detects a dirty conv being overwritten.
   * Rendered as dismissible Toasts at the app shell.
   */
  conflictRecords: ConflictRecord[];

  // Actions
  setTheme: (t: Theme) => void;
  toggleSidebar: () => void;
  toggleArtifacts: () => void;
  setArtifactsPanelWidth: (px: number) => void;
  setCodeBottomPanelHeight: (px: number) => void;
  setActiveMode: (m: WorkMode) => void;

  newConversation: (mode?: WorkMode, projectId?: string) => string;
  /**
   * Create a child conversation spawned from a parent (typically the
   * `spawn_subtask` tool). Differs from newConversation in three ways:
   *   - Sets `parentConversationId` so we can later render hierarchy
   *   - Does NOT touch activeConversationId — subagents run silently
   *     in the background; yanking the user's view away mid-typing
   *     would be hostile
   *   - Title is provided by the caller (the subagent's task label),
   *     not the placeholder "新对话"
   */
  newSubtaskConversation: (args: {
    parentConversationId: string;
    title: string;
    mode: WorkMode;
    modelId: string;
    projectId?: string;
  }) => string;
  setActiveConversation: (id: string | null) => void;
  deleteConversation: (id: string) => void;
  /** Drop all messages but keep the conversation shell. Used by `/clear`. */
  clearConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  /**
   * Swap the model this conversation uses. Used by the Composer's 「深度思考」
   * toggle to flip between e.g. `deepseek-chat` ↔ `deepseek-reasoner` without
   * forking the conversation. No-op if the id doesn't exist.
   */
  setConversationModel: (id: string, modelId: string) => void;
  pinConversation: (id: string, pinned: boolean) => void;
  starConversation: (id: string, starred: boolean) => void;
  setConversationProject: (id: string, projectId: string | undefined) => void;
  appendMessage: (conversationId: string, message: Message) => void;
  patchLastMessage: (conversationId: string, patch: Partial<Message>) => void;
  updateMessage: (conversationId: string, messageId: string, patch: Partial<Message>) => void;
  deleteMessage: (conversationId: string, messageId: string) => void;
  /** Truncate messages after (and optionally including) a given id. Used for regenerate. */
  truncateFrom: (conversationId: string, messageId: string, inclusive?: boolean) => void;
  /** Duplicate a conversation up through a message (branching). */
  branchConversation: (conversationId: string, upToMessageId: string) => string;
  /**
   * Replace (or clear) the conversation summary. `summaryMessageCount` is
   * how many leading messages the summary covers. Pass `undefined` to
   * remove the summary entirely.
   */
  setConversationSummary: (
    conversationId: string,
    summary: string | undefined,
    summaryMessageCount: number | undefined
  ) => void;

  setApiKey: (providerId: string, apiKey: string) => void;
  setProviderEnabled: (providerId: string, enabled: boolean) => void;
  setModelForMode: (mode: WorkMode, modelId: string) => void;
  setDesignVisionModelId: (modelId: string) => void;
  setDesignImageGenModelId: (modelId: string) => void;

  // Projects
  createProject: (name: string, description?: string) => string;
  updateProject: (id: string, patch: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  addProjectSource: (projectId: string, source: Project['sources'][number]) => void;
  removeProjectSource: (projectId: string, sourceId: string) => void;

  // Artifacts
  upsertArtifact: (artifact: Artifact) => void;
  deleteArtifact: (id: string) => void;
  setActiveArtifact: (id: string | null) => void;

  // MCP servers
  addMCPServer: (s: Omit<MCPServer, 'id' | 'status'>) => string;
  updateMCPServer: (id: string, patch: Partial<MCPServer>) => void;
  removeMCPServer: (id: string) => Promise<void>;
  connectMCPServer: (id: string) => Promise<void>;
  disconnectMCPServer: (id: string) => Promise<void>;
  /** Spawn fresh stdio children for every enabled stdio MCP. Tauri-only;
   *  called once at app launch since stdio session ids don't survive
   *  process restarts. */
  restartStdioMCPs: () => Promise<void>;

  // Slash commands
  addSlashCommand: (c: Omit<SlashCommand, 'id'>) => string;
  updateSlashCommand: (id: string, patch: Partial<SlashCommand>) => void;
  deleteSlashCommand: (id: string) => void;

  // Tools
  setToolDisabled: (name: string, disabled: boolean) => void;

  // Hooks
  addHook: (h: Omit<Hook, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateHook: (id: string, patch: Partial<Hook>) => void;
  deleteHook: (id: string) => void;

  // Desktop / workspace
  setWorkspacePath: (path: string | null) => void;
  setAllowFileWrites: (v: boolean) => void;
  setAllowShellExec: (v: boolean) => void;
  /** Append a pending write approval. Called from writeApproval.ts. */
  enqueuePendingWrite: (pw: PendingWrite) => void;
  /** Drop the resolved approval from the queue. Called from writeApproval.ts
   *  after the user clicks Apply or Reject. */
  removePendingWrite: (id: string) => void;

  /** Append a pending plan approval. Called from planMode.ts. */
  enqueuePendingPlan: (pp: PendingPlan) => void;
  /** Drop the resolved plan from the queue. Called from planMode.ts. */
  removePendingPlan: (id: string) => void;

  /**
   * Replace the todo list for a conversation (full-list write, matching the
   * `todo_write` tool semantics). Passing an empty array clears the list,
   * which the UI treats the same as "no todos yet" and hides the panel.
   */
  setConversationTodos: (conversationId: string, todos: TodoItem[]) => void;
  /** User-initiated clear (the "清空" button on the panel). */
  clearConversationTodos: (conversationId: string) => void;

  // M4: Memory + Skills
  setGlobalMemory: (text: string) => void;
  /** Append a line to global memory (used by `/remember <fact>`). */
  appendGlobalMemory: (line: string) => void;
  addSkill: (s: Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>) => string;
  updateSkill: (id: string, patch: Partial<Skill>) => void;
  deleteSkill: (id: string) => void;
  setSkillEnabled: (id: string, enabled: boolean) => void;

  // Auth
  setAuth: (payload: { token: string; user: AuthUser }) => void;
  clearAuth: () => void;
  /** Refresh the idle-timeout heartbeat. Called once per minute by App.tsx
   *  + on visibilitychange/pagehide/beforeunload. */
  setLastActiveAt: (ms: number) => void;

  // Sync (Phase 3). Mutations below bookkeep the dirty set; sync.ts owns the
  // actual transport, and calls these helpers to update cursor/state.
  markConversationDirty: (id: string) => void;
  markAllConversationsDirty: () => void;
  clearDirty: (ids: string[]) => void;
  clearPendingDeletions: (ids: string[]) => void;
  /** Mark a project as having unpushed local edits. */
  markProjectDirty: (id: string) => void;
  /** Mark every project dirty. Used by "resync everything" tooling. */
  markAllProjectsDirty: () => void;
  clearProjectDirty: (ids: string[]) => void;
  clearPendingProjectDeletions: (ids: string[]) => void;
  /** Mark an artifact as having unpushed local edits. */
  markArtifactDirty: (id: string) => void;
  /** Mark every artifact dirty. Used by first-run seed + "resync everything". */
  markAllArtifactsDirty: () => void;
  clearArtifactDirty: (ids: string[]) => void;
  clearPendingArtifactDeletions: (ids: string[]) => void;
  setLastSyncAt: (ts: number | null) => void;
  setSyncState: (state: 'idle' | 'pulling' | 'pushing' | 'error', err?: string | null) => void;
  /**
   * Apply conversations pulled from the server. Merges by id using LWW
   * (last-write-wins by updatedAt) so a pull doesn't clobber a locally-newer
   * edit that hasn't pushed yet. Does NOT mark the merged rows dirty — this
   * is a pull, not an edit.
   */
  applyPulledConversations: (convs: import('@/lib/flaudeApi').SyncConversation[]) => void;
  /**
   * Projects pulled from the server. Same LWW + tombstone semantics as
   * applyPulledConversations. We don't raise a conflict toast for projects
   * today — their edits are rare and a quiet clobber is acceptable until we
   * see it bite someone in practice.
   */
  applyPulledProjects: (projects: import('@/lib/flaudeApi').SyncProject[]) => void;
  /**
   * Artifacts pulled from the server. LWW + tombstone, same as above. No
   * conflict toast — artifacts are model output, not user-authored prose,
   * and a quiet clobber matches how the user already perceives them
   * (regenerate replaces rather than merges).
   */
  applyPulledArtifacts: (artifacts: import('@/lib/flaudeApi').SyncArtifact[]) => void;

  /**
   * Dismiss a conflict without restoring — user has acknowledged that the
   * other device's version is correct. Removes from conflictRecords.
   */
  dismissConflict: (conversationId: string) => void;
  /**
   * Restore the local copy over the server's version. Replaces the conv,
   * bumps updatedAt to now (so the next push wins the LWW race), marks it
   * dirty, and removes the conflict record. User's edit wins.
   */
  restoreConflict: (conversationId: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Defaults
      theme: 'system',
      sidebarOpen: true,
      artifactsOpen: false,
      artifactsPanelWidth: 480,
      codeBottomPanelHeight: 180,
      activeMode: 'chat',

      conversations: [],
      activeConversationId: null,
      projects: [],
      activeProjectId: null,
      providers: DEFAULT_PROVIDERS,
      modelByMode: { ...DEFAULT_MODEL_BY_MODE },
      designVisionModelId: DEFAULT_DESIGN_VISION_MODEL,
      designImageGenModelId: DEFAULT_DESIGN_IMAGE_GEN_MODEL,
      artifacts: {},
      activeArtifactId: null,

      mcpServers: [],
      hooks: [],
      slashCommands: [...BUILTIN_SLASH_COMMANDS],
      disabledToolNames: [],

      workspacePath: null,
      allowFileWrites: false,
      allowShellExec: false,
      pendingWrites: [],
      pendingPlans: [],
      conversationTodos: {},

      globalMemory: '',
      skills: [...BUILTIN_SKILLS],

      auth: null,
      lastActiveAt: 0,

      lastSyncAt: null,
      dirtyConversationIds: [],
      pendingDeletions: [],
      dirtyProjectIds: [],
      pendingProjectDeletions: [],
      dirtyArtifactIds: [],
      pendingArtifactDeletions: [],
      syncState: 'idle',
      syncError: null,
      conflictRecords: [],

      // UI
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleArtifacts: () => set((s) => ({ artifactsOpen: !s.artifactsOpen })),
      // Clamp here (not at the drag handler) so external callers can't wedge
      // the panel at 10px or 5000px and make the layout look broken.
      setArtifactsPanelWidth: (px) =>
        set({ artifactsPanelWidth: Math.min(1200, Math.max(320, Math.round(px))) }),
      setCodeBottomPanelHeight: (px) =>
        set({ codeBottomPanelHeight: Math.min(800, Math.max(80, Math.round(px))) }),
      setActiveMode: (mode) => set({ activeMode: mode }),

      // Conversations
      newConversation: (mode, projectId) => {
        const activeMode = mode ?? get().activeMode;
        // Fallback to DEFAULT_MODEL_BY_MODE if the per-mode pick is missing.
        // This is belt-and-suspenders alongside the rehydrate-time backfill —
        // covers e.g. importing an old account bundle whose settings.modelByMode
        // predates a newly-added mode. Sending an undefined model to streamChat
        // produces "model is required" 400s with no recovery path.
        const modelId =
          get().modelByMode[activeMode] ?? DEFAULT_MODEL_BY_MODE[activeMode];
        const id = uid('conv');
        const now = Date.now();
        // Stamp the currently-open workspace onto Code conversations so
        // re-opening one later restores its folder. v0.1.41 already
        // creates a fresh conversation whenever the workspace switches,
        // so this binding stays one-to-one. Non-Code conversations
        // intentionally leave workspacePath undefined — they don't care
        // about a folder context.
        const workspacePath =
          activeMode === 'code' ? get().workspacePath || undefined : undefined;
        const conv: Conversation = {
          id,
          title: '新对话',
          mode: activeMode,
          modelId,
          projectId: projectId ?? undefined,
          workspacePath,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        // Empty convs aren't marked dirty — pushing 新对话 shells that the
        // user might never type into pollutes the server with zero-content
        // rows. appendMessage is what actually flips the dirty bit; until
        // then, a refresh just loses the empty shell (which was going to be
        // hidden from the sidebar anyway by the "empty drafts" filter).
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeConversationId: id,
          activeMode,
        }));
        return id;
      },

      newSubtaskConversation: (args) => {
        const id = uid('conv');
        const now = Date.now();
        const conv: Conversation = {
          id,
          title: args.title,
          mode: args.mode,
          modelId: args.modelId,
          projectId: args.projectId ?? undefined,
          parentConversationId: args.parentConversationId,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          conversations: [conv, ...s.conversations],
          // Intentionally NOT setting activeConversationId — subagents
          // run in the background; yanking the user's view would be
          // hostile. They can click into the subtask in the sidebar
          // when they want to watch.
        }));
        return id;
      },
      setActiveConversation: (id) => {
        set({ activeConversationId: id });
        if (id) {
          const conv = get().conversations.find((c) => c.id === id);
          if (conv) set({ activeMode: conv.mode });
        }
      },
      deleteConversation: (id) =>
        set((s) => {
          // If the conv never left the client (never dirtied → never pushed),
          // skip the tombstone queue. Otherwise the server has a copy and we
          // need to queue a deletion push. Empty/unsynced convs = silent drop.
          const wasSynced =
            s.dirtyConversationIds.includes(id) ||
            // Heuristic: a conv with messages OR pinned/starred has almost
            // certainly been pushed at some point. Not perfect but avoids
            // keeping a "was this ever on the server" bit on every row.
            (s.conversations.find((c) => c.id === id)?.messages.length ?? 0) > 0;
          // Drop any todo list for this conversation — no point keeping working
          // memory for a conv that no longer exists, and we don't want dead
          // keys accumulating in `conversationTodos`.
          const nextTodos =
            id in s.conversationTodos
              ? (() => {
                  const { [id]: _drop, ...rest } = s.conversationTodos;
                  return rest;
                })()
              : s.conversationTodos;
          return {
            conversations: s.conversations.filter((c) => c.id !== id),
            activeConversationId:
              s.activeConversationId === id ? null : s.activeConversationId,
            dirtyConversationIds: s.dirtyConversationIds.filter((x) => x !== id),
            pendingDeletions: wasSynced
              ? [...s.pendingDeletions, id]
              : s.pendingDeletions,
            conversationTodos: nextTodos,
          };
        }),
      clearConversation: (id) =>
        set((s) => {
          // `/clear` wipes messages but keeps the conversation shell. Any
          // agent-managed todo list was tied to the task those messages
          // described — leaving it behind produces a weird UI where the
          // chat is empty but a TODO panel still shows planned steps.
          const nextTodos =
            id in s.conversationTodos
              ? (() => {
                  const { [id]: _drop, ...rest } = s.conversationTodos;
                  return rest;
                })()
              : s.conversationTodos;
          return {
            conversations: s.conversations.map((c) =>
              c.id === id ? { ...c, messages: [], updatedAt: Date.now() } : c
            ),
            dirtyConversationIds: includeDirty(s.dirtyConversationIds, id),
            conversationTodos: nextTodos,
          };
        }),
      renameConversation: (id, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, id),
        })),
      setConversationModel: (id, modelId) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            // Don't bump updatedAt — this is a UI affordance (e.g. toggling
            // thinking mode), not content authorship. Bumping would reshuffle
            // the sidebar every click, which feels wrong.
            //
            // Consequence: model-toggle is device-local. Multi-device users
            // won't see the "thinking mode" preference follow them. Acceptable
            // tradeoff — next message sent WILL bump updatedAt via appendMessage
            // and the model will sync then.
            c.id === id ? { ...c, modelId } : c
          ),
        })),
      pinConversation: (id, pinned) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, pinned, updatedAt: Date.now() } : c
          ),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, id),
        })),
      starConversation: (id, starred) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, starred, updatedAt: Date.now() } : c
          ),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, id),
        })),
      setConversationProject: (id, projectId) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, projectId, updatedAt: Date.now() } : c
          ),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, id),
        })),
      updateMessage: (conversationId, messageId, patch) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, ...patch } : m
                  ),
                  updatedAt: Date.now(),
                }
              : c
          ),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, conversationId),
        })),
      deleteMessage: (conversationId, messageId) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.filter((m) => m.id !== messageId),
                  updatedAt: Date.now(),
                }
              : c
          ),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, conversationId),
        })),
      truncateFrom: (conversationId, messageId, inclusive = true) =>
        set((s) => {
          let changed = false;
          const convs = s.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const idx = c.messages.findIndex((m) => m.id === messageId);
            if (idx === -1) return c;
            changed = true;
            const cutoff = inclusive ? idx : idx + 1;
            return { ...c, messages: c.messages.slice(0, cutoff), updatedAt: Date.now() };
          });
          return {
            conversations: convs,
            dirtyConversationIds: changed
              ? includeDirty(s.dirtyConversationIds, conversationId)
              : s.dirtyConversationIds,
          };
        }),
      branchConversation: (conversationId, upToMessageId) => {
        const source = get().conversations.find((c) => c.id === conversationId);
        if (!source) return conversationId;
        const idx = source.messages.findIndex((m) => m.id === upToMessageId);
        if (idx === -1) return conversationId;
        const newId = uid('conv');
        const now = Date.now();
        const copy: Conversation = {
          ...source,
          id: newId,
          title: source.title + ' (分支)',
          messages: source.messages.slice(0, idx + 1),
          createdAt: now,
          updatedAt: now,
          pinned: false,
          starred: false,
        };
        set((s) => ({
          conversations: [copy, ...s.conversations],
          activeConversationId: newId,
          // Branching produces a conv with actual content, so mark dirty
          // immediately — unlike newConversation, this one shouldn't be lost
          // on a restart before the user types anything.
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, newId),
        }));
        return newId;
      },
      setConversationSummary: (conversationId, summary, summaryMessageCount) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            // Passing an empty/undefined summary clears the fields so the
            // conversation reverts to sending full history.
            if (!summary || !summaryMessageCount) {
              // Note: we don't bump updatedAt on a clear — clearing is a
              // bookkeeping action, not meaningful activity.
              const { summary: _s, summaryMessageCount: _c, summarizedAt: _a, ...rest } = c;
              void _s; void _c; void _a; // keep linter quiet
              return rest as Conversation;
            }
            return {
              ...c,
              summary,
              summaryMessageCount,
              summarizedAt: Date.now(),
              // Summarization itself shouldn't push a conversation to the
              // top of the sidebar — leave updatedAt alone.
            };
          }),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, conversationId),
        })),
      appendMessage: (conversationId, message) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            // v0.1.45 backfill: legacy code conversations created before
            // v0.1.43 don't have `workspacePath` stamped, so the
            // "restore workspace on switch" feature has no data to
            // restore. We bind the binding the first time the user
            // actually sends a message in the conversation — that's the
            // moment they're committing to "this conversation in this
            // workspace", and we know the user-visible workspace at this
            // exact moment is the one they want associated. Idempotent:
            // a conversation that already has workspacePath is left
            // alone (so we never overwrite an explicit binding).
            const shouldBackfillWorkspace =
              c.mode === 'code' &&
              !c.workspacePath &&
              !!s.workspacePath &&
              message.role === 'user';
            return {
              ...c,
              messages: [...c.messages, message],
              updatedAt: Date.now(),
              // Auto-title from first user message
              title:
                c.messages.length === 0 && message.role === 'user'
                  ? message.content.slice(0, 40).trim() || c.title
                  : c.title,
              workspacePath: shouldBackfillWorkspace
                ? s.workspacePath ?? undefined
                : c.workspacePath,
            };
          }),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, conversationId),
        })),
      // patchLastMessage fires many times per second during streaming. We
      // mark dirty here too, but the actual push is debounced in sync.ts so
      // we don't DDoS our own server with every token.
      //
      // v0.1.46: do NOT bump `updatedAt` per-token. The sidebar sorts
      // conversations by `updatedAt DESC`, so when two conversations
      // stream at once, every patched token rotates them to the top in
      // turn — the sidebar list flickers / their positions swap dozens
      // of times per second. Stamping `updatedAt` once at stream start
      // (via the matching `appendMessage` for the assistant placeholder)
      // is enough for "newest in flight floats up"; we don't need the
      // extra resolution. The sidebar timestamp ("21:10") therefore
      // doesn't tick live during streaming — fine, it's the conversation
      // list, not a stream progress bar.
      patchLastMessage: (conversationId, patch) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId || c.messages.length === 0) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            msgs[msgs.length - 1] = { ...last, ...patch };
            return { ...c, messages: msgs };
          }),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, conversationId),
        })),

      // Providers
      setApiKey: (providerId, apiKey) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId ? { ...p, apiKey } : p
          ),
        })),
      setProviderEnabled: (providerId, enabled) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === providerId ? { ...p, enabled } : p
          ),
        })),
      setModelForMode: (mode, modelId) =>
        set((s) => ({ modelByMode: { ...s.modelByMode, [mode]: modelId } })),
      setDesignVisionModelId: (modelId) => set({ designVisionModelId: modelId }),
      setDesignImageGenModelId: (modelId) =>
        set({ designImageGenModelId: modelId }),

      // Projects
      createProject: (name, description) => {
        const id = uid('proj');
        const now = Date.now();
        set((s) => ({
          projects: [
            {
              id,
              name,
              description,
              instructions: '',
              sources: [],
              createdAt: now,
              updatedAt: now,
            },
            ...s.projects,
          ],
          activeProjectId: id,
          // Mark dirty immediately — unlike conversations we don't care about
          // empty-draft pollution (a project is always explicitly created via
          // the UI, and the user expects it to appear on their other device).
          dirtyProjectIds: includeDirty(s.dirtyProjectIds, id),
        }));
        return id;
      },
      updateProject: (id, patch) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p
          ),
          dirtyProjectIds: includeDirty(s.dirtyProjectIds, id),
        })),
      deleteProject: (id) =>
        set((s) => {
          // Convs that got unlinked need a dirty mark so the projectId=NULL
          // makes it to the server. Without this, re-pulling on another
          // device would re-link the conv to a project that no longer exists
          // (or worse, a new project with the same id).
          const affectedConvIds = s.conversations
            .filter((c) => c.projectId === id)
            .map((c) => c.id);
          const now = Date.now();
          // Mirror conversation deletion: queue a tombstone push unless the
          // project was purely local (never been dirty before and therefore
          // never pushed). A project that was dirty-then-deleted in one
          // session still gets a tombstone — safer than trying to guess
          // whether the push ever made it out.
          const wasEverPushed =
            !s.dirtyProjectIds.includes(id) || s.lastSyncAt !== null;
          return {
            projects: s.projects.filter((p) => p.id !== id),
            activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
            conversations: s.conversations.map((c) =>
              c.projectId === id ? { ...c, projectId: undefined, updatedAt: now } : c
            ),
            dirtyConversationIds: affectedConvIds.reduce(
              includeDirty,
              s.dirtyConversationIds,
            ),
            dirtyProjectIds: s.dirtyProjectIds.filter((x) => x !== id),
            pendingProjectDeletions: wasEverPushed
              ? includeDirty(s.pendingProjectDeletions, id)
              : s.pendingProjectDeletions,
          };
        }),
      addProjectSource: (projectId, source) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId
              ? { ...p, sources: [...p.sources, source], updatedAt: Date.now() }
              : p
          ),
          dirtyProjectIds: includeDirty(s.dirtyProjectIds, projectId),
        })),
      removeProjectSource: (projectId, sourceId) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  sources: p.sources.filter((src) => src.id !== sourceId),
                  updatedAt: Date.now(),
                }
              : p
          ),
          dirtyProjectIds: includeDirty(s.dirtyProjectIds, projectId),
        })),

      // Artifacts
      // NEW ids reveal the panel (Claude-style — a fresh deliverable slides
      // in for preview). Existing ids just update content — important for
      // streaming, where every token upserts and we must NOT yank focus back
      // to the panel if the user just closed it mid-reply.
      upsertArtifact: (artifact) =>
        set((s) => {
          const existing = s.artifacts[artifact.id];
          const isNew = !existing;
          // Preserve the original createdAt across streaming updates — the
          // parser in lib/artifacts.ts stamps Date.now() on every call,
          // which used to jitter createdAt by ~1 second per token. LWW
          // doesn't care about createdAt but the UI does (sort order), and
          // server sync definitely does.
          //
          // Stamp a fresh updatedAt here instead of trusting the caller.
          // Every upsert is a mutation, and the dirty-mark that follows
          // assumes updatedAt is monotonic.
          const stamped: Artifact = {
            ...artifact,
            createdAt: existing?.createdAt ?? artifact.createdAt,
            updatedAt: Date.now(),
          };
          return {
            artifacts: { ...s.artifacts, [artifact.id]: stamped },
            dirtyArtifactIds: includeDirty(s.dirtyArtifactIds, artifact.id),
            ...(isNew
              ? { activeArtifactId: artifact.id, artifactsOpen: true }
              : {}),
          };
        }),
      // Delete an artifact and keep the panel UX sensible:
      //   - If we deleted the ACTIVE artifact and others remain, promote the
      //     most recent remaining one (so the user sees content immediately,
      //     not a blank "no artifact" state).
      //   - If no artifacts remain, close the panel entirely — staring at an
      //     empty panel is worse than just hiding it.
      deleteArtifact: (id) =>
        set((s) => {
          const existed = !!s.artifacts[id];
          const copy = { ...s.artifacts };
          delete copy[id];
          const remaining = Object.values(copy);
          const activeWasDeleted = s.activeArtifactId === id;
          let nextActive = s.activeArtifactId;
          if (activeWasDeleted) {
            // Pick the most-recent remaining artifact (same ordering the
            // switcher uses — newest first).
            nextActive =
              remaining.length > 0
                ? remaining.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).id
                : null;
          }
          // Tombstone-queue policy matches projects: if the artifact was
          // dirty-and-never-synced (we've never hit /sync/push since it was
          // created) we don't need a tombstone; otherwise queue one so the
          // server flips its deleted_at. Use `lastSyncAt !== null` as the
          // "has this client ever synced" proxy.
          const neverPushed =
            s.dirtyArtifactIds.includes(id) && s.lastSyncAt === null;
          return {
            artifacts: copy,
            activeArtifactId: nextActive,
            artifactsOpen: remaining.length > 0 ? s.artifactsOpen : false,
            dirtyArtifactIds: s.dirtyArtifactIds.filter((x) => x !== id),
            pendingArtifactDeletions:
              existed && !neverPushed
                ? includeDirty(s.pendingArtifactDeletions, id)
                : s.pendingArtifactDeletions,
          };
        }),
      setActiveArtifact: (id) =>
        set({ activeArtifactId: id, artifactsOpen: id !== null }),

      // MCP servers
      //
      // Two transports today:
      //   - HTTP (`transport === 'http'` or undefined for legacy entries):
      //     just persist URL + optional token; connect = `connectMCPServer`
      //     in lib/mcp.ts which fetch()es.
      //   - Stdio (`transport === 'stdio'`): connect = spawn the child via
      //     `mcp_stdio_spawn`, then run the JSON-RPC handshake over the
      //     stdio session. The session id is in-memory only (lib/mcp.ts's
      //     `stdioSessions` map) — it doesn't survive an app restart, which
      //     is why `restartStdioMCPs` exists.
      addMCPServer: ({ name, transport, url, token, stdioConfig, enabled }) => {
        const id = uid('mcp');
        set((s) => ({
          mcpServers: [
            ...s.mcpServers,
            {
              id,
              name,
              transport,
              url,
              token,
              stdioConfig,
              enabled: enabled ?? true,
              status: 'disconnected',
            },
          ],
        }));
        return id;
      },
      updateMCPServer: (id, patch) =>
        set((s) => ({
          mcpServers: s.mcpServers.map((m) =>
            m.id === id ? { ...m, ...patch } : m
          ),
        })),
      removeMCPServer: async (id) => {
        // Tear down the MCP toolset *and* (for stdio) kill the child before
        // dropping the entry. Doing it in this order means the next render
        // won't see a "ghost" entry whose tools are still registered.
        await get().disconnectMCPServer(id);
        set((s) => ({ mcpServers: s.mcpServers.filter((m) => m.id !== id) }));
      },
      connectMCPServer: async (id) => {
        const server = get().mcpServers.find((m) => m.id === id);
        if (!server) return;
        set((s) => ({
          mcpServers: s.mcpServers.map((m) =>
            m.id === id
              ? { ...m, status: 'connecting', lastError: undefined }
              : m
          ),
        }));
        try {
          let tools;
          if (server.transport === 'stdio') {
            if (!server.stdioConfig) {
              throw new Error('stdio MCP 缺少 stdioConfig');
            }
            // Re-spawn if no live session id remembered yet (typical after
            // a fresh launch). If one exists from a previous connect attempt
            // in this process we re-use it — `mcp_stdio_recv` will tell us
            // if the child is dead and we'll fall through to the catch.
            let sessionId = getStdioSession(id);
            if (!sessionId) {
              sessionId = await spawnStdioMCP({
                command: server.stdioConfig.command,
                args: server.stdioConfig.args,
                env: server.stdioConfig.env,
                cwd: server.stdioConfig.cwd,
              });
              rememberStdioSession(id, sessionId);
            }
            ({ tools } = await connectStdioMCPServer(id, sessionId));
          } else {
            ({ tools } = await connectMCPServer(id, server.url, server.token));
          }
          set((s) => ({
            mcpServers: s.mcpServers.map((m) =>
              m.id === id
                ? {
                    ...m,
                    status: 'connected',
                    toolNames: tools.map((t) => t.name),
                  }
                : m
            ),
          }));
        } catch (e) {
          // If we spawned a child but the handshake failed, kill it so we
          // don't leak a half-initialised process slot.
          if (server.transport === 'stdio') {
            const session = getStdioSession(id);
            if (session) {
              await killStdioMCP(session);
              forgetStdioSession(id);
            }
          }
          set((s) => ({
            mcpServers: s.mcpServers.map((m) =>
              m.id === id
                ? {
                    ...m,
                    status: 'error',
                    lastError: (e as Error).message,
                  }
                : m
            ),
          }));
          throw e;
        }
      },
      disconnectMCPServer: async (id) => {
        const server = get().mcpServers.find((m) => m.id === id);
        // Always unregister the tool set even if the entry is gone — defence
        // in depth against stale registrations after a botched remove flow.
        disconnectMCPServer(id);
        if (server?.transport === 'stdio') {
          const session = getStdioSession(id);
          if (session) {
            await killStdioMCP(session);
            forgetStdioSession(id);
          }
        }
        set((s) => ({
          mcpServers: s.mcpServers.map((m) =>
            m.id === id
              ? { ...m, status: 'disconnected', toolNames: undefined }
              : m
          ),
        }));
      },
      restartStdioMCPs: async () => {
        // Walk every persisted stdio MCP that's enabled. Spawn a fresh
        // child + reconnect. Errors are swallowed onto the per-server
        // `status='error'` flag so one broken MCP doesn't block the others.
        const servers = get().mcpServers.filter(
          (m) => m.transport === 'stdio' && m.enabled,
        );
        for (const s of servers) {
          try {
            await get().connectMCPServer(s.id);
          } catch {
            /* per-server error is already on s.lastError */
          }
        }
      },

      // Slash commands
      addSlashCommand: (c) => {
        const id = uid('slash');
        set((s) => ({ slashCommands: [...s.slashCommands, { ...c, id }] }));
        return id;
      },
      updateSlashCommand: (id, patch) =>
        set((s) => ({
          slashCommands: s.slashCommands.map((c) =>
            c.id === id ? { ...c, ...patch } : c
          ),
        })),
      deleteSlashCommand: (id) =>
        set((s) => ({
          slashCommands: s.slashCommands.filter((c) => c.id !== id),
        })),

      // Tools
      setToolDisabled: (name, disabled) => {
        setToolDisabled(name, disabled);
        set((s) => {
          const set0 = new Set(s.disabledToolNames);
          if (disabled) set0.add(name);
          else set0.delete(name);
          return { disabledToolNames: [...set0] };
        });
      },

      // Hooks
      addHook: (h) => {
        const id = uid('hook');
        const now = Date.now();
        set((s) => ({
          hooks: [
            ...s.hooks,
            { ...h, id, createdAt: now, updatedAt: now },
          ],
        }));
        return id;
      },
      updateHook: (id, patch) =>
        set((s) => ({
          hooks: s.hooks.map((h) =>
            h.id === id ? { ...h, ...patch, updatedAt: Date.now() } : h,
          ),
        })),
      deleteHook: (id) =>
        set((s) => ({ hooks: s.hooks.filter((h) => h.id !== id) })),

      // Desktop
      setWorkspacePath: (path) => set({ workspacePath: path }),
      setAllowFileWrites: (v) => set({ allowFileWrites: v }),
      setAllowShellExec: (v) => set({ allowShellExec: v }),
      enqueuePendingWrite: (pw) =>
        set((s) => ({ pendingWrites: [...s.pendingWrites, pw] })),
      removePendingWrite: (id) =>
        set((s) => ({
          pendingWrites: s.pendingWrites.filter((p) => p.id !== id),
        })),

      enqueuePendingPlan: (pp) =>
        set((s) => ({ pendingPlans: [...s.pendingPlans, pp] })),
      removePendingPlan: (id) =>
        set((s) => ({
          pendingPlans: s.pendingPlans.filter((p) => p.id !== id),
        })),

      setConversationTodos: (conversationId, todos) =>
        set((s) => {
          // Empty list → drop the key entirely so selectors that test
          // `todos && todos.length` aren't fooled by a stale empty array
          // and the record doesn't slowly accumulate dead conversation ids.
          if (todos.length === 0) {
            if (!(conversationId in s.conversationTodos)) return s;
            const { [conversationId]: _drop, ...rest } = s.conversationTodos;
            return { conversationTodos: rest };
          }
          return {
            conversationTodos: {
              ...s.conversationTodos,
              // Clone the array so downstream consumers can't mutate the
              // stored version in place (the tool handler gets its args by
              // reference and could — theoretically — hold onto the list).
              [conversationId]: todos.map((t) => ({ ...t })),
            },
          };
        }),
      clearConversationTodos: (conversationId) =>
        set((s) => {
          if (!(conversationId in s.conversationTodos)) return s;
          const { [conversationId]: _drop, ...rest } = s.conversationTodos;
          return { conversationTodos: rest };
        }),

      // M4: Memory + Skills
      setGlobalMemory: (text) => set({ globalMemory: text }),
      appendGlobalMemory: (line) =>
        set((s) => {
          const trimmed = line.trim();
          if (!trimmed) return s;
          const prefix = s.globalMemory.trim();
          const body = prefix ? `${prefix}\n- ${trimmed}` : `- ${trimmed}`;
          return { globalMemory: body };
        }),
      addSkill: (s) => {
        const id = uid('skill');
        const now = Date.now();
        set((state) => ({
          skills: [
            ...state.skills,
            { ...s, id, createdAt: now, updatedAt: now, builtin: false },
          ],
        }));
        return id;
      },
      updateSkill: (id, patch) =>
        set((state) => ({
          skills: state.skills.map((sk) =>
            sk.id === id ? { ...sk, ...patch, updatedAt: Date.now() } : sk
          ),
        })),
      deleteSkill: (id) =>
        set((state) => ({
          // Don't delete built-ins — just disable. Keeps them re-seedable on upgrade.
          skills: state.skills.filter((sk) => sk.id !== id || sk.builtin),
        })),
      setSkillEnabled: (id, enabled) =>
        set((state) => ({
          skills: state.skills.map((sk) =>
            sk.id === id ? { ...sk, enabled, updatedAt: Date.now() } : sk
          ),
        })),

      // Auth
      setAuth: ({ token, user }) =>
        set({
          auth: { token, user, loggedInAt: Date.now() },
          // Fresh login resets the idle clock — otherwise a user who was
          // away for 6 minutes would log in successfully, then get kicked
          // back to the login screen on the next render.
          lastActiveAt: Date.now(),
        }),
      setLastActiveAt: (ms) => set({ lastActiveAt: ms }),
      clearAuth: () =>
        // Logout wipes *everything* tied to the user's identity — auth, sync
        // bookkeeping, and the full content set (conversations, projects,
        // artifacts, skills, memory, per-user tool config). Otherwise, when a
        // different user logs in next, their initial pull merges on top of
        // the previous user's cached data and they see someone else's
        // conversations (classic cross-account data leak — localStorage
        // doesn't care who you are).
        //
        // Deliberately *preserved* — these are machine preferences, not user
        // data: theme / sidebarOpen / artifactsPanelWidth / activeMode /
        // modelByMode / providers (server catalog mirror), and per-device
        // permissions (workspacePath / allowFileWrites / allowShellExec).
        // A user logging back into the same machine keeps their UI setup and
        // doesn't have to re-grant shell/file permissions.
        //
        // Skills + slash commands reset to the builtin seed so the next user
        // starts with a clean baseline — their own user-authored skills will
        // re-sync from the server on pull.
        set({
          auth: null,
          // User content
          conversations: [],
          activeConversationId: null,
          projects: [],
          activeProjectId: null,
          artifacts: {},
          activeArtifactId: null,
          skills: [...BUILTIN_SKILLS],
          slashCommands: [...BUILTIN_SLASH_COMMANDS],
          mcpServers: [],
          hooks: [],
          disabledToolNames: [],
          globalMemory: '',
          conversationTodos: {},
          pendingWrites: [],
          pendingPlans: [],
          // Sync bookkeeping
          lastSyncAt: null,
          dirtyConversationIds: [],
          pendingDeletions: [],
          dirtyProjectIds: [],
          pendingProjectDeletions: [],
          dirtyArtifactIds: [],
          pendingArtifactDeletions: [],
          syncState: 'idle',
          syncError: null,
          conflictRecords: [],
        }),

      // -----------------------------------------------------------------------
      // Sync bookkeeping. None of these touches the network — sync.ts reads
      // the dirty set, drives the fetch, and calls back to clearDirty / etc.
      // -----------------------------------------------------------------------
      markConversationDirty: (id) =>
        set((s) => {
          if (s.dirtyConversationIds.includes(id)) return s;
          return { dirtyConversationIds: [...s.dirtyConversationIds, id] };
        }),
      markAllConversationsDirty: () =>
        set((s) => {
          const ids = s.conversations.map((c) => c.id);
          // Preserve any pre-existing dirty ids that might not be in
          // conversations yet (unusual, but defensive).
          const merged = new Set([...s.dirtyConversationIds, ...ids]);
          return { dirtyConversationIds: [...merged] };
        }),
      clearDirty: (ids) =>
        set((s) => ({
          dirtyConversationIds: s.dirtyConversationIds.filter(
            (id) => !ids.includes(id),
          ),
        })),
      clearPendingDeletions: (ids) =>
        set((s) => ({
          pendingDeletions: s.pendingDeletions.filter((id) => !ids.includes(id)),
        })),
      markProjectDirty: (id) =>
        set((s) => {
          if (s.dirtyProjectIds.includes(id)) return s;
          return { dirtyProjectIds: [...s.dirtyProjectIds, id] };
        }),
      markAllProjectsDirty: () =>
        set((s) => {
          const ids = s.projects.map((p) => p.id);
          const merged = new Set([...s.dirtyProjectIds, ...ids]);
          return { dirtyProjectIds: [...merged] };
        }),
      clearProjectDirty: (ids) =>
        set((s) => ({
          dirtyProjectIds: s.dirtyProjectIds.filter((id) => !ids.includes(id)),
        })),
      clearPendingProjectDeletions: (ids) =>
        set((s) => ({
          pendingProjectDeletions: s.pendingProjectDeletions.filter(
            (id) => !ids.includes(id),
          ),
        })),
      markArtifactDirty: (id) =>
        set((s) => {
          if (s.dirtyArtifactIds.includes(id)) return s;
          return { dirtyArtifactIds: [...s.dirtyArtifactIds, id] };
        }),
      markAllArtifactsDirty: () =>
        set((s) => {
          const ids = Object.keys(s.artifacts);
          const merged = new Set([...s.dirtyArtifactIds, ...ids]);
          return { dirtyArtifactIds: [...merged] };
        }),
      clearArtifactDirty: (ids) =>
        set((s) => ({
          dirtyArtifactIds: s.dirtyArtifactIds.filter((id) => !ids.includes(id)),
        })),
      clearPendingArtifactDeletions: (ids) =>
        set((s) => ({
          pendingArtifactDeletions: s.pendingArtifactDeletions.filter(
            (id) => !ids.includes(id),
          ),
        })),
      setLastSyncAt: (ts) => set({ lastSyncAt: ts }),
      setSyncState: (state, err = null) =>
        set({ syncState: state, syncError: err }),

      applyPulledConversations: (pulled) =>
        set((s) => {
          if (pulled.length === 0) return s;
          const byId = new Map(s.conversations.map((c) => [c.id, c]));
          const tombstonedLocally = new Set<string>();
          // Dirty-at-pull-time: if any of these ids end up losing the LWW
          // race to the server version, the user had unpushed local edits
          // that are about to be overwritten. That's a conflict worth
          // surfacing — record the pre-clobber snapshot so they can restore.
          const localDirty = new Set(s.dirtyConversationIds);
          const newConflicts: ConflictRecord[] = [];
          const now = Date.now();

          for (const p of pulled) {
            if (p.deletedAt != null) {
              // Server says this is gone. Drop it locally regardless of
              // whether we had it. We also want to drop any lingering dirty
              // mark for it — pushing a tombstoned conv would re-resurrect it.
              //
              // If we had dirty edits on this conv, that's a conflict too —
              // the user's unpushed changes are about to vanish with the
              // tombstone.
              const existing = byId.get(p.id);
              if (existing && localDirty.has(p.id)) {
                newConflicts.push({
                  conversationId: p.id,
                  localCopy: existing,
                  serverUpdatedAt: p.updatedAt,
                  detectedAt: now,
                });
              }
              tombstonedLocally.add(p.id);
              byId.delete(p.id);
              continue;
            }

            const existing = byId.get(p.id);
            // LWW: if our local copy is strictly newer than the pulled one,
            // keep local. This shouldn't usually happen — we only pull when
            // we've finished pushing — but a burst of "edit → pull in flight"
            // could stage it.
            if (existing && existing.updatedAt > p.updatedAt) continue;

            // Server version winning. If the local copy had unpushed dirty
            // edits, snapshot it into a conflict record before we overwrite.
            if (existing && localDirty.has(p.id)) {
              newConflicts.push({
                conversationId: p.id,
                localCopy: existing,
                serverUpdatedAt: p.updatedAt,
                detectedAt: now,
              });
            }

            const messages: Message[] = (p.messages ?? []).map((m) => {
              const meta = (m.metadata ?? {}) as {
                attachments?: Attachment[];
                toolCalls?: ToolCall[];
              };
              return {
                id: m.id,
                role: (m.role as Message['role']) ?? 'user',
                content: m.content,
                reasoning: m.reasoning ?? undefined,
                attachments: meta.attachments,
                toolCalls: meta.toolCalls,
                modelId: m.modelId ?? undefined,
                tokensIn: m.tokensIn ?? undefined,
                tokensOut: m.tokensOut ?? undefined,
                createdAt: m.createdAt,
              };
            });

            const merged: Conversation = {
              id: p.id,
              title: p.title,
              // The server shouldn't ever hand us a mode we don't know about,
              // but if it does (legacy row, futureproofing), fall back to chat.
              mode: (p.mode === 'chat' || p.mode === 'code' ? p.mode : 'chat') as WorkMode,
              modelId: p.modelId ?? existing?.modelId ?? '',
              projectId: p.projectId ?? undefined,
              messages,
              pinned: p.pinned || undefined,
              starred: p.starred || undefined,
              summary: p.summary ?? undefined,
              summaryMessageCount: p.summaryMessageCount ?? undefined,
              summarizedAt: p.summarizedAt ?? undefined,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
            };
            byId.set(p.id, merged);
          }

          // Preserve original insertion order for existing convs; append new
          // ones at the end. Sort will happen in the sidebar by updatedAt, so
          // order here doesn't really matter for the UI — keeping it stable
          // matters mostly for snapshot tests.
          const next: Conversation[] = [];
          for (const c of s.conversations) {
            if (tombstonedLocally.has(c.id)) continue;
            const v = byId.get(c.id);
            if (v) {
              next.push(v);
              byId.delete(c.id);
            }
          }
          // Any remaining entries in byId are brand-new pulls.
          for (const v of byId.values()) {
            next.push(v);
          }

          const activeId = s.activeConversationId;
          const activeGone = activeId != null && tombstonedLocally.has(activeId);

          // Also drop the dirty / pendingDeletions marks for anything the
          // server just canonicalised — we don't want to immediately push
          // state we literally just pulled.
          const pulledIds = new Set(pulled.map((p) => p.id));

          // Expire stale conflict records (>1h) lazily on each pull. If the
          // user just got a new conflict for the same conv, drop the old
          // record for that id — the new snapshot supersedes.
          const newConflictIds = new Set(newConflicts.map((c) => c.conversationId));
          const keptExistingConflicts = s.conflictRecords.filter(
            (r) =>
              now - r.detectedAt < CONFLICT_TTL_MS &&
              !newConflictIds.has(r.conversationId),
          );

          return {
            conversations: next,
            activeConversationId: activeGone ? null : activeId,
            dirtyConversationIds: s.dirtyConversationIds.filter(
              (id) => !pulledIds.has(id),
            ),
            pendingDeletions: s.pendingDeletions.filter(
              (id) => !tombstonedLocally.has(id),
            ),
            conflictRecords: [...keptExistingConflicts, ...newConflicts],
          };
        }),

      applyPulledProjects: (pulled) =>
        set((s) => {
          if (pulled.length === 0) return s;
          const byId = new Map(s.projects.map((p) => [p.id, p]));
          const tombstonedLocally = new Set<string>();

          for (const p of pulled) {
            if (p.deletedAt != null) {
              tombstonedLocally.add(p.id);
              byId.delete(p.id);
              continue;
            }

            const existing = byId.get(p.id);
            // LWW: local strictly newer → keep local.
            if (existing && existing.updatedAt > p.updatedAt) continue;

            // Re-hydrate sources. Server ships it as unknown; fall back to []
            // if it's missing or malformed so the UI never crashes on a
            // corrupt pull.
            let sources: Project['sources'] = [];
            if (Array.isArray(p.sources)) {
              sources = p.sources as Project['sources'];
            }

            const merged: Project = {
              id: p.id,
              name: p.name,
              description: p.description ?? undefined,
              instructions: p.instructions ?? undefined,
              sources,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
            };
            byId.set(p.id, merged);
          }

          // Preserve original ordering; append new ones at end (the UI sorts
          // by updatedAt anyway).
          const next: Project[] = [];
          for (const p of s.projects) {
            if (tombstonedLocally.has(p.id)) continue;
            const v = byId.get(p.id);
            if (v) {
              next.push(v);
              byId.delete(p.id);
            }
          }
          for (const v of byId.values()) next.push(v);

          // Any conv that pointed at a now-tombstoned project needs a dirty
          // mark so the projectId=NULL propagates. On this device the link
          // just shows as dangling; we clear it eagerly so the next push
          // settles it.
          const tombstoneIds = tombstonedLocally;
          const affectedConvIds: string[] = [];
          const nowMs = Date.now();
          const convsNext = s.conversations.map((c) => {
            if (c.projectId && tombstoneIds.has(c.projectId)) {
              affectedConvIds.push(c.id);
              return { ...c, projectId: undefined, updatedAt: nowMs };
            }
            return c;
          });

          const pulledIds = new Set(pulled.map((p) => p.id));
          return {
            projects: next,
            conversations:
              affectedConvIds.length > 0 ? convsNext : s.conversations,
            activeProjectId:
              s.activeProjectId && tombstonedLocally.has(s.activeProjectId)
                ? null
                : s.activeProjectId,
            dirtyProjectIds: s.dirtyProjectIds.filter((id) => !pulledIds.has(id)),
            pendingProjectDeletions: s.pendingProjectDeletions.filter(
              (id) => !tombstonedLocally.has(id),
            ),
            dirtyConversationIds:
              affectedConvIds.length > 0
                ? affectedConvIds.reduce(includeDirty, s.dirtyConversationIds)
                : s.dirtyConversationIds,
          };
        }),

      applyPulledArtifacts: (pulled) =>
        set((s) => {
          if (pulled.length === 0) return s;
          const next = { ...s.artifacts };
          const tombstonedLocally = new Set<string>();

          for (const p of pulled) {
            if (p.deletedAt != null) {
              if (next[p.id]) {
                delete next[p.id];
                tombstonedLocally.add(p.id);
              }
              continue;
            }

            const existing = next[p.id];
            // LWW: local strictly newer → keep local. `updatedAt ?? createdAt`
            // handles pre-migration rehydrated rows that don't have updatedAt
            // set yet; createdAt is always present.
            const existingUpdated = existing?.updatedAt ?? existing?.createdAt ?? 0;
            if (existing && existingUpdated > p.updatedAt) continue;

            const merged: Artifact = {
              id: p.id,
              messageId: p.messageId ?? undefined,
              // Only a handful of known types. Fall back to 'code' for anything
              // unrecognised so the UI renders something rather than blowing up.
              type: (
                ['html', 'react', 'svg', 'mermaid', 'markdown', 'code', 'image'] as const
              ).includes(p.type as ArtifactType)
                ? (p.type as ArtifactType)
                : 'code',
              title: p.title,
              language: p.language ?? undefined,
              content: p.content,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
            };
            next[p.id] = merged;
          }

          // If the active artifact got tombstoned, fall back to the newest
          // remaining one (same heuristic as deleteArtifact).
          let nextActive = s.activeArtifactId;
          if (nextActive && tombstonedLocally.has(nextActive)) {
            const remaining = Object.values(next);
            nextActive =
              remaining.length > 0
                ? remaining.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).id
                : null;
          }

          const pulledIds = new Set(pulled.map((p) => p.id));
          return {
            artifacts: next,
            activeArtifactId: nextActive,
            // Close the panel if every artifact is gone — same UX as
            // deleteArtifact. Otherwise leave the user's open/closed state.
            artifactsOpen:
              Object.keys(next).length > 0 ? s.artifactsOpen : false,
            dirtyArtifactIds: s.dirtyArtifactIds.filter((id) => !pulledIds.has(id)),
            pendingArtifactDeletions: s.pendingArtifactDeletions.filter(
              (id) => !tombstonedLocally.has(id),
            ),
          };
        }),

      dismissConflict: (conversationId) =>
        set((s) => ({
          conflictRecords: s.conflictRecords.filter(
            (r) => r.conversationId !== conversationId,
          ),
        })),

      restoreConflict: (conversationId) =>
        set((s) => {
          const record = s.conflictRecords.find(
            (r) => r.conversationId === conversationId,
          );
          if (!record) return s;
          const now = Date.now();
          // Bump updatedAt so the next push wins the LWW race against the
          // server's (older-than-now) version. Without this bump the restore
          // would push a row that still loses to the server on every pull.
          const restored: Conversation = {
            ...record.localCopy,
            updatedAt: now,
          };
          // Upsert the restored conv back in. If the current list still has
          // an entry with this id (the post-pull server version), replace it;
          // otherwise append. This also handles the tombstone-conflict case
          // where the conv was dropped entirely.
          const idx = s.conversations.findIndex(
            (c) => c.id === conversationId,
          );
          const nextConvs =
            idx >= 0
              ? s.conversations.map((c) => (c.id === conversationId ? restored : c))
              : [...s.conversations, restored];
          return {
            conversations: nextConvs,
            // Also clear any tombstone-push we might have queued — we're
            // bringing this conv back to life.
            pendingDeletions: s.pendingDeletions.filter(
              (id) => id !== conversationId,
            ),
            dirtyConversationIds: includeDirty(
              s.dirtyConversationIds,
              conversationId,
            ),
            conflictRecords: s.conflictRecords.filter(
              (r) => r.conversationId !== conversationId,
            ),
          };
        }),
    }),
    {
      name: 'flaude-app-store',
      partialize: (s) => ({
        theme: s.theme,
        sidebarOpen: s.sidebarOpen,
        artifactsPanelWidth: s.artifactsPanelWidth,
        codeBottomPanelHeight: s.codeBottomPanelHeight,
        activeMode: s.activeMode,
        // Strip the base64 `data` off attachments before writing to localStorage —
        // image data URLs can each be multi-MB, and localStorage has a ~5MB total
        // quota for the whole store. Keep name/size/mime so the UI can still show
        // the 📎 chip on reload; the data itself is transient per-session.
        conversations: s.conversations.map((c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.attachments && m.attachments.length > 0
              ? {
                  ...m,
                  attachments: m.attachments.map(({ data: _d, ...rest }) => rest),
                }
              : m
          ),
        })),
        activeConversationId: s.activeConversationId,
        projects: s.projects,
        activeProjectId: s.activeProjectId,
        providers: s.providers,
        modelByMode: s.modelByMode,
        designVisionModelId: s.designVisionModelId,
        designImageGenModelId: s.designImageGenModelId,
        artifacts: s.artifacts,
        // MCP + slash + tools
        mcpServers: s.mcpServers,
        hooks: s.hooks,
        slashCommands: s.slashCommands,
        disabledToolNames: s.disabledToolNames,
        // Desktop
        workspacePath: s.workspacePath,
        allowFileWrites: s.allowFileWrites,
        allowShellExec: s.allowShellExec,
        // M4: Memory + Skills
        globalMemory: s.globalMemory,
        skills: s.skills,
        // Auth — persisted so a restart doesn't force re-login. See AuthState
        // comment for the threat-model rationale.
        auth: s.auth,
        lastActiveAt: s.lastActiveAt,
        // Sync cursor + dirty/deletion queues. Persisted so a restart mid-
        // edit-session resumes exactly where we left off — otherwise we'd
        // either re-push unchanged rows (wasteful) or drop pending deletions
        // (user-visible bug: "I deleted it but it came back"). syncState /
        // syncError are deliberately transient.
        lastSyncAt: s.lastSyncAt,
        dirtyConversationIds: s.dirtyConversationIds,
        pendingDeletions: s.pendingDeletions,
        dirtyProjectIds: s.dirtyProjectIds,
        pendingProjectDeletions: s.pendingProjectDeletions,
        dirtyArtifactIds: s.dirtyArtifactIds,
        pendingArtifactDeletions: s.pendingArtifactDeletions,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // ---------------------------------------------------------------
        // Legacy migration: Cowork mode was removed. Any persisted state
        // referencing `cowork` (active mode, per-conversation mode, or the
        // cowork slot in modelByMode) gets coerced to `chat`. We pick Chat
        // (not Code) because:
        //   - Chat preserves the user's messages without dropping them into
        //     a tool-using agent they didn't opt into;
        //   - Code has workspace/terminal UI that would look weird around a
        //     conversation that never used those tools.
        // The cast is necessary because WorkMode no longer includes 'cowork'
        // at the type level, but persisted payloads predate the narrowing.
        // ---------------------------------------------------------------
        type LegacyMode = WorkMode | 'cowork';
        const legacyActive = state.activeMode as unknown as LegacyMode;
        if (legacyActive === 'cowork') state.activeMode = 'chat';
        state.conversations = state.conversations.map((c) => {
          const legacy = c.mode as unknown as LegacyMode;
          return legacy === 'cowork' ? { ...c, mode: 'chat' as WorkMode } : c;
        });
        const mbm = state.modelByMode as unknown as Record<string, string>;
        if (mbm && 'cowork' in mbm) {
          delete mbm.cowork;
        }
        // Backfill any modes added after the user's last persisted snapshot.
        // Without this, a v0.1.8 user (modelByMode = {chat, code}) upgrading to
        // v0.1.9 has no `design` key — newConversation('design') then creates a
        // conv with modelId=undefined, the chat request goes out with no model
        // field, and the server rejects with 400 "model is required" while the
        // TopBar misleadingly shows the V4 Pro label (its <select> value falls
        // back to the first option when bound to undefined). Merge keys in
        // place so the same fix flows to TopBar, newConversation, and every
        // other reader. We only fill *missing* keys — never overwrite a user's
        // explicit pick on a mode they've already configured.
        if (state.modelByMode && typeof state.modelByMode === 'object') {
          const filled = state.modelByMode as Record<string, string>;
          for (const [k, v] of Object.entries(DEFAULT_MODEL_BY_MODE)) {
            if (!filled[k]) filled[k] = v;
          }
        } else {
          state.modelByMode = { ...DEFAULT_MODEL_BY_MODE };
        }
        // v0.1.48 backfill — designVisionModelId / designImageGenModelId
        // weren't persisted before this version. Pre-v0.1.48 users get
        // the defaults on first rehydrate and can re-pick from Settings.
        if (!state.designVisionModelId) {
          state.designVisionModelId = DEFAULT_DESIGN_VISION_MODEL;
        }
        if (!state.designImageGenModelId) {
          state.designImageGenModelId = DEFAULT_DESIGN_IMAGE_GEN_MODEL;
        }
        // Heal any conversation rows whose modelId was lost — typically from
        // the same upgrade path: created on a build that added a new mode
        // before the rehydrate-backfill above existed, so newConversation
        // stamped them with modelId=undefined. Rather than make the user
        // delete-and-recreate, retroactively assign the per-mode default. The
        // user can still re-pick from the TopBar; this only matters for the
        // *first* send where the request would otherwise 400.
        state.conversations = state.conversations.map((c) =>
          c.modelId
            ? c
            : { ...c, modelId: state.modelByMode[c.mode] ?? DEFAULT_MODEL_BY_MODE[c.mode] }
        );
        // Also scrub any `'cowork'` entries from skill.modes[] — otherwise
        // SettingsView's byMode[m].push(sk) hits an undefined bucket and
        // the whole Settings pane white-screens.
        if (Array.isArray(state.skills)) {
          state.skills = state.skills.map((sk) => {
            const modes = (sk.modes as unknown as LegacyMode[]) ?? [];
            if (!modes.includes('cowork')) return sk;
            const cleaned = modes.filter((m) => m !== 'cowork') as WorkMode[];
            return { ...sk, modes: cleaned };
          });
        }
        // Re-seed any missing built-in slash commands (e.g. after app upgrade).
        const existingTriggers = new Set(
          state.slashCommands.filter((c) => c.builtin).map((c) => c.trigger)
        );
        for (const b of BUILTIN_SLASH_COMMANDS) {
          if (!existingTriggers.has(b.trigger)) {
            state.slashCommands.push({ ...b });
          }
        }
        // Defensive: pre-v0.1.28 persisted state has no `hooks` array, which
        // would crash any selector that calls `.filter()` / `.map()` on it.
        if (!Array.isArray(state.hooks)) state.hooks = [];
        // Defensive: pre-v0.1.30 persisted state has no codeBottomPanelHeight.
        if (typeof state.codeBottomPanelHeight !== 'number') {
          state.codeBottomPanelHeight = 180;
        }
        // Stdio MCP statuses don't survive a process restart: the child
        // got reaped when the app exited, the in-memory `stdioSessions`
        // map is empty on launch, but persisted state still says
        // `status: 'connected'`. Reset every stdio entry to 'disconnected'
        // so the UI reflects reality until `restartStdioMCPs` re-spawns
        // them. (HTTP entries can stay as-is — they have no per-process
        // state, just URL + token.) Also clears stale `toolNames` so the
        // tool registry doesn't claim tools that aren't registered yet.
        if (Array.isArray(state.mcpServers)) {
          state.mcpServers = state.mcpServers.map((m) =>
            m.transport === 'stdio'
              ? {
                  ...m,
                  status: 'disconnected' as const,
                  toolNames: undefined,
                  lastError: undefined,
                }
              : m,
          );
        }
        // Idle auto-logout: if the user's been gone longer than the
        // timeout, scrub their auth on rehydrate so they hit the login
        // screen instead of finding the app pre-warmed with their session.
        // Conversation/skill/etc. data stays — we only clear the session
        // token, same as a manual logout *minus* the data wipe (so quick
        // re-logins don't have to re-pull everything from sync).
        //
        // `lastActiveAt: 0` (never seen) is treated as "fresh enough to
        // keep" — covers users upgrading from a pre-v0.1.35 build whose
        // persisted state predates this field; the next heartbeat sets a
        // real value. Without this carve-out we'd kick everyone out on
        // upgrade, which is hostile.
        if (
          state.auth &&
          typeof state.lastActiveAt === 'number' &&
          state.lastActiveAt > 0 &&
          Date.now() - state.lastActiveAt > IDLE_TIMEOUT_MS
        ) {
          state.auth = null;
          state.lastActiveAt = 0;
        }
        if (typeof state.lastActiveAt !== 'number') state.lastActiveAt = 0;
        // Re-seed the provider catalog from DEFAULT_PROVIDERS on every rehydrate.
        // The catalog (ids, displayName, baseUrl, models[], descriptions,
        // capabilities, context windows) is code-owned single source of truth;
        // only `apiKey` and `enabled` are user-owned. Without this merge, when
        // we ship a catalog update (new model, renamed label, new V4 family),
        // existing users stay stuck on the localStorage snapshot forever —
        // because zustand's persist restores whatever was there on last shutdown.
        //
        // We do this unconditionally (no version counter) because the merge is
        // idempotent: for a user on an up-to-date catalog, the DEFAULT side
        // already matches theirs; the only effect is rebuilding the objects.
        if (Array.isArray(state.providers)) {
          const userOverlay = new Map(
            state.providers.map((p) => [
              p.id,
              { apiKey: p.apiKey, enabled: p.enabled },
            ])
          );
          state.providers = DEFAULT_PROVIDERS.map((canonical) => {
            const overlay = userOverlay.get(canonical.id);
            if (!overlay) return { ...canonical };
            return {
              ...canonical,
              // apiKey is sacred — losing it would force the user to re-enter
              // every provider key after every app update. enabled likewise:
              // user may have deliberately turned MiniMax off.
              apiKey: overlay.apiKey,
              enabled: overlay.enabled ?? canonical.enabled,
            };
          });
        } else {
          state.providers = [...DEFAULT_PROVIDERS];
        }
        // Re-seed any missing built-in skills (e.g. after app upgrade added new ones).
        // We keep the user's enabled/disabled choice + any edits they made to
        // existing built-ins; only brand-new built-ins get appended.
        const existingSkillNames = new Set(
          (state.skills ?? []).filter((s) => s.builtin).map((s) => s.name)
        );
        if (!state.skills) state.skills = [];
        for (const b of BUILTIN_SKILLS) {
          if (!existingSkillNames.has(b.name)) {
            state.skills.push({ ...b });
          }
        }
        // Guarantee globalMemory is a string (might be undefined for old persisted state).
        if (typeof state.globalMemory !== 'string') state.globalMemory = '';
        // Phase 4 migration: drop the `integrations` slot entirely. Every
        // third-party key (博查, Brave before that) is server-side now — any
        // persisted client-side key is both useless and a liability. We do
        // this as a `delete` on the typed-`unknown` payload because the slot
        // isn't in AppState anymore.
        const stateAsAny = state as unknown as Record<string, unknown>;
        if ('integrations' in stateAsAny) {
          delete stateAsAny.integrations;
        }
        // Defensive: if auth was persisted from an older build that shaped it
        // differently, drop it rather than let a malformed object crash
        // authFetch. Users just re-login.
        if (
          state.auth &&
          (typeof state.auth.token !== 'string' || typeof state.auth.user !== 'object')
        ) {
          state.auth = null;
        }
        // Mark persisted MCP servers as disconnected — user re-connects on demand.
        state.mcpServers = state.mcpServers.map((m) => ({
          ...m,
          status: 'disconnected',
          toolNames: undefined,
        }));
        // Apply persisted tool-disabled set to the registry.
        setToolDisabledList(state.disabledToolNames ?? []);
      },
    }
  )
);
