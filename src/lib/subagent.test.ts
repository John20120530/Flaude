import { describe, expect, it } from 'vitest';
import { executeTool, getTool } from './tools';
import type { SubagentRequestLite, SubagentResultLite } from './tools';

describe('spawn_subtask tool registration', () => {
  it('is registered as a builtin scoped to Code mode only', () => {
    const tool = getTool('spawn_subtask');
    expect(tool).toBeDefined();
    expect(tool?.source).toBe('builtin');
    expect(tool?.modes).toEqual(['code']);
  });

  it('schema requires title + prompt, makes context optional', () => {
    const tool = getTool('spawn_subtask');
    const params = tool?.parameters as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(params.type).toBe('object');
    expect(params.properties.title.type).toBe('string');
    expect(params.properties.prompt.type).toBe('string');
    expect(params.properties.context.type).toBe('string');
    expect(params.required).toEqual(['title', 'prompt']);
  });

  it('description steers the model toward search/validate/batch use cases (and away from single-tool tasks)', () => {
    const tool = getTool('spawn_subtask');
    expect(tool?.description).toMatch(/适合用|搜索|调研|验证|批量/);
    expect(tool?.description).toMatch(/不适合用|单工具|沟通|强耦合/);
    expect(tool?.description).toMatch(/隔离|看不到/);
  });
});

describe('spawn_subtask handler', () => {
  it('rejects when ctx.spawnSubtask is not injected (called from a non-runtime context)', async () => {
    await expect(
      executeTool(
        'spawn_subtask',
        { title: 'x', prompt: 'do y' },
        { conversationId: 'c1' },
      ),
    ).rejects.toThrow(/spawnSubtask/);
  });

  it('rejects when prompt is missing or empty', async () => {
    const stub = async (): Promise<SubagentResultLite> => ({
      finalText: '',
      subConversationId: 'sub1',
      truncated: false,
    });
    await expect(
      executeTool(
        'spawn_subtask',
        { title: 't', prompt: '' },
        { conversationId: 'c1', spawnSubtask: stub },
      ),
    ).rejects.toThrow(/必须是非空字符串/);
    await expect(
      executeTool(
        'spawn_subtask',
        { title: 't' },
        { conversationId: 'c1', spawnSubtask: stub },
      ),
    ).rejects.toThrow(/必须是非空字符串/);
  });

  it('forwards title + prompt + context to the runtime', async () => {
    let captured: SubagentRequestLite | undefined;
    const stub = async (req: SubagentRequestLite): Promise<SubagentResultLite> => {
      captured = req;
      return { finalText: 'done', subConversationId: 'sub-abc123', truncated: false };
    };
    await executeTool(
      'spawn_subtask',
      { title: '找 fetch', prompt: '搜 src/ 里的 fetch 调用', context: 'React + Tauri' },
      { conversationId: 'parent-1', spawnSubtask: stub },
    );
    expect(captured).toEqual({
      title: '找 fetch',
      prompt: '搜 src/ 里的 fetch 调用',
      context: 'React + Tauri',
    });
  });

  it('falls back to default title when blank', async () => {
    let captured: SubagentRequestLite | undefined;
    const stub = async (req: SubagentRequestLite): Promise<SubagentResultLite> => {
      captured = req;
      return { finalText: '', subConversationId: 's', truncated: false };
    };
    await executeTool(
      'spawn_subtask',
      { title: '   ', prompt: 'p' },
      { conversationId: 'c', spawnSubtask: stub },
    );
    expect(captured?.title).toBe('子任务');
  });

  it('drops empty-string context (does not pass empty string downstream)', async () => {
    let captured: SubagentRequestLite | undefined;
    const stub = async (req: SubagentRequestLite): Promise<SubagentResultLite> => {
      captured = req;
      return { finalText: '', subConversationId: 's', truncated: false };
    };
    await executeTool(
      'spawn_subtask',
      { title: 't', prompt: 'p', context: '   ' },
      { conversationId: 'c', spawnSubtask: stub },
    );
    expect(captured?.context).toBeUndefined();
  });

  it('returns the subagent text wrapped with the title + id pointer', async () => {
    const stub = async (): Promise<SubagentResultLite> => ({
      finalText: '找到 5 处 fetch 调用：\n- src/a.ts:42\n- src/b.ts:13',
      subConversationId: 'sub-deadbeef',
      truncated: false,
    });
    const result = await executeTool(
      'spawn_subtask',
      { title: '找 fetch', prompt: 'p' },
      { conversationId: 'c', spawnSubtask: stub },
    );
    expect(result).toContain('找 fetch');
    expect(result).toContain('找到 5 处');
    // Last 6 chars of the sub conversation id (panel-friendly short id).
    expect(result).toContain('adbeef');
  });

  it('appends a truncation note when the subagent hit the round cap', async () => {
    const stub = async (): Promise<SubagentResultLite> => ({
      finalText: '我做了一半...',
      subConversationId: 'sub-x',
      truncated: true,
    });
    const result = await executeTool(
      'spawn_subtask',
      { title: 't', prompt: 'p' },
      { conversationId: 'c', spawnSubtask: stub },
    );
    expect(result).toMatch(/15 轮|工具上限|没有自然结束/);
  });

  it('omits truncation note on normal completion', async () => {
    const stub = async (): Promise<SubagentResultLite> => ({
      finalText: 'done',
      subConversationId: 's',
      truncated: false,
    });
    const result = await executeTool(
      'spawn_subtask',
      { title: 't', prompt: 'p' },
      { conversationId: 'c', spawnSubtask: stub },
    );
    expect(result).not.toMatch(/工具上限/);
  });
});
