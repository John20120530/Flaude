/**
 * Desktop-only tools (file system + shell). Only registered when running
 * inside Tauri, and each one pulls the workspace path + allow-flags from
 * the app store at invocation time — so the user can flip permissions
 * without restarting.
 */

import { registerTool } from './tools';
import {
  fsListDir,
  fsReadFile,
  fsStat,
  fsWriteFile,
  isTauri,
  shellExec,
} from './tauri';
import { useAppStore } from '@/store/useAppStore';

/**
 * Helper: pull current workspace + permissions from the store. We read via
 * `getState` (not a hook) because tool handlers run outside React.
 */
function readDesktopState() {
  const s = useAppStore.getState();
  return {
    workspace: s.workspacePath,
    allowWrites: s.allowFileWrites,
    allowShell: s.allowShellExec,
  };
}

function requireWorkspace(): string {
  const { workspace } = readDesktopState();
  if (!workspace) {
    throw new Error(
      '未设置工作区。请在 Code 模式里点「打开工作区」选择一个文件夹。'
    );
  }
  return workspace;
}

/** Register all desktop tools. Safe to call more than once — registerTool overwrites. */
export function registerDesktopTools(): void {
  if (!isTauri()) return; // silent no-op in the browser

  registerTool({
    name: 'fs_list_dir',
    description:
      'List files and subdirectories under a path inside the current workspace. ' +
      'Use this to explore the project tree before reading or editing files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path relative to the workspace root (or absolute inside it). Use "." for the workspace root.',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Include dotfiles (.git, .env, …). Default false.',
        },
      },
      required: ['path'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ path, include_hidden }) => {
      const ws = requireWorkspace();
      const entries = await fsListDir(
        ws,
        String(path ?? '.'),
        Boolean(include_hidden)
      );
      if (entries.length === 0) return '(空目录)';
      return entries
        .map(
          (e) =>
            `${e.isDir ? 'd' : '-'} ${e.name}${e.isDir ? '/' : ''}` +
            (e.isDir ? '' : `  ${e.size}B`)
        )
        .join('\n');
    },
  });

  registerTool({
    name: 'fs_read_file',
    description:
      'Read a text file inside the current workspace. Large files are truncated at ~256 KB. ' +
      'Prefer reading before editing — do not invent code based on filenames alone.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to workspace root (or absolute inside it).',
        },
        max_bytes: {
          type: 'number',
          description: 'Optional read cap. Default 262144 (256 KB).',
        },
      },
      required: ['path'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ path, max_bytes }) => {
      const ws = requireWorkspace();
      return fsReadFile(
        ws,
        String(path),
        typeof max_bytes === 'number' ? max_bytes : undefined
      );
    },
  });

  registerTool({
    name: 'fs_stat',
    description:
      'Get metadata for a path (exists? file/dir? size? mtime?). Cheap way to check before reading.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ path }) => {
      const ws = requireWorkspace();
      const s = await fsStat(ws, String(path));
      return JSON.stringify(s, null, 2);
    },
  });

  registerTool({
    name: 'fs_write_file',
    description:
      'Create or overwrite a file inside the current workspace. ' +
      'DESTRUCTIVE: silently replaces the file. Ask the user before writing ' +
      'unless they clearly asked for the change. Requires user to have ' +
      'enabled "allow file writes" in settings.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        create_dirs: {
          type: 'boolean',
          description: 'Create parent directories if they don\'t exist. Default false.',
        },
      },
      required: ['path', 'content'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ path, content, create_dirs }) => {
      const { allowWrites } = readDesktopState();
      if (!allowWrites) {
        throw new Error(
          '文件写入被禁用。请在「设置 → 桌面」里启用「允许写入文件」后再调用。'
        );
      }
      const ws = requireWorkspace();
      await fsWriteFile(
        ws,
        String(path),
        String(content),
        Boolean(create_dirs)
      );
      return `已写入 ${path} (${(content as string).length} 字符)`;
    },
  });

  registerTool({
    name: 'shell_exec',
    description:
      'Run a shell command in the workspace. Returns stdout + stderr + exit code. ' +
      'DESTRUCTIVE: can delete files, push commits, etc. Ask the user first unless ' +
      'they asked for it. 30 s timeout. Requires user to have enabled "allow shell" in settings.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Executable name (e.g. "git", "npm", "python").',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments, already split. Do not rely on shell parsing.',
        },
        cwd: {
          type: 'string',
          description: 'Optional subdirectory of workspace. Defaults to workspace root.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in ms. Default 30000, max advisable 120000.',
        },
      },
      required: ['command'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ command, args, cwd, timeout_ms }) => {
      const { allowShell } = readDesktopState();
      if (!allowShell) {
        throw new Error(
          'Shell 执行被禁用。请在「设置 → 桌面」里启用「允许执行命令」后再调用。'
        );
      }
      const ws = requireWorkspace();
      const res = await shellExec({
        workspace: ws,
        command: String(command),
        args: Array.isArray(args) ? args.map(String) : [],
        cwd: typeof cwd === 'string' ? cwd : undefined,
        timeoutMs: typeof timeout_ms === 'number' ? timeout_ms : undefined,
      });
      // Normalise output for the model. Keep it compact.
      const head = `exit ${res.code}${res.timedOut ? ' (timed out)' : ''}`;
      const out = res.stdout.trim();
      const err = res.stderr.trim();
      const parts = [head];
      if (out) parts.push(`--- stdout ---\n${out}`);
      if (err) parts.push(`--- stderr ---\n${err}`);
      return parts.join('\n\n');
    },
  });
}
