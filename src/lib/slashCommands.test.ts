import { describe, it, expect } from 'vitest';
import type { SlashCommand } from '@/types';
import {
  BUILTIN_SLASH_COMMANDS,
  expandTemplate,
  parseSlashInput,
  suggestCommands,
} from './slashCommands';

describe('BUILTIN_SLASH_COMMANDS', () => {
  it('has unique ids and triggers', () => {
    const ids = BUILTIN_SLASH_COMMANDS.map((c) => c.id);
    const triggers = BUILTIN_SLASH_COMMANDS.map((c) => c.trigger);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it('every command is marked builtin:true', () => {
    for (const c of BUILTIN_SLASH_COMMANDS) {
      expect(c.builtin).toBe(true);
    }
  });

  it('template commands have a template, action commands have an action', () => {
    for (const c of BUILTIN_SLASH_COMMANDS) {
      if (c.kind === 'template') {
        expect(c.template).toBeTruthy();
      } else {
        expect(c.action).toBeTruthy();
      }
    }
  });

  it('ships the M4 memory commands', () => {
    const memoryOpen = BUILTIN_SLASH_COMMANDS.find((c) => c.trigger === '/memory');
    const remember = BUILTIN_SLASH_COMMANDS.find((c) => c.trigger === '/remember');
    expect(memoryOpen?.action).toBe('memory-open');
    expect(remember?.action).toBe('memory-append');
  });
});

describe('expandTemplate', () => {
  it('substitutes {{input}}', () => {
    expect(expandTemplate('hello {{input}}', { input: 'world' })).toBe('hello world');
  });

  it('substitutes {{clipboard}}', () => {
    expect(expandTemplate('paste: {{clipboard}}', { clipboard: 'abc' })).toBe('paste: abc');
  });

  it('handles both placeholders in one template', () => {
    expect(
      expandTemplate('in={{input}} cb={{clipboard}}', { input: 'x', clipboard: 'y' })
    ).toBe('in=x cb=y');
  });

  it('treats missing vars as empty strings', () => {
    expect(expandTemplate('[{{input}}][{{clipboard}}]', {})).toBe('[][]');
  });

  it('replaces all occurrences, not just the first', () => {
    expect(expandTemplate('{{input}}-{{input}}', { input: 'a' })).toBe('a-a');
  });
});

describe('parseSlashInput', () => {
  const commands: SlashCommand[] = [
    { id: 't1', trigger: '/sum', description: '', kind: 'template', template: 'X' },
    { id: 't2', trigger: '/clear', description: '', kind: 'action', action: 'clear' },
  ];

  it('returns null for non-slash input', () => {
    expect(parseSlashInput('hello', commands)).toBeNull();
    expect(parseSlashInput('', commands)).toBeNull();
  });

  it('returns null for unknown commands', () => {
    expect(parseSlashInput('/nope', commands)).toBeNull();
  });

  it('matches a bare command with no argument', () => {
    const out = parseSlashInput('/clear', commands);
    expect(out?.command.id).toBe('t2');
    expect(out?.input).toBe('');
  });

  it('extracts the input after the trigger', () => {
    const out = parseSlashInput('/sum please summarize this', commands);
    expect(out?.command.id).toBe('t1');
    expect(out?.input).toBe('please summarize this');
  });

  it('tolerates leading whitespace', () => {
    const out = parseSlashInput('   /sum hi', commands);
    expect(out?.command.id).toBe('t1');
    expect(out?.input).toBe('hi');
  });

  it('preserves newlines in the input portion', () => {
    const out = parseSlashInput('/sum line1\nline2', commands);
    expect(out?.input).toBe('line1\nline2');
  });
});

describe('suggestCommands', () => {
  const commands: SlashCommand[] = [
    { id: 'a', trigger: '/tr-en', description: '', kind: 'template', template: '' },
    { id: 'b', trigger: '/tr-cn', description: '', kind: 'template', template: '' },
    { id: 'c', trigger: '/sum', description: '', kind: 'template', template: '' },
  ];

  it('returns empty if prefix does not start with /', () => {
    expect(suggestCommands('tr', commands)).toEqual([]);
  });

  it('matches by prefix', () => {
    const out = suggestCommands('/tr', commands);
    expect(out.map((c) => c.trigger)).toEqual(['/tr-cn', '/tr-en']);
  });

  it('sorts matches alphabetically', () => {
    const out = suggestCommands('/', commands);
    expect(out.map((c) => c.trigger)).toEqual(['/sum', '/tr-cn', '/tr-en']);
  });

  it('returns empty when nothing matches', () => {
    expect(suggestCommands('/xyz', commands)).toEqual([]);
  });
});
