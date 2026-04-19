import { describe, it, expect } from 'vitest';
import { parseMessage, artifactToHtml, ARTIFACT_SYSTEM_HINT } from './artifacts';

// All assertions sidestep `createdAt` since `Date.now()` drifts across calls.

describe('parseMessage — explicit <artifact> tags', () => {
  it('extracts a single fully-formed artifact', () => {
    const content =
      'Here you go:\n<artifact type="html" id="page-1" title="登录">\n<!doctype html><p>hi</p>\n</artifact>\nDone.';
    const parsed = parseMessage(content, 'msg-1');
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0]).toMatchObject({
      id: 'page-1',
      type: 'html',
      title: '登录',
    });
    expect(parsed.artifacts[0].content).toContain('<!doctype html>');
    expect(parsed.cleanContent).toContain('[[ARTIFACT:page-1]]');
    expect(parsed.cleanContent).not.toContain('<!doctype html>');
    expect(parsed.cleanContent).toMatch(/^Here you go:/);
    expect(parsed.cleanContent).toMatch(/Done\.$/);
  });

  it('extracts multiple artifacts in order', () => {
    const content = `
<artifact type="html" id="a" title="A"><p>A</p></artifact>
<artifact type="svg" id="b" title="B"><svg></svg></artifact>
`;
    const parsed = parseMessage(content);
    expect(parsed.artifacts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(parsed.artifacts.map((a) => a.type)).toEqual(['html', 'svg']);
    expect(parsed.cleanContent).toMatch(/\[\[ARTIFACT:a]].*\[\[ARTIFACT:b]]/s);
  });

  it('handles a streaming (unterminated) artifact', () => {
    const content =
      '<artifact type="html" id="live" title="流式">\n<!doctype html><body>streaming...';
    const parsed = parseMessage(content);
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].id).toBe('live');
    expect(parsed.artifacts[0].content).toContain('streaming...');
    expect(parsed.cleanContent).toContain('[[ARTIFACT:live]]');
  });

  it('generates a synthetic id when the tag omits one', () => {
    const parsed = parseMessage(
      '<artifact type="markdown" title="笔记">hello</artifact>',
      'msg-42'
    );
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].id).toMatch(/^msg-42-art-/);
  });

  it('falls back to a default title when attribute missing', () => {
    const parsed = parseMessage('<artifact type="svg"><svg/></artifact>');
    expect(parsed.artifacts[0].title).toBe('矢量图');
  });

  it('carries the language attribute through for code artifacts', () => {
    const parsed = parseMessage(
      '<artifact type="code" language="python" title="脚本">print(1)</artifact>'
    );
    expect(parsed.artifacts[0].language).toBe('python');
    expect(parsed.artifacts[0].type).toBe('code');
  });

  it('tags each artifact with the messageId hint', () => {
    const parsed = parseMessage(
      '<artifact type="html" id="x">body</artifact>',
      'msg-hint'
    );
    expect(parsed.artifacts[0].messageId).toBe('msg-hint');
  });

  it('is case-insensitive on the open tag', () => {
    const parsed = parseMessage('<ARTIFACT type="html" id="u">x</artifact>');
    expect(parsed.artifacts).toHaveLength(1);
  });

  it('preserves surrounding prose around artifacts', () => {
    const parsed = parseMessage(
      'before\n<artifact type="html" id="m">x</artifact>\nafter'
    );
    expect(parsed.cleanContent).toMatch(/before\s+\[\[ARTIFACT:m]]\s+after/);
  });

  it('infers type from content when attribute missing', () => {
    const withSvg = parseMessage('<artifact id="s"><svg><circle/></svg></artifact>');
    expect(withSvg.artifacts[0].type).toBe('svg');
    const withHtml = parseMessage(
      '<artifact id="h"><!doctype html><html></html></artifact>'
    );
    expect(withHtml.artifacts[0].type).toBe('html');
  });
});

describe('parseMessage — no artifacts', () => {
  it('returns content unchanged and empty artifacts list', () => {
    const parsed = parseMessage('Just a short answer.');
    expect(parsed.cleanContent).toBe('Just a short answer.');
    expect(parsed.artifacts).toEqual([]);
  });

  it('does NOT promote short code blocks', () => {
    const content = 'Here:\n```html\n<p>hi</p>\n```\nOK.';
    const parsed = parseMessage(content);
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.cleanContent).toBe(content);
  });

  it('does NOT promote unrelated code blocks (python, plain, etc.)', () => {
    const body = 'print("x")\n'.repeat(50); // long, but not a viewable type
    const parsed = parseMessage('```python\n' + body + '```');
    expect(parsed.artifacts).toEqual([]);
  });
});

describe('parseMessage — auto-promote fenced code blocks', () => {
  // Minimum 500 chars + 15 lines to trigger promotion. 50 × ~16 chars = ~800.
  const longHtml =
    '<!doctype html>\n<html>\n' +
    '  <p>hello world line</p>\n'.repeat(50) +
    '</html>';

  it('promotes a long html fenced block when no <artifact> present', () => {
    const parsed = parseMessage('Sure!\n```html\n' + longHtml + '\n```', 'msg-5');
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].type).toBe('html');
    expect(parsed.artifacts[0].language).toBe('html');
    expect(parsed.cleanContent).toContain('[[ARTIFACT:');
    expect(parsed.cleanContent).not.toContain('```html');
  });

  it('promotes a block without a language tag if it looks like HTML', () => {
    const parsed = parseMessage('```\n' + longHtml + '\n```');
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].type).toBe('html');
  });

  it('promotes an SVG block', () => {
    const svg =
      '<svg width="100" height="100">\n' +
      '  <circle cx="50" cy="50" r="4" fill="#d97757"/>\n'.repeat(30) +
      '</svg>';
    const parsed = parseMessage('```svg\n' + svg + '\n```');
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].type).toBe('svg');
  });

  it('promotes a mermaid diagram block', () => {
    const body = 'graph LR\n' + '  node1 --> node2\n'.repeat(50);
    const parsed = parseMessage('```mermaid\n' + body + '\n```');
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].type).toBe('mermaid');
  });

  it('promotes a tsx React component with export default', () => {
    const body =
      'export default function App() {\n' +
      '  return <div>Hi</div>;\n' +
      '}\n' +
      '// padding comment line\n'.repeat(30);
    const parsed = parseMessage('```tsx\n' + body + '\n```');
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].type).toBe('react');
  });

  it('promotes the LARGEST viewable block when multiple exist', () => {
    const small = '<!doctype html>\n' + '<p>small a</p>\n'.repeat(40);
    const big = '<!doctype html>\n' + '<p>big b</p>\n'.repeat(120);
    const parsed = parseMessage(
      '```html\n' + small + '\n```\n\n```html\n' + big + '\n```'
    );
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].content).toContain('b');
    expect(parsed.artifacts[0].content.split('\n').length).toBeGreaterThan(50);
  });

  it('does NOT promote when an explicit <artifact> is already present', () => {
    const content =
      '<artifact type="html" id="x"><p>explicit</p></artifact>\n\n```html\n' +
      longHtml +
      '\n```';
    const parsed = parseMessage(content);
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0].id).toBe('x');
    // The fenced block should NOT have been promoted — it stays in cleanContent.
    expect(parsed.cleanContent).toContain('```html');
  });

  it('strips the promoted block from cleanContent and inserts placeholder', () => {
    const parsed = parseMessage('Intro\n```html\n' + longHtml + '\n```\nOutro');
    expect(parsed.cleanContent).toMatch(/Intro\s+\[\[ARTIFACT:[^\]]+]]\s+Outro/);
    expect(parsed.cleanContent).not.toContain('<!doctype html>');
  });
});

describe('artifactToHtml — preview rendering', () => {
  const base = { id: 't', title: '测试', content: '', createdAt: 0 };

  it('returns html content unwrapped for type=html', () => {
    const out = artifactToHtml({ ...base, type: 'html', content: '<!doctype html><p>x</p>' });
    expect(out).toBe('<!doctype html><p>x</p>');
  });

  it('wraps SVG in a centered document', () => {
    const out = artifactToHtml({ ...base, type: 'svg', content: '<svg><circle/></svg>' });
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('<svg><circle/></svg>');
  });

  it('wraps markdown with a marked.js renderer and github-markdown-css', () => {
    const out = artifactToHtml({
      ...base,
      type: 'markdown',
      content: '# Hello\n\nWorld',
    });
    expect(out).toContain('marked.min.js');
    expect(out).toContain('github-markdown');
    // Source is injected via JSON.stringify so quotes stay safe.
    expect(out).toContain(JSON.stringify('# Hello\n\nWorld'));
  });

  it('escapes mermaid content to prevent HTML injection into the host', () => {
    const out = artifactToHtml({
      ...base,
      type: 'mermaid',
      content: 'graph <a> --> <b>',
    });
    expect(out).toContain('&lt;a&gt;');
    expect(out).not.toContain('--> <b>');
  });

  it('escapes plain-code content (XSS safety in <pre>)', () => {
    const out = artifactToHtml({
      ...base,
      type: 'code',
      content: '<script>alert(1)</script>',
    });
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('ships React + ReactDOM + Babel + Tailwind for react artifacts', () => {
    const out = artifactToHtml({
      ...base,
      type: 'react',
      content: 'function App() { return <div/>; }',
    });
    expect(out).toContain('react.development.js');
    expect(out).toContain('babel.min.js');
    expect(out).toContain('tailwindcss');
    expect(out).toContain('function App()');
  });
});

describe('ARTIFACT_SYSTEM_HINT', () => {
  it('documents every supported artifact type', () => {
    for (const t of ['html', 'react', 'svg', 'mermaid', 'markdown', 'code']) {
      expect(ARTIFACT_SYSTEM_HINT).toContain(t);
    }
  });
});
