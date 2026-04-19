import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAppStore } from '@/store/useAppStore';
import AppShell from '@/components/shell/AppShell';
import ChatView from '@/views/ChatView';
import CodeView from '@/views/CodeView';
import SettingsView from '@/views/SettingsView';
import ProjectsView from '@/views/ProjectsView';
import LoginView from '@/views/LoginView';
import AdminView from '@/views/AdminView';
import { startSync } from '@/lib/sync';

export default function App() {
  const theme = useAppStore((s) => s.theme);
  const auth = useAppStore((s) => s.auth);

  // Apply theme class to <html> for Tailwind `dark:` variants.
  // NB: runs before the auth gate so the login screen itself respects theme.
  useEffect(() => {
    const root = document.documentElement;
    const apply = (mode: 'light' | 'dark') => {
      root.classList.toggle('dark', mode === 'dark');
    };
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches ? 'dark' : 'light');
      const listener = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', listener);
      return () => mq.removeEventListener('change', listener);
    }
    apply(theme);
  }, [theme]);

  // On the transition from unauthenticated → authenticated (fresh login OR
  // restart with a persisted token), kick off Phase 3 sync. The effect depends
  // on `auth?.user.id` rather than `auth` itself so that a token refresh doesn't
  // re-pull everything; we only want to sync once per logged-in user per mount.
  //
  // Any errors inside startSync are swallowed by the sync manager — it sets
  // syncState = 'error' and surfaces that via the store. We deliberately don't
  // await here (the login screen has already left the DOM by the time this
  // effect runs, so there's nothing to gate on the pull completing).
  useEffect(() => {
    if (!auth) return;
    void startSync();
  }, [auth?.user.id]);

  // Auth gate: when no token, show LoginView full-screen instead of the shell.
  // authFetch() calls clearAuth() on 401/403, which flips this back to null
  // and drops the user back here on the next render. No router redirect needed.
  if (!auth) {
    return <LoginView />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatView />} />
        <Route path="/chat/:conversationId" element={<ChatView />} />
        {/* Legacy /cowork URLs (from pre-deletion persisted nav history) → send to /chat. */}
        <Route path="/cowork" element={<Navigate to="/chat" replace />} />
        <Route path="/cowork/:conversationId" element={<Navigate to="/chat" replace />} />
        <Route path="/code" element={<CodeView />} />
        <Route path="/code/:conversationId" element={<CodeView />} />
        <Route path="/projects" element={<ProjectsView />} />
        <Route path="/projects/:projectId" element={<ProjectsView />} />
        <Route path="/settings" element={<SettingsView />} />
        {/* Admin dashboard. Role guard here (not inside AdminView) so a
            non-admin who deep-links or types the URL bounces to /chat without
            the view mounting and firing its admin-only fetches (which would
            just 403 anyway, but no reason to make the round-trip). */}
        <Route
          path="/admin"
          element={
            auth.user.role === 'admin' ? <AdminView /> : <Navigate to="/chat" replace />
          }
        />
      </Route>
    </Routes>
  );
}
