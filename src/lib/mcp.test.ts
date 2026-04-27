/**
 * Tests for the stdio MCP transport's correlation + lifecycle.
 *
 * The full HTTP path is integration-tested via the live MCP servers we ship
 * in the marketplace; the failure modes there are server-side (CORS, 401,
 * SSE framing) and don't lend themselves to unit tests. The stdio path is
 * the new hotness and has interesting state — pending-id map, recv-loop
 * dispatch, abort, child-exit error propagation — so this file pins down
 * the behaviour with a fake StdioIO.
 */

import { describe, expect, it } from 'vitest';
import { StdioTransport, type StdioIO, type StdioRecvResult } from './mcp';

/**
 * Manually-driven IO. `send` records every payload; `recv` blocks on a
 * promise the test resolves when it wants to deliver a batch of messages.
 * Lets us run deterministic step-by-step scenarios.
 */
function makeFakeIO(): {
  io: StdioIO;
  sent: string[];
  /** Deliver one batch of messages to whoever's currently long-polling. */
  push: (result: StdioRecvResult) => void;
  /** Make the next pending recv reject with this error. */
  fail: (err: Error) => void;
} {
  const sent: string[] = [];
  const queue: Array<(r: StdioRecvResult) => void> = [];
  const failures: Array<(e: Error) => void> = [];

  return {
    sent,
    io: {
      async send(message) {
        sent.push(message);
      },
      async recv() {
        return new Promise<StdioRecvResult>((resolve, reject) => {
          queue.push(resolve);
          failures.push(reject);
        });
      },
    },
    push(result) {
      const next = queue.shift();
      failures.shift();
      if (next) next(result);
    },
    fail(err) {
      const next = failures.shift();
      queue.shift();
      if (next) next(err);
    },
  };
}

const RUNNING_EMPTY: StdioRecvResult = {
  messages: [],
  running: true,
  code: null,
  killed: false,
  dropped_messages: 0,
  stderr: '',
};

describe('StdioTransport', () => {
  it('sends a JSON-RPC request and resolves with the matching response', async () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);
    const p = t.request<{ ok: boolean }>('ping', { hi: 1 }, undefined);

    // Give the microtask queue a tick so request() actually fires send().
    await Promise.resolve();
    expect(fake.sent).toHaveLength(1);
    const sent = JSON.parse(fake.sent[0]!);
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('ping');
    expect(sent.id).toBe(1);
    expect(sent.params).toEqual({ hi: 1 });

    // Drive a response back via the fake recv.
    fake.push({
      ...RUNNING_EMPTY,
      messages: [
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
      ],
    });

    await expect(p).resolves.toEqual({ ok: true });
    expect(t.pendingCount()).toBe(0);
    t.close();
  });

  it('correlates concurrent requests by id, in any response order', async () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);

    const p1 = t.request<number>('a', undefined, undefined);
    const p2 = t.request<number>('b', undefined, undefined);
    const p3 = t.request<number>('c', undefined, undefined);
    await Promise.resolve();
    expect(fake.sent).toHaveLength(3);
    expect(t.pendingCount()).toBe(3);

    // Server answers in reverse order — we must still match by id.
    fake.push({
      ...RUNNING_EMPTY,
      messages: [
        JSON.stringify({ jsonrpc: '2.0', id: 3, result: 30 }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: 10 }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, result: 20 }),
      ],
    });

    await expect(p1).resolves.toBe(10);
    await expect(p2).resolves.toBe(20);
    await expect(p3).resolves.toBe(30);
    expect(t.pendingCount()).toBe(0);
    t.close();
  });

  it('rejects a request when the server responds with an error', async () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);
    const p = t.request('boom', undefined, undefined);
    await Promise.resolve();
    fake.push({
      ...RUNNING_EMPTY,
      messages: [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { message: 'tool failed', code: -32000 },
        }),
      ],
    });
    await expect(p).rejects.toThrow(/tool failed.*-32000/);
    t.close();
  });

  it('drops unsolicited notifications and unmatched late responses', async () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);

    // Boot the loop with a request (otherwise dispatch isn't exercised).
    const p = t.request('a', undefined, undefined);
    await Promise.resolve();

    // Notification (no id) + late response (id we never sent) — both should
    // be silently dropped. Then deliver the real id=1 result.
    fake.push({
      ...RUNNING_EMPTY,
      messages: [
        JSON.stringify({ jsonrpc: '2.0', method: 'progress', params: { p: 0.5 } }),
        JSON.stringify({ jsonrpc: '2.0', id: 999, result: 'orphan' }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }),
      ],
    });

    await expect(p).resolves.toBe('ok');
    expect(t.pendingCount()).toBe(0);
    t.close();
  });

  it('rejects all pending requests when the server exits', async () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);
    const p1 = t.request('a', undefined, undefined);
    const p2 = t.request('b', undefined, undefined);
    await Promise.resolve();

    // Server died with non-zero code.
    fake.push({
      messages: [],
      running: false,
      code: 1,
      killed: false,
      dropped_messages: 0,
      stderr: 'crashed',
    });

    await expect(p1).rejects.toThrow(/已退出.*code=1/);
    await expect(p2).rejects.toThrow(/已退出.*code=1/);
  });

  it('rejects all pending requests when the IPC layer fails', async () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);
    const p = t.request('a', undefined, undefined);
    await Promise.resolve();

    fake.fail(new Error('host disconnected'));

    await expect(p).rejects.toThrow(/recv 失败.*host disconnected/);
  });

  it('aborts a pending request when the signal fires', async () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);
    const ctrl = new AbortController();
    const p = t.request('slow', undefined, ctrl.signal);
    await Promise.resolve();

    ctrl.abort();
    await expect(p).rejects.toThrow(/Aborted/);
    // Should have been removed from pending so a late response doesn't
    // double-resolve.
    expect(t.pendingCount()).toBe(0);
    t.close();
  });

  it('rejects further requests after close()', async () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);
    t.close();
    await expect(
      t.request('a', undefined, undefined),
    ).rejects.toThrow(/已关闭/);
  });

  it('accumulates stderr across recv batches', async () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);
    const p = t.request('a', undefined, undefined);

    // Flush microtasks across multiple awaits — each push advances the
    // recv loop by one full iteration (process result → loop back → next
    // recv), and we need the *next* recv to register before our next push
    // can resolve it. Two macrotask ticks bracket each push.
    const flush = () => new Promise((r) => setTimeout(r, 0));
    await flush();

    fake.push({
      ...RUNNING_EMPTY,
      messages: [],
      stderr: 'first line\n',
    });
    await flush();

    fake.push({
      ...RUNNING_EMPTY,
      messages: [JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' })],
      stderr: 'second line\n',
    });
    await p;
    expect(t.stderrLog).toBe('first line\nsecond line\n');
    t.close();
  });

  it('dispatchMessage is robust to non-JSON garbage', () => {
    const fake = makeFakeIO();
    const t = new StdioTransport(fake.io);
    // Should not throw — this happens when a server prints a banner to
    // stdout before starting JSON-RPC (rude but possible).
    expect(() => t.dispatchMessage('hello world this is not JSON')).not.toThrow();
    expect(() => t.dispatchMessage('')).not.toThrow();
    t.close();
  });
});
