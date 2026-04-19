/** Shared domain types for Flaude. */

export type WorkMode = 'chat' | 'code';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Base64 or blob URL — varies by transport. */
  data?: string;
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
