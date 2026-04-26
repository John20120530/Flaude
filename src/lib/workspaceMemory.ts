/**
 * Workspace-level memory: a `FLAUDE.md` (preferred) or `CLAUDE.md` (fallback)
 * file at the workspace root that gets auto-injected into the Code-mode
 * system prompt. The point is to let users version-control project
 * conventions ("我们用 pnpm 不用 npm", "构建命令是 pnpm tauri:dev") with
 * the codebase itself, instead of re-typing them every conversation.
 *
 * Why both filenames:
 *   - FLAUDE.md is the project's own brand and avoids stomping on a repo
 *     that already has a Claude Code-specific CLAUDE.md (some users will
 *     want them to diverge — e.g. tell Claude to be terse, tell Flaude
 *     to be verbose because it's running on a smaller model).
 *   - CLAUDE.md fallback is for the much more common case where the user
 *     already wrote one for Claude Code and just wants Flaude to honor it.
 *
 * Lookup is workspace-root only — no nested or parent-directory walking
 * yet. Anthropic's Claude Code does multi-level CLAUDE.md, but for v0.1
 * "just the root" covers the 80% case at zero extra complexity.
 *
 * Size cap: 100 KB. A reasonable CLAUDE.md is ~2-10 KB; anything larger
 * is probably checked in by mistake (a generated changelog, a giant
 * prompt template). Truncating with a notice prevents one rogue file
 * from eating the entire token budget.
 */

import { fsReadFile, isTauri } from './tauri';

/** Filenames probed in order. The first one that loads wins. */
export const WORKSPACE_MEMORY_FILENAMES = ['FLAUDE.md', 'CLAUDE.md'] as const;

/** Hard cap on the file we'll inject. Larger files get truncated with a notice. */
export const WORKSPACE_MEMORY_MAX_BYTES = 100 * 1024;

export interface WorkspaceMemory {
  /** Which filename actually loaded (so the UI can show "FLAUDE.md (2.1 KB)"). */
  filename: string;
  /** File content, possibly truncated to MAX_BYTES + a tail notice. */
  content: string;
  /** Original byte count (pre-truncation). */
  sizeBytes: number;
  /** True if `content` was cut to fit MAX_BYTES. */
  truncated: boolean;
}

/**
 * Try to load workspace memory. Returns null when:
 *   - Not running in Tauri (browser version has no file system),
 *   - workspace is null/empty,
 *   - neither candidate file exists or both are unreadable.
 *
 * Errors from `fsReadFile` are intentionally swallowed: the most common
 * cause is "file doesn't exist," which we treat as "no memory" rather than
 * surfacing an alarming error to the user. If both candidates fail we
 * just return null and the system prompt skips the section.
 */
export async function loadWorkspaceMemory(
  workspace: string | null | undefined
): Promise<WorkspaceMemory | null> {
  if (!isTauri()) return null;
  if (!workspace || !workspace.trim()) return null;

  for (const filename of WORKSPACE_MEMORY_FILENAMES) {
    try {
      // Read with a generous cap (2x our injection limit) so we can detect
      // truncation accurately. The Rust side has its own 256 KB plain-text
      // cap, so this won't actually request more than that.
      const raw = await fsReadFile(workspace, filename, WORKSPACE_MEMORY_MAX_BYTES * 2);
      if (typeof raw !== 'string') continue;
      // We treat empty file as "no memory" — an empty CLAUDE.md is almost
      // certainly a placeholder, not an intentional empty injection.
      if (!raw.trim()) continue;

      const sizeBytes = byteLength(raw);
      const truncated = sizeBytes > WORKSPACE_MEMORY_MAX_BYTES;
      const content = truncated
        ? truncateToBytes(raw, WORKSPACE_MEMORY_MAX_BYTES) +
          `\n\n[... ${filename} 超过 ${WORKSPACE_MEMORY_MAX_BYTES / 1024} KB，已截断]`
        : raw;

      return { filename, content, sizeBytes, truncated };
    } catch {
      // File not found / unreadable / Rust IPC error — try the next candidate.
      continue;
    }
  }
  return null;
}

/** UTF-8 byte length of a string (TextEncoder is fastest + always available). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Truncate to <= maxBytes UTF-8 bytes without splitting a multi-byte
 * codepoint. Naive `slice(0, n)` would chop a Chinese character in half
 * mid-sequence and leave a U+FFFD replacement char at the boundary.
 */
function truncateToBytes(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8', { fatal: false });
  const bytes = enc.encode(s);
  if (bytes.length <= maxBytes) return s;
  // Decode-then-look-back: TextDecoder with fatal:false will emit U+FFFD
  // for partial sequences at the tail. We trim those U+FFFD off so the
  // boundary is clean.
  const decoded = dec.decode(bytes.slice(0, maxBytes));
  return decoded.replace(/�+$/u, '');
}
