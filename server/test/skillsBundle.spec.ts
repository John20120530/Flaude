/**
 * Tests for /api/skills/fetch-bundle.
 *
 * Three layers, mirroring skillsSearch.spec.ts:
 *   - Pure helpers (parseRawGitHubUrl, isAcceptablePath, parseSkillFrontmatter)
 *   - End-to-end pipeline (`fetchBundle`) against mocked global fetch.
 *   - End-to-end (route + cache) tests are skipped — caches.default
 *     isn't available in the Node test runner, same constraint that
 *     pushed mcpsSearch tests to exercise `mergeAndScore` directly
 *     instead of going through Hono.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __test } from '../src/skillsBundle';

const {
  parseRawGitHubUrl,
  isAcceptablePath,
  parseSkillFrontmatter,
  stripFrontmatter,
  fetchBundle,
} = __test;

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// =============================================================================
// parseRawGitHubUrl
// =============================================================================

describe('parseRawGitHubUrl', () => {
  it('parses a top-level SKILL.md URL', () => {
    expect(
      parseRawGitHubUrl(
        'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
      ),
    ).toEqual({ owner: 'foo', repo: 'bar', branch: 'HEAD', path: 'SKILL.md' });
  });

  it('parses a nested SKILL.md URL', () => {
    expect(
      parseRawGitHubUrl(
        'https://raw.githubusercontent.com/foo/bar/main/.claude/skills/x/SKILL.md',
      ),
    ).toEqual({
      owner: 'foo',
      repo: 'bar',
      branch: 'main',
      path: '.claude/skills/x/SKILL.md',
    });
  });

  it('returns null for non-github URLs', () => {
    expect(
      parseRawGitHubUrl('https://example.com/foo/bar/main/SKILL.md'),
    ).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(parseRawGitHubUrl('https://raw.githubusercontent.com/foo')).toBeNull();
    expect(parseRawGitHubUrl('')).toBeNull();
  });
});

// =============================================================================
// isAcceptablePath
// =============================================================================

describe('isAcceptablePath', () => {
  it('accepts text/markdown/code in skill root', () => {
    expect(isAcceptablePath('skills/x/SKILL.md', 'skills/x/')).toBe(true);
    expect(isAcceptablePath('skills/x/templates/alert.md', 'skills/x/')).toBe(true);
    expect(isAcceptablePath('skills/x/scripts/monitor.py', 'skills/x/')).toBe(true);
    expect(isAcceptablePath('skills/x/config/settings.json', 'skills/x/')).toBe(true);
  });

  it('rejects ignored prefixes', () => {
    expect(isAcceptablePath('skills/x/.git/HEAD', 'skills/x/')).toBe(false);
    expect(isAcceptablePath('skills/x/node_modules/foo/index.js', 'skills/x/')).toBe(
      false,
    );
    expect(isAcceptablePath('skills/x/__pycache__/bar.cpython-311.pyc', 'skills/x/')).toBe(false);
  });

  it('rejects ignored filenames', () => {
    expect(isAcceptablePath('skills/x/.DS_Store', 'skills/x/')).toBe(false);
    expect(isAcceptablePath('skills/x/package-lock.json', 'skills/x/')).toBe(false);
  });

  it('rejects unknown extensions (binary risk)', () => {
    expect(isAcceptablePath('skills/x/data.bin', 'skills/x/')).toBe(false);
    expect(isAcceptablePath('skills/x/img.png', 'skills/x/')).toBe(false);
    expect(isAcceptablePath('skills/x/notes.docx', 'skills/x/')).toBe(false);
  });

  it('accepts Dockerfile and Makefile (no extension)', () => {
    expect(isAcceptablePath('skills/x/Dockerfile', 'skills/x/')).toBe(true);
    expect(isAcceptablePath('skills/x/Makefile', 'skills/x/')).toBe(true);
  });

  it('accepts .env.example but not bare .env', () => {
    expect(isAcceptablePath('skills/x/.env.example', 'skills/x/')).toBe(true);
    expect(isAcceptablePath('skills/x/.env', 'skills/x/')).toBe(false);
  });

  it('rejects files deeper than MAX_DEPTH (3) under skill root', () => {
    expect(isAcceptablePath('skills/x/a/b/c.md', 'skills/x/')).toBe(true); // 3 segments OK
    expect(isAcceptablePath('skills/x/a/b/c/d.md', 'skills/x/')).toBe(false); // 4 segments NO
  });

  it('handles top-level SKILL.md (skillRoot empty)', () => {
    expect(isAcceptablePath('SKILL.md', '')).toBe(true);
    expect(isAcceptablePath('templates/alert.md', '')).toBe(true);
    expect(isAcceptablePath('.git/HEAD', '')).toBe(false);
  });
});

// =============================================================================
// parseSkillFrontmatter & stripFrontmatter
// =============================================================================

describe('parseSkillFrontmatter', () => {
  it('extracts name + description', () => {
    const md = ['---', 'name: pdf', 'description: PDF skill', '---', 'body'].join(
      '\n',
    );
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'pdf',
      description: 'PDF skill',
    });
  });

  it('strips BOM', () => {
    expect(
      parseSkillFrontmatter('﻿---\nname: x\ndescription: d\n---\nbody'),
    ).toEqual({ name: 'x', description: 'd' });
  });
});

describe('stripFrontmatter', () => {
  it('returns the body without the frontmatter', () => {
    const md = ['---', 'name: x', '---', '# Body', 'paragraph'].join('\n');
    expect(stripFrontmatter(md)).toBe('# Body\nparagraph');
  });

  it('returns the input unchanged if no frontmatter', () => {
    expect(stripFrontmatter('# Just a heading\n\nbody')).toBe(
      '# Just a heading\n\nbody',
    );
  });
});

// =============================================================================
// fetchBundle pipeline
// =============================================================================

interface MockRoute {
  body?: unknown;
  text?: string;
  bytes?: Uint8Array;
  status?: number;
  match: 'startsWith' | 'equals';
  url: string;
}

function makeMockedFetch(routes: MockRoute[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = routes.find((r) =>
      r.match === 'equals' ? url === r.url : url.startsWith(r.url),
    );
    if (!r) {
      return new Response(`not mocked: ${url}`, { status: 404 });
    }
    const status = r.status ?? 200;
    if (r.bytes !== undefined) {
      return new Response(r.bytes, { status });
    }
    if (r.text !== undefined) {
      return new Response(r.text, { status });
    }
    return new Response(JSON.stringify(r.body ?? null), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

const goodSkillMd = [
  '---',
  'name: pdf',
  'description: Use this skill whenever the user wants to do anything with PDFs.',
  '---',
  '# PDF tools',
  '',
  'Body — see templates/cover.md.',
].join('\n');

describe('fetchBundle', () => {
  it('returns SKILL.md + bundled siblings (templates / scripts / config)', async () => {
    vi.stubGlobal(
      'fetch',
      makeMockedFetch([
        // Repo info → default_branch resolution
        {
          match: 'equals',
          url: 'https://api.github.com/repos/foo/bar',
          body: { default_branch: 'main' },
        },
        // SKILL.md raw fetch
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/HEAD/skills/pdf/SKILL.md',
          text: goodSkillMd,
        },
        // Tree
        {
          match: 'startsWith',
          url: 'https://api.github.com/repos/foo/bar/git/trees/main',
          body: {
            tree: [
              {
                path: 'skills/pdf/SKILL.md',
                type: 'blob',
                size: goodSkillMd.length,
              },
              { path: 'skills/pdf/templates/cover.md', type: 'blob', size: 60 },
              { path: 'skills/pdf/scripts/extract.py', type: 'blob', size: 120 },
              { path: 'skills/pdf/config.json', type: 'blob', size: 30 },
              // Should be filtered out:
              { path: 'skills/pdf/.git/HEAD', type: 'blob', size: 10 },
              { path: 'skills/pdf/sample.pdf', type: 'blob', size: 5000 },
              { path: 'skills/other/SKILL.md', type: 'blob', size: 100 },
            ],
          },
        },
        // Per-asset raw fetches (only the kept ones).
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/main/skills/pdf/templates/cover.md',
          text: '# Cover template\n\nUse this for the title page.',
        },
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/main/skills/pdf/scripts/extract.py',
          text: 'import sys\nprint("hi")',
        },
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/main/skills/pdf/config.json',
          text: '{"x":1}',
        },
      ]),
    );

    const result = await fetchBundle(
      {
        owner: 'foo',
        repo: 'bar',
        branch: 'HEAD',
        path: 'skills/pdf/SKILL.md',
      },
      'https://raw.githubusercontent.com/foo/bar/HEAD/skills/pdf/SKILL.md',
      'fake-token',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.name).toBe('pdf');
    expect(result.description).toMatch(/PDF/);
    expect(result.body).toContain('# PDF tools');

    // Bundled assets — alphabetical by path, SKILL.md not included.
    expect(result.assets.map((a) => a.path)).toEqual([
      'config.json',
      'scripts/extract.py',
      'templates/cover.md',
    ]);
    expect(result.assets[0]!.content).toBe('{"x":1}');
  });

  it('drops a candidate when its raw fetch 404s', async () => {
    vi.stubGlobal(
      'fetch',
      makeMockedFetch([
        {
          match: 'equals',
          url: 'https://api.github.com/repos/foo/bar',
          body: { default_branch: 'main' },
        },
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
          text: goodSkillMd,
        },
        {
          match: 'startsWith',
          url: 'https://api.github.com/repos/foo/bar/git/trees/main',
          body: {
            tree: [
              { path: 'SKILL.md', type: 'blob', size: 100 },
              { path: 'README.md', type: 'blob', size: 50 },
            ],
          },
        },
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/main/README.md',
          status: 404,
          text: 'not found',
        },
      ]),
    );

    const result = await fetchBundle(
      { owner: 'foo', repo: 'bar', branch: 'HEAD', path: 'SKILL.md' },
      'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
      'tok',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assets).toEqual([]);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes('README.md'))).toBe(true);
  });

  it('rejects a SKILL.md without valid frontmatter', async () => {
    vi.stubGlobal(
      'fetch',
      makeMockedFetch([
        {
          match: 'equals',
          url: 'https://api.github.com/repos/foo/bar',
          body: { default_branch: 'main' },
        },
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
          text: '# Just a heading\n\nNo frontmatter here.',
        },
      ]),
    );

    const result = await fetchBundle(
      { owner: 'foo', repo: 'bar', branch: 'HEAD', path: 'SKILL.md' },
      'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
      'tok',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/frontmatter/);
  });

  it('skips binaries (null bytes detected) without aborting the bundle', async () => {
    const binBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    vi.stubGlobal(
      'fetch',
      makeMockedFetch([
        {
          match: 'equals',
          url: 'https://api.github.com/repos/foo/bar',
          body: { default_branch: 'main' },
        },
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
          text: goodSkillMd,
        },
        {
          match: 'startsWith',
          url: 'https://api.github.com/repos/foo/bar/git/trees/main',
          body: {
            tree: [
              { path: 'SKILL.md', type: 'blob', size: 100 },
              { path: 'logo.txt', type: 'blob', size: binBytes.length }, // wrong-extension binary content
              { path: 'good.md', type: 'blob', size: 5 },
            ],
          },
        },
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/main/logo.txt',
          bytes: binBytes,
        },
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/main/good.md',
          text: '# ok',
        },
      ]),
    );

    const result = await fetchBundle(
      { owner: 'foo', repo: 'bar', branch: 'HEAD', path: 'SKILL.md' },
      'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
      'tok',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assets.map((a) => a.path)).toEqual(['good.md']);
    expect(result.errors?.some((e) => e.includes('binary'))).toBe(true);
  });

  it('returns SKILL.md alone with an error note when tree fetch 5xxs', async () => {
    vi.stubGlobal(
      'fetch',
      makeMockedFetch([
        {
          match: 'equals',
          url: 'https://api.github.com/repos/foo/bar',
          body: { default_branch: 'main' },
        },
        {
          match: 'equals',
          url: 'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
          text: goodSkillMd,
        },
        {
          match: 'startsWith',
          url: 'https://api.github.com/repos/foo/bar/git/trees/main',
          status: 503,
          text: 'service unavailable',
        },
      ]),
    );

    const result = await fetchBundle(
      { owner: 'foo', repo: 'bar', branch: 'HEAD', path: 'SKILL.md' },
      'https://raw.githubusercontent.com/foo/bar/HEAD/SKILL.md',
      'tok',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // SKILL.md still parsed; bundling degraded gracefully.
    expect(result.name).toBe('pdf');
    expect(result.assets).toEqual([]);
    expect(result.errors).toBeDefined();
    expect(result.errors![0]).toMatch(/tree fetch/);
  });
});
