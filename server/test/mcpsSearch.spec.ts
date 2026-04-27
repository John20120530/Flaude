/**
 * Tests for /api/mcps/search.
 *
 * Layered:
 *   - Pure helpers: parseGitHubPath, canonicalIdFrom, scoreOf
 *   - Per-adapter pipelines (PulseMCP / Glama / npm / GitHub) against a
 *     mocked global fetch — proves shape extraction and id canonicalization
 *   - Merge logic: cross-source dedup + trust tier classification
 *   - End-to-end: a query that exercises all 4 adapters and verifies
 *     the merged + ranked result respects the trust + cross-source bonus
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __test, type McpSearchResult } from '../src/mcpsSearch';

const {
  parseGitHubPath,
  canonicalIdFrom,
  searchPulseMCP,
  searchGlama,
  searchNpm,
  searchGitHub,
  searchOfficialMcpPackages,
  mergeAndScore,
  scoreOf,
} = __test;

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// =============================================================================
// parseGitHubPath
// =============================================================================

describe('parseGitHubPath', () => {
  it('handles plain https URL', () => {
    expect(parseGitHubPath('https://github.com/foo/bar')).toBe('foo/bar');
  });
  it('strips .git suffix', () => {
    expect(parseGitHubPath('https://github.com/foo/bar.git')).toBe('foo/bar');
  });
  it('strips git+ prefix', () => {
    expect(parseGitHubPath('git+https://github.com/foo/bar.git')).toBe('foo/bar');
  });
  it('handles npm shorthand `github:owner/repo`', () => {
    expect(parseGitHubPath('github:foo/bar')).toBe('foo/bar');
  });
  it('strips trailing path segments', () => {
    expect(parseGitHubPath('https://github.com/foo/bar/tree/main/src')).toBe(
      'foo/bar',
    );
  });
  it('returns null for non-github URLs', () => {
    expect(parseGitHubPath('https://gitlab.com/foo/bar')).toBeNull();
    expect(parseGitHubPath('https://example.com')).toBeNull();
    expect(parseGitHubPath('')).toBeNull();
  });
});

// =============================================================================
// canonicalIdFrom
// =============================================================================

describe('canonicalIdFrom', () => {
  it('prefers npm name over github path', () => {
    expect(
      canonicalIdFrom({
        npmPackageName: '@scope/pkg',
        githubFullName: 'foo/bar',
      }),
    ).toBe('npm:@scope/pkg');
  });
  it('falls back to github path when no npm', () => {
    expect(canonicalIdFrom({ githubFullName: 'foo/bar' })).toBe('gh:foo/bar');
  });
  it('lower-cases github paths to dedupe foo/Bar vs foo/bar', () => {
    expect(canonicalIdFrom({ githubFullName: 'Foo/Bar' })).toBe('gh:foo/bar');
  });
  it('returns null when neither available', () => {
    expect(canonicalIdFrom({})).toBeNull();
  });
});

// =============================================================================
// scoreOf — used to rank merged results
// =============================================================================

describe('scoreOf', () => {
  function r(partial: Partial<McpSearchResult>): McpSearchResult {
    return {
      id: 'npm:test',
      title: 't',
      description: '',
      publisher: '',
      sources: ['npm'],
      sourceUrls: {},
      endpointType: 'stdio-tauri',
      trustTier: 'unaudited',
      signals: { isOfficialPublisher: false },
      tags: [],
      ...partial,
    };
  }

  it('official tier dominates', () => {
    const off = scoreOf(r({ trustTier: 'official' }));
    const pop = scoreOf(
      r({
        trustTier: 'popular',
        signals: { isOfficialPublisher: false, githubStars: 5000, npmWeeklyDownloads: 50000 },
      }),
    );
    expect(off).toBeGreaterThan(pop);
  });
  it('popular tier with high signals beats unaudited even with mid signals', () => {
    const popHi = scoreOf(
      r({
        trustTier: 'popular',
        signals: { isOfficialPublisher: false, githubStars: 800 },
      }),
    );
    const unaudited = scoreOf(
      r({
        trustTier: 'unaudited',
        signals: { isOfficialPublisher: false, githubStars: 100 },
      }),
    );
    expect(popHi).toBeGreaterThan(unaudited);
  });
  it('cross-source presence adds bonus', () => {
    const single = scoreOf(r({ sources: ['npm'] }));
    const triple = scoreOf(r({ sources: ['npm', 'pulsemcp', 'glama'] }));
    expect(triple - single).toBeGreaterThan(0);
  });
});

// =============================================================================
// Adapters — fake global fetch, verify each emits the correct partial shape
// =============================================================================

function fetchMock(urls: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const matchKey = Object.keys(urls).find((k) => url.startsWith(k));
    if (!matchKey) {
      return new Response('not mocked: ' + url, { status: 404 });
    }
    return new Response(JSON.stringify(urls[matchKey]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('searchPulseMCP', () => {
  it('extracts npm + github + remote URL + trust signals', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'https://api.pulsemcp.com/v0beta/servers': {
          servers: [
            {
              name: 'Memory',
              url: 'https://www.pulsemcp.com/servers/memory',
              short_description: 'Knowledge graph memory',
              source_code_url:
                'https://github.com/modelcontextprotocol/servers',
              github_stars: 5000,
              package_registry: 'npm',
              package_name: '@modelcontextprotocol/server-memory',
              package_download_count: 200_000, // monthly-ish
              remotes: [],
            },
          ],
        },
      }),
    );

    const out = await searchPulseMCP('memory');
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.id).toBe('npm:@modelcontextprotocol/server-memory');
    expect(r.title).toBe('Memory');
    expect(r.description).toBe('Knowledge graph memory');
    expect(r.npmPackageName).toBe('@modelcontextprotocol/server-memory');
    expect(r.githubStars).toBe(5000);
    expect(r.npmWeeklyDownloads).toBe(50_000); // 200000/4 monthly→weekly
    expect(r.source).toBe('pulsemcp');
  });

  it('extracts HTTP remote when present', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'https://api.pulsemcp.com/v0beta/servers': {
          servers: [
            {
              name: 'Hosted MCP',
              url: 'https://www.pulsemcp.com/servers/hosted',
              short_description: 'A hosted server',
              source_code_url: 'https://github.com/foo/hosted',
              remotes: [
                {
                  url_direct: 'https://hosted.example.com/mcp',
                  transport: 'sse',
                },
              ],
            },
          ],
        },
      }),
    );

    const out = await searchPulseMCP('hosted');
    expect(out[0]!.endpointUrl).toBe('https://hosted.example.com/mcp');
  });

  it('drops servers with neither npm nor github (uninstallable)', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'https://api.pulsemcp.com/v0beta/servers': {
          servers: [
            { name: 'phantom', short_description: 'no install path' },
          ],
        },
      }),
    );
    const out = await searchPulseMCP('whatever');
    expect(out).toHaveLength(0);
  });
});

describe('searchGlama', () => {
  it('extracts repo + license + envKeys', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'https://glama.ai/api/mcp/v1/servers': {
          servers: [
            {
              id: 'abc123',
              name: 'github-mcp',
              namespace: 'modelcontextprotocol',
              description: 'GitHub server',
              repository: {
                url: 'https://github.com/modelcontextprotocol/servers',
              },
              slug: 'github-mcp',
              spdxLicense: { name: 'MIT License' },
              url: 'https://glama.ai/mcp/servers/abc123',
              attributes: ['hosting:local-only'],
              environmentVariablesJsonSchema: {
                properties: {
                  GITHUB_PERSONAL_ACCESS_TOKEN: { description: 'PAT' },
                },
                required: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
              },
              tools: [],
            },
          ],
        },
      }),
    );

    const out = await searchGlama('github');
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.id).toBe('gh:modelcontextprotocol/servers');
    expect(r.envKeys).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
    expect(r.license).toBe('MIT');
    expect(r.source).toBe('glama');
  });
});

describe('searchNpm', () => {
  it('extracts package + downloads + license', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'https://registry.npmjs.org/-/v1/search': {
          objects: [
            {
              package: {
                name: '@modelcontextprotocol/server-filesystem',
                description: 'MCP filesystem server',
                license: 'MIT',
                date: '2026-01-15T00:00:00Z',
                publisher: { username: 'modelcontextprotocol' },
                links: {
                  npm: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem',
                  repository:
                    'git+https://github.com/modelcontextprotocol/servers.git',
                },
              },
              downloads: { weekly: 50_000 },
            },
          ],
        },
      }),
    );

    const out = await searchNpm('filesystem');
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.id).toBe('npm:@modelcontextprotocol/server-filesystem');
    expect(r.npmPackageName).toBe('@modelcontextprotocol/server-filesystem');
    expect(r.npmWeeklyDownloads).toBe(50_000);
    expect(r.license).toBe('MIT');
    expect(r.lastUpdate).toBe('2026-01-15T00:00:00Z');
    expect(r.githubFullName).toBe('modelcontextprotocol/servers');
  });
});

describe('searchGitHub', () => {
  it('extracts repo + stars + license + last update', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'https://api.github.com/search/repositories': {
          items: [
            {
              name: 'cool-mcp',
              full_name: 'someone/cool-mcp',
              description: 'A cool MCP',
              html_url: 'https://github.com/someone/cool-mcp',
              stargazers_count: 234,
              pushed_at: '2026-04-01T00:00:00Z',
              license: { spdx_id: 'Apache-2.0' },
              owner: {
                login: 'someone',
                html_url: 'https://github.com/someone',
              },
            },
          ],
        },
      }),
    );

    const out = await searchGitHub('cool', 'fake-token');
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.id).toBe('gh:someone/cool-mcp');
    expect(r.githubStars).toBe(234);
    expect(r.license).toBe('Apache-2.0');
    expect(r.installInstructionsHint).toContain('README');
  });

  it('passes Authorization header when token is provided', async () => {
    const mock = fetchMock({
      'https://api.github.com/search/repositories': { items: [] },
    });
    vi.stubGlobal('fetch', mock);

    await searchGitHub('q', 'my-pat');
    const call = mock.mock.calls[0]!;
    const init = call[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-pat');
  });

  it('skips Authorization when token is missing (graceful unauthenticated path)', async () => {
    const mock = fetchMock({
      'https://api.github.com/search/repositories': { items: [] },
    });
    vi.stubGlobal('fetch', mock);

    await searchGitHub('q', undefined);
    const call = mock.mock.calls[0]!;
    const init = call[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

// =============================================================================
// searchOfficialMcpPackages — direct probe for stem-matched names
// =============================================================================

describe('searchOfficialMcpPackages', () => {
  it('returns no probes for empty / whitespace queries', async () => {
    const results = await searchOfficialMcpPackages('');
    expect(results).toEqual([]);
  });

  it('returns no probes when query stems do not match any official package', async () => {
    // No fetch should be made — we'd 404 on a mocked-empty fetch and the
    // test would still pass, but checking explicitly defends against
    // future regressions where stem matching becomes too loose.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const results = await searchOfficialMcpPackages('nonexistent-thing-xyz');
    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probes the matching official package and emits a PartialResult', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('https://registry.npmjs.org/@modelcontextprotocol/server-memory')) {
          return new Response(
            JSON.stringify({
              name: '@modelcontextprotocol/server-memory',
              description: 'MCP server for enabling memory through a knowledge graph',
              license: 'MIT',
              'dist-tags': { latest: '2026.1.26' },
              time: { '2026.1.26': '2026-01-27T09:25:54.132Z' },
              repository: {
                url: 'git+https://github.com/modelcontextprotocol/servers.git',
              },
            }),
            { status: 200 },
          );
        }
        if (url.startsWith('https://api.npmjs.org/downloads/point/last-week/@modelcontextprotocol/server-memory')) {
          return new Response(JSON.stringify({ downloads: 73823 }), {
            status: 200,
          });
        }
        return new Response('not mocked: ' + url, { status: 404 });
      }),
    );

    const results = await searchOfficialMcpPackages('memory');
    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(r.id).toBe('npm:@modelcontextprotocol/server-memory');
    expect(r.npmPackageName).toBe('@modelcontextprotocol/server-memory');
    expect(r.npmWeeklyDownloads).toBe(73823);
    expect(r.lastUpdate).toBe('2026-01-27T09:25:54.132Z');
    expect(r.githubFullName).toBe('modelcontextprotocol/servers');
  });

  it('matches multiple stems when query has multiple tokens', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls++;
        // Pretend everything 200s with minimal valid response.
        if (url.startsWith('https://registry.npmjs.org/')) {
          const m = url.match(/registry\.npmjs\.org\/(.+)$/)!;
          return new Response(
            JSON.stringify({
              name: decodeURIComponent(m[1]!),
              description: 'foo',
              license: 'MIT',
              'dist-tags': { latest: '1.0.0' },
              time: { '1.0.0': '2026-01-01' },
              repository: { url: 'https://github.com/modelcontextprotocol/servers' },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ downloads: 100 }), { status: 200 });
      }),
    );

    // Query has two distinct stems matching: filesystem + github
    const results = await searchOfficialMcpPackages('filesystem github');
    // Both stems matched, so we probe both packages → 2 results.
    expect(results.length).toBe(2);
    expect(results.map((r) => r.npmPackageName).sort()).toEqual([
      '@modelcontextprotocol/server-filesystem',
      '@modelcontextprotocol/server-github',
    ]);
  });

  it('skips a candidate that 404s from npm (deleted package)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const results = await searchOfficialMcpPackages('memory');
    expect(results).toEqual([]);
  });
});

// =============================================================================
// mergeAndScore — cross-source dedup + trust classification
// =============================================================================

describe('mergeAndScore', () => {
  it('merges the same MCP across all 4 sources by canonical id', () => {
    const merged = mergeAndScore({
      pulsemcp: [
        {
          id: 'npm:@modelcontextprotocol/server-memory',
          title: 'Memory',
          description: 'desc-from-pulsemcp',
          publisher: 'modelcontextprotocol',
          publisherUrl: undefined,
          source: 'pulsemcp',
          sourceUrl: 'https://www.pulsemcp.com/servers/memory',
          npmPackageName: '@modelcontextprotocol/server-memory',
          githubStars: 5000,
          npmWeeklyDownloads: 50_000,
          githubFullName: 'modelcontextprotocol/servers',
        },
      ],
      glama: [
        {
          id: 'gh:modelcontextprotocol/servers', // different id in glama because no npm name
          title: 'Memory',
          description: 'desc-from-glama',
          publisher: 'modelcontextprotocol',
          publisherUrl: undefined,
          source: 'glama',
          sourceUrl: 'https://glama.ai/x',
          envKeys: ['MEMORY_FILE_PATH'],
          license: 'MIT',
          githubFullName: 'modelcontextprotocol/servers',
        },
      ],
      npm: [
        {
          id: 'npm:@modelcontextprotocol/server-memory',
          title: 'Memory',
          description: 'desc-from-npm',
          publisher: 'modelcontextprotocol',
          publisherUrl: undefined,
          source: 'npm',
          sourceUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-memory',
          npmPackageName: '@modelcontextprotocol/server-memory',
          npmWeeklyDownloads: 73_823,
          license: 'MIT',
          lastUpdate: '2026-01-26',
        },
      ],
      github: [
        {
          id: 'gh:modelcontextprotocol/servers',
          title: 'servers',
          description: 'desc-from-github',
          publisher: 'modelcontextprotocol',
          publisherUrl: 'https://github.com/modelcontextprotocol',
          source: 'github',
          sourceUrl: 'https://github.com/modelcontextprotocol/servers',
          githubStars: 5500,
          githubFullName: 'modelcontextprotocol/servers',
          license: 'MIT',
          lastUpdate: '2026-04-01',
        },
      ],
    });

    // Glama uses a different id (gh:...) while pulsemcp/npm use npm:...,
    // so dedup CANNOT collapse them into one in v1 — this is a known
    // tradeoff documented in the source. We expect 2 buckets.
    expect(merged.length).toBe(2);

    // The npm-id bucket should pick pulsemcp.short_description per
    // priority order, and merge npm + pulsemcp signals.
    const npmBucket = merged.find((r) =>
      r.id === 'npm:@modelcontextprotocol/server-memory',
    )!;
    expect(npmBucket).toBeDefined();
    expect(npmBucket.description).toBe('desc-from-pulsemcp');
    expect(npmBucket.signals.npmWeeklyDownloads).toBe(73_823); // from npm (preferred)
    expect(npmBucket.signals.githubStars).toBe(5000); // from pulsemcp
    expect(npmBucket.sources).toContain('pulsemcp');
    expect(npmBucket.sources).toContain('npm');
    expect(npmBucket.trustTier).toBe('official');
  });

  it('classifies @modelcontextprotocol packages as official', () => {
    const merged = mergeAndScore({
      pulsemcp: [],
      glama: [],
      npm: [
        {
          id: 'npm:@modelcontextprotocol/server-memory',
          title: 'memory',
          description: 'd',
          publisher: 'mcp',
          publisherUrl: undefined,
          source: 'npm',
          sourceUrl: '',
          npmPackageName: '@modelcontextprotocol/server-memory',
          npmWeeklyDownloads: 100,
        },
      ],
      github: [],
    });
    expect(merged[0]!.trustTier).toBe('official');
  });

  it('classifies high-download packages as popular', () => {
    const merged = mergeAndScore({
      pulsemcp: [],
      glama: [],
      npm: [
        {
          id: 'npm:cool-mcp',
          title: 'cool',
          description: 'd',
          publisher: 'someone',
          publisherUrl: undefined,
          source: 'npm',
          sourceUrl: '',
          npmPackageName: 'cool-mcp',
          npmWeeklyDownloads: 5000,
        },
      ],
      github: [],
    });
    expect(merged[0]!.trustTier).toBe('popular');
  });

  it('classifies low-signal entries as unaudited', () => {
    const merged = mergeAndScore({
      pulsemcp: [],
      glama: [],
      npm: [
        {
          id: 'npm:obscure-mcp',
          title: 'obscure',
          description: 'd',
          publisher: 'unknown',
          publisherUrl: undefined,
          source: 'npm',
          sourceUrl: '',
          npmPackageName: 'obscure-mcp',
          npmWeeklyDownloads: 50,
        },
      ],
      github: [],
    });
    expect(merged[0]!.trustTier).toBe('unaudited');
  });

  it('marks endpoint type http when an HTTP URL is present', () => {
    const merged = mergeAndScore({
      pulsemcp: [
        {
          id: 'gh:foo/bar',
          title: 'Hosted',
          description: 'd',
          publisher: 'foo',
          publisherUrl: undefined,
          source: 'pulsemcp',
          sourceUrl: '',
          endpointUrl: 'https://hosted.example.com/mcp',
          githubFullName: 'foo/bar',
        },
      ],
      glama: [],
      npm: [],
      github: [],
    });
    expect(merged[0]!.endpointType).toBe('http');
    expect(merged[0]!.endpointUrl).toBe('https://hosted.example.com/mcp');
  });

  it('builds stdio-tauri command when an npm package is present', () => {
    const merged = mergeAndScore({
      pulsemcp: [],
      glama: [],
      npm: [
        {
          id: 'npm:test-mcp',
          title: 'test',
          description: 'd',
          publisher: 'someone',
          publisherUrl: undefined,
          source: 'npm',
          sourceUrl: '',
          npmPackageName: 'test-mcp',
          npmWeeklyDownloads: 5000,
        },
      ],
      github: [],
    });
    const r = merged[0]!;
    expect(r.endpointType).toBe('stdio-tauri');
    expect(r.stdioCommand).toEqual({
      command: 'npx',
      args: ['-y', 'test-mcp'],
      envKeys: undefined,
    });
  });

  it('falls back to stdio-instructions when only github source is available', () => {
    const merged = mergeAndScore({
      pulsemcp: [],
      glama: [],
      npm: [],
      github: [
        {
          id: 'gh:foo/bar',
          title: 'bar',
          description: 'd',
          publisher: 'foo',
          publisherUrl: undefined,
          source: 'github',
          sourceUrl: 'https://github.com/foo/bar',
          githubFullName: 'foo/bar',
          githubStars: 100,
          installInstructionsHint: 'See README.',
        },
      ],
    });
    expect(merged[0]!.endpointType).toBe('stdio-instructions');
    expect(merged[0]!.installInstructions).toContain('README');
  });

  it('attaches envKeys from glama to the stdio command on merge', () => {
    const merged = mergeAndScore({
      pulsemcp: [],
      glama: [
        {
          id: 'npm:test-mcp', // note: forced same id for merge demo
          title: 'test',
          description: 'd',
          publisher: 'someone',
          publisherUrl: undefined,
          source: 'glama',
          sourceUrl: '',
          envKeys: ['MY_TOKEN'],
        },
      ],
      npm: [
        {
          id: 'npm:test-mcp',
          title: 'test',
          description: 'd',
          publisher: 'someone',
          publisherUrl: undefined,
          source: 'npm',
          sourceUrl: '',
          npmPackageName: 'test-mcp',
          npmWeeklyDownloads: 5000,
        },
      ],
      github: [],
    });
    const r = merged[0]!;
    expect(r.stdioCommand?.envKeys).toEqual(['MY_TOKEN']);
  });
});
