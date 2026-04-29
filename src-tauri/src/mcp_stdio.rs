//! Stdio Model Context Protocol (MCP) servers.
//!
//! The HTTP MCP transport is implemented entirely in TS (`src/lib/mcp.ts`)
//! because browsers can `fetch()` remote MCPs directly. Stdio MCPs — by far
//! the more common kind in the wild (`@modelcontextprotocol/server-*`) — need
//! a child process to talk to, which the browser sandbox forbids and the
//! Tauri host has to provide.
//!
//! This module is the host side. It spawns a child, pipes stdin/stdout, and
//! exposes:
//!
//!   - `mcp_stdio_spawn({command, args, env, cwd?})` → `{ id }`
//!   - `mcp_stdio_send({id, message})` — write `message\n` to child stdin
//!   - `mcp_stdio_recv({id, wait_ms})` → `{ messages, running, code? }` —
//!     drain whatever stdout JSON-RPC frames have arrived since the last call.
//!     If nothing pending and `wait_ms > 0`, block on a `Notify` so the TS
//!     side can long-poll without busy-spinning.
//!   - `mcp_stdio_kill({id})`
//!   - `mcp_stdio_list()` — diagnostic / for the Settings UI
//!
//! Framing: **newline-delimited JSON** per the MCP stdio transport spec. We
//! split stdout on `\n` and queue each line as one complete message. (We do
//! NOT parse the JSON here — the TS side correlates by `id` already, no
//! reason to duplicate that.) Stderr is captured into a separate buffer for
//! diagnostics in the UI but never fed back as JSON-RPC.
//!
//! Lifecycle parallels `bgshell.rs`:
//!   - drain task per pipe
//!   - reap task that awaits `child.wait()` OR a kill signal
//!   - `kill_on_drop(true)` so an app crash takes its children with it
//!
//! Why a separate module instead of cribbing `bgshell`:
//!   - bgshell's read API returns raw byte blobs. MCP needs *messages* —
//!     i.e. the splitter has to live somewhere or every TS caller would have
//!     to duplicate it. Putting the splitter in Rust is cheaper.
//!   - bgshell's API surface is wrong shape for RPC: no per-server limits,
//!     no env var injection, and the MCP runner shouldn't compete with the
//!     agent's `shell_start` for the 8-process cap.
//!
//! Bounds:
//!   - 16 concurrent stdio MCPs (each is a long-lived dependency, lower limit
//!     than bgshell's transient commands).
//!   - 1024 pending messages per server. Beyond that, drop oldest and report
//!     `dropped_messages` in `recv`. A reasonable MCP doesn't generate
//!     unsolicited bursts; a hostile one shouldn't blow up host memory.
//!   - 256 KB stderr buffer. Same overflow rule as bgshell.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, Notify};

static MCP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Max concurrent stdio MCP servers. Each is a long-lived child kept open
/// for the whole session; users with many marketplace installs would hit
/// this. 16 is generous — typical setup is 1–3.
const MAX_CONCURRENT: usize = 16;

/// Per-server cap on queued JSON-RPC messages awaiting `recv`. A polite
/// server emits responses 1:1 with our requests, so the queue should rarely
/// hold more than a few items. Cap exists to defend against a server that
/// floods notifications.
const MAX_QUEUED_MESSAGES: usize = 1024;

/// Cap on stderr buffer (for diagnostics — never used as protocol input).
/// Same 256 KB as bgshell.
const STDERR_CAP_BYTES: usize = 256 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum McpStatus {
    Running,
    Exited { code: i32, killed: bool },
}

impl McpStatus {
    fn is_running(&self) -> bool {
        matches!(self, McpStatus::Running)
    }
}

struct McpHandle {
    command: String,
    args: Vec<String>,
    started_ms: u64,
    /// Newline-delimited JSON-RPC messages pending delivery to the TS side.
    out_queue: Arc<Mutex<VecDeque<String>>>,
    /// Number of messages dropped from the head of the queue due to overflow.
    /// Surfaced in `recv` so the TS side can log "MCP server flooded us".
    dropped_messages: Arc<Mutex<u64>>,
    /// Stderr captured for diagnostics. Never used as protocol input.
    stderr_buf: Arc<Mutex<Vec<u8>>>,
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    status: Arc<Mutex<McpStatus>>,
    /// Wakes any `recv(wait_ms > 0)` long-poll when new output / status change.
    notify: Arc<Notify>,
    kill_tx: mpsc::Sender<()>,
}

#[derive(Default)]
pub struct McpStdioState {
    servers: Mutex<HashMap<String, Arc<McpHandle>>>,
}

#[derive(Deserialize)]
pub struct SpawnArgs {
    pub command: String,
    pub args: Option<Vec<String>>,
    /// Environment variables. Inherits the parent env and overrides with
    /// these. Common use: `GITHUB_PERSONAL_ACCESS_TOKEN` for the GitHub MCP.
    pub env: Option<HashMap<String, String>>,
    /// Working directory. Optional — most stdio MCPs don't need a specific
    /// cwd. NOT scoped to a workspace because MCP servers are global tools,
    /// not files-in-workspace operators.
    pub cwd: Option<String>,
}

#[derive(Serialize)]
pub struct SpawnResult {
    id: String,
}

#[derive(Serialize)]
pub struct RecvResult {
    /// Complete JSON-RPC frames pending since the last `recv`. Each entry is
    /// the raw line as the server emitted it (no surrounding newlines).
    messages: Vec<String>,
    /// True if the child is still alive. After it exits, callers should
    /// `kill` to free the slot or just drop the handle.
    running: bool,
    /// Exit code once `running` is false.
    code: Option<i32>,
    /// True if the child was terminated via `kill` rather than self-exit.
    killed: bool,
    /// Messages dropped from the head of the queue due to overflow since
    /// last `recv`. Should be 0 in normal use.
    dropped_messages: u64,
    /// Stderr text captured since last `recv`. Diagnostic only — UIs
    /// surface this to the user but nothing parses it.
    stderr: String,
}

#[derive(Serialize)]
pub struct McpStdioInfo {
    id: String,
    command: String,
    args: Vec<String>,
    started_ms: u64,
    running: bool,
    code: Option<i32>,
    killed: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append bytes to the stderr buffer, dropping oldest on overflow.
fn append_stderr_capped(buf: &mut Vec<u8>, incoming: &[u8]) {
    if incoming.is_empty() {
        return;
    }
    let combined = buf.len() + incoming.len();
    if combined <= STDERR_CAP_BYTES {
        buf.extend_from_slice(incoming);
        return;
    }
    if incoming.len() >= STDERR_CAP_BYTES {
        // Incoming alone is larger than the cap — keep only its tail.
        let cut = incoming.len() - STDERR_CAP_BYTES / 2;
        buf.clear();
        buf.extend_from_slice(&incoming[cut..]);
        return;
    }
    let cut = combined - STDERR_CAP_BYTES / 2;
    if cut >= buf.len() {
        buf.clear();
    } else {
        buf.drain(..cut);
    }
    buf.extend_from_slice(incoming);
}

/// Push a freshly-parsed line into the queue with overflow protection.
/// Returns the number of older messages we had to drop to fit.
fn push_message_capped(q: &mut VecDeque<String>, msg: String) -> u64 {
    let mut dropped = 0;
    while q.len() >= MAX_QUEUED_MESSAGES {
        q.pop_front();
        dropped += 1;
    }
    q.push_back(msg);
    dropped
}

/// Should this MCP command be re-routed through `cmd.exe /c` on Windows?
///
/// Background: Rust's `std::process::Command` on Windows calls
/// `CreateProcessW`, which is **not** cmd.exe — it doesn't consult
/// `PATHEXT` to resolve `npx` → `npx.cmd`, and won't interpret `.cmd` /
/// `.bat` files at all (those are batch scripts, not native executables).
/// The first wave of v0.1.51's MCP work hit this: even with Node.js on
/// PATH, `Command::new("npx")` failed with "program not found" because
/// the kernel can't launch the bare-extensionless `npx` shim file.
///
/// Fix: detect node-ecosystem shim names + explicit `.cmd`/`.bat`/`.ps1`
/// paths and re-route them through `cmd.exe /c`, which does PATHEXT
/// resolution and runs batch files. Native `.exe` paths keep the direct
/// spawn path — wrapping every command in cmd.exe would inflict its
/// quoting rules on invocations that work fine today.
///
/// On non-Windows this always returns false (the .cmd/.bat extensions
/// don't exist as a category, and Unix has no PATHEXT confusion).
///
/// Exposed at module scope so the unit tests below can pin its behavior
/// without spawning processes.
fn needs_cmd_wrapper(command: &str) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let lower = command.to_ascii_lowercase();
    // Strip any directory prefix so `C:\Program Files\nodejs\npx` matches
    // the bare `npx` shim list. We tolerate both backslash and forward
    // slash because Windows accepts either as a separator and users
    // sometimes paste in Unix-style paths.
    let stripped = lower
        .rsplit_once('\\')
        .map(|(_, t)| t)
        .unwrap_or(&lower);
    let stripped = stripped.rsplit_once('/').map(|(_, t)| t).unwrap_or(stripped);

    // Node-ecosystem and Python-via-uv shim names. Generous because the
    // cost of being wrong (cmd.exe wraps a native .exe by mistake) is
    // ~10 ms of cmd.exe startup overhead, vs. the cost of being too
    // narrow (a popular MCP fails to spawn with a confusing error).
    if matches!(
        stripped,
        "npx"
            | "npm"
            | "node"
            | "pnpm"
            | "yarn"
            | "uvx"
            | "uv"
            | "deno"
            | "bun"
    ) {
        return true;
    }
    // Explicit .cmd / .bat paths must go through cmd.exe regardless.
    // .ps1 too, since CreateProcessW won't run PowerShell scripts either.
    stripped.ends_with(".cmd") || stripped.ends_with(".bat") || stripped.ends_with(".ps1")
}

#[tauri::command]
pub async fn mcp_stdio_spawn(
    state: State<'_, McpStdioState>,
    args: SpawnArgs,
) -> Result<SpawnResult, String> {
    // Concurrency cap.
    {
        let map = state.servers.lock().unwrap();
        let live = map
            .values()
            .filter(|h| h.status.lock().unwrap().is_running())
            .count();
        if live >= MAX_CONCURRENT {
            return Err(format!(
                "已达到 stdio MCP 服务器并发上限 ({MAX_CONCURRENT})。请先停掉一个再装新的。"
            ));
        }
    }

    let cmd_name = args.command.clone();
    let cmd_args = args.args.clone().unwrap_or_default();

    // Windows .cmd / .bat shim handling (v0.1.54). See `needs_cmd_wrapper`
    // below for the full backstory; tl;dr Rust's `Command::new("npx")` on
    // Windows refuses to launch `npx.cmd` (CreateProcessW doesn't do
    // PATHEXT resolution and won't interpret batch files), so we re-route
    // shim names + .cmd/.bat through `cmd.exe /c`.
    let needs_cmd_wrapper_flag = needs_cmd_wrapper(&args.command);

    let mut cmd = if needs_cmd_wrapper_flag {
        // `cmd /c <name> <args...>` — cmd.exe re-resolves the shim name
        // via PATHEXT (so `npx` → `npx.cmd`) and interprets it. We pass
        // the original args verbatim; cmd.exe's quoting rules apply, but
        // every MCP we ship today either takes flag args (`-y
        // @scope/pkg`) or absolute paths, neither of which trip cmd
        // quoting up. If a future MCP needs literal special-char args
        // we'd switch to a Powershell wrapper, but we haven't seen that.
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/c").arg(&args.command);
        for a in &cmd_args {
            c.arg(a);
        }
        c
    } else {
        let mut c = tokio::process::Command::new(&args.command);
        c.args(&cmd_args);
        c
    };
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(cwd) = &args.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &args.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.kill_on_drop(true);

    let mut child: Child = cmd
        .spawn()
        .map_err(|e| format!("启动 MCP 进程失败 ({}): {e}", args.command))?;

    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "MCP 子进程未提供 stdout 管道".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "MCP 子进程未提供 stderr 管道".to_string())?;

    let out_queue = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let dropped_messages = Arc::new(Mutex::new(0u64));
    let stderr_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let status = Arc::new(Mutex::new(McpStatus::Running));
    let notify = Arc::new(Notify::new());

    // Drain stdout line-by-line. Each `\n`-terminated line is one complete
    // JSON-RPC frame per the MCP stdio transport spec. We do NOT parse the
    // JSON — that's the TS side's job and skipping it here keeps the host
    // path zero-allocation-after-spawn aside from the line itself.
    {
        let queue = out_queue.clone();
        let dropped = dropped_messages.clone();
        let notify = notify.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        // Strip the trailing newline; keep CR if present
                        // because some servers might emit CRLF on Windows.
                        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
                        if trimmed.is_empty() {
                            // MCP servers shouldn't emit blank lines, but
                            // tolerate it — skip rather than enqueue.
                            continue;
                        }
                        let d = push_message_capped(
                            &mut queue.lock().unwrap(),
                            trimmed.to_string(),
                        );
                        if d > 0 {
                            *dropped.lock().unwrap() += d;
                        }
                        notify.notify_waiters();
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Drain stderr into a byte buffer. Diagnostic only.
    {
        let buf = stderr_buf.clone();
        let notify = notify.clone();
        tokio::spawn(async move {
            let mut r = stderr;
            let mut chunk = [0u8; 4096];
            loop {
                match r.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => {
                        append_stderr_capped(&mut buf.lock().unwrap(), &chunk[..n]);
                        notify.notify_waiters();
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Reap task — same shape as bgshell.
    let (kill_tx, mut kill_rx) = mpsc::channel::<()>(4);
    {
        let status = status.clone();
        let notify = notify.clone();
        tokio::spawn(async move {
            tokio::select! {
                res = child.wait() => {
                    let code = res.ok().and_then(|s| s.code()).unwrap_or(-1);
                    *status.lock().unwrap() = McpStatus::Exited { code, killed: false };
                }
                _ = kill_rx.recv() => {
                    let _ = child.start_kill();
                    let res = child.wait().await;
                    let code = res.ok().and_then(|s| s.code()).unwrap_or(-1);
                    *status.lock().unwrap() = McpStatus::Exited { code, killed: true };
                }
            }
            notify.notify_waiters();
        });
    }

    let id = format!("mcp-{}", MCP_COUNTER.fetch_add(1, Ordering::SeqCst));
    let handle = Arc::new(McpHandle {
        command: cmd_name,
        args: cmd_args,
        started_ms: now_ms(),
        out_queue,
        dropped_messages,
        stderr_buf,
        stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
        status,
        notify,
        kill_tx,
    });
    state.servers.lock().unwrap().insert(id.clone(), handle);
    Ok(SpawnResult { id })
}

#[tauri::command]
pub async fn mcp_stdio_send(
    state: State<'_, McpStdioState>,
    id: String,
    message: String,
) -> Result<(), String> {
    let handle = {
        let map = state.servers.lock().unwrap();
        map.get(&id)
            .cloned()
            .ok_or_else(|| format!("未知 stdio MCP: {id}"))?
    };
    if !handle.status.lock().unwrap().is_running() {
        return Err(format!("MCP 进程已退出: {id}"));
    }
    let mut stdin_guard = handle.stdin.lock().await;
    let stdin = stdin_guard
        .as_mut()
        .ok_or_else(|| "MCP stdin 不可用（可能已关闭）".to_string())?;

    // Per spec, each frame is one line — append a newline if not present.
    // We tolerate either form on the caller side; the wire MUST end with \n.
    let mut payload = message;
    if !payload.ends_with('\n') {
        payload.push('\n');
    }
    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("写入 MCP stdin 失败: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("flush MCP stdin 失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn mcp_stdio_recv(
    state: State<'_, McpStdioState>,
    id: String,
    wait_ms: Option<u64>,
) -> Result<RecvResult, String> {
    let handle = {
        let map = state.servers.lock().unwrap();
        map.get(&id)
            .cloned()
            .ok_or_else(|| format!("未知 stdio MCP: {id}"))?
    };

    let drain = |h: &McpHandle| -> (Vec<String>, u64, String, McpStatus) {
        let mut q = h.out_queue.lock().unwrap();
        let messages: Vec<String> = q.drain(..).collect();
        let mut dm = h.dropped_messages.lock().unwrap();
        let dropped = *dm;
        *dm = 0;
        let mut eb = h.stderr_buf.lock().unwrap();
        let stderr = String::from_utf8_lossy(&eb).into_owned();
        eb.clear();
        let st = h.status.lock().unwrap().clone();
        (messages, dropped, stderr, st)
    };

    let (mut messages, mut dropped, mut stderr_str, mut st) = drain(&handle);

    let should_wait = wait_ms.unwrap_or(0) > 0
        && messages.is_empty()
        && dropped == 0
        && stderr_str.is_empty()
        && st.is_running();
    if should_wait {
        let wait = tokio::time::Duration::from_millis(wait_ms.unwrap());
        let _ = tokio::time::timeout(wait, handle.notify.notified()).await;
        let (m2, d2, e2, s2) = drain(&handle);
        messages = m2;
        dropped = d2;
        stderr_str = e2;
        st = s2;
    }

    let (running, code, killed) = match st {
        McpStatus::Running => (true, None, false),
        McpStatus::Exited { code, killed } => (false, Some(code), killed),
    };

    Ok(RecvResult {
        messages,
        running,
        code,
        killed,
        dropped_messages: dropped,
        stderr: stderr_str,
    })
}

#[tauri::command]
pub async fn mcp_stdio_kill(state: State<'_, McpStdioState>, id: String) -> Result<(), String> {
    // Pop the handle out of the map *and* signal kill. Holding the slot
    // forever would slowly leak memory if the user installs/uninstalls the
    // same MCP many times.
    let handle = {
        let mut map = state.servers.lock().unwrap();
        map.remove(&id)
    };
    if let Some(h) = handle {
        let _ = h.kill_tx.send(()).await;
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_stdio_list(state: State<'_, McpStdioState>) -> Result<Vec<McpStdioInfo>, String> {
    let map = state.servers.lock().unwrap();
    let mut out: Vec<McpStdioInfo> = map
        .iter()
        .map(|(id, h)| {
            let (running, code, killed) = match *h.status.lock().unwrap() {
                McpStatus::Running => (true, None, false),
                McpStatus::Exited { code, killed } => (false, Some(code), killed),
            };
            McpStdioInfo {
                id: id.clone(),
                command: h.command.clone(),
                args: h.args.clone(),
                started_ms: h.started_ms,
                running,
                code,
                killed,
            }
        })
        .collect();
    out.sort_by(|a, b| b.started_ms.cmp(&a.started_ms));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_message_capped_under_limit() {
        let mut q = VecDeque::new();
        let dropped = push_message_capped(&mut q, "hello".to_string());
        assert_eq!(dropped, 0);
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn push_message_capped_drops_oldest_on_overflow() {
        let mut q = VecDeque::new();
        for i in 0..MAX_QUEUED_MESSAGES {
            q.push_back(format!("msg-{i}"));
        }
        let dropped = push_message_capped(&mut q, "newest".to_string());
        assert_eq!(dropped, 1);
        assert_eq!(q.len(), MAX_QUEUED_MESSAGES);
        // Front should now be msg-1 (msg-0 evicted).
        assert_eq!(q.front().map(String::as_str), Some("msg-1"));
        assert_eq!(q.back().map(String::as_str), Some("newest"));
    }

    #[test]
    fn append_stderr_capped_under_cap() {
        let mut buf = vec![1, 2, 3];
        append_stderr_capped(&mut buf, &[4, 5]);
        assert_eq!(buf, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn append_stderr_capped_drops_old_on_overflow() {
        let mut buf = vec![0u8; STDERR_CAP_BYTES];
        append_stderr_capped(&mut buf, &[1, 2, 3]);
        assert!(buf.len() <= STDERR_CAP_BYTES);
        assert_eq!(&buf[buf.len() - 3..], &[1, 2, 3]);
    }

    // The needs_cmd_wrapper tests are gated to Windows because the function
    // unconditionally returns false on other targets (Unix has no PATHEXT
    // confusion + doesn't recognise .cmd/.bat as a category). On Windows
    // they pin the v0.1.54 fix that re-routed `npx` and friends through
    // cmd.exe so MCPs spawned via Node.js shims actually launch.
    #[cfg(windows)]
    #[test]
    fn needs_cmd_wrapper_recognises_node_shims() {
        assert!(needs_cmd_wrapper("npx"));
        assert!(needs_cmd_wrapper("npm"));
        assert!(needs_cmd_wrapper("node"));
        assert!(needs_cmd_wrapper("pnpm"));
        assert!(needs_cmd_wrapper("yarn"));
        assert!(needs_cmd_wrapper("deno"));
        assert!(needs_cmd_wrapper("bun"));
    }

    #[cfg(windows)]
    #[test]
    fn needs_cmd_wrapper_recognises_uv_shims() {
        assert!(needs_cmd_wrapper("uvx"));
        assert!(needs_cmd_wrapper("uv"));
    }

    #[cfg(windows)]
    #[test]
    fn needs_cmd_wrapper_strips_directory_prefix() {
        // Users sometimes paste in the absolute path winget recorded.
        // Both directory separators must be tolerated.
        assert!(needs_cmd_wrapper("C:\\Program Files\\nodejs\\npx"));
        assert!(needs_cmd_wrapper("C:/Program Files/nodejs/npx"));
        assert!(needs_cmd_wrapper(
            "C:\\Users\\qfu\\AppData\\Roaming\\npm\\npx.cmd"
        ));
    }

    #[cfg(windows)]
    #[test]
    fn needs_cmd_wrapper_recognises_explicit_cmd_bat_ps1() {
        assert!(needs_cmd_wrapper("foo.cmd"));
        assert!(needs_cmd_wrapper("foo.bat"));
        assert!(needs_cmd_wrapper("foo.ps1"));
        assert!(needs_cmd_wrapper("FOO.CMD")); // case-insensitive
    }

    #[cfg(windows)]
    #[test]
    fn needs_cmd_wrapper_passes_through_native_exes() {
        // .exe paths are launchable by CreateProcessW directly; wrapping
        // them in cmd.exe would just slow them down + invite quoting bugs.
        assert!(!needs_cmd_wrapper("python.exe"));
        assert!(!needs_cmd_wrapper("C:\\Windows\\System32\\cmd.exe"));
        assert!(!needs_cmd_wrapper("git"));
        assert!(!needs_cmd_wrapper("rust-analyzer"));
        assert!(!needs_cmd_wrapper(""));
    }

    #[cfg(not(windows))]
    #[test]
    fn needs_cmd_wrapper_is_always_false_on_unix() {
        // No PATHEXT + no batch files; Unix kernels execute shebangs
        // directly. The Windows fix should never alter behavior here.
        assert!(!needs_cmd_wrapper("npx"));
        assert!(!needs_cmd_wrapper("foo.cmd"));
        assert!(!needs_cmd_wrapper("/usr/local/bin/uvx"));
    }
}
