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
import { requestWriteApproval } from './writeApproval';

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
      'The user is shown a diff and must click Apply before the write happens — ' +
      'so you can propose changes freely, but the user always has final say. ' +
      'Requires user to have enabled "allow file writes" in settings.',
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
      const filePath = String(path);
      const newContent = String(content);
      const createDirs = Boolean(create_dirs);

      // Snapshot the current file so the approval modal can show a diff.
      // A read error almost always means "file doesn't exist yet" (ENOENT) —
      // treat as a new-file create. We don't try to distinguish "exists but
      // unreadable" here because the subsequent fsWriteFile will surface
      // any real permissions issue with a clearer message.
      let oldContent = '';
      let isNewFile = false;
      try {
        oldContent = await fsReadFile(ws, filePath);
      } catch {
        isNewFile = true;
      }

      // Short-circuit no-op writes — the model sometimes re-issues a write
      // with identical content after re-reading a file it already edited.
      // Surfacing a "diff with 0 changes" modal would be noise; just return.
      if (!isNewFile && oldContent === newContent) {
        return `${filePath} 已是目标内容，跳过写入。`;
      }

      const approved = await requestWriteApproval({
        path: filePath,
        oldContent,
        newContent,
        isNewFile,
        createDirs,
      });
      if (!approved) {
        throw new Error(`用户拒绝写入 ${filePath}`);
      }

      await fsWriteFile(ws, filePath, newContent, createDirs);
      return `已写入 ${filePath} (${newContent.length} 字符)`;
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
