/**
 * Tests for /api/skills/search.
 *
 * Two layers:
 *
 *   1. Pure parser tests (`parseSkillFrontmatter`) — same shape as the
 *      client-side parser tests, kept in lock-step so a SKILL.md the
 *      client can install also appears as a search result.
 *   2. End-to-end pipeline test against a mocked global fetch — proves
 *      the search → license filter → frontmatter peek path returns the
 *      expected card shape, drops bad licenses, drops blocklisted repos.
 *
 * We mock `globalThis.fetch` rather than going through Hono / Cache API
 * because the cache binding (`caches.default`) isn't present in the
 * Node test runner. The route handler is thin glue around `searchGitHub`
 * which is what we actually want to verify.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __test } from '../src/skillsSearch';

const { parseSkillFrontmatter, truncate, searchGitHub } = __test;

// -----------------------------------------------------------------------------
// Frontmatter parser
// -----------------------------------------------------------------------------

describe('parseSkillFrontmatter (server-side)', () => {
  it('extracts name + description from a minimal SKILL.md', () => {
    const md = ['---', 'name: pdf', 'description: PDF skill', '---', 'body'].join(
      '\n',
    );
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'pdf',
      description: 'PDF skill',
    });
  });

  it('returns {} when there is no frontmatter fence', () => {
    expect(parseSkillFrontmatter('# just a heading\n\nbody')).toEqual({});
  });

  it('handles double-quoted values with embedded colons', () => {
    const md = [
      '---',
      'name: x',
      'description: "Use when reviewing PRs: focus on safety"',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFrontmatter(md).description).toBe(
      'Use when reviewing PRs: focus on safety',
    );
  });

  it('handles single-quoted values', () => {
    const md = [
      '---',
      "name: 'memory-recall'",
      "description: 'Pulls relevant memory'",
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'memory-recall',
      description: 'Pulls relevant memory',
    });
  });

  it('handles block scalars (`description: |`)', () => {
    const md = [
      '---',
      'name: long',
      'description: |',
      '  Multi-line',
      '  description',
      '---',
      'body',
    ].join('\n');
    const fm = parseSkillFrontmatter(md);
    expect(fm.description).toContain('Multi-line');
    expect(fm.description).toContain('description');
  });

  it('strips a leading BOM', () => {
    const md = '﻿---\nname: x\ndescription: d\n---\nbody';
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'x', description: 'd' });
  });

  it('tolerates leading whitespace before the fence', () => {
    const md = '\n\n---\nname: x\ndescription: d\n---\nbody';
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'x', description: 'd' });
  });
});

// -----------------------------------------------------------------------------
// truncate
// -----------------------------------------------------------------------------

describe('truncate', () => {
  it('passes strings <= n through unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
  it('cuts and appends an ellipsis when over n', () => {
    expect(truncate('a'.repeat(100), 20)).toBe('a'.repeat(19) + '…');
  });
  it('does NOT split emoji or surrogate pairs at the boundary', () => {
    // 🎓 (U+1F393) is a 2-code-unit surrogate pair in UTF-16. Building a
    // string where the truncation boundary lands inside the pair would
    // leave an unpaired surrogate with naive `slice`.
    const s = 'a'.repeat(19) + '🎓' + 'tail';
    const truncated = truncate(s, 20);
    // Result has at most maxChars codepoints, ends with the ellipsis,
    // and contains no orphan surrogates.
    expect([...truncated].length).toBeLessThanOrEqual(20);
    expect(truncated.endsWith('…')).toBe(true);
    for (const c of truncated) {
      const cp = c.codePointAt(0)!;
      expect(cp < 0xd800 || cp > 0xdfff).toBe(true);
    }
  });
  it('counts CJK characters as one (codepoint-based)', () => {
    // Each Chinese char is one codepoint. 30 chars + maxChars=10 → 9 + …
    const s = '中'.repeat(30);
    const truncated = truncate(s, 10);
    expect([...truncated].length).toBe(10);
    expect(truncated).toBe('中'.repeat(9) + '…');
  });
});

// -----------------------------------------------------------------------------
// searchGitHub pipeline (mocked fetch)
// -----------------------------------------------------------------------------

interface MockEntry {
  body: unknown;
  status?: number;
  text?: string;
}

function makeFetchMock(routes: Record<string, MockEntry>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    // Find the first route whose key is a prefix of the URL. Lets tests
    // write `https://api.github.com/repos/foo/bar/license` once and
    // match both /license and /license?ref=... etc.
    const matchKey = Object.keys(routes).find((k) => url.startsWith(k));
    if (!matchKey) {
      return new Response('not mocked: ' + url, { status: 404 });
    }
    const entry = routes[matchKey]!;
    const status = entry.status ?? 200;
    if (entry.text !== undefined) {
      return new Response(entry.text, { status });
    }
    return new Response(JSON.stringify(entry.body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

const goodSkillMd = [
  '---',
  'name: java-clean-code',
  'description: Help reviewers spot non-idiomatic Java',
  '---',
  '# Java Clean Code',
  '',
  'Body of the skill.',
].join('\n');

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchGitHub', () => {
  it('returns a clean card for an MIT-licensed hit with valid frontmatter', async () => {
    const fetchMock = makeFetchMock({
      'https://api.github.com/search/code': {
        body: {
          total_count: 1,
          items: [
            {
              path: '.claude/skills/java-clean-code/SKILL.md',
              repository: {
                full_name: 'nxd1184/java-clean-code-skill',
                name: 'java-clean-code-skill',
                html_url: 'https://github.com/nxd1184/java-clean-code-skill',
                owner: { login: 'nxd1184' },
                default_branch: 'main',
              },
            },
          ],
        },
      },
      'https://api.github.com/repos/nxd1184/java-clean-code-skill/license': {
        body: { license: { spdx_id: 'MIT', name: 'MIT License' } },
      },
      'https://raw.githubusercontent.com/nxd1184/java-clean-code-skill/main/.claude/skills/java-clean-code/SKILL.md':
        {
          text: goodSkillMd,
        },
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchGitHub('java', 'fake-token');
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.title).toBe('java-clean-code');
    expect(r.description).toMatch(/Java/);
    expect(r.publisher).toBe('@nxd1184');
    expect(r.license).toBe('MIT');
    expect(r.rawUrl).toBe(
      'https://raw.githubusercontent.com/nxd1184/java-clean-code-skill/main/.claude/skills/java-clean-code/SKILL.md',
    );
    expect(r.tags).toContain('github-search');
  });

  it('drops a hit whose license is not in the allow-list', async () => {
    const fetchMock = makeFetchMock({
      'https://api.github.com/search/code': {
        body: {
          items: [
            {
              path: 'SKILL.md',
              repository: {
                full_name: 'evil/proprietary-skill',
                name: 'proprietary-skill',
                owner: { login: 'evil' },
                default_branch: 'main',
                html_url: 'https://github.com/evil/proprietary-skill',
              },
            },
          ],
        },
      },
      'https://api.github.com/repos/evil/proprietary-skill/license': {
        body: { license: { spdx_id: 'NOASSERTION' } },
      },
      'https://raw.githubusercontent.com/evil/proprietary-skill/main/SKILL.md': {
        text: goodSkillMd,
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchGitHub('whatever', 'fake-token');
    expect(results).toHaveLength(0);
  });

  it('drops Apache-but-malformed-frontmatter hits', async () => {
    const fetchMock = makeFetchMock({
      'https://api.github.com/search/code': {
        body: {
          items: [
            {
              path: 'SKILL.md',
              repository: {
                full_name: 'foo/bar',
                name: 'bar',
                owner: { login: 'foo' },
                default_branch: 'main',
                html_url: 'https://github.com/foo/bar',
              },
            },
          ],
        },
      },
      'https://api.github.com/repos/foo/bar/license': {
        body: { license: { spdx_id: 'Apache-2.0' } },
      },
      'https://raw.githubusercontent.com/foo/bar/main/SKILL.md': {
        // No frontmatter at all — the parser will return {} and we drop.
        text: '# Just a heading\n\nNo frontmatter here.',
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchGitHub('whatever', 'fake-token');
    expect(results).toHaveLength(0);
  });

  it('explicitly blocks anthropics/skills repo', async () => {
    const fetchMock = makeFetchMock({
      'https://api.github.com/search/code': {
        body: {
          items: [
            {
              path: 'skills/pdf/SKILL.md',
              repository: {
                full_name: 'anthropics/skills',
                name: 'skills',
                owner: { login: 'anthropics' },
                default_branch: 'main',
                html_url: 'https://github.com/anthropics/skills',
              },
            },
          ],
        },
      },
      // We never expect license/raw fetches to be called for blocked repos —
      // but stub them anyway so a bug that reaches them doesn't 404 out.
      'https://api.github.com/repos/anthropics/skills/license': {
        body: { license: { spdx_id: 'MIT' } },
      },
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md':
        {
          text: goodSkillMd,
        },
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchGitHub('pdf', 'fake-token');
    expect(results).toHaveLength(0);
  });

  it('keeps multiple valid hits and respects the result cap', async () => {
    // Build 25 hits — cap should clamp to 20.
    const items = Array.from({ length: 25 }, (_, i) => ({
      path: `SKILL.md`,
      repository: {
        full_name: `owner${i}/repo${i}`,
        name: `repo${i}`,
        owner: { login: `owner${i}` },
        default_branch: 'main',
        html_url: `https://github.com/owner${i}/repo${i}`,
      },
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://api.github.com/search/code')) {
        return new Response(JSON.stringify({ items }), { status: 200 });
      }
      if (url.includes('/license')) {
        return new Response(
          JSON.stringify({ license: { spdx_id: 'MIT' } }),
          { status: 200 },
        );
      }
      if (url.includes('raw.githubusercontent.com')) {
        return new Response(goodSkillMd, { status: 200 });
      }
      return new Response('nope', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchGitHub('foo', 'tok');
    // Cap is 20 by design — see MAX_RESULTS in the source.
    expect(results.length).toBe(20);
  });

  it('throws when GitHub /search/code returns 5xx', async () => {
    const fetchMock = makeFetchMock({
      'https://api.github.com/search/code': {
        status: 503,
        text: 'service unavailable',
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchGitHub('foo', 'tok')).rejects.toThrow(/503/);
  });

  it('does not require an auth token (graceful unauthenticated path)', async () => {
    const fetchMock = makeFetchMock({
      'https://api.github.com/search/code': {
        body: { items: [] },
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchGitHub('foo', undefined);
    expect(results).toEqual([]);
    // Verify the call had no Authorization header — it would have been
    // optional in the headers object.
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('passes Authorization when token is provided', async () => {
    const fetchMock = makeFetchMock({
      'https://api.github.com/search/code': {
        body: { items: [] },
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await searchGitHub('foo', 'my-pat');
    const call = fetchMock.mock.calls[0]!;
    const init = call[1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-pat');
  });
});
