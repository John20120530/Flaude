import { useEffect, useMemo, useRef, useState } from 'react';
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
  Upload,
  Zap,
  ChevronDown,
  ChevronRight,
  Search,
  X,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { cn } from '@/lib/utils';
import type { Hook, SlashCommand, MCPServer, Skill, WorkMode } from '@/types';
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
import {
  applyImportBundle,
  describeImportError,
  parseImportBundle,
  previewImportBundle,
  type ImportPreview,
} from '@/lib/accountImport';
import {
  SKILLS_MARKET,
  type SkillsMarketEntry,
} from '@/config/skillsMarket';
import { MCP_MARKET, type McpMarketEntry } from '@/config/mcpMarket';
import { parseSkillMd } from '@/lib/skillsImport';
import { searchSkillsMarket } from '@/lib/skillsSearch';

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
        <SkillsMarketSection />
        <MCPSection />
        <McpMarketSection />
        <SlashSection />
        <HooksSection />
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
  // Import state — separate from export state so the two flows don't fight
  // over the same `busy` flag, and so an import error doesn't blank out a
  // recent "exported successfully" indicator.
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importedAt, setImportedAt] = useState<number | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importSettingsOpt, setImportSettingsOpt] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const onPickImportFile = () => {
    setImportErr(null);
    fileInputRef.current?.click();
  };

  const onImportFile = async (file: File) => {
    setImportErr(null);
    setImportedAt(null);
    let raw: string;
    try {
      raw = await file.text();
    } catch (e) {
      setImportErr(`读取文件失败：${(e as Error).message}`);
      return;
    }
    const parsed = parseImportBundle(raw);
    if (!parsed.ok) {
      setImportErr(describeImportError(parsed.error));
      return;
    }
    setPreview(previewImportBundle(parsed.bundle));
    setImportSettingsOpt(false);
  };

  const onApplyImport = () => {
    if (!preview) return;
    try {
      applyImportBundle(preview.bundle, { importSettings: importSettingsOpt });
      setImportedAt(Date.now());
      setPreview(null);
    } catch (e) {
      setImportErr(`导入失败：${(e as Error).message}`);
    }
  };

  const onCancelImport = () => {
    setPreview(null);
    setImportSettingsOpt(false);
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

        <div className="flex flex-wrap items-center gap-3">
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
          <button
            onClick={onPickImportFile}
            disabled={busy}
            className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-md border border-claude-border dark:border-night-border hover:bg-black/[0.04] dark:hover:bg-white/[0.04] disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            从备份导入
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
              // Reset so picking the same file twice fires onChange.
              e.target.value = '';
            }}
          />
          {lastSavedAt !== null && !busy && !err && (
            <span className="text-xs text-green-700 dark:text-green-400 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              已保存
            </span>
          )}
          {importedAt !== null && (
            <span className="text-xs text-green-700 dark:text-green-400 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              已导入
            </span>
          )}
          {err && (
            <span className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              {err}
            </span>
          )}
          {importErr && (
            <span className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              {importErr}
            </span>
          )}
        </div>
      </div>

      {preview && (
        <ImportPreviewModal
          preview={preview}
          importSettings={importSettingsOpt}
          onToggleSettings={() => setImportSettingsOpt((v) => !v)}
          onApply={onApplyImport}
          onCancel={onCancelImport}
        />
      )}
    </section>
  );
}

/**
 * Modal that summarizes what an import will do before the user commits.
 * Mirrors the WriteApprovalModal / PlanApprovalModal pattern: covers the
 * page until the user makes a choice, no auto-focus on the primary action
 * so they read the counts first. The cross-account warning gets a top
 * banner because it's the most likely "user is about to make a mistake"
 * scenario.
 */
function ImportPreviewModal({
  preview,
  importSettings,
  onToggleSettings,
  onApply,
  onCancel,
}: {
  preview: ImportPreview;
  importSettings: boolean;
  onToggleSettings: () => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const exportedDate = new Date(preview.exportedAt).toLocaleString();
  const totalAffected =
    preview.conversations.added +
    preview.conversations.updated +
    preview.conversations.tombstoned +
    preview.projects.added +
    preview.projects.updated +
    preview.projects.tombstoned +
    preview.artifacts.added +
    preview.artifacts.updated +
    preview.artifacts.tombstoned +
    preview.skills.added +
    preview.skills.updated +
    preview.slashCommands.added;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="导入备份预览"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
    >
      <div
        className={cn(
          'w-full max-w-2xl max-h-[90vh] flex flex-col',
          'rounded-xl border border-claude-border dark:border-night-border',
          'bg-claude-bg dark:bg-night-bg shadow-2xl',
        )}
      >
        <div className="px-5 py-3 border-b border-claude-border dark:border-night-border">
          <h2 className="font-semibold flex items-center gap-2">
            <Upload className="w-4 h-4" />
            导入备份预览
          </h2>
          <div className="text-xs text-claude-muted dark:text-night-muted mt-0.5">
            导出于 {exportedDate}
            {preview.exportedBy && ` · 来自 ${preview.exportedBy.email}`}
            {preview.flaudeVersion && ` · Flaude ${preview.flaudeVersion}`}
          </div>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-3 text-sm">
          {preview.isOtherAccount && preview.exportedBy && (
            <div className="p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200 text-xs">
              ⚠ 这个备份是从 <code className="font-mono">{preview.exportedBy.email}</code> 导出的，
              和当前登录账号不一致。导入会让两个账号的数据混在一起，且会通过 sync 同步到当前账号的服务端。
              确定要继续吗？
            </div>
          )}

          <div className="p-3 rounded-md bg-black/[0.03] dark:bg-white/[0.03] text-xs text-claude-muted dark:text-night-muted">
            合并策略：每条记录按 <code>updatedAt</code> 取较新版本（LWW）。本地比备份更新的，**保留本地**。
            备份里删除标记的会同步删除（如本地存在）。设置项默认不导入。
          </div>

          <ImportEntityRow label="会话" counts={preview.conversations} />
          <ImportEntityRow label="项目" counts={preview.projects} />
          <ImportEntityRow label="工件" counts={preview.artifacts} />
          <div className="flex items-center gap-3 text-xs">
            <span className="w-12 text-claude-muted dark:text-night-muted">技能</span>
            <span className="text-green-700 dark:text-green-400">+{preview.skills.added} 新增</span>
            <span className="text-blue-700 dark:text-blue-400">{preview.skills.updated} 更新</span>
            <span className="text-claude-muted dark:text-night-muted">{preview.skills.localKept} 保留本地</span>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="w-12 text-claude-muted dark:text-night-muted">斜杠</span>
            <span className="text-green-700 dark:text-green-400">+{preview.slashCommands.added} 新增</span>
            <span className="text-claude-muted dark:text-night-muted">{preview.slashCommands.skipped} 已存在跳过</span>
          </div>

          <label className="flex items-center gap-2 mt-3 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={importSettings}
              onChange={onToggleSettings}
              className="rounded"
            />
            <span>同时导入设置（主题、默认模型、全局记忆、MCP 服务器、斜杠命令、禁用工具列表）。<strong>不会</strong>导入工作区路径和文件/shell 权限——这些是按设备配置的。</span>
          </label>

          {totalAffected === 0 && (
            <div className="p-3 rounded-md bg-black/[0.03] dark:bg-white/[0.03] text-xs">
              这个备份的数据全部在本地存在且本地版本不旧——导入不会有任何变化。
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-claude-border dark:border-night-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center gap-3">
          <span className="text-[11px] text-claude-muted dark:text-night-muted">Esc 取消</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-sm hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onApply}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm font-medium inline-flex items-center gap-1.5',
              preview.isOtherAccount
                ? 'bg-amber-600 text-white hover:bg-amber-600/90'
                : 'bg-claude-accent text-white hover:bg-claude-accent/90',
            )}
          >
            <Upload className="w-4 h-4" />
            {preview.isOtherAccount ? '我确认，仍然导入' : '应用导入'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportEntityRow({
  label,
  counts,
}: {
  label: string;
  counts: ImportPreview['conversations'];
}) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-12 text-claude-muted dark:text-night-muted">{label}</span>
      <span className="text-green-700 dark:text-green-400">+{counts.added} 新增</span>
      <span className="text-blue-700 dark:text-blue-400">{counts.updated} 更新</span>
      <span className="text-claude-muted dark:text-night-muted">{counts.localKept} 保留本地</span>
      {counts.tombstoned > 0 && (
        <span className="text-red-700 dark:text-red-400">{counts.tombstoned} 删除</span>
      )}
    </div>
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
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded',
                server.transport === 'stdio'
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
              )}
            >
              {server.transport === 'stdio' ? 'stdio' : 'HTTP'}
            </span>
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
          <div
            className="text-xs font-mono text-claude-muted dark:text-night-muted truncate"
            title={
              server.transport === 'stdio' && server.stdioConfig
                ? `${server.stdioConfig.command} ${server.stdioConfig.args.join(' ')}`
                : server.url
            }
          >
            {server.transport === 'stdio' && server.stdioConfig
              ? `$ ${server.stdioConfig.command} ${server.stdioConfig.args.join(' ')}`
              : server.url}
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
// Hooks (auto-run shell commands on agent events) — desktop only
// ---------------------------------------------------------------------------
//
// Three event types:
//   - pre_tool_use  → fires BEFORE matching tool; non-zero exit BLOCKS the
//                     tool with the hook's stderr as the rejection reason
//   - post_tool_use → fires AFTER matching tool; stdout/stderr appended to
//                     the tool result so the agent sees lint/typecheck
//                     output in the next round
//   - stop          → fires when agent turn ends; output discarded (use
//                     for desktop notifications, "git status", etc.)
//
// Substitution variables documented inline in the create/edit form.
// ---------------------------------------------------------------------------

const HOOK_EVENT_LABELS: Record<Hook['event'], string> = {
  pre_tool_use: '工具调用前 (pre_tool_use)',
  post_tool_use: '工具调用后 (post_tool_use)',
  stop: '本轮结束时 (stop)',
};

const DEFAULT_HOOK: Omit<Hook, 'id' | 'createdAt' | 'updatedAt'> = {
  name: '',
  enabled: true,
  event: 'post_tool_use',
  toolMatcher: 'fs_write_file',
  command: '',
  timeoutMs: 30_000,
};

function HooksSection() {
  const hooks = useAppStore((s) => s.hooks);
  const addHook = useAppStore((s) => s.addHook);
  const updateHook = useAppStore((s) => s.updateHook);
  const deleteHook = useAppStore((s) => s.deleteHook);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Zap className="w-4 h-4" />
          Hooks
        </h2>
        <button
          onClick={() => {
            setAdding(true);
            setEditing(null);
          }}
          className="btn-ghost text-xs"
          aria-label="添加 hook"
        >
          <Plus className="w-3.5 h-3.5" />
          添加 hook
        </button>
      </div>
      <p className="text-sm text-claude-muted dark:text-night-muted mb-3">
        在 Code 模式 agent 事件触发时自动跑 shell 命令。<strong>仅桌面版</strong>——浏览器版没有 shell 子系统。
        可用变量：<code className="text-[11px]">$FLAUDE_TOOL</code> · <code className="text-[11px]">$FLAUDE_FILE</code> · <code className="text-[11px]">$FLAUDE_WORKSPACE</code> · <code className="text-[11px]">$FLAUDE_ARGS_JSON</code>。
      </p>

      <div className="space-y-2">
        {hooks.length === 0 && !adding && (
          <div className="p-4 rounded-md border border-dashed border-claude-border dark:border-night-border text-center text-sm text-claude-muted dark:text-night-muted">
            还没有任何 hook。常见用法：写文件后跑 <code>pnpm tsc --noEmit</code>、本轮结束跑 <code>git status</code>、写代码前拒绝危险 <code>rm -rf</code>。
          </div>
        )}

        {hooks.map((h) =>
          editing === h.id ? (
            <HookEditor
              key={h.id}
              initial={h}
              onSave={(patch) => {
                updateHook(h.id, patch);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
              onDelete={() => {
                deleteHook(h.id);
                setEditing(null);
              }}
            />
          ) : (
            <HookRow
              key={h.id}
              hook={h}
              onEdit={() => {
                setEditing(h.id);
                setAdding(false);
              }}
              onToggle={() => updateHook(h.id, { enabled: !h.enabled })}
            />
          ),
        )}

        {adding && (
          <HookEditor
            initial={DEFAULT_HOOK}
            onSave={(patch) => {
              addHook({ ...DEFAULT_HOOK, ...patch } as Omit<Hook, 'id' | 'createdAt' | 'updatedAt'>);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
    </section>
  );
}

function HookRow({
  hook,
  onEdit,
  onToggle,
}: {
  hook: Hook;
  onEdit: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 px-3 py-2 rounded-md border',
        'border-claude-border dark:border-night-border',
        !hook.enabled && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        title={hook.enabled ? '已启用 · 点击禁用' : '已禁用 · 点击启用'}
        className={cn(
          'mt-0.5 shrink-0 p-0.5 rounded hover:bg-black/[0.06] dark:hover:bg-white/[0.06]',
          hook.enabled
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-claude-muted dark:text-night-muted',
        )}
        aria-label={hook.enabled ? '禁用' : '启用'}
      >
        {hook.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium truncate">{hook.name || '(未命名)'}</span>
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.07] text-claude-muted dark:text-night-muted">
            {HOOK_EVENT_LABELS[hook.event]}
          </span>
          {hook.event !== 'stop' && (
            <span className="text-[11px] font-mono text-claude-muted dark:text-night-muted">
              ↳ {hook.toolMatcher || '*'}
            </span>
          )}
        </div>
        <div className="text-xs font-mono text-claude-muted dark:text-night-muted mt-0.5 truncate">
          {hook.command || '(无命令)'}
        </div>
      </div>
      <button onClick={onEdit} className="btn-ghost text-xs shrink-0">
        <Pencil className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function HookEditor({
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Omit<Hook, 'id' | 'createdAt' | 'updatedAt'> | Hook;
  onSave: (patch: Partial<Hook>) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [event, setEvent] = useState<Hook['event']>(initial.event);
  const [toolMatcher, setToolMatcher] = useState(initial.toolMatcher);
  const [command, setCommand] = useState(initial.command);
  const [timeoutSec, setTimeoutSec] = useState(
    Math.round((initial.timeoutMs || 30_000) / 1000),
  );
  const [helpOpen, setHelpOpen] = useState(false);

  const canSave = name.trim() && command.trim();

  const save = () => {
    if (!canSave) return;
    onSave({
      name: name.trim(),
      enabled,
      event,
      toolMatcher: event === 'stop' ? '' : toolMatcher.trim() || '*',
      command: command.trim(),
      timeoutMs: Math.max(1, timeoutSec) * 1000,
    });
  };

  return (
    <div className="p-3 rounded-md border border-claude-accent/40 bg-claude-accent/[0.03] dark:bg-claude-accent/[0.05] space-y-2">
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="hook 名字（例：写后 typecheck）"
        className="w-full px-2 py-1 text-sm rounded border border-claude-border dark:border-night-border bg-white dark:bg-night-bg focus:outline-none focus:ring-2 focus:ring-claude-accent/40"
      />
      <div className="flex items-center gap-2 text-xs">
        <select
          value={event}
          onChange={(e) => setEvent(e.target.value as Hook['event'])}
          className="px-2 py-1 rounded border border-claude-border dark:border-night-border bg-white dark:bg-night-bg"
        >
          <option value="pre_tool_use">{HOOK_EVENT_LABELS.pre_tool_use}</option>
          <option value="post_tool_use">{HOOK_EVENT_LABELS.post_tool_use}</option>
          <option value="stop">{HOOK_EVENT_LABELS.stop}</option>
        </select>
        {event !== 'stop' && (
          <input
            type="text"
            value={toolMatcher}
            onChange={(e) => setToolMatcher(e.target.value)}
            placeholder="工具名（例：fs_write_file 或 fs_write_file|shell_exec 或 *）"
            className="flex-1 px-2 py-1 font-mono rounded border border-claude-border dark:border-night-border bg-white dark:bg-night-bg focus:outline-none focus:ring-2 focus:ring-claude-accent/40"
          />
        )}
      </div>
      <textarea
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder={
          event === 'stop'
            ? '例：git -C $FLAUDE_WORKSPACE status --short'
            : event === 'pre_tool_use'
            ? '例：echo "$FLAUDE_FILE" | grep -v node_modules    （exit 1 阻止；exit 0 放行）'
            : '例：pnpm tsc --noEmit    （或：pnpm prettier --write $FLAUDE_FILE）'
        }
        rows={3}
        className="w-full px-2 py-1 text-sm font-mono rounded border border-claude-border dark:border-night-border bg-white dark:bg-night-bg focus:outline-none focus:ring-2 focus:ring-claude-accent/40 resize-y"
      />
      <div className="flex items-center gap-3 text-xs text-claude-muted dark:text-night-muted">
        <label className="flex items-center gap-1">
          超时
          <input
            type="number"
            min={1}
            max={600}
            value={timeoutSec}
            onChange={(e) => setTimeoutSec(parseInt(e.target.value, 10) || 30)}
            className="w-14 px-1 py-0.5 rounded border border-claude-border dark:border-night-border bg-white dark:bg-night-bg"
          />
          秒
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用
        </label>
        <button
          type="button"
          onClick={() => setHelpOpen((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 text-claude-muted dark:text-night-muted hover:text-claude-ink dark:hover:text-night-ink"
        >
          {helpOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          帮助
        </button>
      </div>
      {helpOpen && (
        <div className="text-[11px] leading-relaxed bg-black/[0.03] dark:bg-white/[0.03] rounded p-2 space-y-1.5">
          <div>
            <strong>变量替换</strong>（在执行前替换，shell-quoted）：
            <ul className="ml-4 mt-1 space-y-0.5">
              <li><code>$FLAUDE_TOOL</code> — 触发的工具名（stop 事件下为空）</li>
              <li><code>$FLAUDE_FILE</code> — fs_write_file 的 path 参数；其他工具为空</li>
              <li><code>$FLAUDE_WORKSPACE</code> — 当前工作区根目录</li>
              <li><code>$FLAUDE_ARGS_JSON</code> — 工具调用的全部参数（JSON 字符串）</li>
            </ul>
          </div>
          <div>
            <strong>事件语义</strong>：
            <ul className="ml-4 mt-1 space-y-0.5">
              <li><code>pre_tool_use</code>：exit 0 放行；exit ≠ 0 阻止工具，hook stderr 当作工具错误返回给 agent</li>
              <li><code>post_tool_use</code>：工具成功后跑；stdout/stderr 拼到工具结果，agent 下一轮看到</li>
              <li><code>stop</code>：每次 agent 回合结束时跑（背景执行，输出丢弃）</li>
            </ul>
          </div>
          <div>
            <strong>工具匹配</strong>（pre/post 事件）：精确匹配；多个用 <code>|</code> 分隔；<code>*</code> 匹配任意工具。
          </div>
          <div>
            <strong>shell 包装</strong>：Windows 用 <code>cmd /c</code>，其他用 <code>sh -c</code>。命令可以用管道、重定向等 shell 特性。
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
          >
            删除
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="btn-ghost text-xs"
        >
          取消
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="btn-primary text-xs disabled:opacity-50"
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

// ---------------------------------------------------------------------------
// Skills Marketplace section — browse + install curated external skills
// ---------------------------------------------------------------------------
//
// Static manifest baked at build time (src/config/skillsMarket.ts). Each
// entry points at a raw GitHub URL for the SKILL.md content; we lazy-fetch
// only when the user clicks Preview / Install. Adapter parses YAML
// frontmatter + body (src/lib/skillsImport.ts) and converts to Flaude's
// Skill shape.
//
// "Already installed" detection: we tag installed skills with a hidden
// `marketId` field stashed inside their `description` (lossy) — actually
// no, simpler: we re-derive by name. If the user's skills include one
// whose `name` matches the parsed SKILL.md `name`, we mark the market
// entry as installed. Imperfect (user could rename) but good enough for
// v1; the worst case is "install" appearing twice with no harm.

function SkillsMarketSection() {
  const skills = useAppStore((s) => s.skills);
  const addSkill = useAppStore((s) => s.addSkill);
  const installedNames = useMemo(
    () => new Set(skills.map((sk) => sk.name)),
    [skills],
  );

  // Search state. Empty `query` shows the curated baseline; non-empty
  // triggers a federated GitHub search via the Worker. We debounce the
  // network call by 350ms — feels responsive while typing without
  // hammering the upstream during a long word.
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<SkillsMarketEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  // Track the latest in-flight query so a slow earlier response doesn't
  // overwrite a fresher one (race when user types fast).
  const inflightRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!debounced) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    const ticket = ++inflightRef.current;
    setLoading(true);
    setError(null);
    void searchSkillsMarket(debounced)
      .then((res) => {
        if (inflightRef.current !== ticket) return; // a newer query won
        setResults(res.results);
        setFromCache(res.fromCache);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (inflightRef.current !== ticket) return;
        setError(e.message || '搜索失败');
        setResults(null);
        setLoading(false);
      });
  }, [debounced]);

  // Decide what to render:
  //   - empty query   → curated baseline (8 entries from SKILLS_MARKET)
  //   - active search → results (or loading / error / empty states)
  //
  // When showing search results, we union them with curated entries that
  // also match the query (substring on title/description) — those float
  // to the top with a "推荐" badge. Why: a user searching "java" should
  // see the curated "Java Clean Code" on top even though it'd also be
  // found via GitHub.
  const showingSearch = debounced.length > 0;
  const matchedCurated = useMemo(() => {
    if (!showingSearch) return [];
    const q = debounced.toLowerCase();
    return SKILLS_MARKET.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [showingSearch, debounced]);

  const dedupedResults = useMemo(() => {
    if (!showingSearch || !results) return [];
    const curatedIds = new Set(matchedCurated.map((e) => e.id));
    return results.filter((r) => !curatedIds.has(r.id));
  }, [showingSearch, results, matchedCurated]);

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <Sparkles className="w-4 h-4" />
        Skills 市场
      </h2>
      <p className="text-sm text-claude-muted dark:text-night-muted mb-3">
        搜整个 GitHub 上的 SKILL.md 文件 + 8 条精选推荐。
        <strong> 严格 MIT / Apache 过滤</strong>——非这两种 license 的 skill 直接不显示。
        每条都标注来源 / license / publisher。
      </p>

      {/* Search box */}
      <div className="relative mb-3">
        <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-claude-muted dark:text-night-muted pointer-events-none" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索关键词，如 'java' / 'pdf' / 'review' / 'memory'…"
          className="w-full pl-8 pr-8 py-2 text-sm rounded-md border border-claude-border dark:border-night-border bg-white dark:bg-night-bg focus:outline-none focus:border-claude-accent"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-claude-muted hover:text-claude-ink dark:hover:text-night-ink"
            aria-label="清除"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Status line */}
      {showingSearch && (
        <div className="text-xs text-claude-muted dark:text-night-muted mb-2 flex items-center gap-2">
          {loading && (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              在 GitHub 上搜「{debounced}」…
            </>
          )}
          {!loading && error && (
            <span className="text-red-500">搜索失败：{error}</span>
          )}
          {!loading && !error && results && (
            <>
              找到 {matchedCurated.length + dedupedResults.length} 条匹配
              {fromCache && <span className="opacity-60">（缓存）</span>}
              {matchedCurated.length > 0 && (
                <span className="opacity-60">
                  · 含 {matchedCurated.length} 条精选推荐
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Results / curated baseline */}
      <div className="space-y-2">
        {!showingSearch &&
          SKILLS_MARKET.map((entry) => (
            <SkillsMarketRow
              key={entry.id}
              entry={entry}
              source="curated"
              installed={installedNames.has(skillNameFromId(entry.id))}
              onInstall={async () => {
                const result = await installMarketSkill(entry, addSkill);
                if (!result.ok) alert(`安装失败：${result.error}`);
              }}
            />
          ))}
        {showingSearch &&
          matchedCurated.map((entry) => (
            <SkillsMarketRow
              key={`curated-${entry.id}`}
              entry={entry}
              source="curated"
              installed={installedNames.has(skillNameFromId(entry.id))}
              onInstall={async () => {
                const result = await installMarketSkill(entry, addSkill);
                if (!result.ok) alert(`安装失败：${result.error}`);
              }}
            />
          ))}
        {showingSearch &&
          dedupedResults.map((entry) => (
            <SkillsMarketRow
              key={`search-${entry.id}`}
              entry={entry}
              source="search"
              installed={installedNames.has(skillNameFromId(entry.id))}
              onInstall={async () => {
                const result = await installMarketSkill(entry, addSkill);
                if (!result.ok) alert(`安装失败：${result.error}`);
              }}
            />
          ))}
        {showingSearch &&
          !loading &&
          !error &&
          results &&
          matchedCurated.length === 0 &&
          dedupedResults.length === 0 && (
            <div className="text-sm text-claude-muted dark:text-night-muted py-6 text-center">
              没找到 MIT/Apache 授权的 skill。试试别的关键词，或者直接到上面的「Skills」section 手写一条。
            </div>
          )}
      </div>
    </section>
  );
}

/** Best-effort guess at the skill's `name` field from its market id. The
 *  market id is `<publisher>/<slug>`, and Anthropic's convention is that
 *  the SKILL.md name == the slug minus the `skills-` prefix. */
function skillNameFromId(marketId: string): string {
  const slug = marketId.split('/').pop() ?? '';
  return slug.replace(/^skills-/, '');
}

function SkillsMarketRow({
  entry,
  installed,
  onInstall,
  source,
}: {
  entry: SkillsMarketEntry;
  installed: boolean;
  onInstall: () => void | Promise<void>;
  /** Provenance — affects the badge shown next to the title. `curated`
   *  comes from the static `SKILLS_MARKET` manifest, `search` from
   *  GitHub federated search. Optional for back-compat. */
  source?: 'curated' | 'search';
}) {
  const [expanded, setExpanded] = useState(false);
  const [previewState, setPreviewState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ok'; body: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [installing, setInstalling] = useState(false);

  const loadPreview = async () => {
    setPreviewState({ kind: 'loading' });
    try {
      const r = await fetch(entry.rawUrl);
      if (!r.ok) {
        setPreviewState({
          kind: 'error',
          message: `HTTP ${r.status}：从 GitHub 拉 SKILL.md 失败`,
        });
        return;
      }
      const text = await r.text();
      const parsed = parseSkillMd(text);
      if (!parsed.ok) {
        setPreviewState({ kind: 'error', message: parsed.error });
        return;
      }
      setPreviewState({ kind: 'ok', body: parsed.parsed.body });
    } catch (e) {
      setPreviewState({ kind: 'error', message: (e as Error).message });
    }
  };

  return (
    <div className="p-3 rounded-md border border-claude-border dark:border-night-border space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{entry.title}</span>
            {source === 'curated' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400 inline-flex items-center gap-0.5">
                <Sparkles className="w-2.5 h-2.5" />
                推荐
              </span>
            )}
            {source === 'search' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 dark:text-blue-400 inline-flex items-center gap-0.5">
                <Search className="w-2.5 h-2.5" />
                GitHub
              </span>
            )}
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded font-mono',
                entry.license === 'MIT'
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
              )}
            >
              {entry.license}
            </span>
            {entry.modes.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/[0.05] dark:bg-white/[0.07] text-claude-muted dark:text-night-muted">
                {entry.modes.join(' / ')}
              </span>
            )}
            {entry.tags
              ?.filter((t) => t !== 'github-search')
              .map((t) => (
                <span
                  key={t}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent"
                >
                  {t}
                </span>
              ))}
            {installed && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                已安装
              </span>
            )}
          </div>
          <div className="text-xs text-claude-muted dark:text-night-muted mt-1">
            {entry.description}
          </div>
          <div className="text-[11px] text-claude-muted dark:text-night-muted mt-1.5">
            {entry.publisher} ·{' '}
            <a
              href={entry.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-claude-ink dark:hover:text-night-ink"
            >
              {entry.source}
            </a>{' '}
            · {entry.license}
          </div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setExpanded((v) => {
                const next = !v;
                if (next && previewState.kind === 'idle') void loadPreview();
                return next;
              });
            }}
            className="btn-ghost text-xs"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            预览
          </button>
          <button
            type="button"
            disabled={installed || installing}
            onClick={async () => {
              setInstalling(true);
              try {
                await onInstall();
              } finally {
                setInstalling(false);
              }
            }}
            className="btn-primary text-xs disabled:opacity-50"
          >
            {installing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            {installed ? '已装' : '安装'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-claude-border/50 dark:border-night-border/50 pt-2">
          {previewState.kind === 'loading' && (
            <div className="text-xs text-claude-muted dark:text-night-muted flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              从 GitHub 拉 SKILL.md...
            </div>
          )}
          {previewState.kind === 'error' && (
            <div className="text-xs text-red-600 dark:text-red-400">
              {previewState.message}
            </div>
          )}
          {previewState.kind === 'ok' && (
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-black/[0.03] dark:bg-white/[0.03] rounded p-2 max-h-64 overflow-y-auto">
              {previewState.body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Fetch SKILL.md, parse, install into the user's skills. Returns
 *  ok/error so the row UI can surface the failure inline. */
async function installMarketSkill(
  entry: SkillsMarketEntry,
  addSkill: (s: Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>) => string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let raw: string;
  try {
    const r = await fetch(entry.rawUrl);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    raw = await r.text();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const parsed = parseSkillMd(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // Compose the Flaude Skill. Title comes from the marketplace manifest
  // (Chinese-friendly); name + description come from upstream
  // frontmatter; instructions = body. Append a small attribution line so
  // when the user later opens the skill in the editor they remember
  // where it came from.
  const attribution =
    `\n\n---\n*来自 Skills 市场 · ${entry.publisher} · ` +
    `[${entry.source}](${entry.sourceUrl}) · ${entry.license}*\n`;

  addSkill({
    name: parsed.parsed.name,
    title: entry.title,
    description: parsed.parsed.description,
    instructions: parsed.parsed.body + attribution,
    modes: entry.modes,
    enabled: true,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// MCP Marketplace section — browse curated MCP servers, one-click install
// for HTTP endpoints, copy-instructions for stdio servers
// ---------------------------------------------------------------------------

function McpMarketSection() {
  const mcpServers = useAppStore((s) => s.mcpServers);
  const addMCPServer = useAppStore((s) => s.addMCPServer);
  const connectMCPServer = useAppStore((s) => s.connectMCPServer);
  const isOnTauri = isTauri();

  // "Already installed" detection for both transports:
  //   - HTTP: exact URL match
  //   - Stdio: marketplace id stored in `name` (we set name = entry.title)
  //     plus transport === 'stdio'. Best-effort, same trade-off as Skills
  //     market: a renamed install won't be recognized as "already
  //     installed" but no harm done.
  const installedHttpUrls = useMemo(
    () => new Set(mcpServers.filter((m) => m.transport !== 'stdio').map((m) => m.url)),
    [mcpServers],
  );
  const installedStdioTitles = useMemo(
    () =>
      new Set(
        mcpServers
          .filter((m) => m.transport === 'stdio')
          .map((m) => m.name),
      ),
    [mcpServers],
  );

  return (
    <section>
      <h2 className="text-lg font-semibold mb-1 flex items-center gap-2">
        <Server className="w-4 h-4" />
        MCP 市场
      </h2>
      <p className="text-sm text-claude-muted dark:text-night-muted mb-3">
        外部 MCP 服务器精选。HTTP endpoint 浏览器 / 桌面都能一键装；stdio MCP{' '}
        {isOnTauri ? (
          <>桌面版自动 spawn 子进程（需要系统装了 Node.js）。</>
        ) : (
          <>仅在桌面版可一键，网页版只能看安装命令。</>
        )}
        来源 + license 每条都标注。
      </p>
      <div className="space-y-2">
        {MCP_MARKET.map((entry) => {
          const httpInstalled =
            entry.endpointType === 'http' &&
            entry.endpointUrl !== undefined &&
            installedHttpUrls.has(entry.endpointUrl);
          const stdioInstalled =
            entry.endpointType === 'stdio-instructions' &&
            installedStdioTitles.has(entry.title);
          return (
            <McpMarketRow
              key={entry.id}
              entry={entry}
              installed={httpInstalled || stdioInstalled}
              onInstall={async (token) => {
                // Path 1: HTTP — same as before.
                if (entry.endpointType === 'http' && entry.endpointUrl) {
                  addMCPServer({
                    name: entry.title,
                    transport: 'http',
                    url: entry.endpointUrl,
                    token: token || undefined,
                    enabled: true,
                  });
                  return;
                }
                // Path 2: stdio + Tauri + structured spawn config — one-click.
                if (
                  entry.endpointType === 'stdio-instructions' &&
                  entry.stdioCommand &&
                  isOnTauri
                ) {
                  // If the entry declares envKeys (e.g. GITHUB token), the
                  // user-pasted token becomes the env value. We take the
                  // FIRST envKey only — multi-env entries aren't a thing in
                  // the current manifest, and adding a multi-input form is
                  // a v2 polish item.
                  const env: Record<string, string> = {};
                  const keys = entry.stdioCommand.envKeys ?? [];
                  if (keys.length > 0 && token) {
                    env[keys[0]!] = token;
                  }
                  const id = addMCPServer({
                    name: entry.title,
                    transport: 'stdio',
                    url: '', // unused for stdio; kept for `installedUrls` shape
                    stdioConfig: {
                      command: entry.stdioCommand.command,
                      args: entry.stdioCommand.args,
                      env: Object.keys(env).length > 0 ? env : undefined,
                    },
                    enabled: true,
                  });
                  // Auto-connect (= spawn child + run handshake) so the
                  // user sees tools in the list immediately. Errors
                  // surface on the row's `lastError` via the regular
                  // store path; we just swallow here.
                  try {
                    await connectMCPServer(id);
                  } catch {
                    /* error already on store entry */
                  }
                  return;
                }
                // Path 3: stdio without spawn config OR running on web.
                alert(
                  isOnTauri
                    ? '这条 stdio MCP 需要额外参数（如 DB 连接串），暂不支持一键安装。请按上面的命令本地启动后到「MCP 服务器」section 手动添加。'
                    : '网页版不能 spawn 本地进程。请下载桌面版 Flaude，或按上面的命令本地启动 + 用 mcp-proxy 包成 HTTP。',
                );
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

function McpMarketRow({
  entry,
  installed,
  onInstall,
}: {
  entry: McpMarketEntry;
  installed: boolean;
  onInstall: (token: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);

  const isStdio = entry.endpointType === 'stdio-instructions';
  // Can the install button do real work? HTTP always; stdio only when we
  // have structured spawn config AND we're running on the desktop.
  const canOneClick =
    entry.endpointType === 'http'
      ? entry.endpointUrl !== undefined
      : Boolean(entry.stdioCommand) && isTauri();
  const needsTokenInput =
    (entry.endpointType === 'http' && entry.authType === 'bearer') ||
    (canOneClick &&
      isStdio &&
      (entry.stdioCommand?.envKeys?.length ?? 0) > 0);

  const copyCommand = async () => {
    if (!entry.installInstructions) return;
    try {
      await navigator.clipboard.writeText(entry.installInstructions);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; user can select manually */
    }
  };

  return (
    <div className="p-3 rounded-md border border-claude-border dark:border-night-border space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{entry.title}</span>
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded',
                isStdio
                  ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
              )}
            >
              {isStdio ? 'stdio · 需自启' : 'HTTP · 可一键装'}
            </span>
            {entry.authType === 'bearer' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-700 dark:text-purple-400">
                需 token
              </span>
            )}
            {entry.tags?.map((t) => (
              <span
                key={t}
                className="text-[10px] px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent"
              >
                {t}
              </span>
            ))}
            {installed && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                已安装
              </span>
            )}
          </div>
          <div className="text-xs text-claude-muted dark:text-night-muted mt-1">
            {entry.description}
          </div>
          <div className="text-[11px] text-claude-muted dark:text-night-muted mt-1.5">
            {entry.publisher} ·{' '}
            <a
              href={entry.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-claude-ink dark:hover:text-night-ink"
            >
              {entry.source}
            </a>{' '}
            · {entry.license}
            {entry.tools && entry.tools.length > 0 && (
              <span className="ml-2 font-mono">
                工具：{entry.tools.slice(0, 4).join(', ')}
                {entry.tools.length > 4 && ` (+${entry.tools.length - 4} more)`}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="btn-ghost text-xs"
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            详情
          </button>
          {canOneClick && (
            <button
              type="button"
              disabled={installed || installing}
              onClick={async () => {
                setInstalling(true);
                try {
                  await onInstall(token);
                } finally {
                  setInstalling(false);
                }
              }}
              className="btn-primary text-xs disabled:opacity-50"
              title={
                isStdio
                  ? '需要系统装了 Node.js（npx 在 PATH 里）'
                  : undefined
              }
            >
              <Download className="w-3.5 h-3.5" />
              {installed ? '已装' : installing ? '安装中…' : '安装'}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-claude-border/50 dark:border-night-border/50 pt-2 space-y-2">
          {isStdio ? (
            <>
              {entry.stdioCommand && (
                <div className="text-[11px] text-claude-muted dark:text-night-muted">
                  桌面一键安装会执行：
                  <code className="ml-1 font-mono break-all">
                    {entry.stdioCommand.command}{' '}
                    {entry.stdioCommand.args.join(' ')}
                  </code>
                </div>
              )}
              <div className="text-xs text-claude-muted dark:text-night-muted">
                {entry.stdioCommand
                  ? '说明 / 网页版手动启动方式：'
                  : '本地启动指令：'}
              </div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-black/[0.03] dark:bg-white/[0.03] rounded p-2 max-h-48 overflow-y-auto">
                {entry.installInstructions}
              </pre>
              <button
                type="button"
                onClick={copyCommand}
                className="btn-ghost text-xs"
              >
                {copied ? <CheckCircle2 className="w-3 h-3" /> : <Upload className="w-3 h-3" />}
                {copied ? '已复制' : '复制全部'}
              </button>
            </>
          ) : (
            <div className="text-[11px] text-claude-muted dark:text-night-muted">
              HTTP endpoint：
              <code className="ml-1 font-mono">{entry.endpointUrl}</code>
            </div>
          )}
          {needsTokenInput && (
            <div className="space-y-1">
              <div className="text-xs text-claude-muted dark:text-night-muted">
                {isStdio && entry.stdioCommand?.envKeys?.[0] ? (
                  <>
                    环境变量{' '}
                    <code className="font-mono">
                      {entry.stdioCommand.envKeys[0]}
                    </code>
                    （安装时注入到子进程）
                  </>
                ) : (
                  <>Bearer token（可选填，不填可先尝试匿名）</>
                )}
                {entry.authHelpUrl && (
                  <>
                    {' · '}
                    <a
                      href={entry.authHelpUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      在哪里拿
                    </a>
                  </>
                )}
              </div>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  isStdio && entry.stdioCommand?.envKeys?.[0]?.includes('TOKEN')
                    ? '粘贴 token / 密钥'
                    : 'sk-...'
                }
                className="w-full px-2 py-1 text-xs font-mono rounded border border-claude-border dark:border-night-border bg-white dark:bg-night-bg focus:outline-none"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
