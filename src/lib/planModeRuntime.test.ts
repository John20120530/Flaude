import { describe, expect, it } from 'vitest';
import { isDestructiveToolName, PLAN_MODE_PROMPT } from './planModeRuntime';
import { executeTool, getTool } from './tools';
import type { PlanApprovalResultLite } from './tools';

describe('isDestructiveToolName', () => {
  it('returns true for fs_write_file and the four shell side-effect tools', () => {
    expect(isDestructiveToolName('fs_write_file')).toBe(true);
    expect(isDestructiveToolName('shell_exec')).toBe(true);
    expect(isDestructiveToolName('shell_start')).toBe(true);
    expect(isDestructiveToolName('shell_write')).toBe(true);
    expect(isDestructiveToolName('shell_kill')).toBe(true);
  });

  it('returns false for read-only fs / shell tools (planning-friendly)', () => {
    expect(isDestructiveToolName('fs_list_dir')).toBe(false);
    expect(isDestructiveToolName('fs_read_file')).toBe(false);
    expect(isDestructiveToolName('fs_stat')).toBe(false);
    expect(isDestructiveToolName('shell_read')).toBe(false);
    expect(isDestructiveToolName('shell_list')).toBe(false);
  });

  it('returns false for non-destructive builtins (planning-friendly)', () => {
    expect(isDestructiveToolName('todo_write')).toBe(false);
    expect(isDestructiveToolName('create_artifact')).toBe(false);
    expect(isDestructiveToolName('web_fetch')).toBe(false);
    expect(isDestructiveToolName('web_search')).toBe(false);
    expect(isDestructiveToolName('current_time')).toBe(false);
    expect(isDestructiveToolName('calculator')).toBe(false);
    expect(isDestructiveToolName('exit_plan_mode')).toBe(false);
  });

  it('returns false for unknown / MCP-style names (we err toward allowing)', () => {
    expect(isDestructiveToolName('something_random')).toBe(false);
    expect(isDestructiveToolName('mcp__server__tool')).toBe(false);
  });
});

describe('PLAN_MODE_PROMPT', () => {
  it('mentions every destructive tool by name (so the model knows what is locked)', () => {
    expect(PLAN_MODE_PROMPT).toContain('fs_write_file');
    expect(PLAN_MODE_PROMPT).toContain('shell_exec');
    expect(PLAN_MODE_PROMPT).toContain('shell_start');
    expect(PLAN_MODE_PROMPT).toContain('shell_write');
    expect(PLAN_MODE_PROMPT).toContain('shell_kill');
  });

  it('explicitly lists allowed read tools (so the model does not refuse to read)', () => {
    expect(PLAN_MODE_PROMPT).toContain('fs_list_dir');
    expect(PLAN_MODE_PROMPT).toContain('fs_read_file');
    expect(PLAN_MODE_PROMPT).toContain('shell_read');
  });

  it('describes the exit_plan_mode call as the way out', () => {
    expect(PLAN_MODE_PROMPT).toContain('exit_plan_mode');
  });

  it('describes the three terminal outcomes the model should expect', () => {
    expect(PLAN_MODE_PROMPT).toMatch(/批准/);
    expect(PLAN_MODE_PROMPT).toMatch(/反馈/);
    expect(PLAN_MODE_PROMPT).toMatch(/拒绝/);
  });
});

describe('exit_plan_mode tool', () => {
  it('is registered as a builtin scoped to Code mode only', () => {
    const tool = getTool('exit_plan_mode');
    expect(tool).toBeDefined();
    expect(tool?.source).toBe('builtin');
    expect(tool?.modes).toEqual(['code']);
  });

  it('schema requires a single string `plan` parameter', () => {
    const tool = getTool('exit_plan_mode');
    const params = tool?.parameters as {
      type: string;
      properties: { plan: { type: string } };
      required: string[];
    };
    expect(params.type).toBe('object');
    expect(params.properties.plan.type).toBe('string');
    expect(params.required).toEqual(['plan']);
  });

  it('rejects with a useful message when ctx.requestPlanApproval is missing (Plan mode not enabled)', async () => {
    await expect(
      executeTool('exit_plan_mode', { plan: 'a plan' }, { conversationId: 'c' }),
    ).rejects.toThrow(/Plan 模式未启用/);
  });

  it('rejects when plan is missing or empty', async () => {
    const requestPlanApproval = async (): Promise<PlanApprovalResultLite> => ({
      kind: 'approved',
    });
    await expect(
      executeTool(
        'exit_plan_mode',
        { plan: '' },
        { conversationId: 'c', requestPlanApproval },
      ),
    ).rejects.toThrow(/必须是非空字符串/);
    await expect(
      executeTool(
        'exit_plan_mode',
        {},
        { conversationId: 'c', requestPlanApproval },
      ),
    ).rejects.toThrow(/必须是非空字符串/);
  });

  it('approval result text contains the unlock confirmation', async () => {
    const requestPlanApproval = async (): Promise<PlanApprovalResultLite> => ({
      kind: 'approved',
    });
    const result = await executeTool(
      'exit_plan_mode',
      { plan: 'do X' },
      { conversationId: 'c', requestPlanApproval },
    );
    expect(result).toMatch(/已批准/);
    expect(result).toMatch(/解锁|可以开始/);
  });

  it('feedback result text echoes the user feedback verbatim and asks to re-submit', async () => {
    const requestPlanApproval = async (): Promise<PlanApprovalResultLite> => ({
      kind: 'feedback',
      feedback: '步骤 2 太激进，先只改 src/',
    });
    const result = await executeTool(
      'exit_plan_mode',
      { plan: 'p' },
      { conversationId: 'c', requestPlanApproval },
    );
    expect(result).toContain('步骤 2 太激进，先只改 src/');
    expect(result).toMatch(/重新调用 exit_plan_mode/);
  });

  it('rejection result text says the plan was rejected', async () => {
    const requestPlanApproval = async (): Promise<PlanApprovalResultLite> => ({
      kind: 'rejected',
    });
    const result = await executeTool(
      'exit_plan_mode',
      { plan: 'p' },
      { conversationId: 'c', requestPlanApproval },
    );
    expect(result).toMatch(/拒绝/);
  });

  it('rejection with reason includes the reason text', async () => {
    const requestPlanApproval = async (): Promise<PlanApprovalResultLite> => ({
      kind: 'rejected',
      reason: '不需要这么麻烦',
    });
    const result = await executeTool(
      'exit_plan_mode',
      { plan: 'p' },
      { conversationId: 'c', requestPlanApproval },
    );
    expect(result).toContain('不需要这么麻烦');
  });
});
