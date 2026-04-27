/**
 * Pure-logic tests for the background-tasks hook. The polling/effect
 * surface itself is exercised via browser preview during the release
 * verification — we don't pull in @testing-library/react just for the
 * unit suite, since the meaningful state machine is the running→done
 * diff (a pure function).
 */
import { describe, expect, it } from 'vitest';
import { diffNewlyCompleted, snapshotOf } from './useBackgroundTasks';
import type { BgShellInfo } from '@/lib/tauri';

const task = (over: Partial<BgShellInfo> = {}): BgShellInfo => ({
  id: over.id ?? 't1',
  command: over.command ?? 'pnpm test',
  args: over.args ?? [],
  startedMs: over.startedMs ?? 1000,
  running: over.running ?? true,
  code: over.code ?? null,
  killed: over.killed ?? false,
});

describe('snapshotOf', () => {
  it('returns an empty map for an empty list', () => {
    expect(snapshotOf([])).toEqual(new Map());
  });

  it('maps each task id to its running flag', () => {
    const m = snapshotOf([
      task({ id: 'a', running: true }),
      task({ id: 'b', running: false }),
    ]);
    expect(m.get('a')).toBe(true);
    expect(m.get('b')).toBe(false);
  });

  it('handles duplicate ids by taking the last one (defensive — the bgshell registry should never produce dupes)', () => {
    const m = snapshotOf([
      task({ id: 'a', running: true }),
      task({ id: 'a', running: false }),
    ]);
    expect(m.get('a')).toBe(false);
  });
});

describe('diffNewlyCompleted', () => {
  it('returns nothing on an empty current list', () => {
    expect(diffNewlyCompleted(new Map([['a', true]]), [])).toEqual([]);
  });

  it('returns nothing when nothing transitioned', () => {
    const prev = new Map<string, boolean>([['a', true]]);
    const out = diffNewlyCompleted(prev, [task({ id: 'a', running: true })]);
    expect(out).toEqual([]);
  });

  it('reports a task that flipped running=true → running=false', () => {
    const prev = new Map<string, boolean>([['a', true]]);
    const out = diffNewlyCompleted(prev, [task({ id: 'a', running: false, code: 0 })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('a');
  });

  it('reports multiple concurrent finishers', () => {
    const prev = new Map<string, boolean>([
      ['a', true],
      ['b', true],
      ['c', true],
    ]);
    const out = diffNewlyCompleted(prev, [
      task({ id: 'a', running: false, code: 0 }),
      task({ id: 'b', running: false, code: 1 }),
      task({ id: 'c', running: true }),
    ]);
    expect(out.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('does NOT report a task that was already false in the snapshot', () => {
    // Already finished by the time we observed it last poll.
    const prev = new Map<string, boolean>([['a', false]]);
    const out = diffNewlyCompleted(prev, [task({ id: 'a', running: false, code: 0 })]);
    expect(out).toEqual([]);
  });

  it('does NOT report a task that we are seeing for the FIRST time as already-finished', () => {
    // App start case: registry has stale finished tasks. Seeing them now
    // doesn't mean they "just" finished.
    const prev = new Map<string, boolean>(); // empty — we never saw them
    const out = diffNewlyCompleted(prev, [task({ id: 'a', running: false, code: 0 })]);
    expect(out).toEqual([]);
  });

  it('does NOT report a task that was running and is still running', () => {
    const prev = new Map<string, boolean>([['a', true]]);
    const out = diffNewlyCompleted(prev, [task({ id: 'a', running: true })]);
    expect(out).toEqual([]);
  });

  it('does not get confused by a task that was kill()d (running=false, killed=true)', () => {
    // A killed task is still a running→done transition the panel should
    // notice. We DO count it; the panel renders a different badge.
    const prev = new Map<string, boolean>([['a', true]]);
    const out = diffNewlyCompleted(prev, [
      task({ id: 'a', running: false, killed: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.killed).toBe(true);
  });

  it('round-trips with snapshotOf — feed the new tasks back through to detect zero diffs on next poll', () => {
    // Cycle: seen-as-running → seen-as-done (diff fires once) →
    // seen-as-done-again (no diff this time).
    const after1 = [task({ id: 'a', running: true })];
    const snap1 = snapshotOf(after1);

    const after2 = [task({ id: 'a', running: false, code: 0 })];
    const diff2 = diffNewlyCompleted(snap1, after2);
    expect(diff2).toHaveLength(1);

    const snap2 = snapshotOf(after2);
    const diff3 = diffNewlyCompleted(snap2, after2);
    expect(diff3).toEqual([]);
  });
});
