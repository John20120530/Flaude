/**
 * Composer attachment ingest — converts a `File` (from drag/drop, file picker,
 * or Ctrl+V paste) into something we can forward to a model.
 *
 * Three kinds:
 *   - 'image'       → base64 data URL, sent as multimodal image_url part
 *   - 'text'        → extracted UTF-8 text, injected as a fenced block in the
 *                     user message (works on every OpenAI-compatible provider,
 *                     no vision model required)
 *   - 'unsupported' → caller shows a rejection message
 *
 * Text comes from two sources:
 *   1. Plain-text-ish files (text/*, plus a curated extension allowlist that
 *      catches code/config files browsers misreport as `application/octet-stream`
 *      or empty mime). Read directly via `File.text()`.
 *   2. PDFs — we run pdf.js client-side (works in both browser and Tauri's
 *      WebView2). Worker setup uses Vite's `import.meta.url` resolution so the
 *      worker bundle ships alongside the app without manual copying.
 *
 * Office files (.docx / .xlsx / .pptx) are intentionally **not** handled here.
 * The Tauri side already has a native extractor (src-tauri/src/office.rs) for
 * files inside the workspace, but it requires a workspace path. For composer-
 * pasted Office files we'd need a JS-side extractor (mammoth / SheetJS) which
 * is significant bundle weight; punted for now.
 */

import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves this URL at build time and ships the worker as a separate
// chunk. Without it pdf.js would try to load the worker from a CDN, which
// breaks under Tauri's tauri:// scheme and offline. The `?url` query is
// the Vite idiom for "give me the resolved asset URL string".
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** Hard cap on extracted text per attachment (UTF-8 chars, 1 char ≈ 1 token-ish). */
export const MAX_EXTRACTED_TEXT_CHARS = 256 * 1024;

export type ExtractedAttachment =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'unsupported'; reason: string };

/**
 * Extension allowlist for "this is text, even though the browser reported
 * application/octet-stream". Lowercased, with leading dot. Curated — not
 * comprehensive. Add aggressively when users complain.
 */
const TEXT_EXTENSIONS = new Set([
  // Plain
  '.txt', '.md', '.markdown', '.rst', '.log',
  // Config
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.env', '.properties', '.editorconfig', '.gitignore', '.gitattributes',
  '.dockerfile', '.dockerignore', '.npmrc', '.gitconfig',
  // Tabular text
  '.csv', '.tsv',
  // Web
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.svg', '.xml', '.xhtml',
  // Scripts / source
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx',
  '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.kts',
  '.c', '.h', '.cpp', '.cc', '.hpp', '.hh', '.cs', '.swift',
  '.php', '.lua', '.r', '.R', '.pl', '.pm', '.scala', '.clj', '.cljs',
  '.dart', '.ex', '.exs', '.erl', '.hs', '.ml', '.mli', '.fs', '.fsx',
  '.zig', '.nim', '.v', '.sol', '.tf', '.tfvars',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.vim', '.vimrc',
  // Data / queries
  '.sql', '.graphql', '.gql', '.proto',
  // Build
  '.mk', '.makefile', '.cmake', '.gradle', '.bazel', '.bzl',
]);

/** Accept files up to this byte count for text extraction (pre-truncation). */
export const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;

/** Hard cap on PDF byte size to keep pdf.js memory bounded. */
export const MAX_PDF_BYTES = 16 * 1024 * 1024;

export async function extractAttachment(file: File): Promise<ExtractedAttachment> {
  const ext = extOf(file.name);

  if (file.type.startsWith('image/')) {
    if (file.size > MAX_TEXT_FILE_BYTES) {
      return {
        kind: 'unsupported',
        reason: `${file.name} 太大（${formatBytes(file.size)}，图片上限 ${formatBytes(MAX_TEXT_FILE_BYTES)}）`,
      };
    }
    const dataUrl = await fileToDataUrl(file);
    return { kind: 'image', dataUrl };
  }

  if (file.type === 'application/pdf' || ext === '.pdf') {
    if (file.size > MAX_PDF_BYTES) {
      return {
        kind: 'unsupported',
        reason: `${file.name} 太大（${formatBytes(file.size)}，PDF 上限 ${formatBytes(MAX_PDF_BYTES)}）`,
      };
    }
    return extractPdf(file);
  }

  if (file.type.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) {
    if (file.size > MAX_TEXT_FILE_BYTES) {
      return {
        kind: 'unsupported',
        reason: `${file.name} 太大（${formatBytes(file.size)}，文本上限 ${formatBytes(MAX_TEXT_FILE_BYTES)}）`,
      };
    }
    const raw = await file.text();
    return capText(raw);
  }

  return {
    kind: 'unsupported',
    reason:
      `${file.name}：暂不支持这种文件类型（${file.type || ext || '未知'}）。` +
      `当前可上传：图片、PDF、文本/代码/配置文件。Office 文档（docx/xlsx/pptx）` +
      `目前需要先放进工作区，由 Code Agent 通过 fs_read_file 读取。`,
  };
}

/** Get the lowercase extension including the leading dot, or '' if none. */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0 || i === name.length - 1) return '';
  return name.slice(i).toLowerCase();
}

async function fileToDataUrl(file: File): Promise<string> {
  // We deliberately avoid `FileReader` so this module works in vitest's
  // node test environment. `arrayBuffer()` is available in browsers,
  // Tauri's WebView2, and modern Node — `btoa` is in browsers and Node 16+.
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Process in chunks: btoa(String.fromCharCode(...bytes)) blows up the
  // call stack on multi-MB images.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(bin);
  const mime = file.type || 'application/octet-stream';
  return `data:${mime};base64,${b64}`;
}

async function extractPdf(file: File): Promise<ExtractedAttachment> {
  const buf = await file.arrayBuffer();
  // pdf.js mutates the input buffer; copy so we don't surprise other consumers.
  const data = new Uint8Array(buf.slice(0));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const pages: string[] = [];
  let totalChars = 0;
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const items = content.items as Array<{ str?: string; hasEOL?: boolean }>;
    let pageText = '';
    for (const item of items) {
      if (typeof item.str === 'string') {
        pageText += item.str;
        if (item.hasEOL) pageText += '\n';
        else pageText += ' ';
      }
    }
    pageText = pageText.replace(/[ \t]+/g, ' ').replace(/[ \t]*\n/g, '\n').trim();
    if (pageText) {
      const block = `## 第 ${pageNum} 页\n\n${pageText}`;
      pages.push(block);
      totalChars += block.length + 2;
      // Bail early if we've already blown past the cap — no point decoding
      // the rest of a 500-page PDF if the model only sees the first 256 KB.
      if (totalChars >= MAX_EXTRACTED_TEXT_CHARS) {
        pages.push(`\n[... 后续页面已截断（PDF 共 ${doc.numPages} 页）]`);
        break;
      }
    }
    page.cleanup();
  }
  await doc.destroy();
  const merged = pages.join('\n\n');
  return capText(merged);
}

/** Truncate to MAX_EXTRACTED_TEXT_CHARS, flagging when we cut. */
function capText(text: string): ExtractedAttachment {
  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) {
    return { kind: 'text', text, truncated: false };
  }
  const head = text.slice(0, MAX_EXTRACTED_TEXT_CHARS);
  return {
    kind: 'text',
    text: head + `\n\n[... 已截断，原文共 ${text.length} 字符]`,
    truncated: true,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
