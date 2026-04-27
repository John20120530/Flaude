/**
 * Echo MCP demo endpoint tests.
 *
 * These pin the wire format the Flaude client expects (see src/lib/mcp.ts in
 * the root package): JSON-RPC 2.0 over a single POST endpoint, with
 * initialize + tools/list + tools/call working end-to-end.
 *
 * Why integration-test instead of unit-test the handler:
 *   - The handler is shaped around Hono's Context (c.req.json / c.json) so a
 *     unit test would mostly mock those. Driving the full app through fetch()
 *     proves the route is actually mounted at /mcp/echo, runs without auth
 *     (the whole point of the demo), and serializes JSON-RPC correctly.
 *   - Cheap — Hono's `app.fetch` runs in-process, no D1 needed since this
 *     endpoint is stateless.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import worker from '../src/index';
import type { Env } from '../src/env';
import { createTestD1 } from './d1Shim';

let env: Env;

function stubCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
}

async function rpc(method: string, params?: unknown, id: number | null = 1) {
  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (id !== null) body.id = id;
  if (params !== undefined) body.params = params;

  const req = new Request('http://test/mcp/echo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  return worker.fetch(req, env, stubCtx());
}

beforeEach(() => {
  // The Echo demo doesn't read DB/JWT — but Env is required-shape, so we
  // wire a minimal env with a stub D1.
  env = {
    DB: createTestD1(),
    APP_ENV: 'development',
    JWT_ISSUER: 'flaude-test',
    MONTHLY_QUOTA_TOKENS: '300000',
    JWT_SECRET: 'test-secret-at-least-32-bytes-long-for-HS256-use-wow',
  } as Env;
});

describe('POST /mcp/echo', () => {
  it('initialize returns server info + capabilities', async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        protocolVersion: string;
        capabilities: { tools: Record<string, unknown> };
        serverInfo: { name: string; version: string };
      };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe('flaude-echo-demo');
  });

  it('tools/list advertises the echo tool with a schema', async () => {
    const res = await rpc('tools/list');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: { properties: Record<string, unknown>; required: string[] };
        }>;
      };
    };
    expect(body.result.tools).toHaveLength(1);
    const tool = body.result.tools[0]!;
    expect(tool.name).toBe('echo');
    expect(tool.description.length).toBeGreaterThan(10);
    expect(tool.inputSchema.properties).toHaveProperty('text');
    expect(tool.inputSchema.required).toContain('text');
  });

  it('tools/call echo returns the input verbatim as text content', async () => {
    const res = await rpc('tools/call', {
      name: 'echo',
      arguments: { text: 'hello flaude 你好' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result.content).toHaveLength(1);
    expect(body.result.content[0]!.type).toBe('text');
    expect(body.result.content[0]!.text).toBe('hello flaude 你好');
  });

  it('tools/call with empty text returns a placeholder, not an error', async () => {
    const res = await rpc('tools/call', { name: 'echo', arguments: {} });
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0]!.text).toBe('(no text provided)');
  });

  it('tools/call with unknown tool name returns -32602', async () => {
    const res = await rpc('tools/call', {
      name: 'nonexistent',
      arguments: {},
    });
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/nonexistent/);
  });

  it('unknown method returns JSON-RPC -32601', async () => {
    const res = await rpc('foo/bar');
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toMatch(/method not found/);
  });

  it('notifications/* return 204 with empty body and no JSON-RPC reply', async () => {
    // Notifications carry no id and expect no response per JSON-RPC. We send
    // id=null to mimic that (the fetchApp helper needs *some* id; the
    // server should still handle it gracefully).
    const req = new Request('http://test/mcp/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    const res = await worker.fetch(req, env, stubCtx());
    expect(res.status).toBe(204);
    const body = await res.text();
    expect(body).toBe('');
  });

  it('malformed body returns -32600 Invalid Request', async () => {
    const req = new Request('http://test/mcp/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const res = await worker.fetch(req, env, stubCtx());
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it('does NOT require auth (the whole point of the demo)', async () => {
    // No Authorization header at all. Should work.
    const req = new Request('http://test/mcp/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const res = await worker.fetch(req, env, stubCtx());
    expect(res.status).toBe(200);
  });
});
