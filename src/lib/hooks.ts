/**
 * Hook execution runtime — pure helpers + the shell-runner glue.
 *
 * The pure parts (matchTool, interpolateCommand, shellQuote) are unit-
 * tested directly. The shell-runner (`runHook`) is integration-tested via
 * the chat hook end-to-end since mocking shellExec out is more brittle
 * than just running it under Tauri.
 *
 * Why a separate module from store/UI:
 *   - Same cycle-avoidance reason as planMode.ts and writeApproval.ts —
 *     the runtime has to be importable from useStreamedChat without
 *     dragging in React or component code.
 *   - Pure helpers stay easy to refactor (variable substitution rules
 *     are the kind of thing we'll iterate on).
 */

import type { Hook } from '@/types';
import { isTauri, shellExec } from './tauri';

// ---------------------------------------------------------------------------
// Tool name matching
// ---------------------------------------------------------------------------

/**
 * Match a hook's `toolMatcher` against a runtime tool name.
 *
 * Matcher syntax (kept dead simple — anything more elaborate is just
 * confusing for hook authors):
 *   - Empty / undefined → matches nothing
 *   - '*' → matches any tool name
 *   - 'fs_write_file' → exact match
 *   - 'fs_write_file|shell_exec' → either exact match
 *
 * Whitespace around `|` is tolerated; we trim both sides.
 */
export function matchTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return false;
  const trimmed = matcher.trim();
  if (trimmed === '*') return true;
  for (const part of trimmed.split('|')) {
    if (part.trim() === toolName) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

export interface HookVars {
  /** Tool name that triggered the hook ('' for stop event). */
  tool: string;
  /** Workspace path the user picked in Code mode. */
  workspace: string;
  /** For fs_write_file: the path argument. Empty for other tools. */
  file: string;
  /** Full tool args as JSON. Useful for hook scripts that want to inspect. */
  argsJson: string;
}

/**
 * Replace `$FLAUDE_*` variables in a command string with their runtime
 * values. We do this BEFORE wrapping with `cmd /c` / `sh -c` so the values
 * land in the command string exactly once and don't depend on shell
 * variable scoping (which differs between cmd / PowerShell / bash).
 *
 * Each substitution is shell-quoted so paths / JSON with spaces don't
 * break the shell parsing. On Windows we use double-quote quoting (cmd's
 * native form), on POSIX single-quote. The caller passes `platform`
 * because we can't probe it from a pure helper that needs to be
 * deterministic in tests.
 *
 * Unknown variables (e.g. `$FLAUDE_BANANA`) are left as-is — feels less
 * surprising than silently empty-substituting, since a typo is easier to
 * spot in the output.
 */
export function interpolateCommand(
  command: string,
  vars: HookVars,
  platform: 'windows' | 'posix',
): string {
  return command.replace(/\$FLAUDE_(\w+)/g, (match, name) => {
    const value = lookupVar(name, vars);
    if (value === null) return match;
    return shellQuote(value, platform);
  });
}

function lookupVar(name: string, vars: HookVars): string | null {
  switch (name.toUpperCase()) {
    case 'TOOL':
      return vars.tool;
    case 'WORKSPACE':
      return vars.workspace;
    case 'FILE':
      return vars.file;
    case 'ARGS_JSON':
      return vars.argsJson;
    default:
      return null;
  }
}

/**
 * Shell-quote a single argument so it survives `cmd /c` (Windows) or
 * `sh -c` (POSIX) parsing as one token.
 *
 * Single-quote on POSIX: wraps in `'...'`, replaces inner `'` with `'\''`.
 * Double-quote on Windows: wraps in `"..."`, escapes inner `"` as `""`
 *   (cmd-style) and backticks/dollars are NOT special so we leave them
 *   alone. Newlines in args are rare; we strip them rather than risk
 *   cmd parsing oddities.
 */
export function shellQuote(value: string, platform: 'windows' | 'posix'): string {
  if (platform === 'windows') {
    const sanitized = value.replace(/[\r\n]/g, ' ');
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Detect platform once at module load. Browser test envs default to posix. */
function detectPlatform(): 'windows' | 'posix' {
  if (typeof navigator === 'undefined') return 'posix';
  if (/Windows/i.test(navigator.userAgent)) return 'windows';
  return 'posix';
}

// ---------------------------------------------------------------------------
// Hook execution
// ---------------------------------------------------------------------------

export interface HookResult {
  /** Exit code; -1 if we never managed to spawn the shell. */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** If the hook itself errored before/while spawning. */
  spawnError?: string;
}

/**
 * Run a single hook. Returns the result; never throws (hook authoring
 * mistakes shouldn't crash the chat loop). Caller decides whether to
 * block (pre_tool_use), feed to agent (post_tool_use), or discard (stop).
 */
export async function runHook(hook: Hook, vars: HookVars): Promise<HookResult> {
  if (!isTauri()) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: 'Hooks 仅在桌面版可用（浏览器没有 shell 子系统）。',
    };
  }
  if (!vars.workspace) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: '当前没有工作区——hook 不会执行。请先在 Code 模式打开工作区。',
    };
  }

  const platform = detectPlatform();
  const interpolated = interpolateCommand(hook.command, vars, platform);

  // Wrap with the platform shell so user can write the command natural-
  // language ("pnpm tsc --noEmit" not ["pnpm", "tsc", "--noEmit"]).
  const [shellCmd, shellFirstArg] =
    platform === 'windows' ? ['cmd', '/c'] : ['sh', '-c'];

  try {
    const r = await shellExec({
      workspace: vars.workspace,
      command: shellCmd,
      args: [shellFirstArg, interpolated],
      timeoutMs: hook.timeoutMs > 0 ? hook.timeoutMs : 30_000,
    });
    return {
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
    };
  } catch (e) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: (e as Error).message ?? '未知错误',
    };
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Render a hook's stdout/stderr for inclusion in the tool result text the
 * model sees on the next round-trip. Keep it compact + clearly labeled so
 * the model doesn't confuse hook output with the tool's own output.
 *
 * Empty input → empty output (no header noise).
 */
export function formatHookOutputForAgent(
  hookName: string,
  result: HookResult,
): string {
  if (result.spawnError) {
    return `\n\n[hook "${hookName}" 启动失败：${result.spawnError}]`;
  }
  const parts: string[] = [];
  parts.push(`\n\n[hook "${hookName}" exit ${result.code}${result.timedOut ? ' (timed out)' : ''}]`);
  if (result.stdout.trim()) {
    parts.push(`stdout:\n${truncate(result.stdout, 4000)}`);
  }
  if (result.stderr.trim()) {
    parts.push(`stderr:\n${truncate(result.stderr, 4000)}`);
  }
  return parts.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[... 已截断，原长 ${s.length} 字符]`;
}
