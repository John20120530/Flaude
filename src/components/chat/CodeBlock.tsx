import { useState, type ComponentPropsWithoutRef } from 'react';
import { Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';

type PreProps = ComponentPropsWithoutRef<'pre'>;

const COLLAPSE_LINE_THRESHOLD = 24;

/**
 * Custom `<pre>` renderer for react-markdown.
 * Adds a language label and copy button, and keeps rehype-highlight classes.
 *
 * Visual: a warm dark-grey (close to Claude's actual code block color) that
 * harmonizes with the cream background, rather than near-black which reads
 * too heavy on a light UI.
 */
export default function CodeBlock({ children, ...rest }: PreProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // react-markdown passes the <code> element as children
  const codeEl = extractCodeElement(children);
  const codeText = getCodeText(codeEl);
  const language = getLanguage(codeEl);
  const lineCount = codeText.split('\n').length;
  const collapsible = lineCount > COLLAPSE_LINE_THRESHOLD;

  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* silent */
    }
  };

  return (
    <div
      className="relative group/code my-3 rounded-xl overflow-hidden
                 bg-[#2b2b29] dark:bg-[#1f1f1e]
                 border border-black/10 dark:border-white/10 shadow-sm"
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 text-xs font-mono
                   text-white/55 bg-white/[0.04] border-b border-white/[0.07]"
      >
        <span className="uppercase tracking-wide">{language || 'text'}</span>
        <div className="flex items-center gap-3">
          {collapsible && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 hover:text-white/90 transition"
              title={expanded ? '折叠代码' : '展开全部代码'}
            >
              {expanded ? (
                <>
                  <ChevronUp className="w-3 h-3" /> 折叠
                </>
              ) : (
                <>
                  <ChevronDown className="w-3 h-3" /> 展开 {lineCount} 行
                </>
              )}
            </button>
          )}
          <button
            onClick={doCopy}
            className="flex items-center gap-1 hover:text-white/90 transition"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-green-400" /> 已复制
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" /> 复制
              </>
            )}
          </button>
        </div>
      </div>
      <div
        className={
          collapsible && !expanded
            ? 'relative max-h-[22rem] overflow-hidden'
            : 'relative'
        }
      >
        <pre
          {...rest}
          className="!m-0 !bg-transparent overflow-x-auto p-4 text-[13px] leading-relaxed"
        >
          {children}
        </pre>
        {collapsible && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="absolute inset-x-0 bottom-0 h-16 flex items-end justify-center pb-2
                       text-xs text-white/70 hover:text-white
                       bg-gradient-to-t from-[#2b2b29] via-[#2b2b29]/80 to-transparent
                       dark:from-[#1f1f1e] dark:via-[#1f1f1e]/80"
          >
            <span className="flex items-center gap-1">
              <ChevronDown className="w-3 h-3" /> 展开剩余 {lineCount - COLLAPSE_LINE_THRESHOLD} 行
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function extractCodeElement(children: unknown): { className?: string; children?: unknown } | null {
  if (!children || typeof children !== 'object') return null;
  // React element
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = children as any;
  if (el.props) return el.props;
  return null;
}

function getLanguage(codeEl: { className?: string } | null): string | null {
  if (!codeEl?.className) return null;
  const m = codeEl.className.match(/language-(\w+)/);
  return m ? m[1] : null;
}

function getCodeText(codeEl: { children?: unknown } | null): string {
  if (!codeEl) return '';
  const c = codeEl.children;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : '')).join('');
  return String(c ?? '');
}
