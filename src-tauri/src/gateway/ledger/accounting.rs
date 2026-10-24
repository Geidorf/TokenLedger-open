//! Permanent, minimal accounting; rotating JSONL files are diagnostics only.
//! Legacy logs are imported once, transactionally, without inventing missing history.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use super::{ContextSize, LedgerRecord, ROTATE_BYTES};

pub(crate) const FILE: &str = "usage-accounting-v1.sqlite3";
const LEGACY_FILES: [&str; 2] = ["usage-v1.jsonl.1", "usage-v1.jsonl"];
const MAX_LINE: usize = 256 * 1024;
const MAX_FIELD: usize = 4096;
pub(crate) const PAGE_SIZE: usize = 2048;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Coverage {
    pub revision: i64,
    /// Every hour starting before this UTC instant may contain missing legacy data.
    /// None means there was no legacy source or sync-state evidence to migrate.
    pub complete_from_utc: Option<String>,
    pub imported_records: i64,
    pub malformed_lines: i64,
    pub import_pending: bool,
}

impl Coverage {
    pub fn has_incomplete_history(&self) -> bool {
        self.import_pending || self.complete_from_utc.is_some()
    }

    pub fn hour_is_complete(&self, storage_hour: &str) -> bool {
        if self.import_pending {
            return false;
        }
        let Some(boundary) = &self.complete_from_utc else {
            return true;
        };
        let (Ok(boundary), Ok(hour)) = (
            DateTime::parse_from_rfc3339(boundary),
            NaiveDateTime::parse_from_str(storage_hour, "%Y-%m-%d %H:%M:%S"),
        ) else {
            return false;
        };
        // Ambiguous DST hours use the earliest occurrence; missing hours fail closed.
        Local
            .from_local_datetime(&hour)
            .earliest()
            .is_some_and(|start| start.with_timezone(&Utc) >= boundary.with_timezone(&Utc))
    }
}

fn private_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("网关会计账本不是普通文件，已保留现有内容。".into());
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(format!("检查网关会计账本失败：{error}")),
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(_) => Ok(()),
        // Another writer initialized this database between metadata and create.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => private_file(path),
        Err(error) => Err(format!("创建网关会计账本失败：{error}")),
    }
}

fn open(dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(dir).map_err(|error| format!("创建网关账本目录失败：{error}"))?;
    let path = dir.join(FILE);
    private_file(&path)?;
    let conn = Connection::open(&path).map_err(|error| format!("打开网关会计账本失败：{error}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    let schema: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if ![0, 1].contains(&schema) {
        return Err("网关会计账本版本不受支持，未覆盖数据。".into());
    }
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS accounting_meta (
             singleton INTEGER PRIMARY KEY CHECK(singleton=1),
             revision INTEGER NOT NULL DEFAULT 0,
             import_complete INTEGER NOT NULL DEFAULT 0,
             complete_from_utc TEXT,
             imported_records INTEGER NOT NULL DEFAULT 0,
             malformed_lines INTEGER NOT NULL DEFAULT 0);
         INSERT OR IGNORE INTO accounting_meta(singleton) VALUES(1);
         CREATE TABLE IF NOT EXISTS accounting_rows (
             sequence INTEGER PRIMARY KEY AUTOINCREMENT,
             accounting_id TEXT NOT NULL UNIQUE,
             request_id TEXT NOT NULL, logical_request_id TEXT,
             ts TEXT NOT NULL, ended_at_ms INTEGER NOT NULL, agent TEXT, session TEXT,
             provider TEXT NOT NULL, model TEXT NOT NULL,
             ok INTEGER NOT NULL, status INTEGER NOT NULL,
             input INTEGER NOT NULL, output INTEGER NOT NULL,
             cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
             latency_ms INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS accounting_rows_ts ON accounting_rows(ended_at_ms,sequence);
         -- Added without a user_version bump: older builds never read it and keep working.
         CREATE TABLE IF NOT EXISTS context_rows (
             accounting_id TEXT PRIMARY KEY,
             system_bytes INTEGER NOT NULL, tools_bytes INTEGER NOT NULL,
             history_bytes INTEGER NOT NULL, tool_results_bytes INTEGER NOT NULL,
             attachments_bytes INTEGER NOT NULL, messages INTEGER NOT NULL,
             tool_results INTEGER NOT NULL, attachments INTEGER NOT NULL);
         PRAGMA user_version=1;",
    )
    .map_err(|error| format!("初始化网关会计账本失败：{error}"))?;
    Ok(conn)
}

pub(crate) fn accounting_id(record: &LedgerRecord) -> String {
    if record.ok {
        record
            .logical_request_id
            .clone()
            .unwrap_or_else(|| record.request_id.clone())
    } else if record.logical_request_id.is_some() {
        record.request_id.clone()
    } else {
        format!(
            "failed:{}:{}:{}:{}",
            record.request_id, record.provider, record.ts, record.status
        )
    }
}

fn model(record: &LedgerRecord) -> &str {
    let upstream = record.upstream_model.trim();
    if !upstream.is_empty() {
        return upstream;
    }
    let requested = record.requested_model.trim();
    requested
        .split_once('/')
        .map_or(requested, |(_, model)| model)
}

fn integer(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn validate_record(record: &LedgerRecord) -> Result<Option<i64>, String> {
    if [
        record.input,
        record.output,
        record.cache_read,
        record.cache_write,
    ]
    .iter()
    .all(|value| *value == 0)
    {
        return Ok(None);
    }
    if record.request_id.is_empty()
        || [
            Some(record.request_id.as_str()),
            record.logical_request_id.as_deref(),
            record.agent.as_deref(),
            record.session.as_deref(),
            Some(record.provider.as_str()),
            Some(model(record)),
        ]
        .iter()
        .flatten()
        .any(|value| value.len() > MAX_FIELD)
    {
        return Err("网关记账身份或维度不符合长度边界。".into());
    }
    let ended_at = DateTime::parse_from_rfc3339(record.ts.trim())
        .map_err(|_| "网关记账时间无效。".to_string())?
        .timestamp_millis();
    Ok(Some(ended_at))
}

fn insert(conn: &Connection, record: &LedgerRecord) -> Result<bool, String> {
    let Some(ended_at) = validate_record(record)? else {
        return Ok(false);
    };
    let changed = conn
        .execute(
            "INSERT OR IGNORE INTO accounting_rows
             (accounting_id,request_id,logical_request_id,ts,ended_at_ms,agent,session,provider,model,
              ok,status,input,output,cache_read,cache_write,latency_ms)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![
                accounting_id(record), record.request_id, record.logical_request_id,
                record.ts, ended_at, record.agent, record.session, record.provider, model(record),
                record.ok, record.status, integer(record.input), integer(record.output),
                integer(record.cache_read), integer(record.cache_write), integer(record.latency_ms)
            ],
        )
        .map_err(|error| format!("写入网关会计账本失败：{error}"))?;
    if let (true, Some(context)) = (changed > 0, record.context) {
        conn.execute(
            "INSERT OR IGNORE INTO context_rows
             (accounting_id,system_bytes,tools_bytes,history_bytes,tool_results_bytes,
              attachments_bytes,messages,tool_results,attachments)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                accounting_id(record),
                integer(context.system_bytes),
                integer(context.tools_bytes),
                integer(context.history_bytes),
                integer(context.tool_results_bytes),
                integer(context.attachments_bytes),
                integer(context.messages),
                integer(context.tool_results),
                integer(context.attachments)
            ],
        )
        .map_err(|error| format!("写入网关会计账本失败：{error}"))?;
    }
    if changed > 0 {
        conn.execute(
            "UPDATE accounting_meta SET revision=revision+1 WHERE singleton=1",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(changed > 0)
}

/// Reads at most MAX_LINE+1 bytes for one line, including malicious unterminated input.
fn bounded_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|error| error.to_string())?;
        if available.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if count > MAX_LINE.saturating_sub(line.len()) {
            return Err("旧网关日志单行超过256KiB，未完成导入且禁止轮转。".into());
        }
        let complete = available[count - 1] == b'\n';
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        if complete {
            return Ok(Some(line));
        }
    }
}

fn import_legacy(conn: &mut Connection, dir: &Path) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let complete: bool = tx
        .query_row(
            "SELECT import_complete FROM accounting_meta WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if complete {
        return Ok(());
    }
    let mut legacy_evidence = fs::symlink_metadata(dir.join("cloud-sync-v1.json")).map_or_else(
        |error| error.kind() != std::io::ErrorKind::NotFound,
        |_| true,
    );
    let mut imported = 0i64;
    let mut malformed = 0i64;
    for name in LEGACY_FILES {
        let path = dir.join(name);
        let meta = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("检查旧网关日志失败：{error}")),
            Ok(meta) => meta,
        };
        legacy_evidence = true;
        if meta.file_type().is_symlink()
            || !meta.is_file()
            || meta.len() > ROTATE_BYTES + MAX_LINE as u64
        {
            return Err("旧网关日志类型或大小越界，未完成导入且禁止轮转。".into());
        }
        let file = fs::File::open(&path).map_err(|error| format!("读取旧网关日志失败：{error}"))?;
        let mut reader = BufReader::new(file);
        let mut bytes_read = 0u64;
        while let Some(line) = bounded_line(&mut reader)? {
            bytes_read += line.len() as u64;
            if bytes_read > ROTATE_BYTES + MAX_LINE as u64 {
                return Err("旧网关日志读取期间超过大小边界，未完成导入。".into());
            }
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            match serde_json::from_slice::<LedgerRecord>(&line) {
                Ok(record) if validate_record(&record).is_err() => malformed += 1,
                Ok(record) => {
                    if insert(&tx, &record)? {
                        imported += 1;
                    }
                }
                Err(_) => malformed += 1,
            }
        }
        let after = fs::symlink_metadata(&path)
            .map_err(|_| "旧网关日志在导入期间被替换，未完成导入。".to_string())?;
        if after.file_type().is_symlink()
            || !after.is_file()
            || after.len() != meta.len()
            || after.modified().ok() != meta.modified().ok()
        {
            return Err("旧网关日志在导入期间变化，未完成导入且禁止轮转。".into());
        }
    }
    let boundary = legacy_evidence.then(|| Utc::now().to_rfc3339());
    tx.execute(
        "UPDATE accounting_meta SET import_complete=1, complete_from_utc=COALESCE(complete_from_utc,?1),
         imported_records=?2, malformed_lines=?3 WHERE singleton=1",
        params![boundary, imported, malformed],
    )
    .map_err(|error| error.to_string())?;
    tx.commit()
        .map_err(|error| format!("提交旧网关账本导入失败：{error}"))
}

pub(crate) fn initialize(dir: &Path) -> Result<Coverage, String> {
    let mut conn = open(dir)?;
    attempt_import(&mut conn, dir)?;
    read_coverage(&conn)
}

fn attempt_import(conn: &mut Connection, dir: &Path) -> Result<(), String> {
    if let Err(error) = import_legacy(conn, dir) {
        // The import transaction has rolled back. Preserve the source and a fixed
        // unknown-history boundary, but never block independent new accounting.
        conn.execute("UPDATE accounting_meta SET complete_from_utc=COALESCE(complete_from_utc,?1) WHERE singleton=1",
            [Utc::now().to_rfc3339()]).map_err(|error| error.to_string())?;
        log::warn!("gateway legacy accounting import pending: {error}");
    }
    Ok(())
}

fn read_coverage(conn: &Connection) -> Result<Coverage, String> {
    conn.query_row(
        "SELECT revision,complete_from_utc,imported_records,malformed_lines,import_complete
         FROM accounting_meta WHERE singleton=1",
        [],
        |row| {
            Ok(Coverage {
                revision: row.get(0)?,
                complete_from_utc: row.get(1)?,
                imported_records: row.get(2)?,
                malformed_lines: row.get(3)?,
                import_pending: !row.get::<_, bool>(4)?,
            })
        },
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn append(dir: &Path, record: &LedgerRecord) -> Result<bool, String> {
    let mut conn = open(dir)?;
    attempt_import(&mut conn, dir)?;
    let diagnostics_allowed = !read_coverage(&conn)?.import_pending;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    insert(&tx, record)?;
    tx.commit()
        .map_err(|error| format!("提交网关记账失败：{error}"))?;
    Ok(diagnostics_allowed)
}

/// Every counted row, oldest first, for a local backup (`local-backup-v1`).
/// No accounting file yet means no rows.
pub(crate) fn read_all(dir: &Path) -> Result<Vec<LedgerRecord>, String> {
    if !dir.join(FILE).exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    let mut after = 0;
    loop {
        let page = read_page(dir, after, i64::MAX)?;
        let Some((last, _)) = page.last() else {
            break;
        };
        after = *last;
        records.extend(page.into_iter().map(|(_, record)| record));
    }
    Ok(records)
}

/// How many of `records` this computer's accounting already holds, by the
/// same identity that dedupes live appends.
pub(crate) fn count_known(dir: &Path, records: &[LedgerRecord]) -> Result<usize, String> {
    let path = dir.join(FILE);
    if !path.exists() {
        return Ok(0);
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare("SELECT 1 FROM accounting_rows WHERE accounting_id=?1")
        .map_err(|error| error.to_string())?;
    let mut known = 0;
    for record in records {
        if stmt
            .exists(params![accounting_id(record)])
            .map_err(|error| error.to_string())?
        {
            known += 1;
        }
    }
    Ok(known)
}

/// The history boundary of this computer's accounting, read-only; `None`
/// when there is no accounting file yet.
pub(crate) fn coverage_of(dir: &Path) -> Result<Option<Coverage>, String> {
    let path = dir.join(FILE);
    if !path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    read_coverage(&conn).map(Some)
}

/// The later of two history boundaries; one that does not parse wins, since
/// treating more hours as incomplete is the safe side.
pub(crate) fn later_boundary(current: Option<String>, incoming: &str) -> String {
    let parse = |at: &str| DateTime::parse_from_rfc3339(at).ok();
    match current {
        Some(current) => match (parse(&current), parse(incoming)) {
            (Some(local), Some(other)) if local >= other => current,
            (Some(_), Some(_)) => incoming.to_string(),
            (None, _) => current,
            (_, None) => incoming.to_string(),
        },
        None => incoming.to_string(),
    }
}

/// Adds restored rows in one transaction; rows already held are left alone.
/// `boundary` is the source computer's history boundary: hours before it may
/// lack requests there, so they stay protected from overwriting cloud history
/// here too. Returns how many were new.
pub(crate) fn import(
    dir: &Path,
    records: &[LedgerRecord],
    boundary: Option<&str>,
) -> Result<usize, String> {
    let mut conn = open(dir)?;
    attempt_import(&mut conn, dir)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let mut added = 0;
    for record in records {
        // A row this build would not have counted is skipped, not fatal.
        if validate_record(record).is_ok() && insert(&tx, record)? {
            added += 1;
        }
    }
    if let Some(boundary) = boundary {
        let current: Option<String> = tx
            .query_row(
                "SELECT complete_from_utc FROM accounting_meta WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        tx.execute(
            "UPDATE accounting_meta SET complete_from_utc=?1 WHERE singleton=1",
            [later_boundary(current, boundary)],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit()
        .map_err(|error| format!("提交网关记账失败：{error}"))?;
    Ok(added)
}

/// Bounded keyset page; identities and provenance contain no diagnostic error or request body.
/// Upper sequence allows consumers to pin a stable append-only read horizon.
pub(crate) fn read_page(
    dir: &Path,
    after_sequence: i64,
    through_sequence: i64,
) -> Result<Vec<(i64, LedgerRecord)>, String> {
    let path = dir.join(FILE);
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("网关会计账本读取目标不是普通文件。".into());
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT a.sequence,a.request_id,a.logical_request_id,a.ts,a.agent,a.session,a.provider,a.model,
         a.ok,a.status,a.input,a.output,a.cache_read,a.cache_write,a.latency_ms,
         c.system_bytes,c.tools_bytes,c.history_bytes,c.tool_results_bytes,c.attachments_bytes,
         c.messages,c.tool_results,c.attachments
         FROM accounting_rows a LEFT JOIN context_rows c ON c.accounting_id=a.accounting_id
         WHERE a.sequence>?1 AND a.sequence<=?2 ORDER BY a.sequence LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(
            params![after_sequence, through_sequence, PAGE_SIZE as i64],
            |row| {
                let model: String = row.get(7)?;
                Ok((
                    row.get(0)?,
                    LedgerRecord {
                        request_id: row.get(1)?,
                        logical_request_id: row.get(2)?,
                        ts: row.get(3)?,
                        agent: row.get(4)?,
                        session: row.get(5)?,
                        provider: row.get(6)?,
                        upstream_model: model.clone(),
                        requested_model: model,
                        ok: row.get(8)?,
                        status: row.get(9)?,
                        input: row.get::<_, i64>(10)? as u64,
                        output: row.get::<_, i64>(11)? as u64,
                        cache_read: row.get::<_, i64>(12)? as u64,
                        cache_write: row.get::<_, i64>(13)? as u64,
                        latency_ms: row.get::<_, i64>(14)? as u64,
                        endpoint: String::new(),
                        wire: String::new(),
                        stream: false,
                        error: None,
                        group: None,
                        member: None,
                        context: context_from_row(row, 15)?,
                        first_token_ms: None,
                    },
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|error| error.to_string())
}

/// Columns `first..first+8` of a `context_rows` LEFT JOIN; NULL when the row has none.
fn context_from_row(row: &rusqlite::Row, first: usize) -> rusqlite::Result<Option<ContextSize>> {
    let Some(system_bytes) = row.get::<_, Option<i64>>(first)? else {
        return Ok(None);
    };
    let at = |offset: usize| -> rusqlite::Result<u64> {
        Ok(row.get::<_, i64>(first + offset)?.max(0) as u64)
    };
    Ok(Some(ContextSize {
        system_bytes: system_bytes.max(0) as u64,
        tools_bytes: at(1)?,
        history_bytes: at(2)?,
        tool_results_bytes: at(3)?,
        attachments_bytes: at(4)?,
        messages: at(5)?,
        tool_results: at(6)?,
        attachments: at(7)?,
    }))
}

pub(crate) fn horizon(dir: &Path) -> Result<(Coverage, i64), String> {
    let mut conn = open(dir)?;
    attempt_import(&mut conn, dir)?;
    if read_coverage(&conn)?.import_pending {
        return Err("旧网关账本导入待处理，新用量已持久化；历史统计暂不完整。".into());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let coverage = read_coverage(&tx)?;
    let last = tx
        .query_row("SELECT MAX(sequence) FROM accounting_rows", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?
        .flatten()
        .unwrap_or(0);
    Ok((coverage, last))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::ledger::Ledger;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tl-gw-accounting-{name}-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(id: &str, input: u64) -> LedgerRecord {
        LedgerRecord {
            ts: "2026-10-05T01:00:00Z".into(),
            request_id: id.into(),
            logical_request_id: None,
            agent: Some("codex".into()),
            session: Some("s".into()),
            endpoint: "responses".into(),
            provider: "p".into(),
            requested_model: "p/m".into(),
            upstream_model: "m".into(),
            wire: "responses".into(),
            stream: true,
            status: 200,
            ok: true,
            input,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            latency_ms: 15,
            error: Some("private diagnostic text".into()),
            group: Some("g".into()),
            member: Some("p/m".into()),
            context: None,
            first_token_ms: None,
        }
    }

    fn write_records(path: &Path, records: &[LedgerRecord]) {
        let mut file = fs::File::create(path).unwrap();
        for record in records {
            serde_json::to_writer(&mut file, record).unwrap();
            file.write_all(b"\n").unwrap();
        }
    }

    fn records(dir: &Path) -> Vec<LedgerRecord> {
        let (_, through) = horizon(dir).unwrap();
        let mut after = 0;
        let mut records = Vec::new();
        loop {
            let page = read_page(dir, after, through).unwrap();
            if page.is_empty() {
                return records;
            }
            after = page.last().unwrap().0;
            records.extend(page.into_iter().map(|(_, record)| record));
        }
    }

    #[test]
    fn imports_both_legacy_logs_once_and_preserves_retry_identities() {
        let dir = dir("import");
        let zero = record("shared", 0);
        let success = record("shared", 10);
        let mut failed = record("shared", 3);
        failed.ok = false;
        failed.status = 503;
        write_records(
            &dir.join(LEGACY_FILES[0]),
            &[zero, success.clone(), failed.clone()],
        );
        write_records(&dir.join(LEGACY_FILES[1]), &[success, failed]);
        let first = initialize(&dir).unwrap();
        assert_eq!(first.imported_records, 2);
        assert_eq!(first.revision, 2);
        assert!(first.complete_from_utc.is_some());
        let loaded = records(&dir);
        assert_eq!(loaded.iter().map(|row| row.input).sum::<u64>(), 13);
        assert_eq!(loaded[1].ts, "2026-10-05T01:00:00Z");
        assert!(accounting_id(&loaded[1]).contains("01:00:00Z:503"));
        write_records(&dir.join(LEGACY_FILES[1]), &[record("later-legacy", 99)]);
        assert_eq!(
            initialize(&dir).unwrap(),
            first,
            "import completion is durable"
        );
        assert_eq!(records(&dir).len(), 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rotation_and_restart_cannot_remove_permanent_accounting() {
        let dir = dir("rotation");
        let ledger = Ledger::new(&dir);
        for id in ["first", "second", "third"] {
            ledger.append(&record(id, 10)).unwrap();
            if id != "third" {
                // Force a real diagnostic rotation, twice, so .1 loses "first".
                OpenOptions::new()
                    .append(true)
                    .open(dir.join("usage-v1.jsonl"))
                    .unwrap()
                    .write_all(&vec![b' '; ROTATE_BYTES as usize])
                    .unwrap();
            }
        }
        assert!(!fs::read_to_string(dir.join(LEGACY_FILES[0]))
            .unwrap()
            .contains("first"));
        assert_eq!(records(&dir).iter().map(|row| row.input).sum::<u64>(), 30);
        assert_eq!(initialize(&dir).unwrap().revision, 3);
        Ledger::new(&dir).append(&record("third", 10)).unwrap();
        assert_eq!(
            initialize(&dir).unwrap().revision,
            3,
            "repeated identity is idempotent"
        );
        assert_eq!(records(&dir).len(), 3);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn logical_success_and_chargeable_attempts_are_separate_but_zero_does_not_reserve() {
        let dir = dir("attempts");
        let mut zero = record("attempt-1", 0);
        zero.logical_request_id = Some("logical".into());
        append(&dir, &zero).unwrap();
        let mut success = zero.clone();
        success.input = 10;
        append(&dir, &success).unwrap();
        success.request_id = "attempt-2".into();
        append(&dir, &success).unwrap();
        let mut failed = record("attempt-3", 4);
        failed.logical_request_id = Some("logical".into());
        failed.ok = false;
        failed.status = 503;
        append(&dir, &failed).unwrap();
        append(&dir, &failed).unwrap();
        assert_eq!(records(&dir).iter().map(|row| row.input).sum::<u64>(), 14);
        assert_eq!(records(&dir).len(), 2);
        assert!(initialize(&dir).unwrap().complete_from_utc.is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_legacy_line_is_explicitly_partial_and_boundary_never_advances() {
        let dir = dir("partial");
        write_records(&dir.join(LEGACY_FILES[1]), &[record("valid", 10)]);
        OpenOptions::new()
            .append(true)
            .open(dir.join(LEGACY_FILES[1]))
            .unwrap()
            .write_all(b"{broken\n")
            .unwrap();
        let coverage = initialize(&dir).unwrap();
        assert_eq!(coverage.malformed_lines, 1);
        assert!(coverage.complete_from_utc.is_some());
        assert!(!coverage.hour_is_complete("2026-10-05 00:00:00"));
        assert!(coverage.hour_is_complete("2100-01-01 00:00:00"));
        assert_eq!(initialize(&dir).unwrap(), coverage);
        assert_eq!(records(&dir).len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pending_legacy_import_preserves_new_accounting_and_recovers_idempotently() {
        let dir = dir("rollback");
        write_records(&dir.join(LEGACY_FILES[0]), &[record("first", 10)]);
        fs::write(dir.join(LEGACY_FILES[1]), vec![b'x'; MAX_LINE + 1]).unwrap();
        let before = fs::read(dir.join(LEGACY_FILES[1])).unwrap();
        assert!(initialize(&dir).unwrap().import_pending);
        assert!(Ledger::new(&dir).append(&record("new", 10)).is_ok());
        assert!(Ledger::new(&dir).append(&record("new2", 11)).is_ok());
        assert!(initialize(&dir).unwrap().import_pending);
        assert!(horizon(&dir).is_err());
        assert_eq!(fs::read(dir.join(LEGACY_FILES[1])).unwrap(), before);
        let conn = open(&dir).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM accounting_rows", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            count, 2,
            "new accounting survives while old import rolls back"
        );
        drop(conn);
        write_records(&dir.join(LEGACY_FILES[1]), &[record("second", 20)]);
        assert_eq!(initialize(&dir).unwrap().imported_records, 2);
        assert_eq!(records(&dir).len(), 4);
        Ledger::new(&dir).append(&record("new", 10)).unwrap();
        assert_eq!(records(&dir).len(), 4);
        assert!(!initialize(&dir).unwrap().import_pending);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn diagnostic_failure_after_commit_does_not_fail_accounting_or_store_diagnostics() {
        let dir = dir("diagnostic-failure");
        initialize(&dir).unwrap();
        fs::create_dir(dir.join("usage-v1.jsonl")).unwrap();
        assert!(Ledger::new(&dir).append(&record("durable", 10)).is_ok());
        let loaded = records(&dir);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].latency_ms, 15);
        assert!(loaded[0].error.is_none());
        assert!(loaded[0].endpoint.is_empty());
        assert!(loaded[0].wire.is_empty());
        let conn = open(&dir).unwrap();
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='accounting_rows'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        for forbidden in ["error", "endpoint", "wire", "body", "secret", "token_key"] {
            assert!(
                !sql.contains(forbidden),
                "unexpected diagnostic column: {forbidden}"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.join(FILE)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(conn);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn read_horizon_excludes_concurrent_append_and_pages_are_bounded() {
        let dir = dir("paging");
        let mut conn = open(&dir).unwrap();
        import_legacy(&mut conn, &dir).unwrap();
        let tx = conn.transaction().unwrap();
        for index in 0..PAGE_SIZE + 3 {
            insert(&tx, &record(&format!("p{index}"), 1)).unwrap();
        }
        tx.commit().unwrap();
        drop(conn);
        let (_, through) = horizon(&dir).unwrap();
        append(&dir, &record("after-snapshot", 1)).unwrap();
        let first = read_page(&dir, 0, through).unwrap();
        assert_eq!(first.len(), PAGE_SIZE);
        let second = read_page(&dir, first.last().unwrap().0, through).unwrap();
        assert_eq!(second.len(), 3);
        assert!(second
            .iter()
            .all(|(_, row)| row.request_id != "after-snapshot"));
        fs::remove_dir_all(dir).unwrap();
    }
}
