/**
 * Skills folder-bundle fetcher.
 *
 * Real-world Claude Skills are folders, not single files — they ship
 * SKILL.md alongside `templates/`, `scripts/`, `config/`, etc. The
 * SKILL.md body references those paths directly ("see
 * templates/alert.md") and the agent is expected to read them on
 * demand. Without bundled assets, those references dangle and the
 * skill mostly fails.
 *
 * This endpoint takes the raw.githubusercontent.com URL of a SKILL.md,
 * walks the parent directory via the GitHub Trees API, fetches every
 * text file under it (subject to size/depth/extension caps), and
 * returns the SKILL.md plus the auxiliary assets in one shot. The
 * client persists the result locally so subsequent reads are offline.
 *
 * Why server-side and not in the desktop client:
 *   - We already have GITHUB_TOKEN in the Worker env, so we hit
 *     authenticated rate limits (5000/h) instead of unauthenticated
 *     (60/h per IP — easy to exhaust on a multi-asset skill).
 *   - Single network round-trip vs. N for the client.
 *   - One place to evolve the size/extension/depth heuristics.
 *
 * Auth: requireAuth (same as everything else under /api/skills/).
 *
 * Cache: Cloudflare Cache API, 1h TTL, key = canonical URL with only
 * the rawUrl param.
 */
import { Hono } from 'hono';

import type { AppContext } from './env';
import { requireAuth } from './middleware';

const skillsBundle = new Hono<AppContext>();

skillsBundle.use('/api/skills/fetch-bundle', requireAuth);

// Per-file size cap. Most skill assets are small (<10KB); 64KB lets us
// absorb a verbose JSON config or a long README without truncating,
// without enabling someone to bundle a 5MB sample dataset.
const MAX_FILE_BYTES = 64 * 1024;

// Bundle-level cap. ~1MB across all assets keeps localStorage and the
// account-export bundle from blowing up after the user installs a
// dozen big skills. Skills much bigger than this are usually wrappers
// around npm packages, not "self-contained" skills.
const MAX_BUNDLE_BYTES = 1024 * 1024;

// How many subdirectory levels we walk into. Real skills are flat
// (~2 levels: skill root + 1 of templates/scripts/data). 3 gives
// headroom without inviting `.git/` walks.
const MAX_DEPTH = 3;

const CACHE_TTL_S = 3600;
const UPSTREAM_TIMEOUT_MS = 12_000;

// Parallel fetch concurrency for asset content. GitHub's raw endpoint
// is fast and not rate-limited per-token (the limit is per-IP), so we
// can lean on it. 8 keeps the Worker under its CPU limit on big
// bundles while finishing in <3s typical.
const ASSET_CONCURRENCY = 8;

// File extensions we keep — text formats only. Anything else is
// either binary (skip) or executable (the agent shouldn't blindly
// run it). The list is allow-list rather than deny-list because the
// blast radius of a wrong call is "the agent reads weird bytes" not
// "we accidentally bundle a 50MB ML model".
const ALLOWED_EXTENSIONS = new Set([
  // text & markup
  '.md', '.mdx', '.markdown', '.txt', '.rst', '.tex', '.org',
  // config & data
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.env.example', '.editorconfig',
  // code (read-only context for the agent — does NOT mean the agent
  // executes it; the read_skill_asset tool returns the source as a
  // string for the agent to reason about)
  '.py', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cs',
  '.html', '.htm', '.css', '.scss', '.sass',
  '.sql', '.graphql', '.proto',
  '.lua', '.r', '.jl', '.scala', '.clj',
  '.dockerfile',
  // tabular data — small samples are useful context
  '.csv', '.tsv',
]);

// Path prefixes we never bundle. Half of these (`.git/`,
// `node_modules/`) are huge and never user-authored; the others
// (`dist/`, `build/`) hold derived artifacts that bloat the bundle
// without adding skill context.
const IGNORED_PATH_PREFIXES = [
  '.git/',
  '.github/',  // GH Actions configs aren't skill content
  'node_modules/',
  '__pycache__/',
  '.pytest_cache/',
  '.venv/',
  'venv/',
  'env/',
  'dist/',
  'build/',
  'target/',
  '.next/',
  '.cache/',
  '.idea/',
  '.vscode/',
];

const IGNORED_FILENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.gitignore',
  '.gitattributes',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Cargo.lock',
]);

interface SkillAssetWire {
  path: string;
  content: string;
  size: number;
}

interface BundleResponse {
  ok: true;
  /** Frontmatter `name` field. */
  name: string;
  /** Frontmatter `description` field. */
  description: string;
  /** SKILL.md body (without frontmatter). */
  body: string;
  /** Auxiliary files in the same folder. Path is relative to skill root. */
  assets: SkillAssetWire[];
  /** Per-file fetch errors (e.g. 404, binary detected, too big).
   *  Bundling continues on partial failures; the UI shows them. */
  errors?: string[];
  /** True if `assets` was clipped because the bundle hit MAX_BUNDLE_BYTES. */
  truncated?: boolean;
  fromCache: boolean;
}

interface BundleErrorResponse {
  ok: false;
  error: string;
}

skillsBundle.get('/api/skills/fetch-bundle', async (c) => {
  const rawUrl = (c.req.query('rawUrl') ?? '').trim();
  if (!rawUrl) {
    return c.json<BundleErrorResponse>({ ok: false, error: 'rawUrl is required' }, 400);
  }
  // Quick sanity check — refuse anything not on raw.githubusercontent.com.
  // Otherwise we'd be a generic URL fetcher with our PAT attached, which
  // is a juicy SSRF vector.
  if (!rawUrl.startsWith('https://raw.githubusercontent.com/')) {
    return c.json<BundleErrorResponse>(
      { ok: false, error: 'rawUrl must start with https://raw.githubusercontent.com/' },
      400,
    );
  }
  const parsed = parseRawGitHubUrl(rawUrl);
  if (!parsed) {
    return c.json<BundleErrorResponse>(
      { ok: false, error: `cannot parse rawUrl: ${rawUrl}` },
      400,
    );
  }

  // Cache lookup — by canonical URL with just rawUrl. Auth header
  // intentionally not in cache key so all authed users share hits.
  const cacheUrl = new URL(c.req.url);
  cacheUrl.search = `rawUrl=${encodeURIComponent(rawUrl)}`;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = (await cached.json()) as BundleResponse | BundleErrorResponse;
    if ('ok' in body && body.ok) {
      return c.json({ ...body, fromCache: true });
    }
    // Negative-result cache: return as-is with the original status.
    return c.json(body);
  }

  let result: BundleResponse | BundleErrorResponse;
  try {
    result = await fetchBundle(parsed, rawUrl, c.env.GITHUB_TOKEN);
  } catch (e) {
    console.error('skills/fetch-bundle failed', { rawUrl, err: e });
    result = {
      ok: false,
      error: `bundle fetch failed: ${(e as Error).message}`,
    };
  }

  const cacheable = new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_S}`,
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, cacheable.clone()));

  return c.json(result);
});

// =============================================================================
// Pipeline
// =============================================================================

interface ParsedRawUrl {
  owner: string;
  repo: string;
  branch: string; // may be 'HEAD'; resolved later
  path: string; // path inside repo, e.g. ".claude/skills/java-clean-code/SKILL.md"
}

/**
 * Parse a raw.githubusercontent.com URL into its components.
 *
 *   https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>
 *
 * Returns null for any URL that doesn't match exactly.
 */
export function parseRawGitHubUrl(url: string): ParsedRawUrl | null {
  const m = url.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/,
  );
  if (!m) return null;
  const [, owner, repo, branch, path] = m;
  if (!owner || !repo || !branch || !path) return null;
  return { owner, repo, branch, path };
}

async function fetchBundle(
  parsed: ParsedRawUrl,
  rawUrl: string,
  githubToken: string | undefined,
): Promise<BundleResponse | BundleErrorResponse> {
  const ghHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'flaude-server/1.0',
  };
  if (githubToken) ghHeaders.Authorization = `Bearer ${githubToken}`;

  // Resolve the branch — `HEAD` is a Git convention, not always a
  // valid ref name in the GitHub API context. Look up the repo's
  // default_branch and use that. We'd otherwise have to guess
  // main vs. master vs. something else.
  let branch = parsed.branch;
  if (branch === 'HEAD' || branch === 'main' || branch === 'master') {
    // Even when branch is "main"/"master", we'd rather use the actual
    // default_branch so we don't 404 on repos using the other one.
    try {
      const repoRes = await fetchWithTimeout(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
        { headers: ghHeaders },
      );
      if (repoRes.ok) {
        const json = (await repoRes.json()) as { default_branch?: string };
        if (json.default_branch) branch = json.default_branch;
      }
    } catch {
      // Fall back to the literal branch name from the URL — better to
      // attempt the API calls and let them fail clearly than abort
      // here on a transient error.
    }
  }

  // Fetch SKILL.md content. We could go through the GitHub Contents
  // API but the raw URL we already have works and is a single hop.
  let skillMdText: string;
  try {
    const skillMdRes = await fetchWithTimeout(rawUrl, {});
    if (!skillMdRes.ok) {
      return { ok: false, error: `SKILL.md fetch ${skillMdRes.status}` };
    }
    skillMdText = await skillMdRes.text();
  } catch (e) {
    return { ok: false, error: `SKILL.md fetch: ${(e as Error).message}` };
  }

  const fm = parseSkillFrontmatter(skillMdText);
  const name = (fm.name ?? '').trim();
  const description = (fm.description ?? '').trim();
  if (!name || !description) {
    return {
      ok: false,
      error: 'SKILL.md has no valid frontmatter (need both name + description)',
    };
  }
  const body = stripFrontmatter(skillMdText).trim();
  if (!body) {
    return { ok: false, error: 'SKILL.md body is empty' };
  }

  // Skill root = parent dir of SKILL.md. If SKILL.md is at the repo
  // root, skillRoot = '' (empty prefix), which means we walk the
  // whole repo. That's fine — small skill repos are intentionally
  // single-skill, and the IGNORED_* filters remove README / LICENSE /
  // .github / etc. anyway.
  const skillRoot = parsed.path.endsWith('/SKILL.md')
    ? parsed.path.slice(0, parsed.path.length - 'SKILL.md'.length) // keep trailing /
    : parsed.path === 'SKILL.md'
      ? ''
      : ''; // shouldn't happen; defensive

  // Walk the repo tree.
  const treeUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${branch}?recursive=1`;
  let treeJson: {
    tree?: Array<{ path?: string; type?: string; size?: number }>;
    truncated?: boolean;
  };
  try {
    const treeRes = await fetchWithTimeout(treeUrl, { headers: ghHeaders });
    if (!treeRes.ok) {
      // No tree access = no assets. Return SKILL.md alone as a graceful
      // degradation — the user still gets a usable skill, just without
      // bundled files.
      return {
        ok: true,
        name,
        description,
        body,
        assets: [],
        errors: [`tree fetch ${treeRes.status} — assets not bundled`],
        fromCache: false,
      };
    }
    treeJson = await treeRes.json();
  } catch (e) {
    return {
      ok: true,
      name,
      description,
      body,
      assets: [],
      errors: [`tree fetch: ${(e as Error).message} — assets not bundled`],
      fromCache: false,
    };
  }

  // Filter tree entries to candidate asset files.
  const tree = treeJson.tree ?? [];
  const candidates: Array<{ path: string; size: number }> = [];
  for (const entry of tree) {
    if (entry.type !== 'blob' || !entry.path) continue;
    if (entry.path === parsed.path) continue; // SKILL.md itself
    if (skillRoot && !entry.path.startsWith(skillRoot)) continue;
    if (!isAcceptablePath(entry.path, skillRoot)) continue;
    if (typeof entry.size === 'number' && entry.size > MAX_FILE_BYTES) continue;
    candidates.push({ path: entry.path, size: entry.size ?? 0 });
  }

  // Fetch raw content with concurrency cap.
  const assets: SkillAssetWire[] = [];
  const errors: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (let i = 0; i < candidates.length; i += ASSET_CONCURRENCY) {
    if (truncated) break;
    const batch = candidates.slice(i, i + ASSET_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const url = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${branch}/${entry.path}`;
        try {
          const res = await fetchWithTimeout(url, {});
          if (!res.ok) return { error: `${entry.path}: HTTP ${res.status}` };
          const buf = await res.arrayBuffer();
          if (buf.byteLength > MAX_FILE_BYTES) {
            return { error: `${entry.path}: file too big (${buf.byteLength} bytes)` };
          }
          if (looksBinary(new Uint8Array(buf))) {
            return { error: `${entry.path}: binary content skipped` };
          }
          let content: string;
          try {
            // `fatal: true` makes the decoder throw on invalid UTF-8 byte
            // sequences instead of inserting U+FFFD replacement chars —
            // that lets us treat malformed text as "skip" rather than
            // shipping garbled assets to the client. `ignoreBOM: false`
            // is the default but Cloudflare's TextDecoder type insists
            // on us setting it explicitly.
            content = new TextDecoder('utf-8', {
              fatal: true,
              ignoreBOM: false,
            }).decode(buf);
          } catch {
            return { error: `${entry.path}: not valid UTF-8` };
          }
          const relPath = skillRoot ? entry.path.slice(skillRoot.length) : entry.path;
          return {
            ok: true as const,
            asset: { path: relPath, content, size: buf.byteLength },
          };
        } catch (e) {
          return { error: `${entry.path}: ${(e as Error).message}` };
        }
      }),
    );
    for (const r of results) {
      if ('ok' in r && r.ok) {
        if (totalBytes + r.asset.size > MAX_BUNDLE_BYTES) {
          truncated = true;
          errors.push(`${r.asset.path}: skipped, bundle full (${MAX_BUNDLE_BYTES} bytes)`);
          continue;
        }
        assets.push(r.asset);
        totalBytes += r.asset.size;
      } else if ('error' in r) {
        errors.push(r.error);
      }
    }
  }

  // Stable order: alphabetical by path. Helps the manifest in the
  // system prompt look the same across renders + simplifies tests.
  assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    ok: true,
    name,
    description,
    body,
    assets,
    errors: errors.length > 0 ? errors : undefined,
    truncated: truncated || undefined,
    fromCache: false,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Path filter — combines depth, extension, ignored-prefix, and
 * ignored-filename rules. Returns true if the path should be bundled.
 */
export function isAcceptablePath(path: string, skillRoot: string): boolean {
  const rel = skillRoot ? path.slice(skillRoot.length) : path;
  if (!rel) return false;

  // Depth check (relative to skill root). Count directory separators in
  // the relative portion.
  const depth = rel.split('/').length;
  if (depth > MAX_DEPTH) return false;

  // Ignored path prefixes (relative to skill root, otherwise top-level
  // .git/ inside a repo whose SKILL.md is in a subfolder wouldn't trip
  // — though our skillRoot.startsWith filter would already catch that).
  for (const prefix of IGNORED_PATH_PREFIXES) {
    if (rel.startsWith(prefix)) return false;
  }

  const filename = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
  if (IGNORED_FILENAMES.has(filename)) return false;

  // Allow Dockerfile et al. without an extension.
  if (filename === 'Dockerfile' || filename === 'Makefile') return true;

  // Extension allow-list. Lowercase so we match `.MD` etc.
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0) return false; // no extension or leading-dot file (.env etc handled below)
  const ext = filename.slice(dotIdx).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext)) return true;
  // Special cases: `.env.example` — handled by the literal in the set;
  // bare `.env` not allowed (might contain real secrets).
  if (filename === '.env.example') return true;
  return false;
}

/**
 * Heuristic binary detection — null bytes within the first 8KB, which
 * are almost never present in legit text but reliably appear in
 * binaries (PNG, ELF, Office docs, …). Cheap, no dep.
 */
function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Same flat-YAML extractor as in skillsSearch.ts. Duplicated rather
 * than shared because the file-bundle module is logically separate
 * (different lifecycle, different cache TTL, can ship without the
 * search endpoint and vice versa). 30 LOC of subset YAML isn't worth
 * a shared utility module + import-cycle risk.
 */
export function parseSkillFrontmatter(md: string): {
  name?: string;
  description?: string;
} {
  const trimmed = md.replace(/^﻿/, '').replace(/^\s+/, '');
  if (!trimmed.startsWith('---')) return {};
  const m = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return {};
  const fmText = m[1] ?? '';
  const out: Record<string, string> = {};
  const lines = fmText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const km = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!km) {
      i++;
      continue;
    }
    const key = km[1]!;
    let rest = (km[2] ?? '').trim();
    if (rest === '|' || rest === '|-' || rest === '>') {
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const bl = lines[i] ?? '';
        if (/^\s+/.test(bl) || bl === '') {
          collected.push(bl.replace(/^\s{0,2}/, ''));
          i++;
        } else {
          break;
        }
      }
      out[key] = collected.join('\n').replace(/\n+$/, '');
      continue;
    }
    if (rest.length >= 2) {
      const first = rest[0];
      const last = rest[rest.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        rest = rest.slice(1, -1);
      }
    }
    out[key] = rest;
    i++;
  }
  return { name: out.name?.trim(), description: out.description?.trim() };
}

/** Strip the frontmatter block (---...---) from the head of a SKILL.md. */
export function stripFrontmatter(md: string): string {
  const trimmed = md.replace(/^﻿/, '').replace(/^\s+/, '');
  if (!trimmed.startsWith('---')) return trimmed;
  const m = trimmed.match(/^---\s*\n[\s\S]*?\n---\s*\n?/);
  if (!m) return trimmed;
  return trimmed.slice(m[0].length);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Visible-for-tests exports.
export const __test = {
  parseRawGitHubUrl,
  isAcceptablePath,
  parseSkillFrontmatter,
  stripFrontmatter,
  fetchBundle,
};

export default skillsBundle;
