/**
 * Minimal MCP HTTP server: the "Echo demo" exposed at `/mcp/echo`.
 *
 * Why this exists: the v0.1.37 MCP marketplace shipped an "Echo demo
 * (Flaude hosted)" card pointing at `https://api.flaude.net/mcp/echo`.
 * The card was real but the endpoint was vapor — I wired the marketplace
 * UI flow (one-click install of an HTTP MCP) before actually implementing
 * the upstream MCP server. This file is the long-overdue server side.
 *
 * Implementation: the absolute minimum that satisfies the MCP "Streamable
 * HTTP" transport spec (2025-06-18) — single endpoint, JSON-RPC, single
 * tool. Public (no auth) on purpose: the whole point is "click install,
 * confirm the chain works end-to-end with zero credentials".
 *
 * Wire shape (what the Flaude MCP client expects):
 *   Request:  POST /mcp/echo   body: JSON-RPC 2.0
 *   Response: application/json with the JSON-RPC reply
 *
 * Methods supported:
 *   - `initialize`                 → server info + capabilities
 *   - `notifications/initialized`  → notification, ignored (fire-and-forget)
 *   - `tools/list`                 → one tool: `echo(text: string)`
 *   - `tools/call` name=`echo`     → returns `text` verbatim as text content
 *
 * Anything else gets a JSON-RPC error -32601 (method not found). We don't
 * advertise resources / prompts / logging because we don't implement them.
 */
import { Hono } from 'hono';

import type { AppContext } from './env';

const mcpDemo = new Hono<AppContext>();

// MCP protocol version we speak. Matches what the client advertises in
// `initialize`. Bumping this here without a client bump won't break anything
// — old clients will just see a higher number and proceed.
const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: Record<string, never>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

interface EchoArgs {
  text?: unknown;
}

/** Build a JSON-RPC error reply with the standard error codes. */
function rpcError(id: number | string | null | undefined, code: number, message: string) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}

mcpDemo.post('/mcp/echo', async (c) => {
  const body = (await c.req.json().catch(() => null)) as JsonRpcRequest | null;
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    // Per JSON-RPC: -32600 Invalid Request. We answer with id=null because
    // we may not have a valid id to echo back.
    return c.json(rpcError(null, -32600, 'invalid JSON-RPC request'));
  }

  const { id, method, params } = body;

  // Notifications are id-less and don't get a response. The MCP client
  // sends `notifications/initialized` after a successful `initialize`;
  // anything starting with `notifications/` we accept and 204.
  if (method.startsWith('notifications/')) {
    // 204 = no content. Hono's c.body(null, 204) gives an empty body.
    return c.body(null, 204);
  }

  switch (method) {
    case 'initialize': {
      const result: InitializeResult = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          // Empty object means "we support tools but advertise no
          // sub-features" (subscribe/list-changed). The Flaude client
          // doesn't need either.
          tools: {},
        },
        serverInfo: {
          name: 'flaude-echo-demo',
          version: '1.0.0',
        },
      };
      return c.json({ jsonrpc: '2.0', id: id ?? null, result });
    }

    case 'tools/list': {
      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          tools: [
            {
              name: 'echo',
              description:
                'Returns the input string verbatim. Useful for confirming the MCP client → Flaude server chain works end-to-end.',
              inputSchema: {
                type: 'object',
                properties: {
                  text: {
                    type: 'string',
                    description: 'Any string to echo back.',
                  },
                },
                required: ['text'],
                additionalProperties: false,
              },
            },
          ],
        },
      });
    }

    case 'tools/call': {
      const callParams = (params ?? {}) as { name?: unknown; arguments?: unknown };
      if (callParams.name !== 'echo') {
        return c.json(
          rpcError(id, -32602, `unknown tool: ${String(callParams.name)}`),
        );
      }
      const args = (callParams.arguments ?? {}) as EchoArgs;
      const text = typeof args.text === 'string' ? args.text : '';
      return c.json({
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [
            {
              type: 'text',
              text: text || '(no text provided)',
            },
          ],
          isError: false,
        },
      });
    }

    default:
      return c.json(rpcError(id, -32601, `method not found: ${method}`));
  }
});

export default mcpDemo;
