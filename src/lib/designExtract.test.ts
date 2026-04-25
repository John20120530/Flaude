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
