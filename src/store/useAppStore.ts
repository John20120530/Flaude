import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Attachment,
  Conversation,
  MCPServer,
  Message,
  Project,
  ProviderConfig,
  Skill,
  SlashCommand,
  ToolCall,
  WorkMode,
} from '@/types';
import type { Artifact } from '@/lib/artifacts';
import { DEFAULT_MODEL_BY_MODE, DEFAULT_PROVIDERS } from '@/config/providers';
import { BUILTIN_SLASH_COMMANDS } from '@/lib/slashCommands';
import { BUILTIN_SKILLS } from '@/lib/builtinSkills';
import { connectMCPServer, disconnectMCPServer } from '@/lib/mcp';
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

interface AppState {
  // UI state
  theme: Theme;
  sidebarOpen: boolean;
  artifactsOpen: boolean;
  /** Width (px) of the right-side artifacts panel. Drag-resizable, persisted. */
  artifactsPanelWidth: number;
  activeMode: WorkMode;

  // Data
  conversations: Conversation[];
  activeConversationId: string | null;
  projects: Project[];
  activeProjectId: string | null;
  providers: ProviderConfig[];
  modelByMode: Record<WorkMode, string>;
  /** All artifacts indexed by id. Multiple versions of the same id overwrite. */
  artifacts: Record<string, Artifact>;
  activeArtifactId: string | null;

  // Tool / MCP / Slash
  mcpServers: MCPServer[];
  slashCommands: SlashCommand[];
  /** Tool names the user has explicitly disabled. Applied to the registry on
   *  rehydrate and whenever MCP tools auto-register. */
  disabledToolNames: string[];

  // Desktop / workspace (only meaningful under Tauri)
  /** Absolute path of the folder the user picked. `null` in the browser. */
  workspacePath: string | null;
  /** Explicit opt-in: without this, fs_write and shell_exec stay off even
   *  though the model sees the tools. Protects against accidental writes
   *  on a fresh install. */
  allowFileWrites: boolean;
  allowShellExec: boolean;

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
  syncState: 'idle' | 'pulling' | 'pushing' | 'error';
  syncError: string | null;

  // Actions
  setTheme: (t: Theme) => void;
  toggleSidebar: () => void;
  toggleArtifacts: () => void;
  setArtifactsPanelWidth: (px: number) => void;
  setActiveMode: (m: WorkMode) => void;

  newConversation: (mode?: WorkMode, projectId?: string) => string;
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
  removeMCPServer: (id: string) => void;
  connectMCPServer: (id: string) => Promise<void>;
  disconnectMCPServer: (id: string) => void;

  // Slash commands
  addSlashCommand: (c: Omit<SlashCommand, 'id'>) => string;
  updateSlashCommand: (id: string, patch: Partial<SlashCommand>) => void;
  deleteSlashCommand: (id: string) => void;

  // Tools
  setToolDisabled: (name: string, disabled: boolean) => void;

  // Desktop / workspace
  setWorkspacePath: (path: string | null) => void;
  setAllowFileWrites: (v: boolean) => void;
  setAllowShellExec: (v: boolean) => void;

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

  // Sync (Phase 3). Mutations below bookkeep the dirty set; sync.ts owns the
  // actual transport, and calls these helpers to update cursor/state.
  markConversationDirty: (id: string) => void;
  markAllConversationsDirty: () => void;
  clearDirty: (ids: string[]) => void;
  clearPendingDeletions: (ids: string[]) => void;
  setLastSyncAt: (ts: number | null) => void;
  setSyncState: (state: 'idle' | 'pulling' | 'pushing' | 'error', err?: string | null) => void;
  /**
   * Apply conversations pulled from the server. Merges by id using LWW
   * (last-write-wins by updatedAt) so a pull doesn't clobber a locally-newer
   * edit that hasn't pushed yet. Does NOT mark the merged rows dirty — this
   * is a pull, not an edit.
   */
  applyPulledConversations: (convs: import('@/lib/flaudeApi').SyncConversation[]) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Defaults
      theme: 'system',
      sidebarOpen: true,
      artifactsOpen: false,
      artifactsPanelWidth: 480,
      activeMode: 'chat',

      conversations: [],
      activeConversationId: null,
      projects: [],
      activeProjectId: null,
      providers: DEFAULT_PROVIDERS,
      modelByMode: { ...DEFAULT_MODEL_BY_MODE },
      artifacts: {},
      activeArtifactId: null,

      mcpServers: [],
      slashCommands: [...BUILTIN_SLASH_COMMANDS],
      disabledToolNames: [],

      workspacePath: null,
      allowFileWrites: false,
      allowShellExec: false,

      globalMemory: '',
      skills: [...BUILTIN_SKILLS],

      auth: null,

      lastSyncAt: null,
      dirtyConversationIds: [],
      pendingDeletions: [],
      syncState: 'idle',
      syncError: null,

      // UI
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleArtifacts: () => set((s) => ({ artifactsOpen: !s.artifactsOpen })),
      // Clamp here (not at the drag handler) so external callers can't wedge
      // the panel at 10px or 5000px and make the layout look broken.
      setArtifactsPanelWidth: (px) =>
        set({ artifactsPanelWidth: Math.min(1200, Math.max(320, Math.round(px))) }),
      setActiveMode: (mode) => set({ activeMode: mode }),

      // Conversations
      newConversation: (mode, projectId) => {
        const activeMode = mode ?? get().activeMode;
        const modelId = get().modelByMode[activeMode];
        const id = uid('conv');
        const now = Date.now();
        const conv: Conversation = {
          id,
          title: '新对话',
          mode: activeMode,
          modelId,
          projectId: projectId ?? undefined,
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
          return {
            conversations: s.conversations.filter((c) => c.id !== id),
            activeConversationId:
              s.activeConversationId === id ? null : s.activeConversationId,
            dirtyConversationIds: s.dirtyConversationIds.filter((x) => x !== id),
            pendingDeletions: wasSynced
              ? [...s.pendingDeletions, id]
              : s.pendingDeletions,
          };
        }),
      clearConversation: (id) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, messages: [], updatedAt: Date.now() } : c
          ),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, id),
        })),
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
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: [...c.messages, message],
                  updatedAt: Date.now(),
                  // Auto-title from first user message
                  title:
                    c.messages.length === 0 && message.role === 'user'
                      ? message.content.slice(0, 40).trim() || c.title
                      : c.title,
                }
              : c
          ),
          dirtyConversationIds: includeDirty(s.dirtyConversationIds, conversationId),
        })),
      // patchLastMessage fires many times per second during streaming. We
      // mark dirty here too, but the actual push is debounced in sync.ts so
      // we don't DDoS our own server with every token.
      patchLastMessage: (conversationId, patch) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId || c.messages.length === 0) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            msgs[msgs.length - 1] = { ...last, ...patch };
            return { ...c, messages: msgs, updatedAt: Date.now() };
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
        }));
        return id;
      },
      updateProject: (id, patch) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p
          ),
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
          };
        }),
      addProjectSource: (projectId, source) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId
              ? { ...p, sources: [...p.sources, source], updatedAt: Date.now() }
              : p
          ),
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
        })),

      // Artifacts
      // NEW ids reveal the panel (Claude-style — a fresh deliverable slides
      // in for preview). Existing ids just update content — important for
      // streaming, where every token upserts and we must NOT yank focus back
      // to the panel if the user just closed it mid-reply.
      upsertArtifact: (artifact) =>
        set((s) => {
          const isNew = !s.artifacts[artifact.id];
          return {
            artifacts: { ...s.artifacts, [artifact.id]: artifact },
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
          return {
            artifacts: copy,
            activeArtifactId: nextActive,
            artifactsOpen: remaining.length > 0 ? s.artifactsOpen : false,
          };
        }),
      setActiveArtifact: (id) =>
        set({ activeArtifactId: id, artifactsOpen: id !== null }),

      // MCP servers
      addMCPServer: ({ name, url, token, enabled }) => {
        const id = uid('mcp');
        set((s) => ({
          mcpServers: [
            ...s.mcpServers,
            {
              id,
              name,
              url,
              token,
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
      removeMCPServer: (id) => {
        disconnectMCPServer(id);
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
          const { tools } = await connectMCPServer(id, server.url, server.token);
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
      disconnectMCPServer: (id) => {
        disconnectMCPServer(id);
        set((s) => ({
          mcpServers: s.mcpServers.map((m) =>
            m.id === id
              ? { ...m, status: 'disconnected', toolNames: undefined }
              : m
          ),
        }));
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

      // Desktop
      setWorkspacePath: (path) => set({ workspacePath: path }),
      setAllowFileWrites: (v) => set({ allowFileWrites: v }),
      setAllowShellExec: (v) => set({ allowShellExec: v }),

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
        set({ auth: { token, user, loggedInAt: Date.now() } }),
      clearAuth: () =>
        // Dropping auth also resets sync state — another user logging in next
        // shouldn't inherit the previous user's cursor or dirty set (which
        // would cause their first push to contain someone else's edits).
        set({
          auth: null,
          lastSyncAt: null,
          dirtyConversationIds: [],
          pendingDeletions: [],
          syncState: 'idle',
          syncError: null,
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
      setLastSyncAt: (ts) => set({ lastSyncAt: ts }),
      setSyncState: (state, err = null) =>
        set({ syncState: state, syncError: err }),

      applyPulledConversations: (pulled) =>
        set((s) => {
          if (pulled.length === 0) return s;
          const byId = new Map(s.conversations.map((c) => [c.id, c]));
          const tombstonedLocally = new Set<string>();

          for (const p of pulled) {
            if (p.deletedAt != null) {
              // Server says this is gone. Drop it locally regardless of
              // whether we had it. We also want to drop any lingering dirty
              // mark for it — pushing a tombstoned conv would re-resurrect it.
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
          return {
            conversations: next,
            activeConversationId: activeGone ? null : activeId,
            dirtyConversationIds: s.dirtyConversationIds.filter(
              (id) => !pulledIds.has(id),
            ),
            pendingDeletions: s.pendingDeletions.filter(
              (id) => !tombstonedLocally.has(id),
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
        artifacts: s.artifacts,
        // MCP + slash + tools
        mcpServers: s.mcpServers,
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
        // Sync cursor + dirty/deletion queues. Persisted so a restart mid-
        // edit-session resumes exactly where we left off — otherwise we'd
        // either re-push unchanged rows (wasteful) or drop pending deletions
        // (user-visible bug: "I deleted it but it came back"). syncState /
        // syncError are deliberately transient.
        lastSyncAt: s.lastSyncAt,
        dirtyConversationIds: s.dirtyConversationIds,
        pendingDeletions: s.pendingDeletions,
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
