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
  messages: Message[];
  createdAt: number;
  updatedAt: number;
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
  | 'zhipu'
  | 'moonshot'
  | 'minimax'
  | 'baichuan'
  | 'yi'
  | 'custom';

export interface ModelDefinition {
  id: string;                    // e.g. "deepseek-v3"
  providerId: ProviderId;
  displayName: string;
  description?: string;
  contextWindow: number;
  capabilities: {
    vision?: boolean;
    tools?: boolean;
    reasoning?: boolean;
    longContext?: boolean;
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
  toolCallDelta?: Partial<ToolCall>;
  finish?: 'stop' | 'length' | 'tool_calls' | 'error';
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/** A remote Model Context Protocol server the user has connected. */
export interface MCPServer {
  id: string;
  name: string;
  url: string;                   // e.g. "https://example.com/mcp"
  token?: string;                // Optional Bearer token
  enabled: boolean;
  /** Populated after a successful connect(). */
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
  createdAt: number;
  updatedAt: number;
}
