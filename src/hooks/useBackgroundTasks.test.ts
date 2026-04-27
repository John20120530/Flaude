/**
 * Pure-logic tests for the background-tasks hook. The polling/effect
 * surface itself is exercised via browser preview during the release
 * verification — we don't pull in @testing-library/react just for the
 * unit suite, since the meaningful state machine is the running→done
 * diff (a pure function).
 */
import { describe, expect, it } from 'vitest';
import { diffNewlyCompleted, snapshotOf, updateObservedEndedMs } from './useBackgroundTasks';
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

describe('updateObservedEndedMs', () => {
  it('records `now` for tasks that just transitioned running→done', () => {
    const prevSnap = new Map<string, boolean>([['a', true], ['b', true]]);
    const prevEnded = new Map<string, number>();
    const latest = [
      task({ id: 'a', running: false, code: 0 }),
      task({ id: 'b', running: true }),
    ];
    const out = updateObservedEndedMs(prevSnap, prevEnded, latest, 9999);
    expect(out.get('a')).toBe(9999);
    expect(out.has('b')).toBe(false); // still running
  });

  it('preserves an already-recorded endedMs across subsequent polls', () => {
    const prevSnap = new Map<string, boolean>([['a', false]]);
    const prevEnded = new Map<string, number>([['a', 1000]]);
    const latest = [task({ id: 'a', running: false, code: 0 })];
    const out = updateObservedEndedMs(prevSnap, prevEnded, latest, 9999);
    expect(out.get('a')).toBe(1000); // not 9999 — keep the original observation
  });

  it('records endedMs for a first-time-seen finished task (sub-second commands that completed within one polling interval)', () => {
    // Common case: agent calls shell_start("node -e 'console.log(\"hi\"); process.exit(2)'"),
    // task finishes in milliseconds, our first poll sees it already done.
    // Since bgshell is in-memory only (no app-restart persistence), we can
    // safely treat `now` as approximate end time — off by at most one poll
    // interval, which formatDuration renders as "<1 秒" anyway for these
    // fast tasks.
    const prevSnap = new Map<string, boolean>(); // empty — first poll
    const prevEnded = new Map<string, number>();
    const latest = [task({ id: 'a', running: false, code: 0 })];
    const out = updateObservedEndedMs(prevSnap, prevEnded, latest, 9999);
    expect(out.get('a')).toBe(9999);
  });

  it('drops entries for tasks the panel forgot about (id removed from registry)', () => {
    const prevSnap = new Map<string, boolean>([['a', false], ['b', true]]);
    const prevEnded = new Map<string, number>([['a', 1000]]);
    // Latest only has 'b' — 'a' was shellRemove'd.
    const latest = [task({ id: 'b', running: true })];
    const out = updateObservedEndedMs(prevSnap, prevEnded, latest, 9999);
    expect(out.has('a')).toBe(false);
  });

  it('handles concurrent finishers with the same `now`', () => {
    const prevSnap = new Map<string, boolean>([['a', true], ['b', true]]);
    const prevEnded = new Map<string, number>();
    const latest = [
      task({ id: 'a', running: false, code: 0 }),
      task({ id: 'b', running: false, code: 1 }),
    ];
    const out = updateObservedEndedMs(prevSnap, prevEnded, latest, 5555);
    expect(out.get('a')).toBe(5555);
    expect(out.get('b')).toBe(5555);
  });

  it('round-trips with snapshotOf — second poll on still-finished task preserves end time', () => {
    // First poll: a is running.
    const after1 = [task({ id: 'a', running: true })];
    const snap1 = snapshotOf(after1);
    const ended1 = updateObservedEndedMs(new Map(), new Map(), after1, 1000);
    expect(ended1.has('a')).toBe(false);

    // Second poll: a finished.
    const after2 = [task({ id: 'a', running: false, code: 0 })];
    const ended2 = updateObservedEndedMs(snap1, ended1, after2, 2000);
    expect(ended2.get('a')).toBe(2000);

    // Third poll: a still finished. Should keep 2000, not advance.
    const snap2 = snapshotOf(after2);
    const ended3 = updateObservedEndedMs(snap2, ended2, after2, 3000);
    expect(ended3.get('a')).toBe(2000);
  });
});
