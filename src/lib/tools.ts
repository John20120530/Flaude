/**
 * Tool registry — shared by the streaming loop, the settings UI, and MCP.
 *
 * A "tool" is an OpenAI-compatible function that the model can call. Each tool
 * declares a JSON-Schema for its arguments and an async handler that produces
 * a string result.
 *
 * Tools come from three sources:
 *   - builtin: shipped with Flaude (see BUILTIN_TOOLS below)
 *   - mcp:     discovered on a connected MCP server
 *   - skill:   (future) authored by the user via the Skills system
 *
 * The registry is a simple in-memory map; MCP tools are re-registered each
 * time a server reconnects.
 */

import type { TodoItem, TodoStatus, WorkMode } from '@/types';
import type { ToolSpec } from '@/services/providerClient';
import { FlaudeApiError, webSearch } from '@/lib/flaudeApi';
import { uid } from '@/lib/utils';

export type ToolSource = 'builtin' | 'mcp' | 'skill';

export interface ToolContext {
  conversationId: string;
  signal?: AbortSignal;
  /** Hook for tools that want to create/update artifacts. */
  upsertArtifact?: (args: {
    id: string;
    type: string;
    title: string;
    content: string;
    language?: string;
  }) => void;
  /**
   * Hook for `todo_write`. Replaces the whole todo list for the conversation
   * this call belongs to. We inject it through ctx (rather than having tools.ts
   * import the store directly) so the registry stays store-agnostic and easy
   * to unit-test — otherwise the module graph has a cycle: store → tools,
   * tools → store.
   */
  setTodos?: (todos: TodoItem[]) => void;
  /**
   * Hook for `exit_plan_mode`. Same cycle-avoidance reason as `setTodos` —
   * the handler awaits a Promise resolved by the PlanApprovalModal in the
   * UI tree. Injected by useStreamedChat from src/lib/planMode.ts.
   */
  requestPlanApproval?: (plan: string) => Promise<PlanApprovalResultLite>;
  /**
   * Hook for `spawn_subtask`. Runs a fresh Code-mode conversation to
   * completion and returns its final assistant text. Injected by
   * useStreamedChat from src/lib/subagent.ts so tools.ts doesn't depend
   * on the store directly. Lite shape mirrors SubagentRequest /
   * SubagentResult for the same cycle-avoidance reason as
   * PlanApprovalResultLite below.
   */
  spawnSubtask?: (req: SubagentRequestLite) => Promise<SubagentResultLite>;
  /**
   * Hook for `read_skill_asset`. Returns the auxiliary file bundled
   * with an installed Skill at install time, or `null` if the skill
   * isn't installed / the asset path doesn't match. Injected from the
   * chat hook so tools.ts doesn't reach into useAppStore directly
   * (same cycle-avoidance pattern as the other hooks above).
   */
  readSkillAsset?: (args: {
    skillName: string;
    assetPath: string;
  }) => { content: string; size: number } | null;
}

export interface SubagentRequestLite {
  title: string;
  prompt: string;
  context?: string;
}

export interface SubagentResultLite {
  finalText: string;
  subConversationId: string;
  truncated: boolean;
}

/**
 * Lite version of PlanApprovalResult — duplicated here to keep tools.ts
 * free of any direct import from planMode.ts (which would re-introduce
 * the cycle through the store).
 */
export type PlanApprovalResultLite =
  | { kind: 'approved' }
  | { kind: 'feedback'; feedback: string }
  | { kind: 'rejected'; reason?: string };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  source: ToolSource;
  /** For MCP tools, the owning server id (used for routing calls). */
  serverId?: string;
  /** Which modes this tool is enabled in. */
  modes: WorkMode[];
  /** Whether the user can disable this tool via settings. */
  disabled?: boolean;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, ToolDefinition>();
const listeners = new Set<() => void>();
/** Names the user has explicitly disabled. Persisted in the app store. */
let disabledSet = new Set<string>();

function notify() {
  for (const l of listeners) l();
}

export function onRegistryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerTool(tool: ToolDefinition) {
  // Respect any persisted disabled flag the moment the tool is registered —
  // otherwise MCP tools would come up enabled on reconnect.
  if (disabledSet.has(tool.name)) tool.disabled = true;
  registry.set(tool.name, tool);
  notify();
}

/** Apply the full disabled-name list (used when rehydrating from storage). */
export function setToolDisabledList(names: string[]) {
  disabledSet = new Set(names);
  for (const t of registry.values()) {
    t.disabled = disabledSet.has(t.name);
  }
  notify();
}

export function setToolDisabled(name: string, disabled: boolean) {
  if (disabled) disabledSet.add(name);
  else disabledSet.delete(name);
  const t = registry.get(name);
  if (t) t.disabled = disabled;
  notify();
}

export function getDisabledToolNames(): string[] {
  return [...disabledSet];
}

export function unregisterTool(name: string) {
  if (registry.delete(name)) notify();
}

export function unregisterBySource(source: ToolSource, serverId?: string) {
  let changed = false;
  for (const [name, t] of registry) {
    if (t.source !== source) continue;
    if (serverId && t.serverId !== serverId) continue;
    registry.delete(name);
    changed = true;
  }
  if (changed) notify();
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(filter?: {
  source?: ToolSource;
  mode?: WorkMode;
  includeDisabled?: boolean;
}): ToolDefinition[] {
  return [...registry.values()].filter((t) => {
    if (filter?.source && t.source !== filter.source) return false;
    if (filter?.mode && !t.modes.includes(filter.mode)) return false;
    if (!filter?.includeDisabled && t.disabled) return false;
    return true;
  });
}

/** Translate enabled tools for a mode into the wire format providerClient wants. */
export function toolsForMode(mode: WorkMode): ToolSpec[] {
  // Used to be `if (mode === 'chat') return []` — we kept Chat "pure" when the
  // only built-ins were agentic (calculator, web_fetch, create_artifact). Once
  // we added `web_search` (which is arguably *most* useful in everyday Q&A),
  // the "chat has zero tools" rule stopped paying rent. Tools now declare
  // their own `modes`, and this filter just honors them.
  return listTools({ mode }).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Execute a tool by name. Returns a string (wire-format expected by OpenAI). */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`未知工具: ${name}`);
  return tool.handler(args, ctx);
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

/**
 * Collapse a 博查 `dateLastCrawled` ISO timestamp into something human-scanable
 * for the model ("3 天前", "今天"), matching the vibe of Brave's `age` field
 * so search results read the same regardless of backend.
 *
 * Graceful: returns the raw string if parsing fails — the model still sees
 * *something* useful, just less polished.
 */
function formatBochaDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  const days = Math.floor(diffMs / day);
  if (days < 0) return d.toLocaleDateString('zh-CN'); // future-dated — weird, just show date
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return d.toLocaleDateString('zh-CN');
}

/** Safe math evaluator: only digits and operator chars allowed. */
function evalMath(expr: string): number {
  const cleaned = expr.replace(/\s+/g, '').replace(/\^/g, '**');
  if (!/^[-+*/%()0-9.e**]+$/i.test(cleaned)) {
    throw new Error('表达式包含不安全的字符，仅支持 + - * / % ^ ( ) 和数字');
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict"; return (${cleaned});`);
  const v = fn();
  if (typeof v !== 'number' || !isFinite(v)) {
    throw new Error('表达式结果非有限数');
  }
  return v;
}

const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'current_time',
    description:
      'Get the current date and time. Useful when the user asks about today, now, or needs a timestamp.',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone (e.g. "Asia/Shanghai"). Defaults to local.',
        },
      },
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ timezone }) => {
      const opts: Intl.DateTimeFormatOptions = {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: typeof timezone === 'string' ? timezone : undefined,
      };
      try {
        return new Intl.DateTimeFormat('zh-CN', opts).format(new Date());
      } catch {
        return new Date().toString();
      }
    },
  },

  {
    name: 'calculator',
    description:
      'Evaluate a numeric expression. Supports + - * / % ^ and parentheses. ' +
      'Use this instead of doing arithmetic by hand when precision matters.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The expression, e.g. "2 * (3 + 4) ^ 2"',
        },
      },
      required: ['expression'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ expression }) => {
      const result = evalMath(String(expression ?? ''));
      return `${expression} = ${result}`;
    },
  },

  {
    name: 'web_fetch',
    description:
      'Fetch the text content of a URL. Returns up to ~20KB of text. ' +
      'May fail on CORS — use only for endpoints the browser can reach.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL' },
        max_chars: { type: 'number', description: 'Max characters to return (default 20000)' },
      },
      required: ['url'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ url, max_chars }, { signal }) => {
      const u = String(url);
      if (!/^https?:\/\//i.test(u)) throw new Error('URL 必须以 http:// 或 https:// 开头');
      const limit = typeof max_chars === 'number' ? max_chars : 20_000;
      const res = await fetch(u, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const ct = res.headers.get('content-type') ?? '';
      const text = await res.text();
      const clipped = text.length > limit
        ? text.slice(0, limit) + `\n\n[... 截断，原始 ${text.length} 字符]`
        : text;
      return `URL: ${u}\nContent-Type: ${ct}\n\n${clipped}`;
    },
  },

  {
    // Backed by 博查 (BochaAI) Web Search — a Chinese-market search backend
    // tuned for LLM consumption. Chosen over Brave/Google for:
    //   - Coverage: Weibo/Zhihu/WeChat/domestic news that western APIs miss.
    //   - Access: direct from within China, no VPN.
    //   - Output: `summary: true` returns LLM-ready summaries, saves a
    //     follow-up web_fetch round for most queries.
    //
    // Phase 4 change: the 博查 API key now lives server-side (shared across
    // all Flaude users). This handler calls `POST {flaude}/tools/web_search`
    // instead of hitting 博查 directly. Benefits:
    //   - Friends don't need their own 博查 account / credits.
    //   - The server can rate-limit / audit usage per user.
    //   - The client ships without any third-party key material.
    //
    // If the server doesn't have BOCHA_API_KEY set (503), we surface a
    // "ask the admin to enable" message — the tool schema still registers
    // so the model sees a stable tools list.
    name: 'web_search',
    description:
      'Search the web for current information. Use when the user asks about ' +
      'recent events, news, prices, who-is-someone questions, or anything that ' +
      'likely changed after training cutoff. Backed by 博查 (BochaAI), which ' +
      'covers Chinese-internet sources (Weibo, Zhihu, WeChat, etc.) in addition ' +
      'to the open web. Returns title + URL + summary for each result. ' +
      'Follow up with web_fetch if you need full page content.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query. Use the user\'s exact phrasing when possible.',
        },
        count: {
          type: 'number',
          description: 'Number of results (1-10, default 5). Larger = more context spend.',
        },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description:
            'Optional recency filter. Omit for "any time". Use this when the ' +
            'user implies freshness ("latest", "today", "this week").',
        },
      },
      required: ['query'],
    },
    source: 'builtin',
    modes: ['chat', 'code'],
    handler: async ({ query, count, freshness }) => {
      const q = String(query ?? '').trim();
      if (!q) throw new Error('搜索词不能为空');
      const n = Math.max(1, Math.min(10, Number(count) || 5));

      // webSearch() is the typed wrapper around authFetch → Flaude server.
      // It throws FlaudeApiError on non-2xx; we translate the common ones
      // into model-friendly Chinese copy.
      let data;
      try {
        data = await webSearch({
          query: q,
          count: n,
          freshness:
            freshness === 'day' || freshness === 'week' ||
            freshness === 'month' || freshness === 'year'
              ? freshness
              : undefined,
        });
      } catch (err) {
        if (err instanceof FlaudeApiError) {
          if (err.status === 503) {
            throw new Error('服务端未开启 Web Search（管理员未配置 BOCHA_API_KEY）。请联系管理员开启。');
          }
          if (err.status === 429) {
            throw new Error('Web Search 被上游限流，稍后重试。');
          }
          if (err.status === 401 || err.status === 403) {
            throw new Error('会话已失效，请重新登录后再试。');
          }
          throw new Error(`Web Search 失败（HTTP ${err.status}）：${err.message}`);
        }
        throw err;
      }

      const results = data.results ?? [];
      if (results.length === 0) {
        return `搜索「${q}」无结果。`;
      }
      const lines = results.slice(0, n).map((r, i) => {
        // Prefer the pre-summarized `summary`; fall back to raw `snippet`.
        // Server returns snake_case (site_name, date_last_crawled).
        const body = r.summary?.trim() || r.snippet?.trim() || '';
        const site = r.site_name ? ` · ${r.site_name}` : '';
        const when = r.date_last_crawled ? ` · ${formatBochaDate(r.date_last_crawled)}` : '';
        return `[${i + 1}] ${r.name || '(untitled)'}${site}${when}\n    ${r.url || ''}\n    ${body}`;
      });
      return `搜索「${q}」共 ${results.length} 条，展示前 ${Math.min(n, results.length)} 条：\n\n${lines.join('\n\n')}`;
    },
  },

  {
    // Agent self-managed TODO list — modeled on Claude Code's TodoWrite.
    //
    // Call pattern: the model passes the *full* list each time (not a patch).
    // This keeps the contract dead simple — no "delete id 3, add after 5"
    // operations — at the cost of some bytes per call. For realistic list
    // sizes (5-15 items) the overhead is negligible and the reliability win
    // is big: the model can't accidentally orphan an item by forgetting an
    // op, and the store always reflects what the model currently believes
    // the plan is.
    //
    // We gate this to code mode because that's where multi-step agent runs
    // actually happen. In chat mode a todo list would just be noise.
    //
    // We deliberately DON'T reject lists with multiple `in_progress` items —
    // smaller models sometimes forget to flip the previous one to completed,
    // and a hard rejection would waste a tool round-trip. The UI highlights
    // the oldest in_progress as the "current" one, which is usually right.
    name: 'todo_write',
    description:
      'Maintain a visible TODO list for the current task so the user can see ' +
      'what you are planning and what\'s done. Call this when you start a ' +
      'multi-step task, and again after each step completes (mark that item ' +
      '`completed` and promote the next to `in_progress`). Each call replaces ' +
      'the entire list — always send every item every time. Keep exactly one ' +
      'item `in_progress` at a time. Pass an empty array to clear the list ' +
      'when the task is done.\n\n' +
      'Each item has:\n' +
      '  - content: imperative form, e.g. "Fix the auth bug"\n' +
      '  - activeForm: present-continuous form, e.g. "Fixing the auth bug"\n' +
      '  - status: "pending" | "in_progress" | "completed"',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description:
            'Full TODO list after this update. An empty array clears the list.',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'Imperative form, e.g. "Run the migration".',
              },
              activeForm: {
                type: 'string',
                description:
                  'Present-continuous form shown while in_progress, e.g. "Running the migration".',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
              },
            },
            required: ['content', 'activeForm', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ todos }, { setTodos }) => {
      if (!setTodos) {
        throw new Error('当前上下文不支持 todo_write（缺少 setTodos 钩子）');
      }
      if (!Array.isArray(todos)) {
        throw new Error('todos 必须是一个数组');
      }
      // Validate + normalize each entry. We're defensive here because the
      // model sometimes returns near-valid shapes (e.g. status="todo" instead
      // of "pending") — better to say "I rejected this, here's why" than to
      // store garbage that crashes the renderer.
      const validStatuses: readonly TodoStatus[] = [
        'pending',
        'in_progress',
        'completed',
      ];
      const cleaned: TodoItem[] = [];
      for (let i = 0; i < todos.length; i++) {
        const raw = todos[i] as Record<string, unknown> | null | undefined;
        if (!raw || typeof raw !== 'object') {
          throw new Error(`第 ${i + 1} 项不是对象`);
        }
        const content = typeof raw.content === 'string' ? raw.content.trim() : '';
        const activeForm =
          typeof raw.activeForm === 'string' ? raw.activeForm.trim() : '';
        const status = raw.status as TodoStatus;
        if (!content) {
          throw new Error(`第 ${i + 1} 项缺少 content（祈使句形式）`);
        }
        if (!activeForm) {
          throw new Error(`第 ${i + 1} 项缺少 activeForm（进行时形式）`);
        }
        if (!validStatuses.includes(status)) {
          throw new Error(
            `第 ${i + 1} 项 status 无效（${String(raw.status)}），必须是 pending | in_progress | completed`
          );
        }
        cleaned.push({ content, activeForm, status });
      }

      setTodos(cleaned);

      if (cleaned.length === 0) {
        return '已清空 TODO 列表。';
      }
      const counts = cleaned.reduce(
        (acc, t) => {
          acc[t.status] += 1;
          return acc;
        },
        { pending: 0, in_progress: 0, completed: 0 } as Record<TodoStatus, number>
      );
      const active = cleaned.find((t) => t.status === 'in_progress');
      const summary =
        `已更新 TODO 列表：共 ${cleaned.length} 项，` +
        `${counts.completed} 已完成 / ${counts.in_progress} 进行中 / ${counts.pending} 待办。`;
      return active ? `${summary} 当前：${active.activeForm}` : summary;
    },
  },

  {
    name: 'create_artifact',
    description:
      'Create or update a Flaude artifact (a viewable deliverable) directly. ' +
      'Prefer <artifact> tags for most content; use this tool when you want the ' +
      'artifact to appear without inline formatting in the reply.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'kebab-case unique id' },
        type: {
          type: 'string',
          enum: ['html', 'react', 'svg', 'mermaid', 'markdown', 'code'],
        },
        title: { type: 'string' },
        content: { type: 'string', description: 'Full source of the artifact' },
        language: { type: 'string', description: 'For type=code (e.g. "python")' },
      },
      required: ['id', 'type', 'title', 'content'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async (
      { id, type, title, content, language },
      { upsertArtifact }
    ) => {
      if (!upsertArtifact) throw new Error('当前上下文不支持创建工件');
      upsertArtifact({
        id: String(id),
        type: String(type),
        title: String(title),
        content: String(content),
        language: typeof language === 'string' ? language : undefined,
      });
      return `已创建工件「${title}」(id=${id})。用户可在右侧工件面板查看。`;
    },
  },

  // ----- exit_plan_mode --------------------------------------------------
  // Plan-mode terminator. The agent calls this with a markdown plan; the
  // UI shows it for approval, and the result text is fed back so the
  // agent can either proceed (approval unlocks destructive tools for
  // this turn) or revise (feedback) or stop (reject).
  //
  // Mode: `code` only — Plan mode is a Code-mode workflow. In Chat /
  // Design there's nothing destructive to gate, so the tool would be
  // pure overhead.
  {
    name: 'exit_plan_mode',
    description:
      '提交一份完整的执行计划给用户审批。**只有当用户启用了 Plan 模式时才需要调用**——平时不要主动用。' +
      '调用前请先用只读工具（fs_list_dir / fs_read_file / fs_stat / web_fetch / shell_read）充分了解上下文，' +
      '然后把计划写成 markdown：每一步具体到要改哪些文件 / 跑什么命令 / 预期结果。' +
      '调用此工具后会暂停等待用户批准；批准后才能使用 fs_write_file / shell_exec 等副作用工具。',
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description:
            '完整的 markdown 计划。结构建议：## 目标 / ## 步骤 / ## 风险 / ## 验证标准。' +
            '不要把读到的源码贴在这里——只写「读了 X、发现 Y、所以打算做 Z」。',
        },
      },
      required: ['plan'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ plan }, { requestPlanApproval }) => {
      if (!requestPlanApproval) {
        // Reachable when the user hasn't enabled Plan mode for this turn.
        // We deliberately fail soft so the agent gets useful feedback and
        // continues the turn instead of dying.
        throw new Error(
          'Plan 模式未启用：用户没有为本轮开启 Plan。直接执行任务即可，不要再调用 exit_plan_mode。',
        );
      }
      if (typeof plan !== 'string' || !plan.trim()) {
        throw new Error('plan 必须是非空字符串。');
      }
      const result = await requestPlanApproval(plan);
      if (result.kind === 'approved') {
        return '✅ 用户已批准计划。可以开始执行——副作用工具（fs_write_file / shell_exec / shell_start 等）现已解锁。';
      }
      if (result.kind === 'feedback') {
        return (
          '🔄 用户希望调整计划。反馈如下：\n\n' +
          result.feedback +
          '\n\n请按反馈修改计划后**重新调用 exit_plan_mode** 提交新版本。副作用工具仍然锁定。'
        );
      }
      return (
        '❌ 用户拒绝了这份计划' +
        (result.reason ? `：${result.reason}` : '。') +
        '\n请在不调用副作用工具的前提下，根据用户接下来的输入继续。'
      );
    },
  },

  // ----- spawn_subtask ---------------------------------------------------
  // Delegate a focused chunk of work to a fresh Code-mode subagent. The
  // subagent runs to completion in its own conversation and returns ONLY
  // its final text — the parent doesn't see the subagent's tool calls,
  // tool results, or intermediate prose. The whole point is token
  // efficiency: a 30-tool-call investigation collapses into one summary.
  //
  // Mode: `code` only. Subagents share the parent's workspace, model,
  // skills, and globalMemory. They cannot spawn their own subagents (we
  // strip spawn_subtask from the subagent's toolset to prevent fork
  // bombs in v1).
  {
    name: 'spawn_subtask',
    description:
      '把一段独立的、产出可总结的工作外包给一个子 agent。子 agent 在隔离的对话里跑工具循环（最多 15 轮），结束时返回一段总结给你。' +
      '\n\n**适合用**：搜索/调研类（"找出所有 fetch 调用"）、独立验证（"跑测试看是否还有 fail"）、批量小修复（"把 src/ 里的 console.log 都加 TODO 注释"）。' +
      '\n**不适合用**：单工具就能干完的事（直接调工具）、需要持续与用户沟通的任务（让父对话处理）、与父对话强耦合需要看上下文的任务（你直接做）。' +
      '\n\n子 agent 不会看到你的对话历史，只看到 prompt 和你传的 context。子 agent 不能再开子 agent。',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            '子任务的简短标题（10-30 字），会显示在用户的 sidebar 里。例如「找所有 fetch 调用」「重新跑一遍测试」。',
        },
        prompt: {
          type: 'string',
          description:
            '给子 agent 的完整任务说明。要自包含——子 agent 看不到父对话的任何历史。说清楚：要做什么 / 范围（哪些目录） / 返回什么格式（列表？摘要？文件清单？）。',
        },
        context: {
          type: 'string',
          description:
            '可选。从父对话往下传的上下文片段（项目用什么语言、用户的偏好、已经知道的事实等）。保持简短——会拼到子 agent 的第一条消息里，等于子 agent 每次思考都要带着它。',
        },
      },
      required: ['title', 'prompt'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ title, prompt, context }, { spawnSubtask }) => {
      if (!spawnSubtask) {
        throw new Error(
          'spawn_subtask 在当前上下文不可用（缺少 spawnSubtask 钩子）。',
        );
      }
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('prompt 必须是非空字符串。');
      }
      const safeTitle = typeof title === 'string' && title.trim() ? title.trim() : '子任务';
      const safeContext =
        typeof context === 'string' && context.trim() ? context.trim() : undefined;
      const result = await spawnSubtask({
        title: safeTitle,
        prompt,
        context: safeContext,
      });
      // Hand back the subagent's final text plus a sidebar pointer so the
      // parent's model can mention "see subtask #abc123" if helpful.
      const truncationNote = result.truncated
        ? '\n\n[注意：子任务达到 15 轮工具上限，没有自然结束。上面是它最后一段文字。]'
        : '';
      return (
        `🌿 子任务「${safeTitle}」完成（id=${result.subConversationId.slice(-6)}）：\n\n` +
        result.finalText +
        truncationNote
      );
    },
  },

  // --- read_skill_asset --------------------------------------------------
  // Reads a file bundled with an installed Skill. Real-world Claude
  // Skills are folders (SKILL.md + templates/ + scripts/ + config/) and
  // the SKILL.md body usually quotes paths relative to that folder
  // ("see templates/alert.md"). v0.1.44 ships those auxiliary files at
  // install time, and this tool exposes them to the agent on demand.
  //
  // Why on-demand instead of stuffing every asset into the system
  // prompt: a "monitor healthcare companies" skill might bundle 20
  // template files, only 1-2 of which apply to any given user request.
  // Inlining all 20 burns ~20K tokens for nothing. The system prompt
  // lists asset paths + sizes (manifest only); the agent reads the
  // ones it needs.
  {
    name: 'read_skill_asset',
    description:
      '读取已安装 Skill 的捆绑文件（templates/scripts/config 等）。' +
      '当 SKILL.md 引用某个相对路径（如 "templates/alert.md"）、' +
      '而你需要看那个文件的内容时调用。文件已在安装时下载到本机，' +
      '不会发起网络请求。可用的 skill 名称和 asset 路径在系统提示的 Skill 清单里列出。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'Skill 的 `name` 字段（不是 title），如 "healthcare-monitor"',
        },
        asset_path: {
          type: 'string',
          description:
            '相对 skill 根目录的路径，如 "templates/alert.md" 或 "config/settings.json"',
        },
      },
      required: ['skill_name', 'asset_path'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ skill_name, asset_path }, { readSkillAsset }) => {
      if (!readSkillAsset) {
        throw new Error(
          'read_skill_asset 在当前上下文不可用（缺少 readSkillAsset 钩子）。',
        );
      }
      if (typeof skill_name !== 'string' || !skill_name.trim()) {
        throw new Error('skill_name 必须是非空字符串。');
      }
      if (typeof asset_path !== 'string' || !asset_path.trim()) {
        throw new Error('asset_path 必须是非空字符串。');
      }
      // Normalize path: strip a leading slash, collapse `./`, reject `..`
      // segments. Defense in depth even though all the asset paths come
      // from a server-controlled bundle — a future "user adds custom
      // assets" feature would inherit the same guard.
      const cleaned = asset_path.replace(/^\/+/, '').replace(/^\.\/+/, '');
      if (cleaned.split('/').some((seg) => seg === '..')) {
        throw new Error('asset_path 不能包含 ".." 段。');
      }
      const result = readSkillAsset({
        skillName: skill_name.trim(),
        assetPath: cleaned,
      });
      if (!result) {
        throw new Error(
          `找不到 skill「${skill_name}」中的资产「${cleaned}」。` +
            '检查 skill 是否已安装、路径是否拼写正确，或在系统提示的 Skill 清单里看可用路径。',
        );
      }
      // Prepend a one-line header so the agent knows it's looking at
      // a specific file (helps with multi-asset reasoning).
      return `=== ${cleaned} (${result.size} bytes) ===\n${result.content}`;
    },
  },

  // --- image_generate ----------------------------------------------------
  // Real image generation via PPIO GPT Image 2. Available in Chat +
  // Design modes; the Design system prompt explicitly mentions when to
  // prefer this over writing HTML/SVG/Mermaid.
  //
  // Wire: client tool calls Worker `/tools/image_generate` (proxy with
  // shared PPIO key). Worker validates + forwards + returns
  // `{prompt, urls, model, size, quality, n}`.
  //
  // Tool result text: a short summary plus markdown image references.
  // The handler ALSO upserts each URL as an `image` artifact via
  // ctx.upsertArtifact, so they show in the artifacts side panel +
  // become downloadable. Doing both — inline mention + artifact entry —
  // mirrors how `create_artifact` works for HTML/SVG.
  {
    name: 'image_generate',
    description:
      '生成真实的 raster 图像（PNG/JPEG，由 GPT Image 2 模型生成）。' +
      '当用户要求"画一张图""做个 logo""生成插图""设计一张照片"等需要 *像素图像* 而非 *矢量代码* 的请求时调用。' +
      '当用户要求 UI 原型 / 流程图 / 图标矢量时不要用此工具——写 HTML/SVG/Mermaid 代码更合适。' +
      '调用后 Flaude 会自动把图片放进右侧 artifacts 面板，用户可以下载或分享。' +
      // v0.1.59: 加超时 + 尺寸引导。Cloudflare Workers subrequest cap ~100s 是硬上限，' +
      // 1536x1024 / 1024x1536 高分辨率经常超过这个，导致 image_generate timed out。' +
      // 1024x1024 + medium quality 是最稳的组合。
      '【重要】1024x1024 是最稳定的尺寸，几乎都能在 ~60s 内完成；1536x1024 / 1024x1536 在复杂中文 prompt 上经常超过 100s 触发 timed out——除非用户明确要竖版/横版，否则就用默认 1024x1024。' +
      '【超时兜底】如果上一次调用 image_generate timed out，**不要重试同样的参数**（再次超时概率高）；要么换更小的 size + low quality，要么直接告诉用户图片服务暂时不稳定并继续后续工作（写占位图、HTML 排版等）。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '描述要生成的图像。中英文均可。详细的视觉描述（光照、风格、构图）效果更好。最长 32000 字符。',
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
          description:
            '图片尺寸：**默认且推荐 1024x1024**（最稳，几乎不超时）/ 1024x1536 竖版（偶尔超时）/ 1536x1024 横版（偶尔超时）/ auto 由模型决定。除非用户明确要某个特定方向，否则用 1024x1024。',
        },
        quality: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description:
            '生成质量。low 最快最便宜（约 $0.011/张），medium 平衡（默认，约 $0.042/张），high 最佳但慢一倍多容易超时（约 $0.167/张）。',
        },
        n: {
          type: 'number',
          description: '生成几张（1-4，默认 1）',
        },
      },
      required: ['prompt'],
    },
    source: 'builtin',
    modes: ['chat', 'design'],
    handler: async ({ prompt, size, quality, n }, { upsertArtifact }) => {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('prompt 必须是非空字符串');
      }
      // Read the user's chosen image-gen model from the store. v0.1.48
      // ships only `gpt-image-2` but the Worker accepts the model id
      // future-compatibly.
      const { useAppStore } = await import('@/store/useAppStore');
      const modelId = useAppStore.getState().designImageGenModelId;

      // Lazy-import authFetch — same circular-dep avoidance as the
      // other tools that hit the Worker (see toolsForMode comments).
      const { authFetch } = await import('./flaudeApi');

      const reqBody: Record<string, unknown> = { prompt: prompt.trim(), model: modelId };
      if (typeof size === 'string') reqBody.size = size;
      if (typeof quality === 'string') reqBody.quality = quality;
      if (typeof n === 'number' && n > 0) reqBody.n = Math.min(4, Math.floor(n));

      // v0.1.59: PPIO GPT Image 2 偶发卡到 100s+ 触发 Cloudflare subrequest cap →
      // Worker 502 + "image_generate timed out"。同 prompt 第二次往往就过（PPIO
      // 内部排队 / cold start 抖动）。所以做一次 transparent retry，timed-out 只
      // 退一次，其它错误（quota / 认证 / 内容审核）直接抛不重试以避免双倍计费。
      type ImageGenBody = {
        urls?: string[];
        prompt?: string;
        model?: string;
        size?: string;
        quality?: string;
        error?: string;
        detail?: string;
      };
      type CallResult =
        | { kind: 'response'; res: Response; body: ImageGenBody | null }
        | { kind: 'fetch_error'; error: string };
      const callOnce = async (): Promise<CallResult> => {
        try {
          const r = await authFetch('/tools/image_generate', {
            method: 'POST',
            body: JSON.stringify(reqBody),
          });
          const b = (await r.json().catch(() => null)) as ImageGenBody | null;
          return { kind: 'response', res: r, body: b };
        } catch (err) {
          // v0.1.60: Tauri WebView2 / browser fetch can throw `TypeError:
          // Failed to fetch` for a grab-bag of transport-layer reasons —
          // connection reset, TLS handshake aborted, WebView2's internal
          // connection pool getting confused after several long-lived
          // requests, etc. Pre-v0.1.60 this propagated up as the raw error
          // (user saw "工具错误: Failed to fetch") with no retry, even
          // though it's almost always a one-off the next call recovers
          // from. Treat it like a transient timeout: classify, retry once.
          return { kind: 'fetch_error', error: (err as Error).message ?? 'fetch failed' };
        }
      };

      const isTransient = (r: CallResult): boolean => {
        if (r.kind === 'fetch_error') return true;
        // Worker maps PPIO timeout AbortError to 502 + 'timed out'.
        return (
          r.res.status === 502 &&
          typeof r.body?.error === 'string' &&
          r.body.error.includes('timed out')
        );
      };

      let result = await callOnce();
      const firstWasTransient = isTransient(result);
      if (firstWasTransient) {
        // Single retry, no backoff. Permanent errors (4xx auth, quota,
        // content moderation, etc.) skip retry to avoid double-billing.
        result = await callOnce();
      }

      // If the second attempt also threw at the fetch layer, surface a
      // descriptive message so the model can do a smart fallback (placeholder
      // image, alternate phrasing, etc.) instead of the bare 'Failed to fetch'.
      if (result.kind === 'fetch_error') {
        const hint = firstWasTransient
          ? '（已自动重试 1 次仍 fetch 失败；可能是网络瞬断或 WebView 连接池抽风，建议告诉用户暂时改用占位图，下一轮再试）'
          : '（建议用占位图先把版面排出来，等用户重发再试图片）';
        throw new Error(`image_generate 失败：${result.error}${hint}`);
      }

      const { res, body } = result;
      if (!res.ok || !body || body.error) {
        const detail = body?.detail ? ` (${body.detail.slice(0, 200)})` : '';
        const retryHint = firstWasTransient
          ? '（已自动重试 1 次仍失败；建议换 1024x1024 + low quality 再试，或继续用占位图先把版面排出来）'
          : '';
        throw new Error(
          `image_generate 失败：${body?.error ?? `HTTP ${res.status}`}${detail}${retryHint}`,
        );
      }
      const urls = body.urls ?? [];
      if (urls.length === 0) {
        throw new Error('image_generate 没返回任何图片');
      }

      // Promote each URL to an `image` artifact so the side panel
      // renders it. Title uses a short slice of the prompt so users
      // can tell artifacts apart in the picker.
      //
      // v0.1.53: skip the promotion in Design mode. The DesignCanvas
      // already shows the rendered HTML (which embeds the image inline),
      // and the artifacts panel is hidden in Design mode anyway —
      // duplicating the image as a standalone artifact just clutters
      // the conversation's artifact list with thumbnails the user
      // doesn't see and can't click. Chat / Code modes still get the
      // promotion since their right pane IS the artifacts panel.
      const titleBase = prompt.trim().slice(0, 30);
      const activeMode = useAppStore.getState().activeMode;
      const promoteToArtifacts = upsertArtifact && activeMode !== 'design';
      if (promoteToArtifacts) {
        urls.forEach((url, i) => {
          const id = uid('img');
          upsertArtifact!({
            id,
            type: 'image',
            title: urls.length > 1 ? `${titleBase}…(${i + 1})` : titleBase,
            content: url,
          });
        });
      }

      // Tool result text — markdown image syntax so the chat bubble
      // also renders the image inline (the markdown renderer already
      // handles `![](url)`). The trailing hint changes per mode: in
      // Chat/Code we point at the artifacts panel; in Design we point
      // at the canvas (which is where the embedded image will render
      // once the next assistant turn writes the HTML).
      const lines = [
        `生成了 ${urls.length} 张图片（${body.size ?? 'auto'} · ${body.quality ?? 'medium'} 质量）：`,
        '',
        ...urls.map((url, i) => `![${titleBase} ${i + 1}](${url})`),
        '',
        promoteToArtifacts
          ? '右侧 artifacts 面板可以查看、下载、或继续生成变体。'
          : '可以把这些 URL 嵌入到 HTML 设计稿里（`<img src="..." />`），右侧画布会渲染。',
      ];
      return lines.join('\n');
    },
  },
];

// Register built-ins once at module load.
for (const t of BUILTIN_TOOLS) registerTool(t);

/** Expose built-in names so UI can list them. */
export const BUILTIN_TOOL_NAMES = BUILTIN_TOOLS.map((t) => t.name);
