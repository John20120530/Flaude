/**
 * Pull the latest design payload out of a conversation's messages.
 *
 * The Design-mode system prompt (see `config/designSystemPrompt.ts`) tells the
 * model to emit *one* fenced code block per turn: ```html / ```jsx / ```svg /
 * ```mermaid. The DesignCanvas needs the most-recent such block from the
 * conversation so it can re-render the iframe whenever a new assistant turn
 * lands.
 *
 * Why a tiny dedicated extractor instead of reusing artifacts.parseMessage:
 *   - parseMessage promotes blocks to artifacts only above a length threshold.
 *     A 200-line design from the model is "small" by Claude-Code standards but
 *     totally normal here, and we don't want it bouncing in and out of artifact
 *     status as the user iterates.
 *   - parseMessage strips the block out and replaces it with a placeholder
 *     token. For Design we want the *raw* block content so we can pipe it
 *     straight to an iframe srcdoc.
 *   - A 25-line scanner is easier to reason about than reusing 200 lines of
 *     artifact code that has to remain backward-compatible with Chat/Code.
 *
 * Returns `null` if no fenced design block has been produced yet (typical for
 * a brand-new conversation, or the very first frame of a stream before any
 * tokens have arrived).
 */
import type { Conversation, Message } from '@/types';

export type DesignFormat = 'html' | 'jsx' | 'svg' | 'mermaid';

export interface DesignBlock {
  /** Source language tag from the fence — narrowed to known formats. */
  format: DesignFormat;
  /** Raw block content (unescaped, no surrounding fences). */
  content: string;
  /** ID of the assistant message this block came from. Used for version list. */
  messageId: string;
  /** Conversation-time when the message landed (ms). */
  createdAt: number;
}

const FENCE_RE = /```([a-zA-Z0-9_+-]*)\s*\n([\s\S]*?)```/g;

function normaliseFormat(lang: string, body: string): DesignFormat | null {
  const l = lang.toLowerCase();
  if (l === 'html') return 'html';
  if (l === 'jsx' || l === 'tsx' || l === 'react') return 'jsx';
  if (l === 'svg') return 'svg';
  if (l === 'mermaid') return 'mermaid';

  // Be tolerant: if the model forgot the fence-language tag but the body
  // looks like HTML / SVG, infer it. Saves the user a round-trip when the
  // model slips on the contract.
  if (!l) {
    const head = body.trim().slice(0, 60).toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')) return 'html';
    if (head.startsWith('<svg')) return 'svg';
  }
  return null;
}

/**
 * Languages the design system prompt asks the model to emit. Used by the
 * collapse helper below to decide whether a given fence should be hidden
 * from the chat thread (because the canvas already renders it) or left
 * inline (because it's just prose context — e.g. ```bash for a CLI hint).
 */
const DESIGN_FENCE_LANGS = new Set([
  'html',
  'jsx',
  'tsx',
  'react',
  'svg',
  'mermaid',
]);

function langToFormat(lang: string): DesignFormat | null {
  if (lang === 'html') return 'html';
  if (lang === 'jsx' || lang === 'tsx' || lang === 'react') return 'jsx';
  if (lang === 'svg') return 'svg';
  if (lang === 'mermaid') return 'mermaid';
  return null;
}

/**
 * Rewrite an assistant message's content for display in DesignView's chat
 * column. Each *design* fence (html / jsx / svg / mermaid, plus tag-less
 * fences whose body obviously contains HTML or SVG) is replaced with a
 * compact placeholder of the form `[[DESIGNBLOCK:<fmt>:<bodyLen>]]`. An
 * unclosed trailing fence — which is what we see mid-stream before the
 * closing backticks arrive, or when the model dies with a network error —
 * becomes `[[DESIGNBLOCK_PARTIAL:<fmt>:<bodyLen>]]`.
 *
 * MessageList renders these placeholders as a one-line chip pointing the
 * user at the right-hand canvas, so the chat thread doesn't double up the
 * 200-line HTML the canvas already shows.
 *
 * Non-design fences (```bash, ```json, etc.) are left untouched — design
 * mode messages occasionally include those for prose context and we want
 * them to render as normal markdown code blocks.
 */
export function collapseDesignBlocks(content: string): string {
  const FENCE = /```([a-zA-Z0-9_+-]*)\s*\n([\s\S]*?)```/g;
  let out = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(content)) !== null) {
    out += content.slice(lastIdx, m.index);
    const lang = (m[1] || '').toLowerCase();
    const body = m[2];
    const fmt = normaliseFormat(lang, body);
    if (fmt) {
      // Trim before measuring so the chip's size hint reflects the actual
      // payload, not the trailing newline that the fence regex always
      // includes between the body and the closing backticks.
      out += `[[DESIGNBLOCK:${fmt}:${body.trim().length}]]`;
    } else {
      out += m[0];
    }
    lastIdx = m.index + m[0].length;
  }

  // Trailing unclosed fence — mid-stream, or stream died before the closer
  // landed. Detect by scanning for a stray ``` after the last closed fence.
  const tail = content.slice(lastIdx);
  const openIdx = tail.indexOf('```');
  if (openIdx < 0) {
    return out + tail;
  }
  const before = tail.slice(0, openIdx);
  const after = tail.slice(openIdx + 3);
  const nl = after.indexOf('\n');
  const headerLang = (nl >= 0 ? after.slice(0, nl) : after).trim().toLowerCase();
  const body = nl >= 0 ? after.slice(nl + 1) : '';

  let fmt: DesignFormat | null = null;
  if (DESIGN_FENCE_LANGS.has(headerLang)) {
    fmt = langToFormat(headerLang);
  } else if (!headerLang) {
    // Empty lang tag — fall back to body sniffing (same logic as the
    // closed-fence path so behaviour is consistent).
    const head = body.trim().slice(0, 60).toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')) fmt = 'html';
    else if (head.startsWith('<svg')) fmt = 'svg';
  }

  if (fmt) {
    // No closing fence yet, so `body` is whatever's been streamed so far.
    // We don't trim here — we want the chip to grow visibly as more bytes
    // arrive, even if the trailing whitespace is just a half-rendered
    // newline from the model's last token.
    return out + before + `[[DESIGNBLOCK_PARTIAL:${fmt}:${body.length}]]`;
  }
  // Unknown lang — leave the raw fence in place so non-design content still
  // shows up correctly in the chat (e.g. an open ```bash that hasn't closed).
  return out + tail;
}

/**
 * Extract the *first* design block from a single assistant message.
 * Used to figure out whether a given turn produced renderable output.
 */
export function extractDesignFromMessage(message: Message): DesignBlock | null {
  if (message.role !== 'assistant' || !message.content) return null;
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(message.content)) !== null) {
    const fmt = normaliseFormat(m[1] || '', m[2]);
    if (!fmt) continue;
    return {
      format: fmt,
      content: m[2].trim(),
      messageId: message.id,
      createdAt: message.createdAt,
    };
  }
  return null;
}

/**
 * Walk the conversation backwards and return the most recent assistant
 * message that produced a renderable design block. Skips assistant turns
 * that were just prose (e.g. the model asking a clarifying question).
 */
export function latestDesignBlock(conv: Conversation): DesignBlock | null {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role !== 'assistant') continue;
    const block = extractDesignFromMessage(m);
    if (block) return block;
  }
  return null;
}

/**
 * Walk the conversation forwards and collect every assistant message that
 * produced a design block. Used by the version list / "iteration history"
 * UI in DesignView so the user can flip back to v3 when v5 went sideways.
 *
 * Returned in chronological order — the consumer reverses for "newest first"
 * if it wants to.
 */
export function allDesignBlocks(conv: Conversation): DesignBlock[] {
  const out: DesignBlock[] = [];
  for (const m of conv.messages) {
    if (m.role !== 'assistant') continue;
    const block = extractDesignFromMessage(m);
    if (block) out.push(block);
  }
  return out;
}

/**
 * Wrap a design block's raw content into a self-contained HTML document
 * suitable for an iframe `srcdoc`. For html blocks the content already
 * contains `<!doctype html>...</html>` (per the system prompt contract),
 * but for jsx/svg/mermaid we have to produce a runnable shell.
 *
 * `injectExportBridge` adds a tiny postMessage listener so the parent window
 * can request a PNG capture via html2canvas. We only inject it when the
 * caller wants export — keeps the "preview" pipeline minimal.
 *
 * `injectAutoHeight` (v0.1.66) adds a second postMessage emitter that posts
 * `document.documentElement.scrollHeight` to the parent on load + on every
 * subsequent layout change. The DesignCanvas listens and resizes the
 * iframe element to match — without this, iframe element height is
 * controlled purely by CSS (h-full + min-h-[600px]) and a short design
 * leaves a white strip below the body's actual content (because the
 * wrapper card's bg-white shows through where the iframe is taller than
 * its body). We only inject for preview, not for the downloaded HTML
 * file (the postMessage call is dead code outside Flaude's iframe).
 */
export function buildDesignDocument(
  block: DesignBlock,
  options: { injectExportBridge?: boolean; injectAutoHeight?: boolean } = {}
): string {
  const bridges =
    (options.injectExportBridge ? EXPORT_BRIDGE_SCRIPT : '') +
    (options.injectAutoHeight ? AUTO_HEIGHT_SCRIPT : '');
  switch (block.format) {
    case 'html': {
      // The model emitted a full document. Insert the bridges just before
      // </body> so they don't fight the page's own scripts.
      if (!bridges) return block.content;
      return injectBeforeBodyEnd(block.content, bridges);
    }
    case 'svg':
      return `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:24px;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafaf7}
        svg{max-width:100%;max-height:100%;height:auto;width:auto}
      </style></head><body>${block.content}${bridges}</body></html>`;
    case 'mermaid':
      return `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;padding:24px;background:#fafaf7;font-family:system-ui}
      </style></head><body>
      <div class="mermaid">${escapeHtml(block.content)}</div>
      <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
      <script>mermaid.initialize({startOnLoad:true, theme:'neutral'});</script>
      ${bridges}
      </body></html>`;
    case 'jsx':
      return `<!doctype html><html><head><meta charset="utf-8">
      <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
      <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
      <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>html,body{margin:0;padding:0;background:#fafaf7;font-family:system-ui}</style>
      </head><body><div id="root"></div>
      <script type="text/babel" data-presets="react,typescript">
        ${block.content}
        const __Root = typeof App !== 'undefined' ? App : null;
        if (__Root) ReactDOM.createRoot(document.getElementById('root')).render(<__Root />);
      </script>
      ${bridges}
      </body></html>`;
  }
}

/**
 * Auto-height bridge — posts the rendered document height back to the
 * parent (DesignCanvas) so the parent can size the iframe element to
 * exactly fit its content. Without this the iframe is whatever CSS
 * height we give it (h-full + min-h-[600px]), and any design shorter
 * than the wrapper card's height shows a white strip at the bottom
 * (the bit of the iframe element below the body's actual content).
 *
 * Triggers re-post on:
 *   - `load` event (initial paint with all subresources, including
 *     remote images from /api/image/<sha>... that arrive async)
 *   - ResizeObserver on documentElement (catches Tailwind's CDN-hot-
 *     swapped styles, container queries, viewport-bound layouts)
 *   - bubbled `load` events from descendant <img> tags (catches the
 *     case where layout was already settled but an image just finished
 *     decoding and pushed body taller)
 *
 * postMessage target is `*` because the iframe is sandboxed without
 * `allow-same-origin`, so `parent.location.origin` reads as `null`
 * and a strict origin check would just discard our own messages.
 */
const AUTO_HEIGHT_SCRIPT = `<script>
(function(){
  function postHeight(){
    try {
      var de = document.documentElement;
      var b  = document.body;
      var h = Math.max(
        de ? de.scrollHeight : 0,
        b  ? b.scrollHeight  : 0,
        de ? de.offsetHeight : 0,
        b  ? b.offsetHeight  : 0
      );
      parent.postMessage({type:'flaude-iframe-height', height: Math.ceil(h)}, '*');
    } catch(e) {}
  }
  if (document.readyState === 'complete') postHeight();
  else window.addEventListener('load', postHeight);
  // Catch dynamic layout shifts (CDN tailwind, container queries, etc).
  if (typeof ResizeObserver !== 'undefined') {
    try { new ResizeObserver(postHeight).observe(document.documentElement); } catch(e) {}
  }
  // Catch async <img> loads pushing body taller after initial paint.
  document.addEventListener('load', function(e){
    if (e.target && e.target.tagName === 'IMG') postHeight();
  }, true);
})();
</script>`;

/**
 * Postscript html2canvas + listener. Loaded lazily — the canvas only injects
 * this when export is requested. Listens for `{type:'flaude-capture', scale}`
 * from the parent window and replies with `{type:'flaude-capture-result',
 * dataUrl}` (or `error`).
 *
 * `useCORS:false` + `backgroundColor:null` are deliberate: the typical design
 * uses Tailwind utilities + picsum.photos placeholders, both of which work
 * inside the iframe without crossing-origin-fetching anything we'd need to
 * taint. If a future design pulls in a remote font, html2canvas will skip it
 * silently and the PNG will fall back to system fonts — acceptable for a
 * "share preview" use case.
 */
const EXPORT_BRIDGE_SCRIPT = `<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
<script>
(function(){
  function reply(payload){ try { parent.postMessage(payload, '*'); } catch(e) {} }
  window.addEventListener('message', async function(e){
    if (!e.data || e.data.type !== 'flaude-capture') return;
    var scale = Number(e.data.scale) || 2;
    try {
      if (typeof html2canvas !== 'function') {
        reply({type:'flaude-capture-result', error:'html2canvas not loaded'});
        return;
      }
      var canvas = await html2canvas(document.body, { scale: scale, backgroundColor: '#ffffff', useCORS: false, logging: false });
      reply({type:'flaude-capture-result', dataUrl: canvas.toDataURL('image/png')});
    } catch (err) {
      reply({type:'flaude-capture-result', error: String(err && err.message || err)});
    }
  });
  reply({type:'flaude-capture-ready'});
})();
</script>`;

function injectBeforeBodyEnd(html: string, snippet: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
