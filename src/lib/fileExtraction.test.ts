import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock pdf.js before importing the module under test. The real package
// pulls in a worker via Vite's `?url` syntax which doesn't resolve under
// vitest's node environment.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker-url' }));

import {
  extractAttachment,
  MAX_EXTRACTED_TEXT_CHARS,
  MAX_PDF_BYTES,
  MAX_TEXT_FILE_BYTES,
} from './fileExtraction';
import * as pdfjsLib from 'pdfjs-dist';

const getDocument = pdfjsLib.getDocument as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  getDocument.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Build a `File` whose `.text()` and `.arrayBuffer()` work in vitest. */
function makeFile(content: string | Uint8Array, name: string, type: string): File {
  const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  // jsdom's File constructor doesn't always wire .text() correctly across
  // versions; build a minimal compatible object that satisfies the bits
  // extractAttachment touches.
  const f = {
    name,
    type,
    size: data.byteLength,
    text: async () => (typeof content === 'string' ? content : new TextDecoder().decode(content)),
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  };
  return f as unknown as File;
}

describe('extractAttachment — image path', () => {
  it('reads PNG as a data URL', async () => {
    const f = makeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'pic.png', 'image/png');
    // jsdom's FileReader returns a real data URL; assert shape, not exact bytes.
    const result = await extractAttachment(f);
    expect(result.kind).toBe('image');
    if (result.kind === 'image') {
      expect(result.dataUrl.startsWith('data:image/png')).toBe(true);
    }
  });

  it('rejects images larger than the cap', async () => {
    const huge = new Uint8Array(MAX_TEXT_FILE_BYTES + 10);
    const f = makeFile(huge, 'big.png', 'image/png');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') expect(result.reason).toContain('太大');
  });
});

describe('extractAttachment — text path', () => {
  it('extracts text/plain content directly', async () => {
    const f = makeFile('hello world', 'note.txt', 'text/plain');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.text).toBe('hello world');
      expect(result.truncated).toBe(false);
    }
  });

  it('extracts code files even when the OS reports an empty mime type', async () => {
    // Browsers commonly hand back '' for .ts/.tsx/.go etc.
    const f = makeFile('export const x = 1;', 'foo.ts', '');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('text');
    if (result.kind === 'text') expect(result.text).toBe('export const x = 1;');
  });

  it('treats application/octet-stream as text when the extension is allowlisted', async () => {
    const f = makeFile('a: 1', 'cfg.yaml', 'application/octet-stream');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('text');
  });

  it('truncates text larger than MAX_EXTRACTED_TEXT_CHARS and flags it', async () => {
    const oversized = 'a'.repeat(MAX_EXTRACTED_TEXT_CHARS + 5_000);
    const f = makeFile(oversized, 'huge.txt', 'text/plain');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThan(oversized.length);
      expect(result.text).toContain('已截断');
    }
  });

  it('rejects text files larger than the byte cap (before reading them)', async () => {
    // The size check uses file.size, which we set to data.byteLength.
    const f = makeFile(new Uint8Array(MAX_TEXT_FILE_BYTES + 1), 'big.csv', 'text/csv');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') expect(result.reason).toContain('文本上限');
  });
});

describe('extractAttachment — PDF path', () => {
  it('extracts text from each page and joins with section headers', async () => {
    // Mock a 2-page PDF where each page has 2 text items.
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (n: number) => ({
          getTextContent: async () => ({
            items:
              n === 1
                ? [
                    { str: 'Hello', hasEOL: false },
                    { str: 'world', hasEOL: true },
                  ]
                : [
                    { str: 'Page', hasEOL: false },
                    { str: 'two', hasEOL: true },
                  ],
          }),
          cleanup: () => {},
        }),
        destroy: async () => {},
      }),
    });

    const f = makeFile(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'doc.pdf', 'application/pdf');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.text).toContain('## 第 1 页');
      expect(result.text).toContain('## 第 2 页');
      expect(result.text).toContain('Hello world');
      expect(result.text).toContain('Page two');
    }
  });

  it('routes by extension when the mime type is missing (Tauri sometimes hands us "")', async () => {
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: 'x', hasEOL: true }] }),
          cleanup: () => {},
        }),
        destroy: async () => {},
      }),
    });
    const f = makeFile(new Uint8Array([1, 2, 3]), 'paper.pdf', '');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('text');
  });

  it('rejects PDFs over MAX_PDF_BYTES without invoking pdf.js', async () => {
    const f = makeFile(new Uint8Array(MAX_PDF_BYTES + 1), 'big.pdf', 'application/pdf');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('unsupported');
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('stops decoding pages once the cap is hit', async () => {
    // Each page produces ~50 KB of "x"; cap is 256 KB, so we'd hit it on page 6.
    const cleanupSpy = vi.fn();
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 100,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [{ str: 'x'.repeat(50_000), hasEOL: true }],
          }),
          cleanup: cleanupSpy,
        }),
        destroy: async () => {},
      }),
    });
    const f = makeFile(new Uint8Array([1, 2, 3]), 'huge.pdf', 'application/pdf');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('text');
    if (result.kind === 'text') {
      expect(result.truncated).toBe(true);
      // We should have stopped well before page 100 — assert by cleanup count.
      expect(cleanupSpy.mock.calls.length).toBeLessThan(100);
    }
  });
});

describe('extractAttachment — unsupported types', () => {
  it('returns a clear reason for a binary file with no allowlist match', async () => {
    const f = makeFile(new Uint8Array([0, 1, 2]), 'archive.zip', 'application/zip');
    const result = await extractAttachment(f);
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') {
      expect(result.reason).toContain('archive.zip');
    }
  });

  it('rejects Office documents with a hint to use the workspace path instead', async () => {
    const f = makeFile(
      new Uint8Array([0x50, 0x4b]),
      'report.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const result = await extractAttachment(f);
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') {
      expect(result.reason).toMatch(/Office|fs_read_file|工作区/);
    }
  });
});
