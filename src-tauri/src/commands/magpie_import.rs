//! One-click import of magpie's local usage ledger (dashboard-stats-v2 §2.5,
//! 「magpie 用量导入」).
//!
//! magpie (an open-source local AI gateway) appends one JSON line per call it
//! serves to `usage.jsonl` in its config folder. The user can import that file
//! once, and again whenever they like: TokenLedger reads it read-only, keeps
//! the counted fields of each call in its own `imports/magpie-usage-v1.jsonl`
//! beside the database, and merges those rows into stats through the gateway
//! overlay, tagged `source = imported-magpie`, so a call an agent also logged
//! locally is counted once. magpie's files are never written, and no other
//! magpie file is opened here: not its providers, logins, settings or backups.
//!
//! What is kept of a call is what stats need: time, agent, provider id, model,
//! the four token counts, latency and session id. Hosts, key names and
//! fingerprints, accounts, errors, request ids and bodies are dropped on read.

use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::gateway_overlay::{self, GatewayRow, RowSource};
use crate::app_paths::AppContext;
use crate::{cache, db};

const STORE_DIR: &str = "imports";
const STORE_FILE: &str = "magpie-usage-v1.jsonl";
const META_FILE: &str = "magpie-import-v1.json";
const SOURCE_FILE: &str = "usage.jsonl";
/// A line longer than this is not a usage record (bodies are never in it).
const MAX_LINE_BYTES: usize = 256 * 1024;
const SYNTHETIC_SESSION_PREFIX: &str = "magpie:";

/// magpie's config folder: `$XDG_CONFIG_HOME/magpie` when that is an absolute
/// path, otherwise `~/.config/magpie` on every platform (magpie's own
/// `appdir.Config`). A portable magpie keeps its folder beside its binary and
/// is not found here.
pub(crate) fn magpie_config_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = PathBuf::from(xdg);
        if xdg.is_absolute() {
            return Some(xdg.join("magpie"));
        }
    }
    dirs::home_dir().map(|home| home.join(".config").join("magpie"))
}

/// One magpie `usage.jsonl` line, only the fields TokenLedger reads.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct MagpieRecord {
    t: String,
    agent: String,
    provider: String,
    model: String,
    req: String,
    served: String,
    #[serde(rename = "in")]
    input: i64,
    out: i64,
    cache_read: i64,
    cache_write: i64,
    ms: i64,
    status: i64,
    rejected: bool,
    session: String,
    route_id: i64,
    rid: String,
    computer: String,
}

/// One imported call as TokenLedger keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ImportedCall {
    /// Stable identity of the call, from its magpie fields.
    pub key: String,
    /// UTC RFC 3339, when the call ended.
    pub t: String,
    pub agent: String,
    pub provider: String,
    pub model: String,
    #[serde(rename = "in")]
    pub input: i64,
    pub out: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub ms: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub session: String,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParseCounts {
    pub lines: usize,
    pub imported: usize,
    pub invalid: usize,
    pub zero_tokens: usize,
    pub rejected: usize,
    pub other_computer: usize,
    pub repeated: usize,
}

/// FNV-1a, hex: the same stable hash the overlay uses for row ids.
fn fnv_hex(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn model_of(record: &MagpieRecord) -> String {
    for candidate in [&record.model, &record.served] {
        let value = candidate.trim();
        if !value.is_empty() {
            return value.to_string();
        }
    }
    let requested = record.req.trim();
    requested
        .split_once('/')
        .map_or(requested, |(_, model)| model)
        .to_string()
}

enum Parsed {
    Call(ImportedCall),
    Invalid,
    ZeroTokens,
    Rejected,
    OtherComputer,
}

fn parse_line(line: &str) -> Parsed {
    let Ok(record) = serde_json::from_str::<MagpieRecord>(line) else {
        return Parsed::Invalid;
    };
    let Ok(at) = DateTime::parse_from_rfc3339(record.t.trim()) else {
        return Parsed::Invalid;
    };
    let tokens = [
        record.input,
        record.out,
        record.cache_read,
        record.cache_write,
    ];
    if tokens.iter().any(|value| *value < 0) {
        return Parsed::Invalid;
    }
    // A call brought here by magpie's own sync was made on another computer;
    // that computer's TokenLedger counts it.
    if !record.computer.trim().is_empty() {
        return Parsed::OtherComputer;
    }
    // Refused locally before any vendor was asked (magpie's IsRejected).
    if record.rejected || (record.provider.trim().is_empty() && record.status >= 400) {
        return Parsed::Rejected;
    }
    if tokens.iter().all(|value| *value == 0) {
        return Parsed::ZeroTokens;
    }
    let t = at.with_timezone(&Utc).to_rfc3339();
    let model = model_of(&record);
    let identity = format!(
        "{t}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{model}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        record.route_id,
        record.rid.trim(),
        record.agent.trim(),
        record.provider.trim(),
        record.input,
        record.out,
        record.cache_read,
        record.cache_write,
    );
    Parsed::Call(ImportedCall {
        key: fnv_hex(&identity),
        t,
        agent: record.agent.trim().to_string(),
        provider: record.provider.trim().to_string(),
        model,
        input: record.input,
        out: record.out,
        cache_read: record.cache_read,
        cache_write: record.cache_write,
        ms: record.ms.max(0),
        session: record.session.trim().to_string(),
    })
}

/// Reads a magpie `usage.jsonl`; a line that doesn't parse is counted and
/// skipped, as magpie itself does.
pub(crate) fn parse_usage(path: &Path) -> Result<(Vec<ImportedCall>, ParseCounts), String> {
    let file =
        fs::File::open(path).map_err(|error| format!("读取 magpie 用量文件失败：{error}"))?;
    let mut reader = BufReader::new(file);
    let mut counts = ParseCounts::default();
    let mut calls = Vec::new();
    let mut seen = BTreeSet::new();
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = reader
            .read_until(b'\n', &mut buffer)
            .map_err(|error| format!("读取 magpie 用量文件失败：{error}"))?;
        if read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&buffer);
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            continue;
        }
        counts.lines += 1;
        if line.len() > MAX_LINE_BYTES {
            counts.invalid += 1;
            continue;
        }
        match parse_line(line) {
            Parsed::Call(call) => {
                if seen.insert(call.key.clone()) {
                    counts.imported += 1;
                    calls.push(call);
                } else {
                    counts.repeated += 1;
                }
            }
            Parsed::Invalid => counts.invalid += 1,
            Parsed::ZeroTokens => counts.zero_tokens += 1,
            Parsed::Rejected => counts.rejected += 1,
            Parsed::OtherComputer => counts.other_computer += 1,
        }
    }
    calls.sort_by(|a, b| a.t.cmp(&b.t).then_with(|| a.key.cmp(&b.key)));
    Ok((calls, counts))
}

pub(super) fn store_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(STORE_DIR)
}

fn store_path(db_path: &Path) -> PathBuf {
    store_dir(db_path).join(STORE_FILE)
}

fn meta_path(db_path: &Path) -> PathBuf {
    store_dir(db_path).join(META_FILE)
}

fn write_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建导入目录失败：{error}"))?;
    }
    let tmp = path.with_extension("tmp");
    let mut file = fs::File::create(&tmp).map_err(|error| format!("写入导入文件失败：{error}"))?;
    file.write_all(body)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("写入导入文件失败：{error}"))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|error| format!("写入导入文件失败：{error}"))
}

/// Replaces the imported store with `calls`.
pub(crate) fn write_store(db_path: &Path, calls: &[ImportedCall]) -> Result<(), String> {
    let mut body = Vec::new();
    for call in calls {
        serde_json::to_writer(&mut body, call).map_err(|error| error.to_string())?;
        body.push(b'\n');
    }
    write_atomic(&store_path(db_path), &body)
}

/// Cache signature of the imported store; `None` when nothing was imported.
pub(super) fn signature(db_path: &Path) -> Option<String> {
    let metadata = fs::metadata(store_path(db_path)).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    Some(format!("magpie:{}:{modified}", metadata.len()))
}

fn local_storage_time(ts: DateTime<Utc>) -> String {
    ts.with_timezone(&Local)
        .naive_local()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

pub(super) fn call_to_row(
    call: &ImportedCall,
    storage_time: &dyn Fn(DateTime<Utc>) -> String,
) -> Option<GatewayRow> {
    let ts = DateTime::parse_from_rfc3339(&call.t)
        .ok()?
        .with_timezone(&Utc);
    let session = Some(call.session.as_str()).filter(|value| !value.is_empty());
    let agent = Some(call.agent.to_ascii_lowercase()).filter(|value| !value.is_empty());
    Some(GatewayRow {
        id: gateway_overlay::row_id(&format!("{SYNTHETIC_SESSION_PREFIX}{}", call.key)),
        source: RowSource::ImportedMagpie,
        request_id: format!("{SYNTHETIC_SESSION_PREFIX}{}", call.key),
        tool: if agent.is_none() {
            "magpie".to_string()
        } else {
            gateway_overlay::tool_for_agent(agent.as_deref())
        },
        model: call.model.clone(),
        provider: call.provider.clone(),
        session_id: session.map_or_else(
            || format!("{SYNTHETIC_SESSION_PREFIX}{}", call.key),
            str::to_string,
        ),
        real_session: session.is_some(),
        timestamp: storage_time(ts),
        start_timestamp: storage_time(ts - chrono::Duration::milliseconds(call.ms)),
        input_tokens: call.input,
        output_tokens: call.out,
        cached_tokens: call.cache_read.saturating_add(call.cache_write),
        cache_write_tokens: call.cache_write,
    })
}

/// Imported rows as overlay rows; empty when nothing was imported. A store
/// that exists but can't be read is an error, never a silent pure-scan view.
pub(super) fn read_rows(db_path: &Path) -> Result<Vec<GatewayRow>, String> {
    let path = store_path(db_path);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取已导入的 magpie 用量失败：{error}")),
    };
    let mut rows = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let call: ImportedCall = serde_json::from_str(line)
            .map_err(|_| "已导入的 magpie 用量文件已损坏，请重新导入。".to_string())?;
        let row = call_to_row(&call, &local_storage_time)
            .ok_or_else(|| "已导入的 magpie 用量文件已损坏，请重新导入。".to_string())?;
        rows.push(row);
    }
    Ok(rows)
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportMeta {
    pub imported_at: String,
    pub counts: ParseCounts,
    pub earliest: Option<String>,
    pub latest: Option<String>,
    /// Imported calls that TokenLedger's own gateway had already recorded.
    pub duplicate_of_gateway: usize,
    /// Scanned rows (agents' own logs) the imported calls replace.
    pub matched_scans: usize,
    /// Imported calls left out because more than one scanned row fit.
    pub held: usize,
}

fn read_meta(db_path: &Path) -> Option<ImportMeta> {
    fs::read(meta_path(db_path))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// How the imported rows merge with what is already counted, for the report.
fn merge_report(db_path: &Path) -> Result<(usize, usize, usize), String> {
    let imported = read_rows(db_path)?;
    let Some(signature) = gateway_overlay::ledger_signature(db_path) else {
        return Ok((0, 0, 0));
    };
    let merged = gateway_overlay::gateway_rows_cached(db_path, &signature)?;
    let kept: BTreeSet<i64> = merged
        .iter()
        .filter(|row| row.source == RowSource::ImportedMagpie)
        .map(|row| row.id)
        .collect();
    let duplicate_of_gateway = imported.len().saturating_sub(kept.len());
    let imported_only: Vec<GatewayRow> = merged
        .iter()
        .filter(|row| row.source == RowSource::ImportedMagpie)
        .cloned()
        .collect();
    let conn = db::get_connection(db_path).map_err(|error| error.to_string())?;
    let scans = gateway_overlay::scan_candidates(&conn, &imported_only)
        .map_err(|error| error.to_string())?;
    let resolution = gateway_overlay::resolve_overlay(
        &imported_only,
        &scans,
        gateway_overlay::DEDUPE_WINDOW_SECS,
    );
    Ok((
        duplicate_of_gateway,
        resolution.superseded.len(),
        resolution.held.len(),
    ))
}

/// Reads `source` (a magpie `usage.jsonl`) into the imported store, replacing
/// any earlier import, and reports how it merges.
pub(crate) fn import_from(db_path: &Path, source: &Path) -> Result<ImportMeta, String> {
    let (calls, counts) = parse_usage(source)?;
    write_store(db_path, &calls)?;
    let (duplicate_of_gateway, matched_scans, held) = merge_report(db_path)?;
    let meta = ImportMeta {
        imported_at: Utc::now().to_rfc3339(),
        earliest: calls.first().map(|call| call.t.clone()),
        latest: calls.last().map(|call| call.t.clone()),
        counts,
        duplicate_of_gateway,
        matched_scans,
        held,
    };
    let body = serde_json::to_vec_pretty(&meta).map_err(|error| error.to_string())?;
    write_atomic(&meta_path(db_path), &body)?;
    Ok(meta)
}

/// Removes the imported store; magpie's own file is untouched.
pub(crate) fn clear(db_path: &Path) -> Result<(), String> {
    for path in [store_path(db_path), meta_path(db_path)] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("删除已导入的 magpie 用量失败：{error}")),
        }
    }
    Ok(())
}

fn status_value(db_path: &Path, magpie_dir: Option<&Path>) -> Value {
    let source = magpie_dir.map(|dir| dir.join(SOURCE_FILE));
    let source_meta = source.as_ref().and_then(|path| fs::metadata(path).ok());
    let source_modified = source_meta
        .as_ref()
        .and_then(|meta| meta.modified().ok())
        .map(|time| DateTime::<Utc>::from(time).to_rfc3339());
    json!({
        "magpieFound": magpie_dir.is_some_and(Path::is_dir),
        "usageFound": source_meta.as_ref().is_some_and(fs::Metadata::is_file),
        "usageBytes": source_meta.as_ref().map(fs::Metadata::len),
        "usageModifiedAt": source_modified,
        "imported": signature(db_path).is_some(),
        "lastImport": read_meta(db_path),
    })
}

fn emit_stats_updated(app_handle: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app_handle.emit("stats-updated", json!({ "source": "backend" }));
}

/// Whether magpie's usage file is present here, and the last import.
#[tauri::command]
pub async fn magpie_import_status(
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<Value, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = db::get_db_path(&app);
        Ok(status_value(&db_path, magpie_config_dir().as_deref()))
    })
    .await
    .map_err(|error| format!("magpie_import_status task panicked: {error}"))?
}

/// Imports (or re-imports) magpie's `usage.jsonl`.
#[tauri::command]
pub async fn magpie_import_run(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<Value, String> {
    let app = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let db_path = db::get_db_path(&app);
        db::init_db(&db_path).map_err(|error| error.to_string())?;
        let dir = magpie_config_dir().ok_or_else(|| "找不到用户主目录。".to_string())?;
        let source = dir.join(SOURCE_FILE);
        if !source.is_file() {
            return Err("没有找到 magpie 的用量文件，请先在这台电脑上使用 magpie。".to_string());
        }
        let meta = import_from(&db_path, &source)?;
        cache::invalidate_all(&db_path);
        serde_json::to_value(meta).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("magpie_import_run task panicked: {error}"))??;
    emit_stats_updated(&app_handle);
    Ok(result)
}

/// Removes imported magpie usage from TokenLedger.
#[tauri::command]
pub async fn magpie_import_clear(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<(), String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = db::get_db_path(&app);
        clear(&db_path)?;
        cache::invalidate_all(&db_path);
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("magpie_import_clear task panicked: {error}"))??;
    emit_stats_updated(&app_handle);
    Ok(())
}

#[cfg(test)]
#[path = "magpie_import_tests.rs"]
mod tests;
