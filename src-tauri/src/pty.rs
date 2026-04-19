//! Interactive PTY (pseudo-terminal) commands.
//!
//! A PTY is the "real shell in a window" — unlike `shell_exec` (which runs a
//! single command and returns output as a blob), a PTY lets the user type
//! interactively, see prompts update live, run full-screen apps (vim, less,
//! htop), and get proper color / escape-sequence rendering.
//!
//! Lifecycle:
//!   1. Frontend calls `pty_create` with optional workspace/shell/size and
//!      gets back an opaque id.
//!   2. A background thread reads bytes from the PTY master and emits them as
//!      Tauri events on `pty:data:{id}`. The frontend's xterm.js instance
//!      listens and calls `.write()` for each chunk.
//!   3. Frontend calls `pty_write` (user keystrokes → PTY), `pty_resize`
//!      (window size changed → adjust the TTY window so line-wrap is right),
//!      and finally `pty_kill` when the component unmounts.
//!   4. When the child exits naturally, the reader loop sees EOF and emits
//!      `pty:exit:{id}` so the frontend can print a marker line.
//!
//! Security / scope:
//!   This is a real shell with whatever permissions the parent process has.
//!   No sandboxing is attempted — the user is literally asking for a terminal
//!   in their project workspace. Workspace path is passed as CWD only; we do
//!   not constrain what the shell can access.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

static PTY_COUNTER: AtomicU64 = AtomicU64::new(1);

/// One live PTY we're hosting. The master end stays here (we need it to
/// resize); the writer half is pulled out so we can write to the child's
/// stdin from command handlers. The child handle lets us kill on cleanup.
struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Tauri-managed state: map of id → live PTY. Wrapped in a Mutex because
/// Tauri commands can be called from arbitrary threads.
#[derive(Default)]
pub struct PtyState {
    ptys: Mutex<HashMap<String, PtyHandle>>,
}

/// Platform default shell. We want something that actually exists out of the
/// box on a fresh install:
///   - Windows: powershell.exe ships with every Win10+ install. pwsh (7+) is
///     nicer but isn't guaranteed.
///   - macOS / Linux: $SHELL if set, else /bin/bash (always present on Linux;
///     on macOS it's bash 3.2 which is ancient but works).
fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[tauri::command]
pub async fn pty_create(
    app: AppHandle,
    state: State<'_, PtyState>,
    workspace: Option<String>,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    // Monotonic ids — cheaper than UUID and the event channel names stay
    // short. Collision is impossible within one app run.
    let id = format!("pty-{}", PTY_COUNTER.fetch_add(1, Ordering::SeqCst));

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty 失败: {e}"))?;

    let shell_cmd = shell.unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell_cmd);
    if let Some(ws) = workspace.as_deref() {
        if !ws.is_empty() {
            cmd.cwd(ws);
        }
    }
    // xterm.js supports 256-color; advertising that lets most modern shells
    // and CLI tools emit richer palettes. `convertEol: true` on the frontend
    // handles \n → \r\n if needed.
    cmd.env("TERM", "xterm-256color");
    // Harmless breadcrumb a user's shell init can check, e.g. to suppress
    // noisy MOTD or adjust prompt width.
    cmd.env("FLAUDE_PTY", "1");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 shell 失败 ({shell_cmd}): {e}"))?;
    // Drop the slave — the child now owns its end. Keeping it alive would
    // prevent us from ever seeing EOF when the child exits.
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("获取 writer 失败: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader 失败: {e}"))?;

    // Background reader thread — blocking reads are fine here, we're isolated
    // from Tauri's async runtime. Bytes → UTF-8 lossy (terminal output is
    // line-ish enough that split multi-byte sequences are rare; if we cared
    // we'd maintain a carry buffer, but the replacement-char tradeoff is
    // acceptable for MVP).
    let app_clone = app.clone();
    let id_clone = id.clone();
    std::thread::spawn(move || {
        let data_channel = format!("pty:data:{id_clone}");
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // child closed its stdout
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    // If the frontend is gone (window closed mid-stream), emit
                    // returns Err; break out rather than spin forever.
                    if app_clone.emit(&data_channel, chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit(&format!("pty:exit:{id_clone}"), ());
    });

    state.ptys.lock().unwrap().insert(
        id.clone(),
        PtyHandle {
            writer,
            master: pair.master,
            child,
        },
    );

    Ok(id)
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    let handle = map
        .get_mut(&id)
        .ok_or_else(|| format!("未知 pty: {id}"))?;
    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("写入失败: {e}"))?;
    handle
        .writer
        .flush()
        .map_err(|e| format!("flush 失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.ptys.lock().unwrap();
    let handle = map.get(&id).ok_or_else(|| format!("未知 pty: {id}"))?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize 失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    if let Some(mut handle) = map.remove(&id) {
        // Best-effort: signal the child. On Windows this maps to TerminateProcess,
        // on Unix to SIGKILL. We don't propagate the error — the handle is being
        // dropped anyway, and the reader thread will exit on its own when the
        // master side goes away.
        let _ = handle.child.kill();
    }
    Ok(())
}
