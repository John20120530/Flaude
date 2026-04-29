/** Shared domain types for Flaude. */

export type WorkMode = 'chat' | 'code' | 'design';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * `kind` distinguishes how the attachment is forwarded to the model:
 *   - 'image' → multimodal `image_url` part (vision-capable models only)
 *   - 'text'  → injected as a fenced text block in the user message
 *
 * Older messages persisted before this field existed had only image-type
 * attachments, so `kind` is optional; readers should treat undefined as
 * 'image' for backward compatibility (see wireFormat.ts).
 */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind?: 'image' | 'text';
  /** Image: base64 data URL. Unset for text attachments. */
  data?: string;
  /** Text: extracted plain-text contents (already capped + truncated). True if so. */
  text?: string;
  /** Set when `text` was truncated to fit the per-attachment cap. */
  textTruncated?: boolean;
  url?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  status: 'pending' | 'running' | 'success' | 'error';
  error?: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  attachments?: Attachment[];
  toolCalls?: ToolCall[];
  reasoning?: string;            // For thinking models
  /**
   * Anthropic Extended Thinking proof-of-thinking signature (opaque base64).
   * Echoed back on the next request inside the same thinking block, otherwise
   * Anthropic 400s on `messages[i].content[j].thinking.signature: Field
   * required`. v0.1.52 added this to fix the 2nd-turn 400 the user hit on
   * Code mode with Opus thinking. DeepSeek thinking-mode doesn't use this
   * field — only Anthropic does — so it stays undefined for non-Claude turns.
   */
  reasoningSignature?: string;
  createdAt: number;
  modelId?: string;              // Which model produced this message
  tokensIn?: number;
  tokensOut?: number;
}

export interface Conversation {
  id: string;
  title: string;
  mode: WorkMode;
  modelId: string;
  projectId?: string;
  /**
   * For Code-mode conversations: the workspace folder path that was
   * active when the conversation started. Persisted with the conversation
   * so clicking back to it in the sidebar restores that workspace, not
   * whichever folder happens to be open right now. The workspace switch
   * UX in CodeView already creates a fresh conversation when the user
   * picks a new folder (v0.1.41), so this binding is one-to-one.
   *
   * Undefined means the conversation pre-dates this binding (legacy)
   * or it's a non-Code conversation. We intentionally don't auto-clear
   * the global workspace when a non-Code conversation is opened —
   * users may switch to a Chat conversation and want their open folder
   * to stay open in the background for when they switch back.
   */
  workspacePath?: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  /**
   * If this conversation was created by `spawn_subtask` from another
   * conversation, the parent's id. Used to render a hierarchy hint in
   * the sidebar and to scope analytics. Top-level conversations leave
   * this unset.
   */
  parentConversationId?: string;
  /** Pinned conversations appear at top of sidebar. */
  pinned?: boolean;
  /** Starred shows in a separate section. */
  starred?: boolean;
  /**
   * Compressed text summary of the first `summaryMessageCount` messages.
   * When present, those messages are *not* sent to the model; instead the
   * summary is appended to the system prompt. Used by M6 context management
   * to keep long conversations within the model's context window.
   */
  summary?: string;
  /**
   * How many leading messages are covered by `summary`. We use a count
   * rather than an ID so that deleting / editing messages degrades
   * gracefully (we clamp at runtime). A value of 0 (or missing) means
   * no summary is active.
   */
  summaryMessageCount?: number;
  /** When the summary was last generated (ms). Shown in the UI chip. */
  summarizedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  /** Custom instructions (like Claude's Project Knowledge prompt). */
  instructions?: string;
  /** RAG sources: uploaded files, indexed folders. */
  sources: ProjectSource[];
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSource {
  id: string;
  kind: 'file' | 'folder' | 'url' | 'text';
  name: string;
  path?: string;
  content?: string;
  tokenEstimate?: number;
}

export type ProviderId =
  | 'deepseek'
  | 'qwen'
  // 'zhipu' removed in v0.1.51 — kept out of the union so any stale modelId
  // string that still references glm-* fails to type-narrow at the routing
  // layer instead of silently being sent to a defunct provider.
  | 'moonshot'
  | 'minimax'
  | 'baichuan'
  | 'yi'
  // v0.1.48: PPIO is a model gateway covering Anthropic + image-gen
  // models (GPT Image 2). Different protocol per family — we route
  // imageGen-capability models to /tools/image_generate (server-side
  // proxy with shared key), and Anthropic chat models will get a
  // separate translation layer in v0.1.49.
  | 'ppio'
  // v0.1.62: PPIO also exposes Google Gemini through their *separate*
  // OpenAI-compatible host (api.ppinfra.com). Different protocol surface
  // from `ppio` (which is reserved for the Anthropic native path used
  // by Claude). Same PPIO_API_KEY works for both.
  | 'ppio-openai'
  | 'custom';

export interface ModelDefinition {
  id: string;                    // e.g. "deepseek-v3"
  providerId: ProviderId;
  displayName: string;
  description?: string;
  contextWindow: number;
  capabilities: {
    /** Accepts image inputs (multi-modal vision). Used by Design mode
     *  to route image-attachment turns to a vision-capable model. */
    vision?: boolean;
    tools?: boolean;
    reasoning?: boolean;
    longContext?: boolean;
    /** This model **generates** images (raster output) rather than
     *  participating in chat. Filtered into Design mode's
     *  "image-gen model" picker. NOT a chat model — calls go through
     *  /tools/image_generate, not /v1/chat/completions. */
    imageGen?: boolean;
  };
  /** Which modes this model is best suited for. */
  recommendedFor: WorkMode[];
}

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  baseUrl: string;               // OpenAI-compatible endpoint
  apiKey?: string;               // User-supplied; stored locally
  enabled: boolean;
  models: ModelDefinition[];
}

/** A generic streamed chunk from any provider. */
export interface StreamChunk {
  delta?: string;                // Content delta
  reasoningDelta?: string;       // Thinking delta
  /**
   * Anthropic Extended Thinking signature delta. The upstream emits one
   * `signature_delta` per thinking content block (usually a single chunk
   * at the block end). The streaming consumer concatenates these into a
   * single `reasoningSignature` on the assistant message.
   */
  reasoningSignatureDelta?: string;
  toolCallDelta?: Partial<ToolCall>;
  finish?: 'stop' | 'length' | 'tool_calls' | 'error';
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * Configuration for a stdio-based MCP server. Tauri-only; on web the entry
 * exists in the manifest but install just shows the npm command.
 *
 * The host module `src-tauri/src/mcp_stdio.rs` spawns the command, pipes
 * stdin/stdout, and exposes `mcp_stdio_send` / `mcp_stdio_recv` IPC. The
 * runtime stdio session id (issued by spawn, regenerated each time we
 * reconnect) is NOT stored here — it's transient and lives in
 * `lib/mcp.ts`'s `stdioSessions` map for the life of the app process.
 */
export interface MCPStdioConfig {
  /** Command to run (e.g. "npx", "node", "python"). */
  command: string;
  /** CLI args (e.g. ["-y", "@modelcontextprotocol/server-memory"]). */
  args: string[];
  /**
   * Environment variables. Common use: `GITHUB_PERSONAL_ACCESS_TOKEN`,
   * `SLACK_BOT_TOKEN`, etc. Stored as plaintext — same trust model as the
   * existing HTTP `token` field.
   */
  env?: Record<string, string>;
  /** Optional working directory. Most stdio MCPs don't care. */
  cwd?: string;
}

/** A connected Model Context Protocol server (HTTP or stdio). */
export interface MCPServer {
  id: string;
  name: string;
  /**
   * Wire transport. Defaults to `'http'` when omitted (legacy entries
   * predating the stdio support were all HTTP).
   */
  transport?: 'http' | 'stdio';
  /**
   * HTTP endpoint URL — used only when `transport === 'http'`. For stdio
   * entries we leave this as an empty string for back-compat with the
   * `installedUrls` set used by the marketplace UI.
   */
  url: string;
  /** Bearer token for HTTP. Ignored for stdio (use `stdioConfig.env`). */
  token?: string;
  /** Stdio spawn config — required when `transport === 'stdio'`. */
  stdioConfig?: MCPStdioConfig;
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  lastError?: string;
  /** Tool names discovered on the server (flat list for UI). */
  toolNames?: string[];
}

/**
 * User-configured automation hook. Runs a shell command in response to
 * specific Code-mode events. Tauri-only — the runner uses the desktop
 * shell_exec IPC.
 *
 * Events:
 *   - 'pre_tool_use'  — fires BEFORE a matching tool executes. Exit 0 →
 *                       tool proceeds normally. Exit ≠ 0 → tool is blocked,
 *                       hook's stderr becomes the tool result text.
 *   - 'post_tool_use' — fires AFTER a matching tool succeeds. Hook
 *                       stdout/stderr is appended to the tool result so
 *                       the agent sees it next round.
 *   - 'stop'          — fires when the agent turn ends. Output discarded.
 *
 * Substitution variables in `command` (replaced before shell wrapping):
 *   $FLAUDE_TOOL          — tool name
 *   $FLAUDE_FILE          — fs_write_file: the path argument; empty otherwise
 *   $FLAUDE_WORKSPACE     — current Code-mode workspace path
 *   $FLAUDE_ARGS_JSON     — JSON of the tool's arguments (single-quoted, escaped)
 *
 * Tool matcher is a simple pipe-separated allowlist (e.g. "fs_write_file"
 * or "fs_write_file|shell_exec"). `*` matches any tool. Ignored when
 * event === 'stop'.
 */
export interface Hook {
  id: string;
  name: string;
  enabled: boolean;
  event: 'pre_tool_use' | 'post_tool_use' | 'stop';
  /** Pipe-separated tool names, or '*' for any tool. Ignored for 'stop'. */
  toolMatcher: string;
  /** Shell command. Wrapped in `cmd /c` on Windows, `sh -c` elsewhere. */
  command: string;
  /** Default 30000. Killed at this point; tool result text mentions the timeout. */
  timeoutMs: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * A user-defined (or built-in) slash command.
 *
 * Two kinds:
 *   - template: types out a prefilled prompt into the composer. `{{input}}`
 *     is replaced by whatever the user typed after the command.
 *   - action:   performs a UI action (clear / compact / etc). Resolved
 *     to a handler by `kind`.
 */
export interface SlashCommand {
  id: string;
  trigger: string;               // e.g. "/sum"
  description: string;
  kind: 'template' | 'action';
  /** For kind=template */
  template?: string;
  /** For kind=action — the built-in handler key (e.g. "clear", "compact"). */
  action?: string;
  builtin?: boolean;
}

/**
 * A Skill is a reusable capability bundle — prompt guidance that teaches the
 * model how to handle a specific kind of task. Skills are prompt-injected into
 * the system prompt as a catalogue; the model reads the description and
 * activates the skill's instructions when the user's request matches.
 *
 * Unlike tools, skills don't have executable code — they're pure prompt
 * engineering, packaged and reusable. Think Anthropic Claude Skills: SKILL.md
 * with a frontmatter + body.
 */
/**
 * Agent self-managed todo item. Written by the `todo_write` tool so a Code-mode
 * agent can expose its plan for a multi-step task. Modeled directly on Claude
 * Code's TodoWrite: each entry carries both an imperative form (for the list
 * view) and a present-continuous form (shown while in_progress), plus a
 * status. We keep the tool contract — and therefore this type — stable across
 * calls so the agent can diff against what it wrote last time.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Imperative form, e.g. "Fix the auth bug". Used in the list view. */
  content: string;
  /** Present-continuous form, e.g. "Fixing the auth bug". Shown when status=in_progress. */
  activeForm: string;
  status: TodoStatus;
}

/**
 * A single auxiliary file bundled with a Skill at install time.
 *
 * Real-world Claude Skills are folders, not single files — they ship
 * SKILL.md alongside `templates/`, `scripts/`, `config/`, etc. The
 * SKILL.md body references those paths directly (e.g. "see
 * templates/alert.md") and the agent is expected to read them on
 * demand. Without bundled assets, those references dangle.
 *
 * Bundled at install time (Worker walks the GitHub tree, fetches each
 * text file, ships the lot in one response) and stored locally with
 * the skill so subsequent reads are offline-fast. Read by the
 * `read_skill_asset` builtin tool when the agent quotes a path.
 */
export interface SkillAsset {
  /** Relative path within the skill folder, e.g. "templates/alert.md". */
  path: string;
  /** UTF-8 text content. Binaries are filtered at install time. */
  content: string;
  /** Bytes (UTF-8). Stored explicitly so we can render size hints in
   *  the asset manifest without re-encoding the content. */
  size: number;
}

export interface Skill {
  id: string;
  /** Short kebab-case identifier, e.g. "code-review". Shown to the model. */
  name: string;
  /** Display name for UI, e.g. "代码评审". */
  title: string;
  /**
   * Short one-line trigger description: *when* to use this skill. The model
   * reads this in the skill catalogue to decide whether to activate.
   */
  description: string;
  /**
   * The actual guidance body — how to do the task. Markdown is fine.
   * Injected into the system prompt when the skill's mode matches.
   */
  instructions: string;
  /** Which modes this skill is relevant in. Empty = all modes. */
  modes: WorkMode[];
  /** User can toggle this off without deleting it. */
  enabled: boolean;
  builtin?: boolean;
  /**
   * Auxiliary files bundled with the skill. Optional — user-authored
   * skills (typed into the form) and pre-v0.1.44 skills won't have any.
   * Skills installed from the marketplace get whatever's in the same
   * folder as SKILL.md, subject to size/extension/depth caps applied
   * server-side at install time.
   *
   * The agent reads these via the `read_skill_asset` tool — the system
   * prompt lists their paths in a manifest so the agent knows what to
   * ask for. Total bundle is capped at ~1MB to keep store size sane.
   */
  assets?: SkillAsset[];
  createdAt: number;
  updatedAt: number;
}
