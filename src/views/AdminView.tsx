/**
 * Admin dashboard — user management for a friends-group Flaude server.
 *
 * Reachable at /admin when auth.user.role === 'admin'. App.tsx enforces
 * the route guard; we defensively show an empty state if that's ever bypassed.
 *
 * Design decisions:
 *   - One flat table, not a multi-step wizard. For 5-10 users we want every
 *     lever visible at a glance: role, disabled, quota, usage bar.
 *   - Inline editing via small modals (quota, password, new user). Avoids
 *     a separate /admin/users/:id detail page — premature at our scale.
 *   - "Create user" surfaces the plaintext password *once* after creation
 *     with a "copy" button, then never again. Admin is expected to paste
 *     it into Telegram/WeChat for the user out-of-band; we don't have an
 *     email stack.
 *   - Self-row has the destructive controls (disable, role change) hidden,
 *     matching the server's 400-guard. Belt + suspenders.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  UserPlus,
  Loader2,
  RefreshCw,
  Copy,
  Check,
  Key,
  UserCog,
  Ban,
  RotateCcw,
  X,
  Shield,
  User as UserIcon,
} from 'lucide-react';

import {
  adminCreateUser,
  adminListUsers,
  adminResetPassword,
  adminUpdateUser,
  FlaudeApiError,
  type AdminUser,
} from '@/lib/flaudeApi';
import { useAppStore } from '@/store/useAppStore';
import { cn } from '@/lib/utils';

export default function AdminView() {
  const selfId = useAppStore((s) => s.auth?.user.id);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [envDefaultQuota, setEnvDefaultQuota] = useState<number>(300_000);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modals — single-instance, keyed by { kind, user? }. Keeps state local;
  // we re-fetch the list after each mutation instead of patching in place
  // (simpler, and the table is small enough that a full refetch is free).
  const [modal, setModal] = useState<
    | { kind: 'create' }
    | { kind: 'quota'; user: AdminUser }
    | { kind: 'password'; user: AdminUser }
    | null
  >(null);

  // Toast-ish banner for post-mutation success flashes.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminListUsers();
      setUsers(res.users);
      setEnvDefaultQuota(res.env_default_quota);
    } catch (err) {
      setError(
        err instanceof FlaudeApiError ? err.message : (err as Error).message,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleDisabled = async (user: AdminUser) => {
    const targetState = !user.disabled;
    const verb = targetState ? '禁用' : '启用';
    if (!confirm(`确认${verb}「${user.display_name}」（${user.email}）？`)) return;
    try {
      await adminUpdateUser(user.id, { disabled: !!targetState });
      setFlash(`已${verb}「${user.display_name}」`);
      load();
    } catch (err) {
      alert(err instanceof FlaudeApiError ? err.message : (err as Error).message);
    }
  };

  const toggleRole = async (user: AdminUser) => {
    const targetRole: 'admin' | 'user' = user.role === 'admin' ? 'user' : 'admin';
    const verb = targetRole === 'admin' ? '提升为管理员' : '降为普通用户';
    if (!confirm(`确认将「${user.display_name}」${verb}？`)) return;
    try {
      await adminUpdateUser(user.id, { role: targetRole });
      setFlash(`已${verb}「${user.display_name}」`);
      load();
    } catch (err) {
      alert(err instanceof FlaudeApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Shield className="w-5 h-5" />
              管理员
            </h1>
            <p className="text-sm text-claude-muted dark:text-night-muted mt-1">
              创建/禁用用户、调整配额、重置密码。所有操作立即生效。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              disabled={loading}
              className="btn-ghost text-sm"
              title="刷新"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              刷新
            </button>
            <button
              onClick={() => setModal({ kind: 'create' })}
              className="btn-primary text-sm"
            >
              <UserPlus className="w-3.5 h-3.5" />
              新建用户
            </button>
          </div>
        </div>

        {flash && (
          <div className="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-md px-3 py-2">
            {flash}
          </div>
        )}

        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-claude-border dark:border-night-border">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-claude-muted dark:text-night-muted">
              <tr className="border-b border-claude-border dark:border-night-border">
                <th className="text-left font-medium px-3 py-2">用户</th>
                <th className="text-left font-medium px-3 py-2">角色</th>
                <th className="text-left font-medium px-3 py-2">状态</th>
                <th className="text-left font-medium px-3 py-2 min-w-[200px]">本月用量</th>
                <th className="text-right font-medium px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && !loading ? (
                <tr>
                  <td colSpan={5} className="text-center text-claude-muted dark:text-night-muted py-8">
                    还没有用户
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === selfId}
                    envDefaultQuota={envDefaultQuota}
                    onToggleDisabled={() => toggleDisabled(u)}
                    onToggleRole={() => toggleRole(u)}
                    onEditQuota={() => setModal({ kind: 'quota', user: u })}
                    onResetPassword={() => setModal({ kind: 'password', user: u })}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="text-xs text-claude-muted dark:text-night-muted">
          服务端默认月配额：{envDefaultQuota.toLocaleString()} tokens。单用户可在"编辑配额"里覆盖。
        </div>
      </div>

      {modal?.kind === 'create' && (
        <CreateUserModal
          onClose={() => setModal(null)}
          onCreated={(display_name) => {
            setFlash(`已创建「${display_name}」`);
            setModal(null);
            load();
          }}
          envDefaultQuota={envDefaultQuota}
        />
      )}
      {modal?.kind === 'quota' && (
        <QuotaModal
          user={modal.user}
          envDefaultQuota={envDefaultQuota}
          onClose={() => setModal(null)}
          onSaved={() => {
            setFlash(`已更新「${modal.user.display_name}」的配额`);
            setModal(null);
            load();
          }}
        />
      )}
      {modal?.kind === 'password' && (
        <PasswordModal
          user={modal.user}
          onClose={() => setModal(null)}
          onSaved={() => {
            setFlash(`已重置「${modal.user.display_name}」的密码`);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function UserRow({
  user,
  isSelf,
  envDefaultQuota,
  onToggleDisabled,
  onToggleRole,
  onEditQuota,
  onResetPassword,
}: {
  user: AdminUser;
  isSelf: boolean;
  envDefaultQuota: number;
  onToggleDisabled: () => void;
  onToggleRole: () => void;
  onEditQuota: () => void;
  onResetPassword: () => void;
}) {
  const effectiveQuota =
    user.monthly_quota_tokens ?? envDefaultQuota;
  const pct = effectiveQuota > 0
    ? Math.min(100, (user.used_tokens / effectiveQuota) * 100)
    : 0;
  const pctColor =
    pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-claude-accent';

  return (
    <tr
      className={cn(
        'border-b border-claude-border/50 dark:border-night-border/50 last:border-0',
        user.disabled && 'opacity-50',
      )}
    >
      <td className="px-3 py-3 align-top">
        <div className="flex items-center gap-2">
          <div className="font-medium truncate">{user.display_name}</div>
          {isSelf && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent">
              你
            </span>
          )}
        </div>
        <div className="text-xs text-claude-muted dark:text-night-muted font-mono truncate">
          {user.email}
        </div>
      </td>

      <td className="px-3 py-3 align-top">
        <div className="flex items-center gap-1.5">
          {user.role === 'admin' ? (
            <>
              <Shield className="w-3.5 h-3.5 text-claude-accent" />
              <span className="text-xs">管理员</span>
            </>
          ) : (
            <>
              <UserIcon className="w-3.5 h-3.5 text-claude-muted" />
              <span className="text-xs">用户</span>
            </>
          )}
        </div>
      </td>

      <td className="px-3 py-3 align-top">
        <span
          className={cn(
            'text-xs px-2 py-0.5 rounded-full',
            user.disabled
              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
              : 'bg-green-500/10 text-green-700 dark:text-green-400',
          )}
        >
          {user.disabled ? '已禁用' : '正常'}
        </span>
      </td>

      <td className="px-3 py-3 align-top min-w-[200px]">
        <div className="h-1.5 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
          <div
            className={cn('h-full transition-all', pctColor)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex items-baseline justify-between text-xs text-claude-muted dark:text-night-muted gap-2">
          <span>
            {formatTokens(user.used_tokens)} / {formatTokens(effectiveQuota)}
          </span>
          {user.monthly_quota_tokens === null && (
            <span className="text-[10px]">默认</span>
          )}
        </div>
      </td>

      <td className="px-3 py-3 align-top text-right">
        <div className="inline-flex items-center gap-1">
          <button
            onClick={onEditQuota}
            className="btn-ghost text-xs"
            title="编辑配额"
          >
            <UserCog className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onResetPassword}
            className="btn-ghost text-xs"
            title="重置密码"
          >
            <Key className="w-3.5 h-3.5" />
          </button>
          {/* Role / disable controls hidden for self-row to match server guard. */}
          {!isSelf && (
            <>
              <button
                onClick={onToggleRole}
                className="btn-ghost text-xs"
                title={user.role === 'admin' ? '降为普通用户' : '提升为管理员'}
              >
                <Shield className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onToggleDisabled}
                className={cn(
                  'btn-ghost text-xs',
                  user.disabled
                    ? 'text-green-600 hover:text-green-700'
                    : 'text-red-500 hover:text-red-600',
                )}
                title={user.disabled ? '启用账户' : '禁用账户'}
              >
                {user.disabled ? (
                  <RotateCcw className="w-3.5 h-3.5" />
                ) : (
                  <Ban className="w-3.5 h-3.5" />
                )}
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Create-user modal
// ---------------------------------------------------------------------------

function CreateUserModal({
  onClose,
  onCreated,
  envDefaultQuota,
}: {
  onClose: () => void;
  onCreated: (displayName: string) => void;
  envDefaultQuota: number;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [quotaOverride, setQuotaOverride] = useState(''); // empty = use default
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // After successful create, show the password one last time so admin can
  // copy it. We do NOT store this anywhere — it's derived from the form, so
  // refreshing the page loses it (which is fine — admin was supposed to
  // copy it).
  const [created, setCreated] = useState<{
    displayName: string;
    password: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const quotaInvalid =
    quotaOverride.trim() !== '' &&
    (!/^\d+$/.test(quotaOverride.trim()) || Number(quotaOverride) < 0);

  const canSubmit =
    email.trim().length > 0 &&
    password.length >= 8 &&
    !quotaInvalid &&
    !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const args: Parameters<typeof adminCreateUser>[0] = {
        email: email.trim(),
        password,
        role,
      };
      if (displayName.trim()) args.display_name = displayName.trim();
      if (quotaOverride.trim() !== '') {
        args.monthly_quota_tokens = Number(quotaOverride);
      }
      const res = await adminCreateUser(args);
      setCreated({ displayName: res.user.display_name, password });
    } catch (err) {
      setError(
        err instanceof FlaudeApiError ? err.message : (err as Error).message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const copyPassword = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — user can select-and-copy manually from the
      // visible field. Non-fatal.
    }
  };

  // Post-create success screen.
  if (created) {
    return (
      <ModalShell onClose={onClose} title="用户已创建">
        <div className="space-y-3 text-sm">
          <p>
            「<span className="font-medium">{created.displayName}</span>」已创建成功。把下面这串密码通过私聊发给用户——
            <span className="text-amber-600 dark:text-amber-400">
              关闭此窗口后不再可见
            </span>
            。
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm bg-black/5 dark:bg-white/5 rounded px-3 py-2 select-all break-all">
              {created.password}
            </code>
            <button
              onClick={copyPassword}
              className="btn-ghost text-sm"
              title="复制"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" /> 已复制
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" /> 复制
                </>
              )}
            </button>
          </div>
        </div>
        <div className="flex justify-end mt-5">
          <button
            onClick={() => onCreated(created.displayName)}
            className="btn-primary"
          >
            我已保存，关闭
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose} title="新建用户">
      <div className="space-y-3">
        <Field label="邮箱">
          <input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
            placeholder="user@example.com"
            className="modal-input"
          />
        </Field>

        <Field label="显示名（可选，不填用邮箱前缀）">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={submitting}
            placeholder="张三"
            className="modal-input"
          />
        </Field>

        <Field label="初始密码（至少 8 位）">
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            placeholder="手选或用密码生成器"
            className="modal-input font-mono"
          />
        </Field>

        <Field label="角色">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={role === 'user'}
                onChange={() => setRole('user')}
                disabled={submitting}
              />
              普通用户
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={role === 'admin'}
                onChange={() => setRole('admin')}
                disabled={submitting}
              />
              管理员
            </label>
          </div>
        </Field>

        <Field label={`月配额 tokens（留空 = 默认 ${envDefaultQuota.toLocaleString()}）`}>
          <input
            type="text"
            inputMode="numeric"
            value={quotaOverride}
            onChange={(e) => setQuotaOverride(e.target.value)}
            disabled={submitting}
            placeholder="留空使用默认"
            className={cn('modal-input', quotaInvalid && 'border-red-500')}
          />
        </Field>

        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded px-2 py-1.5">
            {error}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} className="btn-ghost" disabled={submitting}>
          取消
        </button>
        <button onClick={submit} disabled={!canSubmit} className="btn-primary">
          {submitting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <UserPlus className="w-3.5 h-3.5" />
          )}
          创建
        </button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Quota modal
// ---------------------------------------------------------------------------

function QuotaModal({
  user,
  envDefaultQuota,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  envDefaultQuota: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(
    user.monthly_quota_tokens === null ? '' : String(user.monthly_quota_tokens),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const useDefault = trimmed === '';
  const n = useDefault ? null : Number(trimmed);
  const invalid = !useDefault && (!/^\d+$/.test(trimmed) || Number(n) < 0);

  const submit = async () => {
    if (invalid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminUpdateUser(user.id, { monthly_quota_tokens: n });
      onSaved();
    } catch (err) {
      setError(
        err instanceof FlaudeApiError ? err.message : (err as Error).message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell onClose={onClose} title={`调整「${user.display_name}」的月配额`}>
      <div className="space-y-3">
        <p className="text-sm text-claude-muted dark:text-night-muted">
          留空恢复服务端默认（{envDefaultQuota.toLocaleString()} tokens）。
          设为 0 等于封顶本月 LLM 调用。每月 1 号 UTC 自动重置。
        </p>
        <Field label="tokens">
          <input
            type="text"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={submitting}
            placeholder={`留空 = ${envDefaultQuota.toLocaleString()}`}
            className={cn('modal-input', invalid && 'border-red-500')}
            autoFocus
          />
        </Field>
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded px-2 py-1.5">
            {error}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} className="btn-ghost" disabled={submitting}>
          取消
        </button>
        <button onClick={submit} disabled={invalid || submitting} className="btn-primary">
          {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          保存
        </button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Password reset modal
// ---------------------------------------------------------------------------

function PasswordModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState(false);

  const canSubmit = password.length >= 8 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await adminResetPassword(user.id, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof FlaudeApiError ? err.message : (err as Error).message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // non-fatal
    }
  };

  if (done) {
    return (
      <ModalShell onClose={onSaved} title="密码已重置">
        <div className="space-y-3 text-sm">
          <p>
            「<span className="font-medium">{user.display_name}</span>」的密码已更新。把新密码通过私聊发给用户——
            <span className="text-amber-600 dark:text-amber-400">
              关闭此窗口后不再可见
            </span>
            。
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm bg-black/5 dark:bg-white/5 rounded px-3 py-2 select-all break-all">
              {password}
            </code>
            <button onClick={copyPassword} className="btn-ghost text-sm" title="复制">
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" /> 已复制
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" /> 复制
                </>
              )}
            </button>
          </div>
        </div>
        <div className="flex justify-end mt-5">
          <button onClick={onSaved} className="btn-primary">
            我已保存，关闭
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose} title={`重置「${user.display_name}」的密码`}>
      <div className="space-y-3">
        <p className="text-sm text-claude-muted dark:text-night-muted">
          输入新密码（至少 8 位）。用户现有 JWT 不会立刻失效——如果要强制所有人重登，换 JWT_SECRET 即可。
        </p>
        <Field label="新密码">
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            placeholder="至少 8 位"
            className="modal-input font-mono"
            autoFocus
          />
        </Field>
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded px-2 py-1.5">
            {error}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} className="btn-ghost" disabled={submitting}>
          取消
        </button>
        <button onClick={submit} disabled={!canSubmit} className="btn-primary">
          {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          重置
        </button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white dark:bg-night-bg border border-claude-border dark:border-night-border shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="btn-ghost p-1" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <div className="text-xs text-claude-muted dark:text-night-muted mb-1">
        {label}
      </div>
      {children}
    </label>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
