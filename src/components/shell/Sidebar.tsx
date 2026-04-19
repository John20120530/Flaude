import { useNavigate, useLocation, useParams } from 'react-router-dom';
import {
  MessageSquare,
  Code2,
  FolderKanban,
  Settings,
  Shield,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Pin,
  Star,
  Edit3,
  MoreHorizontal,
  Download,
  X,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { cn, formatTime } from '@/lib/utils';
import { searchConversations, type SearchHit } from '@/lib/conversationSearch';
import {
  buildConversationMarkdown,
  sanitizeFilename,
} from '@/lib/conversationMarkdown';
import { downloadTextFile } from '@/lib/tauri';
import type { Conversation, WorkMode } from '@/types';
import { useMemo, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

const MODE_LABELS: Record<WorkMode, { label: string; icon: typeof MessageSquare }> = {
  chat: { label: 'Chat', icon: MessageSquare },
  code: { label: 'Code', icon: Code2 },
};

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { conversationId } = useParams();

  const activeMode = useAppStore((s) => s.activeMode);
  const setActiveMode = useAppStore((s) => s.setActiveMode);
  const conversations = useAppStore((s) => s.conversations);
  const newConversation = useAppStore((s) => s.newConversation);
  // Admins get an extra entry above 设置. We read role here instead of
  // auth-presence because non-admin users shouldn't even see the link — the
  // route guard in App.tsx is the real gate, this just hides a dead entry.
  const isAdmin = useAppStore((s) => s.auth?.user.role === 'admin');

  const [query, setQuery] = useState('');
  // Debounce the query so typing doesn't rescan messages on every keystroke.
  // 120ms is imperceptible but skips most in-flight scans on a burst of typing.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 120);
    return () => clearTimeout(t);
  }, [query]);
  const isSearching = debouncedQuery.trim().length > 0;

  // Browse mode: active mode only, split by pinned/recent, hide empty drafts.
  const { pinned, recent } = useMemo(() => {
    if (isSearching) return { pinned: [], recent: [] };
    const list = conversations
      .filter((c) => c.mode === activeMode)
      // Hide empty conversations (user just clicked "新对话" but sent nothing).
      // Keep pinned / starred ones regardless — the user explicitly marked them.
      .filter((c) => c.messages.length > 0 || c.pinned || c.starred)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      pinned: list.filter((c) => c.pinned),
      recent: list.filter((c) => !c.pinned),
    };
  }, [conversations, activeMode, isSearching]);

  // Search mode: ALL modes, title + message content, ranked.
  const searchHits = useMemo(
    () => (isSearching ? searchConversations(conversations, debouncedQuery) : []),
    [conversations, debouncedQuery, isSearching]
  );

  const startNew = () => {
    const id = newConversation(activeMode);
    navigate(`/${activeMode}/${id}`);
  };

  const isRouteActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-claude-border dark:border-night-border">
        <div className="w-7 h-7 rounded-lg bg-claude-accent text-white flex items-center justify-center text-sm font-bold">
          F
        </div>
        <span className="font-semibold tracking-tight">Flaude</span>
        <span className="ml-auto text-xs text-claude-muted dark:text-night-muted">
          v0.1
        </span>
      </div>

      <nav className="px-2 pt-3 space-y-0.5">
        {(Object.keys(MODE_LABELS) as WorkMode[]).map((m) => {
          const Icon = MODE_LABELS[m].icon;
          const active = activeMode === m && isRouteActive(`/${m}`);
          return (
            <button
              key={m}
              onClick={() => {
                setActiveMode(m);
                navigate(`/${m}`);
              }}
              className={cn('side-item w-full', active && 'side-item-active')}
            >
              <Icon className="w-4 h-4" />
              <span>{MODE_LABELS[m].label}</span>
              <span className="ml-auto text-xs text-claude-muted dark:text-night-muted">
                {/* Match the list filter below — hide empty drafts so the
                    badge count equals the number of rows the user actually
                    sees when they click into the mode. Pinned / starred
                    drafts still count (they show up in the list). */}
                {conversations.filter(
                  (c) => c.mode === m && (c.messages.length > 0 || c.pinned || c.starred)
                ).length || ''}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="px-2 pt-3 space-y-0.5">
        <button
          onClick={() => navigate('/projects')}
          className={cn(
            'side-item w-full',
            isRouteActive('/projects') && 'side-item-active'
          )}
        >
          <FolderKanban className="w-4 h-4" />
          Projects
        </button>
      </div>

      <div className="mx-3 my-3 h-px bg-claude-border dark:bg-night-border" />

      <div className="px-3 space-y-2">
        <button onClick={startNew} className="btn-primary w-full justify-center">
          <Plus className="w-4 h-4" />
          新对话
        </button>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-claude-muted dark:text-night-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索对话（标题 + 内容）..."
            className="w-full pl-8 pr-7 py-1.5 text-sm rounded-lg bg-transparent border border-claude-border dark:border-night-border focus:outline-none focus:border-claude-accent"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-claude-muted hover:text-claude-ink dark:hover:text-night-ink"
              aria-label="清除搜索"
              title="清除搜索（Esc）"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
        {isSearching ? (
          // SEARCH MODE — flat cross-mode ranked result list
          searchHits.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-claude-muted dark:text-night-muted">
              <Search className="w-4 h-4 mx-auto mb-2 opacity-60" />
              未找到匹配的对话或消息
            </div>
          ) : (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-claude-muted dark:text-night-muted">
                搜索结果 · {searchHits.length}
              </div>
              {searchHits.map((hit) => (
                <SearchResultItem
                  key={`${hit.conversation.id}:${hit.messageId ?? 'title'}`}
                  hit={hit}
                  query={debouncedQuery}
                  active={conversationId === hit.conversation.id}
                />
              ))}
            </>
          )
        ) : pinned.length === 0 && recent.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-claude-muted dark:text-night-muted">
            <Sparkles className="w-4 h-4 mx-auto mb-2 opacity-60" />
            还没有对话，开始你的第一次对话吧
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-claude-muted dark:text-night-muted">
                  已置顶
                </div>
                {pinned.map((c) => (
                  <ConvItem key={c.id} conv={c} active={conversationId === c.id} />
                ))}
                <div className="my-1 h-px bg-claude-border/50 dark:bg-night-border/50" />
              </>
            )}
            {recent.map((c) => (
              <ConvItem key={c.id} conv={c} active={conversationId === c.id} />
            ))}
          </>
        )}
      </div>

      <div className="px-2 py-2 border-t border-claude-border dark:border-night-border space-y-0.5">
        {isAdmin && (
          <button
            onClick={() => navigate('/admin')}
            className={cn(
              'side-item w-full',
              isRouteActive('/admin') && 'side-item-active'
            )}
          >
            <Shield className="w-4 h-4" />
            管理员
          </button>
        )}
        <button
          onClick={() => navigate('/settings')}
          className={cn(
            'side-item w-full',
            isRouteActive('/settings') && 'side-item-active'
          )}
        >
          <Settings className="w-4 h-4" />
          设置
        </button>
      </div>
    </div>
  );
}

function ConvItem({ conv, active }: { conv: Conversation; active: boolean }) {
  const navigate = useNavigate();
  const renameConversation = useAppStore((s) => s.renameConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const pinConversation = useAppStore((s) => s.pinConversation);
  const starConversation = useAppStore((s) => s.starConversation);
  // Needed for the Markdown export: artifacts are inlined as fenced blocks
  // (so the .md file stands alone), and the project name appears in the
  // metadata header if the conversation is in a project.
  const artifacts = useAppStore((s) => s.artifacts);
  const projects = useAppStore((s) => s.projects);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conv.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const MENU_WIDTH = 160; // Tailwind w-40

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Align menu's right edge with the trigger's right edge, drop down 6px
    setMenuPos({ top: rect.bottom + 6, left: rect.right - MENU_WIDTH });
    setMenuOpen(true);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onScroll = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    // Capture-phase listener catches scrolls in any ancestor container
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const saveRename = () => {
    if (draft.trim()) renameConversation(conv.id, draft.trim());
    setEditing(false);
  };

  const exportMarkdown = async () => {
    const project = conv.projectId
      ? projects.find((p) => p.id === conv.projectId)
      : undefined;
    const md = buildConversationMarkdown(conv, {
      artifacts,
      projectName: project?.name,
    });
    // Close the menu first so the OS save dialog isn't competing with a
    // click-outside handler that might fire when focus shifts.
    setMenuOpen(false);
    try {
      await downloadTextFile(`${sanitizeFilename(conv.title)}.md`, md);
    } catch (e) {
      alert(`导出失败：${(e as Error).message}`);
    }
  };

  return (
    <div
      onClick={() => !editing && navigate(`/${conv.mode}/${conv.id}`)}
      onDoubleClick={() => {
        setDraft(conv.title);
        setEditing(true);
      }}
      className={cn('side-item group relative', active && 'side-item-active')}
    >
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-transparent border-b border-claude-accent text-sm focus:outline-none"
          />
        ) : (
          <>
            <div className="flex items-center gap-1 truncate">
              {conv.pinned && <Pin className="w-3 h-3 text-claude-accent shrink-0" />}
              {conv.starred && <Star className="w-3 h-3 text-amber-500 shrink-0" />}
              <span className="truncate">{conv.title}</span>
            </div>
            <div className="text-xs text-claude-muted dark:text-night-muted">
              {formatTime(conv.updatedAt)}
            </div>
          </>
        )}
      </div>

      {!editing && (
        <>
          <button
            ref={triggerRef}
            onClick={openMenu}
            className={cn(
              'p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition',
              // Keep the trigger visible while its menu is open, otherwise
              // reveal on hover.
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
            aria-label="更多操作"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {menuOpen && menuPos &&
            createPortal(
              <div
                ref={menuRef}
                // Fixed + portal so it escapes the sidebar's overflow-y-auto
                // clip and the relative-sibling stacking issue.
                style={{ top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
                className="fixed rounded-lg border border-claude-border dark:border-night-border
                           bg-claude-surface dark:bg-night-surface shadow-lg z-[1000] py-1 text-sm
                           text-claude-ink dark:text-night-ink"
                onClick={(e) => e.stopPropagation()}
              >
                <MenuItem
                  icon={<Pin className="w-3.5 h-3.5" />}
                  label={conv.pinned ? '取消置顶' : '置顶'}
                  onClick={() => {
                    pinConversation(conv.id, !conv.pinned);
                    setMenuOpen(false);
                  }}
                />
                <MenuItem
                  icon={<Star className="w-3.5 h-3.5" />}
                  label={conv.starred ? '取消收藏' : '收藏'}
                  onClick={() => {
                    starConversation(conv.id, !conv.starred);
                    setMenuOpen(false);
                  }}
                />
                <MenuItem
                  icon={<Edit3 className="w-3.5 h-3.5" />}
                  label="重命名"
                  onClick={() => {
                    setDraft(conv.title);
                    setEditing(true);
                    setMenuOpen(false);
                  }}
                />
                <MenuItem
                  icon={<Download className="w-3.5 h-3.5" />}
                  label="导出 Markdown"
                  onClick={exportMarkdown}
                />
                <div className="my-1 h-px bg-claude-border dark:bg-night-border" />
                <MenuItem
                  icon={<Trash2 className="w-3.5 h-3.5" />}
                  label="删除"
                  danger
                  onClick={() => {
                    if (confirm(`删除「${conv.title}」？`)) deleteConversation(conv.id);
                    setMenuOpen(false);
                  }}
                />
              </div>,
              document.body
            )}
        </>
      )}
    </div>
  );
}

/**
 * Compact search-result row. Shows mode chip, title, and (if a message
 * matched) a snippet with the query highlighted. Clicking navigates to the
 * conversation; if a message matched, we pass the message id via URL hash so
 * MessageList can scroll to it, and the query via router state so it can
 * flash only the matched text (not the whole message).
 */
function SearchResultItem({
  hit,
  query,
  active,
}: {
  hit: SearchHit;
  query: string;
  active: boolean;
}) {
  const navigate = useNavigate();
  const { conversation, messageId, messageRole, snippet, highlight } = hit;
  const Icon = MODE_LABELS[conversation.mode].icon;
  const hasMessage = !!messageId;

  const go = () => {
    const base = `/${conversation.mode}/${conversation.id}`;
    // Only send flashQuery when we have a specific message to flash —
    // title-only matches don't need DOM-level highlighting.
    navigate(
      messageId ? `${base}#msg-${messageId}` : base,
      messageId ? { state: { flashQuery: query } } : undefined
    );
  };

  return (
    <div
      onClick={go}
      className={cn('side-item group flex-col items-stretch gap-0.5', active && 'side-item-active')}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <Icon className="w-3 h-3 shrink-0 text-claude-muted dark:text-night-muted" />
        {conversation.pinned && <Pin className="w-3 h-3 text-claude-accent shrink-0" />}
        {conversation.starred && <Star className="w-3 h-3 text-amber-500 shrink-0" />}
        <span className="truncate text-sm flex-1 min-w-0">
          {hasMessage ? (
            conversation.title
          ) : (
            <HighlightedText text={snippet} highlight={highlight} />
          )}
        </span>
        <span className="text-[10px] text-claude-muted dark:text-night-muted shrink-0">
          {formatTime(conversation.updatedAt)}
        </span>
      </div>
      {hasMessage && (
        <div className="pl-[18px] text-xs text-claude-muted dark:text-night-muted line-clamp-2">
          <span className="mr-1 opacity-70">
            {messageRole === 'user' ? '你:' : 'F:'}
          </span>
          <HighlightedText text={snippet} highlight={highlight} />
        </div>
      )}
    </div>
  );
}

/**
 * Renders text with a single highlighted span. Pure presentational — no refs,
 * no effects. If the highlight range is out of bounds we fall back to plain
 * text (defensive; shouldn't happen in practice).
 */
function HighlightedText({
  text,
  highlight,
}: {
  text: string;
  highlight: { start: number; end: number };
}) {
  if (highlight.start < 0 || highlight.end > text.length || highlight.start >= highlight.end) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, highlight.start)}
      <mark className="bg-claude-accent/30 text-claude-ink dark:text-night-ink rounded-sm px-0.5">
        {text.slice(highlight.start, highlight.end)}
      </mark>
      {text.slice(highlight.end)}
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-black/5 dark:hover:bg-white/5 transition',
        danger && 'text-red-600 dark:text-red-400'
      )}
    >
      {icon}
      {label}
    </button>
  );
}
