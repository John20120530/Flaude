//! Background (persistent) shell commands for the Code agent.
//!
//! Unlike `shell_exec` — which spawns a child, waits for it, and returns the
//! full stdout/stderr blob — `shell_start` spawns a process and returns an id
//! immediately. The agent then calls `shell_read` to drain buffered output,
//! `shell_write` to send stdin, and `shell_kill` to stop it.
//!
//! This is the `Bash(run_in_background=true)` + `BashOutput` pair from Claude
//! Code: real agents need to run `npm run dev`, tail logs, poke a REPL, etc.
//! `shell_exec` can't do that without timing out the moment the command stops
//! exiting on its own.
//!
//! Scope (why we don't just reuse `pty.rs`):
//!   - `pty.rs` is for the xterm.js terminal panel. It emits every byte as
//!     Tauri events, which is what xterm wants but not what an LLM wants.
//!   - The agent polls on demand (`shell_read`), so a pipe + buffer is simpler
//!     and uses less IPC bandwidth.
//!   - No TUI / escape-sequence / resize concerns here — the agent doesn't
//!     care about colors, and feeding xterm-256color noise back into the
//!     model just wastes tokens.
//!
//! Lifecycle:
//!   1. `shell_start` spawns a `tokio::process::Command` with piped stdin/
//!      stdout/stderr. Separate tokio tasks drain stdout/stderr into
//!      per-channel buffers. A reap task awaits `child.wait()` OR a kill
//!      signal, updates the status when the process exits.
//!   2. `shell_read` snapshots + clears the buffers and reports running/exited.
//!      With `wait_ms > 0`, it waits on a Notify until new output arrives or
//!      the status changes — lets the agent block briefly without spin-polling.
//!   3. `shell_write` pushes bytes to stdin.
//!   4. `shell_kill` fires the kill channel; the reap task signals the child
//!      and waits for actual exit. Handle stays in the map (status = exited)
//!      so one final `shell_read` can still drain trailing output.
//!   5. `shell_list` reports all handles — running or dead — for the UI.
//!
//! Bounds:
//!   - Per-channel buffer is capped at 256 KB. When full, oldest bytes are
//!     dropped (ring-buffer-like). The agent can always `shell_read` faster
//!     than most commands produce output, so overflow is the pathological
//!     case (a runaway `cat /dev/urandom` kind of thing).
//!   - Max 8 concurrent background shells. Prevents a buggy prompt loop from
//!     spawning hundreds of processes.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, Notify};

static BG_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Cap on in-memory stdout/stderr buffer per channel, per shell. 256 KB is
/// plenty for any reasonable command output; beyond that the model has no
/// chance of making sense of it anyway. When full we drop the oldest half.
const BUF_CAP_BYTES: usize = 256 * 1024;

/// Max concurrent background shells. Trips the obvious "agent loop spawns
/// hundreds" failure mode. Raise if a real use case needs more.
const MAX_CONCURRENT: usize = 8;

/// A process either still running or terminated (naturally or killed).
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum BgStatus {
    Running,
    Exited { code: i32, killed: bool },
}

impl BgStatus {
    fn is_running(&self) -> bool {
        matches!(self, BgStatus::Running)
    }
}

struct BgHandle {
    command: String,
    args: Vec<String>,
    started_ms: u64,
    stdout_buf: Arc<Mutex<Vec<u8>>>,
    stderr_buf: Arc<Mutex<Vec<u8>>>,
    /// Bytes dropped from the head because the buffer overflowed, per channel.
    /// Surfaced in `shell_read` so the model knows output was truncated.
    stdout_dropped: Arc<Mutex<u64>>,
    stderr_dropped: Arc<Mutex<u64>>,
    stdin: Arc<tokio::sync::Mutex<Option<ChildStdin>>>,
    status: Arc<Mutex<BgStatus>>,
    /// Fired when stdout/stderr get new bytes or status changes. Used by
    /// `shell_read(wait_ms)` to avoid spin-polling.
    notify: Arc<Notify>,
    /// One-shot(ish) kill signal. `shell_kill` sends; the reap task receives
    /// and calls `child.start_kill()`. mpsc over oneshot because we may want
    /// to coalesce multiple kill presses into idempotent behavior.
    kill_tx: mpsc::Sender<()>,
}

#[derive(Default)]
pub struct BgShellState {
    shells: Mutex<HashMap<String, Arc<BgHandle>>>,
}

#[derive(Serialize)]
pub struct ShellStartResult {
    id: String,
}

#[derive(Serialize)]
pub struct ShellReadResult {
    stdout: String,
    stderr: String,
    running: bool,
    /// Exit code once `running` is false. -1 if unknown (killed/signalled).
    code: Option<i32>,
    /// True if the process was killed by `shell_kill` rather than exiting on
    /// its own. Only meaningful when `running` is false.
    killed: bool,
    /// Bytes dropped from the head of the stdout buffer due to overflow, if any.
    stdout_dropped: u64,
    stderr_dropped: u64,
}

#[derive(Serialize)]
pub struct BgShellInfo {
    id: String,
    command: String,
    args: Vec<String>,
    started_ms: u64,
    running: bool,
    code: Option<i32>,
    killed: bool,
}

/// Canonicalise a cwd inside the workspace. Same scoping rule as fs_* / shell_exec.
fn resolve_cwd(workspace: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let ws = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|e| format!("无法解析工作区 {workspace:?}: {e}"))?;
    let Some(sub) = cwd else {
        return Ok(ws);
    };
    if sub.is_empty() {
        return Ok(ws);
    }
    let sub_path = std::path::Path::new(sub);
    let candidate = if sub_path.is_absolute() {
        sub_path.to_path_buf()
    } else {
        ws.join(sub_path)
    };
    let canon = candidate
        .canonicalize()
        .map_err(|e| format!("cwd 解析失败 {candidate:?}: {e}"))?;
    if !canon.starts_with(&ws) {
        return Err(format!(
            "cwd 超出工作区: {} (工作区: {})",
            canon.display(),
            ws.display()
        ));
    }
    if !canon.is_dir() {
        return Err(format!("cwd 不是目录: {}", canon.display()));
    }
    Ok(canon)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append bytes to a capped buffer; when it overflows, drop the oldest half.
/// Returns the number of bytes dropped during this append.
fn append_capped(buf: &mut Vec<u8>, incoming: &[u8]) -> u64 {
    if incoming.is_empty() {
        return 0;
    }
    let mut dropped = 0u64;
    // If the incoming alone exceeds the cap, keep only the tail.
    let effective: &[u8] = if incoming.len() >= BUF_CAP_BYTES {
        let cut = incoming.len() - BUF_CAP_BYTES / 2;
        dropped += (buf.len() + cut) as u64;
        buf.clear();
        &incoming[cut..]
    } else {
        incoming
    };
    let combined = buf.len() + effective.len();
    if combined > BUF_CAP_BYTES {
        let cut = combined - BUF_CAP_BYTES / 2;
        // Drop from the head of the existing buffer. `drain(..cut)` would
        // reallocate; for a 256KB buffer that's fine but `copy_within` is
        // marginally nicer. We take the simple approach.
        if cut >= buf.len() {
            dropped += buf.len() as u64;
            buf.clear();
            // Then also eat from the incoming tail if still over.
            let still_over = effective.len().saturating_sub(BUF_CAP_BYTES / 2);
            if still_over > 0 {
                dropped += still_over as u64;
                buf.extend_from_slice(&effective[still_over..]);
            } else {
                buf.extend_from_slice(effective);
            }
        } else {
            dropped += cut as u64;
            buf.drain(..cut);
            buf.extend_from_slice(effective);
        }
    } else {
        buf.extend_from_slice(effective);
    }
    dropped
}

#[tauri::command]
pub async fn shell_start(
    state: State<'_, BgShellState>,
    workspace: String,
    command: String,
    args: Option<Vec<String>>,
    cwd: Option<String>,
) -> Result<ShellStartResult, String> {
    // Enforce the concurrency cap. Count live (non-reaped) handles.
    {
        let map = state.shells.lock().unwrap();
        let running = map
            .values()
            .filter(|h| h.status.lock().unwrap().is_running())
            .count();
        if running >= MAX_CONCURRENT {
            return Err(format!(
                "已达到后台 shell 并发上限 ({MAX_CONCURRENT})，请先 shell_kill 一个再启动新的。"
            ));
        }
    }

    let args = args.unwrap_or_default();
    let cwd_path = resolve_cwd(&workspace, cwd.as_deref())?;

    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args)
        .current_dir(&cwd_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Don't leak a console window on Windows GUI apps. Matches `shell_exec`.
        ;
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // `kill_on_drop` is a defence-in-depth net: if the Tauri app exits mid-
    // session with live handles, tokio will SIGKILL every child we hold.
    // Without it, long-running commands would outlive the app window.
    cmd.kill_on_drop(true);

    let mut child: Child = cmd
        .spawn()
        .map_err(|e| format!("启动进程失败 ({command}): {e}"))?;

    // Take the pipes before we move `child` into the reap task.
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "子进程未提供 stdout 管道".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "子进程未提供 stderr 管道".to_string())?;

    let stdout_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stdout_dropped = Arc::new(Mutex::new(0u64));
    let stderr_dropped = Arc::new(Mutex::new(0u64));
    let status = Arc::new(Mutex::new(BgStatus::Running));
    let notify = Arc::new(Notify::new());

    // Drain stdout into buffer.
    {
        let buf = stdout_buf.clone();
        let dropped = stdout_dropped.clone();
        let notify = notify.clone();
        tokio::spawn(async move {
            let mut r = stdout;
            let mut chunk = [0u8; 4096];
            loop {
                match r.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let d = append_capped(&mut buf.lock().unwrap(), &chunk[..n]);
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

    // Drain stderr into buffer.
    {
        let buf = stderr_buf.clone();
        let dropped = stderr_dropped.clone();
        let notify = notify.clone();
        tokio::spawn(async move {
            let mut r = stderr;
            let mut chunk = [0u8; 4096];
            loop {
                match r.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let d = append_capped(&mut buf.lock().unwrap(), &chunk[..n]);
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

    // Reap task — waits for the child to exit, or a kill signal to come in.
    let (kill_tx, mut kill_rx) = mpsc::channel::<()>(4);
    {
        let status = status.clone();
        let notify = notify.clone();
        tokio::spawn(async move {
            tokio::select! {
                res = child.wait() => {
                    let code = res.ok().and_then(|s| s.code()).unwrap_or(-1);
                    *status.lock().unwrap() = BgStatus::Exited { code, killed: false };
                }
                _ = kill_rx.recv() => {
                    // start_kill is non-blocking; the process may take a moment
                    // to actually exit. Wait for that so the reported exit
                    // code is real, not a placeholder.
                    let _ = child.start_kill();
                    let res = child.wait().await;
                    let code = res.ok().and_then(|s| s.code()).unwrap_or(-1);
                    *status.lock().unwrap() = BgStatus::Exited { code, killed: true };
                }
            }
            notify.notify_waiters();
        });
    }

    let id = format!("bg-{}", BG_COUNTER.fetch_add(1, Ordering::SeqCst));
    let handle = Arc::new(BgHandle {
        command: command.clone(),
        args,
        started_ms: now_ms(),
        stdout_buf,
        stderr_buf,
        stdout_dropped,
        stderr_dropped,
        stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
        status,
        notify,
        kill_tx,
    });
    state.shells.lock().unwrap().insert(id.clone(), handle);
    Ok(ShellStartResult { id })
}

#[tauri::command]
pub async fn shell_read(
    state: State<'_, BgShellState>,
    id: String,
    wait_ms: Option<u64>,
) -> Result<ShellReadResult, String> {
    // Look up the handle (cloned Arc so we release the outer map lock before
    // awaiting the notify — otherwise concurrent commands block).
    let handle = {
        let map = state.shells.lock().unwrap();
        map.get(&id)
            .cloned()
            .ok_or_else(|| format!("未知后台 shell: {id}"))?
    };

    // Fast path: drain what's buffered right now.
    let drain = |h: &BgHandle| -> (String, String, u64, u64, BgStatus) {
        let mut out = h.stdout_buf.lock().unwrap();
        let mut err = h.stderr_buf.lock().unwrap();
        let stdout = String::from_utf8_lossy(&out).into_owned();
        let stderr = String::from_utf8_lossy(&err).into_owned();
        out.clear();
        err.clear();
        let mut od = h.stdout_dropped.lock().unwrap();
        let mut ed = h.stderr_dropped.lock().unwrap();
        let od_v = *od;
        let ed_v = *ed;
        *od = 0;
        *ed = 0;
        let st = h.status.lock().unwrap().clone();
        (stdout, stderr, od_v, ed_v, st)
    };

    let (mut stdout, mut stderr, mut od, mut ed, mut st) = drain(&handle);

    // If nothing to report and the caller is willing to wait, block on the
    // notify with a bounded timeout. One wake is enough — we drain again and
    // return whatever's there (even if still empty, caller can re-poll).
    let should_wait = wait_ms.unwrap_or(0) > 0
        && stdout.is_empty()
        && stderr.is_empty()
        && od == 0
        && ed == 0
        && st.is_running();
    if should_wait {
        let wait = tokio::time::Duration::from_millis(wait_ms.unwrap());
        let _ = tokio::time::timeout(wait, handle.notify.notified()).await;
        let (s2, e2, od2, ed2, st2) = drain(&handle);
        stdout = s2;
        stderr = e2;
        od = od2;
        ed = ed2;
        st = st2;
    }

    let (running, code, killed) = match st {
        BgStatus::Running => (true, None, false),
        BgStatus::Exited { code, killed } => (false, Some(code), killed),
    };

    Ok(ShellReadResult {
        stdout,
        stderr,
        running,
        code,
        killed,
        stdout_dropped: od,
        stderr_dropped: ed,
    })
}

#[tauri::command]
pub async fn shell_write(
    state: State<'_, BgShellState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let handle = {
        let map = state.shells.lock().unwrap();
        map.get(&id)
            .cloned()
            .ok_or_else(|| format!("未知后台 shell: {id}"))?
    };
    if !handle.status.lock().unwrap().is_running() {
        return Err(format!("后台 shell 已退出: {id}"));
    }
    let mut stdin_guard = handle.stdin.lock().await;
    let stdin = stdin_guard
        .as_mut()
        .ok_or_else(|| "stdin 不可用（可能已关闭）".to_string())?;
    stdin
        .write_all(data.as_bytes())
        .await
        .map_err(|e| format!("写入 stdin 失败: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("flush stdin 失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn shell_kill(state: State<'_, BgShellState>, id: String) -> Result<(), String> {
    let handle = {
        let map = state.shells.lock().unwrap();
        map.get(&id)
            .cloned()
            .ok_or_else(|| format!("未知后台 shell: {id}"))?
    };
    // Send kill signal. If the channel is closed (reap task already exited),
    // that means the process has already terminated — not an error.
    let _ = handle.kill_tx.send(()).await;
    Ok(())
}

#[tauri::command]
pub fn shell_list(state: State<'_, BgShellState>) -> Result<Vec<BgShellInfo>, String> {
    let map = state.shells.lock().unwrap();
    let mut out: Vec<BgShellInfo> = map
        .iter()
        .map(|(id, h)| {
            let (running, code, killed) = match *h.status.lock().unwrap() {
                BgStatus::Running => (true, None, false),
                BgStatus::Exited { code, killed } => (false, Some(code), killed),
            };
            BgShellInfo {
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
    // Stable order for UI: newest first.
    out.sort_by(|a, b| b.started_ms.cmp(&a.started_ms));
    Ok(out)
}

/// Forget a handle. Frees memory for a shell whose output the agent is done
/// reading. If still running, we kill it first (defence in depth; the agent
/// should have called `shell_kill` explicitly).
#[tauri::command]
pub async fn shell_remove(state: State<'_, BgShellState>, id: String) -> Result<(), String> {
    let handle = {
        let mut map = state.shells.lock().unwrap();
        map.remove(&id)
    };
    if let Some(h) = handle {
        if h.status.lock().unwrap().is_running() {
            let _ = h.kill_tx.send(()).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_capped_noop_on_empty() {
        let mut buf = vec![];
        assert_eq!(append_capped(&mut buf, &[]), 0);
        assert!(buf.is_empty());
    }

    #[test]
    fn append_capped_small_under_cap() {
        let mut buf = vec![1, 2, 3];
        let dropped = append_capped(&mut buf, &[4, 5]);
        assert_eq!(dropped, 0);
        assert_eq!(buf, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn append_capped_drops_old_when_over_cap() {
        // Fill to cap, then append a chunk — should drop enough to fit.
        let mut buf = vec![0u8; BUF_CAP_BYTES];
        let dropped = append_capped(&mut buf, &[1, 2, 3]);
        assert!(dropped > 0);
        // After overflow the buffer is at most BUF_CAP_BYTES.
        assert!(buf.len() <= BUF_CAP_BYTES);
        // Tail should reflect the new bytes.
        assert_eq!(&buf[buf.len() - 3..], &[1, 2, 3]);
    }

    #[test]
    fn append_capped_drops_incoming_tail_when_incoming_alone_huge() {
        let mut buf = vec![];
        let huge = vec![9u8; BUF_CAP_BYTES * 2];
        let dropped = append_capped(&mut buf, &huge);
        assert!(dropped >= (BUF_CAP_BYTES) as u64);
        assert!(buf.len() <= BUF_CAP_BYTES);
    }
}
