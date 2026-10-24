//! Database self-check and repair (contract `local-backup-v1` §6).
//!
//! The check runs SQLite's own `integrity_check` on the ledger and on the
//! gateway's accounting. Repair first rebuilds the ledger's indexes, which
//! fixes the common index-only damage in place. Anything worse is repaired
//! at the next start, before any other code opens the database: every row
//! that still reads is copied into a new database, the damaged file is kept
//! beside it, and the scan cursors start over so rows lost with damaged pages
//! come back from the agents' own logs. A database too damaged to open at
//! all is repaired the same way at startup without being asked, since the app
//! cannot run without it; that too waits until this process is the only
//! instance, so a second launch never moves the files a running one has open.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Local, Utc};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use super::table_columns;
use crate::app_paths::AppContext;
use crate::db;
use crate::gateway::accounting;

const PENDING_FILE: &str = "db-repair-pending-v1.json";
const NOTICE_FILE: &str = "db-repair-v1.json";
const MAX_PROBLEMS: usize = 20;
const CHUNK: i64 = 1000;
/// With no readable upper rowid, reading goes on until this many rowids past
/// the last one found have all come back empty or unreadable.
const PROBE_GAP: i64 = 200_000;
/// Tables carried over by a rebuild. Everything else in the ledger database
/// is derived (stats cache, project index) or must start over (scan cursors
/// and checkpoints). The cumulative-source state is not a cursor: it holds
/// each source's reset generation, which the rows alone cannot restore.
const SALVAGED_TABLES: [&str; 6] = [
    "token_logs",
    "scan_cumulative_state",
    "pending_cloud_purges",
    "discovered_models",
    "scan_cloud_sent_identities",
    "scan_cloud_dirty_buckets",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHealth {
    pub exists: bool,
    pub ok: bool,
    /// SQLite's findings, at most a screenful.
    pub problems: Vec<String>,
    pub bytes: u64,
    pub wal_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub checked_at: String,
    pub ok: bool,
    pub ledger: FileHealth,
    pub ledger_rows: Option<i64>,
    pub gateway: FileHealth,
    pub repair_pending: bool,
    pub last_repair: Option<RepairNotice>,
}

/// What the last rebuild did, for the settings page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairNotice {
    pub at: String,
    /// Whether it ran because the database could not be opened at start.
    pub automatic: bool,
    pub rows_recovered: i64,
    pub rows_unreadable: i64,
    pub damaged_copy: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairOutcome {
    /// Rebuilding the indexes left the database healthy.
    pub fixed: bool,
    /// A rebuild is scheduled for the next start.
    pub restart_required: bool,
    pub report: HealthReport,
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn wal_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-wal", path.display()))
}

fn shm_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-shm", path.display()))
}

fn integrity(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA integrity_check({MAX_PROBLEMS})"))
        .map_err(|error| error.to_string())?;
    let lines = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(lines.into_iter().filter(|line| line != "ok").collect())
}

fn check_file(path: &Path) -> FileHealth {
    let mut health = FileHealth {
        exists: path.is_file(),
        bytes: file_len(path),
        wal_bytes: file_len(&wal_path(path)),
        ..FileHealth::default()
    };
    if !health.exists {
        health.ok = true;
        return health;
    }
    let result = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())
        .and_then(|conn| {
            conn.busy_timeout(std::time::Duration::from_secs(5))
                .map_err(|error| error.to_string())?;
            integrity(&conn)
        });
    match result {
        Ok(problems) => {
            health.ok = problems.is_empty();
            health.problems = problems;
        }
        Err(error) => health.problems = vec![error],
    }
    health
}

pub fn check(app: &AppContext, gateway_dir: &Path) -> HealthReport {
    let db_path = db::get_db_path(app);
    let ledger = check_file(&db_path);
    let ledger_rows = ledger
        .ok
        .then(|| {
            db::get_connection(&db_path)
                .ok()?
                .query_row("SELECT COUNT(*) FROM token_logs", [], |row| row.get(0))
                .ok()
        })
        .flatten();
    let gateway = check_file(&gateway_dir.join(accounting::FILE));
    HealthReport {
        checked_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        ok: ledger.ok && gateway.ok,
        ledger,
        ledger_rows,
        gateway,
        repair_pending: app.app_data_dir().join(PENDING_FILE).exists(),
        last_repair: last_repair(app),
    }
}

pub fn last_repair(app: &AppContext) -> Option<RepairNotice> {
    let bytes = fs::read(app.app_data_dir().join(NOTICE_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn reindex(path: &Path) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|error| error.to_string())?;
    conn.execute_batch("REINDEX;")
        .map_err(|error| error.to_string())
}

/// Rebuilds indexes in place; when the ledger is still damaged, schedules a
/// rebuild for the next start.
pub fn repair(app: &AppContext, gateway_dir: &Path) -> Result<RepairOutcome, String> {
    let _guard = super::busy_lock();
    let db_path = db::get_db_path(app);
    let accounting_path = gateway_dir.join(accounting::FILE);
    let before = check(app, gateway_dir);
    if !before.ledger.ok {
        let _ = reindex(&db_path);
    }
    if !before.gateway.ok && accounting_path.exists() {
        let _ = reindex(&accounting_path);
    }
    let after = check(app, gateway_dir);
    if after.ledger.ok {
        let _ = fs::remove_file(app.app_data_dir().join(PENDING_FILE));
        return Ok(RepairOutcome {
            fixed: after.ok,
            restart_required: false,
            report: after,
        });
    }
    schedule_rebuild(app, false)?;
    let report = check(app, gateway_dir);
    Ok(RepairOutcome {
        fixed: false,
        restart_required: true,
        report,
    })
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SalvageReport {
    pub rows_recovered: i64,
    pub rows_unreadable: i64,
}

/// Where reading a damaged table can stop.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Bound {
    Empty,
    Last(i64),
    /// Every way of finding the last rowid hit damage (the rightmost leaf).
    Unknown,
}

fn max_rowid(conn: &Connection, table: &str) -> Bound {
    let max = conn.query_row(&format!("SELECT max(rowid) FROM \"{table}\""), [], |row| {
        row.get::<_, Option<i64>>(0)
    });
    match max {
        Ok(Some(last)) => return Bound::Last(last),
        Ok(None) => return Bound::Empty,
        Err(_) => {}
    }
    if let Ok(last) = conn.query_row(
        &format!("SELECT rowid FROM \"{table}\" ORDER BY rowid DESC LIMIT 1"),
        [],
        |row| row.get::<_, i64>(0),
    ) {
        return Bound::Last(last);
    }
    // AUTOINCREMENT tables record their highest rowid elsewhere.
    if let Ok(Some(last)) = conn.query_row(
        "SELECT seq FROM sqlite_sequence WHERE name = ?1",
        [table],
        |row| row.get::<_, Option<i64>>(0),
    ) {
        return Bound::Last(last);
    }
    Bound::Unknown
}

fn read_rows(
    conn: &Connection,
    sql: &str,
    width: usize,
    args: &[i64],
) -> rusqlite::Result<Vec<Vec<SqlValue>>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map(params_from_iter(args.iter()), |row| {
            (0..width)
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<rusqlite::Result<Vec<_>>>()
        })?
        .collect::<rusqlite::Result<Vec<_>>>();
    rows
}

/// Copies every readable row of `table` from `damaged` into `fresh`.
fn salvage_table(
    damaged: &Connection,
    fresh: &Connection,
    table: &str,
    report: &mut SalvageReport,
) {
    let Ok(source_columns) = table_columns(damaged, table) else {
        return;
    };
    let Ok(target_columns) = table_columns(fresh, table) else {
        return;
    };
    let columns: Vec<String> = source_columns
        .into_iter()
        .filter(|column| target_columns.contains(column))
        .collect();
    if columns.is_empty() {
        return;
    }
    let list = super::quoted(&columns);
    let bound = max_rowid(damaged, table);
    if bound == Bound::Empty {
        return;
    }
    let range_sql = format!("SELECT {list} FROM \"{table}\" WHERE rowid BETWEEN ?1 AND ?2");
    let one_sql = format!("SELECT {list} FROM \"{table}\" WHERE rowid = ?1");
    let insert_sql = format!(
        "INSERT OR IGNORE INTO \"{table}\" ({list}) VALUES ({})",
        vec!["?"; columns.len()].join(",")
    );
    let Ok(mut insert) = fresh.prepare(&insert_sql) else {
        return;
    };
    let counted = table == "token_logs";
    let mut start = 0;
    let mut last_found: i64 = 0;
    loop {
        let more = match bound {
            Bound::Last(last) => start <= last,
            _ => start <= last_found.saturating_add(PROBE_GAP),
        };
        if !more {
            break;
        }
        let end = start.saturating_add(CHUNK - 1);
        let rows = match read_rows(damaged, &range_sql, columns.len(), &[start, end]) {
            Ok(rows) => rows,
            Err(_) => {
                // A damaged page in this range: read the rows one by one.
                let mut rows = Vec::new();
                for rowid in start..=end {
                    match read_rows(damaged, &one_sql, columns.len(), &[rowid]) {
                        Ok(mut found) => rows.append(&mut found),
                        Err(_) if counted => report.rows_unreadable += 1,
                        Err(_) => {}
                    }
                }
                rows
            }
        };
        if !rows.is_empty() {
            last_found = end;
        }
        for row in rows {
            if insert.execute(params_from_iter(row)).unwrap_or(0) > 0 && counted {
                report.rows_recovered += 1;
            }
        }
        start = end.saturating_add(1);
    }
}

/// Builds a new ledger database from the rows of `damaged` that still read.
pub fn salvage(damaged: &Path, target: &Path) -> Result<SalvageReport, String> {
    for path in [target.to_path_buf(), wal_path(target), shm_path(target)] {
        let _ = fs::remove_file(path);
    }
    db::init_fresh_db(&target.to_path_buf()).map_err(|error| error.to_string())?;
    let fresh = db::get_connection(target).map_err(|error| error.to_string())?;
    // Migrations run against the empty database queue work of their own,
    // such as a cloud purge for every tool: carried into the rebuilt ledger,
    // the next sync would delete cloud history the recovered rows (already
    // uploaded) never send again. The salvaged tables hold only what the
    // damaged file held.
    for table in SALVAGED_TABLES {
        fresh
            .execute(&format!("DELETE FROM {table}"), [])
            .map_err(|error| error.to_string())?;
    }
    let mut report = SalvageReport::default();
    // A file that does not open at all leaves an empty, healthy ledger.
    if let Ok(source) = Connection::open_with_flags(damaged, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        fresh
            .execute_batch("BEGIN")
            .map_err(|error| error.to_string())?;
        for table in SALVAGED_TABLES {
            salvage_table(&source, &fresh, table, &mut report);
        }
        fresh
            .execute_batch("COMMIT")
            .map_err(|error| error.to_string())?;
    }
    fresh
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|error| error.to_string())?;
    Ok(report)
}

/// Swaps a salvaged copy in for the damaged ledger and records a notice.
fn rebuild(app: &AppContext, db_path: &Path, automatic: bool) -> Result<RepairNotice, String> {
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let rebuilt = db_path.with_extension("db.rebuilt");
    let report = salvage(db_path, &rebuilt)?;
    let damaged_copy = db_path.with_extension(format!("db.damaged-{stamp}"));
    if db_path.exists() {
        fs::rename(db_path, &damaged_copy)
            .map_err(|error| format!("移开损坏的数据库失败：{error}"))?;
    }
    for (from, suffix) in [(wal_path(db_path), "-wal"), (shm_path(db_path), "-shm")] {
        if from.exists() {
            let _ = fs::rename(&from, format!("{}{suffix}", damaged_copy.display()));
        }
    }
    let _ = fs::remove_file(wal_path(&rebuilt));
    let _ = fs::remove_file(shm_path(&rebuilt));
    fs::rename(&rebuilt, db_path).map_err(|error| format!("换入修复后的数据库失败：{error}"))?;
    let notice = RepairNotice {
        at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        automatic,
        rows_recovered: report.rows_recovered,
        rows_unreadable: report.rows_unreadable,
        damaged_copy: damaged_copy.to_string_lossy().to_string(),
    };
    if let Ok(bytes) = serde_json::to_vec_pretty(&notice) {
        let _ = fs::write(app.app_data_dir().join(NOTICE_FILE), bytes);
    }
    Ok(notice)
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Pending {
    requested_at: String,
    automatic: bool,
}

/// Asks the next primary instance to rebuild the ledger before opening it.
pub fn schedule_rebuild(app: &AppContext, automatic: bool) -> Result<(), String> {
    let pending = Pending {
        requested_at: Utc::now().to_rfc3339(),
        automatic,
    };
    fs::write(
        app.app_data_dir().join(PENDING_FILE),
        serde_json::to_vec(&pending).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("安排修复失败：{error}"))
}

/// Runs a scheduled rebuild. Only the primary instance calls this, before the
/// scheduler or any window opens the ledger.
pub fn run_pending(app: &AppContext, db_path: &Path) {
    let marker = app.app_data_dir().join(PENDING_FILE);
    let Ok(bytes) = fs::read(&marker) else {
        return;
    };
    let automatic = serde_json::from_slice::<Pending>(&bytes)
        .map(|pending| pending.automatic)
        .unwrap_or(false);
    match rebuild(app, db_path, automatic) {
        Ok(notice) => log::warn!(
            "ledger database rebuilt: {} rows recovered, {} unreadable",
            notice.rows_recovered,
            notice.rows_unreadable
        ),
        Err(error) => log::error!("ledger database rebuild failed: {error}"),
    }
    let _ = fs::remove_file(marker);
}

/// Whether `error` says the file is damaged rather than busy or missing.
pub fn is_corruption(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
    )
}
