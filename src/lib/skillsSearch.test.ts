/**
 * Client-side tests for the skillsSearch wrapper.
 *
 * The wrapper is mostly a typed adapter over `authGetJson` — Worker
 * integration is covered by the server-side tests in
 * `server/test/skillsSearch.spec.ts`. Here we just pin:
 *   - empty / whitespace queries short-circuit without a network call
 *   - the wrapper returns the parsed shape unchanged
 *   - thrown errors propagate
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./flaudeApi', () => ({
  authGetJson: vi.fn(),
}));

import { authGetJson } from './flaudeApi';
import { searchSkillsMarket } from './skillsSearch';

const mockedAuthGetJson = vi.mocked(authGetJson);

beforeEach(() => {
  mockedAuthGetJson.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchSkillsMarket', () => {
  it('returns empty results without hitting the network for empty query', async () => {
    const r = await searchSkillsMarket('');
    expect(r.results).toEqual([]);
    expect(r.fromCache).toBe(false);
    expect(mockedAuthGetJson).not.toHaveBeenCalled();
  });

  it('returns empty results without hitting the network for whitespace-only query', async () => {
    const r = await searchSkillsMarket('   \t\n  ');
    expect(r.results).toEqual([]);
    expect(mockedAuthGetJson).not.toHaveBeenCalled();
  });

  it('forwards the trimmed query and returns the server response shape', async () => {
    mockedAuthGetJson.mockResolvedValue({
      query: 'java',
      results: [
        {
          id: 'foo/bar:SKILL.md',
          title: 'Java Clean Code',
          description: 'desc',
          publisher: '@foo',
          publisherUrl: 'https://github.com/foo',
          source: 'foo/bar · GitHub',
          sourceUrl: 'https://github.com/foo/bar',
          rawUrl: 'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
          license: 'MIT',
          modes: [],
          tags: ['github-search'],
        },
      ],
      fromCache: false,
    });

    const r = await searchSkillsMarket('  java  ');
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.title).toBe('Java Clean Code');
    expect(mockedAuthGetJson).toHaveBeenCalledWith(
      '/api/skills/search?q=java',
    );
  });

  it('URL-encodes special characters in the query', async () => {
    mockedAuthGetJson.mockResolvedValue({
      query: 'a b/c',
      results: [],
      fromCache: false,
    });
    await searchSkillsMarket('a b/c');
    expect(mockedAuthGetJson).toHaveBeenCalledWith(
      '/api/skills/search?q=a%20b%2Fc',
    );
  });

  it('propagates errors from the underlying fetch', async () => {
    mockedAuthGetJson.mockRejectedValue(new Error('502 upstream'));
    await expect(searchSkillsMarket('foo')).rejects.toThrow(/502 upstream/);
  });

  it('handles a missing results field gracefully', async () => {
    // Server contract says results[] but defensive code.
    mockedAuthGetJson.mockResolvedValue({} as never);
    const r = await searchSkillsMarket('foo');
    expect(r.results).toEqual([]);
    expect(r.fromCache).toBe(false);
  });
});
