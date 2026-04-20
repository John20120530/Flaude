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
  shellKill,
  shellList,
  shellRead,
  shellStart,
  shellWriteStdin,
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

  // ---------------------------------------------------------------------
  // Persistent / background shell — for long-running commands that
  // `shell_exec` can't serve (dev servers, REPLs, log tails, etc.).
  //
  // Pattern mirrors Claude Code's `Bash(run_in_background=true)` +
  // `BashOutput`: spawn, poll for new output, optionally send stdin, kill.
  // ---------------------------------------------------------------------

  registerTool({
    name: 'shell_start',
    description:
      'Start a long-running command in the background and return a handle id. ' +
      'Use this INSTEAD of shell_exec for anything that does not exit on its own ' +
      '(dev servers like `npm run dev`, watch processes, REPLs, log tails). ' +
      'Use shell_read with the returned id to drain output as it arrives, ' +
      'shell_write to send stdin, and shell_kill to stop the process. ' +
      'Max 8 concurrent background shells per session. ' +
      'Requires "allow shell" in settings.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable name.' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments, already split.',
        },
        cwd: {
          type: 'string',
          description: 'Optional subdirectory of workspace. Defaults to workspace root.',
        },
      },
      required: ['command'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ command, args, cwd }) => {
      const { allowShell } = readDesktopState();
      if (!allowShell) {
        throw new Error(
          'Shell 执行被禁用。请在「设置 → 桌面」里启用「允许执行命令」后再调用。'
        );
      }
      const ws = requireWorkspace();
      const id = await shellStart({
        workspace: ws,
        command: String(command),
        args: Array.isArray(args) ? args.map(String) : [],
        cwd: typeof cwd === 'string' ? cwd : undefined,
      });
      return `已启动后台进程，id=${id}。使用 shell_read({ id: "${id}" }) 获取输出。`;
    },
  });

  registerTool({
    name: 'shell_read',
    description:
      'Drain buffered stdout/stderr from a background shell started with shell_start. ' +
      'Each call returns and clears anything buffered since the previous call, plus ' +
      'the current running/exited status. Set wait_ms to block for up to that many ms ' +
      'when nothing is buffered yet (useful right after issuing a command via ' +
      'shell_write, to let the process print a response). Default wait_ms=0 returns immediately.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Handle id from shell_start.' },
        wait_ms: {
          type: 'number',
          description:
            'Max ms to wait when buffers are empty. 0 returns immediately. ' +
            'Use 1000–5000 to let an interactive command print a response.',
        },
      },
      required: ['id'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ id, wait_ms }) => {
      const { allowShell } = readDesktopState();
      if (!allowShell) {
        throw new Error('Shell 执行被禁用。');
      }
      const res = await shellRead(
        String(id),
        typeof wait_ms === 'number' ? Math.max(0, Math.min(30_000, wait_ms)) : 0
      );
      const lines: string[] = [];
      if (res.running) {
        lines.push(`running (id=${id})`);
      } else {
        const how = res.killed ? ' (killed)' : '';
        lines.push(`exited code=${res.code ?? -1}${how} (id=${id})`);
      }
      if (res.stdoutDropped > 0) {
        lines.push(`[⚠ ${res.stdoutDropped} stdout bytes dropped due to overflow]`);
      }
      if (res.stderrDropped > 0) {
        lines.push(`[⚠ ${res.stderrDropped} stderr bytes dropped due to overflow]`);
      }
      const out = res.stdout.trim();
      const err = res.stderr.trim();
      if (out) lines.push(`--- stdout ---\n${out}`);
      if (err) lines.push(`--- stderr ---\n${err}`);
      if (!out && !err && res.running) {
        lines.push('(暂无新输出)');
      }
      return lines.join('\n\n');
    },
  });

  registerTool({
    name: 'shell_write',
    description:
      'Send text to a background shell\'s stdin. Most commands expect a trailing ' +
      'newline — include "\\n" explicitly when that matters (e.g. answering a prompt). ' +
      'No-op if the shell has already exited.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        data: { type: 'string', description: 'Raw bytes to write. Include \\n if needed.' },
      },
      required: ['id', 'data'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ id, data }) => {
      const { allowShell } = readDesktopState();
      if (!allowShell) {
        throw new Error('Shell 执行被禁用。');
      }
      await shellWriteStdin(String(id), String(data));
      return `已写入 ${String(data).length} 字符到 ${id}`;
    },
  });

  registerTool({
    name: 'shell_kill',
    description:
      'Terminate a background shell started with shell_start. Always call this ' +
      'when you are done with a long-running process so it does not linger.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    },
    source: 'builtin',
    modes: ['code'],
    handler: async ({ id }) => {
      const { allowShell } = readDesktopState();
      if (!allowShell) {
        throw new Error('Shell 执行被禁用。');
      }
      await shellKill(String(id));
      return `已发送终止信号到 ${id}`;
    },
  });

  registerTool({
    name: 'shell_list',
    description:
      'List every background shell started in this session (running and recently ' +
      'exited). Useful if you lose track of which handles are live. Newest first.',
    parameters: { type: 'object', properties: {} },
    source: 'builtin',
    modes: ['code'],
    handler: async () => {
      const { allowShell } = readDesktopState();
      if (!allowShell) {
        throw new Error('Shell 执行被禁用。');
      }
      const list = await shellList();
      if (list.length === 0) return '(没有后台 shell)';
      return list
        .map((s) => {
          const status = s.running
            ? 'running'
            : `exited ${s.code ?? -1}${s.killed ? ' (killed)' : ''}`;
          const cmdline = [s.command, ...s.args].join(' ');
          return `${s.id}  [${status}]  ${cmdline}`;
        })
        .join('\n');
    },
  });
}
