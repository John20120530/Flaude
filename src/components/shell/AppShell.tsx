import { Outlet } from 'react-router-dom';
import { useAppStore } from '@/store/useAppStore';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import ArtifactsPanel from './ArtifactsPanel';
import ConflictToasts from './ConflictToasts';
import { cn } from '@/lib/utils';

export default function AppShell() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const artifactsOpen = useAppStore((s) => s.artifactsOpen);
  const artifactsPanelWidth = useAppStore((s) => s.artifactsPanelWidth);
  const setArtifactsPanelWidth = useAppStore((s) => s.setArtifactsPanelWidth);

  // Inline all drag state into the closure so the listener doesn't need to
  // reference itself (which confuses React Compiler's "access before
  // declared" check) and unmount cleanup falls out naturally — the listeners
  // are always detached by the same click-sequence that attached them.
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = artifactsPanelWidth;

    const onMove = (ev: MouseEvent) => {
      // Panel is on the RIGHT → moving mouse left grows it, right shrinks it.
      // Store action clamps to [320, 1200], so no extra guard needed here.
      setArtifactsPanelWidth(startWidth + (startX - ev.clientX));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Restore cursor / text selection behaviour we disabled during drag.
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // Without these the drag feels janky: cursor flickers to "text" over the
    // message list, and text selection lights up under the pointer.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className="h-full w-full flex overflow-hidden">
      <aside
        className={cn(
          'shrink-0 border-r border-claude-border dark:border-night-border',
          'bg-claude-surface dark:bg-night-surface',
          'transition-[width] duration-200 ease-out overflow-hidden',
          sidebarOpen ? 'w-[260px]' : 'w-0'
        )}
      >
        <Sidebar />
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <div className="flex-1 flex min-h-0">
          <div className="flex-1 min-w-0 flex flex-col">
            <Outlet />
          </div>
          {artifactsOpen && (
            <>
              {/*
                Thin vertical gutter that the user can grab to resize the
                panel. We paint a wider hit area (`w-1.5`) than the visible
                hairline (`bg-*`) so small mice don't fight to catch it.
              */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="调整工件面板宽度"
                onMouseDown={onDragStart}
                className="w-1.5 shrink-0 cursor-col-resize bg-claude-border dark:bg-night-border hover:bg-claude-accent/60 transition-colors"
              />
              <div
                className="shrink-0 border-l border-claude-border dark:border-night-border bg-claude-surface dark:bg-night-surface"
                style={{ width: `${artifactsPanelWidth}px` }}
              >
                <ArtifactsPanel />
              </div>
            </>
          )}
        </div>
      </main>
      {/*
        Sync conflict toasts. Positioned `fixed` internally, so its place
        in the JSX tree is cosmetic — last sibling puts it above siblings
        in the z-stack by default (plus we set z-50). Mounted at shell
        level so it's visible across all routes.
      */}
      <ConflictToasts />
    </div>
  );
}
