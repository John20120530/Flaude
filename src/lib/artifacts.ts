/**
 * Artifact system — parses structured content blocks from assistant messages
 * and renders them in an isolated sandbox (Claude-style).
 *
 * The model is instructed (via system prompt) to wrap substantial deliverables
 * in tags like:
 *
 *   <artifact type="html" id="login-form" title="登录表单">
 *   ...html...
 *   </artifact>
 *
 * Supported types: html, react, svg, mermaid, markdown, code, image
 *
 * v0.1.48: `image` is for raster images returned by the
 * `image_generate` tool (PPIO GPT Image 2 etc.). The `content` field
 * holds the image URL (PPIO returns CDN URLs); the artifact panel
 * renders it in an `<img>` wrapped in an HTML page so the existing
 * iframe-srcdoc rendering pipeline still applies.
 */

export type ArtifactType =
  | 'html'
  | 'react'
  | 'svg'
  | 'mermaid'
  | 'markdown'
  | 'code'
  | 'image';

export interface Artifact {
  id: string;
  messageId?: string;
  type: ArtifactType;
  /**
   * For `type='image'`: the image URL (or data:URI). The content field
   * holds the URL itself rather than HTML so other consumers (download,
   * sharing) can pull the URL directly without parsing HTML.
   */
  title: string;
  language?: string;     // For code artifacts
  content: string;
  createdAt: number;
  /**
   * Last-edit timestamp (ms). Added in Phase 3.2 for LWW sync. Optional on
   * the type so pre-migration persisted rows don't crash on rehydrate —
   * the store stamps `updatedAt = Date.now()` on every upsert anyway, so
   * any rehydrated row gets a fresh value the moment it's touched. Consumers
   * that care (server sync) fall back to `updatedAt ?? createdAt`.
   */
  updatedAt?: number;
}

export interface ParsedMessage {
  /** Content with artifacts stripped out. */
  cleanContent: string;
  /** Placeholders tokens inserted at artifact locations. Format: [[ARTIFACT:id]] */
  artifacts: Artifact[];
}

const OPEN_RE = /<artifact\b([^>]*)>/i;
const CLOSE_TAG = '</artifact>';

/**
 * Walk a message string, extracting <artifact>...</artifact> blocks.
 * Non-terminated artifacts (still streaming) are emitted with whatever content
 * has arrived so far, so the UI can show a "generating..." indicator.
 *
 * If the model didn't wrap its output in an explicit <artifact> tag but clearly
 * produced a viewable deliverable (a full HTML doc, an SVG, a React component,
 * a Mermaid diagram) inside a fenced code block, we auto-promote the largest
 * such block to an artifact. This gracefully handles models that don't reliably
 * follow the artifact instruction (e.g. DeepSeek often just emits ```html).
 */
export function parseMessage(content: string, messageIdHint?: string): ParsedMessage {
  const artifacts: Artifact[] = [];
  let cleanContent = '';
  let cursor = 0;
  let artifactIdx = 0;

  while (cursor < content.length) {
    const openMatch = OPEN_RE.exec(content.slice(cursor));
    if (!openMatch) {
      cleanContent += content.slice(cursor);
      break;
    }
    const openStart = cursor + openMatch.index;
    const openEnd = openStart + openMatch[0].length;
    const attrs = parseAttrs(openMatch[1]);

    // Append everything before the artifact tag
    cleanContent += content.slice(cursor, openStart);

    // Find closing tag
    const closeIdx = content.indexOf(CLOSE_TAG, openEnd);
    const inner =
      closeIdx === -1
        ? content.slice(openEnd)                 // streaming, not yet closed
        : content.slice(openEnd, closeIdx);

    const id = attrs.id || `${messageIdHint ?? 'msg'}-art-${artifactIdx++}`;
    const type = (attrs.type as ArtifactType) || inferType(inner, attrs.language);
    artifacts.push({
      id,
      messageId: messageIdHint,
      type,
      title: attrs.title || defaultTitle(type),
      language: attrs.language,
      content: inner.trim(),
      createdAt: Date.now(),
    });

    cleanContent += `\n\n[[ARTIFACT:${id}]]\n\n`;

    cursor = closeIdx === -1 ? content.length : closeIdx + CLOSE_TAG.length;
  }

  // Auto-promote: if the model didn't use <artifact> tags but produced a large
  // viewable code block, lift it into an artifact so the user gets a preview.
  if (artifacts.length === 0) {
    const promoted = autoPromoteCodeBlock(cleanContent, messageIdHint);
    if (promoted) {
      return promoted;
    }
  }

  return { cleanContent, artifacts };
}

/** Fenced code block: ```lang\n...\n``` — only closed ones. */
const FENCE_RE = /```([a-zA-Z0-9_+-]*)\s*\n([\s\S]*?)```/g;

const AUTO_PROMOTE_MIN_CHARS = 500;
const AUTO_PROMOTE_MIN_LINES = 15;

/**
 * Scan for the single biggest fenced block that looks like a viewable
 * deliverable; if found, return a new ParsedMessage with it promoted.
 */
function autoPromoteCodeBlock(
  content: string,
  messageIdHint?: string
): ParsedMessage | null {
  FENCE_RE.lastIndex = 0;
  let best: {
    start: number;
    end: number;
    lang: string;
    body: string;
    type: ArtifactType;
  } | null = null;

  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(content)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    const body = m[2];
    if (body.length < AUTO_PROMOTE_MIN_CHARS) continue;
    if (body.split('\n').length < AUTO_PROMOTE_MIN_LINES) continue;

    const type = classifyViewable(lang, body);
    if (!type) continue;

    if (!best || body.length > best.body.length) {
      best = { start: m.index, end: m.index + m[0].length, lang, body, type };
    }
  }

  if (!best) return null;

  const id = `${messageIdHint ?? 'msg'}-auto-0`;
  const artifact: Artifact = {
    id,
    messageId: messageIdHint,
    type: best.type,
    title: defaultTitle(best.type),
    language: best.lang || undefined,
    content: best.body.trim(),
    createdAt: Date.now(),
  };

  const cleanContent =
    content.slice(0, best.start) +
    `\n\n[[ARTIFACT:${id}]]\n\n` +
    content.slice(best.end);

  return { cleanContent, artifacts: [artifact] };
}

/**
 * Decide if a fenced block is worth previewing.
 * Returns the artifact type, or null if it should stay as a regular code block.
 */
function classifyViewable(lang: string, body: string): ArtifactType | null {
  const head = body.trim().slice(0, 200).toLowerCase();

  if (lang === 'html' || head.startsWith('<!doctype') || head.startsWith('<html')) {
    return 'html';
  }
  if (lang === 'svg' || head.startsWith('<svg')) {
    return 'svg';
  }
  if (lang === 'mermaid') return 'mermaid';
  if (
    (lang === 'jsx' || lang === 'tsx' || lang === 'react') &&
    /export\s+default|function\s+App|const\s+App\s*=/.test(body)
  ) {
    return 'react';
  }
  return null;
}

/** Tiny attribute parser for artifact open tags. */
function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function inferType(content: string, language?: string): ArtifactType {
  const c = content.trim().slice(0, 120).toLowerCase();
  if (c.startsWith('<svg')) return 'svg';
  if (c.startsWith('<!doctype') || c.startsWith('<html') || c.includes('<body')) return 'html';
  if (language === 'mermaid') return 'mermaid';
  if (language === 'markdown' || language === 'md') return 'markdown';
  if (language) return 'code';
  return 'markdown';
}

function defaultTitle(type: ArtifactType): string {
  return type === 'html'
    ? '网页'
    : type === 'react'
      ? 'React 组件'
      : type === 'svg'
        ? '矢量图'
        : type === 'mermaid'
          ? '流程图'
          : type === 'code'
            ? '代码'
            : '文档';
}

/** Build a full HTML document from an artifact for iframe rendering. */
export function artifactToHtml(artifact: Artifact): string {
  switch (artifact.type) {
    case 'html':
      return artifact.content;
    case 'svg':
      return `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:16px;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafaf7}
        svg{max-width:100%;max-height:100%;height:auto;width:auto}
      </style></head><body>${artifact.content}</body></html>`;
    case 'mermaid':
      return `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:16px;background:#fafaf7;font-family:system-ui}
      </style></head><body>
      <div class="mermaid">${escapeHtml(artifact.content)}</div>
      <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
      <script>mermaid.initialize({startOnLoad:true, theme:'neutral'});</script>
      </body></html>`;
    case 'react':
      return `<!doctype html><html><head><meta charset="utf-8">
      <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
      <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
      <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>html,body{margin:0;padding:0;background:#fafaf7;font-family:system-ui}</style>
      </head><body><div id="root"></div>
      <script type="text/babel" data-presets="react,typescript">
        ${artifact.content}
        const __Root = typeof App !== 'undefined' ? App : null;
        if (__Root) ReactDOM.createRoot(document.getElementById('root')).render(<__Root />);
      </script></body></html>`;
    case 'markdown':
      return `<!doctype html><html><head><meta charset="utf-8">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-light.css">
      <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
      <style>body{margin:0;padding:32px;max-width:760px;margin:auto}</style>
      </head><body class="markdown-body" id="o"></body>
      <script>document.getElementById('o').innerHTML = marked.parse(${JSON.stringify(artifact.content)});</script>
      </html>`;
    case 'image': {
      // `content` is the image URL (PPIO CDN typically). Render it
      // centred with object-fit:contain so the whole picture is
      // visible regardless of the iframe's aspect ratio. Right-click
      // → save-as works as it would for any <img>. We escape the URL
      // for HTML attribute safety even though our trusted server-side
      // generator is the only origin.
      const url = escapeHtml(artifact.content);
      const altText = escapeHtml(artifact.title || 'Generated image');
      return `<!doctype html><html><head><meta charset="utf-8">
      <style>
        html,body{margin:0;padding:0;width:100%;height:100%;background:#fafaf7;display:flex;align-items:center;justify-content:center}
        img{max-width:100%;max-height:100%;object-fit:contain;display:block}
      </style></head><body>
      <img src="${url}" alt="${altText}" />
      </body></html>`;
    }
    case 'code':
    default:
      return `<!doctype html><html><head><meta charset="utf-8">
      <style>html,body{margin:0;padding:0;background:#2b2b29;color:#e6e1cf;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:13px;line-height:1.6}
      pre{margin:0;padding:24px;white-space:pre-wrap;word-break:break-word}</style>
      </head><body><pre>${escapeHtml(artifact.content)}</pre></body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const ARTIFACT_SYSTEM_HINT = `When you produce a substantial, self-contained deliverable (an HTML page, a React component, an SVG image, a Mermaid diagram, or a long document), wrap it in an <artifact> block so the user can view it in a dedicated panel:

<artifact type="html" id="my-login" title="登录表单">
<!doctype html>
<html>...
</html>
</artifact>

Valid types: html, react, svg, mermaid, markdown, code.
- Use a short kebab-case id that you can reference again to update the artifact.
- Keep normal short replies as plain Markdown (do NOT wrap small snippets in artifacts).
- You may produce multiple artifacts in one reply.`;
