/**
 * Tests for built-in tools. Today this file covers `todo_write` — the other
 * built-ins (calculator, current_time, web_fetch, web_search, create_artifact)
 * either hit the network or require a richer mock harness that's not pulling
 * its weight yet. When one of those regresses, add a section here.
 *
 * `todo_write` is pure logic-plus-store-write, which maps cleanly onto the
 * existing vitest harness: we exercise the handler directly and assert
 *   (a) the store reflects what the agent published, and
 *   (b) the model-facing result string summarises the list in a stable way.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from './tools';
import { useAppStore } from '@/store/useAppStore';

// Snapshot fresh store state for between-test resets. Mirrors the pattern in
// useAppStore.test.ts so tests stay isolated.
const INITIAL_STATE = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(INITIAL_STATE, true);
});

afterEach(() => {
  useAppStore.setState(INITIAL_STATE, true);
});

const ctx = (conversationId = 'conv-test') => ({ conversationId });

describe('todo_write', () => {
  it('writes a valid list to the store keyed by conversation id', async () => {
    const result = await executeTool(
      'todo_write',
      {
        todos: [
          { content: 'Explore', activeForm: 'Exploring', status: 'completed' },
          { content: 'Implement', activeForm: 'Implementing', status: 'in_progress' },
          { content: 'Test', activeForm: 'Testing', status: 'pending' },
        ],
      },
      ctx('conv-a')
    );
    const stored = useAppStore.getState().agentTodos['conv-a'];
    expect(stored).toHaveLength(3);
    expect(stored[1]).toEqual({
      content: 'Implement',
      activeForm: 'Implementing',
      status: 'in_progress',
    });
    // The result string is what the model sees — it should summarise the
    // count and render each item with a status marker.
    expect(result).toContain('3 项');
    expect(result).toContain('[x] Explore');
    expect(result).toContain('[~] Implementing'); // shows activeForm for in_progress
    expect(result).toContain('[ ] Test');
  });

  it('empty list clears the conversation\'s stored todos', async () => {
    useAppStore
      .getState()
      .setAgentTodos('conv-b', [
        { content: 'old', activeForm: 'Old', status: 'pending' },
      ]);
    const result = await executeTool('todo_write', { todos: [] }, ctx('conv-b'));
    expect('conv-b' in useAppStore.getState().agentTodos).toBe(false);
    expect(result).toMatch(/清空/);
  });

  it('rejects multiple in_progress entries', async () => {
    await expect(
      executeTool(
        'todo_write',
        {
          todos: [
            { content: 'a', activeForm: 'A', status: 'in_progress' },
            { content: 'b', activeForm: 'B', status: 'in_progress' },
          ],
        },
        ctx()
      )
    ).rejects.toThrow(/in_progress/);
  });

  it('rejects a non-array todos argument', async () => {
    await expect(
      executeTool('todo_write', { todos: 'oops' as unknown as unknown[] }, ctx())
    ).rejects.toThrow(/数组/);
  });

  it('rejects an unknown status value', async () => {
    await expect(
      executeTool(
        'todo_write',
        {
          todos: [{ content: 'x', activeForm: 'X', status: 'wip' }],
        },
        ctx()
      )
    ).rejects.toThrow(/status/);
  });

  it('rejects an empty content string', async () => {
    await expect(
      executeTool(
        'todo_write',
        {
          todos: [{ content: '   ', activeForm: 'X', status: 'pending' }],
        },
        ctx()
      )
    ).rejects.toThrow(/content/);
  });

  it('trims whitespace on content / activeForm', async () => {
    await executeTool(
      'todo_write',
      {
        todos: [
          { content: '  Run tests  ', activeForm: '  Running tests  ', status: 'pending' },
        ],
      },
      ctx('conv-c')
    );
    const stored = useAppStore.getState().agentTodos['conv-c'];
    expect(stored[0].content).toBe('Run tests');
    expect(stored[0].activeForm).toBe('Running tests');
  });

  it('subsequent calls replace (not merge) — mirrors Claude Code semantics', async () => {
    await executeTool(
      'todo_write',
      {
        todos: [
          { content: 'a', activeForm: 'A', status: 'pending' },
          { content: 'b', activeForm: 'B', status: 'pending' },
        ],
      },
      ctx('conv-d')
    );
    await executeTool(
      'todo_write',
      {
        todos: [{ content: 'c', activeForm: 'C', status: 'in_progress' }],
      },
      ctx('conv-d')
    );
    const stored = useAppStore.getState().agentTodos['conv-d'];
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('c');
  });

  it('keeps separate conversations independent', async () => {
    await executeTool(
      'todo_write',
      { todos: [{ content: 'a', activeForm: 'A', status: 'pending' }] },
      ctx('conv-e')
    );
    await executeTool(
      'todo_write',
      { todos: [{ content: 'b', activeForm: 'B', status: 'completed' }] },
      ctx('conv-f')
    );
    const all = useAppStore.getState().agentTodos;
    expect(all['conv-e'][0].content).toBe('a');
    expect(all['conv-f'][0].content).toBe('b');
  });
});
