import type { Project, Skill, WorkMode } from '@/types';

/**
 * Compose the full system prompt for a conversation, combining:
 *   - The mode's base prompt (Chat / Code)
 *   - Global memory (CLAUDE.md-style persistent facts about the user)
 *   - A catalogue of skills relevant to the current mode
 *   - Any project-level instructions (project memory)
 *   - Any project knowledge files (injected as context)
 *
 * Runs on every turn so updates to memory / skills / project instructions
 * take effect immediately.
 *
 * Order matters: base → memory → skills → project instructions → project
 * knowledge. The model reads top-down, so identity (base) goes first, followed
 * by stable facts (memory), then reusable capabilities (skills), then
 * project-specific context that might override earlier defaults.
 */
export function composeSystemPrompt(options: {
  basePrompt: string;
  /** Current conversation mode. Used to filter which skills get injected. */
  mode: WorkMode;
  /** Global CLAUDE.md-style memory. Empty string → not injected. */
  globalMemory?: string;
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
    skills,
    project,
    knowledgeTokenBudget = 40_000,
  } = options;
  const parts: string[] = [basePrompt];

  if (globalMemory && globalMemory.trim()) {
    parts.push(
      [
        '',
        '## 用户记忆（持久事实）',
        '',
        '以下是关于用户的持久事实，适用于所有对话。在回答时请考虑这些背景，但不要每次都显式复述：',
        '',
        globalMemory.trim(),
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
