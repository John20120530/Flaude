/**
 * Global memory entry parser/serializer.
 *
 * `globalMemory` is stored in the app store as a single `string` so it
 * round-trips cleanly through persistence, sync, and account export
 * without a schema change. The Settings UI presents it as a list of
 * individually toggle-able entries; this module is the bridge.
 *
 * Encoding:
 *   - One line per entry. Blank lines are skipped on parse.
 *   - A line starting with the literal prefix `<!--disabled-->` (with
 *     optional whitespace after) is marked disabled. The rest of the line
 *     is the entry text. Disabled entries are persisted but stripped from
 *     the system prompt by `effectiveGlobalMemory`.
 *
 * Why HTML-comment as the disable marker:
 *   - Visually unmistakable in the raw string (so the textarea fallback,
 *     `/remember` slash command, account export, etc. all show "this line
 *     is off" without parsing).
 *   - Survives any markdown renderer untouched (it's a comment).
 *   - Doesn't collide with content the user is plausibly going to type.
 *
 * IDs are generated on parse and intentionally NOT round-tripped to the
 * string. They exist only for React keys + transient edit state. If the
 * caller wants stable IDs across reloads, parse once and keep the result.
 */

import { uid } from './utils';

const DISABLED_PREFIX = '<!--disabled-->';
const DISABLED_PREFIX_RE = /^<!--disabled-->\s?/;

export interface GlobalMemoryEntry {
  id: string;
  text: string;
  disabled: boolean;
}

/**
 * Parse the raw `globalMemory` string into an array of entries.
 * - Blank lines drop out.
 * - Lines beginning with the disabled marker get `disabled: true`.
 * - Everything else becomes an enabled entry with its line as text
 *   (including any leading "- " or "* " — we preserve user style).
 */
export function parseEntries(raw: string): GlobalMemoryEntry[] {
  if (!raw) return [];
  const lines = raw.split('\n');
  const out: GlobalMemoryEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = DISABLED_PREFIX_RE.exec(line);
    if (m) {
      const text = line.slice(m[0].length).trim();
      // A bare "<!--disabled-->" with no body is meaningless; skip.
      if (!text) continue;
      out.push({ id: uid('mem'), text, disabled: true });
    } else {
      out.push({ id: uid('mem'), text: line, disabled: false });
    }
  }
  return out;
}

/**
 * Serialize entries back to the canonical string. Empty `text` entries
 * are dropped (no point persisting blank rows the user added but never
 * filled in). Order is preserved.
 */
export function serializeEntries(entries: GlobalMemoryEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    const t = e.text.trim();
    if (!t) continue;
    lines.push(e.disabled ? `${DISABLED_PREFIX} ${t}` : t);
  }
  return lines.join('\n');
}

/**
 * Strip disabled entries from the raw string, returning what should
 * actually go into the model's system prompt. `composeSystemPrompt`
 * calls this so disabled-but-still-listed memories don't reach the model.
 *
 * Implementation note: we operate on the string directly (without the
 * id round-trip) so prompt composition stays a pure string transform —
 * cheaper and easier to test than going through `parseEntries`.
 */
export function effectiveGlobalMemory(raw: string | undefined | null): string {
  if (!raw) return '';
  const lines = raw.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (DISABLED_PREFIX_RE.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}
