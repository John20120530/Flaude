/**
 * Slash commands — user-triggered shortcuts typed at the start of the composer.
 *
 * Two kinds:
 *   - template: the command's `template` string is expanded and inserted into
 *     the composer. `{{input}}` is replaced with whatever the user typed after
 *     the command. `{{clipboard}}` is replaced with the current clipboard.
 *   - action:   runs a built-in handler that mutates UI / conversation state.
 *     The `action` field names the handler (see ACTION_HANDLERS below).
 *
 * Built-ins ship from this file and are re-seeded on app startup (see the
 * store's onRehydrateStorage hook). Users can also define their own via the
 * settings page — those have `builtin: false`.
 */

import type { SlashCommand } from '@/types';

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'builtin-sum',
    trigger: '/sum',
    description: '总结给定内容的要点',
    kind: 'template',
    template:
      '请用简洁的中文总结以下内容的 3–5 个要点（条目形式）：\n\n{{input}}',
    builtin: true,
  },
  {
    id: 'builtin-translate-en',
    trigger: '/tr-en',
    description: '翻译为英文（保留 Markdown 格式）',
    kind: 'template',
    template:
      'Translate the following into natural, fluent English. Preserve Markdown formatting (code blocks, lists, links). Output only the translation:\n\n{{input}}',
    builtin: true,
  },
  {
    id: 'builtin-translate-cn',
    trigger: '/tr-cn',
    description: '翻译为中文（保留格式）',
    kind: 'template',
    template:
      '把下面内容翻译为自然、地道的中文，保留 Markdown 格式（代码块、列表、链接）。只输出译文：\n\n{{input}}',
    builtin: true,
  },
  {
    id: 'builtin-explain',
    trigger: '/explain',
    description: '解释一段代码或概念',
    kind: 'template',
    template:
      '请解释下面这段内容，面向中级工程师。说明它是做什么的、关键机制、可能的坑：\n\n{{input}}',
    builtin: true,
  },
  {
    id: 'builtin-improve',
    trigger: '/improve',
    description: '润色/改进一段文字',
    kind: 'template',
    template:
      '请改进下面这段文字：使其更清晰、更有条理，去掉冗余。保持原意和语气。输出改写后的版本 + 一行说明你改了什么：\n\n{{input}}',
    builtin: true,
  },
  {
    id: 'builtin-clear',
    trigger: '/clear',
    description: '清空当前对话（仅清消息，不删对话）',
    kind: 'action',
    action: 'clear',
    builtin: true,
  },
  {
    id: 'builtin-help',
    trigger: '/help',
    description: '显示可用的斜杠命令',
    kind: 'action',
    action: 'help',
    builtin: true,
  },
  {
    id: 'builtin-memory',
    trigger: '/memory',
    description: '打开全局记忆编辑器（Settings → 记忆）',
    kind: 'action',
    action: 'memory-open',
    builtin: true,
  },
  {
    id: 'builtin-remember',
    trigger: '/remember',
    description: '把后面的一句话加入全局记忆（如 `/remember 我偏好 pnpm 不用 npm`）',
    kind: 'action',
    action: 'memory-append',
    builtin: true,
  },
];

/**
 * Expand a slash-command template. `{{input}}` is the user's text after the
 * command; `{{clipboard}}` is an optional clipboard snapshot supplied by the
 * caller (we can't read the clipboard synchronously from the composer without
 * a user gesture, so we do it on trigger).
 */
export function expandTemplate(
  template: string,
  vars: { input?: string; clipboard?: string }
): string {
  return template
    .replace(/\{\{input\}\}/g, vars.input ?? '')
    .replace(/\{\{clipboard\}\}/g, vars.clipboard ?? '');
}

/**
 * Match a composer input that starts with a slash command. Returns the command
 * trigger and the remaining "input" text, or null if not a command.
 */
export function parseSlashInput(
  text: string,
  commands: SlashCommand[]
): { command: SlashCommand; input: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return null;
  // First whitespace separates trigger from input
  const match = trimmed.match(/^(\/\S+)\s*([\s\S]*)$/);
  if (!match) return null;
  const [, trigger, input] = match;
  const cmd = commands.find((c) => c.trigger === trigger);
  if (!cmd) return null;
  return { command: cmd, input };
}

/**
 * Fuzzy-match commands against a prefix (e.g. "/tr" matches both "/tr-en" and
 * "/tr-cn"). Keeps only triggers that start with the typed prefix.
 */
export function suggestCommands(
  prefix: string,
  commands: SlashCommand[]
): SlashCommand[] {
  const p = prefix.trim();
  if (!p.startsWith('/')) return [];
  return commands
    .filter((c) => c.trigger.startsWith(p))
    .sort((a, b) => a.trigger.localeCompare(b.trigger));
}
