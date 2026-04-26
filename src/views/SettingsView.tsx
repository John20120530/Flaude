import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Save,
  Plus,
  Trash2,
  Link as LinkIcon,
  Unlink,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Wrench,
  Server,
  Slash,
  Pencil,
  FolderOpen,
  Monitor,
  Brain,
  Sparkles,
  User,
  LogOut,
  Gauge,
  RefreshCw,
  Download,
  Database,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { cn } from '@/lib/utils';
import type { SlashCommand, MCPServer, Skill, WorkMode } from '@/types';
import {
  parseEntries,
  serializeEntries,
  type GlobalMemoryEntry,
} from '@/lib/globalMemory';
import { uid } from '@/lib/utils';
import { useRegisteredTools } from '@/lib/useTools';
import type { ToolDefinition } from '@/lib/tools';
import { isTauri, pickFolder } from '@/lib/tauri';
import {
  fetchUsage,
  FlaudeApiError,
  getServerUrl,
  logout as apiLogout,
  type UsageSnapshot,
} from '@/lib/flaudeApi';
import {
  countBundleContents,
  exportAccountBundle,
} from '@/lib/accountExport';

export default function SettingsView() {
  const providers = useAppStore((s) => s.providers);
  const modelByMode = useAppStore((s) => s.modelByMode);
  const setModelForMode = useAppStore((s) => s.setModelForMode);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-10">
        <div>
          <h1 className="text-2xl font-semibold">设置</h1>
          <p className="text-sm text-claude-muted dark:text-night-muted mt-1">
            账户、默认模型、工具和斜杠命令。模型 API Key 由服务端集中保管。
          </p>
        </div>

        <AccountSection />

        {/* Mode defaults */}
        <section>
          <h2 className="text-lg font-semibold mb-3">默认模型</h2>
          <p className="text-xs text-claude-muted dark:text-night-muted mb-3">
            不同模式的默认模型。模型列表由服务端提供——本机选不到的型号说明服务端没开。
          </p>
          <div className="space-y-2">
            {(['chat', 'code'] as const).map((mode) => (
              <div
                key={mode}
                className="flex items-center gap-3 p-3 rounded-lg border border-claude-border dark:border-night-border"
              >
                <div className="w-20 text-sm capitalize">{mode}</div>
                <select
                  value={modelByMode[mode]}
                  onChange={(e) => setModelForMode(mode, e.target.value)}
                  className="flex-1 bg-transparent border border-claude-border dark:border-night-border rounded-md px-2 py-1.5 text-sm"
                >
                  {providers
                    .filter((p) => p.enabled)
                    .map((p) => (
                      <optgroup key={p.id} label={p.displayName}>
                        {p.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                </select>
              </div>
            ))}
          </div>
        </section>

        <DesktopSection />
        <MemorySection />
        <DataSection />
        <SkillsSection />
        <MCPSection />
        <SlashSection />
        <ToolsSection />

        <section>
          <h2 className="text-lg font-semibold mb-3">关于</h2>
          <div className="text-sm text-claude-muted dark:text-night-muted space-y-1">
            <div>Flaude v0.1 — 基于中国开源模型的 Claude-like 客户端</div>
            <div>
              此应用通过标准 OpenAI 兼容 API 接入各模型厂商，所有对话与密钥仅保存在本机。
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account — current user, usage/quota, logout
// ---------------------------------------------------------------------------

function AccountSection() {
  const auth = useAppStore((s) => s.auth);
  const clearAuth = useAppStore((s) => s.clearAuth);

  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);

  const loadUsage = async () => {
    setLoadingUsage(true);
    setUsageError(null);
    try {
      const snap = await fetchUsage();
      setUsage(snap);
    } catch (err) {
      // 401/403 have already cleared auth via authFetch — the next render
      // will flip us to LoginView, so a transient error message is fine.
      setUsageError(
        err instanceof FlaudeApiError ? err.message : (err as Error).message,
      );
    } finally {
      setLoadingUsage(false);
    }
  };

  useEffect(() => {
    if (auth) loadUsage();
    // Re-fetch only when the user identity changes; within a session we offer
    // a manual refresh button so the numbers don't quietly drift.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.user.id]);

  const onLogout = async () => {
    if (!auth) return;
    if (!confirm('确定退出登录？本地会话数据会被清空。')) return;
    // Fire-and-forget the server call; local clear is the source of truth.
    // If the network is down we still drop back to LoginView cleanly.
    void apiLogout(auth.token);
    clearAuth();
  };

  if (!auth) {
    // Shouldn't happen — App.tsx gates this view on auth — but render a
    // defensible placeholder instead of throwing if it ever does.
    return null;
  }

  const user = auth.user;
  const pct =
    usage && usage.quota_tokens > 0
      ? Math.min(100, (usage.used_tokens / usage.quota_tokens) * 100)
      : 0;
  const pctColor =
    pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-claude-accent';

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
        <User className="w-4 h-4" /> 账户
      </h2>

      <div className="p-4 rounded-xl border border-claude-border dark:border-night-border space-y-4">
        {/* Identity */}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="font-medium truncate">{user.display_name}</div>
              <span
                className={cn(
                  'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded',
                  user.role === 'admin'
                    ? 'bg-claude-accent/10 text-claude-accent'
                    : 'bg-black/5 dark:bg-white/5 text-claude-muted dark:text-night-muted',
                )}
              >
                {user.role === 'admin' ? '管理员' : '用户'}
              </span>
            </div>
            <div className="text-xs text-claude-muted dark:text-night-muted font-mono truncate">
              {user.email}
            </div>
          </div>
          <button
            onClick={onLogout}
            className="btn-ghost text-xs text-red-500 hover:text-red-600"
            title="退出登录"
          >
            <LogOut className="w-3.5 h-3.5" />
            退出
          </button>
        </div>

        {/* Usage bar */}
        <div className="border-t border-claude-border dark:border-night-border pt-3">
          <div className="flex items-center gap-2 mb-2">
            <Gauge className="w-3.5 h-3.5 text-claude-muted dark:text-night-muted" />
            <div className="text-sm font-medium">本月用量</div>
            <button
              onClick={loadUsage}
              disabled={loadingUsage}
              className="ml-auto text-xs text-claude-muted hover:text-claude-accent inline-flex items-center gap-1"
              title="刷新"
            >
              <RefreshCw
                className={cn('w-3 h-3', loadingUsage && 'animate-spin')}
              />
              刷新
            </button>
          </div>

          {usageError ? (
            <div className="text-xs text-red-500">{usageError}</div>
          ) : usage ? (
            <>
              <div className="h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
                <div
                  className={cn('h-full transition-all', pctColor)}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-baseline justify-between text-xs text-claude-muted dark:text-night-muted">
                <span>
                  {formatTokens(usage.used_tokens)}
                  {' / '}
                  {formatTokens(usage.quota_tokens)} tokens
                </span>
                <span>
                  重置于 {formatDate(usage.period_end)}
                </span>
              </div>
            </>
          ) : loadingUsage ? (
            <div className="text-xs text-claude-muted dark:text-night-muted inline-flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> 加载中…
            </div>
          ) : (
            <div className="text-xs text-claude-muted dark:text-night-muted">
              —
            </div>
          )}
        </div>

        <div className="text-xs text-claude-muted dark:text-night-muted border-t border-claude-border dark:border-night-border pt-3">
          服务端：<code className="font-mono">{getServerUrl()}</code>
        </div>
      </div>
    </section>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDate(unixSec: number): string {
  try {
    return new Date(unixSec * 1000).toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '-';
  }
}

// ---------------------------------------------------------------------------
// Desktop (Tauri-only)
// ---------------------------------------------------------------------------

function DesktopSection() {
  const workspacePath = useAppStore((s) => s.workspacePath);
  const setWorkspacePath = useAppStore((s) => s.setWorkspacePath);
  const allowFileWrites = useAppStore((s) => s.allowFileWrites);
  const setAllowFileWrites = useAppStore((s) => s.setAllowFileWrites);
  const allowShellExec = useAppStore((s) => s.allowShellExec);
  const setAllowShellExec = useAppStore((s) => s.setAllowShellExec);

  const desktop = isTauri();

  const pick = async () => {
    try {
      const p = await pickFolder('选择工作区');
      if (p) setWorkspacePath(p);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
        <Monitor className="w-4 h-4" /> 桌面
      </h2>
      <p className="text-xs text-claude-muted dark:text-night-muted mb-3">
        桌面版（Tauri）启用本地文件系统与 Shell 工具。写入和 Shell 默认关闭，
        由你明确授权。浏览器模式下这一段不可用。
      </p>

      {!desktop && (
        <div className="mb-3 p-3 rounded-xl border border-dashed border-claude-border dark:border-night-border text-xs text-claude-muted dark:text-night-muted">
          当前运行在浏览器里。要启用本地 FS / Shell，请安装 Rust 后运行{' '}
          <code className="font-mono">pnpm tauri dev</code>。
        </div>
      )}

      <div className="p-3 rounded-xl border border-claude-border dark:border-night-border space-y-3">
        <div>
          <div className="text-xs text-claude-muted dark:text-night-muted mb-1">
            当前工作区
          </div>
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex-1 px-3 py-1.5 rounded-md border text-xs font-mono truncate',
                workspacePath
                  ? 'border-claude-border dark:border-night-border'
                  : 'border-dashed border-claude-border/50 dark:border-night-border/50 text-claude-muted/70'
              )}
              title={workspacePath ?? undefined}
            >
              {workspacePath ?? '（未设置）'}
            </div>
            <button
              onClick={pick}
              disabled={!desktop}
              className="btn-ghost text-xs disabled:opacity-50"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              选择
            </button>
            {workspacePath && (
              <button
                onClick={() => setWorkspacePath(null)}
                className="btn-ghost text-xs text-red-500 hover:text-red-600"
                title="清除工作区"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <label
          className={cn(
            'flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer',
            allowFileWrites
              ? 'border-claude-accent/50 bg-claude-accent/5'
              : 'border-claude-border dark:border-night-border',
            !desktop && 'opacity-50 pointer-events-none'
          )}
        >
          <input
            type="checkbox"
            checked={allowFileWrites}
            onChange={(e) => setAllowFileWrites(e.target.checked)}
            disabled={!desktop}
            className="mt-0.5"
          />
          <div className="text-sm">
            <div className="font-medium">允许写入文件</div>
            <div className="text-xs text-claude-muted dark:text-night-muted mt-0.5">
              Agent 可通过 <code className="font-mono">fs_write_file</code>{' '}
              直接修改工作区内的文件。关闭时工具调用会被拒绝。
            </div>
          </div>
        </label>

        <label
          className={cn(
            'flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer',
            allowShellExec
              ? 'border-claude-accent/50 bg-claude-accent/5'
              : 'border-claude-border dark:border-night-border',
            !desktop && 'opacity-50 pointer-events-none'
          )}
        >
          <input
            type="checkbox"
            checked={allowShellExec}
            onChange={(e) => setAllowShellExec(e.target.checked)}
            disabled={!desktop}
            className="mt-0.5"
          />
          <div className="text-sm">
            <div className="font-medium">允许执行 Shell 命令</div>
            <div className="text-xs text-claude-muted dark:text-night-muted mt-0.5">
              Agent 可通过 <code className="font-mono">shell_exec</code> 在工作区里运行命令
              （git / npm / python 等）。默认 30 秒超时，cwd 被限制在工作区内。
            </div>
          </div>
        </label>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Data management — full-account export (backup).
//
// One button that downloads a JSON bundle of everything the user cares
// about: conversations, projects, artifacts, skills, slash commands, MCP
// setup, global memory, and UI preferences. Format matches /sync/pull so a
// future import path can round-trip without a second schema.
//
// We don't block on success — the download either kicks off (browser /
// Tauri save dialog) or throws, and we surface the latter inline. No
// long-running state because even thousands of conversations serialize
// in well under a second.
// ---------------------------------------------------------------------------

function DataSection() {
  const [busy, setBusy] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Reading the store on every render is cheap — Zustand hooks short-circuit
  // when the selected slice didn't change. We select the specific counters
  // rather than calling countBundleContents() because that would force a
  // re-render on any unrelated store write.
  const conversations = useAppStore((s) => s.conversations);
  const projects = useAppStore((s) => s.projects);
  const artifacts = useAppStore((s) => s.artifacts);
  const skills = useAppStore((s) => s.skills);
  const counts = useMemo(() => countBundleContents(), [
    conversations,
    projects,
    artifacts,
    skills,
  ]);

  const onExport = async () => {
    setBusy(true);
    setErr(null);
    try {
      const saved = await exportAccountBundle({
        flaudeVersion: '0.1.0',
      });
      // Tauri: `saved` is the path the user picked; browser: the filename;
      // null means the user cancelled the native save dialog.
      if (saved !== null) {
        setLastSavedAt(Date.now());
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <Database className="w-4 h-4" />
        数据管理
      </h2>
      <p className="text-xs text-claude-muted dark:text-night-muted mb-3">
        一键备份你的全部数据（会话、项目、工件、技能、设置）。文件格式与服务端同步的 payload 对齐，
        方便未来导入恢复。不含登录态、工作区路径和桌面权限开关——这些是按设备单独配置的。
      </p>

      <div className="p-3 rounded-xl border border-claude-border dark:border-night-border space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <Stat label="会话" value={counts.conversations} />
          <Stat label="消息" value={counts.messages} />
          <Stat label="项目" value={counts.projects} />
          <Stat label="工件" value={counts.artifacts} />
          <Stat label="技能" value={counts.skills} />
          <Stat label="斜杠命令" value={counts.slashCommands} />
          <Stat label="MCP 服务器" value={counts.mcpServers} />
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onExport}
            disabled={busy}
            className="btn-primary flex items-center gap-2 text-sm disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            导出全部数据
          </button>
          {lastSavedAt !== null && !busy && !err && (
            <span className="text-xs text-green-700 dark:text-green-400 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              已保存
            </span>
          )}
          {err && (
            <span className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              {err}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="p-2 rounded-md bg-black/[0.03] dark:bg-white/[0.03]">
      <div className="text-claude-muted dark:text-night-muted">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Global Memory (CLAUDE.md-style persistent facts) — entry-based UI
// ---------------------------------------------------------------------------
//
// `globalMemory` is stored as a single string for sync/export simplicity, but
// presented here as a list of toggle-able entries. Each entry maps to one
// non-blank line in the underlying string; disabled entries get a
// <!--disabled--> marker prefix so they survive a reload but are stripped
// from the model's system prompt by `effectiveGlobalMemory`.
//
// Edit model: changes commit to the store immediately on blur or Enter.
// No separate "Save" button — the explicit save flow on the old textarea
// turned out to confuse users into typing notes and then closing the page,
// losing them. The list-with-toggle UI makes "what is the model going to
// see right now" legible at a glance, which is the actual point of this
// rewrite (the toggle-on/off question was the killer feature missing).
// ---------------------------------------------------------------------------

function MemorySection() {
  const globalMemory = useAppStore((s) => s.globalMemory);
  const setGlobalMemory = useAppStore((s) => s.setGlobalMemory);

  // Parsed view of the store string. Re-derived whenever the store changes
  // (e.g. `/remember` appends a line). When the user is mid-edit on a row,
  // the local edit state lives on the row itself, so re-parsing here doesn't
  // clobber in-flight typing.
  const entries = useMemo<GlobalMemoryEntry[]>(
    () => parseEntries(globalMemory),
    [globalMemory],
  );

  // Buffer for "+ 添加一条" — pending entry that hasn't been committed yet.
  // We don't put empty rows directly in the persisted string because
  // serializeEntries drops them, which would cause an instant disappear-on-
  // commit-of-something-else. Instead, the new-row sits in component state
  // until the user types something and blurs/Enters.
  const [adding, setAdding] = useState<{ id: string; text: string } | null>(null);

  // Scroll into view when the user arrived via `/memory` (hash anchor).
  const location = useLocation();
  useEffect(() => {
    if (location.hash === '#memory') {
      document.getElementById('memory-section')?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [location.hash]);

  // Commit a freshly-edited list back to the store. We rebuild from the
  // current `entries` array and selectively replace one item; never trust
  // a stale reference from a callback closure.
  const commitEntries = (next: GlobalMemoryEntry[]) => {
    setGlobalMemory(serializeEntries(next));
  };

  const updateEntryText = (id: string, text: string) => {
    if (!text.trim()) {
      // Empty after edit = delete. Less surprising than persisting blanks.
      commitEntries(entries.filter((e) => e.id !== id));
      return;
    }
    commitEntries(entries.map((e) => (e.id === id ? { ...e, text } : e)));
  };

  const toggleEntry = (id: string) => {
    commitEntries(
      entries.map((e) => (e.id === id ? { ...e, disabled: !e.disabled } : e)),
    );
  };

  const deleteEntry = (id: string) => {
    commitEntries(entries.filter((e) => e.id !== id));
  };

  const startAdding = () => {
    setAdding({ id: uid('mem-new'), text: '' });
  };

  const commitAdding = () => {
    const a = adding;
    setAdding(null);
    if (!a || !a.text.trim()) return;
    commitEntries([
      ...entries,
      { id: uid('mem'), text: a.text.trim(), disabled: false },
    ]);
  };

  const enabledCount = entries.filter((e) => !e.disabled).length;
  const totalChars = entries
    .filter((e) => !e.disabled)
    .reduce((sum, e) => sum + e.text.length + 1, 0); // +1 per line for the join \n

  return (
    <section id="memory-section">
      <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <Brain className="w-4 h-4" />
        全局记忆
      </h2>
      <p className="text-sm text-claude-muted dark:text-night-muted mb-3">
        持久事实，注入到所有对话的 system prompt 前部。一条一行——可以单独开关、修改、删除。
        也可以用 <code className="text-xs bg-black/5 dark:bg-white/10 px-1 rounded">/remember &lt;fact&gt;</code> 从对话里追加。
      </p>

      <div className="rounded-lg border border-claude-border dark:border-night-border bg-white dark:bg-night-bg divide-y divide-claude-border/60 dark:divide-night-border/60">
        {entries.length === 0 && !adding && (
          <div className="px-3 py-6 text-center text-sm text-claude-muted dark:text-night-muted">
            还没有任何记忆。点下面「添加一条」开始——例如：「我用 pnpm，不用 npm」。
          </div>
        )}

        {entries.map((entry) => (
          <MemoryRow
            key={entry.id}
            entry={entry}
            onToggle={() => toggleEntry(entry.id)}
            onCommitText={(text) => updateEntryText(entry.id, text)}
            onDelete={() => deleteEntry(entry.id)}
          />
        ))}

        {adding && (
          <div className="flex items-start gap-2 px-3 py-2">
            <Plus className="w-4 h-4 mt-1.5 text-claude-muted dark:text-night-muted shrink-0" />
            <input
              autoFocus
              type="text"
              value={adding.text}
              onChange={(e) =>
                setAdding({ id: adding.id, text: e.target.value })
              }
              onBlur={commitAdding}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitAdding();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setAdding(null);
                }
              }}
              placeholder="写一条事实，回车或失焦时保存（Esc 取消）"
              className="flex-1 bg-transparent text-sm focus:outline-none px-1 py-1"
            />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-2 text-xs text-claude-muted dark:text-night-muted">
        <span>
          {entries.length} 条（{enabledCount} 启用）· 约 {Math.ceil(totalChars / 4)} tokens 注入
          {totalChars > 20_000 && (
            <span className="ml-2 text-amber-600">（过长会挤占每轮 token 预算，考虑精简）</span>
          )}
        </span>
        <button
          onClick={startAdding}
          disabled={!!adding}
          className="btn-ghost text-xs"
        >
          <Plus className="w-3.5 h-3.5" />
          添加一条
        </button>
      </div>
    </section>
  );
}

/**
 * One row in the memory list. Inline-editable text + toggle + delete.
 * The text input commits on blur or Enter (consistent with the new-row
 * behavior). The toggle is the "is this in the system prompt right now?"
 * checkbox — the whole point of the rewrite.
 */
function MemoryRow({
  entry,
  onToggle,
  onCommitText,
  onDelete,
}: {
  entry: GlobalMemoryEntry;
  onToggle: () => void;
  onCommitText: (text: string) => void;
  onDelete: () => void;
}) {
  // Local edit buffer so typing doesn't pay for a serialize-deserialize on
  // every keystroke. Synced from props when the underlying store changes
  // (e.g. user re-enabled and the row identity stayed but text didn't).
  const [draft, setDraft] = useState(entry.text);
  useEffect(() => {
    setDraft(entry.text);
  }, [entry.text]);

  const dirty = draft !== entry.text;

  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2',
        entry.disabled && 'bg-black/[0.02] dark:bg-white/[0.02]',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'mt-1 shrink-0 p-0.5 rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.06]',
          entry.disabled
            ? 'text-claude-muted dark:text-night-muted'
            : 'text-emerald-600 dark:text-emerald-400',
        )}
        title={entry.disabled ? '已禁用 · 点击启用' : '已启用 · 点击禁用'}
        aria-label={entry.disabled ? '启用这条记忆' : '禁用这条记忆'}
      >
        {entry.disabled ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>

      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (dirty) onCommitText(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(entry.text);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn(
          'flex-1 bg-transparent text-sm font-mono focus:outline-none px-1 py-1',
          entry.disabled && 'line-through text-claude-muted dark:text-night-muted',
        )}
      />

      <button
        type="button"
        onClick={onDelete}
        className="mt-1 shrink-0 p-0.5 rounded text-claude-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
        title="删除这条记忆"
        aria-label="删除"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skills (reusable capability bundles, injected into system prompt per mode)
// ---------------------------------------------------------------------------

function SkillsSection() {
  const skills = useAppStore((s) => s.skills);
  const addSkill = useAppStore((s) => s.addSkill);
  const updateSkill = useAppStore((s) => s.updateSkill);
  const deleteSkill = useAppStore((s) => s.deleteSkill);
  const setSkillEnabled = useAppStore((s) => s.setSkillEnabled);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const grouped = useMemo(() => {
    const byMode: Record<WorkMode | 'all', Skill[]> = { chat: [], code: [], design: [], all: [] };
    for (const sk of skills) {
      if (sk.modes.length === 0) {
        byMode.all.push(sk);
        continue;
      }
      for (const m of sk.modes) {
        // Defensive: legacy persisted skills could have stale modes (e.g.
        // `'cowork'` pre-removal). Silently skip any mode we don't know
        // about — the migration in useAppStore should catch these on the
        // next rehydrate, but don't let a stray value white-screen Settings.
        const bucket = byMode[m];
        if (bucket) bucket.push(sk);
      }
    }
    return byMode;
  }, [skills]);

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          技能
          <span className="text-xs font-normal text-claude-muted dark:text-night-muted">
            · {skills.filter((s) => s.enabled).length}/{skills.length} 启用
          </span>
        </h2>
        <button
          onClick={() => setAdding(true)}
          className="btn-ghost text-sm"
        >
          <Plus className="w-3.5 h-3.5" />
          新技能
        </button>
      </div>
      <p className="text-sm text-claude-muted dark:text-night-muted mb-4">
        可复用的能力包——在 system prompt 里注入一段"场景→指导"的映射。
        模型读到匹配场景时自动激活，不占用工具调用预算。按模式过滤，只影响相关对话。
      </p>

      {adding && (
        <div className="mb-4">
          <SkillForm
            onCancel={() => setAdding(false)}
            onSave={(s) => {
              addSkill(s);
              setAdding(false);
            }}
          />
        </div>
      )}

      <div className="space-y-2">
        {skills.map((sk) =>
          editing === sk.id ? (
            <SkillForm
              key={sk.id}
              initial={sk}
              onCancel={() => setEditing(null)}
              onSave={(patch) => {
                updateSkill(sk.id, patch);
                setEditing(null);
              }}
            />
          ) : (
            <div
              key={sk.id}
              className={cn(
                'rounded-lg border border-claude-border dark:border-night-border p-3',
                !sk.enabled && 'opacity-60'
              )}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={sk.enabled}
                  onChange={(e) => setSkillEnabled(sk.id, e.target.checked)}
                  className="mt-1"
                  title={sk.enabled ? '已启用 — 会注入到 system prompt' : '已禁用'}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{sk.title}</span>
                    <code className="text-xs bg-black/5 dark:bg-white/10 px-1.5 py-0.5 rounded">
                      {sk.name}
                    </code>
                    {sk.builtin && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent">
                        内置
                      </span>
                    )}
                    <div className="flex gap-1">
                      {sk.modes.length === 0 ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10">
                          所有模式
                        </span>
                      ) : (
                        sk.modes.map((m) => (
                          <span
                            key={m}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10"
                          >
                            {m}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-claude-muted dark:text-night-muted mt-1">
                    {sk.description}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => setEditing(sk.id)}
                    className="btn-ghost text-xs"
                    title="编辑"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  {!sk.builtin && (
                    <button
                      onClick={() => {
                        if (confirm(`删除技能「${sk.title}」？`)) deleteSkill(sk.id);
                      }}
                      className="btn-ghost text-xs text-red-500 hover:text-red-600"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        )}
      </div>

      {/* Mode distribution summary — helps spot lopsided catalogues. */}
      <div className="mt-3 text-xs text-claude-muted dark:text-night-muted">
        按模式分布：chat {grouped.chat.length} · code {grouped.code.length}
        {grouped.all.length > 0 && ` · 全局 ${grouped.all.length}`}
      </div>
    </section>
  );
}

function SkillForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Skill;
  onSave: (s: Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [modes, setModes] = useState<WorkMode[]>(initial?.modes ?? []);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const toggleMode = (m: WorkMode) => {
    setModes((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  };

  const canSave = name.trim() && title.trim() && description.trim() && instructions.trim();

  const save = () => {
    if (!canSave) return;
    onSave({
      name: name.trim(),
      title: title.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      modes,
      enabled,
      builtin: initial?.builtin,
    });
  };

  return (
    <div className="rounded-lg border border-claude-accent/40 bg-claude-accent/5 p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-claude-muted dark:text-night-muted">
            名称（kebab-case，模型看这个）
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="code-review"
            disabled={initial?.builtin}
            className="w-full mt-0.5 px-2 py-1 text-sm rounded border
                       border-claude-border dark:border-night-border bg-white dark:bg-night-bg
                       focus:outline-none focus:ring-1 focus:ring-claude-accent/40
                       disabled:opacity-60"
          />
        </div>
        <div>
          <label className="text-xs text-claude-muted dark:text-night-muted">显示名</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="代码评审"
            className="w-full mt-0.5 px-2 py-1 text-sm rounded border
                       border-claude-border dark:border-night-border bg-white dark:bg-night-bg
                       focus:outline-none focus:ring-1 focus:ring-claude-accent/40"
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-claude-muted dark:text-night-muted">
          适用场景（何时激活，一句话）
        </label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="用户要求审查代码、找 bug 时使用"
          className="w-full mt-0.5 px-2 py-1 text-sm rounded border
                     border-claude-border dark:border-night-border bg-white dark:bg-night-bg
                     focus:outline-none focus:ring-1 focus:ring-claude-accent/40"
        />
      </div>
      <div>
        <label className="text-xs text-claude-muted dark:text-night-muted">
          指导内容（Markdown，怎么做）
        </label>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="1. 先用 fs_read_file 读完整文件..."
          className="w-full mt-0.5 min-h-[120px] max-h-[400px] px-2 py-1 text-sm font-mono rounded border
                     border-claude-border dark:border-night-border bg-white dark:bg-night-bg
                     focus:outline-none focus:ring-1 focus:ring-claude-accent/40 resize-y"
        />
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-claude-muted dark:text-night-muted">适用模式：</span>
          {(['chat', 'code'] as const).map((m) => (
            <label key={m} className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={modes.includes(m)}
                onChange={() => toggleMode(m)}
              />
              {m}
            </label>
          ))}
          <span className="text-xs text-claude-muted dark:text-night-muted">
            {modes.length === 0 ? '（空 = 所有模式）' : ''}
          </span>
        </div>
        <label className="flex items-center gap-1 text-sm cursor-pointer ml-auto">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用
        </label>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="btn-ghost text-sm">取消</button>
        <button
          onClick={save}
          disabled={!canSave}
          className="btn-primary text-sm"
        >
          <Save className="w-3.5 h-3.5" />
          保存
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Servers
// ---------------------------------------------------------------------------

function MCPSection() {
  const servers = useAppStore((s) => s.mcpServers);
  const addMCPServer = useAppStore((s) => s.addMCPServer);
  const removeMCPServer = useAppStore((s) => s.removeMCPServer);
  const connectMCPServer = useAppStore((s) => s.connectMCPServer);
  const disconnectMCPServer = useAppStore((s) => s.disconnectMCPServer);
  const updateMCPServer = useAppStore((s) => s.updateMCPServer);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', url: '', token: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const add = () => {
    if (!form.name.trim() || !form.url.trim()) return;
    addMCPServer({
      name: form.name.trim(),
      url: form.url.trim(),
      token: form.token.trim() || undefined,
      enabled: true,
    });
    setForm({ name: '', url: '', token: '' });
    setAdding(false);
  };

  const tryConnect = async (id: string) => {
    setBusy(id);
    try {
      await connectMCPServer(id);
    } catch {
      /* error lands on the server's lastError */
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Server className="w-4 h-4" /> MCP 服务器
        </h2>
        {!adding && (
          <button onClick={() => setAdding(true)} className="btn-ghost text-sm">
            <Plus className="w-3.5 h-3.5" />
            添加
          </button>
        )}
      </div>
      <p className="text-xs text-claude-muted dark:text-night-muted mb-3">
        Model Context Protocol 服务器。连接后，远程工具会自动注册到工具列表。
        浏览器环境要求服务器开启 CORS；stdio 服务器请用 mcp-proxy 之类的桥接转成 HTTP。
      </p>

      {adding && (
        <div className="mb-3 p-3 rounded-xl border border-dashed border-claude-border dark:border-night-border space-y-2">
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="名称（如 Playwright）"
            className="w-full px-3 py-1.5 rounded-md bg-transparent border border-claude-border dark:border-night-border text-sm focus:outline-none focus:border-claude-accent"
          />
          <input
            value={form.url}
            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            placeholder="URL（如 http://localhost:8787/mcp）"
            className="w-full px-3 py-1.5 rounded-md bg-transparent border border-claude-border dark:border-night-border text-sm font-mono focus:outline-none focus:border-claude-accent"
          />
          <input
            value={form.token}
            onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
            placeholder="Bearer Token（可选）"
            className="w-full px-3 py-1.5 rounded-md bg-transparent border border-claude-border dark:border-night-border text-sm font-mono focus:outline-none focus:border-claude-accent"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setAdding(false)} className="btn-ghost">
              取消
            </button>
            <button
              onClick={add}
              disabled={!form.name.trim() || !form.url.trim()}
              className="btn-primary"
            >
              添加
            </button>
          </div>
        </div>
      )}

      {servers.length === 0 && !adding ? (
        <div className="text-sm text-claude-muted dark:text-night-muted p-6 rounded-xl border border-dashed border-claude-border dark:border-night-border text-center">
          尚未添加任何 MCP 服务器
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <MCPRow
              key={s.id}
              server={s}
              busy={busy === s.id}
              onConnect={() => tryConnect(s.id)}
              onDisconnect={() => disconnectMCPServer(s.id)}
              onRemove={() => {
                if (confirm(`删除 ${s.name}？`)) removeMCPServer(s.id);
              }}
              onToggle={(enabled) => updateMCPServer(s.id, { enabled })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function MCPRow({
  server,
  busy,
  onConnect,
  onDisconnect,
  onRemove,
  onToggle,
}: {
  server: MCPServer;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const statusColor =
    server.status === 'connected'
      ? 'text-green-600'
      : server.status === 'error'
        ? 'text-red-500'
        : server.status === 'connecting'
          ? 'text-blue-500'
          : 'text-claude-muted dark:text-night-muted';

  const StatusIcon =
    server.status === 'connected'
      ? CheckCircle2
      : server.status === 'error'
        ? AlertCircle
        : server.status === 'connecting' || busy
          ? Loader2
          : Unlink;

  return (
    <div
      className={cn(
        'p-3 rounded-xl border',
        server.enabled
          ? 'border-claude-border dark:border-night-border'
          : 'border-dashed border-claude-border/50 dark:border-night-border/50 opacity-70'
      )}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="font-medium truncate">{server.name}</div>
            <div className={cn('flex items-center gap-1 text-xs', statusColor)}>
              <StatusIcon
                className={cn(
                  'w-3 h-3',
                  (server.status === 'connecting' || busy) && 'animate-spin'
                )}
              />
              {server.status}
            </div>
          </div>
          <div className="text-xs font-mono text-claude-muted dark:text-night-muted truncate">
            {server.url}
          </div>
        </div>
        <label className="text-xs flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          启用
        </label>
        {server.status === 'connected' ? (
          <button
            onClick={onDisconnect}
            className="btn-ghost text-xs"
            title="断开连接"
          >
            <Unlink className="w-3.5 h-3.5" />
            断开
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={!server.enabled || busy}
            className="btn-ghost text-xs"
            title="连接并发现工具"
          >
            <LinkIcon className="w-3.5 h-3.5" />
            连接
          </button>
        )}
        <button
          onClick={onRemove}
          className="btn-ghost text-xs text-red-500 hover:text-red-600"
          title="删除"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      {server.lastError && (
        <div className="mt-2 text-xs text-red-500 font-mono">
          错误：{server.lastError}
        </div>
      )}
      {server.toolNames && server.toolNames.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {server.toolNames.map((n) => (
            <span
              key={n}
              className="text-[10px] px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-mono"
            >
              {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function SlashSection() {
  const commands = useAppStore((s) => s.slashCommands);
  const addSlashCommand = useAppStore((s) => s.addSlashCommand);
  const updateSlashCommand = useAppStore((s) => s.updateSlashCommand);
  const deleteSlashCommand = useAppStore((s) => s.deleteSlashCommand);

  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Slash className="w-4 h-4" /> 斜杠命令
        </h2>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="btn-ghost text-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            添加
          </button>
        )}
      </div>
      <p className="text-xs text-claude-muted dark:text-night-muted mb-3">
        在输入框首字母输入 <code className="font-mono">/</code> 即可触发。
        模板命令可用 <code className="font-mono">{'{{input}}'}</code> 和{' '}
        <code className="font-mono">{'{{clipboard}}'}</code> 变量。
      </p>

      {adding && (
        <SlashForm
          onCancel={() => setAdding(false)}
          onSubmit={(c) => {
            addSlashCommand(c);
            setAdding(false);
          }}
        />
      )}

      <div className="space-y-2">
        {commands.map((c) =>
          editing === c.id ? (
            <SlashForm
              key={c.id}
              initial={c}
              onCancel={() => setEditing(null)}
              onSubmit={(patch) => {
                updateSlashCommand(c.id, patch);
                setEditing(null);
              }}
            />
          ) : (
            <div
              key={c.id}
              className="p-3 rounded-xl border border-claude-border dark:border-night-border flex items-start gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-claude-accent text-sm">
                    {c.trigger}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-claude-muted dark:text-night-muted">
                    {c.kind === 'action' ? '动作' : '模板'}
                  </span>
                  {c.builtin && (
                    <span className="text-[10px] uppercase tracking-wider text-claude-muted/70">
                      内置
                    </span>
                  )}
                </div>
                <div className="text-sm text-claude-muted dark:text-night-muted mt-0.5">
                  {c.description}
                </div>
                {c.kind === 'template' && c.template && (
                  <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap text-claude-muted dark:text-night-muted bg-black/[0.04] dark:bg-white/[0.04] p-2 rounded max-h-24 overflow-y-auto">
                    {c.template}
                  </pre>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!c.builtin && (
                  <button
                    onClick={() => setEditing(c.id)}
                    className="btn-ghost text-xs"
                    title="编辑"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                {!c.builtin && (
                  <button
                    onClick={() => {
                      if (confirm(`删除 ${c.trigger}？`))
                        deleteSlashCommand(c.id);
                    }}
                    className="btn-ghost text-xs text-red-500 hover:text-red-600"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </section>
  );
}

function SlashForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: SlashCommand;
  onSubmit: (c: Omit<SlashCommand, 'id'>) => void;
  onCancel: () => void;
}) {
  const [trigger, setTrigger] = useState(initial?.trigger ?? '/');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [template, setTemplate] = useState(initial?.template ?? '');

  const valid = /^\/\S+$/.test(trigger.trim()) && template.trim().length > 0;

  return (
    <div className="p-3 rounded-xl border border-dashed border-claude-border dark:border-night-border space-y-2 mb-2">
      <div className="flex gap-2">
        <input
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          placeholder="/trigger"
          className="w-32 px-3 py-1.5 rounded-md bg-transparent border border-claude-border dark:border-night-border text-sm font-mono focus:outline-none focus:border-claude-accent"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="描述（简短一行）"
          className="flex-1 px-3 py-1.5 rounded-md bg-transparent border border-claude-border dark:border-night-border text-sm focus:outline-none focus:border-claude-accent"
        />
      </div>
      <textarea
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        rows={4}
        placeholder={'模板内容，支持 {{input}} 与 {{clipboard}}…'}
        className="w-full px-3 py-1.5 rounded-md bg-transparent border border-claude-border dark:border-night-border text-sm font-mono focus:outline-none focus:border-claude-accent"
      />
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="btn-ghost">
          取消
        </button>
        <button
          onClick={() =>
            onSubmit({
              trigger: trigger.trim(),
              description: description.trim() || '自定义命令',
              kind: 'template',
              template,
              builtin: false,
            })
          }
          disabled={!valid}
          className="btn-primary"
        >
          <Save className="w-3.5 h-3.5" />
          保存
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tools (enable / disable)
// ---------------------------------------------------------------------------

function ToolsSection() {
  const tools = useRegisteredTools({ includeDisabled: true });
  const setToolDisabledStore = useAppStore((s) => s.setToolDisabled);

  const grouped = groupBySource(tools);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
        <Wrench className="w-4 h-4" /> 工具开关
      </h2>
      <p className="text-xs text-claude-muted dark:text-night-muted mb-3">
        每个工具自己声明它能在哪些模式里用（见下面的标签）。例如 <code className="font-mono">web_search</code>
         在 Chat + Code 都可用，而 <code className="font-mono">calculator</code> 等只在 Code。
        MCP 工具随服务器连接动态出现。
      </p>
      <div className="space-y-4">
        {(['builtin', 'mcp', 'skill'] as const).map((src) => {
          const list = grouped.get(src) ?? [];
          if (list.length === 0) return null;
          return (
            <div key={src}>
              <div className="text-xs uppercase tracking-wider text-claude-muted dark:text-night-muted mb-1.5">
                {src === 'builtin' ? '内置' : src === 'mcp' ? 'MCP' : '技能'}
              </div>
              <div className="space-y-1.5">
                {list.map((t) => (
                  <label
                    key={t.name}
                    className="flex items-start gap-3 p-2.5 rounded-lg border border-claude-border dark:border-night-border cursor-pointer hover:border-claude-accent/50"
                  >
                    <input
                      type="checkbox"
                      checked={!t.disabled}
                      onChange={(e) =>
                        setToolDisabledStore(t.name, !e.target.checked)
                      }
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs text-claude-accent truncate">
                        {t.name}
                      </div>
                      <div className="text-xs text-claude-muted dark:text-night-muted mt-0.5">
                        {t.description}
                      </div>
                      <div className="mt-1 flex gap-1">
                        {t.modes.map((m) => (
                          <span
                            key={m}
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 text-claude-muted dark:text-night-muted"
                          >
                            {m}
                          </span>
                        ))}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {tools.length === 0 && (
          <div className="text-sm text-claude-muted dark:text-night-muted p-6 rounded-xl border border-dashed border-claude-border dark:border-night-border text-center">
            未加载任何工具
          </div>
        )}
      </div>
    </section>
  );
}

function groupBySource(
  tools: ToolDefinition[]
): Map<ToolDefinition['source'], ToolDefinition[]> {
  const out = new Map<ToolDefinition['source'], ToolDefinition[]>();
  for (const t of tools) {
    const arr = out.get(t.source) ?? [];
    arr.push(t);
    out.set(t.source, arr);
  }
  for (const [, arr] of out) arr.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
