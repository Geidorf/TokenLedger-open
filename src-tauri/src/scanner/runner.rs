use super::antigravity::*;
use super::claude::*;
use super::codex::*;
use super::dsh::*;
use super::gemini::*;
use super::grok::*;
use super::helpers::*;
use super::kimi::*;
use super::minimax::*;
use super::other_tools::*;
use super::pi::*;
use super::reasonix::*;
use super::types::{
    AntigravityRecordProvenance, AntigravityUsageProvenance, CoordinatedScanOutcome, LogRecord,
    ScanOutcome,
};
use chrono::Local;
use rusqlite::{params, OptionalExtension, Result};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

type SharedScanResult = std::result::Result<ScanOutcome, String>;

#[derive(Default)]
pub(crate) struct ScanFlight {
    result: Mutex<Option<SharedScanResult>>,
    ready: Condvar,
}

pub(crate) fn active_scan_flights() -> &'static Mutex<HashMap<PathBuf, Arc<ScanFlight>>> {
    static FLIGHTS: OnceLock<Mutex<HashMap<PathBuf, Arc<ScanFlight>>>> = OnceLock::new();
    FLIGHTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn run_scan_singleflight_with<F>(db_path: &Path, scan: F) -> (SharedScanResult, bool)
where
    F: FnOnce() -> SharedScanResult,
{
    let key = db_path.to_path_buf();
    let (flight, is_leader) = {
        let mut active = active_scan_flights()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(flight) = active.get(&key) {
            (Arc::clone(flight), false)
        } else {
            let flight = Arc::new(ScanFlight::default());
            active.insert(key.clone(), Arc::clone(&flight));
            (flight, true)
        }
    };

    if !is_leader {
        let mut result = flight
            .result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while result.is_none() {
            result = flight
                .ready
                .wait(result)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        return (
            result
                .as_ref()
                .expect("scan result is present after wait")
                .clone(),
            false,
        );
    }

    // Convert an unexpected scanner panic into a shared error so followers
    // are always released instead of waiting forever on a poisoned flight.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(scan))
        .unwrap_or_else(|_| Err("scanner task panicked".to_string()));
    {
        let mut shared = flight
            .result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *shared = Some(result.clone());
        flight.ready.notify_all();
    }
    {
        let mut active = active_scan_flights()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &flight))
        {
            active.remove(&key);
        }
    }
    (result, true)
}

/// Runs at most one filesystem scan for a database at a time. Concurrent
/// scheduler and UI refreshes wait for and reuse the same result.
pub fn run_scan_singleflight(
    db_path: &Path,
) -> std::result::Result<CoordinatedScanOutcome, String> {
    let (outcome, is_leader) = run_scan_singleflight_with(db_path, || {
        run_scan(db_path).map_err(|error| error.to_string())
    });
    Ok(CoordinatedScanOutcome {
        outcome: outcome?,
        joined_existing: !is_leader,
    })
}

/// Only model-like identifiers enter the price discovery catalog. Some local
/// tools also write UI modes or injected prompt text into fields named
/// `model`, so accepting arbitrary strings here would pollute the price table.
pub(crate) fn model_discovery_key(model: &str) -> Option<String> {
    let cleaned = clean_model_name(model);
    let key = cleaned.trim().to_ascii_lowercase();
    if key.is_empty() || key.len() > 96 {
        return None;
    }
    if !key.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '/' | ':' | '@' | '+')
    }) {
        return None;
    }

    const PLACEHOLDERS: &[&str] = &[
        "unknown",
        "unknown-model",
        "default",
        "claude-unknown",
        "codex-agent",
        "gemini-3.5-flash-agent",
        "minimax-model",
        "reasonix-agent",
        "hermes-agent",
        "kimi-unknown",
        "grok-unknown",
        "gemini-unknown",
        "antigravity-unknown",
        "pi-unknown",
    ];
    if PLACEHOLDERS.contains(&key.as_str())
        || key == "auto"
        || key.starts_with("auto-")
        || key.ends_with("-auto")
    {
        return None;
    }

    Some(key)
}

pub(crate) fn record_discovered_models(
    tx: &rusqlite::Transaction<'_>,
    logs: &[LogRecord],
) -> Result<Vec<String>> {
    let mut observed = HashMap::<(String, String), String>::new();
    for log in logs {
        let Some(model_key) = model_discovery_key(&log.model) else {
            continue;
        };
        let tool = log.tool.trim().to_ascii_lowercase();
        if tool.is_empty() {
            continue;
        }
        observed
            .entry((tool, model_key))
            .or_insert_with(|| log.model.trim().to_string());
    }

    let mut observed = observed.into_iter().collect::<Vec<_>>();
    observed.sort_by(|a, b| a.0.cmp(&b.0));
    let mut newly_discovered = Vec::new();
    let mut newly_discovered_keys = HashSet::new();

    for ((tool, model_key), model) in observed {
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO discovered_models (tool, model_key, model)
             VALUES (?1, ?2, ?3)",
            params![tool, model_key, model],
        )?;
        tx.execute(
            "UPDATE discovered_models
             SET model = ?3, last_seen_at = datetime('now')
             WHERE tool = ?1 AND model_key = ?2 AND model != ?3",
            params![tool, model_key, model],
        )?;
        if inserted > 0 && newly_discovered_keys.insert(model_key.clone()) {
            newly_discovered.push(model_key);
        }
    }

    newly_discovered.sort();
    Ok(newly_discovered)
}

pub fn run_scan(db_path: &Path) -> Result<ScanOutcome> {
    macro_rules! timed_scan_step {
        ($label:literal, $expression:expr) => {{
            let started = std::time::Instant::now();
            let value = $expression;
            if std::env::var_os("TOKENLEDGER_RUN_REAL_SCAN_GATE").is_some() {
                eprintln!("scan timing {}: {:?}", $label, started.elapsed());
            }
            value
        }};
    }
    let mut logs = Vec::new();
    let mut pending_checkpoints = Vec::new();
    let (
        scan_cursors,
        antigravity_checkpoints,
        trae_checkpoints,
        workbuddy_checkpoints,
        deepseekgui_checkpoints,
        dsh_checkpoints,
        grok_checkpoints,
        gemini_checkpoints,
        kimi_checkpoints,
        kimidesktop_checkpoints,
        pi_checkpoints,
    ) = {
        let conn = crate::db::get_connection(db_path)?;
        (
            crate::db::load_scan_source_cursors(&conn)?,
            crate::db::load_scan_checkpoints(&conn, ANTIGRAVITY_CHECKPOINT_SOURCE_KIND)?,
            crate::db::load_scan_checkpoints(&conn, TRAE_CHECKPOINT_SOURCE_KIND)?,
            crate::db::load_scan_checkpoints(&conn, WORKBUDDY_PROJECT_CHECKPOINT_SOURCE_KIND)?,
            crate::db::load_scan_checkpoints(&conn, DEEPSEEKGUI_CHECKPOINT_SOURCE_KIND)?,
            crate::db::load_scan_checkpoints(&conn, DSH_CHECKPOINT_SOURCE_KIND)?,
            crate::db::load_scan_checkpoints(&conn, GROK_CHECKPOINT_SOURCE_KIND)?,
            crate::db::load_scan_checkpoints(&conn, GEMINI_CLI_CHECKPOINT_SOURCE_KIND)?,
            crate::db::load_scan_checkpoints(&conn, KIMI_CHECKPOINT_SOURCE_KIND)?,
            crate::db::load_scan_checkpoints(&conn, KIMI_DESKTOP_CHECKPOINT_SOURCE_KIND)?,
            crate::db::load_scan_checkpoints(&conn, PI_CHECKPOINT_SOURCE_KIND)?,
        )
    };
    let mut pending_cursors = Vec::new();

    let (claude_roots, claude_scan) = timed_scan_step!(
        "claude",
        scan_claude(db_path, &mut logs, &mut pending_checkpoints)
    )?;
    log::debug!(
        "Claude checkpoint scan discovered {} roots, parsed {} files / {} records, skipped {}, failed {}",
        claude_roots,
        claude_scan.parsed_files,
        claude_scan.parsed_records,
        claude_scan.skipped_files,
        claude_scan.failed_files
    );
    let (codex_scan, codex_rebuild_plan, codex_rebuild_deferred) = timed_scan_step!(
        "codex",
        scan_codex(db_path, &mut logs, &mut pending_checkpoints)
    )?;
    log::debug!(
        "Codex checkpoint scan parsed {} files / {} records, skipped {}, failed {}",
        codex_scan.parsed_files,
        codex_scan.parsed_records,
        codex_scan.skipped_files,
        codex_scan.failed_files
    );
    timed_scan_step!(
        "opencode",
        scan_opencode_like(
            &mut logs,
            "opencode",
            ".local/share/opencode/opencode.db",
            &scan_cursors,
            &mut pending_cursors,
        )
    );
    timed_scan_step!(
        "kilo",
        scan_opencode_like(
            &mut logs,
            "kilo",
            ".local/share/kilo/kilo.db",
            &scan_cursors,
            &mut pending_cursors,
        )
    );
    let antigravity_batch =
        timed_scan_step!("antigravity", scan_antigravity(&antigravity_checkpoints));
    logs.extend(antigravity_batch.logs);
    pending_checkpoints.extend(antigravity_batch.checkpoints);
    // Framework-backed rows in ~/.mavis mirror requests that the native
    // opencode/kilo scanners already cover. Skip them iff the native DB file
    // exists — a stable rule that cannot flip between scan passes.
    let opencode_db_exists = get_home_dir()
        .join(".local/share/opencode/opencode.db")
        .exists();
    let kilo_db_exists = get_home_dir().join(".local/share/kilo/kilo.db").exists();
    timed_scan_step!(
        "minimax",
        scan_minimax_marvis_incremental(
            &mut logs,
            opencode_db_exists,
            kilo_db_exists,
            &scan_cursors,
            &mut pending_cursors,
        )
    );
    timed_scan_step!(
        "tencent-marvis",
        scan_tencent_marvis(&mut logs, &scan_cursors, &mut pending_cursors)
    );
    timed_scan_step!(
        "workbuddy",
        scan_workbuddy(&mut logs, &workbuddy_checkpoints, &mut pending_checkpoints)
    );
    timed_scan_step!("qclaw", scan_qclaw(&mut logs));
    timed_scan_step!("hermes", scan_hermes(&mut logs));
    timed_scan_step!("reasonix", scan_reasonix(&mut logs));
    timed_scan_step!(
        "trae",
        scan_trae(&mut logs, &trae_checkpoints, &mut pending_checkpoints)
    );
    timed_scan_step!(
        "deepseekgui",
        scan_deepseekgui(
            &mut logs,
            &deepseekgui_checkpoints,
            &mut pending_checkpoints
        )
    );
    timed_scan_step!(
        "dsh",
        scan_dsh(&mut logs, &dsh_checkpoints, &mut pending_checkpoints)
    );
    timed_scan_step!(
        "grok",
        scan_grok(&mut logs, &grok_checkpoints, &mut pending_checkpoints)
    );
    timed_scan_step!(
        "gemini",
        scan_gemini(&mut logs, &gemini_checkpoints, &mut pending_checkpoints)
    );
    timed_scan_step!("zcode", scan_zcode(&mut logs));
    timed_scan_step!(
        "kimi",
        scan_kimi(&mut logs, &kimi_checkpoints, &mut pending_checkpoints)
    );
    timed_scan_step!(
        "kimidesktop",
        scan_kimi_desktop(
            &mut logs,
            &kimidesktop_checkpoints,
            &mut pending_checkpoints
        )
    );
    timed_scan_step!(
        "pi",
        scan_pi(&mut logs, &pi_checkpoints, &mut pending_checkpoints)
    );

    let mut outcome = timed_scan_step!(
        "persist",
        persist_scan_batch_with_antigravity(
            db_path,
            logs,
            pending_checkpoints,
            pending_cursors,
            codex_rebuild_plan,
            &antigravity_batch.provenance,
        )
    )?;
    // Opt-in project index (T10.165): a no-op unless the user enabled it;
    // resolution runs on its own thread, outside the scan transaction.
    crate::project_index::notify_scan_persisted(db_path, outcome.inserted > 0);
    outcome.codex_rebuild_deferred = codex_rebuild_deferred;
    outcome.codex_rebuild_failed_files = if codex_rebuild_deferred {
        codex_scan.failed_files
    } else {
        0
    };
    Ok(outcome)
}

#[cfg(test)]
pub(crate) fn persist_scan_batch(
    db_path: &Path,
    logs: Vec<LogRecord>,
    pending_checkpoints: Vec<crate::db::ScanCheckpoint>,
    pending_cursors: Vec<crate::db::ScanSourceCursor>,
    codex_rebuild_plan: Option<crate::db::CodexRebuildPlan>,
) -> Result<ScanOutcome> {
    persist_scan_batch_with_antigravity(
        db_path,
        logs,
        pending_checkpoints,
        pending_cursors,
        codex_rebuild_plan,
        &HashMap::new(),
    )
}

pub(crate) fn persist_scan_batch_with_antigravity(
    db_path: &Path,
    logs: Vec<LogRecord>,
    pending_checkpoints: Vec<crate::db::ScanCheckpoint>,
    pending_cursors: Vec<crate::db::ScanSourceCursor>,
    codex_rebuild_plan: Option<crate::db::CodexRebuildPlan>,
    provenance: &HashMap<String, AntigravityRecordProvenance>,
) -> Result<ScanOutcome> {
    if logs.is_empty()
        && pending_checkpoints.is_empty()
        && pending_cursors.is_empty()
        && codex_rebuild_plan.is_none()
    {
        return Ok(ScanOutcome::default());
    }

    // Connect and save（统一走连接工厂：busy_timeout 5s + synchronous=NORMAL，
    // 否则与 UI 侧保存价格等写事务争用时会直接抛出 SQLITE_BUSY）
    let mut conn = crate::db::get_connection(db_path)?;
    let tx = conn.transaction()?;
    let discovered_models = record_discovered_models(&tx, &logs)?;

    // Retrieve machine ID (hostname) to write
    let machine_id = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown_machine".to_string());

    let mut inserted = if let Some(plan) = codex_rebuild_plan.as_ref() {
        crate::db::prepare_codex_rebuild_swap(&tx, &machine_id, plan)?
    } else {
        0
    };
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO token_logs
             (tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
        )?;

        for log in logs {
            if log.tool == "antigravity" {
                let metadata = provenance.get(&log.unique_key).copied().unwrap_or(
                    AntigravityRecordProvenance {
                        usage: AntigravityUsageProvenance::Estimated,
                        cache_write_known: false,
                    },
                );
                inserted += persist_antigravity_record(&tx, &log, metadata, &machine_id)?;
                continue;
            }
            if log.cumulative {
                if insert_cumulative_delta(&tx, &log, &machine_id)? {
                    inserted += 1;
                }
                continue;
            }
            let rowcount = stmt.execute(params![
                log.tool,
                log.model,
                log.input_tokens,
                log.output_tokens,
                log.cached_tokens,
                log.cache_write_tokens,
                log.timestamp,
                log.session_id,
                log.unique_key,
                log.cost_usd,
                machine_id,
            ])?;
            if rowcount > 0 {
                inserted += 1;
            } else if log.tool == "claude" {
                // Claude writes growing streaming snapshots under one stable
                // message id. INSERT OR IGNORE alone can freeze a row at the
                // first one-token placeholder forever, so accept only a
                // strictly more complete snapshot and re-queue cloud sync.
                let updated = tx.execute(
                    "UPDATE token_logs
                     SET model = ?1,
                         input_tokens = ?2,
                         output_tokens = ?3,
                         cached_tokens = ?4,
                         cache_write_tokens = ?5,
                         timestamp = ?6,
                         session_id = ?7,
                         cost_usd = ?8,
                         machine_id = ?9,
                         sync_status = 0
                     WHERE unique_key = ?10
                       AND tool = 'claude'
                       AND (
                           output_tokens < ?3
                           OR (
                               output_tokens = ?3
                               AND input_tokens + cached_tokens < ?2 + ?4
                           )
                           OR (
                               output_tokens = ?3
                               AND input_tokens + cached_tokens = ?2 + ?4
                               AND cache_write_tokens < ?5
                           )
                       )",
                    params![
                        log.model,
                        log.input_tokens,
                        log.output_tokens,
                        log.cached_tokens,
                        log.cache_write_tokens,
                        log.timestamp,
                        log.session_id,
                        log.cost_usd,
                        machine_id,
                        log.unique_key,
                    ],
                )?;
                // ScanOutcome::inserted is the existing persisted-change
                // signal used for cache invalidation and refresh events. Count
                // monotonic Claude corrections as changes without adding rows.
                inserted += updated;
            } else if log.tool == "opencode" || log.tool == "kilo" {
                // These provider rows can be updated in place while a response
                // is streaming. Their keyset cursor follows time_updated, so a
                // changed snapshot must replace the local row and be re-synced.
                let updated = tx.execute(
                    "UPDATE token_logs
                     SET model = ?1,
                         input_tokens = ?2,
                         output_tokens = ?3,
                         cached_tokens = ?4,
                         cache_write_tokens = ?5,
                         timestamp = ?6,
                         session_id = ?7,
                         cost_usd = ?8,
                         machine_id = ?9,
                         sync_status = 0
                     WHERE unique_key = ?10
                       AND tool = ?11
                       AND (
                           model != ?1 OR input_tokens != ?2 OR output_tokens != ?3
                           OR cached_tokens != ?4 OR cache_write_tokens != ?5
                           OR timestamp != ?6 OR session_id != ?7
                           OR cost_usd IS NOT ?8
                       )",
                    params![
                        log.model,
                        log.input_tokens,
                        log.output_tokens,
                        log.cached_tokens,
                        log.cache_write_tokens,
                        log.timestamp,
                        log.session_id,
                        log.cost_usd,
                        machine_id,
                        log.unique_key,
                        log.tool,
                    ],
                )?;
                inserted += updated;
            } else if log.tool == "codex" && log.model != "codex-agent" {
                // Earlier builds stored every codex row under the "codex-agent"
                // placeholder; INSERT OR IGNORE leaves those rows untouched on
                // rescan. Now that the real model is parsed from turn_context,
                // correct the historical row in place and re-queue it for sync
                // (the cloud upsert keys on (user_id, unique_key), so resetting
                // sync_status overwrites the stale cloud copy). The model guard
                // makes this a no-op once a row has been corrected.
                tx.execute(
                    "UPDATE token_logs SET model = ?1, sync_status = 0
                     WHERE unique_key = ?2 AND tool = 'codex' AND model != ?1",
                    params![log.model, log.unique_key],
                )?;
            } else if log.tool == "minimax" || log.unique_key.starts_with("mavis_") {
                // MiniMax Code rows used to be written with a fabricated
                // `mavis-{agent}` model (since T10.81, `minimax-unknown`), and
                // rows whose model did not start with "minimax" were even
                // filed under the unrelated Tencent Marvis tool. INSERT OR
                // IGNORE leaves an already-stored row frozen at whatever label
                // it first received, so re-scanning alone cannot repair it.
                //
                // Scope by the `mavis_` unique_key namespace, which is
                // MiniMax Code's alone: Tencent Marvis rows are keyed
                // `marvis_tencent_*` / `tencent_*`, and the difference between
                // `mavis` and `marvis` is the literal `r`, so neither prefix
                // can be captured by the other. Resetting sync_status lets the
                // cloud upsert on (user_id, unique_key) overwrite the stale
                // labels; the difference guard makes this a no-op once a row is
                // already correct.
                let updated = tx.execute(
                    "UPDATE token_logs
                        SET tool = ?1,
                            model = ?2,
                            cost_usd = ?3,
                            sync_status = 0
                      WHERE unique_key = ?4
                        AND unique_key LIKE 'mavis\\_%' ESCAPE '\\'
                        AND (tool != ?1 OR model != ?2 OR cost_usd IS NOT ?3)",
                    params![log.tool, log.model, log.cost_usd, log.unique_key,],
                )?;
                inserted += updated;
            }
        }
    }

    // Checkpoints and rows commit atomically. A parser/read/SQLite failure can
    // therefore never mark bytes as processed without the corresponding rows.
    crate::db::upsert_scan_checkpoints(&tx, &pending_checkpoints)?;
    crate::db::upsert_scan_source_cursors(&tx, &pending_cursors)?;
    if codex_rebuild_plan.is_some() {
        crate::db::complete_codex_rebuild_swap(&tx, &machine_id)?;
    }

    tx.commit()?;
    Ok(ScanOutcome {
        inserted,
        discovered_models,
        ..ScanOutcome::default()
    })
}

// Reported rows can replace earlier estimates and complete snapshots (including
// decreases). Estimates may correct estimates; persisted reported provenance
// fences downgrades across restarts and source loss.
fn persist_antigravity_record(
    tx: &rusqlite::Transaction<'_>,
    row: &LogRecord,
    metadata: AntigravityRecordProvenance,
    machine: &str,
) -> Result<usize> {
    tx.execute(
        "INSERT INTO token_logs
         (tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,
          session_id,unique_key,cost_usd,machine_id,sync_status,usage_provenance,cache_write_known)
         VALUES ('antigravity',?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11,?12)
         ON CONFLICT(unique_key) DO UPDATE SET
           model=excluded.model,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
           cached_tokens=excluded.cached_tokens,cache_write_tokens=excluded.cache_write_tokens,
           timestamp=excluded.timestamp,session_id=excluded.session_id,cost_usd=excluded.cost_usd,
           machine_id=excluded.machine_id,sync_status=0,usage_provenance=excluded.usage_provenance,
           cache_write_known=excluded.cache_write_known
         WHERE token_logs.tool='antigravity'
           AND (excluded.usage_provenance='reported'
             OR (excluded.usage_provenance='estimated' AND token_logs.usage_provenance='estimated'))
           AND (token_logs.model IS NOT excluded.model OR token_logs.input_tokens IS NOT excluded.input_tokens
             OR token_logs.output_tokens IS NOT excluded.output_tokens OR token_logs.cached_tokens IS NOT excluded.cached_tokens
             OR token_logs.cache_write_tokens IS NOT excluded.cache_write_tokens OR token_logs.timestamp IS NOT excluded.timestamp
             OR token_logs.session_id IS NOT excluded.session_id OR token_logs.machine_id IS NOT excluded.machine_id
             OR token_logs.usage_provenance IS NOT excluded.usage_provenance
             OR token_logs.cache_write_known IS NOT excluded.cache_write_known)",
        params![row.model,row.input_tokens,row.output_tokens,row.cached_tokens,row.cache_write_tokens,
            row.timestamp,row.session_id,row.unique_key,row.cost_usd,machine,metadata.usage.as_str(),metadata.cache_write_known],
    )
}

/// Stores a cumulative session snapshot as delta rows.
///
/// The record's `unique_key` acts as a base key; the first sighting is stored
/// under it verbatim with the source timestamp. When the source totals grow,
/// a delta row keyed `{base}#g{generation}#t{in}_{out}_{cached}` is inserted, timestamped
/// "now" (the growth happened since the previous scan, not at session start).
/// The suffix is derived from the source totals, so rescanning an unchanged
/// source maps to an existing key and INSERT OR IGNORE keeps this idempotent.
///
/// Shrinking totals (source DB reset, session id reuse) never invent a row,
/// but they do re-baseline the stored state: keeping the old high-water mark
/// would silently swallow every later increment until the reset source grew
/// past it again.
pub(crate) fn insert_cumulative_delta(
    tx: &rusqlite::Transaction,
    log: &LogRecord,
    machine_id: &str,
) -> Result<bool> {
    let stored_state: Option<(i64, i64, i64, i64, Option<f64>, i64)> = tx
        .query_row(
            "SELECT input_tokens, output_tokens, cached_tokens,
                    cache_write_tokens, cost_usd, generation
             FROM scan_cumulative_state WHERE unique_key = ?1",
            params![log.unique_key],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;

    // Compatibility bridge for databases created before scan_cumulative_state:
    // pay the historical aggregate query once per cumulative source, then all
    // later scans use the O(1) state row.
    let had_stored_state = stored_state.is_some();
    let generation = stored_state.as_ref().map_or(0, |state| state.5);
    let (rows, sum_in, sum_out, sum_cached, sum_write, sum_cost) = if let Some(state) = stored_state
    {
        (
            1_i64,
            state.0,
            state.1,
            state.2,
            state.3,
            state.4.unwrap_or(0.0),
        )
    } else {
        tx.query_row(
            "SELECT COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cached_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0),
                COALESCE(SUM(cost_usd), 0.0)
         FROM token_logs
         WHERE unique_key = ?1 OR unique_key LIKE ?1 || '#%'",
            params![log.unique_key],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )?
    };

    let (unique_key, timestamp, d_in, d_out, d_cached, d_write, d_cost) = if rows == 0 {
        (
            log.unique_key.clone(),
            log.timestamp.clone(),
            log.input_tokens,
            log.output_tokens,
            log.cached_tokens,
            log.cache_write_tokens,
            log.cost_usd,
        )
    } else {
        let d_in = log.input_tokens - sum_in;
        let d_out = log.output_tokens - sum_out;
        let d_cached = log.cached_tokens - sum_cached;
        let d_write = log.cache_write_tokens - sum_write;
        if d_in < 0 || d_out < 0 || d_cached < 0 {
            log::debug!(
                "cumulative source shrank for {} (Δin={d_in}, Δout={d_out}); re-baselining",
                log.unique_key
            );
            upsert_cumulative_state(
                tx,
                log,
                generation
                    .checked_add(1)
                    .ok_or(rusqlite::Error::InvalidQuery)?,
            )?;
            return Ok(false);
        }
        if d_in == 0 && d_out == 0 && d_cached == 0 {
            if !had_stored_state {
                upsert_cumulative_state(tx, log, generation)?;
            }
            return Ok(false);
        }
        // Only a real increase is a provider-reported cost for this delta.
        // Clamping a flat or shrinking total to 0.0 used to pin the row at $0
        // permanently, because repricing only revisits rows whose cost is
        // NULL — exactly what happens when a session keeps spending tokens on
        // a relay provider the source cannot price.
        let d_cost = log
            .cost_usd
            .map(|c| c - sum_cost)
            .filter(|delta| *delta > 0.0);
        (
            if generation == 0 {
                // Preserve the dedup keys of pre-v15 increments.
                format!(
                    "{}#t{}_{}_{}",
                    log.unique_key, log.input_tokens, log.output_tokens, log.cached_tokens
                )
            } else {
                format!(
                    "{}#g{}#t{}_{}_{}",
                    log.unique_key,
                    generation,
                    log.input_tokens,
                    log.output_tokens,
                    log.cached_tokens
                )
            },
            Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            d_in,
            d_out,
            d_cached,
            d_write.max(0),
            d_cost,
        )
    };

    let rowcount = tx.execute(
        "INSERT OR IGNORE INTO token_logs
         (tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        params![
            log.tool,
            log.model,
            d_in,
            d_out,
            d_cached,
            d_write,
            timestamp,
            log.session_id,
            unique_key,
            d_cost,
            machine_id,
        ],
    )?;
    upsert_cumulative_state(tx, log, generation)?;
    Ok(rowcount > 0)
}

pub(crate) fn upsert_cumulative_state(
    tx: &rusqlite::Transaction,
    log: &LogRecord,
    generation: i64,
) -> Result<()> {
    tx.execute(
        "INSERT INTO scan_cumulative_state (
             unique_key, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, cost_usd, generation, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(unique_key) DO UPDATE SET
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             cached_tokens = excluded.cached_tokens,
             cache_write_tokens = excluded.cache_write_tokens,
             cost_usd = excluded.cost_usd,
             generation = excluded.generation,
             updated_at = excluded.updated_at",
        params![
            log.unique_key,
            log.input_tokens,
            log.output_tokens,
            log.cached_tokens,
            log.cache_write_tokens,
            log.cost_usd,
            generation,
        ],
    )?;
    Ok(())
}
