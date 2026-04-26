import { describe, it, expect } from 'vitest';
import type { Project, Skill } from '@/types';
import { composeSystemPrompt } from './systemPrompt';

const BASE = 'You are Flaude.';

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: over.id ?? 's1',
  name: over.name ?? 'code-review',
  title: over.title ?? '代码评审',
  description: over.description ?? '审查代码',
  instructions: over.instructions ?? '仔细读代码',
  modes: over.modes ?? ['code'],
  enabled: over.enabled ?? true,
  builtin: over.builtin,
  createdAt: over.createdAt ?? 0,
  updatedAt: over.updatedAt ?? 0,
});

describe('composeSystemPrompt', () => {
  it('returns just the base prompt when nothing else is set', () => {
    const out = composeSystemPrompt({ basePrompt: BASE, mode: 'chat' });
    expect(out).toBe(BASE);
  });

  it('injects globalMemory under a heading', () => {
    const out = composeSystemPrompt({
      basePrompt: BASE,
      mode: 'chat',
      globalMemory: '- I prefer pnpm',
    });
    expect(out).toContain('## 用户记忆（持久事实）');
    expect(out).toContain('- I prefer pnpm');
  });

  it('skips the memory section when globalMemory is empty or whitespace', () => {
    const empty = composeSystemPrompt({ basePrompt: BASE, mode: 'chat', globalMemory: '' });
    const blank = composeSystemPrompt({ basePrompt: BASE, mode: 'chat', globalMemory: '   \n  ' });
    expect(empty).not.toContain('用户记忆');
    expect(blank).not.toContain('用户记忆');
  });

  it('filters skills by mode — injects only matching ones', () => {
    const skills = [
      skill({ id: 'a', name: 'only-code', modes: ['code'] }),
      skill({ id: 'b', name: 'only-chat', modes: ['chat'] }),
    ];
    const chatOut = composeSystemPrompt({ basePrompt: BASE, mode: 'chat', skills });
    expect(chatOut).toContain('only-chat');
    expect(chatOut).not.toContain('only-code');
  });

  it('treats skills with empty modes[] as universal', () => {
    const skills = [skill({ id: 'u', name: 'universal', modes: [] })];
    const codeOut = composeSystemPrompt({ basePrompt: BASE, mode: 'code', skills });
    const chatOut = composeSystemPrompt({ basePrompt: BASE, mode: 'chat', skills });
    expect(codeOut).toContain('universal');
    expect(chatOut).toContain('universal');
  });

  it('filters out disabled skills', () => {
    const skills = [
      skill({ id: 'on', name: 'enabled-skill', enabled: true, modes: ['chat'] }),
      skill({ id: 'off', name: 'disabled-skill', enabled: false, modes: ['chat'] }),
    ];
    const out = composeSystemPrompt({ basePrompt: BASE, mode: 'chat', skills });
    expect(out).toContain('enabled-skill');
    expect(out).not.toContain('disabled-skill');
  });

  it('omits the skills section entirely when no skills are active', () => {
    const skills = [skill({ enabled: false })];
    const out = composeSystemPrompt({ basePrompt: BASE, mode: 'code', skills });
    expect(out).not.toContain('## 可用技能');
  });

  it('injects project instructions when provided', () => {
    const project: Project = {
      id: 'p1',
      name: 'MyApp',
      instructions: 'Use strict TypeScript.',
      sources: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const out = composeSystemPrompt({ basePrompt: BASE, mode: 'chat', project });
    expect(out).toContain('项目指令');
    expect(out).toContain('「MyApp」');
    expect(out).toContain('Use strict TypeScript.');
  });

  it('injects project knowledge sources', () => {
    const project: Project = {
      id: 'p1',
      name: 'MyApp',
      sources: [
        { id: 's1', kind: 'text', name: 'notes.md', content: 'some knowledge content' },
      ],
      createdAt: 0,
      updatedAt: 0,
    };
    const out = composeSystemPrompt({ basePrompt: BASE, mode: 'chat', project });
    expect(out).toContain('项目知识');
    expect(out).toContain('### notes.md');
    expect(out).toContain('some knowledge content');
  });

  it('truncates project knowledge when it exceeds the token budget', () => {
    const huge = 'x'.repeat(20_000); // 20k chars ≈ 5k tokens
    const project: Project = {
      id: 'p1',
      name: 'MyApp',
      sources: [{ id: 's1', kind: 'text', name: 'big.md', content: huge }],
      createdAt: 0,
      updatedAt: 0,
    };
    const out = composeSystemPrompt({
      basePrompt: BASE,
      mode: 'chat',
      project,
      knowledgeTokenBudget: 100, // 100 tokens ≈ 400 chars
    });
    expect(out).toContain('[... 已截断]');
    expect(out.length).toBeLessThan(huge.length);
  });

  it('keeps composition order: base → memory → skills → project', () => {
    const out = composeSystemPrompt({
      basePrompt: BASE,
      mode: 'chat',
      globalMemory: '- memory-line',
      skills: [skill({ modes: [] })],
      project: {
        id: 'p', name: 'P', instructions: 'proj-instr',
        sources: [], createdAt: 0, updatedAt: 0,
      },
    });
    const baseIdx = out.indexOf(BASE);
    const memIdx = out.indexOf('用户记忆');
    const skillIdx = out.indexOf('可用技能');
    const projIdx = out.indexOf('项目指令');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(memIdx).toBeGreaterThan(baseIdx);
    expect(skillIdx).toBeGreaterThan(memIdx);
    expect(projIdx).toBeGreaterThan(skillIdx);
  });

  describe('workspaceMemory injection', () => {
    it('injects FLAUDE.md content under a workspace section', () => {
      const out = composeSystemPrompt({
        basePrompt: BASE,
        mode: 'code',
        workspaceMemory: {
          filename: 'FLAUDE.md',
          content: 'Use pnpm. Build via `pnpm tauri:dev`.',
        },
      });
      expect(out).toContain('## 工作区约定（FLAUDE.md）');
      expect(out).toContain('Use pnpm. Build via `pnpm tauri:dev`.');
    });

    it('uses the actual filename in the heading (CLAUDE.md fallback)', () => {
      const out = composeSystemPrompt({
        basePrompt: BASE,
        mode: 'code',
        workspaceMemory: { filename: 'CLAUDE.md', content: '- be terse' },
      });
      expect(out).toContain('## 工作区约定（CLAUDE.md）');
      expect(out).not.toContain('## 工作区约定（FLAUDE.md）');
    });

    it('omits the workspace section when workspaceMemory is undefined', () => {
      const out = composeSystemPrompt({ basePrompt: BASE, mode: 'code' });
      expect(out).not.toContain('## 工作区约定');
    });

    it('omits the workspace section when content is whitespace-only', () => {
      const out = composeSystemPrompt({
        basePrompt: BASE,
        mode: 'code',
        workspaceMemory: { filename: 'FLAUDE.md', content: '   \n\n  ' },
      });
      expect(out).not.toContain('## 工作区约定');
    });

    it('places workspace memory after global memory and before skills', () => {
      // The order matters: workspace conventions are project-level facts
      // that should override generic skill defaults but sit under the user's
      // own persistent memory.
      const out = composeSystemPrompt({
        basePrompt: BASE,
        mode: 'code',
        globalMemory: '- I prefer Vim',
        workspaceMemory: {
          filename: 'FLAUDE.md',
          content: 'Project uses 2-space indent.',
        },
        skills: [skill({ name: 'lint-skill', modes: [] })],
      });
      const memIdx = out.indexOf('## 用户记忆');
      const wsIdx = out.indexOf('## 工作区约定');
      const skillIdx = out.indexOf('## 可用技能');
      expect(memIdx).toBeGreaterThan(0);
      expect(wsIdx).toBeGreaterThan(memIdx);
      expect(skillIdx).toBeGreaterThan(wsIdx);
    });

    it('coexists with project instructions without conflict (both render)', () => {
      const out = composeSystemPrompt({
        basePrompt: BASE,
        mode: 'code',
        workspaceMemory: { filename: 'FLAUDE.md', content: 'workspace fact' },
        project: {
          id: 'p',
          name: 'MyProj',
          instructions: 'project instruction',
          sources: [],
          createdAt: 0,
          updatedAt: 0,
        },
      });
      expect(out).toContain('workspace fact');
      expect(out).toContain('project instruction');
    });
  });
});
