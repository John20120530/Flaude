/**
 * Adapter: external SKILL.md content → Flaude `Skill` shape.
 *
 * Anthropic-style SKILL.md files have a YAML frontmatter block (name +
 * description, sometimes other fields) followed by the markdown body.
 * Example:
 *
 *     ---
 *     name: pdf
 *     description: Use this skill whenever the user wants to do anything with PDF files.
 *     ---
 *     # PDF tools
 *     ...body...
 *
 * Our Flaude `Skill` is similar but with extra fields: `title` (display
 * name in Chinese / human-friendly), `instructions` (the full body), and
 * `modes` (which Flaude modes activate this skill).
 *
 * The adapter:
 *   1. Splits frontmatter from body via the `---` fence.
 *   2. Parses frontmatter as a flat key=value YAML subset (no nested
 *      objects, no arrays — simpler than pulling in a full YAML lib for
 *      what's a half-page of text).
 *   3. Returns a partial Skill that the caller (skillsImport UI) merges
 *      with the marketplace entry's metadata (title, modes from manifest)
 *      to fill any gaps.
 *
 * Why we don't use a YAML library: skills frontmatter is intentionally
 * small (`name`, `description`, sometimes `model`/`tools`). A 30-line
 * regex parser keeps the bundle small and gives precise error messages
 * when the file is malformed. The day we need nested YAML we can swap.
 */

export interface ParsedSkillContent {
  /** From frontmatter `name: ...`, lowercase kebab-case usually. */
  name: string;
  /** From frontmatter `description: ...`, the trigger blurb. */
  description: string;
  /** The markdown body after the frontmatter — this is what gets injected as instructions. */
  body: string;
  /** Any other frontmatter keys we recognized but don't have a typed home for. */
  rawFrontmatter: Record<string, string>;
}

export type ParseResult =
  | { ok: true; parsed: ParsedSkillContent }
  | { ok: false; error: string };

/**
 * Parse a SKILL.md string. Returns a discriminated union so the UI can
 * show specific error messages (vs. throwing).
 */
export function parseSkillMd(raw: string): ParseResult {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, error: '内容为空。' };
  }

  // Trim BOM / leading whitespace so the frontmatter regex sees `---`
  // at position 0.
  const trimmed = raw.replace(/^﻿/, '').replace(/^\s+/, '');

  if (!trimmed.startsWith('---')) {
    // No frontmatter: treat the whole thing as body, name from filename
    // would have to come from the caller.
    return {
      ok: false,
      error:
        '没有找到 frontmatter（SKILL.md 应以 `---` 开头，包含 name + description）。',
    };
  }

  // Find the closing `---`. Allow optional leading newline before the
  // closing fence for tolerance.
  const closeMatch = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!closeMatch) {
    return { ok: false, error: 'frontmatter 没有找到结束的 `---` 行。' };
  }

  const fmText = closeMatch[1] ?? '';
  const body = trimmed.slice(closeMatch[0].length).trim();

  const fm = parseFlatYaml(fmText);
  const name = (fm.name ?? '').trim();
  const description = (fm.description ?? '').trim();
  if (!name) {
    return { ok: false, error: 'frontmatter 缺 `name` 字段。' };
  }
  if (!description) {
    return { ok: false, error: 'frontmatter 缺 `description` 字段。' };
  }
  if (!body) {
    return { ok: false, error: 'SKILL.md body 为空，没有 instructions。' };
  }
  return {
    ok: true,
    parsed: { name, description, body, rawFrontmatter: fm },
  };
}

/**
 * Tiny flat-YAML parser. Handles:
 *   - `key: value`
 *   - `key: "quoted value with: colons"` and `'single quoted'`
 *   - Block scalars `key: |` followed by indented lines (for multi-line
 *     descriptions — Anthropic uses these)
 *
 * Does NOT handle nested objects / arrays / anchors / merge keys —
 * SKILL.md frontmatter doesn't use them.
 */
function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || /^\s*(#|$)/.test(line)) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1]!;
    const rest = (m[2] ?? '').trim();
    if (rest === '|' || rest === '|-' || rest === '>') {
      // Block scalar — collect indented lines.
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const blockLine = lines[i] ?? '';
        if (/^\s+/.test(blockLine) || blockLine === '') {
          collected.push(blockLine.replace(/^\s{0,2}/, ''));
          i++;
        } else {
          break;
        }
      }
      // Block scalars `>` join with spaces, `|` keep newlines. Both rare
      // in SKILL.md; we keep newlines in either case (safe default).
      out[key] = collected.join('\n').replace(/\n+$/, '');
      continue;
    }
    out[key] = unquote(rest);
    i++;
  }
  return out;
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}
