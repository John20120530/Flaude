/**
 * Lazy file tree backed by the Tauri fs_list_dir command. Folders are read
 * on first expand, not up-front, so opening a huge project doesn't block.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fsListDir, type DirEntry } from '@/lib/tauri';

interface Props {
  workspace: string;
  onOpenFile?: (entry: DirEntry) => void;
  /** Show .git / .env / etc. Default false. */
  showHidden?: boolean;
}

export default function FileTree({
  workspace,
  onOpenFile,
  showHidden = false,
}: Props) {
  return (
    <div className="py-1 text-sm">
      <DirNode
        workspace={workspace}
        relPath="."
        label={deriveRootLabel(workspace)}
        depth={0}
        defaultOpen
        onOpenFile={onOpenFile}
        showHidden={showHidden}
      />
    </div>
  );
}

function deriveRootLabel(absPath: string): string {
  // Windows: "C:\foo\bar\baz" → "baz"; POSIX: "/foo/bar/baz" → "baz".
  const norm = absPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/');
  return parts[parts.length - 1] || absPath;
}

interface NodeProps {
  workspace: string;
  relPath: string;
  label: string;
  depth: number;
  defaultOpen?: boolean;
  onOpenFile?: (entry: DirEntry) => void;
  showHidden: boolean;
}

function DirNode({
  workspace,
  relPath,
  label,
  depth,
  defaultOpen,
  onOpenFile,
  showHidden,
}: NodeProps) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [loaded, setLoaded] = useState(false);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fsListDir(workspace, relPath, showHidden);
      setEntries(list);
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspace, relPath, showHidden]);

  // Auto-load when the node opens for the first time.
  useEffect(() => {
    if (open && !loaded && !loading) void load();
  }, [open, loaded, loading, load]);

  // If showHidden flips, invalidate the cache.
  useEffect(() => {
    if (loaded) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  return (
    <div>
      <div
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer select-none"
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <ChevronRight
          className={cn(
            'w-3 h-3 shrink-0 text-claude-muted dark:text-night-muted transition-transform',
            open && 'rotate-90'
          )}
        />
        {open ? (
          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-claude-accent" />
        ) : (
          <Folder className="w-3.5 h-3.5 shrink-0 text-claude-muted dark:text-night-muted" />
        )}
        <span className="truncate">{label}</span>
        {loading && (
          <Loader2 className="w-3 h-3 ml-auto text-claude-muted animate-spin" />
        )}
      </div>
      {open && (
        <>
          {error && (
            <div
              className="flex items-start gap-1 px-1.5 py-1 text-xs text-red-500"
              style={{ paddingLeft: 22 + depth * 12 }}
            >
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
          {entries.map((e) => {
            // Compose the child's relPath. Keep it POSIX-style for the Rust side,
            // which handles both separators.
            const childRel =
              relPath === '.'
                ? e.name
                : `${relPath.replace(/\\/g, '/')}/${e.name}`;
            return e.isDir ? (
              <DirNode
                key={e.path}
                workspace={workspace}
                relPath={childRel}
                label={e.name}
                depth={depth + 1}
                onOpenFile={onOpenFile}
                showHidden={showHidden}
              />
            ) : (
              <FileNode
                key={e.path}
                entry={e}
                depth={depth + 1}
                onOpen={() => onOpenFile?.(e)}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

function FileNode({
  entry,
  depth,
  onOpen,
}: {
  entry: DirEntry;
  depth: number;
  onOpen: () => void;
}) {
  return (
    <div
      onClick={onOpen}
      className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer select-none"
      style={{ paddingLeft: 22 + depth * 12 }}
    >
      <FileText className="w-3.5 h-3.5 shrink-0 text-claude-muted dark:text-night-muted" />
      <span className="truncate">{entry.name}</span>
    </div>
  );
}
