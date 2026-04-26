/**
 * Thin typed bridge to the Rust side. Everything in this file is a no-op in
 * a plain browser — `isTauri()` returns false and the invoke wrappers throw
 * a helpful message. That way the same codebase runs in `pnpm dev` (browser)
 * and `pnpm tauri dev` (desktop) without conditional imports everywhere.
 */

// Tauri 2 injects `window.__TAURI_INTERNALS__`; v1 used `window.__TAURI__`.
// We check both to stay compatible if users are on an older toolchain.
interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as TauriWindow;
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

/**
 * Dynamically import the Tauri API so a plain browser build doesn't crash on
 * the bare import. Exported so sibling bridge modules (e.g. `pty.ts`) can
 * reuse the same guarded-invoke pattern without duplicating the isTauri
 * check and the helpful error message.
 */
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(
      `命令 ${cmd} 仅在桌面版可用。请使用 \`pnpm tauri dev\` 启动，或安装已发布的 Flaude 桌面客户端。`
    );
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// FS bridge (mirrors src-tauri/src/lib.rs)
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modifiedMs: number;
}

interface RawDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified_ms: number;
}

export interface FileStat {
  isDir: boolean;
  isFile: boolean;
  isSymlink: boolean;
  size: number;
  modifiedMs: number;
}

interface RawFileStat {
  is_dir: boolean;
  is_file: boolean;
  is_symlink: boolean;
  size: number;
  modified_ms: number;
}

export async function fsListDir(
  workspace: string,
  path: string,
  includeHidden = false
): Promise<DirEntry[]> {
  const raw = await tauriInvoke<RawDirEntry[]>('fs_list_dir', {
    workspace,
    path,
    includeHidden,
  });
  return raw.map((e) => ({
    name: e.name,
    path: e.path,
    isDir: e.is_dir,
    isSymlink: e.is_symlink,
    size: e.size,
    modifiedMs: e.modified_ms,
  }));
}

export async function fsReadFile(
  workspace: string,
  path: string,
  maxBytes?: number
): Promise<string> {
  return tauriInvoke<string>('fs_read_file', { workspace, path, maxBytes });
}

/**
 * Explicit text extraction for Office (.xlsx / .xls / .xlsm / .xlsb / .docx /
 * .pptx) and PDF files. Returns clean markdown — tables for spreadsheets,
 * paragraphs for documents, slide-numbered sections for presentations,
 * page-stripped text for PDF.
 *
 * Note: `fsReadFile` already auto-routes to the same backend implementation
 * when it sees one of these extensions. This standalone function is here for
 * the rarer case where the caller knows the format up front and wants to
 * skip the existence + extension sniff (e.g. processing a drag-and-dropped
 * file before deciding whether to attach it as text or image).
 */
export async function officeExtract(
  workspace: string,
  path: string
): Promise<string> {
  return tauriInvoke<string>('office_extract', { workspace, path });
}

export async function fsWriteFile(
  workspace: string,
  path: string,
  content: string,
  createDirs = false
): Promise<void> {
  return tauriInvoke<void>('fs_write_file', {
    workspace,
    path,
    content,
    createDirs,
  });
}

export async function fsStat(workspace: string, path: string): Promise<FileStat> {
  const raw = await tauriInvoke<RawFileStat>('fs_stat', { workspace, path });
  return {
    isDir: raw.is_dir,
    isFile: raw.is_file,
    isSymlink: raw.is_symlink,
    size: raw.size,
    modifiedMs: raw.modified_ms,
  };
}

// ---------------------------------------------------------------------------
// Shell bridge
// ---------------------------------------------------------------------------

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

interface RawShellResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
}

export interface ShellOptions {
  workspace: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export async function shellExec(opts: ShellOptions): Promise<ShellResult> {
  const raw = await tauriInvoke<RawShellResult>('shell_exec', {
    params: {
      workspace: opts.workspace,
      command: opts.command,
      args: opts.args ?? [],
      cwd: opts.cwd,
      timeout_ms: opts.timeoutMs,
    },
  });
  return {
    stdout: raw.stdout,
    stderr: raw.stderr,
    code: raw.code,
    timedOut: raw.timed_out,
  };
}

// ---------------------------------------------------------------------------
// Background shell bridge (agent-oriented persistent processes).
//
// Unlike shellExec (one-shot), these wrap the `shell_start` / `shell_read` /
// `shell_write` / `shell_kill` commands that let the Code agent spawn a
// long-running process and drain its output on demand. See
// src-tauri/src/bgshell.rs for the protocol.
// ---------------------------------------------------------------------------

export interface BgShellStartOptions {
  workspace: string;
  command: string;
  args?: string[];
  cwd?: string;
}

export interface BgShellReadResult {
  stdout: string;
  stderr: string;
  running: boolean;
  code: number | null;
  killed: boolean;
  stdoutDropped: number;
  stderrDropped: number;
}

interface RawBgShellRead {
  stdout: string;
  stderr: string;
  running: boolean;
  code: number | null;
  killed: boolean;
  stdout_dropped: number;
  stderr_dropped: number;
}

export interface BgShellInfo {
  id: string;
  command: string;
  args: string[];
  startedMs: number;
  running: boolean;
  code: number | null;
  killed: boolean;
}

interface RawBgShellInfo {
  id: string;
  command: string;
  args: string[];
  started_ms: number;
  running: boolean;
  code: number | null;
  killed: boolean;
}

/** Start a background process. Returns a handle id for subsequent calls. */
export async function shellStart(opts: BgShellStartOptions): Promise<string> {
  const raw = await tauriInvoke<{ id: string }>('shell_start', {
    workspace: opts.workspace,
    command: opts.command,
    args: opts.args ?? [],
    cwd: opts.cwd,
  });
  return raw.id;
}

/**
 * Drain buffered stdout/stderr since the last read. If `waitMs` > 0 and there's
 * nothing buffered yet, blocks up to that many ms waiting for new output or an
 * exit transition.
 */
export async function shellRead(
  id: string,
  waitMs = 0
): Promise<BgShellReadResult> {
  const raw = await tauriInvoke<RawBgShellRead>('shell_read', {
    id,
    waitMs,
  });
  return {
    stdout: raw.stdout,
    stderr: raw.stderr,
    running: raw.running,
    code: raw.code,
    killed: raw.killed,
    stdoutDropped: raw.stdout_dropped,
    stderrDropped: raw.stderr_dropped,
  };
}

/** Push bytes to the child process's stdin. The child sees them when it next reads. */
export function shellWriteStdin(id: string, data: string): Promise<void> {
  return tauriInvoke<void>('shell_write', { id, data });
}

/**
 * Terminate the child process. Platform-specific signal (SIGKILL on Unix,
 * TerminateProcess on Windows). Safe to call once per handle; subsequent
 * calls after natural exit are no-ops.
 */
export function shellKill(id: string): Promise<void> {
  return tauriInvoke<void>('shell_kill', { id });
}

/** List every live handle (running and recently exited). Newest first. */
export async function shellList(): Promise<BgShellInfo[]> {
  const raw = await tauriInvoke<RawBgShellInfo[]>('shell_list', {});
  return raw.map((r) => ({
    id: r.id,
    command: r.command,
    args: r.args,
    startedMs: r.started_ms,
    running: r.running,
    code: r.code,
    killed: r.killed,
  }));
}

/** Forget a handle and free its buffers. Kills the process first if still running. */
export function shellRemove(id: string): Promise<void> {
  return tauriInvoke<void>('shell_remove', { id });
}

// ---------------------------------------------------------------------------
// Dialog bridge (uses tauri-plugin-dialog)
// ---------------------------------------------------------------------------

/** Ask the user to pick a folder. Returns null if they cancel. */
export async function pickFolder(title = '选择工作区'): Promise<string | null> {
  if (!isTauri()) {
    throw new Error('文件夹选择仅在桌面版可用');
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const res = await open({ directory: true, multiple: false, title });
  if (!res) return null;
  return typeof res === 'string' ? res : (res as unknown as string);
}

// ---------------------------------------------------------------------------
// Download / save bridge
// ---------------------------------------------------------------------------

export interface SaveFileFilter {
  /** Display name shown in the OS save dialog (e.g. "Markdown"). */
  name: string;
  /** Extensions without the dot, e.g. `["md", "markdown"]`. */
  extensions: string[];
}

/**
 * Show the OS-native save-file dialog, then write `content` to whatever path
 * the user picks. Returns the chosen path, or `null` if they cancelled.
 *
 * Tauri-only. In a plain browser this throws.
 */
export async function saveTextFileDialog(
  defaultName: string,
  content: string,
  filters?: SaveFileFilter[]
): Promise<string | null> {
  if (!isTauri()) throw new Error('saveTextFileDialog 仅在桌面版可用');
  const { save } = await import('@tauri-apps/plugin-dialog');
  const picked = await save({
    defaultPath: defaultName,
    filters: filters ?? [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (!picked) return null;
  const path = typeof picked === 'string' ? picked : String(picked);
  await tauriInvoke<void>('save_text_file', { path, content });
  return path;
}

/**
 * Save text content to disk. In Tauri, pops the native save dialog so the
 * user picks the path (required: WebView2 on Windows silently swallows
 * `<a download>` clicks for Blob URLs — our previous approach looked like
 * it worked but actually saved nothing). In a plain browser, falls back to
 * the classic Blob + `<a download>` pattern.
 *
 * Returns the saved path (Tauri) / filename (browser), or null if the user
 * cancelled the Tauri dialog. Throws on actual write errors.
 *
 * No-op outside a browser/Tauri environment (SSR / tests without jsdom).
 */
export async function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/markdown;charset=utf-8'
): Promise<string | null> {
  if (isTauri()) {
    const ext = (filename.match(/\.([^.]+)$/)?.[1] || 'md').toLowerCase();
    return saveTextFileDialog(filename, content, [
      { name: ext.toUpperCase(), extensions: [ext] },
    ]);
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  // Must be in the DOM for Firefox to honor the click.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to initiate the download before we revoke.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}
