//! Native text extraction for Office formats (xlsx / docx / pptx) and PDF.
//!
//! ## Why this module exists
//!
//! `fs_read_file` used to be a thin `String::from_utf8_lossy` over raw bytes.
//! That's fine for source code and markdown but produces 256 KB of `PK\x03\x04`
//! noise when the agent tries to read a real `.xlsx`. The model then panics
//! into "let me try Python" loops, the conversation context fills up with
//! garbage, and the whole task collapses (typical symptom: 40+ tool calls,
//! 7+ errors, browser tab freezes).
//!
//! With this module in place, `fs_read_file` sniffs the extension and routes
//! to `extract_by_extension`, which returns clean markdown. The agent never
//! has to know any of this exists.
//!
//! ## Design notes
//!
//! - Each extractor is a synchronous function (Office crates are all sync).
//!   `lib.rs` wraps them in `tokio::task::spawn_blocking` so the async
//!   runtime isn't held hostage by a slow PDF.
//! - We cap output at 512 KB regardless of input size. Real-world Office
//!   files extract to maybe 10-50 KB of text; the cap is a safety net for
//!   pathological cases (1000-page PDF, 50-sheet Excel) so we don't blow
//!   context anyway.
//! - For xlsx we render each sheet as a markdown table; for docx/pptx we
//!   walk the known text tags (`w:t` / `a:t`) and join paragraphs with
//!   blank lines. PPTX gets one `## Slide N` header per slide.
//! - We deliberately don't try to preserve formatting (bold, colors, font
//!   sizes). LLMs don't care, and stripping markup keeps the token cost
//!   honest.

use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

/// Output cap for any single extraction.
///
/// Originally 512 KB (double fs_read_file's 256 KB default) on the theory
/// that office content is denser per byte. In practice we ran a real
/// investment-research task with three Office files, hit ~1.5 MB of tool
/// result text in conversation state, watched Zustand persist serialize
/// + write that to localStorage on every reasoning-delta tick (~1500x
/// per turn), and OOM'd the WebView2 renderer mid-stream.
///
/// 128 KB is the empirical sweet spot: typical PDF/docx extractions
/// surface their key content (intro + key sections) in the first
/// 50-100 KB, and the truncation hint tells the model to ask for a
/// specific section if it needs more. Keeps single-conversation tool
/// content well under 1 MB across 3-5 file reads, which the renderer
/// + localStorage stack handles comfortably.
const MAX_EXTRACT_BYTES: usize = 128 * 1024;

/// Extensions this module knows how to handle. Centralised so `fs_read_file`
/// in lib.rs uses the same list — keeps the route-table single-sourced.
pub fn is_office_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "xlsx" | "xlsm" | "xlsb" | "xls" | "docx" | "pptx" | "pdf"
    )
}

/// Dispatch by extension. Returns `Ok(text)` on success, `Err(msg)` on a
/// known failure (corrupt file, encrypted PDF, etc.). Caller is expected
/// to have pre-checked `is_office_extension`.
pub fn extract_by_extension(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| "no extension".to_string())?;

    match ext.as_str() {
        "xlsx" | "xlsm" | "xlsb" | "xls" => extract_xlsx(path),
        "docx" => extract_docx(path),
        "pptx" => extract_pptx(path),
        "pdf" => extract_pdf(path),
        other => Err(format!("unsupported extension: {other}")),
    }
}

// ---- XLSX ----------------------------------------------------------------

fn extract_xlsx(path: &Path) -> Result<String, String> {
    use calamine::{open_workbook_auto, Reader};

    let mut wb = open_workbook_auto(path).map_err(|e| format!("打开工作簿失败: {e}"))?;

    let mut out = String::new();
    let fname = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workbook");
    out.push_str(&format!("# 工作簿: {fname}\n\n"));

    // `sheet_names` returns Vec<String> in calamine 0.30; clone so we can
    // borrow the workbook mutably below.
    let sheet_names: Vec<String> = wb.sheet_names().to_vec();

    for sheet_name in &sheet_names {
        if out.len() > MAX_EXTRACT_BYTES {
            out.push_str("\n[... 截断: 后续 sheet 未读取]\n");
            break;
        }
        let range = match wb.worksheet_range(sheet_name) {
            Ok(r) => r,
            Err(e) => {
                out.push_str(&format!("## Sheet: {sheet_name}\n\n[读取失败: {e}]\n\n"));
                continue;
            }
        };
        if range.is_empty() {
            out.push_str(&format!("## Sheet: {sheet_name}\n\n[空]\n\n"));
            continue;
        }
        out.push_str(&format!("## Sheet: {sheet_name}\n\n"));

        let mut wrote_header = false;
        for (i, row) in range.rows().enumerate() {
            if out.len() > MAX_EXTRACT_BYTES {
                out.push_str("\n[... 截断: 行数过多]\n");
                break;
            }
            // Render every row as a markdown row. For the first row, also
            // emit the `|---|---|` separator so downstream renderers (and
            // the model's mental model) treat it as a header. This is a
            // heuristic — sometimes the first row is data, but the LLM
            // recovers from that fine.
            out.push('|');
            for cell in row {
                out.push(' ');
                out.push_str(&cell_to_md(cell));
                out.push_str(" |");
            }
            out.push('\n');
            if i == 0 {
                out.push('|');
                for _ in row {
                    out.push_str("---|");
                }
                out.push('\n');
                wrote_header = true;
            }
            // De-warn: header always written when there's at least one row.
            let _ = wrote_header;
        }
        out.push('\n');
    }

    Ok(out)
}

fn cell_to_md(cell: &calamine::Data) -> String {
    use calamine::Data;
    let raw = match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => format_number(*f),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("#ERR:{e:?}"),
    };
    // Markdown table cell escaping: pipes break the row; newlines break
    // alignment. Replace both with safe equivalents.
    raw.replace('|', "\\|").replace('\n', " ⏎ ")
}

fn format_number(f: f64) -> String {
    // Render integral floats without the `.0` trailer — Excel stores
    // everything as f64 by default and a column of "1.0, 2.0, 3.0" reads
    // worse than "1, 2, 3" for the LLM.
    if f.is_finite() && f == f.trunc() && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

// ---- DOCX ----------------------------------------------------------------

fn extract_docx(path: &Path) -> Result<String, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("打开文档失败: {e}"))?;
    let mut archive = ZipArchive::new(f).map_err(|e| format!("docx 不是有效的 ZIP: {e}"))?;

    let mut xml = String::new();
    {
        let mut entry = archive
            .by_name("word/document.xml")
            .map_err(|e| format!("找不到 word/document.xml: {e}"))?;
        entry
            .read_to_string(&mut xml)
            .map_err(|e| format!("读 document.xml 失败: {e}"))?;
    }

    let mut out = String::new();
    let fname = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document");
    out.push_str(&format!("# 文档: {fname}\n\n"));

    walk_text_runs(&xml, b"w:t", b"w:p", &mut out);
    Ok(out)
}

// ---- PPTX ----------------------------------------------------------------

fn extract_pptx(path: &Path) -> Result<String, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("打开演示文稿失败: {e}"))?;
    let mut archive = ZipArchive::new(f).map_err(|e| format!("pptx 不是有效的 ZIP: {e}"))?;

    // Collect slide entry names. They live at `ppt/slides/slide<N>.xml`;
    // the order in the zip is not guaranteed, so we sort by N.
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .collect();
    slide_names.sort_by_key(|n| {
        n.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0)
    });

    let mut out = String::new();
    let fname = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("presentation");
    out.push_str(&format!(
        "# 演示文稿: {fname} ({} 张幻灯片)\n\n",
        slide_names.len()
    ));

    for (idx, name) in slide_names.iter().enumerate() {
        if out.len() > MAX_EXTRACT_BYTES {
            out.push_str("\n[... 截断: 后续幻灯片未读取]\n");
            break;
        }
        let mut xml = String::new();
        if let Ok(mut entry) = archive.by_name(name) {
            if entry.read_to_string(&mut xml).is_err() {
                continue;
            }
        } else {
            continue;
        }

        out.push_str(&format!("## Slide {}\n\n", idx + 1));
        // pptx text runs use the DrawingML namespace (`a:t`). Paragraphs
        // are `a:p`. Same walk pattern as docx, different tag names.
        walk_text_runs(&xml, b"a:t", b"a:p", &mut out);
        out.push('\n');
    }

    Ok(out)
}

/// Shared XML walker for docx + pptx. Pulls every text run inside `text_tag`
/// and emits a blank line whenever it leaves a `paragraph_tag` (so we get
/// readable paragraph separation).
///
/// quick-xml is SAX-style, which is exactly what we want — we don't care
/// about structure beyond "is this text inside the run tag", and streaming
/// keeps memory bounded for large documents.
fn walk_text_runs(xml: &str, text_tag: &[u8], paragraph_tag: &[u8], out: &mut String) {
    let mut reader = XmlReader::from_str(xml);
    let mut buf: Vec<u8> = Vec::new();
    let mut in_text = false;
    let mut paragraph = String::new();

    loop {
        if out.len() > MAX_EXTRACT_BYTES {
            out.push_str("\n[... 截断]\n");
            break;
        }
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                if e.name().as_ref() == text_tag {
                    in_text = true;
                }
            }
            Ok(Event::Text(e)) if in_text => {
                // quick-xml 0.39 split the old `BytesText::unescape()` into
                // `decode()` (bytes → str) + `escape::unescape()` (entity
                // resolution). We do both so we get clean Chinese / accented
                // text without `&amp;` / `&lt;` leaking through. If either
                // step fails (rare — malformed entity), fall back to raw
                // decoded bytes rather than losing the run entirely.
                if let Ok(decoded) = e.decode() {
                    match unescape(&decoded) {
                        Ok(s) => paragraph.push_str(&s),
                        Err(_) => paragraph.push_str(&decoded),
                    }
                }
            }
            Ok(Event::End(e)) => {
                let n = e.name();
                if n.as_ref() == text_tag {
                    in_text = false;
                } else if n.as_ref() == paragraph_tag {
                    let trimmed = paragraph.trim();
                    if !trimmed.is_empty() {
                        out.push_str(trimmed);
                        out.push('\n');
                        out.push('\n');
                    }
                    paragraph.clear();
                }
            }
            Ok(Event::Eof) => break,
            // Soft-fail XML errors: an unclosed tag near EOF shouldn't
            // throw away everything we extracted up to that point. Real
            // corruption shows up as an empty result, which the caller
            // can flag.
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    // Flush any trailing paragraph that didn't end with `</p>` (rare but
    // possible in malformed exports).
    let trimmed = paragraph.trim();
    if !trimmed.is_empty() {
        out.push_str(trimmed);
        out.push('\n');
    }
}

// ---- PDF -----------------------------------------------------------------

fn extract_pdf(path: &Path) -> Result<String, String> {
    // pdf-extract panics on a few classes of malformed PDFs (very old
    // versions, certain font encodings). Wrap in catch_unwind so we
    // surface a clean error instead of bringing the whole Tauri process
    // down — the agent will see "extraction failed" and can move on.
    let path_owned = path.to_path_buf();
    let result = std::panic::catch_unwind(move || pdf_extract::extract_text(&path_owned));

    let text = match result {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return Err(format!("PDF 抽取失败: {e}")),
        Err(_) => return Err("PDF 抽取过程中崩溃（文件可能已加密或编码异常）".into()),
    };

    let mut out = String::new();
    let fname = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document");
    out.push_str(&format!("# PDF: {fname}\n\n"));

    if text.len() > MAX_EXTRACT_BYTES {
        // Walk to a char boundary before slicing — Chinese / accented
        // characters span multiple UTF-8 bytes and slicing mid-codepoint
        // panics.
        let mut end = MAX_EXTRACT_BYTES;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        out.push_str(&text[..end]);
        out.push_str(&format!(
            "\n\n[... 截断: 原文共 {} 字节，已读取 {} 字节]\n",
            text.len(),
            end
        ));
    } else {
        out.push_str(&text);
    }

    Ok(out)
}
