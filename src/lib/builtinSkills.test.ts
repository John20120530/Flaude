import { describe, it, expect } from 'vitest';
import { BUILTIN_SKILLS } from './builtinSkills';

describe('BUILTIN_SKILLS', () => {
  it('ships at least the 5 advertised skills', () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(5);
  });

  it('every skill has unique id and name', () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id);
    const names = BUILTIN_SKILLS.map((s) => s.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every builtin is marked builtin:true and enabled:true', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.builtin).toBe(true);
      expect(s.enabled).toBe(true);
    }
  });

  it('all names are kebab-case (no spaces, no uppercase)', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('uses stable createdAt:0 so re-seeding is idempotent', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.createdAt).toBe(0);
    }
  });

  it('every skill has non-empty description and instructions', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.instructions.trim().length).toBeGreaterThan(20);
    }
  });

  it('modes only contain valid WorkMode values', () => {
    const valid = new Set(['chat', 'code']);
    for (const s of BUILTIN_SKILLS) {
      for (const m of s.modes) {
        expect(valid.has(m)).toBe(true);
      }
    }
  });
});
