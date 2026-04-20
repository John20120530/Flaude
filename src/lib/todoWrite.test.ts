/**
 * Tests for the `todo_write` builtin tool + the conversationTodos store slice.
 *
 * The tool is a thin handler over the store: validate shape, then call
 * `ctx.setTodos(...)`. The interesting surface is therefore:
 *   - shape validation (every error path we want the model to actually hit)
 *   - happy-path routing through the setTodos adapter
 *   - store-level concerns: per-conversation isolation, cleanup on
 *     deleteConversation / clearConversation, empty-list drop, etc.
 *
 * We exercise the tool directly via `executeTool('todo_write', ...)` so any
 * future routing changes (e.g. if the tool moves between builtin and MCP)
 * would still be caught by these tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from './tools';
import { useAppStore } from '@/store/useAppStore';
import type { TodoItem } from '@/types';

const INITIAL_STATE = useAppStore.getState();

function resetStore(): void {
  useAppStore.setState(INITIAL_STATE, true);
}

/**
 * Invoke `todo_write` with a setTodos adapter that writes to the real store,
 * scoped to the given conversation id. Returns the handler's string result so
 * tests can assert on the confirmation copy the model will see.
 */
function invokeTodoWrite(conversationId: string, args: Record<string, unknown>) {
  return executeTool('todo_write', args, {
    conversationId,
    setTodos: (todos: TodoItem[]) =>
      useAppStore.getState().setConversationTodos(conversationId, todos),
  });
}

describe('todo_write tool', () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  describe('shape validation', () => {
    it('rejects when todos is missing entirely', async () => {
      await expect(invokeTodoWrite('c1', {})).rejects.toThrow(/必须是一个数组/);
    });

    it('rejects when todos is not an array', async () => {
      await expect(
        invokeTodoWrite('c1', { todos: 'nope' }),
      ).rejects.toThrow(/必须是一个数组/);
    });

    it('rejects a non-object entry', async () => {
      await expect(
        invokeTodoWrite('c1', { todos: ['oops'] }),
      ).rejects.toThrow(/第 1 项不是对象/);
    });

    it('rejects an entry with a missing content field', async () => {
      await expect(
        invokeTodoWrite('c1', {
          todos: [{ activeForm: 'Doing it', status: 'pending' }],
        }),
      ).rejects.toThrow(/第 1 项缺少 content/);
    });

    it('rejects an entry with an empty-string content (after trim)', async () => {
      await expect(
        invokeTodoWrite('c1', {
          todos: [{ content: '   ', activeForm: 'Doing it', status: 'pending' }],
        }),
      ).rejects.toThrow(/第 1 项缺少 content/);
    });

    it('rejects an entry with a missing activeForm field', async () => {
      await expect(
        invokeTodoWrite('c1', {
          todos: [{ content: 'Do it', status: 'pending' }],
        }),
      ).rejects.toThrow(/第 1 项缺少 activeForm/);
    });

    it('rejects an entry with an invalid status', async () => {
      await expect(
        invokeTodoWrite('c1', {
          todos: [
            { content: 'Do it', activeForm: 'Doing it', status: 'todo' },
          ],
        }),
      ).rejects.toThrow(/status 无效/);
    });

    it('reports the offending index in multi-item rejections', async () => {
      await expect(
        invokeTodoWrite('c1', {
          todos: [
            { content: 'A', activeForm: 'Aing', status: 'pending' },
            { content: 'B', activeForm: 'Bing', status: 'bogus' },
          ],
        }),
      ).rejects.toThrow(/第 2 项/);
    });
  });

  describe('happy path', () => {
    it('writes a valid list into the store under the correct conversation id', async () => {
      const result = await invokeTodoWrite('conv-A', {
        todos: [
          { content: 'Read spec', activeForm: 'Reading spec', status: 'completed' },
          { content: 'Write code', activeForm: 'Writing code', status: 'in_progress' },
          { content: 'Run tests', activeForm: 'Running tests', status: 'pending' },
        ],
      });

      expect(result).toMatch(/已更新 TODO 列表：共 3 项/);
      expect(result).toContain('1 已完成');
      expect(result).toContain('1 进行中');
      expect(result).toContain('1 待办');
      // Active item surfaces in the return for the model's convenience.
      expect(result).toContain('Writing code');

      const stored = useAppStore.getState().conversationTodos['conv-A'];
      expect(stored).toHaveLength(3);
      expect(stored[0]).toEqual({
        content: 'Read spec',
        activeForm: 'Reading spec',
        status: 'completed',
      });
      expect(stored[1].status).toBe('in_progress');
      expect(stored[2].status).toBe('pending');
    });

    it('replaces (not merges) on subsequent calls', async () => {
      await invokeTodoWrite('c1', {
        todos: [{ content: 'A', activeForm: 'Aing', status: 'pending' }],
      });
      expect(useAppStore.getState().conversationTodos['c1']).toHaveLength(1);

      // Second call with a completely different list — expect replacement.
      await invokeTodoWrite('c1', {
        todos: [
          { content: 'X', activeForm: 'Xing', status: 'in_progress' },
          { content: 'Y', activeForm: 'Ying', status: 'pending' },
        ],
      });
      const stored = useAppStore.getState().conversationTodos['c1'];
      expect(stored).toHaveLength(2);
      expect(stored[0].content).toBe('X');
      expect(stored[1].content).toBe('Y');
    });

    it('isolates todos per conversation', async () => {
      await invokeTodoWrite('c1', {
        todos: [{ content: 'A', activeForm: 'Aing', status: 'pending' }],
      });
      await invokeTodoWrite('c2', {
        todos: [
          { content: 'B1', activeForm: 'B1ing', status: 'pending' },
          { content: 'B2', activeForm: 'B2ing', status: 'pending' },
        ],
      });
      const state = useAppStore.getState();
      expect(state.conversationTodos['c1']).toHaveLength(1);
      expect(state.conversationTodos['c2']).toHaveLength(2);
      expect(state.conversationTodos['c1'][0].content).toBe('A');
    });

    it('trims whitespace from content and activeForm', async () => {
      await invokeTodoWrite('c1', {
        todos: [
          { content: '  Do the thing  ', activeForm: '\tDoing the thing\n', status: 'pending' },
        ],
      });
      const stored = useAppStore.getState().conversationTodos['c1'];
      expect(stored[0].content).toBe('Do the thing');
      expect(stored[0].activeForm).toBe('Doing the thing');
    });

    it('accepts an empty list and drops the entry from the store', async () => {
      await invokeTodoWrite('c1', {
        todos: [{ content: 'A', activeForm: 'Aing', status: 'pending' }],
      });
      expect('c1' in useAppStore.getState().conversationTodos).toBe(true);

      const result = await invokeTodoWrite('c1', { todos: [] });
      expect(result).toBe('已清空 TODO 列表。');
      // Key should be dropped, not left as an empty array — selectors elsewhere
      // treat "missing" and "empty" as the same, but a floor of "no dead keys"
      // keeps memory clean over a long session.
      expect('c1' in useAppStore.getState().conversationTodos).toBe(false);
    });

    it('summary copy omits the current-item suffix when nothing is in_progress', async () => {
      const result = await invokeTodoWrite('c1', {
        todos: [
          { content: 'A', activeForm: 'Aing', status: 'completed' },
          { content: 'B', activeForm: 'Bing', status: 'completed' },
        ],
      });
      expect(result).toContain('2 已完成');
      expect(result).not.toMatch(/当前：/);
    });

    it('throws if ctx.setTodos is not provided', async () => {
      // Same-shape ctx as a real call, but without the setTodos hook — the tool
      // refuses rather than silently discarding the write. This guards against
      // future refactors that forget to wire the adapter through.
      await expect(
        executeTool(
          'todo_write',
          {
            todos: [{ content: 'A', activeForm: 'Aing', status: 'pending' }],
          },
          { conversationId: 'c1' },
        ),
      ).rejects.toThrow(/setTodos/);
    });
  });
});

describe('conversationTodos store actions', () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it('setConversationTodos clones the array so mutations do not leak in', () => {
    const list: TodoItem[] = [
      { content: 'A', activeForm: 'Aing', status: 'pending' },
    ];
    useAppStore.getState().setConversationTodos('c1', list);

    // Mutate the caller's reference — the store snapshot must not change.
    list.push({ content: 'B', activeForm: 'Bing', status: 'pending' });
    list[0].content = 'MUTATED';

    const stored = useAppStore.getState().conversationTodos['c1'];
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe('A');
  });

  it('clearConversationTodos drops the entry', () => {
    useAppStore.getState().setConversationTodos('c1', [
      { content: 'A', activeForm: 'Aing', status: 'pending' },
    ]);
    expect('c1' in useAppStore.getState().conversationTodos).toBe(true);

    useAppStore.getState().clearConversationTodos('c1');
    expect('c1' in useAppStore.getState().conversationTodos).toBe(false);
  });

  it('clearConversationTodos on an unknown id is a no-op', () => {
    // Start with one existing conversation's todos to make sure we don't
    // accidentally wipe everything.
    useAppStore.getState().setConversationTodos('c1', [
      { content: 'A', activeForm: 'Aing', status: 'pending' },
    ]);
    const before = useAppStore.getState().conversationTodos;
    useAppStore.getState().clearConversationTodos('does-not-exist');
    // Same reference — store returned `s` unchanged.
    expect(useAppStore.getState().conversationTodos).toBe(before);
  });

  it('deleteConversation drops the conversation todos', () => {
    // Seed a conversation so deleteConversation has something to delete; the
    // action filters by id-in-conversations list.
    useAppStore.setState((s) => ({
      conversations: [
        ...s.conversations,
        {
          id: 'c1',
          title: 't',
          mode: 'code',
          modelId: 'm',
          messages: [],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }));
    useAppStore.getState().setConversationTodos('c1', [
      { content: 'A', activeForm: 'Aing', status: 'pending' },
    ]);
    expect('c1' in useAppStore.getState().conversationTodos).toBe(true);

    useAppStore.getState().deleteConversation('c1');
    expect('c1' in useAppStore.getState().conversationTodos).toBe(false);
  });

  it('clearConversation (/clear) wipes the todos alongside messages', () => {
    useAppStore.setState((s) => ({
      conversations: [
        ...s.conversations,
        {
          id: 'c1',
          title: 't',
          mode: 'code',
          modelId: 'm',
          messages: [
            { id: 'm1', role: 'user', content: 'hi', createdAt: 0 },
          ],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    }));
    useAppStore.getState().setConversationTodos('c1', [
      { content: 'A', activeForm: 'Aing', status: 'in_progress' },
    ]);

    useAppStore.getState().clearConversation('c1');

    const conv = useAppStore
      .getState()
      .conversations.find((c) => c.id === 'c1');
    expect(conv?.messages).toHaveLength(0);
    expect('c1' in useAppStore.getState().conversationTodos).toBe(false);
  });
});
