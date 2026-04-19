/**
 * Minimal MCP (Model Context Protocol) HTTP server for Flaude smoke-testing.
 *
 * Implements just enough of the 2025-06-18 "Streamable HTTP" transport to
 * round-trip with Flaude's MCPClient:
 *   - POST /mcp  → JSON-RPC 2.0 request, responds with application/json
 *   - initialize / notifications/initialized
 *   - tools/list
 *   - tools/call
 *
 * Two demo tools:
 *   - greet({ name })          → plain text echo
 *   - list_files({ path })     → readdir inside the Flaude repo (read-only)
 *
 * CORS is wide open (`*`) because this is localhost-only. For a real server
 * you'd pin the origin.
 *
 * Run:  node scripts/mock-mcp-server.mjs
 * Port: 8787 (override with MCP_PORT env)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.MCP_PORT) || 8787;
// Read root — tools can't escape this. We use repo root so `list_files` has
// something interesting to return by default. Must use `fileURLToPath` (not
// `.pathname`) so URL-encoded characters — spaces, Chinese folder names —
// get decoded to real OS paths that fs.readdirSync can open.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const TOOLS = [
  {
    name: 'greet',
    description: 'Return a friendly greeting for a name. Useful for end-to-end MCP plumbing tests.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Person to greet' } },
      required: ['name'],
    },
  },
  {
    name: 'list_files',
    description: `List files in a directory relative to the Flaude repo root (${REPO_ROOT}). Read-only.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to repo root. Use "." for root.',
        },
      },
      required: ['path'],
    },
  },
];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    // Browsers block reading Mcp-Session-Id unless we explicitly expose it.
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}

function jsonRpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonRpcErr(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpc(msg) {
  const { method, id, params } = msg;

  // Notifications have no id; we ACK silently.
  if (id === undefined) return null;

  switch (method) {
    case 'initialize':
      return jsonRpcOk(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'flaude-mock-mcp', version: '0.1.0' },
      });

    case 'tools/list':
      return jsonRpcOk(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args = {} } = params ?? {};
      try {
        if (name === 'greet') {
          const who = String(args.name ?? 'world');
          return jsonRpcOk(id, {
            content: [{ type: 'text', text: `Hello, ${who}! MCP is wired up.` }],
          });
        }
        if (name === 'list_files') {
          const rel = String(args.path ?? '.');
          const abs = path.resolve(REPO_ROOT, rel);
          // Keep the tool honest: no escaping the repo.
          if (!abs.startsWith(REPO_ROOT)) {
            throw new Error('path outside repo root');
          }
          const entries = fs.readdirSync(abs, { withFileTypes: true });
          const lines = entries
            .map((e) => `${e.isDirectory() ? 'd' : '-'} ${e.name}${e.isDirectory() ? '/' : ''}`)
            .join('\n');
          return jsonRpcOk(id, {
            content: [{ type: 'text', text: lines || '(empty directory)' }],
          });
        }
        return jsonRpcOk(id, {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        });
      } catch (e) {
        return jsonRpcOk(id, {
          content: [{ type: 'text', text: `error: ${e.message}` }],
          isError: true,
        });
      }
    }

    default:
      return jsonRpcErr(id, -32601, `method not found: ${method}`);
  }
}

const server = http.createServer(async (req, res) => {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
    res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'text/plain' });
    res.end('POST /mcp only');
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');

  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jsonRpcErr(null, -32700, 'parse error')));
    return;
  }

  const out = await handleRpc(msg);
  // Notifications → 202 empty body
  if (out === null) {
    res.writeHead(202, corsHeaders());
    res.end();
    return;
  }

  // Give initialize a session id so Flaude exercises the Mcp-Session-Id path.
  const headers = {
    ...corsHeaders(),
    'Content-Type': 'application/json',
  };
  if (msg.method === 'initialize') {
    headers['Mcp-Session-Id'] = 'mock-session-' + Date.now();
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(out));
});

server.listen(PORT, () => {
  console.log(`[mock-mcp] listening on http://localhost:${PORT}/mcp`);
  console.log(`[mock-mcp] repo root = ${REPO_ROOT}`);
  console.log(`[mock-mcp] tools: ${TOOLS.map((t) => t.name).join(', ')}`);
});
