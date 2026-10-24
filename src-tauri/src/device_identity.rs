//! This computer's device id: the value `token_logs.machine_id` carries and
//! the cloud groups this computer's usage under.
//!
//! Older versions used the hostname, which put the computer's name in every
//! uploaded row. The id is now random, generated once and kept in the app
//! data folder (`device-id`), beside the ledger. Nothing about the computer
//! can be read from it.
//!
//! Moving off the hostname happens in two steps:
//! - `migrate_local` (from `db::init_db`) re-stamps the ledger rows and the
//!   local sync bookkeeping from the hostname to the id, once per ledger.
//! - `cloud_moves_pending` / `mark_cloud_moved` let the cloud sync copy each
//!   account's rows that were uploaded under the hostname to the id, before
//!   it uploads anything (see `commands::move_legacy_cloud_rows`). The copy
//!   keeps the cloud history even for hours the local ledger no longer has.

use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection};

pub const DEVICE_ID_FILE: &str = "device-id";
const ID_PREFIX: &str = "tl-";
const ID_HEX_LEN: usize = 16;

/// What old versions wrote when the hostname could not be read.
pub const UNKNOWN_MACHINE: &str = "unknown_machine";

static CACHE: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();

const IDENTITY_SCHEMA_SQL: &str = "
    CREATE TABLE IF NOT EXISTS device_identity_migrations (
        legacy_machine_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS device_identity_cloud_moves (
        user_id TEXT NOT NULL,
        legacy_machine_id TEXT NOT NULL,
        moved_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, legacy_machine_id)
    );
";

/// `tl-` followed by 16 lowercase hex digits (64 random bits).
pub fn is_valid(id: &str) -> bool {
    id.len() == ID_PREFIX.len() + ID_HEX_LEN
        && id.starts_with(ID_PREFIX)
        && id[ID_PREFIX.len()..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn generate() -> Result<String, String> {
    let mut raw = [0u8; ID_HEX_LEN / 2];
    getrandom::fill(&mut raw).map_err(|error| format!("生成设备 ID 失败：{error}"))?;
    let hex: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{ID_PREFIX}{hex}"))
}

fn read_valid(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let id = text.trim();
    is_valid(id).then(|| id.to_string())
}

/// Reads the id kept in `dir`, creating it the first time. Two processes
/// starting together (the app and the CLI) agree on one id: the file is
/// linked into place without overwriting, so the loser reads the winner's.
fn load_or_create(dir: &Path) -> Result<String, String> {
    let path = dir.join(DEVICE_ID_FILE);
    if let Some(id) = read_valid(&path) {
        return Ok(id);
    }
    fs::create_dir_all(dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    let id = generate()?;
    let temp = dir.join(format!(".{DEVICE_ID_FILE}.{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(format!("{id}\n").as_bytes())?;
        file.sync_all()
    };
    write().map_err(|error| format!("无法保存设备 ID：{error}"))?;
    let linked = fs::hard_link(&temp, &path);
    let _ = fs::remove_file(&temp);
    match linked {
        Ok(()) => Ok(id),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => match read_valid(&path) {
            Some(existing) => Ok(existing),
            // Unreadable leftovers (an empty or edited file) are replaced.
            None => {
                fs::write(&path, format!("{id}\n"))
                    .map_err(|error| format!("无法保存设备 ID：{error}"))?;
                Ok(id)
            }
        },
        Err(error) => Err(format!("无法保存设备 ID：{error}")),
    }
}

/// The device id kept in the app data folder `dir`.
pub fn for_data_dir(dir: &Path) -> Result<String, String> {
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(id) = cache.get(dir) {
        return Ok(id.clone());
    }
    let id = load_or_create(dir)?;
    cache.insert(dir.to_path_buf(), id.clone());
    Ok(id)
}

/// The device id of the ledger at `db_path` (kept beside it).
pub fn for_db(db_path: &Path) -> Result<String, String> {
    for_data_dir(db_path.parent().unwrap_or_else(|| Path::new(".")))
}

/// Like `for_db`, for callers that used to fall back to `unknown_machine`
/// when the hostname could not be read.
pub fn for_db_or_unknown(db_path: &Path) -> String {
    for_db(db_path).unwrap_or_else(|error| {
        log::warn!("{error}");
        UNKNOWN_MACHINE.to_string()
    })
}

/// The device id of the ledger `conn` has open.
pub fn for_connection(conn: &Connection) -> Result<String, String> {
    match conn.path().filter(|path| !path.is_empty()) {
        Some(path) => for_db(Path::new(path)),
        None => Err("内存数据库没有设备 ID".to_string()),
    }
}

/// The machine id rows were stamped with before the device id existed.
/// Only the one-time migrations of rows written by old versions use it.
pub fn legacy_machine_id() -> String {
    hostname::get()
        .map(|name| name.to_string_lossy().trim().to_string())
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| UNKNOWN_MACHINE.to_string())
}

/// Re-stamps rows of `legacy` with `device_id`, once per ledger. Upload
/// receipts stay as they are: the cloud copy under the new id is made by
/// the sync before anything is uploaded, so nothing is re-sent.
pub fn migrate_local(conn: &Connection, legacy: &str, device_id: &str) -> rusqlite::Result<()> {
    conn.execute_batch(IDENTITY_SCHEMA_SQL)?;
    let done: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM device_identity_migrations WHERE legacy_machine_id = ?1)",
        [legacy],
        |row| row.get(0),
    )?;
    if done || legacy == device_id {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    // The dirty-bucket trigger records the old buckets of every re-stamped
    // row. Those buckets are moved in the cloud, not deleted, so the entries
    // the UPDATE adds are dropped again.
    let dirty_before: i64 = tx.query_row(
        "SELECT coalesce(max(id), 0) FROM scan_cloud_dirty_buckets",
        [],
        |row| row.get(0),
    )?;
    // Bumping the revision here keeps the revision trigger from marking the
    // rows unsynced; a delayed receipt for the old revision is still fenced.
    tx.execute(
        "UPDATE token_logs SET machine_id = ?2, sync_revision = sync_revision + 1
         WHERE machine_id = ?1",
        params![legacy, device_id],
    )?;
    tx.execute(
        "DELETE FROM scan_cloud_dirty_buckets WHERE id > ?1",
        [dirty_before],
    )?;
    tx.execute(
        "UPDATE scan_cloud_dirty_buckets SET machine_id = ?2 WHERE machine_id = ?1",
        params![legacy, device_id],
    )?;
    tx.execute(
        "UPDATE OR IGNORE scan_cloud_sent_identities SET machine_id = ?2 WHERE machine_id = ?1",
        params![legacy, device_id],
    )?;
    tx.execute(
        "DELETE FROM scan_cloud_sent_identities WHERE machine_id = ?1",
        [legacy],
    )?;
    // Queued purges now target the moved rows.
    tx.execute(
        "UPDATE OR IGNORE pending_cloud_purges SET machine_id = ?2 WHERE machine_id = ?1",
        params![legacy, device_id],
    )?;
    tx.execute(
        "DELETE FROM pending_cloud_purges WHERE machine_id = ?1",
        [legacy],
    )?;
    tx.execute(
        "INSERT INTO device_identity_migrations (legacy_machine_id, device_id) VALUES (?1, ?2)",
        params![legacy, device_id],
    )?;
    tx.commit()
}

/// Old machine ids whose cloud rows `user_id` still has to move to `device_id`.
pub fn cloud_moves_pending(
    conn: &Connection,
    user_id: &str,
    device_id: &str,
) -> rusqlite::Result<Vec<String>> {
    conn.execute_batch(IDENTITY_SCHEMA_SQL)?;
    let mut statement = conn.prepare(
        "SELECT m.legacy_machine_id FROM device_identity_migrations m
         WHERE m.device_id = ?2
           AND NOT EXISTS(SELECT 1 FROM device_identity_cloud_moves c
                          WHERE c.user_id = ?1 AND c.legacy_machine_id = m.legacy_machine_id)
         ORDER BY m.legacy_machine_id",
    )?;
    let rows = statement.query_map(params![user_id, device_id], |row| row.get(0))?;
    rows.collect()
}

pub fn mark_cloud_moved(conn: &Connection, user_id: &str, legacy: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO device_identity_cloud_moves (user_id, legacy_machine_id)
         VALUES (?1, ?2)",
        params![user_id, legacy],
    )?;
    Ok(())
}

/// The cloud unique key of a row moved from `legacy` to `device_id`. Hourly
/// aggregates name their machine in the key; other keys are kept.
pub fn moved_unique_key(unique_key: &str, legacy: &str, device_id: &str) -> String {
    let old_prefix = format!("agg_{legacy}_");
    match unique_key.strip_prefix(&old_prefix) {
        Some(rest) => format!("agg_{device_id}_{rest}"),
        None => unique_key.to_string(),
    }
}

#[cfg(test)]
#[path = "device_identity_tests.rs"]
mod tests;
