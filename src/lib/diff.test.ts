/**
 * Tests for the line-level LCS diff.
 *
 * We don't bother testing with "a real diff library's output" as the oracle
 * — line-level LCS has well-defined semantics and the backtrack choice
 * (del-first when ties) is a stable contract. Instead we assert the
 * properties callers actually rely on: exact counts, reconstruction of
 * the new file from equal+add, and line-number indexing.
 */
import { describe, expect, it } from 'vitest';
import {
  diffLines,
  diffStats,
  DiffTooLargeError,
  MAX_LINES_PER_SIDE,
  type DiffLine,
} from './diff';

// Rebuild the new file from the diff — every equal + add should yield the
// new text verbatim. Rebuild the old file from equal + del. These are the
// two invariants that make a diff "correct" for any line-level algorithm.
function rebuildOld(lines: DiffLine[]): string {
  return lines
    .filter((l) => l.op === 'equal' || l.op === 'del')
    .map((l) => l.text)
    .join('\n');
}
function rebuildNew(lines: DiffLine[]): string {
  return lines
    .filter((l) => l.op === 'equal' || l.op === 'add')
    .map((l) => l.text)
    .join('\n');
}

describe('diffLines', () => {
  it('identical inputs produce all-equal ops', () => {
    const text = 'one\ntwo\nthree';
    const lines = diffLines(text, text);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.op === 'equal')).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(['one', 'two', 'three']);
  });

  it('empty old side produces all-add', () => {
    const lines = diffLines('', 'a\nb');
    expect(lines).toEqual([
      { op: 'add', text: 'a', newLine: 1 },
      { op: 'add', text: 'b', newLine: 2 },
    ]);
  });

  it('empty new side produces all-del', () => {
    const lines = diffLines('x\ny', '');
    expect(lines).toEqual([
      { op: 'del', text: 'x', oldLine: 1 },
      { op: 'del', text: 'y', oldLine: 2 },
    ]);
  });

  it('both empty produces empty diff', () => {
    expect(diffLines('', '')).toEqual([]);
  });

  it('pure insertion in the middle keeps surrounding equals', () => {
    const oldText = 'a\nb\nc';
    const newText = 'a\nNEW\nb\nc';
    const lines = diffLines(oldText, newText);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 0, unchanged: 3 });
    expect(rebuildOld(lines)).toBe(oldText);
    expect(rebuildNew(lines)).toBe(newText);
  });

  it('pure deletion keeps surrounding equals', () => {
    const oldText = 'a\nGONE\nb';
    const newText = 'a\nb';
    const lines = diffLines(oldText, newText);
    expect(diffStats(lines)).toEqual({ added: 0, removed: 1, unchanged: 2 });
    expect(rebuildOld(lines)).toBe(oldText);
    expect(rebuildNew(lines)).toBe(newText);
  });

  it('replacement of a single line', () => {
    const oldText = 'a\nold\nc';
    const newText = 'a\nnew\nc';
    const lines = diffLines(oldText, newText);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1, unchanged: 2 });
    expect(rebuildOld(lines)).toBe(oldText);
    expect(rebuildNew(lines)).toBe(newText);
  });

  it('line numbers are 1-indexed and track original positions', () => {
    const lines = diffLines('a\nb\nc', 'a\nX\nc');
    // Expect: equal a (1,1), del b (old 2), add X (new 2), equal c (3,3)
    expect(lines).toEqual([
      { op: 'equal', text: 'a', oldLine: 1, newLine: 1 },
      { op: 'del', text: 'b', oldLine: 2 },
      { op: 'add', text: 'X', newLine: 2 },
      { op: 'equal', text: 'c', oldLine: 3, newLine: 3 },
    ]);
  });

  it('CRLF is normalised to LF (Windows editor vs Unix file)', () => {
    const crlf = 'a\r\nb\r\nc';
    const lf = 'a\nb\nc';
    const lines = diffLines(crlf, lf);
    // All equal — line endings are not part of the content for diff purposes.
    expect(lines.every((l) => l.op === 'equal')).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it('trailing newline does not produce a phantom empty line', () => {
    const lines = diffLines('a\nb\n', 'a\nb');
    // Should be all-equal, 2 lines — the trailing newline is stripped.
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.op === 'equal')).toBe(true);
  });

  it('single-line input with no trailing newline', () => {
    const lines = diffLines('hello', 'world');
    expect(lines).toEqual([
      { op: 'del', text: 'hello', oldLine: 1 },
      { op: 'add', text: 'world', newLine: 1 },
    ]);
  });

  it('large-ish file (200 lines) runs quickly and reconstructs correctly', () => {
    const oldLines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const newLines = [...oldLines];
    newLines[50] = 'CHANGED';
    newLines.splice(100, 0, 'INSERTED');
    newLines.splice(150, 1);
    const diff = diffLines(oldLines.join('\n'), newLines.join('\n'));
    expect(rebuildOld(diff)).toBe(oldLines.join('\n'));
    expect(rebuildNew(diff)).toBe(newLines.join('\n'));
  });

  it('throws DiffTooLargeError when either side exceeds the cap', () => {
    const big = Array.from({ length: MAX_LINES_PER_SIDE + 1 }, (_, i) => `L${i}`).join('\n');
    expect(() => diffLines(big, 'short')).toThrow(DiffTooLargeError);
    expect(() => diffLines('short', big)).toThrow(DiffTooLargeError);
  });
});

describe('diffStats', () => {
  it('counts each op correctly', () => {
    const lines: DiffLine[] = [
      { op: 'equal', text: 'a' },
      { op: 'add', text: 'b' },
      { op: 'add', text: 'c' },
      { op: 'del', text: 'd' },
      { op: 'equal', text: 'e' },
    ];
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1, unchanged: 2 });
  });

  it('empty input', () => {
    expect(diffStats([])).toEqual({ added: 0, removed: 0, unchanged: 0 });
  });
});
