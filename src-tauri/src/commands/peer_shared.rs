//! Other computers' usage, shared by the peer gateway on the WebDAV folder
//! (contract `peer-sync-v1` §6).
//!
//! The peer puts each computer's calls of a day beside its backup, sealed
//! with the sync passphrase. `peer_sync::shared` brings down the days of the
//! computers the user picked; this module keeps their counted fields in
//! `imports/peer-shared-v1.jsonl` and hands them to the stats overlay as
//! rows of their own (`source = shared-peer`), under a machine id per
//! computer. They are another computer's calls: they never replace a row
//! scanned here, and they are never uploaded to the cloud, where that
//! computer's own TokenLedger (if any) counts them.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};

use super::gateway_overlay::{self, GatewayRow, RowSource};
use crate::app_paths::AppContext;
use crate::{cache, db, peer_sync};

const STORE_DIR: &str = "imports";
const STORE_FILE: &str = "peer-shared-v1.jsonl";
const META_FILE: &str = "peer-shared-v1.json";
const ID_PREFIX: &str = "peer-shared:";

/// A shared call as the peer writes it, only the fields counted here.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SharedRecord {
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
}

/// One shared call as TokenLedger keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct SharedCall {
    /// The peer's id of the computer the call was made on.
    pub computer: String,
    /// Stable identity of the call within that computer.
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

/// What a pull brought, per computer, for the settings page.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedComputer {
    pub id: String,
    pub name: String,
    pub days: usize,
    pub calls: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedMeta {
    pub pulled_at: String,
    pub computers: Vec<SharedComputer>,
}

fn fnv_hex(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// One call of a shared day; `None` when it isn't counted: unreadable,
/// refused before reaching a vendor, or without tokens.
pub(crate) fn parse_call(computer: &str, value: &serde_json::Value) -> Option<SharedCall> {
    let record = SharedRecord::deserialize(value).ok()?;
    let at = DateTime::parse_from_rfc3339(record.t.trim()).ok()?;
    let tokens = [
        record.input,
        record.out,
        record.cache_read,
        record.cache_write,
    ];
    if tokens.iter().any(|value| *value < 0) || tokens.iter().all(|value| *value == 0) {
        return None;
    }
    if record.rejected || (record.provider.trim().is_empty() && record.status >= 400) {
        return None;
    }
    let t = at.with_timezone(&Utc).to_rfc3339();
    let model = [&record.model, &record.served]
        .into_iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let requested = record.req.trim();
            requested
                .split_once('/')
                .map_or(requested, |(_, model)| model)
                .to_string()
        });
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
    Some(SharedCall {
        computer: computer.to_string(),
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

fn store_dir(db_path: &Path) -> PathBuf {
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
    let mut file = fs::File::create(&tmp).map_err(|error| format!("写入共享用量失败：{error}"))?;
    file.write_all(body)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("写入共享用量失败：{error}"))?;
    drop(file);
    fs::rename(&tmp, path).map_err(|error| format!("写入共享用量失败：{error}"))
}

/// Replaces the kept shared usage with `calls` (each counted once).
pub(crate) fn write_store(
    db_path: &Path,
    calls: &[SharedCall],
    computers: Vec<SharedComputer>,
) -> Result<SharedMeta, String> {
    let mut seen = BTreeSet::new();
    let mut body = Vec::new();
    for call in calls {
        if !seen.insert((call.computer.as_str(), call.key.as_str())) {
            continue;
        }
        serde_json::to_writer(&mut body, call).map_err(|error| error.to_string())?;
        body.push(b'\n');
    }
    write_atomic(&store_path(db_path), &body)?;
    let meta = SharedMeta {
        pulled_at: Utc::now().to_rfc3339(),
        computers,
    };
    let text = serde_json::to_vec_pretty(&meta).map_err(|error| error.to_string())?;
    write_atomic(&meta_path(db_path), &text)?;
    Ok(meta)
}

pub(crate) fn read_meta(db_path: &Path) -> Option<SharedMeta> {
    fs::read(meta_path(db_path))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Removes the kept shared usage.
pub(crate) fn clear(db_path: &Path) -> Result<(), String> {
    for path in [store_path(db_path), meta_path(db_path)] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("删除共享用量失败：{error}")),
        }
    }
    Ok(())
}

/// Cache signature of the kept shared usage; `None` when there is none.
pub(super) fn signature(db_path: &Path) -> Option<String> {
    let metadata = fs::metadata(store_path(db_path)).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    Some(format!("shared:{}:{modified}", metadata.len()))
}

fn local_storage_time(ts: DateTime<Utc>) -> String {
    ts.with_timezone(&Local)
        .naive_local()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

/// The machine id another computer's rows are counted under.
pub(super) fn machine_id(computer: &str) -> String {
    format!("peer:{computer}")
}

pub(super) fn call_to_row(
    call: &SharedCall,
    storage_time: &dyn Fn(DateTime<Utc>) -> String,
) -> Option<GatewayRow> {
    let ts = DateTime::parse_from_rfc3339(&call.t)
        .ok()?
        .with_timezone(&Utc);
    let request_id = format!("{ID_PREFIX}{}:{}", call.computer, call.key);
    let agent = Some(call.agent.to_ascii_lowercase()).filter(|value| !value.is_empty());
    Some(GatewayRow {
        id: gateway_overlay::row_id(&request_id),
        source: RowSource::SharedPeer,
        tool: gateway_overlay::tool_for_agent(agent.as_deref()),
        model: call.model.clone(),
        provider: call.provider.clone(),
        // No session: a synthetic one, left out of session statistics.
        session_id: if call.session.is_empty() {
            format!("{}{request_id}", gateway_overlay::SYNTHETIC_SESSION_PREFIX)
        } else {
            call.session.clone()
        },
        // Another computer's session never spans rows scanned here.
        real_session: false,
        request_id,
        timestamp: storage_time(ts),
        start_timestamp: storage_time(ts - chrono::Duration::milliseconds(call.ms)),
        input_tokens: call.input,
        output_tokens: call.out,
        cached_tokens: call.cache_read.saturating_add(call.cache_write),
        cache_write_tokens: call.cache_write,
        machine_id: Some(machine_id(&call.computer)),
    })
}

/// Kept shared calls as overlay rows; empty when none were pulled. A store
/// that exists but can't be read is an error, never silently dropped.
pub(super) fn read_rows(db_path: &Path) -> Result<Vec<GatewayRow>, String> {
    let text = match fs::read_to_string(store_path(db_path)) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取共享用量失败：{error}")),
    };
    let broken = || "共享用量文件已损坏，请重新同步。".to_string();
    let mut rows = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let call: SharedCall = serde_json::from_str(line).map_err(|_| broken())?;
        rows.push(call_to_row(&call, &local_storage_time).ok_or_else(broken)?);
    }
    Ok(rows)
}

fn emit_stats_updated(app_handle: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = app_handle.emit("stats-updated", serde_json::json!({ "source": "backend" }));
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedListing {
    pub computers: Vec<peer_sync::shared::RemoteComputer>,
    pub last: Option<SharedMeta>,
}

/// The computers sharing usage on the server, and what the last pull kept.
#[tauri::command]
pub async fn peer_sync_shared_list(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<SharedListing, String> {
    peer_sync::ensure_main(&window)?;
    let app = state.inner().clone();
    let source = peer_sync::shared_source(app.app_data_dir(), &peer_sync::secrets())?;
    let computers = source
        .computers(&peer_sync::shared_selection(app.app_data_dir()))
        .await?;
    Ok(SharedListing {
        computers,
        last: read_meta(&db::get_db_path(&app)),
    })
}

/// Counts the picked computers' shared usage (and only theirs) from now on:
/// remembers the choice, brings their days down and replaces what was kept.
#[tauri::command]
pub async fn peer_sync_shared_pull(
    window: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
    ids: Vec<String>,
) -> Result<SharedMeta, String> {
    peer_sync::ensure_main(&window)?;
    let app = state.inner().clone();
    let picked = peer_sync::save_shared_selection(app.app_data_dir(), &ids)?;
    let db_path = db::get_db_path(&app);
    if picked.is_empty() {
        clear(&db_path)?;
        cache::invalidate_all(&db_path);
        emit_stats_updated(&app_handle);
        return Ok(SharedMeta::default());
    }
    let source = peer_sync::shared_source(app.app_data_dir(), &peer_sync::secrets())?;
    let (calls, computers) = source.pull(&picked).await?;
    let meta = tauri::async_runtime::spawn_blocking(move || {
        db::init_db(&db_path).map_err(|error| error.to_string())?;
        let meta = write_store(&db_path, &calls, computers)?;
        cache::invalidate_all(&db_path);
        Ok::<_, String>(meta)
    })
    .await
    .map_err(|error| format!("peer_sync_shared_pull task panicked: {error}"))??;
    emit_stats_updated(&app_handle);
    Ok(meta)
}

/// Stops counting other computers' shared usage and forgets the choice.
#[tauri::command]
pub async fn peer_sync_shared_clear(
    window: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<(), String> {
    peer_sync::ensure_main(&window)?;
    let app = state.inner().clone();
    peer_sync::save_shared_selection(app.app_data_dir(), &[])?;
    let db_path = db::get_db_path(&app);
    clear(&db_path)?;
    cache::invalidate_all(&db_path);
    emit_stats_updated(&app_handle);
    Ok(())
}

#[cfg(test)]
#[path = "peer_shared_tests.rs"]
mod tests;
