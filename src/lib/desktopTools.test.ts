/**
 * Tests for the desktop tool registrations (fs_* + shell_*).
 *
 * We don't exercise the actual Rust bridge — that's integration territory,
 * and the existing repo pattern is "mock `./tauri` exports, assert the
 * handler calls them with the right shape." These tests focus on the
 * gating logic (workspace unset → throws, permission off → throws) and the
 * normalisation we do around the background-shell tools (result-string
 * format, argument passthrough).
 *
 * `registerDesktopTools` bails early when `isTauri()` returns false, so we
 * stub it to `true` and pretend the bridge is there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { executeTool, unregisterTool } from './tools';

// Mock the whole tauri bridge. Each test can override individual returns via
// the exposed spies. We keep the mocks co-located with the test so a reader
// doesn't have to jump files to see what's faked.
vi.mock('./tauri', () => {
  return {
    isTauri: () => true,
    fsListDir: vi.fn(async () => []),
    fsReadFile: vi.fn(async () => ''),
    fsWriteFile: vi.fn(async () => undefined),
    fsStat: vi.fn(async () => ({
      isDir: false,
      isFile: true,
      isSymlink: false,
      size: 0,
      modifiedMs: 0,
    })),
    shellExec: vi.fn(async () => ({
      stdout: '',
      stderr: '',
      code: 0,
      timedOut: false,
    })),
    shellStart: vi.fn(async () => 'bg-42'),
    shellRead: vi.fn(async () => ({
      stdout: '',
      stderr: '',
      running: true,
      code: null,
      killed: false,
      stdoutDropped: 0,
      stderrDropped: 0,
    })),
    shellWriteStdin: vi.fn(async () => undefined),
    shellKill: vi.fn(async () => undefined),
    shellList: vi.fn(async () => []),
  };
});

// Import after the mock so desktopTools picks up the stubbed bridge.
import {
  shellKill,
  shellList,
  shellRead,
  shellStart,
  shellWriteStdin,
} from './tauri';
import { registerDesktopTools } from './desktopTools';

const INITIAL_STATE = useAppStore.getState();

// Ensure a clean registry + store per test. Desktop tool names are stable,
// so unregistering them before each re-register is safe.
const BG_TOOL_NAMES = [
  'shell_start',
  'shell_read',
  'shell_write',
  'shell_kill',
  'shell_list',
] as const;

beforeEach(() => {
  useAppStore.setState(INITIAL_STATE, true);
  for (const n of BG_TOOL_NAMES) unregisterTool(n);
  // Reset the mock call logs so each test starts clean.
  vi.mocked(shellStart).mockClear();
  vi.mocked(shellRead).mockClear();
  vi.mocked(shellWriteStdin).mockClear();
  vi.mocked(shellKill).mockClear();
  vi.mocked(shellList).mockClear();
  registerDesktopTools();
});

const ctx = { conversationId: 'conv-x' };

describe('shell_start', () => {
  it('throws when allowShellExec is off', async () => {
    useAppStore.setState({
      workspacePath: 'C:/ws',
      allowShellExec: false,
    });
    await expect(
      executeTool('shell_start', { command: 'echo', args: ['hi'] }, ctx)
    ).rejects.toThrow(/Shell 执行被禁用/);
    expect(shellStart).not.toHaveBeenCalled();
  });

  it('throws when workspace is unset, even with permission on', async () => {
    useAppStore.setState({
      workspacePath: null,
      allowShellExec: true,
    });
    await expect(
      executeTool('shell_start', { command: 'ls' }, ctx)
    ).rejects.toThrow(/工作区/);
  });

  it('forwards command/args/cwd to the bridge and returns the handle id in the message', async () => {
    useAppStore.setState({
      workspacePath: 'C:/ws',
      allowShellExec: true,
    });
    const msg = await executeTool(
      'shell_start',
      { command: 'npm', args: ['run', 'dev'], cwd: 'apps/web' },
      ctx
    );
    expect(shellStart).toHaveBeenCalledWith({
      workspace: 'C:/ws',
      command: 'npm',
      args: ['run', 'dev'],
      cwd: 'apps/web',
    });
    expect(msg).toContain('bg-42');
    expect(msg).toContain('shell_read');
  });

  it('defaults missing args to an empty array', async () => {
    useAppStore.setState({ workspacePath: 'C:/ws', allowShellExec: true });
    await executeTool('shell_start', { command: 'tsc' }, ctx);
    expect(shellStart).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'tsc', args: [] })
    );
  });
});

describe('shell_read', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: 'C:/ws', allowShellExec: true });
  });

  it('caps wait_ms to [0, 30000] before hitting the bridge', async () => {
    await executeTool('shell_read', { id: 'bg-1', wait_ms: 999_999 }, ctx);
    expect(shellRead).toHaveBeenCalledWith('bg-1', 30_000);

    await executeTool('shell_read', { id: 'bg-1', wait_ms: -5 }, ctx);
    expect(shellRead).toHaveBeenLastCalledWith('bg-1', 0);
  });

  it('formats a running process with no new output as a friendly placeholder', async () => {
    vi.mocked(shellRead).mockResolvedValueOnce({
      stdout: '',
      stderr: '',
      running: true,
      code: null,
      killed: false,
      stdoutDropped: 0,
      stderrDropped: 0,
    });
    const out = await executeTool('shell_read', { id: 'bg-1' }, ctx);
    expect(out).toContain('running');
    expect(out).toContain('暂无新输出');
  });

  it('summarises exited + killed status and shows dropped-byte warnings', async () => {
    vi.mocked(shellRead).mockResolvedValueOnce({
      stdout: 'out',
      stderr: 'err',
      running: false,
      code: 130,
      killed: true,
      stdoutDropped: 1024,
      stderrDropped: 0,
    });
    const out = await executeTool('shell_read', { id: 'bg-1' }, ctx);
    expect(out).toMatch(/exited code=130/);
    expect(out).toContain('killed');
    expect(out).toContain('1024 stdout bytes dropped');
    expect(out).toContain('--- stdout ---\nout');
    expect(out).toContain('--- stderr ---\nerr');
  });
});

describe('shell_write', () => {
  it('passes the raw data through untouched (no trailing \\n injected)', async () => {
    useAppStore.setState({ workspacePath: 'C:/ws', allowShellExec: true });
    await executeTool('shell_write', { id: 'bg-1', data: 'y' }, ctx);
    expect(shellWriteStdin).toHaveBeenCalledWith('bg-1', 'y');
  });
});

describe('shell_kill', () => {
  it('forwards the id', async () => {
    useAppStore.setState({ workspacePath: 'C:/ws', allowShellExec: true });
    await executeTool('shell_kill', { id: 'bg-1' }, ctx);
    expect(shellKill).toHaveBeenCalledWith('bg-1');
  });
});

describe('shell_list', () => {
  it('renders each entry with status + cmdline', async () => {
    useAppStore.setState({ workspacePath: 'C:/ws', allowShellExec: true });
    vi.mocked(shellList).mockResolvedValueOnce([
      {
        id: 'bg-1',
        command: 'npm',
        args: ['run', 'dev'],
        startedMs: 0,
        running: true,
        code: null,
        killed: false,
      },
      {
        id: 'bg-2',
        command: 'tsc',
        args: ['--noEmit'],
        startedMs: 0,
        running: false,
        code: 0,
        killed: false,
      },
    ]);
    const out = await executeTool('shell_list', {}, ctx);
    expect(out).toContain('bg-1');
    expect(out).toContain('running');
    expect(out).toContain('npm run dev');
    expect(out).toContain('bg-2');
    expect(out).toContain('exited 0');
  });

  it('returns a friendly empty message when the list is empty', async () => {
    useAppStore.setState({ workspacePath: 'C:/ws', allowShellExec: true });
    vi.mocked(shellList).mockResolvedValueOnce([]);
    const out = await executeTool('shell_list', {}, ctx);
    expect(out).toContain('没有后台 shell');
  });
});
