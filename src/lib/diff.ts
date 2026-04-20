/**
 * Line-level diff for the write-approval modal.
 *
 * Pure. No DOM, no store, no React — deliberately testable in isolation.
 *
 * Why a hand-rolled LCS instead of the `diff` npm package: we only need
 * line-grain diffs for a "before applying, does this look right?" modal,
 * not char-level or word-level highlighting. An O(N*M) LCS is 30 lines,
 * well-understood, and saves a dependency. For the typical use case
 * (agent edits a 200-line source file) it runs in < 1ms.
 *
 * Safety cap: very large files would blow up the N*M DP table, so we
 * refuse to diff when either side exceeds MAX_LINES_PER_SIDE. Callers
 * can still render the new file in full via a different code path (e.g.
 * "new file preview") — this function just declines to align them.
 */

export type DiffOp = 'equal' | 'del' | 'add';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-indexed line number in the old file (undefined for 'add'). */
  oldLine?: number;
  /** 1-indexed line number in the new file (undefined for 'del'). */
  newLine?: number;
}

/**
 * Hard cap beyond which we bail on LCS to avoid a gigabyte DP table.
 * 5000 lines covers virtually every source file we'd write via
 * `fs_write_file`; anything bigger is almost certainly a misuse (a full
 * lockfile, bundled asset, etc.) and the modal can render a "too large
 * to diff" message instead.
 */
export const MAX_LINES_PER_SIDE = 5000;

/**
 * Thrown when either side exceeds MAX_LINES_PER_SIDE. The modal catches
 * this and falls back to a non-diff preview.
 */
export class DiffTooLargeError extends Error {
  constructor(public oldLines: number, public newLines: number) {
    super(
      `diff too large: ${oldLines} old lines × ${newLines} new lines (cap ${MAX_LINES_PER_SIDE})`,
    );
    this.name = 'DiffTooLargeError';
  }
}

/**
 * Compute line-level diff between oldText and newText.
 *
 * Handles:
 *  - trailing newline normalisation (so "a\nb" and "a\nb\n" produce the
 *    same line count)
 *  - CRLF → LF (silently) so Windows-authored vs Unix-authored files don't
 *    read as all-different
 *  - empty input on either side (returns pure add / pure del)
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length > MAX_LINES_PER_SIDE || b.length > MAX_LINES_PER_SIDE) {
    throw new DiffTooLargeError(a.length, b.length);
  }

  // Trivial cases — saves building the table.
  if (a.length === 0) {
    return b.map((text, i) => ({ op: 'add', text, newLine: i + 1 }));
  }
  if (b.length === 0) {
    return a.map((text, i) => ({ op: 'del', text, oldLine: i + 1 }));
  }

  // Build LCS length table. dp[i][j] = LCS length of a[0..i] and b[0..j].
  const N = a.length;
  const M = b.length;
  const dp: number[][] = Array.from({ length: N + 1 }, () =>
    new Array<number>(M + 1).fill(0),
  );
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = dp[i - 1][j] >= dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
      }
    }
  }

  // Backtrack to recover the edit script. Note: we push in reverse-walk
  // order and reverse at the end, so the LAST branch taken at a tie ends
  // up FIRST in the final output. To produce the unified-diff-standard
  // "DEL before ADD" ordering on a replacement, ties must prefer the
  // ADD branch here (j--), pushing ADD earlier so DEL lands later =
  // appears first after the reverse.
  const out: DiffLine[] = [];
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ op: 'equal', text: a[i - 1], oldLine: i, newLine: j });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      out.push({ op: 'del', text: a[i - 1], oldLine: i });
      i--;
    } else {
      out.push({ op: 'add', text: b[j - 1], newLine: j });
      j--;
    }
  }
  while (i > 0) {
    out.push({ op: 'del', text: a[i - 1], oldLine: i });
    i--;
  }
  while (j > 0) {
    out.push({ op: 'add', text: b[j - 1], newLine: j });
    j--;
  }
  return out.reverse();
}

/**
 * Summary counts — useful for the modal header ("+12 / -3").
 */
export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const l of lines) {
    if (l.op === 'add') added++;
    else if (l.op === 'del') removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}

/**
 * Split a blob of text into lines. Normalises CRLF to LF and drops a
 * single trailing newline so "a\nb\n".split() doesn't produce a phantom
 * empty final line. Empty input returns []; single-line-no-newline
 * returns a one-element array.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const stripped = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return stripped.split('\n');
}
