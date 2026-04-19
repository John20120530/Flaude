/**
 * Login screen.
 *
 * Full-viewport, shown by App.tsx when `auth === null`. On successful login
 * we stash the token + user in the store; App.tsx observes and swaps to the
 * main AppShell on next render.
 *
 * No "Register" flow here — user creation goes through the admin in Phase 5.
 * Showing a self-signup link would be misleading for a friends-group server.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn, Loader2 } from 'lucide-react';

import { FlaudeApiError, getServerUrl, login } from '@/lib/flaudeApi';
import { useAppStore } from '@/store/useAppStore';

export default function LoginView() {
  const setAuth = useAppStore((s) => s.setAuth);
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  const onSubmit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await login(email.trim(), password);
      setAuth({ token: res.token, user: res.user });
      // Replace (not push) the current history entry so that:
      //   1. "Back" from /chat after login doesn't bounce the user into a
      //      logged-out snapshot of whatever URL they were on before.
      //   2. If the pre-logout URL was /settings, we still land on /chat
      //      instead of resurrecting that deeper page — feels less confusing
      //      right after a fresh login.
      navigate('/chat', { replace: true });
    } catch (err) {
      // Map FlaudeApiError to human copy. 401 is by far the common case
      // (bad credentials); everything else gets the generic message plus
      // the server-provided detail if we have it.
      if (err instanceof FlaudeApiError) {
        if (err.status === 401) {
          setError('邮箱或密码不对');
        } else if (err.status === 403) {
          setError('账户已被禁用，联系管理员');
        } else if (err.status === 0 || err.status >= 500) {
          setError(`服务器连不上（${err.message}）。检查服务端是否启动。`);
        } else {
          setError(err.message);
        }
      } else {
        // Network error — fetch() threw before we got a Response. Usually
        // "server not running" or DNS failure on a misconfigured URL.
        setError(
          `连接失败：${(err as Error).message}。当前服务端地址 ${getServerUrl()}`,
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-claude-surface dark:bg-night-surface px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-3xl font-semibold tracking-tight">Flaude</div>
          <div className="text-sm text-claude-muted dark:text-night-muted mt-1">
            登录你的账户继续
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="p-6 rounded-2xl border border-claude-border dark:border-night-border bg-white dark:bg-night-bg space-y-4"
        >
          <div>
            <label className="block text-sm font-medium mb-1">邮箱</label>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-transparent border border-claude-border dark:border-night-border focus:outline-none focus:border-claude-accent"
              placeholder="you@example.com"
              disabled={submitting}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">密码</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-transparent border border-claude-border dark:border-night-border focus:outline-none focus:border-claude-accent"
              placeholder="••••••••"
              disabled={submitting}
              required
            />
          </div>

          {error && (
            <div
              role="alert"
              className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-md px-3 py-2"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full btn-primary justify-center py-2"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <LogIn className="w-4 h-4" />
            )}
            登录
          </button>

          <div className="text-xs text-claude-muted dark:text-night-muted text-center">
            没账号？联系管理员开通。
          </div>
        </form>

        <div className="mt-6 text-center text-xs text-claude-muted dark:text-night-muted">
          服务端：<code className="font-mono">{getServerUrl()}</code>
        </div>
      </div>
    </div>
  );
}
