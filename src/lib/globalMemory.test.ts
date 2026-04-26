import { describe, it, expect } from 'vitest';
import {
  parseEntries,
  serializeEntries,
  effectiveGlobalMemory,
  type GlobalMemoryEntry,
} from './globalMemory';

describe('parseEntries', () => {
  it('returns [] for empty / undefined / null inputs', () => {
    expect(parseEntries('')).toEqual([]);
    expect(parseEntries(undefined as unknown as string)).toEqual([]);
    expect(parseEntries(null as unknown as string)).toEqual([]);
  });

  it('one non-blank line → one enabled entry', () => {
    const out = parseEntries('I prefer pnpm');
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('I prefer pnpm');
    expect(out[0]?.disabled).toBe(false);
  });

  it('skips blank lines (whitespace-only too)', () => {
    const out = parseEntries('a\n\n\n   \n\nb');
    expect(out.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('preserves bullet-prefixed lines verbatim — does not strip "- " or "* "', () => {
    const out = parseEntries('- pnpm only\n* tabs not spaces');
    expect(out.map((e) => e.text)).toEqual(['- pnpm only', '* tabs not spaces']);
  });

  it('marks lines starting with the disabled marker as disabled, with text trimmed', () => {
    const raw = 'enabled fact\n<!--disabled--> ignored fact';
    const out = parseEntries(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: 'enabled fact', disabled: false });
    expect(out[1]).toMatchObject({ text: 'ignored fact', disabled: true });
  });

  it('disabled marker without trailing space still parses (no-space form)', () => {
    const out = parseEntries('<!--disabled-->no space form');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: 'no space form', disabled: true });
  });

  it('a bare "<!--disabled-->" line with no body is skipped', () => {
    const out = parseEntries('a\n<!--disabled-->\nb');
    expect(out.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('assigns a unique id per entry (not the same id twice)', () => {
    const out = parseEntries('one\ntwo\nthree');
    const ids = out.map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('disabled entries keep their order relative to enabled ones', () => {
    const out = parseEntries(
      'first\n<!--disabled--> second-disabled\nthird\n<!--disabled--> fourth-disabled',
    );
    expect(out.map((e) => `${e.disabled ? '*' : ''}${e.text}`)).toEqual([
      'first',
      '*second-disabled',
      'third',
      '*fourth-disabled',
    ]);
  });
});

describe('serializeEntries', () => {
  const e = (text: string, disabled = false): GlobalMemoryEntry => ({
    id: 'x',
    text,
    disabled,
  });

  it('returns "" for an empty array', () => {
    expect(serializeEntries([])).toBe('');
  });

  it('joins enabled entries with newlines', () => {
    expect(serializeEntries([e('a'), e('b'), e('c')])).toBe('a\nb\nc');
  });

  it('prefixes disabled entries with the marker', () => {
    expect(serializeEntries([e('on'), e('off', true)])).toBe(
      'on\n<!--disabled--> off',
    );
  });

  it('drops entries whose text is whitespace-only', () => {
    expect(serializeEntries([e('keep'), e('   '), e('also-keep')])).toBe(
      'keep\nalso-keep',
    );
  });

  it('trims each entry text before serialize so leading/trailing whitespace doesn’t pollute the line', () => {
    expect(serializeEntries([e('  padded  ')])).toBe('padded');
  });

  it('round-trips: parse(serialize(entries)) preserves text + disabled state', () => {
    const input: GlobalMemoryEntry[] = [
      { id: '1', text: 'I prefer pnpm', disabled: false },
      { id: '2', text: 'I write Rust', disabled: true },
      { id: '3', text: '- bullet line', disabled: false },
    ];
    const reparsed = parseEntries(serializeEntries(input));
    expect(reparsed.map((e) => ({ text: e.text, disabled: e.disabled }))).toEqual(
      input.map(({ text, disabled }) => ({ text, disabled })),
    );
  });
});

describe('effectiveGlobalMemory', () => {
  it('returns "" for empty / nullish inputs', () => {
    expect(effectiveGlobalMemory('')).toBe('');
    expect(effectiveGlobalMemory(undefined)).toBe('');
    expect(effectiveGlobalMemory(null)).toBe('');
  });

  it('passes through plain strings unchanged', () => {
    expect(effectiveGlobalMemory('a\nb')).toBe('a\nb');
  });

  it('strips lines that start with the disabled marker', () => {
    const raw = 'kept\n<!--disabled--> hidden\nalso-kept';
    expect(effectiveGlobalMemory(raw)).toBe('kept\nalso-kept');
  });

  it('strips disabled marker lines preserving the count of newlines for non-disabled ones', () => {
    // Newlines BEFORE disabled lines are preserved as part of the previous
    // line's content. The function joins kept lines with \n, which is fine.
    const raw = 'a\n<!--disabled--> b\nc';
    expect(effectiveGlobalMemory(raw)).toBe('a\nc');
  });

  it('returns "" when every line is disabled', () => {
    const raw = '<!--disabled--> a\n<!--disabled--> b';
    expect(effectiveGlobalMemory(raw)).toBe('');
  });

  it('does not require a space after the marker (matches the parser)', () => {
    expect(effectiveGlobalMemory('<!--disabled-->no-space')).toBe('');
  });

  it('handles trailing newlines without producing phantom entries', () => {
    expect(effectiveGlobalMemory('a\n')).toBe('a\n');
  });
});
