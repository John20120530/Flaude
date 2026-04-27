import { describe, expect, it } from 'vitest';
import { parseSkillMd } from './skillsImport';

describe('parseSkillMd', () => {
  it('rejects empty / non-string input with a clear message', () => {
    const r1 = parseSkillMd('');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/为空/);
  });

  it('rejects content that does not start with a frontmatter fence', () => {
    const r = parseSkillMd('# Just a heading\n\nbody only');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/frontmatter/);
  });

  it('rejects frontmatter without a closing fence', () => {
    const r = parseSkillMd('---\nname: foo\ndescription: bar\nbody starts here');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/结束/);
  });

  it('parses a minimal anthropic-style SKILL.md', () => {
    const md = [
      '---',
      'name: pdf',
      'description: Use this skill whenever the user wants to do anything with PDF files.',
      '---',
      '# PDF tools',
      '',
      'This skill helps you with PDFs.',
      '',
      '## Reading',
      '...details...',
    ].join('\n');
    const r = parseSkillMd(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.name).toBe('pdf');
      expect(r.parsed.description).toMatch(/PDF/);
      expect(r.parsed.body.startsWith('# PDF tools')).toBe(true);
      expect(r.parsed.body).toContain('## Reading');
    }
  });

  it('handles double-quoted frontmatter values with embedded colons', () => {
    const md = [
      '---',
      'name: code-review',
      'description: "Use when reviewing PRs: focus on safety, clarity, tests"',
      '---',
      'body here',
    ].join('\n');
    const r = parseSkillMd(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.description).toBe(
        'Use when reviewing PRs: focus on safety, clarity, tests',
      );
    }
  });

  it('handles single-quoted values', () => {
    const md = [
      '---',
      "name: 'memory-recall'",
      "description: 'Pulls the relevant memory context'",
      '---',
      'body',
    ].join('\n');
    const r = parseSkillMd(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.name).toBe('memory-recall');
      expect(r.parsed.description).toBe('Pulls the relevant memory context');
    }
  });

  it('handles block scalars (`description: |` followed by indented lines)', () => {
    const md = [
      '---',
      'name: long-desc',
      'description: |',
      '  This is a multi-line',
      '  description that spans',
      '  several lines.',
      '---',
      'body',
    ].join('\n');
    const r = parseSkillMd(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.description).toContain('multi-line');
      expect(r.parsed.description).toContain('several lines');
      // Newlines preserved within the block
      expect(r.parsed.description.split('\n').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('rejects when name is missing from frontmatter', () => {
    const md = ['---', 'description: only desc', '---', 'body'].join('\n');
    const r = parseSkillMd(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name/);
  });

  it('rejects when description is missing from frontmatter', () => {
    const md = ['---', 'name: only-name', '---', 'body'].join('\n');
    const r = parseSkillMd(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/description/);
  });

  it('rejects when body is empty after the frontmatter', () => {
    const md = [
      '---',
      'name: empty',
      'description: nothing here',
      '---',
      '',
    ].join('\n');
    const r = parseSkillMd(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/body/);
  });

  it('preserves additional frontmatter keys in rawFrontmatter', () => {
    const md = [
      '---',
      'name: x',
      'description: d',
      'model: claude-3-5-sonnet',
      'tools: ["Bash", "Read"]',
      '---',
      'body',
    ].join('\n');
    const r = parseSkillMd(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.rawFrontmatter.model).toBe('claude-3-5-sonnet');
      // tools is left as-is (we don't try to parse arrays in the flat parser)
      expect(r.parsed.rawFrontmatter.tools).toContain('Bash');
    }
  });

  it('strips a leading BOM (some GitHub raw responses include one)', () => {
    const md =
      '﻿---\nname: x\ndescription: d\n---\nbody';
    const r = parseSkillMd(md);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.name).toBe('x');
  });

  it('tolerates leading whitespace / blank lines before the frontmatter fence', () => {
    const md = '\n\n---\nname: x\ndescription: d\n---\nbody';
    const r = parseSkillMd(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.name).toBe('x');
      expect(r.parsed.body).toBe('body');
    }
  });

  it('preserves markdown body verbatim including code fences and lists', () => {
    const md = [
      '---',
      'name: complex',
      'description: complex skill',
      '---',
      '# Title',
      '',
      '- item 1',
      '- item 2',
      '',
      '```python',
      'print("hello")',
      '```',
      '',
      '> a quote',
    ].join('\n');
    const r = parseSkillMd(md);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.body).toContain('```python');
      expect(r.parsed.body).toContain('- item 1');
      expect(r.parsed.body).toContain('> a quote');
    }
  });
});
