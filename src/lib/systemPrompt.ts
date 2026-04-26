import type { Project, Skill, WorkMode } from '@/types';
import { effectiveGlobalMemory } from './globalMemory';

/**
 * Compose the full system prompt for a conversation, combining:
 *   - The mode's base prompt (Chat / Code)
 *   - Global memory (CLAUDE.md-style persistent facts about the user)
 *   - Workspace memory (FLAUDE.md / CLAUDE.md from the current workspace root)
 *   - A catalogue of skills relevant to the current mode
 *   - Any project-level instructions (project memory)
 *   - Any project knowledge files (injected as context)
 *
 * Runs on every turn so updates to memory / skills / project instructions
 * take effect immediately.
 *
 * Order matters: base → user memory → workspace memory → skills → project
 * instructions → project knowledge. The model reads top-down, so identity
 * (base) goes first, then stable facts about the user, then project-level
 * conventions checked into the codebase, then reusable capabilities, then
 * the active project's own context.
 */
export function composeSystemPrompt(options: {
  basePrompt: string;
  /** Current conversation mode. Used to filter which skills get injected. */
  mode: WorkMode;
  /** Global CLAUDE.md-style memory. Empty string → not injected. */
  globalMemory?: string;
  /**
   * Workspace memory loaded from FLAUDE.md / CLAUDE.md at the workspace root.
   * Only meaningful in Code mode (the only mode with a workspace concept).
   */
  workspaceMemory?: { filename: string; content: string };
  /** User's skill library. Filtered by mode + `enabled` before injection. */
  skills?: Skill[];
  /** Active project (optional). */
  project?: Project;
  /** Rough token budget for project knowledge; files beyond this are truncated. */
  knowledgeTokenBudget?: number;
}): string {
  const {
    basePrompt,
    mode,
    globalMemory,
    workspaceMemory,
    skills,
    project,
    knowledgeTokenBudget = 40_000,
  } = options;
  const parts: string[] = [basePrompt];

  // Strip out entries the user marked as disabled in the Settings UI before
  // injecting. The raw string can contain `<!--disabled-->`-prefixed lines
  // that should be persisted (so toggling back on doesn't lose them) but
  // never reach the model.
  const liveMemory = effectiveGlobalMemory(globalMemory).trim();
  if (liveMemory) {
    parts.push(
      [
        '',
        '## 用户记忆（持久事实）',
        '',
        '以下是关于用户的持久事实，适用于所有对话。在回答时请考虑这些背景，但不要每次都显式复述：',
        '',
        liveMemory,
      ].join('\n')
    );
  }

  if (workspaceMemory && workspaceMemory.content.trim()) {
    parts.push(
      [
        '',
        `## 工作区约定（${workspaceMemory.filename}）`,
        '',
        '以下内容来自当前工作区根目录的 ' +
          workspaceMemory.filename +
          '，是这个项目专属的约定（命令、规范、目录结构、避免改动的区域等）。当用户的请求与之相关时，**优先**遵守它，而不是你的默认习惯：',
        '',
        workspaceMemory.content.trim(),
      ].join('\n')
    );
  }

  if (skills && skills.length > 0) {
    const active = skills.filter(
      (s) => s.enabled && (s.modes.length === 0 || s.modes.includes(mode))
    );
    if (active.length > 0) {
      const catalogue = active
        .map(
          (s) =>
            `### ${s.name}（${s.title}）\n**适用场景**：${s.description}\n\n${s.instructions.trim()}`
        )
        .join('\n\n---\n\n');
      parts.push(
        [
          '',
          '## 可用技能',
          '',
          '当用户的请求匹配某项技能的适用场景时，按该技能的指导操作。技能之间可组合，也可都不用——由你判断。',
          '',
          catalogue,
        ].join('\n')
      );
    }
  }

  if (project) {
    if (project.instructions?.trim()) {
      parts.push(
        `\n## 项目指令（来自项目「${project.name}」）\n\n${project.instructions.trim()}`
      );
    }

    if (project.sources.length > 0) {
      const knowledge = truncateSources(project.sources, knowledgeTokenBudget);
      if (knowledge) {
        parts.push(
          `\n## 项目知识（来自项目「${project.name}」）\n\n${knowledge}\n\n在回答时请优先引用上述项目知识。`
        );
      }
    }
  }

  return parts.join('\n');
}

function truncateSources(
  sources: Project['sources'],
  tokenBudget: number
): string {
  // Chars-per-token heuristic = 4
  const charBudget = tokenBudget * 4;
  const out: string[] = [];
  let used = 0;
  for (const src of sources) {
    if (!src.content) continue;
    const header = `\n### ${src.name}\n`;
    const remaining = charBudget - used - header.length;
    if (remaining <= 200) {
      out.push(`\n### ${src.name}\n[内容已省略 — 超出 token 预算]`);
      break;
    }
    const body =
      src.content.length > remaining
        ? src.content.slice(0, remaining) + '\n\n[... 已截断]'
        : src.content;
    out.push(header + body);
    used += header.length + body.length;
  }
  return out.join('\n');
}
