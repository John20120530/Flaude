/**
 * Browser-side Model Context Protocol (MCP) client.
 *
 * Speaks JSON-RPC 2.0 over a pluggable transport. Two transports today:
 *
 *   - **HTTP** (`HttpTransport`) — the "Streamable HTTP" spec (2025-06-18):
 *     POST a JSON-RPC request to one endpoint, get back either application/
 *     json (single response) or text/event-stream (one or more responses
 *     over SSE). Works in plain browsers and in Tauri.
 *   - **Stdio** (`StdioTransport`) — newline-delimited JSON over a child
 *     process's stdin/stdout. Tauri-only; the host module
 *     `src-tauri/src/mcp_stdio.rs` spawns the child and exposes
 *     `mcp_stdio_send` / `mcp_stdio_recv` IPC commands. This is how
 *     marketplace one-click install for stdio MCPs (filesystem, github,
 *     postgres, slack, memory, ...) actually works on desktop.
 *
 * Tools discovered on a connected server are auto-registered into the
 * global tool registry under source='mcp' with `serverId` set, so the
 * streaming loop and Settings UI treat them uniformly with built-ins.
 *
 * Browser CORS caveat: HTTP MCPs only work if the server sends
 * Access-Control-Allow-Origin. Tauri webviews bypass CORS. Stdio MCPs are
 * desktop-only by design.
 */

import { registerTool, unregisterBySource } from './tools';
import { isTauri, tauriInvoke } from './tauri';

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

// ---------------------------------------------------------------------------
// Transport interface — what MCPClient needs from the wire layer.
// ---------------------------------------------------------------------------

/**
 * Send a JSON-RPC request and receive the matching response.
 *
 * The transport is responsible for correlating concurrent requests by id
 * (each request payload gets a fresh integer id). Returns the parsed JSON
 * result on success; throws Error with a useful message on transport or
 * RPC failure.
 */
export interface MCPTransport {
  request<T = unknown>(
    method: string,
    params: unknown | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T>;

  /** Fire-and-forget JSON-RPC notification (server expects no reply). */
  notify(method: string, params?: unknown): Promise<void>;

  /** Release any resources the transport holds (long-poll loops, etc.). */
  close(): void;
}

// ---------------------------------------------------------------------------
// HTTP transport — Streamable HTTP spec 2025-06-18.
// ---------------------------------------------------------------------------

class HttpTransport implements MCPTransport {
  private nextId = 0;
  private sessionId?: string;

  constructor(
    private readonly url: string,
    private readonly token?: string,
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

  async request<T = unknown>(
    method: string,
    params: unknown | undefined,
    signal: AbortSignal | undefined,
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

    const sid = res.headers.get('Mcp-Session-Id');
    if (sid && !this.sessionId) this.sessionId = sid;

    const ct = res.headers.get('Content-Type') ?? '';
    if (ct.includes('text/event-stream')) {
      return this.readSSEResponse<T>(res, id, signal);
    }
    const json = await res.json();
    if (json.error) {
      throw new Error(
        `${json.error.message ?? 'RPC error'} (${json.error.code ?? '?'})`,
      );
    }
    return json.result as T;
  }

  private async readSSEResponse<T>(
    res: Response,
    expectedId: number,
    signal?: AbortSignal,
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

          let parsed: {
            id?: number;
            result?: unknown;
            error?: { message?: string; code?: number };
          };
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (parsed.id !== expectedId) continue;
          if (parsed.error) {
            throw new Error(
              `${parsed.error.message ?? 'RPC error'} (${parsed.error.code ?? '?'})`,
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

  async notify(method: string, params?: unknown): Promise<void> {
    await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    }).catch(() => {
      /* notifications can be silently dropped */
    });
  }

  close(): void {
    /* no resources held */
  }
}

// ---------------------------------------------------------------------------
// Stdio transport — newline-delimited JSON over a Tauri-spawned child.
// ---------------------------------------------------------------------------
//
// The Rust side (`mcp_stdio.rs`) hands us a session id when we ask it to
// spawn. We then write requests via `mcp_stdio_send` and long-poll via
// `mcp_stdio_recv` to receive *all* messages from the server (responses to
// our requests, plus any unsolicited notifications). A single recv loop
// dispatches each message to the appropriate pending-request resolver
// (matching by JSON-RPC id) or — if no match — drops it on the floor (we
// don't have a notification handler yet; the day a server actually sends
// useful unsolicited notifications we can wire one).
//
// Concurrency: the recv loop is started lazily on first request and runs
// until `close()`. An in-flight `request()` registers a pending resolver
// keyed by id and awaits a Promise the loop will resolve. If the child
// dies, pending resolvers reject with a clear error.

interface PendingResolver {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface StdioRecvResult {
  messages: string[];
  running: boolean;
  code: number | null;
  killed: boolean;
  /** Snake-case from Rust serde — kept verbatim. */
  dropped_messages: number;
  stderr: string;
}

/**
 * Pluggable I/O for the stdio transport. Production wires this to Tauri
 * `invoke('mcp_stdio_send' / 'mcp_stdio_recv', ...)`; tests inject a fake.
 */
export interface StdioIO {
  send(message: string): Promise<void>;
  /** Long-poll. Resolves with whatever's available within `waitMs`. */
  recv(waitMs: number): Promise<StdioRecvResult>;
}

/** Production IO that talks to the Tauri host. */
function tauriStdioIO(sessionId: string): StdioIO {
  return {
    send: (message) =>
      tauriInvoke<void>('mcp_stdio_send', { id: sessionId, message }),
    recv: (waitMs) =>
      tauriInvoke<StdioRecvResult>('mcp_stdio_recv', {
        id: sessionId,
        waitMs,
      }),
  };
}

export class StdioTransport implements MCPTransport {
  private nextId = 0;
  private pending = new Map<number, PendingResolver>();
  private recvLoopRunning = false;
  private closed = false;

  /** Buffered stderr text — exposed so the UI can show why a server died. */
  public stderrLog = '';

  /**
   * Visible for tests; production callers should use the
   * `createStdioTransport(sessionId)` helper.
   */
  constructor(private readonly io: StdioIO) {}

  /** Lazily kick off the recv loop. Idempotent. */
  private startRecvLoop(): void {
    if (this.recvLoopRunning || this.closed) return;
    this.recvLoopRunning = true;
    void this.recvLoop();
  }

  private async recvLoop(): Promise<void> {
    while (!this.closed) {
      let result: StdioRecvResult;
      try {
        result = await this.io.recv(30_000);
      } catch (e) {
        // IPC failure usually means the host shut down or the session is
        // gone. Reject everything pending and stop.
        this.failAllPending(
          new Error(`MCP stdio recv 失败: ${(e as Error).message}`),
        );
        this.recvLoopRunning = false;
        return;
      }

      if (result.stderr) this.stderrLog += result.stderr;

      for (const raw of result.messages) {
        this.dispatchMessage(raw);
      }

      if (!result.running) {
        this.failAllPending(
          new Error(
            `MCP stdio 进程已退出 (code=${result.code ?? '?'}${result.killed ? ', killed' : ''})`,
          ),
        );
        this.recvLoopRunning = false;
        return;
      }
    }
  }

  /**
   * Visible for tests. Dispatch one raw message: parse, look up pending
   * resolver by id, fire it (or drop on the floor if unmatched).
   */
  dispatchMessage(raw: string): void {
    let parsed: {
      id?: number;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // non-JSON line — server should not emit these on stdout
    }
    if (typeof parsed.id !== 'number') return; // unsolicited notification
    const resolver = this.pending.get(parsed.id);
    if (!resolver) return; // late response; nothing waiting
    this.pending.delete(parsed.id);
    if (parsed.error) {
      resolver.reject(
        new Error(
          `${parsed.error.message ?? 'RPC error'} (${parsed.error.code ?? '?'})`,
        ),
      );
    } else {
      resolver.resolve(parsed.result);
    }
  }

  private failAllPending(err: Error): void {
    for (const r of this.pending.values()) r.reject(err);
    this.pending.clear();
  }

  /** Visible for tests — reveal how many requests are still in-flight. */
  pendingCount(): number {
    return this.pending.size;
  }

  async request<T = unknown>(
    method: string,
    params: unknown | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (this.closed) throw new Error('MCP stdio transport 已关闭');
    this.startRecvLoop();

    const id = ++this.nextId;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      if (signal) {
        const onAbort = () => {
          if (this.pending.delete(id)) {
            reject(new DOMException('Aborted', 'AbortError'));
          }
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });

    try {
      await this.io.send(message);
    } catch (e) {
      this.pending.delete(id);
      throw new Error(`MCP stdio send 失败: ${(e as Error).message}`);
    }

    return promise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return;
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    await this.io.send(message).catch(() => {
      /* notifications are best-effort */
    });
  }

  close(): void {
    this.closed = true;
    this.failAllPending(new Error('MCP stdio transport 关闭'));
  }
}

/** Build a StdioTransport wired to the Tauri host. */
export function createStdioTransport(sessionId: string): StdioTransport {
  return new StdioTransport(tauriStdioIO(sessionId));
}

// ---------------------------------------------------------------------------
// Protocol layer — initialize / tools/list / tools/call.
// ---------------------------------------------------------------------------

export class MCPClient {
  private initialized = false;

  constructor(private readonly transport: MCPTransport) {}

  async initialize() {
    const result = await this.transport.request<{
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo?: { name: string; version: string };
    }>(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'Flaude', version: '0.1' },
      },
      undefined,
    );
    await this.transport.notify('notifications/initialized');
    this.initialized = true;
    return result;
  }

  async listTools(signal?: AbortSignal): Promise<MCPToolInfo[]> {
    if (!this.initialized) await this.initialize();
    const result = await this.transport.request<{ tools: MCPToolInfo[] }>(
      'tools/list',
      undefined,
      signal,
    );
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPCallResult> {
    if (!this.initialized) await this.initialize();
    return this.transport.request<MCPCallResult>(
      'tools/call',
      { name, arguments: args },
      signal,
    );
  }

  close(): void {
    this.transport.close();
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

/**
 * Stdio MCP session ids are issued by `mcp_stdio_spawn`. We keep them in a
 * module-local map keyed by `serverId` so `disconnectMCPServer` can find the
 * right child to kill, and so the lifecycle helpers below can re-use a
 * spawned session across reconnects.
 */
const stdioSessions = new Map<string, string>();

/** Record a stdio session id against a Flaude serverId. */
export function rememberStdioSession(serverId: string, sessionId: string): void {
  stdioSessions.set(serverId, sessionId);
}

/** Look up the stdio session id for a serverId, or undefined. */
export function getStdioSession(serverId: string): string | undefined {
  return stdioSessions.get(serverId);
}

/** Forget a stdio session — caller must have killed the child first. */
export function forgetStdioSession(serverId: string): void {
  stdioSessions.delete(serverId);
}

/**
 * Spawn a stdio MCP child via the Tauri host. Caller is responsible for
 * later calling `mcp_stdio_kill` (via `disconnectMCPServer`) to clean up.
 *
 * Throws if not running in Tauri.
 */
export async function spawnStdioMCP(args: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<string> {
  if (!isTauri()) {
    throw new Error('stdio MCP 仅在桌面版可用');
  }
  const result = await tauriInvoke<{ id: string }>('mcp_stdio_spawn', {
    args,
  });
  return result.id;
}

/** Kill a previously-spawned stdio MCP. No-op if the id is unknown. */
export async function killStdioMCP(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('mcp_stdio_kill', { id: sessionId }).catch(() => {
    /* already dead — fine */
  });
}

/**
 * Connect via HTTP. Caller provides URL + optional bearer token; we
 * register every tool the server reports.
 */
export async function connectMCPServer(
  serverId: string,
  url: string,
  token?: string,
): Promise<ConnectResult> {
  const transport = new HttpTransport(url, token);
  return connectMCPClient(serverId, new MCPClient(transport));
}

/**
 * Connect via stdio. Caller has already spawned (or asked us to remember)
 * the session via `spawnStdioMCP` + `rememberStdioSession`.
 */
export async function connectStdioMCPServer(
  serverId: string,
  sessionId: string,
): Promise<ConnectResult> {
  const transport = createStdioTransport(sessionId);
  return connectMCPClient(serverId, new MCPClient(transport));
}

/** Common path: initialize, list tools, register them. */
async function connectMCPClient(
  serverId: string,
  client: MCPClient,
): Promise<ConnectResult> {
  const initRes = await client.initialize();
  const tools = await client.listTools();

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
