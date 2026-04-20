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

import type { AgentTodo, WorkMode } from '@/types';
import type { ToolSpec } from '@/services/providerClient';
import { FlaudeApiError, webSearch } from '@/lib/flaudeApi';
import { useAppStore } from '@/store/useAppStore';

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
}

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
    // Claude Code's "TodoWrite" dressed up for Flaude. The Code agent
    // publishes its whole task breakdown on every call; we store it in
    // `agentTodos[conversationId]` for UIs that want a pinned view, and we
    // also embed the list in the tool result so ToolCallCard renders the
    // snapshot inline in-conversation (mirrors Claude Code's transcript
    // affordance exactly).
    //
    // Why expose this as a tool rather than, say, <todo> tags? Tools are
    // structured JSON the agent is already trained to produce reliably;
    // tags would leak into prose and regress with every model swap.
    name: 'todo_write',
    description:
      'Publish or update your task list for this conversation. Call this when ' +
      'starting a non-trivial task (3+ steps) to plan, and again each time a ' +
      'step completes or a new one is discovered. Always pass the FULL list — ' +
      'this replaces the previous snapshot entirely. Mark exactly one task as ' +
      'in_progress at a time. Include both an imperative `content` and a ' +
      'present-continuous `activeForm` per item.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete current task list. Empty array clears it.',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'Imperative description, e.g. "Run tests".',
              },
              activeForm: {
                type: 'string',
                description: 'Present-continuous, e.g. "Running tests".',
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
    handler: async ({ todos }, { conversationId }) => {
      if (!Array.isArray(todos)) {
        throw new Error('todos 必须是数组');
      }
      const normalized: AgentTodo[] = [];
      for (let i = 0; i < todos.length; i++) {
        const raw = todos[i] as Record<string, unknown>;
        if (!raw || typeof raw !== 'object') {
          throw new Error(`todos[${i}] 不是对象`);
        }
        const content = typeof raw.content === 'string' ? raw.content.trim() : '';
        const activeForm =
          typeof raw.activeForm === 'string' ? raw.activeForm.trim() : '';
        const status = raw.status;
        if (!content) throw new Error(`todos[${i}].content 为空`);
        if (!activeForm) throw new Error(`todos[${i}].activeForm 为空`);
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
          throw new Error(
            `todos[${i}].status 非法（需 pending / in_progress / completed）`
          );
        }
        normalized.push({ content, activeForm, status });
      }
      // At most one in_progress at a time — mirrors Claude Code's rule and
      // stops the model from "parallel-claiming" every item.
      const inProgressCount = normalized.filter((t) => t.status === 'in_progress').length;
      if (inProgressCount > 1) {
        throw new Error('只能有一个任务处于 in_progress 状态');
      }

      useAppStore.getState().setAgentTodos(conversationId, normalized);

      if (normalized.length === 0) return '任务列表已清空。';
      const summary = normalized
        .map((t) => {
          const mark =
            t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
          const label = t.status === 'in_progress' ? t.activeForm : t.content;
          return `${mark} ${label}`;
        })
        .join('\n');
      return `已更新任务列表（${normalized.length} 项）：\n${summary}`;
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
];

// Register built-ins once at module load.
for (const t of BUILTIN_TOOLS) registerTool(t);

/** Expose built-in names so UI can list them. */
export const BUILTIN_TOOL_NAMES = BUILTIN_TOOLS.map((t) => t.name);
