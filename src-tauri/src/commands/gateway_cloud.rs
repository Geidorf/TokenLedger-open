//! Gateway-merged hourly aggregates for cloud sync (dashboard-stats-v2 §2.5,
//! "云端合并上传"). Dedupe runs here, before upload: the cloud only holds
//! hourly aggregates and cannot tell which scanned rows the gateway superseded.
//!
//! Hours touched by the gateway (its own rows and the scans it superseded) are
//! re-aggregated from the merged rows and upserted under the same unique keys
//! as scan-only aggregates; keys the merge no longer produces are deleted. A
//! small state file remembers what was uploaded per hour so unchanged hours
//! are not re-sent.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::gateway_overlay;
use crate::db;
use crate::gateway::accounting::Coverage;

const STATE_FILE: &str = "cloud-sync-v1.json";
const STATE_VERSION: u32 = 1;
const HOURS_PER_QUERY: usize = 500;

/// One stats row of an hour touched by the gateway.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct HourRow {
    pub id: i64,
    pub sync_revision: i64,
    pub tool: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub cache_write_tokens: i64,
    pub cache_write_known: Option<bool>,
    pub cost_usd: Option<f64>,
    /// Already resolved to the fallback machine id when empty.
    pub machine_id: String,
    /// A scanned row not yet synced for the current cloud user.
    pub pending: bool,
    pub gateway: bool,
    pub superseded: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Aggregate {
    pub tool: String,
    pub model: String,
    pub hour: String,
    pub machine_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub cache_write_tokens: i64,
    pub cache_write_known: bool,
    pub requests: i64,
    pub gateway_requests: i64,
    pub cost_usd: f64,
}

impl Aggregate {
    pub fn unique_key(&self) -> String {
        unique_key(&self.machine_id, &self.tool, &self.model, &self.hour)
    }

    pub fn payload(&self, user_id: &str) -> Value {
        json!({
            "user_id": user_id,
            "tool": self.tool,
            "model": self.model,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cached_tokens": self.cached_tokens,
            "cache_write_tokens": self.cache_write_known.then_some(self.cache_write_tokens),
            "timestamp": self.hour,
            "session_id": "agg",
            "unique_key": self.unique_key(),
            "cost_usd": self.cost_usd,
            "machine_id": self.machine_id,
            "requests": self.requests,
            "gateway_requests": self.gateway_requests
        })
    }
}

/// `YYYY-MM-DD HH:00:00` bucket of a storage timestamp, as cloud sync uses.
pub(super) fn hour_bucket(timestamp: &str) -> String {
    match timestamp.get(0..13) {
        Some(prefix) => format!("{prefix}:00:00"),
        None => timestamp.to_string(),
    }
}

pub(super) fn unique_key(machine_id: &str, tool: &str, model: &str, hour: &str) -> String {
    format!("agg_{machine_id}_{tool}_{model}_{hour}")
}

/// Aggregates of one hour; superseded scans are left out.
pub(super) fn aggregate_hour(
    hour: &str,
    rows: &[HourRow],
    cost_of: &dyn Fn(&HourRow) -> f64,
) -> Vec<Aggregate> {
    let mut groups: BTreeMap<(&str, &str, &str), Aggregate> = BTreeMap::new();
    for row in rows.iter().filter(|row| !row.superseded) {
        let entry = groups
            .entry((&row.machine_id, &row.tool, &row.model))
            .or_insert_with(|| Aggregate {
                tool: row.tool.clone(),
                model: row.model.clone(),
                hour: hour.to_string(),
                machine_id: row.machine_id.clone(),
                input_tokens: 0,
                output_tokens: 0,
                cached_tokens: 0,
                cache_write_tokens: 0,
                cache_write_known: true,
                requests: 0,
                gateway_requests: 0,
                cost_usd: 0.0,
            });
        entry.input_tokens += row.input_tokens;
        entry.output_tokens += row.output_tokens;
        entry.cached_tokens += row.cached_tokens;
        entry.cache_write_tokens += row.cache_write_tokens;
        entry.cache_write_known &= row.cache_write_known != Some(false);
        entry.requests += 1;
        entry.gateway_requests += i64::from(row.gateway);
        entry.cost_usd += cost_of(row);
    }
    groups.into_values().collect()
}

/// Token and request shape of an hour. Cost is left out so a price table
/// change does not re-upload hours whose usage did not change.
fn fingerprint(aggregates: &[Aggregate]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for agg in aggregates {
        let line = format!(
            "{}|{}|{}|{}|{}|{}|{}|{}\n",
            agg.unique_key(),
            agg.input_tokens,
            agg.output_tokens,
            agg.cached_tokens,
            agg.cache_write_tokens,
            agg.requests,
            agg.gateway_requests,
            agg.cache_write_known
        );
        for byte in line.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{hash:016x}")
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HourState {
    pub fingerprint: String,
    pub keys: Vec<String>,
}

/// What was last uploaded for each gateway-touched hour of one user/machine.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloudState {
    pub version: u32,
    pub user_id: String,
    pub machine_id: String,
    pub hours: BTreeMap<String, HourState>,
}

#[derive(Debug, Default)]
pub(super) struct GatewayPlan {
    /// Every gateway-touched hour; the scan-only aggregation must skip them.
    pub hours: BTreeSet<String>,
    pub upserts: Vec<Aggregate>,
    pub deletes: Vec<String>,
    /// Pending scanned rows covered by the upserted hours.
    pub mark_ids: Vec<(i64, i64)>,
    pub next_state: CloudState,
}

impl GatewayPlan {
    pub fn has_work(&self) -> bool {
        !self.upserts.is_empty() || !self.deletes.is_empty() || !self.mark_ids.is_empty()
    }
}

/// Decides which gateway-touched hours to re-upload. An hour is re-sent when
/// its merged fingerprint differs from the last upload or it has pending
/// scanned rows; stale keys are those uploaded before (or produced by the
/// scan-only aggregation) that the merge no longer produces.
pub(super) fn plan(
    hours: &BTreeMap<String, Vec<HourRow>>,
    state: &CloudState,
    user_id: &str,
    machine_id: &str,
    cost_of: &dyn Fn(&HourRow) -> f64,
) -> GatewayPlan {
    let previous = (state.version == STATE_VERSION
        && state.user_id == user_id
        && state.machine_id == machine_id)
        .then_some(&state.hours);
    let mut plan = GatewayPlan {
        next_state: CloudState {
            version: STATE_VERSION,
            user_id: user_id.to_string(),
            machine_id: machine_id.to_string(),
            hours: previous.cloned().unwrap_or_default(),
        },
        ..GatewayPlan::default()
    };
    for (hour, rows) in hours {
        let aggregates = aggregate_hour(hour, rows, cost_of);
        let fingerprint = fingerprint(&aggregates);
        let keys: Vec<String> = aggregates.iter().map(Aggregate::unique_key).collect();
        let last = previous.and_then(|hours| hours.get(hour));
        let pending: Vec<(i64, i64)> = rows
            .iter()
            .filter(|row| row.pending && !row.gateway)
            .map(|row| (row.id, row.sync_revision))
            .collect();
        if !pending.is_empty() || last.map(|state| &state.fingerprint) != Some(&fingerprint) {
            let mut stale: BTreeSet<String> = last
                .map(|state| state.keys.iter().cloned().collect())
                .unwrap_or_default();
            stale.extend(
                rows.iter()
                    .filter(|row| !row.gateway)
                    .map(|row| unique_key(&row.machine_id, &row.tool, &row.model, hour)),
            );
            for key in &keys {
                stale.remove(key);
            }
            plan.deletes.extend(stale);
            plan.upserts.extend(aggregates);
            plan.mark_ids.extend(pending);
        }
        plan.hours.insert(hour.clone());
        if rows.iter().any(|row| row.gateway || row.superseded) {
            plan.next_state
                .hours
                .insert(hour.clone(), HourState { fingerprint, keys });
        } else {
            // Back to scan-only and uploaded as such above: the scan-only
            // aggregation owns the hour again.
            plan.next_state.hours.remove(hour);
        }
    }
    plan
}

/// The sync coordinator protects incomplete legacy hours across every write path.
/// This is quality metadata only; it neither clears history nor invents missing rows.
pub(super) fn accounting_coverage(db_path: &Path) -> Result<Option<Coverage>, String> {
    gateway_overlay::accounting_coverage(db_path)
}

/// Rows of every hour touched by the gateway, with superseded scans flagged.
/// Empty when there is no readable ledger.
pub(super) fn collect_hours(
    db_path: &Path,
    user_id: &str,
    fallback_machine: &str,
) -> Result<BTreeMap<String, Vec<HourRow>>, String> {
    collect_hours_with_scan_hook(db_path, user_id, fallback_machine, || {})
}

fn collect_hours_with_scan_hook(
    db_path: &Path,
    user_id: &str,
    fallback_machine: &str,
    after_candidates: impl FnOnce(),
) -> Result<BTreeMap<String, Vec<HourRow>>, String> {
    let mut hours: BTreeMap<String, Vec<HourRow>> = BTreeMap::new();
    // Hours uploaded from merged rows before stay touched even when their
    // gateway or imported rows are gone (an import removed or replaced, a row
    // now held): they are re-aggregated, so stale merged keys are deleted and
    // the scan-only totals restored rather than left in the cloud.
    let state = load_state(db_path);
    let previous: Vec<String> = if state.version == STATE_VERSION
        && state.user_id == user_id
        && state.machine_id == fallback_machine
    {
        state.hours.keys().cloned().collect()
    } else {
        Vec::new()
    };
    let gateway = match gateway_overlay::ledger_signature(db_path) {
        Some(signature) => gateway_overlay::gateway_rows_cached(db_path, &signature)?,
        None => std::sync::Arc::new(Vec::new()),
    };
    if gateway.is_empty() && previous.is_empty() {
        return Ok(hours);
    }
    let mut conn = db::get_connection(db_path).map_err(|error| error.to_string())?;
    // Dedupe and receipts must describe the same WAL snapshot. Otherwise a
    // stale superseded ID can accidentally acknowledge a newer scan revision.
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let scans =
        gateway_overlay::scan_candidates(&tx, &gateway).map_err(|error| error.to_string())?;
    after_candidates();
    let gateway_overlay::OverlayResolution { superseded, held } =
        gateway_overlay::resolve_overlay(&gateway, &scans, gateway_overlay::DEDUPE_WINDOW_SECS);
    let mut touched: BTreeSet<String> = gateway
        .iter()
        .filter(|row| !held.contains(&row.id))
        .map(|row| hour_bucket(&row.timestamp))
        .collect();
    touched.extend(
        scans
            .iter()
            .filter(|scan| superseded.contains(&scan.id))
            .map(|scan| hour_bucket(&scan.timestamp)),
    );
    touched.extend(previous);

    let touched: Vec<String> = touched.into_iter().collect();
    // An hour left with no rows at all still needs its uploaded keys deleted.
    for hour in &touched {
        hours.entry(hour.clone()).or_default();
    }
    for chunk in touched.chunks(HOURS_PER_QUERY) {
        let sql = format!(
            "SELECT id, tool, model, input_tokens, output_tokens, COALESCE(cached_tokens, 0),
                    COALESCE(cache_write_tokens, 0), timestamp, cost_usd,
                    COALESCE(machine_id, ''), sync_status, cloud_user_id, sync_revision, cache_write_known
               FROM main.token_logs
              WHERE substr(timestamp, 1, 13) || ':00:00' IN ({})",
            vec!["?"; chunk.len()].join(", ")
        );
        let values: Vec<SqlValue> = chunk.iter().cloned().map(SqlValue::Text).collect();
        let mut stmt = tx.prepare(&sql).map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(values.iter()), |row| {
                let id: i64 = row.get(0)?;
                let timestamp: String = row.get(7)?;
                let machine_id: String = row.get(9)?;
                let sync_status: i64 = row.get(10)?;
                let cloud_user_id: Option<String> = row.get(11)?;
                Ok((
                    hour_bucket(&timestamp),
                    HourRow {
                        id,
                        sync_revision: row.get(12)?,
                        tool: row.get(1)?,
                        model: row.get(2)?,
                        input_tokens: row.get(3)?,
                        output_tokens: row.get(4)?,
                        cached_tokens: row.get(5)?,
                        cache_write_tokens: row.get(6)?,
                        cache_write_known: row.get(13)?,
                        cost_usd: row.get(8)?,
                        machine_id: if machine_id.is_empty() {
                            fallback_machine.to_string()
                        } else {
                            machine_id
                        },
                        pending: sync_status == 0 || cloud_user_id.as_deref() != Some(user_id),
                        gateway: false,
                        superseded: superseded.contains(&id),
                    },
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (hour, row) = row.map_err(|error| error.to_string())?;
            hours.entry(hour).or_default().push(row);
        }
    }
    for row in gateway.iter().filter(|row| !held.contains(&row.id)) {
        hours
            .entry(hour_bucket(&row.timestamp))
            .or_default()
            .push(HourRow {
                id: row.id,
                sync_revision: 0, // Gateway rows are not marked in the local scan ledger.
                tool: row.tool.clone(),
                model: row.model.clone(),
                input_tokens: row.input_tokens,
                output_tokens: row.output_tokens,
                cached_tokens: row.cached_tokens,
                cache_write_tokens: row.cache_write_tokens,
                cache_write_known: None,
                cost_usd: None,
                machine_id: fallback_machine.to_string(),
                pending: false,
                gateway: true,
                superseded: false,
            });
    }
    Ok(hours)
}

/// PostgREST `in.(...)` filter value; every key is quoted because model names
/// may contain commas, parentheses or quotes.
pub(super) fn postgrest_in_filter(keys: &[String]) -> String {
    let quoted: Vec<String> = keys
        .iter()
        .map(|key| format!("\"{}\"", key.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("in.({})", quoted.join(","))
}

fn gateway_state_path(db_path: &Path) -> PathBuf {
    gateway_overlay::gateway_dir(db_path).join(STATE_FILE)
}

/// Where an install whose merged rows are only imported ones (no gateway)
/// keeps its state: a state file in the gateway folder is legacy-history
/// evidence to the accounting store (§2.5), which must not be faked.
fn import_state_path(db_path: &Path) -> PathBuf {
    super::magpie_import::store_dir(db_path).join(STATE_FILE)
}

fn state_path(db_path: &Path) -> PathBuf {
    if gateway_overlay::accounting_present(db_path) {
        gateway_state_path(db_path)
    } else {
        import_state_path(db_path)
    }
}

/// A missing or unreadable state only costs one extra upload.
pub(super) fn load_state(db_path: &Path) -> CloudState {
    let read = |path: PathBuf| {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    };
    read(state_path(db_path))
        .or_else(|| read(import_state_path(db_path)))
        .unwrap_or_default()
}

pub(super) fn save_state(db_path: &Path, state: &CloudState) -> Result<(), String> {
    let path = state_path(db_path);
    if state.hours.is_empty() && !path.exists() {
        return Ok(());
    }
    let body = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("写入网关云同步状态失败：{error}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)
        .and_then(|_| fs::rename(&tmp, &path))
        .map_err(|error| format!("写入网关云同步状态失败：{error}"))?;
    if path == gateway_state_path(db_path) {
        // The gateway's state now carries the imported hours too.
        let _ = fs::remove_file(import_state_path(db_path));
    }
    Ok(())
}

#[cfg(test)]
#[path = "gateway_cloud_tests.rs"]
mod tests;
