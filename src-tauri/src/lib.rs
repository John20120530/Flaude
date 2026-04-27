//! Flaude desktop backend.
//!
//! Exposes a small, deliberately narrow set of FS and shell commands to the
//! frontend. Every path-taking command takes an explicit `workspace` argument
//! and canonicalises both the target path and the workspace root before
//! comparing them — so a malicious/buggy prompt cannot `..`/symlink its way
//! out of the directory the user opened.
//!
//! Design notes:
//!   - `workspace` comes from frontend state (the user picks a folder once
//!     via the dialog plugin). We accept it on every call to keep the Rust
//!     side stateless.
//!   - Writes and shell execution are exposed but the FRONTEND gates them
//!     behind user-opt-in flags. Rust does path scoping; the opt-in is
//!     policy, not security.
//!   - `shell_exec` always inherits stdin=null / stdout+stderr=pipe and runs
//!     with a default 30 s timeout.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;

mod bgshell;
mod mcp_stdio;
mod office;
mod pty;

// ---------------------------------------------------------------------------
// Path scoping helpers
// ---------------------------------------------------------------------------

/// Canonicalise `workspace` and ensure `target` resolves inside it.
///
/// If `target` doesn't exist yet (e.g. we're about to write a new file), we
/// fall back to canonicalising the parent and re-joining the file name —
/// otherwise `std::fs::canonicalize` would fail.
fn resolve_in_workspace(workspace: &str, target: &str) -> Result<PathBuf, String> {
    let ws = PathBuf::from(workspace);
    let ws_canon = ws
        .canonicalize()
        .map_err(|e| format!("无法解析工作区路径 {workspace:?}: {e}"))?;

    let target_path = Path::new(target);
    let candidate = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        ws_canon.join(target_path)
    };

    let canon = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|e| format!("路径解析失败 {candidate:?}: {e}"))?
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| format!("路径没有父目录: {candidate:?}"))?;
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| format!("父目录解析失败 {parent:?}: {e}"))?;
        let file_name = candidate
            .file_name()
            .ok_or_else(|| format!("路径没有文件名: {candidate:?}"))?;
        parent_canon.join(file_name)
    };

    if !canon.starts_with(&ws_canon) {
        return Err(format!(
            "路径超出工作区: {} (工作区: {})",
            canon.display(),
            ws_canon.display()
        ));
    }
    Ok(canon)
}

// ---------------------------------------------------------------------------
// FS commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_symlink: bool,
    size: u64,
    /// Unix epoch milliseconds, or 0 if unknown.
    modified_ms: u64,
}

#[derive(Serialize)]
pub struct FileStat {
    is_dir: bool,
    is_file: bool,
    is_symlink: bool,
    size: u64,
    modified_ms: u64,
}

/// Hidden-file heuristic: Windows hidden attribute OR Unix-style `.` prefix.
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

#[tauri::command]
async fn fs_list_dir(
    workspace: String,
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<DirEntry>, String> {
    let target = resolve_in_workspace(&workspace, &path)?;
    let mut read = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| format!("读取目录失败: {e}"))?;
    let mut out = Vec::new();
    let show_hidden = include_hidden.unwrap_or(false);
    while let Some(entry) = read
        .next_entry()
        .await
        .map_err(|e| format!("枚举条目失败: {e}"))?
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !show_hidden && is_hidden(&name) {
            continue;
        }
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue, // skip unreadable entries rather than fail the whole listing
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            size: meta.len(),
            modified_ms,
        });
    }
    // Folders first, then name asc.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// Read a file as text.
///
/// For plain-text files (source code, markdown, json, csv, ...): up to
/// `max_bytes` UTF-8-lossy bytes, default 256 KB.
///
/// For Office formats (xlsx / docx / pptx) and PDF: auto-routes to
/// `office::extract_by_extension` and returns clean markdown instead of
/// the raw zipped/binary bytes. The agent doesn't have to know — it just
/// keeps calling `fs_read_file` and gets sensible content for whatever it
/// asks. Without this, the agent would loop on "let me try Python" and
/// burn 60 KB of context on `PK\x03\x04` noise per attempt; we saw a
/// real task with 42 tool calls / 7 errors before the conversation died.
///
/// `max_bytes` is honored only for the plain-text path; Office extraction
/// has its own internal cap (see `office::MAX_EXTRACT_BYTES`) calibrated
/// for the denser markdown output.
#[tauri::command]
async fn fs_read_file(
    workspace: String,
    path: String,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let target = resolve_in_workspace(&workspace, &path)?;

    // Refuse directories early — same behaviour as before, but with a
    // metadata read that doesn't require opening a file handle (cheaper
    // and works correctly on Windows where some directories error on
    // open).
    let meta = tokio::fs::metadata(&target)
        .await
        .map_err(|e| format!("读取元数据失败: {e}"))?;
    if meta.is_dir() {
        return Err("目标是目录，不是文件".into());
    }

    // Office / PDF route. We push the sync extraction onto a blocking
    // thread so the async runtime stays responsive — `pdf_extract` in
    // particular can take seconds on a multi-page PDF and would
    // otherwise hold up other Tauri commands behind it.
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    if office::is_office_extension(&ext) {
        let target_owned = target.clone();
        return tokio::task::spawn_blocking(move || office::extract_by_extension(&target_owned))
            .await
            .map_err(|e| format!("抽取任务被中断: {e}"))?;
    }

    // Plain-text path — preserved verbatim from the pre-v0.1.16 version.
    let limit = max_bytes.unwrap_or(256 * 1024); // 256 KB default
    let f = tokio::fs::File::open(&target)
        .await
        .map_err(|e| format!("打开文件失败: {e}"))?;
    let mut buf = Vec::with_capacity(std::cmp::min(limit as usize, meta.len() as usize));
    let mut handle = f.take(limit);
    handle
        .read_to_end(&mut buf)
        .await
        .map_err(|e| format!("读取失败: {e}"))?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if meta.len() > limit {
        Ok(format!(
            "{text}\n\n[... 截断，文件共 {} 字节，已读取 {} 字节]",
            meta.len(),
            limit
        ))
    } else {
        Ok(text)
    }
}

/// Explicit Office / PDF text extraction. `fs_read_file` already auto-routes
/// to this — exposing the standalone command lets the frontend (or future
/// tools) call it directly when they know the extension up front, without
/// the file-existence + extension-sniff dance.
///
/// Returns the same clean-markdown shape as the auto-routed path.
#[tauri::command]
async fn office_extract(workspace: String, path: String) -> Result<String, String> {
    let target = resolve_in_workspace(&workspace, &path)?;
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    if !office::is_office_extension(&ext) {
        return Err(format!(
            "office_extract 不支持的扩展名: {ext}（支持: xlsx/xls/xlsm/xlsb/docx/pptx/pdf）"
        ));
    }
    let target_owned = target.clone();
    tokio::task::spawn_blocking(move || office::extract_by_extension(&target_owned))
        .await
        .map_err(|e| format!("抽取任务被中断: {e}"))?
}

#[tauri::command]
async fn fs_write_file(
    workspace: String,
    path: String,
    content: String,
    create_dirs: Option<bool>,
) -> Result<(), String> {
    let target = resolve_in_workspace(&workspace, &path)?;
    if create_dirs.unwrap_or(false) {
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    tokio::fs::write(&target, content)
        .await
        .map_err(|e| format!("写入失败: {e}"))
}

/// Write UTF-8 text to an arbitrary absolute path the user picked via the
/// native save-file dialog. Unlike `fs_write_file`, this is deliberately NOT
/// scoped to a workspace — the user explicitly consents to each path through
/// the OS dialog, so workspace scoping would prevent legitimate use cases
/// like "save this conversation to my Desktop."
///
/// The path must be absolute; we reject relative paths to avoid ambiguity
/// about which cwd they'd resolve against.
#[tauri::command]
async fn save_text_file(path: String, content: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err(format!("保存路径必须是绝对路径: {path}"));
    }
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败: {e}"))?;
    }
    tokio::fs::write(&target, content)
        .await
        .map_err(|e| format!("写入失败: {e}"))
}

#[tauri::command]
async fn fs_stat(workspace: String, path: String) -> Result<FileStat, String> {
    let target = resolve_in_workspace(&workspace, &path)?;
    let meta = tokio::fs::symlink_metadata(&target)
        .await
        .map_err(|e| format!("读取元数据失败: {e}"))?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        is_dir: meta.is_dir(),
        is_file: meta.is_file(),
        is_symlink: meta.file_type().is_symlink(),
        size: meta.len(),
        modified_ms,
    })
}

// ---------------------------------------------------------------------------
// Shell command (one-shot, workspace-scoped cwd)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ShellResult {
    stdout: String,
    stderr: String,
    /// Exit code, or -1 if the process was signalled / didn't produce one.
    code: i32,
    /// True if we killed the process because it hit the timeout.
    timed_out: bool,
}

#[derive(Deserialize)]
pub struct ShellArgs {
    workspace: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    /// Optional subdirectory of workspace to run in. Defaults to workspace root.
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[tauri::command]
async fn shell_exec(params: ShellArgs) -> Result<ShellResult, String> {
    // Determine cwd: either workspace root or a subdir inside it.
    let cwd = match &params.cwd {
        Some(sub) => resolve_in_workspace(&params.workspace, sub)?,
        None => PathBuf::from(&params.workspace)
            .canonicalize()
            .map_err(|e| format!("无法解析工作区: {e}"))?,
    };
    if !cwd.is_dir() {
        return Err(format!("cwd 不是目录: {}", cwd.display()));
    }

    let timeout = Duration::from_millis(params.timeout_ms.unwrap_or(30_000));

    let mut cmd = tokio::process::Command::new(&params.command);
    cmd.args(&params.args)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Important on Windows: without this the process may open a console
    // window, which is jarring inside a GUI app.
    #[cfg(windows)]
    {
        // tokio's Command re-exports `creation_flags` on Windows, no trait import needed.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动进程失败 ({}): {e}", params.command))?;

    // Race the child against the timeout.
    let result = tokio::time::timeout(timeout, child.wait_with_output()).await;

    match result {
        Ok(Ok(output)) => Ok(ShellResult {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            code: output.status.code().unwrap_or(-1),
            timed_out: false,
        }),
        Ok(Err(e)) => Err(format!("进程错误: {e}")),
        Err(_) => Err(format!("命令超时（{} ms）", timeout.as_millis())),
    }
}

// ---------------------------------------------------------------------------
// App entry
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Updater: checks a JSON manifest on GitHub Releases at startup (the
        // frontend triggers the actual check via @tauri-apps/plugin-updater).
        // Disabled in dev builds — a `tauri dev` run checking Releases for
        // itself is just noise. Production MSI/NSIS bundles include it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Process plugin — exposes `relaunch()` so the updater UI can restart
        // the app after a successful install. `exit()` isn't wired anywhere.
        .plugin(tauri_plugin_process::init())
        // PTY state is Tauri-managed so each handler gets a typed `State`
        // reference without us having to thread the HashMap manually.
        .manage(pty::PtyState::default())
        // Background shell state — the agent's `shell_start` lives here.
        // Separate from PtyState because the two serve very different callers:
        // xterm wants every byte as an event, agent wants to poll on demand.
        .manage(bgshell::BgShellState::default())
        // Stdio MCP servers — long-lived child processes spawning npm/pip
        // packages that speak JSON-RPC over stdio. Decoupled from BgShellState
        // so the agent's `shell_start` cap doesn't compete with marketplace
        // installs.
        .manage(mcp_stdio::McpStdioState::default())
        .invoke_handler(tauri::generate_handler![
            fs_list_dir,
            fs_read_file,
            fs_write_file,
            fs_stat,
            office_extract,
            save_text_file,
            shell_exec,
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            bgshell::shell_start,
            bgshell::shell_read,
            bgshell::shell_write,
            bgshell::shell_kill,
            bgshell::shell_list,
            bgshell::shell_remove,
            mcp_stdio::mcp_stdio_spawn,
            mcp_stdio::mcp_stdio_send,
            mcp_stdio::mcp_stdio_recv,
            mcp_stdio::mcp_stdio_kill,
            mcp_stdio::mcp_stdio_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flaude tauri application");
}
