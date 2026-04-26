import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadWorkspaceMemory,
  WORKSPACE_MEMORY_FILENAMES,
  WORKSPACE_MEMORY_MAX_BYTES,
} from './workspaceMemory';

vi.mock('./tauri', () => ({
  isTauri: vi.fn(),
  fsReadFile: vi.fn(),
}));

import { isTauri, fsReadFile } from './tauri';

const mockIsTauri = isTauri as unknown as ReturnType<typeof vi.fn>;
const mockFsReadFile = fsReadFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockIsTauri.mockReset();
  mockFsReadFile.mockReset();
  // Default to Tauri-on for the typical case; tests that exercise browser
  // mode override this explicitly.
  mockIsTauri.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('loadWorkspaceMemory', () => {
  it('returns null when not running in Tauri (browser mode)', async () => {
    mockIsTauri.mockReturnValue(false);
    const result = await loadWorkspaceMemory('/some/workspace');
    expect(result).toBeNull();
    expect(mockFsReadFile).not.toHaveBeenCalled();
  });

  it('returns null when workspace is null', async () => {
    const result = await loadWorkspaceMemory(null);
    expect(result).toBeNull();
    expect(mockFsReadFile).not.toHaveBeenCalled();
  });

  it('returns null when workspace is empty string', async () => {
    const result = await loadWorkspaceMemory('');
    expect(result).toBeNull();
    expect(mockFsReadFile).not.toHaveBeenCalled();
  });

  it('returns null when workspace is whitespace-only', async () => {
    const result = await loadWorkspaceMemory('   ');
    expect(result).toBeNull();
    expect(mockFsReadFile).not.toHaveBeenCalled();
  });

  it('prefers FLAUDE.md over CLAUDE.md when both exist', async () => {
    mockFsReadFile.mockImplementation(async (_ws, path) => {
      if (path === 'FLAUDE.md') return '# Flaude says hi';
      if (path === 'CLAUDE.md') return '# Claude says hi';
      throw new Error('not found');
    });
    const result = await loadWorkspaceMemory('/ws');
    expect(result).not.toBeNull();
    expect(result!.filename).toBe('FLAUDE.md');
    expect(result!.content).toBe('# Flaude says hi');
  });

  it('falls back to CLAUDE.md when FLAUDE.md is missing', async () => {
    mockFsReadFile.mockImplementation(async (_ws, path) => {
      if (path === 'FLAUDE.md') throw new Error('ENOENT');
      if (path === 'CLAUDE.md') return '# Claude conventions';
      throw new Error('not found');
    });
    const result = await loadWorkspaceMemory('/ws');
    expect(result!.filename).toBe('CLAUDE.md');
    expect(result!.content).toBe('# Claude conventions');
  });

  it('returns null when neither candidate exists', async () => {
    mockFsReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await loadWorkspaceMemory('/ws');
    expect(result).toBeNull();
    // Should have tried both candidates.
    expect(mockFsReadFile).toHaveBeenCalledTimes(WORKSPACE_MEMORY_FILENAMES.length);
  });

  it('treats an empty file as "no memory" and falls through to the next candidate', async () => {
    mockFsReadFile.mockImplementation(async (_ws, path) => {
      if (path === 'FLAUDE.md') return ''; // empty placeholder
      if (path === 'CLAUDE.md') return '# real content';
      throw new Error('not found');
    });
    const result = await loadWorkspaceMemory('/ws');
    expect(result!.filename).toBe('CLAUDE.md');
  });

  it('treats whitespace-only file the same as empty', async () => {
    mockFsReadFile.mockImplementation(async (_ws, path) => {
      if (path === 'FLAUDE.md') return '   \n\n  ';
      if (path === 'CLAUDE.md') return 'real';
      throw new Error('not found');
    });
    const result = await loadWorkspaceMemory('/ws');
    expect(result!.filename).toBe('CLAUDE.md');
  });

  it('reports byte size accurately for ASCII content', async () => {
    mockFsReadFile.mockResolvedValueOnce('hello world'); // 11 bytes
    const result = await loadWorkspaceMemory('/ws');
    expect(result!.sizeBytes).toBe(11);
    expect(result!.truncated).toBe(false);
  });

  it('reports byte size accurately for multi-byte UTF-8 (Chinese)', async () => {
    // "构建命令" = 4 chars, each 3 bytes in UTF-8 = 12 bytes.
    mockFsReadFile.mockResolvedValueOnce('构建命令');
    const result = await loadWorkspaceMemory('/ws');
    expect(result!.sizeBytes).toBe(12);
    expect(result!.truncated).toBe(false);
  });

  it('truncates content larger than MAX_BYTES and flags it', async () => {
    const oversized = 'a'.repeat(WORKSPACE_MEMORY_MAX_BYTES + 5_000);
    mockFsReadFile.mockResolvedValueOnce(oversized);
    const result = await loadWorkspaceMemory('/ws');
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.sizeBytes).toBe(oversized.length); // pre-truncation size
    // Truncated content + tail notice = roughly MAX_BYTES, not the oversized
    // length. We don't pin the exact length because the notice is a few dozen
    // bytes; just check it's much smaller than the original AND mentions the
    // truncation.
    expect(result!.content.length).toBeLessThan(oversized.length);
    expect(result!.content).toContain('已截断');
  });

  it('does not split a multi-byte codepoint at the truncation boundary', async () => {
    // Build a string whose byte boundary would land mid-character. Each '汉'
    // is 3 bytes, so MAX_BYTES + 1 of them definitely puts the cut mid-char.
    const charCount = Math.ceil(WORKSPACE_MEMORY_MAX_BYTES / 3) + 100;
    const oversized = '汉'.repeat(charCount);
    mockFsReadFile.mockResolvedValueOnce(oversized);
    const result = await loadWorkspaceMemory('/ws');
    expect(result!.truncated).toBe(true);
    // U+FFFD (replacement char) must not appear at the boundary — that's the
    // bug the byte-aware truncator is meant to prevent.
    expect(result!.content).not.toContain('�');
  });

  it('swallows IPC errors and tries the next candidate', async () => {
    const errs: string[] = [];
    mockFsReadFile.mockImplementation(async (_ws, path) => {
      errs.push(path);
      if (path === 'FLAUDE.md') throw new Error('permission denied');
      if (path === 'CLAUDE.md') return '# fallback worked';
      throw new Error('unreachable');
    });
    const result = await loadWorkspaceMemory('/ws');
    expect(result!.filename).toBe('CLAUDE.md');
    expect(errs).toEqual(['FLAUDE.md', 'CLAUDE.md']);
  });

  it('returns null when all candidates throw', async () => {
    mockFsReadFile.mockRejectedValue(new Error('boom'));
    const result = await loadWorkspaceMemory('/ws');
    expect(result).toBeNull();
  });

  it('returns null when fsReadFile resolves to a non-string (unexpected IPC shape)', async () => {
    mockFsReadFile.mockResolvedValue(undefined as unknown as string);
    const result = await loadWorkspaceMemory('/ws');
    expect(result).toBeNull();
  });
});
