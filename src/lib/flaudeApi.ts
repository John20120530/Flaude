/**
 * Flaude server API helpers.
 *
 * Single source of truth for:
 *   - The server URL (env var with localhost fallback for dev).
 *   - The login / logout / me endpoints.
 *   - The Bearer-token fetch wrapper used by everything else (chat stream,
 *     web_search, future /usage and /conversations).
 *
 * Why not just scatter fetch() calls with manual header injection:
 *   Centralizing here means "token expired → 401 → kick to login" has exactly
 *   one code path. When JWT rotation lands it's a one-file change.
 */
import { useAppStore } from '@/store/useAppStore';

/**
 * Resolve the server base URL. In dev, Vite substitutes
 * `import.meta.env.VITE_FLAUDE_SERVER_URL` at build time from `.env.local`
 * or the shell; in prod it ends up baked into the Tauri bundle. We fall
 * back to localhost so `pnpm dev` on a fresh checkout just works.
 *
 * NOTE: do NOT default to 127.0.0.1. Tauri/WKWebView sometimes resolve
 * localhost to ::1 first and wrangler only binds IPv4 — the bare string
 * "localhost" goes through a faster resolution path on Windows.
 */
export function getServerUrl(): string {
  const env = (import.meta.env.VITE_FLAUDE_SERVER_URL as string | undefined)?.trim();
  if (env) return env.replace(/\/+$/, '');
  return 'http://127.0.0.1:8787';
}

export interface LoginResponse {
  token: string;
  user: {
    id: number;
    email: string;
    display_name: string;
    role: 'admin' | 'user';
  };
}

export interface UsageSnapshot {
  used_tokens: number;
  quota_tokens: number;
  period_start: number;
  period_end: number;
}

/**
 * Error shape bubbled up from non-2xx server responses. Callers can branch
 * on `.status` for e.g. 401 (clear auth) vs 402 (quota) vs 5xx (retry).
 */
export class FlaudeApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'FlaudeApiError';
    this.status = status;
    this.body = body;
  }
}

// -----------------------------------------------------------------------------
// Auth endpoints (no Bearer required; these mint the token)
// -----------------------------------------------------------------------------

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${getServerUrl()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    throw new FlaudeApiError(
      res.status,
      (body as { error?: string } | null)?.error ?? '登录失败',
      body,
    );
  }
  return body as LoginResponse;
}

/**
 * Server-side logout is a no-op today (stateless JWTs), but we still call it
 * so that (a) the client has one code path for "I'm done" and (b) if we add
 * a token blacklist later it plugs in without a client change.
 *
 * We fire-and-forget — if the server is down, we still clear local auth.
 */
export async function logout(token: string): Promise<void> {
  try {
    await fetch(`${getServerUrl()}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // ignore — we're logging out regardless
  }
}

// -----------------------------------------------------------------------------
// Authenticated fetch wrapper
// -----------------------------------------------------------------------------

/**
 * Thin fetch wrapper that:
 *   1. Prepends the server base URL.
 *   2. Injects `Authorization: Bearer <token>` from the store.
 *   3. On 401/403, clears auth so App.tsx drops to LoginView.
 *
 * Returns the raw Response — callers decide how to parse (JSON, stream, etc).
 * That way chat streaming can grab the body's ReadableStream without us
 * pre-buffering JSON.
 */
export async function authFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = useAppStore.getState().auth?.token;
  if (!token) {
    throw new FlaudeApiError(401, '未登录');
  }

  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${getServerUrl()}${path}`, { ...init, headers });

  // Token invalidated server-side (user deleted, disabled, secret rotated,
  // or expired). Kick out — App.tsx will render LoginView on next tick.
  if (res.status === 401 || res.status === 403) {
    // Only force logout on 401/invalid-token reasons. Admin-disabled (403)
    // also clears auth because the user can't do anything anyway.
    const body = await res.clone().json().catch(() => null);
    const reason = (body as { error?: string } | null)?.error ?? '';
    // Avoid clearing auth on spurious /auth/me calls during login flow —
    // but since authFetch only runs AFTER login, this is moot. Clear.
    useAppStore.getState().clearAuth();
    throw new FlaudeApiError(res.status, reason || '会话已失效，请重新登录', body);
  }

  return res;
}

/**
 * Convenience helpers for JSON endpoints. Use `authFetch` directly when you
 * need the raw Response (e.g. for streaming).
 */
export async function authGetJson<T>(path: string): Promise<T> {
  const res = await authFetch(path);
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    throw new FlaudeApiError(
      res.status,
      (body as { error?: string } | null)?.error ?? `请求失败 HTTP ${res.status}`,
      body,
    );
  }
  return body as T;
}

export async function authPostJson<T>(path: string, payload: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const body = await parseJsonSafe(res);
  if (!res.ok) {
    throw new FlaudeApiError(
      res.status,
      (body as { error?: string } | null)?.error ?? `请求失败 HTTP ${res.status}`,
      body,
    );
  }
  return body as T;
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Typed convenience wrappers
// -----------------------------------------------------------------------------

export function fetchUsage(): Promise<UsageSnapshot> {
  return authGetJson<UsageSnapshot>('/usage');
}

export interface WebSearchResult {
  name: string;
  url: string;
  snippet: string;
  summary: string;
  site_name: string;
  date_last_crawled: string;
}

export interface WebSearchResponse {
  query: string;
  count: number;
  freshness: string;
  results: WebSearchResult[];
}

export function webSearch(args: {
  query: string;
  count?: number;
  freshness?: 'day' | 'week' | 'month' | 'year';
}): Promise<WebSearchResponse> {
  return authPostJson<WebSearchResponse>('/tools/web_search', args);
}

// -----------------------------------------------------------------------------
// Admin endpoints (Phase 5). All gated server-side by requireAdmin; a non-admin
// token gets a 403 and authFetch will clear auth only on 401 — 403 here means
// "you're logged in but not admin", which for us is a UX bug, not a security
// event (AdminView shouldn't be reachable for non-admins).
// -----------------------------------------------------------------------------

export interface AdminUser {
  id: number;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  disabled: number;
  monthly_quota_tokens: number | null;
  created_at: number;
  used_tokens: number;
}

export interface AdminUsersResponse {
  users: AdminUser[];
  period_start: number;
  env_default_quota: number;
}

export function adminListUsers(): Promise<AdminUsersResponse> {
  return authGetJson<AdminUsersResponse>('/admin/users');
}

export function adminCreateUser(args: {
  email: string;
  password: string;
  display_name?: string;
  role?: 'admin' | 'user';
  monthly_quota_tokens?: number | null;
}): Promise<{ user: AdminUser }> {
  return authPostJson<{ user: AdminUser }>('/admin/users', args);
}

/**
 * PATCH /admin/users/:id. Send only the fields you want to change. Pass
 * `monthly_quota_tokens: null` to explicitly clear the override and fall
 * back to the server env default.
 */
export async function adminUpdateUser(
  id: number,
  patch: {
    disabled?: boolean;
    role?: 'admin' | 'user';
    display_name?: string;
    monthly_quota_tokens?: number | null;
  },
): Promise<{ user: AdminUser }> {
  const res = await authFetch(`/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new FlaudeApiError(
      res.status,
      (body as { error?: string } | null)?.error ?? `请求失败 HTTP ${res.status}`,
      body,
    );
  }
  return body as { user: AdminUser };
}

export function adminResetPassword(id: number, password: string): Promise<{ ok: true }> {
  return authPostJson<{ ok: true }>(`/admin/users/${id}/password`, { password });
}

// -----------------------------------------------------------------------------
// Sync endpoints (Phase 3 — conversation history round-trip).
//
// The wire format is a subset of the client's Conversation/Message types:
//   - no transient UI fields (activeConversationId, composer state, etc.)
//   - no base64 attachment data — attachments keep name/size/mime only (see
//     partialize() in useAppStore for how the client already strips blobs
//     before they ever reach the wire).
// -----------------------------------------------------------------------------

/** Wire shape of a single message. Mirrors server/src/sync.ts. */
export interface SyncMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | string;
  content: string;
  reasoning?: string | null;
  /** Opaque JSON-able blob for attachments/toolCalls; client owns the schema. */
  metadata?: unknown;
  modelId?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  createdAt: number;
}

/** Wire shape of a single conversation (nested messages). */
export interface SyncConversation {
  id: string;
  title: string;
  mode: string;
  pinned: boolean;
  starred: boolean;
  modelId?: string | null;
  projectId?: string | null;
  summary?: string | null;
  summaryMessageCount?: number | null;
  summarizedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  /** Unix ms of soft-delete. NULL/undefined = live conversation. */
  deletedAt?: number | null;
  messages: SyncMessage[];
}

/**
 * Wire shape of a project. Mirrors server/src/sync.ts.
 *
 * `sources` is the ProjectSource[] array from the client's Project type,
 * passed through as opaque JSON — the server doesn't validate the element
 * shape (see sources_json in schema.sql).
 */
export interface SyncProject {
  id: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  sources?: unknown;
  createdAt: number;
  updatedAt: number;
  /** Unix ms of soft-delete. NULL/undefined = live project. */
  deletedAt?: number | null;
}

export interface SyncPullResponse {
  conversations: SyncConversation[];
  /** Added in Phase 3.1. Older servers may omit this — treat as empty. */
  projects?: SyncProject[];
  /** Pass this as `since` on the next pull. Ms. */
  server_time: number;
}

export interface SyncPushResponse {
  /** Server's ms timestamp when the push was accepted. */
  accepted_at: number;
}

export function syncPull(since: number): Promise<SyncPullResponse> {
  // since=0 is the first-run path (returns everything the user has).
  return authGetJson<SyncPullResponse>(`/sync/pull?since=${since}`);
}

export function syncPush(args: {
  upserts: SyncConversation[];
  deletions: string[];
  /** New in Phase 3.1. Server ignores these if it predates the migration. */
  projectUpserts?: SyncProject[];
  projectDeletions?: string[];
}): Promise<SyncPushResponse> {
  return authPostJson<SyncPushResponse>('/sync/push', args);
}
