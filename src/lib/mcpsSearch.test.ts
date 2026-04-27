/**
 * Client-side tests for searchMcpsMarket.
 *
 * Like skillsSearch.test.ts, the wrapper is mostly a typed adapter over
 * `authGetJson` — the federated logic lives server-side. We pin:
 *   - empty / whitespace queries short-circuit
 *   - the wrapper passes the trimmed query as a URL-encoded `q` param
 *   - the response shape is propagated unchanged
 *   - errors propagate
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./flaudeApi', () => ({
  authGetJson: vi.fn(),
}));

import { authGetJson } from './flaudeApi';
import { searchMcpsMarket, type McpSearchResult } from './mcpsSearch';

const mockedAuthGetJson = vi.mocked(authGetJson);

beforeEach(() => {
  mockedAuthGetJson.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fakeResult(overrides: Partial<McpSearchResult> = {}): McpSearchResult {
  return {
    id: 'npm:test',
    title: 'test',
    description: '',
    publisher: 'someone',
    sources: ['npm'],
    sourceUrls: {},
    endpointType: 'stdio-tauri',
    trustTier: 'unaudited',
    signals: { isOfficialPublisher: false },
    tags: [],
    ...overrides,
  };
}

describe('searchMcpsMarket', () => {
  it('returns empty results without hitting network for empty query', async () => {
    const r = await searchMcpsMarket('');
    expect(r.results).toEqual([]);
    expect(r.fromCache).toBe(false);
    expect(mockedAuthGetJson).not.toHaveBeenCalled();
  });

  it('returns empty results for whitespace-only query', async () => {
    const r = await searchMcpsMarket('   \t\n  ');
    expect(r.results).toEqual([]);
    expect(mockedAuthGetJson).not.toHaveBeenCalled();
  });

  it('forwards the trimmed URL-encoded query', async () => {
    mockedAuthGetJson.mockResolvedValue({
      query: 'memory',
      results: [],
      fromCache: false,
      sourceCounts: { pulsemcp: 0, glama: 0, npm: 0, github: 0 },
    });
    await searchMcpsMarket('  memory  ');
    expect(mockedAuthGetJson).toHaveBeenCalledWith(
      '/api/mcps/search?q=memory',
    );
  });

  it('URL-encodes special characters', async () => {
    mockedAuthGetJson.mockResolvedValue({
      query: 'a b/c',
      results: [],
      fromCache: false,
      sourceCounts: { pulsemcp: 0, glama: 0, npm: 0, github: 0 },
    });
    await searchMcpsMarket('a b/c');
    expect(mockedAuthGetJson).toHaveBeenCalledWith(
      '/api/mcps/search?q=a%20b%2Fc',
    );
  });

  it('returns the response shape unchanged', async () => {
    const result = fakeResult({
      id: 'npm:@modelcontextprotocol/server-memory',
      trustTier: 'official',
      signals: {
        isOfficialPublisher: true,
        npmWeeklyDownloads: 73823,
        license: 'MIT',
      },
    });
    mockedAuthGetJson.mockResolvedValue({
      query: 'memory',
      results: [result],
      fromCache: true,
      sourceCounts: { pulsemcp: 5, glama: 3, npm: 30, github: 10 },
    });

    const r = await searchMcpsMarket('memory');
    expect(r.results).toEqual([result]);
    expect(r.fromCache).toBe(true);
    expect(r.sourceCounts).toEqual({ pulsemcp: 5, glama: 3, npm: 30, github: 10 });
  });

  it('propagates errors from authGetJson', async () => {
    mockedAuthGetJson.mockRejectedValue(new Error('502 upstream'));
    await expect(searchMcpsMarket('foo')).rejects.toThrow(/502 upstream/);
  });

  it('handles a missing results field gracefully', async () => {
    mockedAuthGetJson.mockResolvedValue({} as never);
    const r = await searchMcpsMarket('foo');
    expect(r.results).toEqual([]);
    expect(r.fromCache).toBe(false);
  });
});
