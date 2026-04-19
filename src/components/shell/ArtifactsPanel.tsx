/**
 * Right-side preview panel for artifacts (Claude-style Canvas).
 *
 * Receives a parsed `Artifact` from the store and renders either its live
 * preview (HTML in a sandboxed iframe) or the raw source.
 *
 * Two non-obvious design choices:
 *
 * 1. **`srcdoc` over Blob URL**: the previous implementation wrapped `html`
 *    in `new Blob(...)` + `URL.createObjectURL`, which (a) leaked the URL
 *    on every change — iframes get a new URL each token during streaming,
 *    dozens per second — and (b) failed to revoke any of them. We now use
 *    `srcdoc` directly; no lifecycle management needed.
 *
 * 2. **Debounced iframe updates**: during streaming every delta rewrites
 *    the iframe's document, which looks like a strobe light. We coalesce
 *    updates to at most one per ~300 ms. The final state always lands because
 *    the trailing timer fires after the stream stops.
 */

import { X, Code, Eye, Download, Copy, Check, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { artifactToHtml } from '@/lib/artifacts';
import { cn } from '@/lib/utils';

/** Tune with care: too small = strobe during streaming; too large = laggy preview. */
const IFRAME_DEBOUNCE_MS = 300;

export default function ArtifactsPanel() {
  const activeArtifactId = useAppStore((s) => s.activeArtifactId);
  const artifacts = useAppStore((s) => s.artifacts);
  const setActiveArtifact = useAppStore((s) => s.setActiveArtifact);
  const toggleArtifacts = useAppStore((s) => s.toggleArtifacts);
  const deleteArtifact = useAppStore((s) => s.deleteArtifact);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const [copied, setCopied] = useState(false);

  const artifactList = useMemo(
    () => Object.values(artifacts).sort((a, b) => b.createdAt - a.createdAt),
    [artifacts]
  );

  const active = activeArtifactId ? artifacts[activeArtifactId] : artifactList[0];

  const html = useMemo(() => (active ? artifactToHtml(active) : ''), [active]);

  // Debounced mirror of `html` for the iframe. Prevents token-by-token
  // reloads from thrashing the WebView2 process during streaming. When the
  // active artifact ID changes we DO want to flush immediately (otherwise
  // the user would stare at stale content for ~300ms after switching tabs),
  // so we use a ref to compare the previous id and bypass the debounce.
  const [debouncedHtml, setDebouncedHtml] = useState(html);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevIdRef = useRef<string | undefined>(active?.id);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const idChanged = prevIdRef.current !== active?.id;
    prevIdRef.current = active?.id;
    if (idChanged) {
      // Immediate commit — artifact switch, no strobe risk.
      setDebouncedHtml(html);
      return;
    }
    // Same artifact, content changed (streaming) — coalesce.
    timerRef.current = setTimeout(() => setDebouncedHtml(html), IFRAME_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [html, active?.id]);

  // Manual "reload iframe" — incrementing forces React to remount the
  // iframe element, which kicks the WebView into re-running any JS (React,
  // mermaid, etc.) from scratch. Useful when the preview gets into a weird
  // state without a content change to trigger an update.
  const [iframeKey, setIframeKey] = useState(0);

  const copyContent = async () => {
    if (!active) return;
    await navigator.clipboard.writeText(active.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const download = () => {
    if (!active) return;
    const ext =
      active.type === 'html'
        ? 'html'
        : active.type === 'svg'
          ? 'svg'
          : active.type === 'markdown'
            ? 'md'
            : active.language || 'txt';
    const blob = new Blob([active.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${active.title.replace(/[^a-z0-9\u4e00-\u9fa5-_]+/gi, '_')}.${ext}`;
    a.click();
    // Give the browser a tick to initiate the download before we revoke.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="h-12 shrink-0 flex items-center px-3 border-b border-claude-border dark:border-night-border gap-2">
        <div className="text-sm font-medium truncate flex-1">
          {active?.title ?? '工件'}
          {active && (
            <span className="ml-2 text-[10px] uppercase tracking-wider text-claude-muted dark:text-night-muted">
              {active.type}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab('preview')}
            className={cn('btn-ghost', tab === 'preview' && 'bg-black/5 dark:bg-white/5')}
            title="预览"
          >
            <Eye className="w-4 h-4" />
          </button>
          <button
            onClick={() => setTab('code')}
            className={cn('btn-ghost', tab === 'code' && 'bg-black/5 dark:bg-white/5')}
            title="源码"
          >
            <Code className="w-4 h-4" />
          </button>
          {tab === 'preview' && active && (
            <button
              onClick={() => setIframeKey((k) => k + 1)}
              className="btn-ghost"
              title="重新加载预览"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
          <button onClick={copyContent} className="btn-ghost" title="复制源码" disabled={!active}>
            {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
          </button>
          <button onClick={download} className="btn-ghost" title="下载" disabled={!active}>
            <Download className="w-4 h-4" />
          </button>
          {/*
            Deletes the CURRENT artifact from the store. Separate from the
            panel-close button below — "关闭面板" hides the panel but keeps
            all artifacts around, "删除此工件" removes this one deliverable
            (the rest stay; if this was the last one, the store also closes
            the panel automatically).
          */}
          <button
            onClick={() => active && deleteArtifact(active.id)}
            className="btn-ghost hover:text-red-500"
            title="删除此工件"
            disabled={!active}
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button onClick={toggleArtifacts} className="btn-ghost" title="关闭面板">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {artifactList.length > 1 && (
        <div className="px-2 py-1 flex gap-1 border-b border-claude-border dark:border-night-border overflow-x-auto">
          {artifactList.map((a) => (
            // Browser-tab UX: one button selects, a nested X deletes. We
            // model this as a `div` with role=button (rather than nested
            // <button>s, which is invalid HTML and confuses screen readers).
            // The outer keydown makes Enter/Space activate the switcher the
            // same way a real button would.
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              onClick={() => setActiveArtifact(a.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveArtifact(a.id);
                }
              }}
              className={cn(
                'group/chip text-xs pl-2 pr-1 py-1 rounded-md whitespace-nowrap transition flex items-center gap-1 cursor-pointer',
                a.id === active?.id
                  ? 'bg-claude-accent/10 text-claude-accent'
                  : 'hover:bg-black/5 dark:hover:bg-white/5 text-claude-muted dark:text-night-muted'
              )}
            >
              <span>{a.title}</span>
              <button
                type="button"
                onClick={(e) => {
                  // Stop propagation so the outer chip's click (which would
                  // activate the artifact we just deleted) doesn't fire.
                  e.stopPropagation();
                  deleteArtifact(a.id);
                }}
                // Always reachable via keyboard, but visually understated
                // until the chip is hovered/focused — keeps the switcher
                // looking clean when you're just scanning titles.
                className="opacity-0 group-hover/chip:opacity-100 focus:opacity-100 hover:bg-black/10 dark:hover:bg-white/10 rounded p-0.5 transition"
                aria-label={`删除工件 ${a.title}`}
                title="删除此工件"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-hidden bg-white dark:bg-[#1a1918]">
        {!active ? (
          <div className="h-full flex flex-col items-center justify-center text-sm text-claude-muted dark:text-night-muted gap-2 px-6 text-center">
            <Eye className="w-8 h-8 opacity-30" />
            <div>还没有工件。</div>
            <div className="text-xs opacity-70">
              当 Flaude 生成 HTML、SVG、Mermaid、React 组件或长文档时，会自动出现在这里。
            </div>
          </div>
        ) : tab === 'preview' ? (
          <iframe
            key={iframeKey}
            srcDoc={debouncedHtml}
            // `allow-scripts` is required for React/Mermaid to hydrate. We do
            // NOT add `allow-same-origin` — the iframe stays in an opaque origin,
            // so artifact scripts can't read the parent app's localStorage / cookies.
            sandbox="allow-scripts"
            className="w-full h-full border-0"
            title={active.title}
          />
        ) : (
          <pre className="h-full overflow-auto font-mono text-xs p-4 bg-[#0f1115] text-[#e6e1cf] m-0">
            {active.content}
          </pre>
        )}
      </div>
    </div>
  );
}
