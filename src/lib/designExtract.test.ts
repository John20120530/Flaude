/**
 * Tests for the Design-mode extractor.
 *
 * Two sets of pure-function checks:
 *   1. parsing — pulling fenced ```html / ```jsx / ```svg / ```mermaid blocks
 *      out of assistant messages, including tolerance for the model dropping
 *      the language tag.
 *   2. document building — turning a parsed block into a runnable iframe
 *      `srcdoc`, with optional html2canvas bridge injection for export.
 *
 * We deliberately don't render anything here — the iframe + DOM behaviour
 * lives in DesignCanvas.tsx and would require jsdom configuration that's
 * heavier than the value provided. The interesting bugs in this module are
 * all string-shaped, so string assertions cover them.
 */
import { describe, it, expect } from 'vitest';
import type { Conversation, Message } from '@/types';
import {
  allDesignBlocks,
  buildDesignDocument,
  collapseDesignBlocks,
  extractDesignFromMessage,
  latestDesignBlock,
} from './designExtract';

function asst(id: string, content: string, createdAt = 1_000): Message {
  return { id, role: 'assistant', content, createdAt };
}

function user(id: string, content: string): Message {
  return { id, role: 'user', content, createdAt: 0 };
}

function conv(messages: Message[]): Conversation {
  return {
    id: 'c1',
    title: 't',
    mode: 'design',
    modelId: 'deepseek-v4-pro',
    messages,
    createdAt: 0,
    updatedAt: 0,
  };
}

const HTML_DOC = '<!doctype html><html><body><h1>Hi</h1></body></html>';

// ---- extractDesignFromMessage ---------------------------------------------

describe('extractDesignFromMessage', () => {
  it('returns null for non-assistant messages', () => {
    expect(extractDesignFromMessage(user('u1', '```html\n<p/>\n```'))).toBeNull();
  });

  it('returns null when content has no fence', () => {
    expect(extractDesignFromMessage(asst('m1', 'just text'))).toBeNull();
  });

  it('returns null when fence is non-design (e.g. python)', () => {
    expect(
      extractDesignFromMessage(asst('m1', '```python\nprint(1)\n```'))
    ).toBeNull();
  });

  it('extracts an html block', () => {
    const block = extractDesignFromMessage(asst('m1', '```html\n' + HTML_DOC + '\n```'));
    expect(block).not.toBeNull();
    expect(block!.format).toBe('html');
    expect(block!.content).toContain('<!doctype html>');
    expect(block!.messageId).toBe('m1');
  });

  it('treats jsx / tsx / react fence tags as the same format', () => {
    for (const tag of ['jsx', 'tsx', 'react']) {
      const block = extractDesignFromMessage(
        asst('m', '```' + tag + '\nfunction App(){return <p/>}\n```')
      );
      expect(block?.format).toBe('jsx');
    }
  });

  it('extracts svg + mermaid blocks', () => {
    expect(
      extractDesignFromMessage(asst('m', '```svg\n<svg></svg>\n```'))?.format
    ).toBe('svg');
    expect(
      extractDesignFromMessage(asst('m', '```mermaid\ngraph TD\n```'))?.format
    ).toBe('mermaid');
  });

  it('infers html when the model forgot the language tag', () => {
    // Model produced ``` ... ``` without a tag but the body is a doc.
    const block = extractDesignFromMessage(
      asst('m', '```\n' + HTML_DOC + '\n```')
    );
    expect(block?.format).toBe('html');
  });

  it('infers svg when the model forgot the language tag', () => {
    const block = extractDesignFromMessage(
      asst('m', '```\n<svg width="10" height="10"/>\n```')
    );
    expect(block?.format).toBe('svg');
  });

  it('returns the FIRST design block when the model emits two', () => {
    const block = extractDesignFromMessage(
      asst(
        'm',
        '```html\n<p>first</p>\n```\nthen\n```html\n<p>second</p>\n```'
      )
    );
    expect(block?.content).toContain('first');
  });

  it('strips surrounding whitespace from the block content', () => {
    const block = extractDesignFromMessage(
      asst('m', '```html\n\n   <p/>   \n\n```')
    );
    expect(block?.content).toBe('<p/>');
  });
});

// ---- latestDesignBlock / allDesignBlocks ----------------------------------

describe('latestDesignBlock', () => {
  it('walks backwards and skips assistant turns that were just prose', () => {
    const c = conv([
      user('u0', 'hi'),
      asst('a1', '```html\n<p>v1</p>\n```'),
      user('u1', 'change'),
      asst('a2', 'sure, working on it...'), // no fence
    ]);
    expect(latestDesignBlock(c)?.messageId).toBe('a1');
  });

  it('returns null when the conversation has no design output yet', () => {
    expect(latestDesignBlock(conv([asst('a1', 'thinking...')]))).toBeNull();
    expect(latestDesignBlock(conv([]))).toBeNull();
  });
});

describe('allDesignBlocks', () => {
  it('returns blocks in chronological order, one per producing turn', () => {
    const c = conv([
      asst('a1', '```html\n<p>v1</p>\n```', 1),
      user('u1', 'next'),
      asst('a2', 'sure', 2), // skipped
      asst('a3', '```html\n<p>v2</p>\n```', 3),
    ]);
    const blocks = allDesignBlocks(c);
    expect(blocks.map((b) => b.messageId)).toEqual(['a1', 'a3']);
    expect(blocks.map((b) => b.createdAt)).toEqual([1, 3]);
  });
});

// ---- buildDesignDocument --------------------------------------------------

describe('buildDesignDocument', () => {
  it('returns html-format content verbatim by default', () => {
    const block = extractDesignFromMessage(asst('m', '```html\n' + HTML_DOC + '\n```'))!;
    expect(buildDesignDocument(block)).toBe(HTML_DOC);
  });

  it('wraps svg in a centered viewer document', () => {
    const block = extractDesignFromMessage(
      asst('m', '```svg\n<svg width="40"></svg>\n```')
    )!;
    const doc = buildDesignDocument(block);
    expect(doc).toContain('<svg width="40"></svg>');
    expect(doc).toMatch(/<!doctype html>/i);
    expect(doc).toContain('display:flex');
  });

  it('wraps mermaid with the mermaid CDN script', () => {
    const block = extractDesignFromMessage(
      asst('m', '```mermaid\ngraph TD;A-->B\n```')
    )!;
    const doc = buildDesignDocument(block);
    expect(doc).toContain('mermaid.min.js');
    expect(doc).toContain('mermaid.initialize');
    // Diagram source is HTML-escaped so `>` doesn't break the wrapper.
    expect(doc).toContain('graph TD;A--&gt;B');
  });

  it('wraps jsx with React + Babel + Tailwind', () => {
    const block = extractDesignFromMessage(
      asst('m', '```jsx\nfunction App(){return <p>x</p>}\n```')
    )!;
    const doc = buildDesignDocument(block);
    expect(doc).toContain('react.development.js');
    expect(doc).toContain('@babel/standalone');
    expect(doc).toContain('cdn.tailwindcss.com');
    expect(doc).toContain('function App()');
  });

  it('injects the html2canvas bridge before </body> when requested', () => {
    const block = extractDesignFromMessage(asst('m', '```html\n' + HTML_DOC + '\n```'))!;
    const doc = buildDesignDocument(block, { injectExportBridge: true });
    expect(doc).toContain('html2canvas');
    expect(doc).toContain('flaude-capture');
    // The bridge sits BEFORE the closing body, not after it (otherwise the
    // browser ignores the script). Check by ordering of "html2canvas" vs
    // the original closing tag.
    expect(doc.indexOf('html2canvas')).toBeLessThan(
      doc.toLowerCase().lastIndexOf('</body>')
    );
  });

  it('omits the bridge by default — keeps the preview slim', () => {
    const block = extractDesignFromMessage(asst('m', '```html\n' + HTML_DOC + '\n```'))!;
    const doc = buildDesignDocument(block);
    expect(doc).not.toContain('html2canvas');
    expect(doc).not.toContain('flaude-capture');
  });
});

// ---- collapseDesignBlocks -------------------------------------------------
//
// This is what keeps DesignView's chat thread from doubling up the canvas.
// Every closed design fence becomes [[DESIGNBLOCK:fmt:bytes]]; an unclosed
// trailing fence (mid-stream or errored stream) becomes
// [[DESIGNBLOCK_PARTIAL:fmt:bytes]]. Non-design fences pass through.

describe('collapseDesignBlocks', () => {
  it('replaces a closed html fence with a placeholder including byte length', () => {
    const body = '<!doctype html><html></html>';
    const out = collapseDesignBlocks('here you go:\n```html\n' + body + '\n```\n');
    expect(out).toBe('here you go:\n[[DESIGNBLOCK:html:' + body.length + ']]\n');
  });

  it('replaces jsx / tsx / react fences as the same "jsx" format', () => {
    for (const tag of ['jsx', 'tsx', 'react']) {
      const out = collapseDesignBlocks('```' + tag + '\nfunction App(){}\n```');
      expect(out).toContain('[[DESIGNBLOCK:jsx:');
    }
  });

  it('replaces svg + mermaid fences', () => {
    expect(collapseDesignBlocks('```svg\n<svg/>\n```')).toContain('[[DESIGNBLOCK:svg:');
    expect(collapseDesignBlocks('```mermaid\ngraph TD\n```')).toContain(
      '[[DESIGNBLOCK:mermaid:'
    );
  });

  it('infers html / svg from body when the model dropped the language tag', () => {
    expect(collapseDesignBlocks('```\n<!doctype html><html></html>\n```')).toContain(
      '[[DESIGNBLOCK:html:'
    );
    expect(collapseDesignBlocks('```\n<svg width="10"/>\n```')).toContain(
      '[[DESIGNBLOCK:svg:'
    );
  });

  it('leaves non-design fences alone (```python, ```bash, etc.)', () => {
    const input = '```python\nprint(1)\n```';
    expect(collapseDesignBlocks(input)).toBe(input);
    const input2 = '```bash\nls -la\n```';
    expect(collapseDesignBlocks(input2)).toBe(input2);
  });

  it('keeps surrounding prose intact', () => {
    const out = collapseDesignBlocks(
      '这是你要的海报：\n\n```html\n<!doctype html><body/>\n```\n\n如需调整，告诉我哪里。'
    );
    expect(out).toMatch(/^这是你要的海报：\n\n\[\[DESIGNBLOCK:html:\d+\]\]\n\n如需调整/);
  });

  it('replaces an unclosed trailing fence with DESIGNBLOCK_PARTIAL (mid-stream)', () => {
    // What the chat sees while the model is mid-emit, or after a network
    // error killed the stream before the closing ``` arrived.
    const partial = '生成中...\n```html\n<!doctype html><html><body><h1>Hi';
    const out = collapseDesignBlocks(partial);
    expect(out).toContain('[[DESIGNBLOCK_PARTIAL:html:');
    expect(out.startsWith('生成中...\n')).toBe(true);
    // The raw body is gone — that's the whole point.
    expect(out).not.toContain('<!doctype');
    expect(out).not.toContain('<h1>');
  });

  it('infers format on a partial fence with no language tag', () => {
    const out = collapseDesignBlocks('```\n<!doctype html><html');
    expect(out).toContain('[[DESIGNBLOCK_PARTIAL:html:');
  });

  it('leaves an unclosed non-design trailing fence alone', () => {
    const input = '```bash\nls -la';
    expect(collapseDesignBlocks(input)).toBe(input);
  });

  it('handles mixed closed + trailing partial in the same message', () => {
    // Rare but legal — model emitted v1 fully, then started v2 and the
    // stream cut. Both should fold.
    const out = collapseDesignBlocks(
      '```html\n<!doctype html><html></html>\n```\n现在再试一版：\n```html\n<!doctype html><html><body><div'
    );
    expect(out).toContain('[[DESIGNBLOCK:html:');
    expect(out).toContain('[[DESIGNBLOCK_PARTIAL:html:');
    expect(out).toContain('现在再试一版：');
  });

  it('passes content through untouched when no fences are present', () => {
    const input = '我建议用 Tailwind 配 stone 色板，更显高级。';
    expect(collapseDesignBlocks(input)).toBe(input);
  });
});
