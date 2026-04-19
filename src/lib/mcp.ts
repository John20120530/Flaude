/**
 * Browser-side Model Context Protocol (MCP) client.
 *
 * Uses the "Streamable HTTP" transport (spec: 2025-06-18):
 *   - Client POSTs a JSON-RPC request to a single endpoint.
 *   - Server responds with either application/json (single response) or
 *     text/event-stream (one or more responses over SSE).
 *
 * Tools discovered on a connected server are auto-registered into the global
 * tool registry under source='mcp' with `serverId` set, so the streaming loop
 * and settings UI can treat them uniformly with built-ins.
 *
 * CORS caveat: browsers can only reach MCP servers that send
 * Access-Control-Allow-Origin headers. For stdio-only servers users need to
 * run a local bridge (e.g. mcp-proxy, mcpo) exposing HTTP with CORS enabled.
 */

import { registerTool, unregisterBySource } from './tools';

interface MCPToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface MCPContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

interface MCPCallResult {
  content: MCPContentBlock[];
  isError?: boolean;
}

export class MCPClient {
  private nextId = 0;
  private initialized = false;
  private sessionId?: string; // For servers that require Mcp-Session-Id

  constructor(
    private readonly url: string,
    private readonly token?: string
  ) {}

  private headers(): HeadersInit {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  /** JSON-RPC request that expects a matching response. */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const id = ++this.nextId;
    const body = { jsonrpc: '2.0', id, method, params };

    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP HTTP ${res.status}: ${text || res.statusText}`);
    }

    // Capture session id if the server assigned one during initialize.
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid && !this.sessionId) this.sessionId = sid;

    const ct = res.headers.get('Content-Type') ?? '';
    if (ct.includes('text/event-stream')) {
      return this.readSSEResponse<T>(res, id, signal);
    }
    const json = await res.json();
    if (json.error) {
      throw new Error(`${json.error.message ?? 'RPC error'} (${json.error.code ?? '?'})`);
    }
    return json.result as T;
  }

  /** Drain SSE messages until we find the response with our request id. */
  private async readSSEResponse<T>(
    res: Response,
    expectedId: number,
    signal?: AbortSignal
  ): Promise<T> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('MCP 流响应无 body');
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) throw new Error('MCP SSE 关闭但未收到响应');
        buffer += decoder.decode(value, { stream: true });

        // SSE events end with \n\n
        let splitIdx: number;
        while ((splitIdx = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, splitIdx);
          buffer = buffer.slice(splitIdx + 2);
          const dataLine = event
            .split('\n')
            .find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;

          let parsed: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (parsed.id !== expectedId) continue;
          if (parsed.error) {
            throw new Error(
              `${parsed.error.message ?? 'RPC error'} (${parsed.error.code ?? '?'})`
            );
          }
          return parsed.result as T;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
  }

  async initialize() {
    const result = await this.request<{
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo?: { name: string; version: string };
    }>('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'Flaude', version: '0.1' },
    });
    // MCP requires a post-initialize notification.
    await this.notify('notifications/initialized');
    this.initialized = true;
    return result;
  }

  /** JSON-RPC notification (no response expected). Fire-and-forget. */
  private async notify(method: string, params?: unknown) {
    await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => {
      /* notifications can be silently dropped */
    });
  }

  async listTools(signal?: AbortSignal): Promise<MCPToolInfo[]> {
    if (!this.initialized) await this.initialize();
    const result = await this.request<{ tools: MCPToolInfo[] }>(
      'tools/list',
      undefined,
      signal
    );
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<MCPCallResult> {
    if (!this.initialized) await this.initialize();
    return this.request<MCPCallResult>(
      'tools/call',
      { name, arguments: args },
      signal
    );
  }
}

// ---------------------------------------------------------------------------
// High-level connect/disconnect — wires MCP tools into the shared registry.
// ---------------------------------------------------------------------------

export interface ConnectResult {
  serverInfo?: { name: string; version: string };
  tools: MCPToolInfo[];
}

/** Sanitize a tool name to satisfy the OpenAI function-name regex. */
function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export async function connectMCPServer(
  serverId: string,
  url: string,
  token?: string
): Promise<ConnectResult> {
  const client = new MCPClient(url, token);
  const initRes = await client.initialize();
  const tools = await client.listTools();

  // Register each remote tool as a local tool.
  for (const t of tools) {
    const localName = `mcp__${safeName(serverId)}__${safeName(t.name)}`;
    registerTool({
      name: localName,
      description: t.description ? `[MCP] ${t.description}` : `[MCP] ${t.name}`,
      parameters:
        (t.inputSchema as Record<string, unknown>) ||
        { type: 'object', properties: {} },
      source: 'mcp',
      serverId,
      modes: ['code'],
      handler: async (args, { signal }) => {
        const result = await client.callTool(t.name, args, signal);
        const textBlocks = (result.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '');
        const out = textBlocks.join('\n').trim();
        if (result.isError) {
          throw new Error(out || 'MCP 工具调用失败');
        }
        return out || '(MCP 工具返回空结果)';
      },
    });
  }

  return {
    serverInfo: initRes.serverInfo,
    tools,
  };
}

export function disconnectMCPServer(serverId: string) {
  unregisterBySource('mcp', serverId);
}
