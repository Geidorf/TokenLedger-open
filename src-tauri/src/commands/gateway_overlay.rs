//! Merges the local gateway ledger into local stats (dashboard-stats-v2 §2.5).
//!
//! Scanned rows are never modified. When the ledger exists, a stats connection
//! gets a TEMP view named `token_logs`: SQLite resolves unqualified names in
//! `temp` before `main`, so every read-only stats query on that connection sees
//! "scanned rows not superseded by the gateway" ∪ "counted gateway rows"
//! without changing its SQL. Writers must never use such a connection.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Local, NaiveDateTime, Utc};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};

use crate::db;
use crate::gateway::{accounting, LedgerRecord};

/// Slack around a gateway request's `[ts − latencyMs, ts]` span: magpie's 2 s
/// end-time match plus up to 1 s of second truncation on each side, plus 1 s.
pub(super) const DEDUPE_WINDOW_SECS: i64 = 5;
const LEDGER_FILES: [&str; 2] = ["usage-v1.jsonl.1", "usage-v1.jsonl"];
const SYNTHETIC_SESSION_PREFIX: &str = "gateway:";

/// Where a merged row came from: TokenLedger's own gateway, or magpie's
/// `usage.jsonl` imported by the user (`magpie_import`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum RowSource {
    #[default]
    Gateway,
    ImportedMagpie,
}

impl RowSource {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Gateway => "gateway",
            Self::ImportedMagpie => "imported-magpie",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct GatewayRow {
    pub id: i64,
    pub source: RowSource,
    pub request_id: String,
    pub tool: String,
    pub model: String,
    pub provider: String,
    pub session_id: String,
    pub real_session: bool,
    /// When the request was recorded (its end), in storage time.
    pub timestamp: String,
    /// `ts − latencyMs`, in storage time.
    pub start_timestamp: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub cache_write_tokens: i64,
}

#[derive(Clone, Debug)]
pub(super) struct ScanCandidate {
    pub id: i64,
    pub tool: String,
    pub session_id: String,
    pub timestamp: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
}

pub(super) fn is_synthetic_session(session_id: &str) -> bool {
    session_id.starts_with(SYNTHETIC_SESSION_PREFIX)
}

pub(super) fn tool_for_agent(agent: Option<&str>) -> String {
    match agent.map(str::trim).filter(|value| !value.is_empty()) {
        None => "gateway".to_string(),
        Some("claude-code") => "claude".to_string(),
        Some("gemini-cli") => "gemini".to_string(),
        Some(other) => other.to_string(),
    }
}

fn model_for(record: &LedgerRecord) -> String {
    let upstream = record.upstream_model.trim();
    if !upstream.is_empty() {
        return upstream.to_string();
    }
    let requested = record.requested_model.trim();
    requested
        .split_once('/')
        .map_or(requested, |(_, model)| model)
        .to_string()
}

/// Stable negative id so gateway rows never collide with scanned row ids and
/// detail cursors stay valid across reloads (FNV-1a of the request id).
pub(super) fn row_id(request_id: &str) -> i64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in request_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    -((hash & 0x3fff_ffff_ffff_ffff) as i64) - 1
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// Maps one ledger line to a stats row; `None` when it is not counted
/// (zero tokens) or its timestamp cannot be read.
pub(super) fn map_record(
    record: &LedgerRecord,
    storage_time: &dyn Fn(DateTime<Utc>) -> String,
) -> Option<GatewayRow> {
    let tokens = [
        record.input,
        record.output,
        record.cache_read,
        record.cache_write,
    ];
    if tokens.iter().all(|value| *value == 0) {
        return None;
    }
    let ts = DateTime::parse_from_rfc3339(record.ts.trim())
        .ok()?
        .with_timezone(&Utc);
    let session = record
        .session
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Some(GatewayRow {
        id: row_id(&accounting_id(record)),
        source: RowSource::Gateway,
        request_id: record.request_id.clone(),
        tool: tool_for_agent(record.agent.as_deref()),
        model: model_for(record),
        provider: record.provider.clone(),
        session_id: session.map_or_else(
            || format!("{SYNTHETIC_SESSION_PREFIX}{}", record.request_id),
            str::to_string,
        ),
        real_session: session.is_some(),
        timestamp: storage_time(ts),
        start_timestamp: storage_time(
            ts - chrono::Duration::milliseconds(to_i64(record.latency_ms)),
        ),
        input_tokens: to_i64(record.input),
        output_tokens: to_i64(record.output),
        cached_tokens: to_i64(record.cache_read.saturating_add(record.cache_write)),
        cache_write_tokens: to_i64(record.cache_write),
    })
}

fn parse_storage(value: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S").ok()
}

/// `[start, end]` of a gateway request; a start after the end is clamped.
fn span_of(row: &GatewayRow) -> Option<(NaiveDateTime, NaiveDateTime)> {
    let end = parse_storage(&row.timestamp)?;
    let start = parse_storage(&row.start_timestamp).map_or(end, |start| start.min(end));
    Some((start, end))
}

/// Rule A (session span) then rule B (one-to-one fingerprint fallback).
pub(super) fn superseded_scan_ids(
    gateway: &[GatewayRow],
    scans: &[ScanCandidate],
    window_secs: i64,
) -> BTreeSet<i64> {
    resolve_overlay(gateway, scans, window_secs).superseded
}

/// Outcome of merging gateway-like rows with scanned rows.
#[derive(Debug, Default, PartialEq)]
pub(super) struct OverlayResolution {
    /// Scanned rows replaced by a gateway or imported row.
    pub superseded: BTreeSet<i64>,
    /// Imported rows left out because rule B found more than one equally
    /// fitting scan: their scanned twins stay counted instead, so the totals
    /// are unchanged and nothing is merged on a guess.
    pub held: BTreeSet<i64>,
}

/// Rule A then rule B, as `superseded_scan_ids`; imported magpie rows are
/// never matched by rule B when more than one candidate fits.
pub(super) fn resolve_overlay(
    gateway: &[GatewayRow],
    scans: &[ScanCandidate],
    window_secs: i64,
) -> OverlayResolution {
    let window = chrono::Duration::seconds(window_secs);
    let mut superseded = BTreeSet::new();
    let mut held = BTreeSet::new();

    let mut spans: HashMap<(&str, &str), (NaiveDateTime, NaiveDateTime)> = HashMap::new();
    for row in gateway.iter().filter(|row| row.real_session) {
        let Some((start, end)) = span_of(row) else {
            continue;
        };
        spans
            .entry((row.tool.as_str(), row.session_id.as_str()))
            .and_modify(|(first, last)| {
                *first = (*first).min(start);
                *last = (*last).max(end);
            })
            .or_insert((start, end));
    }
    let mut anchored: BTreeSet<(&str, &str)> = BTreeSet::new();
    for scan in scans {
        let key = (scan.tool.as_str(), scan.session_id.as_str());
        let (Some((first, last)), Some(ts)) = (spans.get(&key), parse_storage(&scan.timestamp))
        else {
            continue;
        };
        if ts >= *first - window && ts <= *last + window {
            superseded.insert(scan.id);
            anchored.insert(key);
        }
    }

    let mut fallback: Vec<&GatewayRow> = gateway
        .iter()
        .filter(|row| {
            !row.real_session || !anchored.contains(&(row.tool.as_str(), row.session_id.as_str()))
        })
        .collect();
    fallback.sort_by(|a, b| {
        a.timestamp
            .cmp(&b.timestamp)
            .then_with(|| a.request_id.as_bytes().cmp(b.request_id.as_bytes()))
    });
    // Parse each remaining scan once and index only equal tool/token fingerprints.
    // The time range retains the inclusive window and (distance, id) tie-break;
    // removing a consumed entry preserves rule B's one-to-one accounting.
    type Fingerprint<'a> = (&'a str, i64, i64, i64);
    let mut candidates: HashMap<Fingerprint<'_>, BTreeSet<(NaiveDateTime, i64)>> = HashMap::new();
    for scan in scans.iter().filter(|scan| !superseded.contains(&scan.id)) {
        let Some(at) = parse_storage(&scan.timestamp) else {
            continue;
        };
        candidates
            .entry((
                scan.tool.as_str(),
                scan.input_tokens,
                scan.output_tokens,
                scan.cached_tokens,
            ))
            .or_default()
            .insert((at, scan.id));
    }
    for row in fallback {
        let Some((start, end)) = span_of(row) else {
            continue;
        };
        let Some(matching) = candidates.get_mut(&(
            row.tool.as_str(),
            row.input_tokens,
            row.output_tokens,
            row.cached_tokens,
        )) else {
            continue;
        };
        let (first, last) = (start - window, end + window);
        if first > last {
            continue;
        }
        let fitting = matching
            .range((first, i64::MIN)..=(last, i64::MAX))
            .filter(|(_, id)| !superseded.contains(id))
            .map(|&(at, id)| {
                let delta = if at < start {
                    (start - at).num_seconds()
                } else if at > end {
                    (at - end).num_seconds()
                } else {
                    0
                };
                (delta, id, at)
            })
            .filter(|(delta, _, _)| *delta <= window_secs)
            .collect::<Vec<_>>();
        if row.source == RowSource::ImportedMagpie && fitting.len() > 1 {
            held.insert(row.id);
            continue;
        }
        if let Some(&(_, id, at)) = fitting.iter().min() {
            superseded.insert(id);
            matching.remove(&(at, id));
        }
    }
    OverlayResolution { superseded, held }
}

pub(super) fn gateway_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("gateway")
}

fn ledger_paths(db_path: &Path) -> Vec<PathBuf> {
    let dir = gateway_dir(db_path);
    LEDGER_FILES.iter().map(|name| dir.join(name)).collect()
}

/// Presence is detected without inventing an accounting database for scan-only installs.
pub(super) fn accounting_present(db_path: &Path) -> bool {
    let present = |path: &Path| {
        fs::symlink_metadata(path).map_or_else(
            |error| error.kind() != std::io::ErrorKind::NotFound,
            |_| true,
        )
    };
    let dir = gateway_dir(db_path);
    present(&dir.join(accounting::FILE))
        || present(&dir.join("cloud-sync-v1.json"))
        || ledger_paths(db_path).iter().any(|path| present(path))
}

pub(super) fn accounting_coverage(db_path: &Path) -> Result<Option<accounting::Coverage>, String> {
    if !accounting_present(db_path) {
        return Ok(None);
    }
    accounting::initialize(&gateway_dir(db_path)).map(Some)
}

/// Permanent accounting revision invalidates stats caches even after diagnostic rotation.
/// An unreadable source retains presence; consumers must return Err, not pure-scan fallback.
/// An imported magpie ledger (`magpie_import`) joins the signature, so importing,
/// re-importing or removing it invalidates the same caches.
pub(super) fn ledger_signature(db_path: &Path) -> Option<String> {
    let accounting =
        accounting_present(db_path).then(|| match accounting::horizon(&gateway_dir(db_path)) {
            Ok((coverage, through)) => format!("accounting:{}:{through}", coverage.revision),
            Err(_) => "accounting:unreadable".to_string(),
        });
    match (accounting, super::magpie_import::signature(db_path)) {
        (Some(accounting), Some(magpie)) => Some(format!("{accounting}|{magpie}")),
        (accounting, magpie) => accounting.or(magpie),
    }
}

fn local_storage_time(ts: DateTime<Utc>) -> String {
    ts.with_timezone(&Local)
        .naive_local()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn accounting_id(record: &LedgerRecord) -> String {
    accounting::accounting_id(record)
}

/// TokenLedger's own gateway rows, then the imported magpie rows that are not
/// the same request seen by both gateways (a TokenLedger gateway row wins,
/// matched by the same rules A and B as a scanned row).
fn read_merged_rows(db_path: &Path) -> Result<Vec<GatewayRow>, String> {
    let mut rows = if accounting_present(db_path) {
        read_gateway_rows(db_path)?
    } else {
        Vec::new()
    };
    let imported = super::magpie_import::read_rows(db_path)?;
    if imported.is_empty() {
        return Ok(rows);
    }
    let as_scans: Vec<ScanCandidate> = imported
        .iter()
        .map(|row| ScanCandidate {
            id: row.id,
            tool: row.tool.clone(),
            session_id: row.session_id.clone(),
            timestamp: row.timestamp.clone(),
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            cached_tokens: row.cached_tokens,
        })
        .collect();
    let duplicates = superseded_scan_ids(&rows, &as_scans, DEDUPE_WINDOW_SECS);
    rows.extend(
        imported
            .into_iter()
            .filter(|row| !duplicates.contains(&row.id)),
    );
    Ok(rows)
}

fn read_gateway_rows(db_path: &Path) -> Result<Vec<GatewayRow>, String> {
    let dir = gateway_dir(db_path);
    let (_, through) = accounting::horizon(&dir)?;
    let mut after = 0;
    let mut rows = Vec::new();
    loop {
        let page = accounting::read_page(&dir, after, through)?;
        if page.is_empty() {
            break;
        }
        after = page.last().expect("nonempty page").0;
        for (_, record) in page {
            let row = map_record(&record, &local_storage_time)
                .ok_or_else(|| "网关持久账本包含无法安全统计的记录。".to_string())?;
            rows.push(row);
        }
    }
    Ok(rows)
}

type CachedRows = (String, Arc<Vec<GatewayRow>>);
static ROWS_CACHE: Mutex<Option<(PathBuf, CachedRows)>> = Mutex::new(None);

pub(super) fn gateway_rows_cached(
    db_path: &Path,
    signature: &str,
) -> Result<Arc<Vec<GatewayRow>>, String> {
    let mut cache = ROWS_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((path, (cached_signature, rows))) = cache.as_ref() {
        if path == db_path && cached_signature == signature {
            return Ok(rows.clone());
        }
    }
    let rows = Arc::new(read_merged_rows(db_path)?);
    *cache = Some((db_path.to_path_buf(), (signature.to_string(), rows.clone())));
    Ok(rows)
}

pub(super) fn scan_candidates(
    conn: &Connection,
    gateway: &[GatewayRow],
) -> rusqlite::Result<Vec<ScanCandidate>> {
    let spans: Vec<(NaiveDateTime, NaiveDateTime)> = gateway.iter().filter_map(span_of).collect();
    let (Some(first), Some(last)) = (
        spans.iter().map(|span| span.0).min(),
        spans.iter().map(|span| span.1).max(),
    ) else {
        return Ok(Vec::new());
    };
    let window = chrono::Duration::seconds(DEDUPE_WINDOW_SECS);
    let tools: BTreeSet<&str> = gateway.iter().map(|row| row.tool.as_str()).collect();
    let mut sql = "SELECT id, tool, session_id, timestamp, input_tokens, output_tokens, \
                   COALESCE(cached_tokens, 0) FROM main.token_logs \
                   WHERE timestamp >= ? AND timestamp <= ? AND tool IN ("
        .to_string();
    sql.push_str(&vec!["?"; tools.len()].join(", "));
    sql.push(')');
    let mut values = vec![
        SqlValue::Text(super::storage_timestamp(first - window)),
        SqlValue::Text(super::storage_timestamp(last + window)),
    ];
    values.extend(tools.iter().map(|tool| SqlValue::Text((*tool).to_string())));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        Ok(ScanCandidate {
            id: row.get(0)?,
            tool: row.get(1)?,
            session_id: row.get(2)?,
            timestamp: row.get(3)?,
            input_tokens: row.get(4)?,
            output_tokens: row.get(5)?,
            cached_tokens: row.get(6)?,
        })
    })?;
    rows.collect()
}

fn install_overlay(conn: &Connection, gateway: &[GatewayRow]) -> rusqlite::Result<()> {
    let OverlayResolution { superseded, held } = resolve_overlay(
        gateway,
        &scan_candidates(conn, gateway)?,
        DEDUPE_WINDOW_SECS,
    );
    let machine_id = super::fallback_machine_id();
    conn.execute_batch(
        "CREATE TEMP TABLE gw_rows (
             id INTEGER PRIMARY KEY, tool TEXT NOT NULL, model TEXT NOT NULL,
             input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
             cached_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
             timestamp TEXT NOT NULL, session_id TEXT NOT NULL, cost_usd REAL,
             machine_id TEXT NOT NULL, provider TEXT NOT NULL, source TEXT NOT NULL);
         CREATE TEMP TABLE gw_superseded (id INTEGER PRIMARY KEY);
         CREATE TEMP VIEW token_logs AS
             SELECT id, tool, model, input_tokens, output_tokens, cached_tokens,
                    cache_write_tokens, timestamp, session_id, cost_usd, machine_id, cache_write_known, usage_provenance
               FROM main.token_logs
              WHERE id NOT IN (SELECT id FROM temp.gw_superseded)
             UNION ALL
             SELECT id, tool, model, input_tokens, output_tokens, cached_tokens,
                    cache_write_tokens, timestamp, session_id, cost_usd, machine_id, NULL AS cache_write_known, 'reported' AS usage_provenance
               FROM temp.gw_rows;",
    )?;
    let mut insert_row = conn.prepare(
        "INSERT OR IGNORE INTO temp.gw_rows VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12)",
    )?;
    for row in gateway.iter().filter(|row| !held.contains(&row.id)) {
        insert_row.execute(params![
            row.id,
            row.tool,
            row.model,
            row.input_tokens,
            row.output_tokens,
            row.cached_tokens,
            row.cache_write_tokens,
            row.timestamp,
            row.session_id,
            machine_id,
            row.provider,
            row.source.as_str(),
        ])?;
    }
    let mut insert_superseded = conn.prepare("INSERT INTO temp.gw_superseded VALUES (?1)")?;
    for id in superseded {
        insert_superseded.execute(params![id])?;
    }
    Ok(())
}

/// Read-only stats connection. With a gateway ledger present the connection
/// sees the merged view; otherwise it is a plain connection.
pub(super) fn open_stats_connection(db_path: &Path) -> Result<Connection, String> {
    let conn = db::get_connection(db_path).map_err(|error| error.to_string())?;
    if let Some(signature) = ledger_signature(db_path) {
        let rows = gateway_rows_cached(db_path, &signature)?;
        install_overlay(&conn, &rows).map_err(|error| error.to_string())?;
    }
    Ok(conn)
}

/// Source (`gateway` or `imported-magpie`) and provider of a merged row on a
/// connection from `open_stats_connection`.
pub(super) fn gateway_provider(conn: &Connection, id: i64) -> Option<(String, String)> {
    if id >= 0 {
        return None;
    }
    conn.query_row(
        "SELECT source, provider FROM temp.gw_rows WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .ok()
}

#[cfg(test)]
#[path = "gateway_overlay_tests.rs"]
mod tests;

#[cfg(test)]
mod retry_accounting_tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn legacy_and_new_retries_preserve_success_and_chargeable_failures() {
        let dir = std::env::temp_dir().join(format!("tl-retry-overlay-{}", std::process::id()));
        fs::create_dir_all(dir.join("gateway")).unwrap();
        let db = dir.join("test.db");
        let base = json!({"ts":"2026-10-05T00:00:00Z", "requestId":"legacy", "agent":"codex", "session":null,
            "endpoint":"responses", "provider":"p", "requestedModel":"group/g", "upstreamModel":"m", "wire":"chat",
            "stream":false, "status":503, "ok":false, "input":0, "output":0, "cacheRead":0, "cacheWrite":0, "latencyMs":1, "error":"retry"});
        let mut lines = vec![base.clone()];
        let mut success = base.clone();
        success["ok"] = json!(true);
        success["input"] = json!(10);
        success["status"] = json!(200);
        lines.push(success.clone());
        lines.push(success.clone());
        let mut failed = base.clone();
        failed["input"] = json!(3);
        lines.push(failed.clone());
        lines.push(failed);
        let mut diagnostic = base.clone();
        diagnostic["requestId"] = json!("n1");
        diagnostic["logicalRequestId"] = json!("new");
        lines.push(diagnostic);
        let mut new_failed = base.clone();
        new_failed["requestId"] = json!("n2");
        new_failed["logicalRequestId"] = json!("new");
        new_failed["input"] = json!(4);
        lines.push(new_failed.clone());
        lines.push(new_failed);
        success["requestId"] = json!("n3");
        success["logicalRequestId"] = json!("new");
        lines.push(success.clone());
        success["requestId"] = json!("n4");
        lines.push(success);
        let text = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(dir.join("gateway/usage-v1.jsonl"), text).unwrap();
        let rows = read_gateway_rows(&db).unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows.iter().map(|r| r.input_tokens).sum::<i64>(), 27);
        assert_eq!(rows.iter().map(|r| r.id).collect::<BTreeSet<_>>().len(), 4);
        // A matching scanned success is replaced once; unrelated usage remains.
        let row = rows.iter().find(|r| r.request_id == "n3").unwrap();
        let scans = vec![ScanCandidate {
            id: 1,
            tool: "codex".into(),
            session_id: "scan".into(),
            timestamp: row.timestamp.clone(),
            input_tokens: 10,
            output_tokens: 0,
            cached_tokens: 0,
        }];
        assert_eq!(superseded_scan_ids(&rows, &scans, 5), BTreeSet::from([1]));
        fs::remove_dir_all(dir).unwrap();
    }
}
