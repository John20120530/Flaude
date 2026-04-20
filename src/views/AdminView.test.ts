/**
 * Unit tests for AdminView helpers.
 *
 * We don't render the view here — it's a big page, node-env vitest has no
 * jsdom hook, and the repo's testing policy is "pure logic at the lib
 * level." But `formatRelativeTime` IS pure logic, and it's the piece most
 * likely to regress in a locale change or a refactor of the relative-time
 * buckets. Lifting it to a small exported helper lets the test live here.
 */
import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './AdminView';

describe('formatRelativeTime', () => {
  it('< 10 s reads as "刚刚"', () => {
    expect(formatRelativeTime(0)).toBe('刚刚');
    expect(formatRelativeTime(1_000)).toBe('刚刚');
    expect(formatRelativeTime(9_999)).toBe('刚刚');
  });

  it('10–59 s reads as seconds', () => {
    expect(formatRelativeTime(10_000)).toBe('10 秒前');
    expect(formatRelativeTime(45_000)).toBe('45 秒前');
    expect(formatRelativeTime(59_999)).toBe('59 秒前');
  });

  it('1–59 min reads as minutes', () => {
    expect(formatRelativeTime(60_000)).toBe('1 分钟前');
    expect(formatRelativeTime(30 * 60_000)).toBe('30 分钟前');
    expect(formatRelativeTime(59 * 60_000)).toBe('59 分钟前');
  });

  it('1–23 h reads as hours', () => {
    expect(formatRelativeTime(60 * 60_000)).toBe('1 小时前');
    expect(formatRelativeTime(23 * 60 * 60_000)).toBe('23 小时前');
  });

  it('≥ 24 h reads as days (escape hatch; view\'s title shows absolute timestamp)', () => {
    expect(formatRelativeTime(24 * 60 * 60_000)).toBe('1 天前');
    expect(formatRelativeTime(48 * 60 * 60_000)).toBe('2 天前');
  });

  it('negative elapsed (clock skew) clamps to "刚刚" rather than erroring', () => {
    expect(formatRelativeTime(-500)).toBe('刚刚');
  });
});
