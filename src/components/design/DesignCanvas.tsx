/**
 * DesignCanvas — the right-hand pane of Design mode.
 *
 * Responsibilities:
 *   - Render the latest design block in a sandboxed iframe.
 *   - Let the user flip between mobile / desktop breakpoints.
 *   - Toggle between rendered preview and source code view.
 *   - Trigger downloads: full HTML file, or 2x retina PNG.
 *
 * Design notes:
 *   - The iframe uses `srcdoc` (not `src`) so we never round-trip through a
 *     blob: URL — keeps the rendered HTML in DevTools the same as the source.
 *   - The PREVIEW iframe's sandbox is `allow-scripts` only. NOT
 *     `allow-same-origin`. This means the iframe runs as an opaque origin,
 *     so any `fetch()` / cookie / localStorage call inside the design
 *     fails by design — which matches what we tell the model in
 *     `designSystemPrompt.ts`.
 *   - The EXPORT iframe (used only for PNG capture, mounted offscreen and
 *     destroyed after one snapshot) does grant `allow-same-origin` because
 *     html2canvas internally creates a clone iframe whose contentDocument
 *     it has to read back — that readback only works when both iframes
 *     share an origin. See `capturePng` below for the rationale + the
 *     security boundaries that keep this from being scary.
 *   - PNG export uses html2canvas inside the iframe, talking to the parent
 *     via postMessage. The bridge script (see `designExtract.ts`) is only
 *     injected when the user clicks 导出 PNG, so the typical preview path
 *     stays slim. We use a fresh iframe for the capture so the visible
 *     preview iframe never has html2canvas loaded into it (avoids weird
 *     interaction with the user's own scripts).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Smartphone,
  Monitor,
  Code as CodeIcon,
  Eye,
  Download,
  Image as ImageIcon,
  Loader2,
  Sparkles,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { downloadTextFile } from '@/lib/tauri';
import { buildDesignDocument, type DesignBlock } from '@/lib/designExtract';

interface Props {
  /**
   * Every design block produced in this conversation, in chronological order.
   * Empty array → empty state. The user can step backwards through previous
   * versions via the v N/M chip in the toolbar.
   */
  blocks: DesignBlock[];
  /**
   * Becomes true the moment a streaming assistant message starts producing
   * a fenced block (even if the block isn't terminated yet). Used to show a
   * subtle "rendering..." overlay so the canvas doesn't look frozen mid-token.
   */
  streaming?: boolean;
}

type Breakpoint = 'mobile' | 'desktop';
type ViewMode = 'preview' | 'code';

const BREAKPOINT_PX: Record<Breakpoint, number | null> = {
  mobile: 390, // iPhone 14/15 portrait — the "designed for mobile first" reference
  desktop: null, // null → fills the available width (responsive flex)
};

const BREAKPOINT_LABEL: Record<Breakpoint, string> = {
  mobile: '手机',
  desktop: '桌面',
};

/** Friendly default filename for downloads — date-stamped, kebab-cased. */
function defaultFilename(ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `flaude-design-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

export default function DesignCanvas({ blocks, streaming }: Props) {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>('desktop');
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  /**
   * Which version (0-indexed) is currently displayed. We track this as
   * "offset from the latest" instead of an absolute index so that when a new
   * version streams in, the user sticks to the *newest* by default — i.e. the
   * canvas auto-follows the conversation. If they manually click ⟨ to step
   * back, we record `-1`, `-2`, etc., and stop following until they hit ⟩
   * back to 0 (or a brand-new conversation resets everything).
   */
  const [versionOffset, setVersionOffset] = useState(0);

  const previewIframeRef = useRef<HTMLIFrameElement>(null);

  // Whenever a new block arrives, snap back to following the latest. Skipping
  // this would leave a user on "v3 of 5" forever once they ever scrolled back.
  // We *do* keep the offset constant if the new total dropped (e.g. after
  // regenerate replaced the latest), so a regenerate doesn't feel jumpy.
  const blockCount = blocks.length;
  useEffect(() => {
    setVersionOffset(0);
  }, [blockCount]);

  const currentIdx = Math.max(0, blockCount - 1 + versionOffset);
  const block: DesignBlock | null = blocks[currentIdx] ?? null;
  const isLatest = versionOffset === 0;

  // Build the iframe document once per (block, format) — re-render when the
  // model produces a new turn, but DON'T thrash on every keystroke into the
  // composer. `srcdoc` is reactive: changing the prop swaps the iframe doc.
  const srcDoc = useMemo(() => {
    if (!block) return '';
    return buildDesignDocument(block, { injectExportBridge: false });
  }, [block]);

  // Reset export error when a new block arrives — stale "html2canvas timeout"
  // messages from the previous version would just confuse the user.
  useEffect(() => {
    setExportError(null);
  }, [block?.messageId]);

  const goPrev = () => setVersionOffset((v) => Math.max(-(blockCount - 1), v - 1));
  const goNext = () => setVersionOffset((v) => Math.min(0, v + 1));

  const onDownloadHtml = () => {
    if (!block) return;
    // For format=html we save what the model produced verbatim. For
    // jsx/svg/mermaid we save the *built* document so the file is a runnable
    // standalone artifact rather than a fragment that needs Babel/Mermaid set
    // up to view.
    const text =
      block.format === 'html'
        ? block.content
        : buildDesignDocument(block, { injectExportBridge: false });
    void downloadTextFile(defaultFilename('html'), text);
  };

  const onExportPng = async () => {
    if (!block || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const dataUrl = await capturePng(block, 2);
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = defaultFilename('png');
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      setExportError((e as Error).message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  // Empty state — design mode just opened, no turns yet.
  if (!block) {
    return (
      <div className="flex-1 flex items-center justify-center bg-claude-bg dark:bg-night-bg">
        <div className="text-center max-w-sm px-8">
          <Sparkles className="w-10 h-10 mx-auto mb-3 text-claude-accent opacity-60" />
          <h2 className="text-lg font-semibold mb-2">还没有设计稿</h2>
          <p className="text-sm text-claude-muted dark:text-night-muted leading-relaxed">
            在左侧输入你想要的页面（比如「做一个极简的博客落地页」），
            Flaude 会直接生成可运行的 HTML，并在这里渲染成可视化设计稿。
          </p>
        </div>
      </div>
    );
  }

  const widthPx = BREAKPOINT_PX[breakpoint];

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-claude-bg dark:bg-night-bg">
      {/* Toolbar */}
      <div className="h-11 shrink-0 px-3 flex items-center gap-2 border-b border-claude-border dark:border-night-border bg-claude-surface dark:bg-night-surface">
        {/* Breakpoint cluster — segmented control style. */}
        <div className="flex items-center rounded-lg border border-claude-border dark:border-night-border overflow-hidden">
          {(['mobile', 'desktop'] as const).map((bp) => {
            const Icon = bp === 'mobile' ? Smartphone : Monitor;
            return (
              <button
                key={bp}
                type="button"
                onClick={() => setBreakpoint(bp)}
                title={BREAKPOINT_LABEL[bp]}
                className={cn(
                  'h-7 px-2.5 text-xs flex items-center gap-1 transition-colors',
                  breakpoint === bp
                    ? 'bg-claude-accent/10 text-claude-accent'
                    : 'hover:bg-claude-bg dark:hover:bg-night-bg text-claude-muted dark:text-night-muted'
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{BREAKPOINT_LABEL[bp]}</span>
              </button>
            );
          })}
        </div>

        {/* Version stepper — appears once there are 2+ versions. Lets the
            user flip back to a previous render without scrolling chat. */}
        {blockCount > 1 && (
          <div className="flex items-center rounded-lg border border-claude-border dark:border-night-border overflow-hidden">
            <button
              type="button"
              onClick={goPrev}
              disabled={currentIdx === 0}
              title="上一版"
              className="h-7 px-1.5 hover:bg-claude-bg dark:hover:bg-night-bg text-claude-muted dark:text-night-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span
              className={cn(
                'h-7 px-2 text-[11px] font-mono flex items-center min-w-[3rem] justify-center',
                isLatest
                  ? 'text-claude-muted dark:text-night-muted'
                  : 'text-claude-accent bg-claude-accent/10'
              )}
              title={isLatest ? '最新版' : '查看历史版本（可点 ⟩ 回到最新）'}
            >
              v{currentIdx + 1}/{blockCount}
            </span>
            <button
              type="button"
              onClick={goNext}
              disabled={isLatest}
              title="下一版"
              className="h-7 px-1.5 hover:bg-claude-bg dark:hover:bg-night-bg text-claude-muted dark:text-night-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Preview / code toggle. */}
        <div className="flex items-center rounded-lg border border-claude-border dark:border-night-border overflow-hidden">
          <button
            type="button"
            onClick={() => setViewMode('preview')}
            className={cn(
              'h-7 px-2.5 text-xs flex items-center gap-1 transition-colors',
              viewMode === 'preview'
                ? 'bg-claude-accent/10 text-claude-accent'
                : 'hover:bg-claude-bg dark:hover:bg-night-bg text-claude-muted dark:text-night-muted'
            )}
          >
            <Eye className="w-3.5 h-3.5" /> 预览
          </button>
          <button
            type="button"
            onClick={() => setViewMode('code')}
            className={cn(
              'h-7 px-2.5 text-xs flex items-center gap-1 transition-colors',
              viewMode === 'code'
                ? 'bg-claude-accent/10 text-claude-accent'
                : 'hover:bg-claude-bg dark:hover:bg-night-bg text-claude-muted dark:text-night-muted'
            )}
          >
            <CodeIcon className="w-3.5 h-3.5" /> 源码
          </button>
        </div>

        <div className="flex-1" />

        <span className="text-[11px] text-claude-muted dark:text-night-muted hidden md:inline">
          格式 · {block.format.toUpperCase()}
        </span>

        <button
          type="button"
          onClick={onDownloadHtml}
          className="btn-ghost h-7 text-xs"
          title="下载完整 HTML 文件"
        >
          <Download className="w-3.5 h-3.5" />
          HTML
        </button>
        <button
          type="button"
          onClick={onExportPng}
          disabled={exporting}
          className="btn-ghost h-7 text-xs"
          title="导出 2x 高清 PNG"
        >
          {exporting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ImageIcon className="w-3.5 h-3.5" />
          )}
          PNG
        </button>
      </div>

      {exportError && (
        <div className="px-3 py-1.5 text-xs bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-b border-rose-200 dark:border-rose-900">
          导出失败：{exportError}
        </div>
      )}

      {/* Render area */}
      <div className="flex-1 min-h-0 overflow-auto p-4 flex items-start justify-center bg-[radial-gradient(circle,rgba(0,0,0,0.04)_1px,transparent_1px)] [background-size:18px_18px] dark:bg-[radial-gradient(circle,rgba(255,255,255,0.04)_1px,transparent_1px)]">
        {viewMode === 'preview' ? (
          <div
            className="bg-white shadow-xl rounded-md overflow-hidden ring-1 ring-black/5 transition-[width] duration-200 ease-out"
            style={
              widthPx
                ? { width: `${widthPx}px`, minHeight: '100%', maxWidth: '100%' }
                : { width: '100%', minHeight: '100%' }
            }
          >
            <iframe
              ref={previewIframeRef}
              title="Design preview"
              sandbox="allow-scripts"
              srcDoc={srcDoc}
              className="w-full h-full min-h-[600px] border-0 block"
            />
          </div>
        ) : (
          <pre className="w-full max-w-4xl bg-claude-surface dark:bg-night-surface rounded-md p-4 text-xs font-mono overflow-auto whitespace-pre-wrap break-words ring-1 ring-claude-border dark:ring-night-border">
            {block.content}
          </pre>
        )}
      </div>

      {streaming && (
        <div className="absolute bottom-4 right-4 text-xs text-claude-muted dark:text-night-muted bg-claude-surface/90 dark:bg-night-surface/90 backdrop-blur px-2 py-1 rounded shadow ring-1 ring-claude-border dark:ring-night-border flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" /> 正在生成…
        </div>
      )}
    </div>
  );
}

/**
 * One-shot PNG capture. We mount a *throwaway* iframe (offscreen, but in the
 * DOM so html2canvas inside it has a real layout) with the export bridge
 * injected, wait for it to load, ask it to render, and rip the data URL out
 * of the postMessage reply.
 *
 * Why a separate iframe: keeps the visible preview unmodified — no flicker
 * while html2canvas runs, and the user's design isn't polluted with the
 * library's runtime in the normal case. Phase 2 may want to keep a single
 * iframe with the bridge always loaded, but we'll need to verify the
 * library doesn't interfere with user scripts before doing that.
 */
async function capturePng(block: DesignBlock, scale: number): Promise<string> {
  const doc = buildDesignDocument(block, { injectExportBridge: true });

  return new Promise<string>((resolve, reject) => {
    const iframe = document.createElement('iframe');
    // `allow-same-origin` is mandatory here — html2canvas internally clones
    // the document into a temporary inner iframe and needs to read its
    // contentDocument back. Without same-origin, the outer (opaque-null)
    // and inner (also opaque-null) iframes are *different* opaque origins
    // and the browser blocks the readback with
    //   "Failed to read a named property 'document' from 'Window':
    //    Blocked a frame with origin 'null' from accessing a cross-origin
    //    frame."
    // The PREVIEW iframe (in the JSX above) stays locked down — that one
    // displays user-iterated designs interactively and we don't want them
    // touching parent state. The EXPORT iframe is throwaway: we mount it
    // offscreen, capture once, then remove. The 8s ceiling above puts a
    // hard cap on its lifetime. The trade-off is acceptable because (a)
    // designs are produced by Flaude's own model + system prompt, not
    // user-uploaded HTML, and (b) the user has to explicitly click 导出
    // PNG to spawn this iframe at all.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.title = 'Design export';
    iframe.style.position = 'fixed';
    iframe.style.left = '-99999px';
    iframe.style.top = '0';
    // Render at desktop width — we want full-fidelity capture, not the
    // cropped mobile preview the user might currently be staring at.
    iframe.style.width = '1440px';
    iframe.style.height = '900px';
    iframe.style.border = '0';

    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      try {
        iframe.remove();
      } catch {
        // ignore
      }
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg));
    };
    const succeed = (dataUrl: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(dataUrl);
    };

    const onMessage = (e: MessageEvent) => {
      // We match on contentWindow identity rather than origin: postMessage
      // preserves the source Window reference across the boundary, which is
      // robust regardless of whether the iframe was launched as opaque-null
      // or (since the export-iframe fix) inheriting our origin.
      if (e.source !== iframe.contentWindow) return;
      const data = e.data as
        | { type: 'flaude-capture-ready' }
        | { type: 'flaude-capture-result'; dataUrl?: string; error?: string }
        | undefined;
      if (!data) return;
      if (data.type === 'flaude-capture-ready') {
        // Bridge is alive — kick off the render. We give it a small breath
        // (next macrotask) so any deferred CSS / web fonts have a chance to
        // finish before html2canvas snapshots.
        setTimeout(() => {
          iframe.contentWindow?.postMessage({ type: 'flaude-capture', scale }, '*');
        }, 60);
        return;
      }
      if (data.type === 'flaude-capture-result') {
        if (data.dataUrl) succeed(data.dataUrl);
        else fail(data.error || 'capture failed');
      }
    };
    window.addEventListener('message', onMessage);

    // 8s ceiling. html2canvas is usually <500ms even for big designs; if it
    // hangs that long something's wrong (CSP-blocked CDN, infinite layout
    // animation, etc.) and the user deserves an error rather than a spinner
    // forever.
    setTimeout(() => fail('导出超时（>8s）'), 8000);

    document.body.appendChild(iframe);
    iframe.srcdoc = doc;
  });
}
