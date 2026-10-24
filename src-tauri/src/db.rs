use rusqlite::{params, Connection, OptionalExtension, Result, Transaction};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::app_paths::AppContext;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanCheckpoint {
    pub source_kind: String,
    pub source_path: String,
    pub source_identity: String,
    pub size_bytes: i64,
    pub modified_ns: i64,
    pub processed_offset: i64,
}

/// Durable keyset cursor for provider databases. Unlike file checkpoints,
/// these cursors describe a logical row position and remain valid while a
/// WAL-backed SQLite file grows or is checkpointed in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanSourceCursor {
    pub source_kind: String,
    pub source_path: String,
    pub source_identity: String,
    pub cursor_primary: String,
    pub cursor_secondary: String,
    pub size_bytes: i64,
    pub modified_ns: i64,
    pub parser_version: i64,
}

/// Source identities that can be rebuilt from a complete Codex rollout
/// inventory. Legacy rows use the rollout file stem as `session_id`; rebuilt
/// rows use the root thread UUID. Keeping both sets makes a retry idempotent
/// without deleting unrelated or no-longer-reconstructable Codex history.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexRebuildPlan {
    pub legacy_session_ids: Vec<String>,
    pub root_session_ids: Vec<String>,
}

const CODEX_CHECKPOINT_SOURCE_PREFIX: &str = "codex-rollout-jsonl-";

/// Local schema version that adds the opt-in project index (T10.165; number
/// assigned by root on 2026-09-24 after v12 was found taken by T10.88).
pub(crate) const PROJECT_INDEX_SCHEMA_VERSION: i64 = 13;

/// v14 (T10.305): local-only revision fencing for delayed upload receipts.
const SYNC_REVISION_SCHEMA_VERSION: i64 = 14;
const SYNC_REVISION_TRIGGER_V14_SQL: &str = "
    CREATE TRIGGER token_logs_sync_revision
    AFTER UPDATE OF tool, model, input_tokens, output_tokens, cached_tokens,
        cache_write_tokens, timestamp, session_id, unique_key, cost_usd,
        machine_id, sync_status, cloud_user_id, synced_at ON token_logs
    WHEN NEW.sync_revision = OLD.sync_revision AND (NEW.sync_status = 0
        OR NEW.tool IS NOT OLD.tool OR NEW.model IS NOT OLD.model
        OR NEW.input_tokens IS NOT OLD.input_tokens
        OR NEW.output_tokens IS NOT OLD.output_tokens
        OR NEW.cached_tokens IS NOT OLD.cached_tokens
        OR NEW.cache_write_tokens IS NOT OLD.cache_write_tokens
        OR NEW.timestamp IS NOT OLD.timestamp
        OR NEW.session_id IS NOT OLD.session_id
        OR NEW.unique_key IS NOT OLD.unique_key
        OR NEW.cost_usd IS NOT OLD.cost_usd
        OR NEW.machine_id IS NOT OLD.machine_id)
    BEGIN
        UPDATE token_logs SET sync_revision = OLD.sync_revision + 1, sync_status = 0
        WHERE id = NEW.id;
    END;
";

/// v15 (T10.306c): cumulative reset generations and durable scan identities.
const DATA_CONSISTENCY_SCHEMA_VERSION: i64 = 15;

// v16 (T10.307): only Antigravity supplies explicit usage/cache provenance.
const ANTIGRAVITY_PROVENANCE_SCHEMA_VERSION: i64 = 16;
const SCAN_CLOUD_IDENTITIES_V15_SQL: &str = "
    CREATE TABLE IF NOT EXISTS scan_cloud_sent_identities (
        user_id TEXT NOT NULL, source_key TEXT NOT NULL,
        tool TEXT NOT NULL, model TEXT NOT NULL,
        hour_bucket TEXT NOT NULL, machine_id TEXT NOT NULL,
        PRIMARY KEY (user_id, source_key, tool, model, hour_bucket, machine_id)
    );
    CREATE TABLE IF NOT EXISTS scan_cloud_dirty_buckets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL, tool TEXT NOT NULL, model TEXT NOT NULL,
        hour_bucket TEXT NOT NULL, machine_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scan_cloud_dirty_owner ON scan_cloud_dirty_buckets(user_id);
    CREATE INDEX IF NOT EXISTS scan_cloud_sent_source ON scan_cloud_sent_identities(source_key);
    CREATE TRIGGER IF NOT EXISTS token_logs_dirty_old_bucket_update
    AFTER UPDATE OF tool, model, timestamp, machine_id, unique_key ON token_logs
    WHEN NEW.tool IS NOT OLD.tool OR NEW.model IS NOT OLD.model
        OR substr(NEW.timestamp, 1, 13) IS NOT substr(OLD.timestamp, 1, 13)
        OR NEW.machine_id IS NOT OLD.machine_id OR NEW.unique_key IS NOT OLD.unique_key
    BEGIN
        INSERT INTO scan_cloud_dirty_buckets(user_id, tool, model, hour_bucket, machine_id)
        SELECT user_id, tool, model, hour_bucket, machine_id
        FROM scan_cloud_sent_identities WHERE source_key = OLD.unique_key;
        INSERT INTO scan_cloud_dirty_buckets(user_id, tool, model, hour_bucket, machine_id)
        SELECT OLD.cloud_user_id, OLD.tool, OLD.model,
               substr(OLD.timestamp, 1, 13) || ':00:00', coalesce(OLD.machine_id, '')
        WHERE OLD.cloud_user_id IS NOT NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS token_logs_dirty_old_bucket_delete AFTER DELETE ON token_logs
    BEGIN
        INSERT INTO scan_cloud_dirty_buckets(user_id, tool, model, hour_bucket, machine_id)
        SELECT user_id, tool, model, hour_bucket, machine_id
        FROM scan_cloud_sent_identities WHERE source_key = OLD.unique_key;
        INSERT INTO scan_cloud_dirty_buckets(user_id, tool, model, hour_bucket, machine_id)
        SELECT OLD.cloud_user_id, OLD.tool, OLD.model,
               substr(OLD.timestamp, 1, 13) || ':00:00', coalesce(OLD.machine_id, '')
        WHERE OLD.cloud_user_id IS NOT NULL;
    END;
";

/// Frozen DDL of schema v13. Later changes need a new version, never an edit
/// here. Both tables are local-only: no sync SQL, export or diagnostic reads
/// them, and the migration creates them empty (nothing is read or written
/// until the user enables the project dimension). Constraints keep paths out
/// structurally: a label can never contain a path separator, and the failure
/// field only holds a lowercase reason code.
const PROJECT_INDEX_V13_SQL: &str = "
    CREATE TABLE IF NOT EXISTS local_session_projects (
        tool TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_family TEXT NOT NULL,
        project_kind TEXT NOT NULL
            CHECK (project_kind IN ('named','home','root','temp','managed','unresolved')),
        project_key TEXT NOT NULL,
        project_label TEXT,
        resolution TEXT NOT NULL
            CHECK (resolution IN ('git_root','git_worktree','git_submodule','source_git_root',
                                  'worktree_heuristic','folder','bucket',
                                  'unsupported_source','source_missing','source_unreadable',
                                  'field_missing','invalid_path','budget_exceeded')),
        generation INTEGER NOT NULL,
        resolver_version INTEGER NOT NULL,
        resolved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (tool, session_id),
        CHECK ((project_kind = 'named') = (project_label IS NOT NULL)),
        CHECK ((project_kind = 'named') = (project_key GLOB 'n:?*')),
        CHECK (project_label IS NULL OR (
            length(project_label) BETWEEN 1 AND 256
            AND instr(project_label, '/') = 0
            AND instr(project_label, char(92)) = 0))
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS local_session_projects_key_idx
        ON local_session_projects (project_key);
    CREATE TABLE IF NOT EXISTS local_project_index_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        consent_version INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0,
        backfill_status TEXT NOT NULL DEFAULT 'idle'
            CHECK (backfill_status IN ('idle','running','done','cancelled','failed')),
        backfill_total INTEGER NOT NULL DEFAULT 0,
        backfill_done INTEGER NOT NULL DEFAULT 0,
        indexed_through_id INTEGER NOT NULL DEFAULT 0,
        resolver_version INTEGER NOT NULL DEFAULT 0,
        last_failure TEXT
            CHECK (last_failure IS NULL OR (
                length(last_failure) BETWEEN 1 AND 32
                AND last_failure NOT GLOB '*[^a-z_]*')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
";

/// Get the path to the SQLite database.
/// Creates the directory if it does not exist.
pub fn get_db_path(app: &AppContext) -> PathBuf {
    let app_dir = app.app_data_dir().to_path_buf();
    fs::create_dir_all(&app_dir).ok();
    app_dir.join("tokenboard.db")
}

/// Establish a connection to the database.
pub fn get_connection(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    // WAL 模式下 NORMAL 已足够安全；此前只有 init 连接设置了它，扫描持久化、
    // 计价重算、同步标记等业务连接全部回落到 FULL（每次 commit 全量 fsync）。
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(conn)
}

/// Initialize the database, create tables, and perform migrations if necessary.
pub fn init_db(db_path: &PathBuf) -> Result<()> {
    // Unit tests must never inspect developer-machine legacy paths. Production
    // builds retain the one-time migration behaviour.
    init_db_with_legacy_migration(db_path, !cfg!(test))
}

#[cfg(test)]
pub(crate) fn init_test_db(db_path: &PathBuf) -> Result<()> {
    init_db_with_legacy_migration(db_path, false)
}

fn init_db_with_legacy_migration(db_path: &PathBuf, migrate_legacy: bool) -> Result<()> {
    let conn = get_connection(db_path)?;

    let journal_mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    }
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    // Create token_logs table with the new schema (including machine_id and sync_status)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS token_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tool TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cached_tokens INTEGER DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            timestamp TEXT NOT NULL,
            session_id TEXT NOT NULL,
            unique_key TEXT UNIQUE NOT NULL,
            cost_usd REAL,
            machine_id TEXT NOT NULL DEFAULT '',
            sync_status INTEGER NOT NULL DEFAULT 0,
            cloud_user_id TEXT,
            synced_at TEXT
        )",
        [],
    )?;

    // Retrieve column information to perform online migrations for legacy databases
    let mut stmt = conn.prepare("PRAGMA table_info(token_logs)")?;
    let mut rows = stmt.query([])?;
    let mut has_cost_usd = false;
    let mut has_machine_id = false;
    let mut has_sync_status = false;
    let mut has_cloud_user_id = false;
    let mut has_synced_at = false;
    let mut has_cache_write = false;

    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        match name.as_str() {
            "cost_usd" => has_cost_usd = true,
            "machine_id" => has_machine_id = true,
            "sync_status" => has_sync_status = true,
            "cloud_user_id" => has_cloud_user_id = true,
            "synced_at" => has_synced_at = true,
            "cache_write_tokens" => has_cache_write = true,
            _ => {}
        }
    }

    // Explicit drops to release database locks before running migrations
    drop(rows);
    drop(stmt);

    if !has_cost_usd {
        conn.execute("ALTER TABLE token_logs ADD COLUMN cost_usd REAL", [])?;
    }
    if !has_machine_id {
        conn.execute(
            "ALTER TABLE token_logs ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    if !has_sync_status {
        conn.execute(
            "ALTER TABLE token_logs ADD COLUMN sync_status INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !has_cloud_user_id {
        conn.execute("ALTER TABLE token_logs ADD COLUMN cloud_user_id TEXT", [])?;
    }
    if !has_synced_at {
        conn.execute("ALTER TABLE token_logs ADD COLUMN synced_at TEXT", [])?;
    }
    if !has_cache_write {
        // cached_tokens keeps the historical meaning of read+write combined;
        // cache_write_tokens carries the write share so cost estimation can
        // price reads (0.1x) and writes (1.25x) separately. Legacy rows stay
        // at 0 and are priced as pure reads, matching the old behaviour.
        conn.execute(
            "ALTER TABLE token_logs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    init_indexes(&conn)?;
    init_discovered_models(&conn)?;

    // Idempotently backfill legacy data even when the new DB already has rows.
    // Synthetic tests opt out so they never inspect real legacy paths under
    // the developer's cwd or HOME.
    if migrate_legacy {
        migrate_legacy_db(db_path).ok();
    }

    run_schema_upgrades(&conn)?;
    // After the upgrades: they queue cloud purges under the hostname the
    // rows were uploaded with, and this moves those rows to the device id.
    let device_id = crate::device_identity::for_db(db_path)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
    crate::device_identity::migrate_local(
        &conn,
        &crate::device_identity::legacy_machine_id(),
        &device_id,
    )?;

    init_local_cache(&conn)?;
    init_scan_checkpoints(&conn)?;
    init_scan_source_cursors(&conn)?;
    init_scan_cumulative_state(&conn)?;

    Ok(())
}

fn init_scan_source_cursors(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scan_source_cursors (
            source_kind TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_identity TEXT NOT NULL,
            cursor_primary TEXT NOT NULL,
            cursor_secondary TEXT NOT NULL DEFAULT '',
            size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),
            modified_ns INTEGER NOT NULL DEFAULT 0,
            parser_version INTEGER NOT NULL,
            updated_at TEXT NOT NULL DEFAULT
                (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY (source_kind, source_path)
        )",
        [],
    )?;
    Ok(())
}

fn init_scan_cumulative_state(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scan_cumulative_state (
            unique_key TEXT PRIMARY KEY,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cached_tokens INTEGER NOT NULL,
            cache_write_tokens INTEGER NOT NULL,
            cost_usd REAL,
            updated_at TEXT NOT NULL DEFAULT
                (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )",
        [],
    )?;
    Ok(())
}

fn init_scan_checkpoints(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scan_checkpoints (
            source_kind TEXT NOT NULL,
            source_path TEXT NOT NULL,
            source_identity TEXT NOT NULL,
            size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
            modified_ns INTEGER NOT NULL,
            processed_offset INTEGER NOT NULL
                CHECK(processed_offset >= 0 AND processed_offset <= size_bytes),
            updated_at TEXT NOT NULL DEFAULT
                (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            PRIMARY KEY (source_kind, source_path)
        )",
        [],
    )?;
    Ok(())
}

pub fn load_scan_checkpoints(
    conn: &Connection,
    source_kind: &str,
) -> Result<HashMap<String, ScanCheckpoint>> {
    let mut stmt = conn.prepare(
        "SELECT source_kind, source_path, source_identity,
                size_bytes, modified_ns, processed_offset
         FROM scan_checkpoints
         WHERE source_kind = ?1",
    )?;
    let rows = stmt.query_map([source_kind], |row| {
        let checkpoint = ScanCheckpoint {
            source_kind: row.get(0)?,
            source_path: row.get(1)?,
            source_identity: row.get(2)?,
            size_bytes: row.get(3)?,
            modified_ns: row.get(4)?,
            processed_offset: row.get(5)?,
        };
        Ok((checkpoint.source_path.clone(), checkpoint))
    })?;
    rows.collect()
}

pub fn upsert_scan_checkpoints(tx: &Transaction<'_>, checkpoints: &[ScanCheckpoint]) -> Result<()> {
    let mut stmt = tx.prepare(
        "INSERT INTO scan_checkpoints (
             source_kind, source_path, source_identity,
             size_bytes, modified_ns, processed_offset, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(source_kind, source_path) DO UPDATE SET
             source_identity = excluded.source_identity,
             size_bytes = excluded.size_bytes,
             modified_ns = excluded.modified_ns,
             processed_offset = excluded.processed_offset,
             updated_at = excluded.updated_at",
    )?;
    for checkpoint in checkpoints {
        stmt.execute(params![
            checkpoint.source_kind,
            checkpoint.source_path,
            checkpoint.source_identity,
            checkpoint.size_bytes,
            checkpoint.modified_ns,
            checkpoint.processed_offset,
        ])?;
    }
    Ok(())
}

pub fn load_scan_source_cursors(
    conn: &Connection,
) -> Result<HashMap<(String, String), ScanSourceCursor>> {
    let mut stmt = conn.prepare(
        "SELECT source_kind, source_path, source_identity,
                cursor_primary, cursor_secondary, size_bytes, modified_ns,
                parser_version
         FROM scan_source_cursors",
    )?;
    let rows = stmt.query_map([], |row| {
        let cursor = ScanSourceCursor {
            source_kind: row.get(0)?,
            source_path: row.get(1)?,
            source_identity: row.get(2)?,
            cursor_primary: row.get(3)?,
            cursor_secondary: row.get(4)?,
            size_bytes: row.get(5)?,
            modified_ns: row.get(6)?,
            parser_version: row.get(7)?,
        };
        Ok((
            (cursor.source_kind.clone(), cursor.source_path.clone()),
            cursor,
        ))
    })?;
    rows.collect()
}

pub fn upsert_scan_source_cursors(
    tx: &Transaction<'_>,
    cursors: &[ScanSourceCursor],
) -> Result<()> {
    let mut stmt = tx.prepare(
        "INSERT INTO scan_source_cursors (
             source_kind, source_path, source_identity,
             cursor_primary, cursor_secondary, size_bytes, modified_ns,
             parser_version, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(source_kind, source_path) DO UPDATE SET
             source_identity = excluded.source_identity,
             cursor_primary = excluded.cursor_primary,
             cursor_secondary = excluded.cursor_secondary,
             size_bytes = excluded.size_bytes,
             modified_ns = excluded.modified_ns,
             parser_version = excluded.parser_version,
             updated_at = excluded.updated_at",
    )?;
    for cursor in cursors {
        stmt.execute(params![
            cursor.source_kind,
            cursor.source_path,
            cursor.source_identity,
            cursor.cursor_primary,
            cursor.cursor_secondary,
            cursor.size_bytes,
            cursor.modified_ns,
            cursor.parser_version,
        ])?;
    }
    Ok(())
}

/// SQLite 文件占用快照：页大小、总页数与空闲页数。空闲页是删除后尚未归还给
/// 操作系统的空间，只有 `VACUUM` 能回收。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorageFootprint {
    pub page_size: u64,
    pub page_count: u64,
    pub freelist_pages: u64,
}

impl StorageFootprint {
    pub fn total_bytes(&self) -> u64 {
        self.page_size.saturating_mul(self.page_count)
    }

    pub fn reclaimable_bytes(&self) -> u64 {
        self.page_size.saturating_mul(self.freelist_pages)
    }

    /// 空闲页占比 0.0–1.0；空库为 0。
    pub fn free_ratio(&self) -> f64 {
        if self.page_count == 0 {
            0.0
        } else {
            self.freelist_pages as f64 / self.page_count as f64
        }
    }
}

pub fn storage_footprint(conn: &Connection) -> Result<StorageFootprint> {
    let page_size: u64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
    let page_count: u64 = conn.query_row("PRAGMA page_count", [], |row| row.get(0))?;
    let freelist_pages: u64 = conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
    Ok(StorageFootprint {
        page_size,
        page_count,
        freelist_pages,
    })
}

/// 一次 `VACUUM` 的前后对比（字节按页面计算，不含 WAL 文件）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReclaimedSpace {
    pub before_bytes: u64,
    pub after_bytes: u64,
}

impl ReclaimedSpace {
    pub fn freed_bytes(&self) -> u64 {
        self.before_bytes.saturating_sub(self.after_bytes)
    }
}

/// 重建数据库文件以归还空闲页。`VACUUM` 需要短暂的独占锁，扫描或同步正在写入
/// 时会在 busy timeout 后失败，由调用方把错误原样交给用户重试；数据本身不变，
/// 因此不需要让统计缓存失效。结束后截断 WAL，避免回收的空间转移到 `-wal` 文件。
pub fn reclaim_space(db_path: &Path) -> Result<ReclaimedSpace> {
    let conn = get_connection(db_path)?;
    let before = storage_footprint(&conn)?;
    conn.execute_batch("VACUUM")?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
    let after = storage_footprint(&conn)?;
    Ok(ReclaimedSpace {
        before_bytes: before.total_bytes(),
        after_bytes: after.total_bytes(),
    })
}

/// 只有空闲页占比达到 `min_free_ratio` 时才回收，避免每次小清理都重写整个文件。
pub fn reclaim_space_if_fragmented(
    db_path: &Path,
    min_free_ratio: f64,
) -> Result<Option<ReclaimedSpace>> {
    let footprint = {
        let conn = get_connection(db_path)?;
        storage_footprint(&conn)?
    };
    if footprint.freelist_pages == 0 || footprint.free_ratio() < min_free_ratio {
        return Ok(None);
    }
    reclaim_space(db_path).map(Some)
}

/// Query indexes for the stats aggregation paths. token_logs previously only
/// had the implicit unique index on unique_key, so every dashboard query was
/// a full table scan + sort.
fn init_indexes(conn: &Connection) -> Result<()> {
    // T10.105c：`(timestamp)` 与 `(tool, timestamp)` 两个早期索引被下面带 `id`
    // 的同前缀索引完全覆盖（SQLite 可以双向扫描同一索引），却在真实账本里各占
    // 12–15 MB 并拖慢每次写入；这里幂等地删除，老库升级后即可回收。
    conn.execute("DROP INDEX IF EXISTS token_logs_timestamp_idx", [])?;
    conn.execute("DROP INDEX IF EXISTS token_logs_tool_timestamp_idx", [])?;
    // Stable keyset order for detail pages. SQLite can scan an index in
    // either direction; spelling DESC documents and covers the dominant path.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS token_logs_timestamp_id_idx
            ON token_logs (timestamp DESC, id DESC)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS token_logs_tool_timestamp_id_idx
            ON token_logs (tool, timestamp DESC, id DESC)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS token_logs_model_timestamp_id_idx
            ON token_logs (model, timestamp DESC, id DESC)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS token_logs_machine_timestamp_id_idx
            ON token_logs (machine_id, timestamp DESC, id DESC)",
        [],
    )?;
    // Entity drill-down commonly combines tool + model and may optionally
    // narrow to one machine. Equality columns lead; the range/order columns
    // remain last so the same index supports cursor pagination.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS token_logs_tool_model_machine_timestamp_id_idx
            ON token_logs (tool, model, machine_id, timestamp DESC, id DESC)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS token_logs_sync_status_user_idx
            ON token_logs (sync_status, cloud_user_id)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS token_logs_cloud_user_sync_idx
            ON token_logs (cloud_user_id, sync_status)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS token_logs_missing_cost_idx
            ON token_logs (id) WHERE cost_usd IS NULL",
        [],
    )?;
    Ok(())
}

/// Models observed in local logs are kept separately from user price
/// overrides. The effective price table can therefore surface an editable
/// placeholder without rewriting bundled prices or racing with a user's
/// unsaved price edits.
fn init_discovered_models(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS discovered_models (
            tool TEXT NOT NULL,
            model_key TEXT NOT NULL,
            model TEXT NOT NULL,
            first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (tool, model_key)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS discovered_models_model_key_idx
            ON discovered_models (model_key)",
        [],
    )?;
    Ok(())
}

/// Versioned one-time upgrades tracked via PRAGMA user_version.
///
/// v2 (app 1.2.0): the Claude scanner used to record one row per JSONL entry,
/// but Claude Code writes one entry per content block, all repeating the same
/// API usage — historical rows are inflated ~1.8-2.8x. The scanner now
/// dedupes by (message.id, requestId), which uses a new unique_key scheme, so
/// the old rows must be dropped to avoid double counting. The JSONL files are
/// rescanned on the next scheduler tick and history within log retention is
/// rebuilt with correct numbers. Cloud-side aggregates for this machine are
/// queued for deletion in pending_cloud_purges and processed by the next sync.
fn run_schema_upgrades(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS pending_cloud_purges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tool TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            ready INTEGER NOT NULL DEFAULT 1 CHECK(ready IN (0, 1)),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(tool, machine_id)
        )",
        [],
    )?;

    // Existing databases created the purge queue before staged rebuilds were
    // introduced. Old/manual purge rows are immediately actionable, so the
    // additive column defaults to ready=1.
    let has_purge_ready = {
        let mut stmt = conn.prepare("PRAGMA table_info(pending_cloud_purges)")?;
        let mut rows = stmt.query([])?;
        let mut found = false;
        while let Some(row) = rows.next()? {
            if row.get::<_, String>(1)? == "ready" {
                found = true;
                break;
            }
        }
        found
    };
    if !has_purge_ready {
        conn.execute(
            "ALTER TABLE pending_cloud_purges
             ADD COLUMN ready INTEGER NOT NULL DEFAULT 1 CHECK(ready IN (0, 1))",
            [],
        )?;
    }

    let mut user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if user_version < 2 {
        let machine_id = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown_machine".to_string());

        let deleted = conn.execute("DELETE FROM token_logs WHERE tool = 'claude'", [])?;
        if deleted > 0 {
            log::info!(
                "schema upgrade v2: dropped {deleted} duplicate-inflated claude rows; rescan will rebuild them"
            );
        }
        conn.execute(
            "INSERT OR IGNORE INTO pending_cloud_purges (tool, machine_id) VALUES ('claude', ?1)",
            params![machine_id],
        )?;
        conn.execute_batch("PRAGMA user_version = 2")?;
        user_version = 2;
    }
    if user_version < 3 {
        let machine_id = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown_machine".to_string());

        let mut stmt = conn.prepare("SELECT DISTINCT tool FROM token_logs")?;
        let mut rows = stmt.query([])?;
        let mut tools = Vec::new();
        while let Some(row) = rows.next()? {
            let tool: String = row.get(0)?;
            tools.push(tool);
        }

        for tool in tools {
            conn.execute(
                "INSERT OR IGNORE INTO pending_cloud_purges (tool, machine_id) VALUES (?1, ?2)",
                params![tool, machine_id],
            )?;
        }

        conn.execute(
            "UPDATE token_logs SET sync_status = 0, cloud_user_id = NULL, synced_at = NULL",
            [],
        )?;

        conn.execute_batch("PRAGMA user_version = 3")?;
        log::info!(
            "schema upgrade v3: queued cloud purges and reset sync status for all tools on machine {}",
            machine_id
        );
    }
    if user_version < 4 {
        // These scanners never receive a provider-reported cost; every
        // non-NULL value was estimated locally. Reprice them after the
        // GPT-5.6/model-catalog and inclusive-cache fixes while preserving
        // provider-reported costs from OpenCode, Hermes, ReasoniX, etc.
        let affected = conn.execute(
            "UPDATE token_logs
             SET cost_usd = NULL,
                 sync_status = 0
             WHERE tool IN ('claude', 'codex', 'trae', 'zcode')",
            [],
        )?;
        // The cache table may not exist yet on a fresh install.
        let _ = conn.execute("DELETE FROM local_stats_cache", []);
        conn.execute_batch("PRAGMA user_version = 4")?;
        log::info!(
            "schema upgrade v4: cleared {} derived costs for repricing and resync",
            affected
        );
        user_version = 4;
    }
    if user_version < 5 {
        // Existing installations should surface models already present in
        // token_logs even when their source log files are no longer retained.
        let backfilled = conn.execute(
            "INSERT OR IGNORE INTO discovered_models
                (tool, model_key, model, first_seen_at, last_seen_at)
             SELECT lower(trim(tool)), lower(trim(model)), trim(model),
                    MIN(timestamp), MAX(timestamp)
             FROM token_logs
             WHERE trim(model) <> ''
             GROUP BY lower(trim(tool)), lower(trim(model))",
            [],
        )?;
        conn.execute_batch("PRAGMA user_version = 5")?;
        log::info!(
            "schema upgrade v5: indexed {} existing local model types for price discovery",
            backfilled
        );
        user_version = 5;
    }
    if user_version < 6 {
        // v6 used to delete every Codex row here and rely on a later scan to
        // restore it. A parse/read failure could therefore destroy the only
        // retained history and let idle sync purge the cloud first. v9 owns a
        // staged, atomic rebuild; advancing this legacy marker without data
        // mutation is required for databases upgrading through v5/v6/v7/v8.
        conn.execute_batch("PRAGMA user_version = 6")?;
        log::info!("schema upgrade v6: deferred destructive Codex rebuild to staged schema v9");
        user_version = 6;
    }
    if user_version < 7 {
        // Strip custom provider/proxy prefixes (e.g. "minimax-cn-anthropic/MiniMax-M3" -> "MiniMax-M3")
        // from historical token_logs and discovered_models.
        let mut stmt =
            conn.prepare("SELECT DISTINCT id, model FROM token_logs WHERE model LIKE '%/%'")?;
        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let raw_model: String = row.get(1)?;
                Ok((id, raw_model))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut cleaned_count = 0;
        for (id, raw_model) in rows {
            let cleaned = crate::scanner::clean_model_name(&raw_model);
            if cleaned != raw_model {
                conn.execute(
                    "UPDATE token_logs SET model = ?1, sync_status = 0 WHERE id = ?2",
                    params![cleaned, id],
                )?;
                cleaned_count += 1;
            }
        }

        let mut stmt_dm = conn
            .prepare("SELECT DISTINCT tool, model FROM discovered_models WHERE model LIKE '%/%'")?;
        let rows_dm = stmt_dm
            .query_map([], |row| {
                let tool: String = row.get(0)?;
                let raw_model: String = row.get(1)?;
                Ok((tool, raw_model))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        for (tool, raw_model) in rows_dm {
            let cleaned = crate::scanner::clean_model_name(&raw_model);
            let cleaned_key = cleaned.to_ascii_lowercase();
            conn.execute(
                "DELETE FROM discovered_models WHERE tool = ?1 AND (model = ?2 OR model_key = ?3)",
                params![tool, raw_model, cleaned_key],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO discovered_models (tool, model_key, model, first_seen_at, last_seen_at)
                 SELECT lower(trim(tool)), lower(trim(model)), trim(model), MIN(timestamp), MAX(timestamp)
                 FROM token_logs WHERE lower(trim(tool)) = lower(trim(?1)) AND lower(trim(model)) = ?2",
                params![tool, cleaned_key],
            )?;
        }

        let _ = conn.execute("DELETE FROM local_stats_cache", []);
        conn.execute_batch("PRAGMA user_version = 7")?;
        log::info!(
            "schema upgrade v7: cleaned {} proxy/provider prefixed model names in token_logs",
            cleaned_count
        );
        user_version = 7;
    }
    if user_version < 8 {
        // ReasoniX crash-recovery forks used to keep their own cumulative
        // baseline even though their telemetry re-reports the parent's
        // counters. The scanner now keys the whole family by its root session
        // id; fold the existing per-fork baselines onto that key at the
        // family's high-water mark so the first scan after this upgrade does
        // not re-insert tokens the fork rows already recorded.
        //
        // token_logs is deliberately left alone: those rows are real evidence
        // of what the ledger reported, and the source files for most of the
        // affected sessions are already gone, so a purge-and-rescan would
        // delete history that cannot be rebuilt.
        let folded = fold_reasonix_recovery_state(conn)?;
        let _ = conn.execute("DELETE FROM local_stats_cache", []);
        conn.execute_batch("PRAGMA user_version = 8")?;
        log::info!(
            "schema upgrade v8: folded {folded} reasonix recovery-fork cumulative baselines into their root sessions"
        );
        user_version = 8;
    }
    if user_version < 9 {
        // Merely stage the rebuild during init. The existing rows, checkpoints
        // and caches remain the last-known-good view until the scanner proves
        // that a complete source inventory parsed successfully. This is one
        // transaction so a crash cannot leave an actionable purge without the
        // corresponding version marker (or vice versa).
        let tx = conn.unchecked_transaction()?;
        let has_any_codex_rows: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM token_logs WHERE tool = 'codex' LIMIT 1)",
            [],
            |row| row.get(0),
        )?;
        let has_any_codex_purge: bool = tx.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM pending_cloud_purges WHERE tool = 'codex' LIMIT 1
             )",
            [],
            |row| row.get(0),
        )?;
        let checkpoint_table_exists: bool = tx.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'scan_checkpoints'
             )",
            [],
            |row| row.get(0),
        )?;
        let has_codex_checkpoints = if checkpoint_table_exists {
            tx.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM scan_checkpoints
                     WHERE source_kind LIKE ?1 || '%' LIMIT 1
                 )",
                [CODEX_CHECKPOINT_SOURCE_PREFIX],
                |row| row.get::<_, bool>(0),
            )?
        } else {
            false
        };

        if has_any_codex_rows || has_codex_checkpoints || has_any_codex_purge {
            let machine_id = hostname::get()
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
                .to_string_lossy()
                .trim()
                .to_string();
            if machine_id.is_empty() || machine_id == "unknown_machine" {
                return Err(rusqlite::Error::InvalidParameterName(
                    "cannot stage Codex rebuild without a trustworthy machine id".to_string(),
                ));
            }
            let has_current_codex_rows: bool = tx.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM token_logs
                     WHERE tool = 'codex' AND (machine_id = ?1 OR machine_id = '')
                     LIMIT 1
                 )",
                [&machine_id],
                |row| row.get(0),
            )?;
            let has_current_codex_purge: bool = tx.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM pending_cloud_purges
                     WHERE tool = 'codex' AND machine_id = ?1
                     LIMIT 1
                 )",
                [&machine_id],
                |row| row.get(0),
            )?;
            if has_current_codex_rows || has_codex_checkpoints || has_current_codex_purge {
                tx.execute(
                    "INSERT INTO pending_cloud_purges (tool, machine_id, ready)
                     VALUES ('codex', ?1, 0)
                     ON CONFLICT(tool, machine_id) DO UPDATE SET
                         ready = 0,
                         created_at = datetime('now')",
                    params![machine_id],
                )?;
                log::info!(
                    "schema upgrade v9: staged safe Codex rebuild for machine {machine_id}; old rows remain active until an atomic scan swap"
                );
            }
        }
        tx.pragma_update(None, "user_version", 9)?;
        tx.commit()?;
    }
    if user_version < 10 {
        // Zcode rows were stored with the provider's inclusive input field,
        // which counts cache reads into input_tokens and inflated effective
        // tokens (locally ~58x). Drop them; scan_zcode is a checkpoint-free
        // full rescan, so the next pass rebuilds the rows with net input. The
        // cloud purge makes the next sync re-upload corrected rows (the
        // deleted local rows may already have been synced in inclusive form).
        let machine_id = hostname::get()
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
            .to_string_lossy()
            .trim()
            .to_string();
        let deleted = conn.execute("DELETE FROM token_logs WHERE tool = 'zcode'", [])?;
        if deleted > 0 {
            log::info!(
                "schema upgrade v10: dropped {deleted} inclusive-input zcode rows; rescan will rebuild them with net input"
            );
        }
        conn.execute(
            "INSERT OR IGNORE INTO pending_cloud_purges (tool, machine_id) VALUES ('zcode', ?1)",
            params![machine_id],
        )?;
        let _ = conn.execute("DELETE FROM local_stats_cache", []);
        conn.execute_batch("PRAGMA user_version = 10")?;
        user_version = 10;
    }
    if user_version < 11 {
        // MiniMax Code 从 2026-08-24 起不再写 `model` 列。旧扫描器在这种情况下
        // 回退到 `mavis-{agent_name}`，于是账本里出现了 `mavis-mavis`、
        // `mavis-explore`、`mavis-worker` 这些**供应商从未返回过的模型名**；又因
        // 为它们不以 "minimax" 开头，同一个 App 的消耗还被从 `minimax` 改判成
        // `marvis`，看板上 `minimax` 直接拉平。
        //
        // 与 v10 的 zcode 情况不同：这里 token 数值本身是对的，错的只有 tool 和
        // model 两个标签，所以就地改写即可，不需要删行重扫。`unique_key` 是
        // `mavis_{session}_{id}`，不含 tool/model，改写不影响去重；云端 upsert 键
        // 是 (user_id, unique_key)，把 sync_status 归零就能让下一次同步覆盖掉云端
        // 的错误标签，因此也不需要 pending_cloud_purges。
        let relabelled = conn.execute(
            "UPDATE token_logs
                SET tool = 'minimax',
                    model = 'minimax-unknown',
                    sync_status = 0,
                    cloud_user_id = NULL,
                    synced_at = NULL
              WHERE tool = 'marvis' AND model LIKE 'mavis-%'",
            [],
        )?;
        if relabelled > 0 {
            log::info!(
                "schema upgrade v11: relabelled {relabelled} fabricated MiniMax model rows to minimax/minimax-unknown and queued them for re-sync"
            );
            let _ = conn.execute("DELETE FROM local_stats_cache", []);
        }
        conn.execute_batch("PRAGMA user_version = 11")?;
    }
    if user_version < 12 {
        // Gemini CLI usage was initially interpreted as already-net input and
        // omitted thinking tokens. The current writer stores the official API
        // prompt (inclusive of cache), candidates, thoughts and total fields;
        // drop the old rows and checkpoints so the v2 scanner can rebuild them
        // from source evidence instead of leaving mixed semantics in one
        // ledger. Cloud rows are purged before the corrected rows are synced.
        let machine_id = hostname::get()
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
            .to_string_lossy()
            .trim()
            .to_string();
        let deleted = conn.execute("DELETE FROM token_logs WHERE tool = 'gemini'", [])?;
        let checkpoint_table_exists: bool = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'scan_checkpoints'
             )",
            [],
            |row| row.get(0),
        )?;
        if checkpoint_table_exists {
            conn.execute(
                "DELETE FROM scan_checkpoints WHERE source_kind LIKE 'gemini-cli-chats-%'",
                [],
            )?;
        }
        if deleted > 0 {
            conn.execute(
                "INSERT OR IGNORE INTO pending_cloud_purges (tool, machine_id) VALUES ('gemini', ?1)",
                params![machine_id],
            )?;
            log::info!(
                "schema upgrade v12: dropped {deleted} legacy Gemini rows; v2 scanner will rebuild official prompt/thoughts semantics"
            );
        }
        let _ = conn.execute("DELETE FROM local_stats_cache", []);
        conn.execute_batch("PRAGMA user_version = 12")?;
    }
    if user_version < PROJECT_INDEX_SCHEMA_VERSION {
        // v13 (T10.165, user decision D5②): the opt-in, local-only project
        // index. Only creates the two empty tables; `token_logs`, unique keys,
        // checkpoints, cursors and the sync path are untouched. One transaction
        // so the tables and the version marker land together.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(PROJECT_INDEX_V13_SQL)?;
        tx.pragma_update(None, "user_version", PROJECT_INDEX_SCHEMA_VERSION)?;
        tx.commit()?;
    }
    if user_version < SYNC_REVISION_SCHEMA_VERSION {
        // Keep the column, trigger and marker atomic; existing rows and cloud
        // keys remain unchanged. Older writers are fenced by the trigger too.
        let tx = conn.unchecked_transaction()?;
        let has_revision: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('token_logs') WHERE name = 'sync_revision')",
            [], |row| row.get(0),
        )?;
        if !has_revision {
            tx.execute_batch(
                "ALTER TABLE token_logs ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 0",
            )?;
        }
        let previous_trigger: Option<String> = tx.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'token_logs_sync_revision'",
            [], |row| row.get(0),
        ).optional()?;
        if let Some(sql) = previous_trigger {
            // A later database with a restored old marker may already have the
            // exact migration. Never silently accept an unrelated trigger.
            if sql.trim().trim_end_matches(';')
                != SYNC_REVISION_TRIGGER_V14_SQL.trim().trim_end_matches(';')
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
        } else {
            tx.execute_batch(SYNC_REVISION_TRIGGER_V14_SQL)?;
        }
        tx.pragma_update(None, "user_version", SYNC_REVISION_SCHEMA_VERSION)?;
        tx.commit()?;
    }
    if user_version < DATA_CONSISTENCY_SCHEMA_VERSION {
        let tx = conn.unchecked_transaction()?;
        // Fresh databases have not initialized the cumulative table yet.
        init_scan_cumulative_state(&tx)?;
        let has_generation: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('scan_cumulative_state') WHERE name = 'generation')",
            [], |row| row.get(0),
        )?;
        if !has_generation {
            tx.execute_batch("ALTER TABLE scan_cumulative_state ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)")?;
        }
        tx.execute_batch(SCAN_CLOUD_IDENTITIES_V15_SQL)?;
        tx.pragma_update(None, "user_version", DATA_CONSISTENCY_SCHEMA_VERSION)?;
        tx.commit()?;
    }
    if user_version < ANTIGRAVITY_PROVENANCE_SCHEMA_VERSION {
        migrate_antigravity_provenance(conn)?;
    }
    Ok(())
}

fn migrate_antigravity_provenance(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (column, ddl) in [
        ("usage_provenance", "ALTER TABLE token_logs ADD COLUMN usage_provenance TEXT CHECK(usage_provenance IN ('reported', 'estimated'))"),
        ("cache_write_known", "ALTER TABLE token_logs ADD COLUMN cache_write_known INTEGER CHECK(cache_write_known IN (0, 1))"),
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('token_logs') WHERE name = ?1)",
            [column], |row| row.get(0),
        )?;
        if !exists {
            tx.execute_batch(ddl)?;
        }
    }
    // Earlier Antigravity rows were character estimates, never confirmed zero
    // cache writes. Preserve their values/keys and re-queue just those rows.
    tx.execute(
        "UPDATE token_logs SET usage_provenance = 'estimated', cache_write_known = 0, sync_status = 0
         WHERE tool = 'antigravity' AND usage_provenance IS NULL", [],
    )?;
    // init_db initializes this cache after schema upgrades. A fresh/older
    // database may not have it yet; existing cache deletion errors must abort.
    let cache_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_stats_cache')",
        [], |row| row.get(0),
    )?;
    if cache_exists {
        tx.execute("DELETE FROM local_stats_cache", [])?;
    }
    tx.pragma_update(None, "user_version", ANTIGRAVITY_PROVENANCE_SCHEMA_VERSION)?;
    tx.commit()
}

/// True while schema v9 is retaining the old Codex rows and waiting for a
/// complete replacement scan. Sync must exclude those rows and must not run
/// the paired cloud purge until `complete_codex_rebuild_swap` marks it ready.
pub fn codex_rebuild_pending(conn: &Connection, machine_id: &str) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM pending_cloud_purges
             WHERE tool = 'codex' AND machine_id = ?1 AND ready = 0
             LIMIT 1
         )",
        [machine_id],
        |row| row.get(0),
    )
}

/// Starts the destructive half of a Codex rebuild inside the scanner's write
/// transaction. Only sessions proven present in the parsed inventory are
/// replaced; orphan history whose rollout is gone is deliberately retained.
/// New rows and checkpoints must be persisted in this same transaction before
/// calling `complete_codex_rebuild_swap`.
pub fn prepare_codex_rebuild_swap(
    tx: &Transaction<'_>,
    machine_id: &str,
    plan: &CodexRebuildPlan,
) -> Result<usize> {
    if !codex_rebuild_pending(tx, machine_id)? {
        return Err(rusqlite::Error::InvalidParameterName(
            "Codex rebuild swap requires a staged ready=0 purge".to_string(),
        ));
    }

    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS codex_rebuild_session_ids (
             session_id TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         DELETE FROM temp.codex_rebuild_session_ids;",
    )?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO temp.codex_rebuild_session_ids (session_id) VALUES (?1)",
        )?;
        let mut inserted_ids = 0usize;
        for session_id in plan
            .legacy_session_ids
            .iter()
            .chain(plan.root_session_ids.iter())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            inserted_ids += stmt.execute([session_id])?;
        }
        if inserted_ids == 0 {
            return Err(rusqlite::Error::InvalidParameterName(
                "Codex rebuild inventory contains no session identities".to_string(),
            ));
        }
    }

    let deleted = tx.execute(
        "DELETE FROM token_logs
         WHERE tool = 'codex'
           AND (machine_id = ?1 OR machine_id = '')
           AND session_id IN (SELECT session_id FROM temp.codex_rebuild_session_ids)",
        [machine_id],
    )?;

    // A whole-machine cloud purge will remove both rebuilt sessions and any
    // retained orphan hours. Requeue every surviving local Codex row so the
    // orphan history is restored after the purge instead of disappearing.
    tx.execute(
        "UPDATE token_logs
         SET sync_status = 0, cloud_user_id = NULL, synced_at = NULL
         WHERE tool = 'codex' AND (machine_id = ?1 OR machine_id = '')",
        [machine_id],
    )?;
    tx.execute(
        "DELETE FROM scan_checkpoints WHERE source_kind LIKE ?1 || '%'",
        [CODEX_CHECKPOINT_SOURCE_PREFIX],
    )?;
    tx.execute("DELETE FROM local_stats_cache", [])?;
    Ok(deleted)
}

/// Makes the paired cloud purge actionable only after corrected rows and their
/// checkpoints have been written successfully in the same transaction.
pub fn complete_codex_rebuild_swap(tx: &Transaction<'_>, machine_id: &str) -> Result<()> {
    let updated = tx.execute(
        "UPDATE pending_cloud_purges
         SET ready = 1
         WHERE tool = 'codex' AND machine_id = ?1 AND ready = 0",
        [machine_id],
    )?;
    if updated != 1 {
        return Err(rusqlite::Error::InvalidParameterName(
            "Codex rebuild completion lost its staged purge".to_string(),
        ));
    }
    Ok(())
}

/// Collapses `scan_cumulative_state` rows belonging to ReasoniX recovery forks
/// onto their root session key, keeping the per-field maximum. Returns how
/// many fork rows were removed.
fn fold_reasonix_recovery_state(conn: &Connection) -> Result<usize> {
    // Upgrades run before the cumulative-state table is created, so a fresh
    // install has nothing to fold.
    let table_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'table' AND name = 'scan_cumulative_state'",
        [],
        |row| row.get(0),
    )?;
    if table_exists == 0 {
        return Ok(0);
    }

    let mut stmt = conn.prepare(
        "SELECT unique_key, input_tokens, output_tokens, cached_tokens,
                cache_write_tokens, cost_usd
         FROM scan_cumulative_state
         WHERE unique_key LIKE 'reasonix\\_%' ESCAPE '\\'",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<f64>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut families: BTreeMap<String, (i64, i64, i64, i64, Option<f64>)> = BTreeMap::new();
    let mut fork_keys = Vec::new();
    for (unique_key, input, output, cached, cache_write, cost) in rows {
        let Some(session_id) = unique_key.strip_prefix("reasonix_") else {
            continue;
        };
        let root_key = format!(
            "reasonix_{}",
            crate::scanner::reasonix_root_session_id(session_id)
        );
        if root_key != unique_key {
            fork_keys.push(unique_key);
        }
        let slot = families.entry(root_key).or_insert((0, 0, 0, 0, None));
        slot.0 = slot.0.max(input);
        slot.1 = slot.1.max(output);
        slot.2 = slot.2.max(cached);
        slot.3 = slot.3.max(cache_write);
        slot.4 = match (slot.4, cost) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }

    if fork_keys.is_empty() {
        return Ok(0);
    }

    for (root_key, (input, output, cached, cache_write, cost)) in families {
        conn.execute(
            "INSERT INTO scan_cumulative_state (
                 unique_key, input_tokens, output_tokens, cached_tokens,
                 cache_write_tokens, cost_usd, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(unique_key) DO UPDATE SET
                 input_tokens = excluded.input_tokens,
                 output_tokens = excluded.output_tokens,
                 cached_tokens = excluded.cached_tokens,
                 cache_write_tokens = excluded.cache_write_tokens,
                 cost_usd = excluded.cost_usd,
                 updated_at = excluded.updated_at",
            params![root_key, input, output, cached, cache_write, cost],
        )?;
    }
    for fork_key in &fork_keys {
        conn.execute(
            "DELETE FROM scan_cumulative_state WHERE unique_key = ?1",
            params![fork_key],
        )?;
    }
    Ok(fork_keys.len())
}

/// Initialize the local stats cache table used by commands::get_cached_stats.
/// Kept as a separate function so unit tests can build the schema without
/// running the full migration.
pub fn init_local_cache(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS local_stats_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL,
            range_key TEXT NOT NULL,
            device_filter TEXT NOT NULL,
            data_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(scope, range_key, device_filter)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS local_stats_cache_lookup_idx
            ON local_stats_cache (scope, range_key, device_filter)",
        [],
    )?;
    Ok(())
}

fn migrate_legacy_db(new_db_path: &PathBuf) -> Result<()> {
    let current_dir = std::env::current_dir().unwrap_or_default();
    #[cfg(target_os = "macos")]
    let old_paths = {
        let mut paths = vec![current_dir.join("tokenboard.db")];
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(PathBuf::from(home).join("Desktop/tokenboard/tokenboard.db"));
        }
        paths
    };
    #[cfg(not(target_os = "macos"))]
    let old_paths = vec![current_dir.join("tokenboard.db")];

    let machine_id = crate::device_identity::for_db_or_unknown(new_db_path);

    for old_p in old_paths {
        if !old_p.exists() || old_p == *new_db_path {
            continue;
        }

        let new_conn = Connection::open(new_db_path)?;
        new_conn.execute(
            "ATTACH DATABASE ? AS old_db",
            [old_p.to_string_lossy().to_string()],
        )?;

        let table_exists: Result<i64> = new_conn.query_row(
            "SELECT 1 FROM old_db.sqlite_master WHERE type='table' AND name='token_logs'",
            [],
            |r| r.get(0),
        );
        if table_exists.is_err() {
            let _ = new_conn.execute("DETACH DATABASE old_db", []);
            continue;
        }

        let mut check_stmt = new_conn.prepare("PRAGMA old_db.table_info(token_logs)")?;
        let mut check_rows = check_stmt.query([])?;
        let mut old_has_cost = false;
        let mut old_has_machine_id = false;
        while let Some(row) = check_rows.next()? {
            let name: String = row.get(1)?;
            match name.as_str() {
                "cost_usd" => old_has_cost = true,
                "machine_id" => old_has_machine_id = true,
                _ => {}
            }
        }
        drop(check_rows);
        drop(check_stmt);

        let cost_expr = if old_has_cost { "cost_usd" } else { "NULL" };
        let machine_expr = if old_has_machine_id {
            "COALESCE(NULLIF(machine_id, ''), ?1)"
        } else {
            "?1"
        };
        // Claude and Codex legacy rows predate their corrected dedup/cache
        // normalization. Their JSONL sources of truth are rescanned instead.
        let insert_sql = format!(
            "INSERT OR IGNORE INTO token_logs
             (tool, model, input_tokens, output_tokens, cached_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status)
             SELECT tool, model, input_tokens, output_tokens, cached_tokens, timestamp, session_id, unique_key, {cost_expr}, {machine_expr}, 0
             FROM old_db.token_logs
             WHERE tool NOT IN ('claude', 'codex')"
        );

        new_conn.execute(&insert_sql, params![machine_id])?;
        new_conn.execute("DETACH DATABASE old_db", [])?;
    }
    Ok(())
}

#[cfg(test)]
mod schema_upgrade_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The version every fully upgraded database ends at.
    const LATEST_SCHEMA_VERSION: i64 = ANTIGRAVITY_PROVENANCE_SCHEMA_VERSION;

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn v15_preserves_cumulative_baseline_and_rolls_back_failed_schema() {
        for inject_failure in [false, true] {
            let path = std::env::temp_dir().join(format!(
                "tokenledger_schema_v15_{}_{}.db",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            init_test_db(&path).unwrap();
            let conn = get_connection(&path).unwrap();
            conn.execute_batch("DROP TRIGGER token_logs_dirty_old_bucket_update;
                DROP TRIGGER token_logs_dirty_old_bucket_delete;
                DROP TABLE scan_cloud_sent_identities; DROP TABLE scan_cloud_dirty_buckets;
                ALTER TABLE scan_cumulative_state DROP COLUMN generation;
                INSERT INTO scan_cumulative_state(unique_key,input_tokens,output_tokens,cached_tokens,cache_write_tokens,cost_usd)
                VALUES('fixture',160,90,0,0,0.8); PRAGMA user_version=14;").unwrap();
            if inject_failure {
                conn.execute_batch("CREATE TABLE scan_cloud_dirty_owner(value INTEGER)")
                    .unwrap();
            }
            let result = run_schema_upgrades(&conn);
            assert_eq!(result.is_err(), inject_failure);
            let baseline: (i64, i64, f64) = conn
                .query_row(
                    "SELECT input_tokens,output_tokens,cost_usd FROM scan_cumulative_state",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(baseline, (160, 90, 0.8));
            assert_eq!(user_version(&conn), if inject_failure { 14 } else { 16 });
            if inject_failure {
                assert!(conn
                    .prepare("SELECT generation FROM scan_cumulative_state")
                    .is_err());
                assert!(conn
                    .prepare("SELECT * FROM scan_cloud_dirty_buckets")
                    .is_err());
            } else {
                assert_eq!(
                    conn.query_row("SELECT generation FROM scan_cumulative_state", [], |r| r
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
                run_schema_upgrades(&conn).unwrap();
                assert_eq!(table_rows(&conn, "scan_cloud_dirty_buckets"), 0);
            }
            drop(conn);
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn provider_source_cursors_round_trip_and_advance_atomically() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_source_cursor_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_test_db(&path).expect("initialize test db");

        let mut conn = Connection::open(&path).expect("open test db");
        let tx = conn.transaction().expect("begin cursor transaction");
        upsert_scan_source_cursors(
            &tx,
            &[ScanSourceCursor {
                source_kind: "provider-v1".to_string(),
                source_path: "C:/provider/data.db".to_string(),
                source_identity: "windows:1:2".to_string(),
                cursor_primary: "42".to_string(),
                cursor_secondary: "row-42".to_string(),
                size_bytes: 1024,
                modified_ns: 123,
                parser_version: 1,
            }],
        )
        .expect("upsert cursor");
        tx.commit().expect("commit cursor");

        let cursors = load_scan_source_cursors(&conn).expect("load cursor");
        let cursor = cursors
            .get(&("provider-v1".to_string(), "C:/provider/data.db".to_string()))
            .expect("persisted cursor");
        assert_eq!(cursor.cursor_primary, "42");
        assert_eq!(cursor.cursor_secondary, "row-42");

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn local_detail_indexes_cover_range_and_entity_keyset_paths() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_detail_indexes_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        for name in [
            "token_logs_timestamp_id_idx",
            "token_logs_tool_timestamp_id_idx",
            "token_logs_model_timestamp_id_idx",
            "token_logs_machine_timestamp_id_idx",
            "token_logs_tool_model_machine_timestamp_id_idx",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'index' AND name = ?1",
                    [name],
                    |row| row.get(0),
                )
                .expect("query index metadata");
            assert_eq!(count, 1, "missing detail index {name}");
        }

        let entity_plan: Vec<String> = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT id FROM token_logs
                 WHERE tool = ?1 AND model = ?2 AND machine_id = ?3
                   AND timestamp >= ?4 AND timestamp <= ?5
                 ORDER BY timestamp DESC, id DESC LIMIT 101",
            )
            .expect("prepare entity query plan")
            .query_map(
                params![
                    "codex",
                    "gpt-test",
                    "mac",
                    "2026-07-01 00:00:00",
                    "2026-07-31 23:59:59"
                ],
                |row| row.get(3),
            )
            .expect("explain entity query")
            .collect::<Result<Vec<_>>>()
            .expect("collect entity plan");
        assert!(
            entity_plan
                .iter()
                .any(|line| { line.contains("token_logs_tool_model_machine_timestamp_id_idx") }),
            "entity detail query should use the composite keyset index: {entity_plan:?}"
        );

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn existing_database_gets_scan_checkpoint_table_without_data_loss() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_checkpoint_migration_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        let legacy = Connection::open(&path).expect("open legacy database");
        legacy
            .execute_batch(
                "CREATE TABLE token_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tool TEXT NOT NULL,
                    model TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    cached_tokens INTEGER DEFAULT 0,
                    timestamp TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    unique_key TEXT UNIQUE NOT NULL
                 );
                 INSERT INTO token_logs (
                    tool, model, input_tokens, output_tokens, cached_tokens,
                    timestamp, session_id, unique_key
                 ) VALUES (
                    'legacy', 'legacy-model', 1, 2, 0,
                    '2026-07-15 00:00:00', 'legacy-session', 'legacy-row'
                 );
                 PRAGMA user_version = 6;",
            )
            .expect("seed legacy database");
        drop(legacy);

        init_test_db(&path).expect("migrate existing database schema");
        let conn = Connection::open(&path).expect("reopen migrated database");
        let checkpoint_columns: Vec<String> = conn
            .prepare("PRAGMA table_info(scan_checkpoints)")
            .expect("prepare checkpoint columns")
            .query_map([], |row| row.get(1))
            .expect("query checkpoint columns")
            .collect::<Result<Vec<_>>>()
            .expect("collect checkpoint columns");
        assert_eq!(
            checkpoint_columns,
            vec![
                "source_kind",
                "source_path",
                "source_identity",
                "size_bytes",
                "modified_ns",
                "processed_offset",
                "updated_at",
            ]
        );
        let legacy_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE unique_key = 'legacy-row'",
                [],
                |row| row.get(0),
            )
            .expect("count preserved legacy row");
        assert_eq!(legacy_rows, 1);
        assert!(load_scan_checkpoints(&conn, "codex-rollout-jsonl-v1")
            .expect("load empty migrated checkpoints")
            .is_empty());

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v4_reprices_only_scanner_derived_costs() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v4_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "INSERT INTO token_logs
                (tool, model, input_tokens, output_tokens, cached_tokens, timestamp,
                 session_id, unique_key, cost_usd, machine_id, sync_status)
             VALUES
                ('trae', 'minimax-m2.7', 100, 10, 80, '2026-07-10 10:00:00',
                 's1', 'trae-derived', 0.01, 'm', 1),
                ('opencode', 'provider-model', 100, 10, 0, '2026-07-10 10:00:00',
                 's2', 'provider-cost', 0.02, 'm', 1);
             PRAGMA user_version = 3;",
        )
        .expect("seed v3 data");

        run_schema_upgrades(&conn).expect("run v4 upgrade");

        let (derived_cost, derived_sync): (Option<f64>, i64) = conn
            .query_row(
                "SELECT cost_usd, sync_status FROM token_logs WHERE unique_key = 'trae-derived'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read derived row");
        let provider_cost: Option<f64> = conn
            .query_row(
                "SELECT cost_usd FROM token_logs WHERE unique_key = 'provider-cost'",
                [],
                |row| row.get(0),
            )
            .expect("read provider row");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version");
        let discovered: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM discovered_models
                 WHERE (tool = 'trae' AND model_key = 'minimax-m2.7')
                    OR (tool = 'opencode' AND model_key = 'provider-model')",
                [],
                |row| row.get(0),
            )
            .expect("count backfilled model discoveries");

        assert_eq!(derived_cost, None);
        assert_eq!(derived_sync, 0);
        assert_eq!(provider_cost, Some(0.02));
        assert_eq!(version, LATEST_SCHEMA_VERSION);
        assert_eq!(discovered, 2);

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v5_to_v9_stages_codex_rebuild_without_deleting_existing_rows() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v6_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        let machine_id = hostname::get()
            .expect("read test hostname")
            .to_string_lossy()
            .to_string();
        conn.execute_batch(
            "DELETE FROM pending_cloud_purges;
             INSERT INTO token_logs
                (tool, model, input_tokens, output_tokens, cached_tokens, timestamp,
                 session_id, unique_key, cost_usd, machine_id, sync_status)
             VALUES
                ('codex', 'gpt-5.6-sol', 100, 10, 80, '2026-07-10 10:00:00',
                 's1', 'codex-stale', 0.01, '', 1),
                ('opencode', 'provider-model', 100, 10, 0, '2026-07-10 10:00:00',
                 's2', 'provider-kept', 0.02, 'm', 1);
             PRAGMA user_version = 5;",
        )
        .expect("seed v5 data");
        conn.execute(
            "INSERT INTO pending_cloud_purges (tool, machine_id, ready)
             VALUES ('codex', ?1, 1)",
            [&machine_id],
        )
        .expect("seed legacy actionable purge");

        run_schema_upgrades(&conn).expect("run staged v9 upgrade");

        let codex_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE tool = 'codex'",
                [],
                |row| row.get(0),
            )
            .expect("count codex rows");
        let provider_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE unique_key = 'provider-kept'",
                [],
                |row| row.get(0),
            )
            .expect("count provider rows");
        let staged_codex_purges: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_cloud_purges
                 WHERE tool = 'codex' AND machine_id = ?1 AND ready = 0",
                [&machine_id],
                |row| row.get(0),
            )
            .expect("count codex purges");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version");

        assert_eq!(
            codex_rows, 1,
            "staging must retain last-known-good Codex rows"
        );
        assert_eq!(provider_rows, 1);
        assert_eq!(staged_codex_purges, 1);
        assert_eq!(version, LATEST_SCHEMA_VERSION);

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v7_cleans_provider_prefixed_models() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v7_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "INSERT INTO token_logs
                (tool, model, input_tokens, output_tokens, cached_tokens, timestamp,
                 session_id, unique_key, cost_usd, machine_id, sync_status)
             VALUES
                ('reasonix', 'minimax-cn-anthropic/MiniMax-M3', 100, 10, 0, '2026-08-02 12:00:00',
                 's1', 'k1', 0.1, 'm', 1),
                ('claude', 'BC_CLAUD/deepseek-v4-flash', 200, 20, 0, '2026-08-02 12:00:00',
                 's2', 'k2', 0.2, 'm', 1);
             INSERT INTO discovered_models (tool, model_key, model, first_seen_at, last_seen_at)
             VALUES
                ('reasonix', 'minimax-cn-anthropic/minimax-m3', 'minimax-cn-anthropic/MiniMax-M3', '2026-08-02 12:00:00', '2026-08-02 12:00:00');
             PRAGMA user_version = 6;",
        )
        .expect("seed v6 prefixed data");

        run_schema_upgrades(&conn).expect("run v7 upgrade");

        let model1: String = conn
            .query_row(
                "SELECT model FROM token_logs WHERE unique_key = 'k1'",
                [],
                |r| r.get(0),
            )
            .expect("read k1 model");
        let model2: String = conn
            .query_row(
                "SELECT model FROM token_logs WHERE unique_key = 'k2'",
                [],
                |r| r.get(0),
            )
            .expect("read k2 model");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version");

        assert_eq!(model1, "MiniMax-M3");
        assert_eq!(model2, "deepseek-v4-flash");
        assert_eq!(version, LATEST_SCHEMA_VERSION);

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v8_folds_reasonix_recovery_baselines_into_the_root_session() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v8_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        // Real shape from a Windows profile: the base session plus two forks
        // whose telemetry re-reports it, each with its own baseline row.
        conn.execute_batch(
            "INSERT INTO scan_cumulative_state
                (unique_key, input_tokens, output_tokens, cached_tokens,
                 cache_write_tokens, cost_usd, updated_at)
             VALUES
                ('reasonix_20260806-033150.212737500-deepseek-deepseek-v4-pro',
                 120280, 8832, 1193728, 0, 0.0816, '2026-08-06T13:21:45.397Z'),
                ('reasonix_20260806-033150.212737500-deepseek-deepseek-v4-pro-recovery-c1d49fa41c445687',
                 144497, 12672, 1279744, 0, 0.1153, '2026-08-06T13:21:45.397Z'),
                ('reasonix_20260806-033150.212737500-deepseek-deepseek-v4-pro-7b8579ec21a9-recovery-2fc94e3b0d68012c',
                 490546, 48159, 7947776, 0, 0.6656, '2026-08-06T13:21:45.030Z'),
                ('reasonix_desktop-202605280926-1', 33631842, 108273, 0, 0, 5.7126, '2026-07-20T03:58:29.246Z');
             PRAGMA user_version = 7;",
        )
        .expect("seed v7 cumulative state");

        run_schema_upgrades(&conn).expect("run v8 upgrade");

        let (input, output, cached, cost): (i64, i64, i64, Option<f64>) = conn
            .query_row(
                "SELECT input_tokens, output_tokens, cached_tokens, cost_usd
                 FROM scan_cumulative_state
                 WHERE unique_key = 'reasonix_20260806-033150.212737500-deepseek-deepseek-v4-pro'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read folded root state");
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scan_cumulative_state WHERE unique_key LIKE '%recovery%'",
                [],
                |row| row.get(0),
            )
            .expect("count fork rows");
        let untouched: i64 = conn
            .query_row(
                "SELECT input_tokens FROM scan_cumulative_state
                 WHERE unique_key = 'reasonix_desktop-202605280926-1'",
                [],
                |row| row.get(0),
            )
            .expect("read unrelated session");

        // The family is a chain, so its true total is the deepest fork's
        // high-water mark, not the sum the ledger used to record.
        assert_eq!(input, 490546);
        assert_eq!(output, 48159);
        assert_eq!(cached, 7947776);
        assert_eq!(cost, Some(0.6656));
        assert_eq!(remaining, 0, "fork baselines are removed");
        assert_eq!(untouched, 33631842, "unrelated sessions keep their state");

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v9_stages_recovery_when_old_v6_left_only_codex_checkpoints() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v9_checkpoint_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "DELETE FROM pending_cloud_purges;
             INSERT INTO scan_checkpoints (
                 source_kind, source_path, source_identity,
                 size_bytes, modified_ns, processed_offset
             ) VALUES (
                 'codex-rollout-jsonl-v1', 'C:/codex/legacy.jsonl', 'legacy-id',
                 100, 1, 100
             );
             PRAGMA user_version = 8;",
        )
        .expect("seed checkpoint-only v8 state");

        run_schema_upgrades(&conn).expect("stage checkpoint-only rebuild");

        let machine_id = hostname::get()
            .expect("read test hostname")
            .to_string_lossy()
            .to_string();
        assert!(
            codex_rebuild_pending(&conn, &machine_id).expect("query staged rebuild"),
            "an installation already damaged by old v6 still needs a full recovery scan"
        );
        let checkpoint_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scan_checkpoints
                 WHERE source_kind = 'codex-rollout-jsonl-v1'",
                [],
                |row| row.get(0),
            )
            .expect("count retained checkpoint");
        assert_eq!(checkpoint_count, 1, "staging must not mutate checkpoints");

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v9_disarms_old_v6_purge_even_when_no_codex_rows_or_checkpoints_remain() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v9_old_purge_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        let machine_id = hostname::get()
            .expect("read test hostname")
            .to_string_lossy()
            .to_string();
        conn.execute_batch(
            "DELETE FROM token_logs WHERE tool = 'codex';
             DELETE FROM scan_checkpoints
                 WHERE source_kind LIKE 'codex-rollout-jsonl-%';
             DELETE FROM pending_cloud_purges;",
        )
        .expect("clear newer Codex state");
        conn.execute(
            "INSERT INTO pending_cloud_purges (tool, machine_id, ready)
             VALUES ('codex', ?1, 1)",
            [&machine_id],
        )
        .expect("seed old v6 actionable purge");
        conn.pragma_update(None, "user_version", 8)
            .expect("rewind schema marker");

        run_schema_upgrades(&conn).expect("stage old purge recovery");

        assert!(codex_rebuild_pending(&conn, &machine_id).expect("query staged rebuild"));
        let actionable: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_cloud_purges
                 WHERE tool = 'codex' AND machine_id = ?1 AND ready = 1",
                [&machine_id],
                |row| row.get(0),
            )
            .expect("count actionable purges");
        assert_eq!(actionable, 0, "v9 must disarm the old destructive queue");

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v9_adds_ready_to_legacy_purge_queue_without_disarming_unrelated_entries() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v9_ready_column_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "DROP TABLE pending_cloud_purges;
             CREATE TABLE pending_cloud_purges (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 tool TEXT NOT NULL,
                 machine_id TEXT NOT NULL,
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 UNIQUE(tool, machine_id)
             );
             INSERT INTO pending_cloud_purges (tool, machine_id)
                 VALUES ('claude', 'machine-a');
             PRAGMA user_version = 8;",
        )
        .expect("seed legacy purge queue");

        run_schema_upgrades(&conn).expect("add staged purge state");

        let ready: i64 = conn
            .query_row(
                "SELECT ready FROM pending_cloud_purges
                 WHERE tool = 'claude' AND machine_id = 'machine-a'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated ready state");
        assert_eq!(ready, 1, "legacy non-Codex purges remain actionable");
        let ready_column_count: i64 = conn
            .prepare("PRAGMA table_info(pending_cloud_purges)")
            .expect("prepare purge columns")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query purge columns")
            .filter_map(|name| name.ok())
            .filter(|name| name == "ready")
            .count() as i64;
        assert_eq!(ready_column_count, 1);

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v9_does_not_stage_or_mutate_codex_rows_owned_by_another_machine() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v9_other_machine_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        let current_machine = hostname::get()
            .expect("read test hostname")
            .to_string_lossy()
            .to_string();
        let other_machine = format!("{current_machine}-other");
        conn.execute("DELETE FROM pending_cloud_purges", [])
            .expect("clear purge queue");
        conn.execute(
            "INSERT INTO token_logs (
                 tool, model, input_tokens, output_tokens, cached_tokens,
                 timestamp, session_id, unique_key, machine_id, sync_status,
                 cloud_user_id, synced_at
             ) VALUES (
                 'codex', 'gpt-test', 1, 2, 3,
                 '2026-08-01 00:00:00', 'other-session', 'other-row', ?1, 1,
                 'cloud-user', '2026-08-01 01:00:00'
             )",
            [&other_machine],
        )
        .expect("seed another machine row");
        conn.pragma_update(None, "user_version", 8)
            .expect("rewind schema marker");

        run_schema_upgrades(&conn).expect("run v9 migration");

        assert!(!codex_rebuild_pending(&conn, &current_machine).expect("query rebuild marker"));
        let retained: (i64, String, Option<String>) = conn
            .query_row(
                "SELECT sync_status, machine_id, cloud_user_id
                 FROM token_logs WHERE unique_key = 'other-row'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retained other-machine row");
        assert_eq!(retained, (1, other_machine, Some("cloud-user".to_string())));

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn codex_rebuild_swap_replaces_inventory_and_preserves_orphans_and_other_tools() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_codex_swap_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let mut conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "INSERT INTO pending_cloud_purges (tool, machine_id, ready)
                 VALUES ('codex', 'machine-a', 0);
             INSERT INTO token_logs (
                 tool, model, input_tokens, output_tokens, cached_tokens,
                 timestamp, session_id, unique_key, machine_id, sync_status,
                 cloud_user_id, synced_at
             ) VALUES
                 ('codex', 'gpt-old', 10, 1, 20, '2026-08-01 00:00:00',
                  'legacy-session', 'old-legacy', 'machine-a', 1, 'cloud-user', '2026-08-01 01:00:00'),
                 ('codex', 'gpt-old', 20, 2, 30, '2026-08-01 00:01:00',
                  'root-session', 'old-root', '', 1, 'cloud-user', '2026-08-01 01:00:00'),
                 ('codex', 'gpt-old', 30, 3, 40, '2026-08-01 00:02:00',
                  'orphan-session', 'orphan-current', 'machine-a', 1, 'cloud-user', '2026-08-01 01:00:00'),
                 ('codex', 'gpt-old', 40, 4, 50, '2026-08-01 00:03:00',
                  'legacy-session', 'other-machine', 'machine-b', 1, 'cloud-user', '2026-08-01 01:00:00'),
                 ('opencode', 'provider', 50, 5, 0, '2026-08-01 00:04:00',
                  'legacy-session', 'other-tool', 'machine-a', 1, 'cloud-user', '2026-08-01 01:00:00');
             INSERT INTO scan_checkpoints (
                 source_kind, source_path, source_identity,
                 size_bytes, modified_ns, processed_offset
             ) VALUES
                 ('codex-rollout-jsonl-v1', 'C:/codex/old.jsonl', 'old', 100, 1, 100),
                 ('claude-jsonl-v1', 'C:/claude/kept.jsonl', 'kept', 100, 1, 100);
             INSERT INTO local_stats_cache
                 (scope, range_key, device_filter, data_json, updated_at)
             VALUES
                 ('local', 'today', 'all', '{}', 1),
                 ('cloud', 'today', 'all', '{}', 1),
                 ('cloud_yesterday', 'today', 'all', '{}', 1);",
        )
        .expect("seed staged rebuild state");

        let tx = conn.transaction().expect("begin rebuild transaction");
        let deleted = prepare_codex_rebuild_swap(
            &tx,
            "machine-a",
            &CodexRebuildPlan {
                legacy_session_ids: vec!["legacy-session".to_string()],
                root_session_ids: vec!["root-session".to_string()],
            },
        )
        .expect("prepare Codex swap");
        assert_eq!(deleted, 2);
        tx.execute(
            "INSERT INTO token_logs (
                 tool, model, input_tokens, output_tokens, cached_tokens,
                 timestamp, session_id, unique_key, machine_id
             ) VALUES (
                 'codex', 'gpt-corrected', 7, 8, 9,
                 '2026-08-01 00:05:00', 'root-session', 'corrected-root', 'machine-a'
             )",
            [],
        )
        .expect("persist corrected row");
        upsert_scan_checkpoints(
            &tx,
            &[ScanCheckpoint {
                source_kind: "codex-rollout-jsonl-v2".to_string(),
                source_path: "C:/codex/new.jsonl".to_string(),
                source_identity: "new".to_string(),
                size_bytes: 200,
                modified_ns: 2,
                processed_offset: 200,
            }],
        )
        .expect("persist replacement checkpoint");
        complete_codex_rebuild_swap(&tx, "machine-a").expect("complete Codex swap");
        tx.commit().expect("commit Codex swap");

        let old_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs
                 WHERE unique_key IN ('old-legacy', 'old-root')",
                [],
                |row| row.get(0),
            )
            .expect("count replaced rows");
        assert_eq!(old_rows, 0);
        let corrected_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE unique_key = 'corrected-root'",
                [],
                |row| row.get(0),
            )
            .expect("count corrected rows");
        assert_eq!(corrected_rows, 1);
        let orphan_sync: (i64, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT sync_status, cloud_user_id, synced_at
                 FROM token_logs WHERE unique_key = 'orphan-current'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retained orphan");
        assert_eq!(orphan_sync, (0, None, None));
        let other_machine_sync: (i64, Option<String>) = conn
            .query_row(
                "SELECT sync_status, cloud_user_id
                 FROM token_logs WHERE unique_key = 'other-machine'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read other-machine row");
        assert_eq!(other_machine_sync, (1, Some("cloud-user".to_string())));
        let other_tool_sync: (i64, Option<String>) = conn
            .query_row(
                "SELECT sync_status, cloud_user_id
                 FROM token_logs WHERE unique_key = 'other-tool'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read other-tool row");
        assert_eq!(other_tool_sync, (1, Some("cloud-user".to_string())));
        let checkpoints: Vec<(String, String)> = conn
            .prepare(
                "SELECT source_kind, source_path FROM scan_checkpoints
                 ORDER BY source_kind, source_path",
            )
            .expect("prepare checkpoint query")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query checkpoints")
            .collect::<Result<Vec<_>>>()
            .expect("collect checkpoints");
        assert_eq!(
            checkpoints,
            vec![
                (
                    "claude-jsonl-v1".to_string(),
                    "C:/claude/kept.jsonl".to_string()
                ),
                (
                    "codex-rollout-jsonl-v2".to_string(),
                    "C:/codex/new.jsonl".to_string()
                ),
            ]
        );
        let cache_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_stats_cache", [], |row| {
                row.get(0)
            })
            .expect("count invalidated cache rows");
        assert_eq!(cache_rows, 0);
        let ready: i64 = conn
            .query_row(
                "SELECT ready FROM pending_cloud_purges
                 WHERE tool = 'codex' AND machine_id = 'machine-a'",
                [],
                |row| row.get(0),
            )
            .expect("read completed purge marker");
        assert_eq!(ready, 1);

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn codex_rebuild_swap_rolls_back_all_destructive_changes_on_failure() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_codex_swap_rollback_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let mut conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "INSERT INTO pending_cloud_purges (tool, machine_id, ready)
                 VALUES ('codex', 'machine-a', 0);
             INSERT INTO token_logs (
                 tool, model, input_tokens, output_tokens, cached_tokens,
                 timestamp, session_id, unique_key, machine_id, sync_status,
                 cloud_user_id, synced_at
             ) VALUES (
                 'codex', 'gpt-old', 10, 1, 20, '2026-08-01 00:00:00',
                 'legacy-session', 'rollback-old', 'machine-a', 1,
                 'cloud-user', '2026-08-01 01:00:00'
             );
             INSERT INTO scan_checkpoints (
                 source_kind, source_path, source_identity,
                 size_bytes, modified_ns, processed_offset
             ) VALUES (
                 'codex-rollout-jsonl-v1', 'C:/codex/old.jsonl', 'old', 100, 1, 100
             );
             INSERT INTO local_stats_cache
                 (scope, range_key, device_filter, data_json, updated_at)
             VALUES ('local', 'today', 'all', '{}', 1);",
        )
        .expect("seed rollback state");

        let tx = conn.transaction().expect("begin rebuild transaction");
        prepare_codex_rebuild_swap(
            &tx,
            "machine-a",
            &CodexRebuildPlan {
                legacy_session_ids: vec!["legacy-session".to_string()],
                root_session_ids: Vec::new(),
            },
        )
        .expect("prepare destructive swap");
        tx.rollback().expect("simulate failed scan batch");

        let row_state: (i64, Option<String>) = conn
            .query_row(
                "SELECT sync_status, cloud_user_id
                 FROM token_logs WHERE unique_key = 'rollback-old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read rolled-back row");
        assert_eq!(row_state, (1, Some("cloud-user".to_string())));
        let checkpoint_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM scan_checkpoints", [], |row| {
                row.get(0)
            })
            .expect("count rolled-back checkpoints");
        assert_eq!(checkpoint_count, 1);
        let cache_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM local_stats_cache", [], |row| {
                row.get(0)
            })
            .expect("count rolled-back cache rows");
        assert_eq!(cache_count, 1);
        assert!(codex_rebuild_pending(&conn, "machine-a").expect("query staged marker"));

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v11_relabels_fabricated_minimax_model_rows_without_touching_values() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v11_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "INSERT INTO token_logs
                (tool, model, input_tokens, output_tokens, cached_tokens, timestamp,
                 session_id, unique_key, cost_usd, machine_id, sync_status, cloud_user_id, synced_at)
             VALUES
                ('marvis', 'mavis-mavis', 584, 937, 159345, '2026-08-24 09:20:00',
                 'mvs_null', 'mavis_mvs_null_1', 0.0, 'm', 1, 'cloud-user', '2026-08-24 09:21:00'),
                ('marvis', 'mavis-explore', 10, 20, 0, '2026-08-24 09:19:00',
                 'mvs_x', 'mavis_mvs_x_2', 0.0, 'm', 1, 'cloud-user', '2026-08-24 09:21:00'),
                ('marvis', 'deepseek-v4-pro-external', 5, 6, 0, '2026-08-21 16:46:00',
                 'mvs_real', 'mavis_mvs_real_3', 0.0, 'm', 1, 'cloud-user', '2026-08-21 16:47:00'),
                ('minimax', 'MiniMax-M3', 7, 8, 0, '2026-08-21 15:30:00',
                 'mvs_named', 'mavis_mvs_named_4', 0.0, 'm', 1, 'cloud-user', '2026-08-21 15:31:00');
             PRAGMA user_version = 10;",
        )
        .expect("seed v10 data");

        run_schema_upgrades(&conn).expect("run v11 upgrade");

        // 拼造出来的两条改判到产生它们的 App，并标为模型未知。
        let relabelled: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs
                 WHERE tool = 'minimax' AND model = 'minimax-unknown'",
                [],
                |row| row.get(0),
            )
            .expect("count relabelled rows");
        assert_eq!(relabelled, 2);

        // 数值一个都不能动：错的只是标签，token 本来就是对的。
        let values: (i64, i64, i64) = conn
            .query_row(
                "SELECT input_tokens, output_tokens, cached_tokens FROM token_logs
                 WHERE unique_key = 'mavis_mvs_null_1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read relabelled row values");
        assert_eq!(values, (584, 937, 159_345));

        // 改写过的行必须重新排队同步，云端 upsert 键是 (user_id, unique_key)，
        // 所以重传就能覆盖掉云端的错误标签，不需要 purge。
        let resync: (i64, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT sync_status, cloud_user_id, synced_at FROM token_logs
                 WHERE unique_key = 'mavis_mvs_null_1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read relabelled row sync state");
        assert_eq!(resync, (0, None, None));

        // 真实模型名的 marvis 行不能被牵连——那是 MiniMax Code 跑别家模型，
        // 归 marvis 本来就是对的。
        let untouched: (String, i64) = conn
            .query_row(
                "SELECT tool, sync_status FROM token_logs WHERE unique_key = 'mavis_mvs_real_3'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read genuine marvis row");
        assert_eq!(untouched, ("marvis".to_string(), 1));

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version");
        assert_eq!(version, LATEST_SCHEMA_VERSION);

        // 重跑迁移链必须幂等：不能把已经同步过的行反复打回未同步。
        conn.execute(
            "UPDATE token_logs SET sync_status = 1 WHERE model = 'minimax-unknown'",
            [],
        )
        .expect("mark relabelled rows synced");
        run_schema_upgrades(&conn).expect("rerun upgrades");
        let still_synced: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE model = 'minimax-unknown' AND sync_status = 1",
                [],
                |row| row.get(0),
            )
            .expect("count still-synced rows");
        assert_eq!(still_synced, 2);

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v10_drops_inclusive_zcode_rows_and_stages_cloud_purge() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v10_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "INSERT INTO token_logs
                (tool, model, input_tokens, output_tokens, cached_tokens, timestamp,
                 session_id, unique_key, cost_usd, machine_id, sync_status)
             VALUES
                ('zcode', 'glm-5.2', 126005, 275, 125568, '2026-08-18 20:00:00',
                 's1', 'zcode-old-inclusive', 0.01, 'm', 1),
                ('codex', 'gpt-5.5', 100, 10, 0, '2026-08-18 20:00:00',
                 's2', 'codex-untouched', 0.02, 'm', 1);
             PRAGMA user_version = 9;",
        )
        .expect("seed v9 data");

        run_schema_upgrades(&conn).expect("run v10 upgrade");

        let zcode_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE tool = 'zcode'",
                [],
                |row| row.get(0),
            )
            .expect("count zcode rows");
        let codex_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE unique_key = 'codex-untouched'",
                [],
                |row| row.get(0),
            )
            .expect("count codex row");
        // init_db already staged one under the device id; v10 stages its
        // purge under the hostname the old rows were uploaded with.
        let purges: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_cloud_purges WHERE tool = 'zcode' AND machine_id = ?1",
                [crate::device_identity::legacy_machine_id()],
                |row| row.get(0),
            )
            .expect("count zcode purge");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version");

        assert_eq!(zcode_rows, 0, "inclusive-input zcode rows must be dropped");
        assert_eq!(codex_rows, 1, "other tools must be untouched");
        assert_eq!(purges, 1, "cloud purge must be staged for zcode");
        assert_eq!(version, LATEST_SCHEMA_VERSION);

        // Re-running the migration chain must stay idempotent.
        run_schema_upgrades(&conn).expect("rerun upgrades");
        let purges_again: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_cloud_purges WHERE tool = 'zcode' AND machine_id = ?1",
                [crate::device_identity::legacy_machine_id()],
                |row| row.get(0),
            )
            .expect("count zcode purge after rerun");
        assert_eq!(purges_again, 1);

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn v12_rebuilds_legacy_gemini_rows_and_checkpoints() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v12_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_db(&path).expect("initialize test db");

        let conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "INSERT INTO token_logs
                (tool, model, input_tokens, output_tokens, cached_tokens, timestamp,
                 session_id, unique_key, cost_usd, machine_id, sync_status)
             VALUES ('gemini', 'gemini-3.5-flash', 100, 10, 20,
                     '2026-08-18 20:00:00', 's1', 'gemini-old', NULL, 'm', 1);
             INSERT INTO scan_checkpoints
                (source_kind, source_path, source_identity, size_bytes,
                 modified_ns, processed_offset)
             VALUES ('gemini-cli-chats-v1', '/tmp/session.jsonl', 'id', 10, 1, 10);
             PRAGMA user_version = 11;",
        )
        .expect("seed legacy Gemini state");

        run_schema_upgrades(&conn).expect("run v12 upgrade");
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE tool = 'gemini'",
                [],
                |row| row.get(0),
            )
            .expect("count Gemini rows");
        let checkpoints: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scan_checkpoints WHERE source_kind LIKE 'gemini-cli-chats-%'",
                [],
                |row| row.get(0),
            )
            .expect("count Gemini checkpoints");
        let purges: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_cloud_purges WHERE tool = 'gemini'",
                [],
                |row| row.get(0),
            )
            .expect("count Gemini purge");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version");
        assert_eq!(rows, 0);
        assert_eq!(checkpoints, 0);
        assert_eq!(purges, 1);
        assert_eq!(version, LATEST_SCHEMA_VERSION);

        run_schema_upgrades(&conn).expect("rerun v12 upgrade");
        let purges_again: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_cloud_purges WHERE tool = 'gemini'",
                [],
                |row| row.get(0),
            )
            .expect("count Gemini purge after rerun");
        assert_eq!(purges_again, 1);
        drop(conn);
        let _ = fs::remove_file(path);
    }

    /// Every row of the ledger-side tables, to prove a migration left them
    /// untouched.
    fn ledger_snapshot(conn: &Connection) -> Vec<String> {
        let mut snapshot = Vec::new();
        for sql in [
            "SELECT * FROM token_logs ORDER BY id",
            "SELECT * FROM scan_checkpoints ORDER BY source_kind, source_path",
            "SELECT * FROM scan_source_cursors ORDER BY source_kind, source_path",
            "SELECT * FROM pending_cloud_purges ORDER BY id",
        ] {
            let mut statement = conn.prepare(sql).expect("prepare snapshot");
            let columns = statement.column_count();
            let mut rows = statement.query([]).expect("query snapshot");
            while let Some(row) = rows.next().expect("snapshot row") {
                let values: Vec<String> = (0..columns)
                    .map(|index| {
                        format!(
                            "{:?}",
                            row.get::<_, rusqlite::types::Value>(index)
                                .expect("snapshot value")
                        )
                    })
                    .collect();
                snapshot.push(values.join("|"));
            }
            snapshot.push(format!("-- {sql}"));
        }
        snapshot
    }

    fn table_rows(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count table rows")
    }

    fn user_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version")
    }

    #[test]
    fn v13_adds_empty_project_index_tables_without_touching_the_ledger() {
        assert_eq!(PROJECT_INDEX_SCHEMA_VERSION, 13);
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v13_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        init_test_db(&path).expect("initialize test db");

        // Turn it back into a populated v12 database.
        let conn = Connection::open(&path).expect("open test db");
        conn.execute_batch(
            "DROP TABLE local_session_projects;
             DROP TABLE local_project_index_state;
             INSERT INTO token_logs
                (tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
                 timestamp, session_id, unique_key, cost_usd, machine_id, sync_status,
                 cloud_user_id, synced_at)
             VALUES ('claude', 'claude-sonnet-4', 100, 10, 30, 5, '2026-09-24 10:00:00',
                     'session-a', 'claude_msg_a', 0.02, 'm', 1, 'user-1', '2026-09-24 10:05:00'),
                    ('codex', 'gpt-5', 50, 5, 0, 0, '2026-09-24 11:00:00',
                     'session-b', 'codex_v2_b', NULL, 'm', 0, NULL, NULL);
             INSERT INTO scan_checkpoints
                (source_kind, source_path, source_identity, size_bytes, modified_ns,
                 processed_offset)
             VALUES ('claude-jsonl-v2', '/fixture/session-a.jsonl', 'id', 10, 1, 10);
             PRAGMA user_version = 12;",
        )
        .expect("seed v12 database");
        let before = ledger_snapshot(&conn);

        run_schema_upgrades(&conn).expect("upgrade to v13");
        assert_eq!(user_version(&conn), LATEST_SCHEMA_VERSION);
        assert_eq!(table_rows(&conn, "local_session_projects"), 0);
        assert_eq!(table_rows(&conn, "local_project_index_state"), 0);
        assert_eq!(
            ledger_snapshot(&conn),
            before,
            "v13 must not touch the ledger"
        );
        let state_columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('local_project_index_state')")
            .expect("prepare state columns")
            .query_map([], |row| row.get(0))
            .expect("query state columns")
            .collect::<Result<Vec<_>>>()
            .expect("collect state columns");
        assert!(state_columns.iter().any(|column| column == "enabled"));
        assert!(!state_columns
            .iter()
            .any(|column| column.contains("path") || column.contains("label")));

        // Idempotent: re-running the chain and a full re-init keep the tables,
        // their rows and the ledger exactly as they are.
        conn.execute_batch(
            "INSERT INTO local_project_index_state (id, enabled, consent_version, generation)
             VALUES (1, 1, 1, 1);
             INSERT INTO local_session_projects
                (tool, session_id, source_family, project_kind, project_key, project_label,
                 resolution, generation, resolver_version)
             VALUES ('claude', 'session-a', 'claude', 'named', 'n:fixture', 'Fixture',
                     'folder', 1, 2);",
        )
        .expect("seed project index rows");
        run_schema_upgrades(&conn).expect("rerun upgrades");
        drop(conn);
        init_test_db(&path).expect("re-initialize test db");
        let conn = Connection::open(&path).expect("reopen test db");
        assert_eq!(user_version(&conn), LATEST_SCHEMA_VERSION);
        assert_eq!(table_rows(&conn, "local_session_projects"), 1);
        assert_eq!(table_rows(&conn, "local_project_index_state"), 1);
        assert_eq!(ledger_snapshot(&conn), before);

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn legacy_databases_reach_v13_through_the_whole_chain() {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_schema_v13_chain_{}_{}.db",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        let legacy = Connection::open(&path).expect("open legacy database");
        legacy
            .execute_batch(
                "CREATE TABLE token_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tool TEXT NOT NULL,
                    model TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    cached_tokens INTEGER DEFAULT 0,
                    timestamp TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    unique_key TEXT UNIQUE NOT NULL
                 );
                 INSERT INTO token_logs (
                    tool, model, input_tokens, output_tokens, cached_tokens,
                    timestamp, session_id, unique_key
                 ) VALUES (
                    'opencode', 'legacy-model', 1, 2, 0,
                    '2026-07-15 00:00:00', 'legacy-session', 'opencode_legacy_row'
                 );
                 PRAGMA user_version = 11;",
            )
            .expect("seed legacy database");
        drop(legacy);

        init_test_db(&path).expect("migrate legacy database");
        let conn = Connection::open(&path).expect("reopen migrated database");
        assert_eq!(user_version(&conn), LATEST_SCHEMA_VERSION);
        assert_eq!(table_rows(&conn, "local_session_projects"), 0);
        assert_eq!(table_rows(&conn, "local_project_index_state"), 0);
        let preserved: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE unique_key = 'opencode_legacy_row'",
                [],
                |row| row.get(0),
            )
            .expect("count preserved legacy row");
        assert_eq!(preserved, 1);

        drop(conn);
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod storage_tests {
    use super::*;

    fn scratch_db_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tokenledger_{tag}_{}_{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
    }

    fn insert_scratch_rows(conn: &Connection, count: usize) {
        for index in 0..count {
            conn.execute(
                "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id)
                 VALUES ('codex', 'gpt-5', 1000, 500, 0, 0, '2026-09-01 10:00:00', 'session', ?1, 0.01, 'm1')",
                params![format!("vacuum-test-{index}-{}", "x".repeat(200))],
            )
            .expect("insert scratch row");
        }
    }

    fn index_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'token_logs'",
            )
            .expect("prepare");
        let names = stmt
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<Vec<String>>>()
            .expect("collect");
        names
    }

    #[test]
    fn covered_legacy_indexes_are_dropped_on_init() {
        let path = scratch_db_path("legacy_index");
        init_test_db(&path).expect("init");
        {
            let conn = get_connection(&path).expect("open");
            conn.execute(
                "CREATE INDEX IF NOT EXISTS token_logs_timestamp_idx ON token_logs (timestamp)",
                [],
            )
            .expect("legacy index");
            conn.execute(
                "CREATE INDEX IF NOT EXISTS token_logs_tool_timestamp_idx ON token_logs (tool, timestamp)",
                [],
            )
            .expect("legacy index");
        }
        init_test_db(&path).expect("re-init");
        let names = {
            let conn = get_connection(&path).expect("open");
            index_names(&conn)
        };
        assert!(
            !names.iter().any(|n| n == "token_logs_timestamp_idx"),
            "{names:?}"
        );
        assert!(
            !names.iter().any(|n| n == "token_logs_tool_timestamp_idx"),
            "{names:?}"
        );
        assert!(
            names.iter().any(|n| n == "token_logs_timestamp_id_idx"),
            "{names:?}"
        );
        assert!(
            names
                .iter()
                .any(|n| n == "token_logs_tool_timestamp_id_idx"),
            "{names:?}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reclaim_space_returns_freelist_pages_after_deletes() {
        let path = scratch_db_path("vacuum");
        init_test_db(&path).expect("init");
        let footprint = {
            let conn = get_connection(&path).expect("open");
            insert_scratch_rows(&conn, 3000);
            conn.execute("DELETE FROM token_logs", []).expect("delete");
            storage_footprint(&conn).expect("footprint")
        };
        assert!(
            footprint.freelist_pages > 0,
            "deletes must leave free pages: {footprint:?}"
        );
        assert!(footprint.reclaimable_bytes() > 0);
        assert!(footprint.free_ratio() > 0.0 && footprint.free_ratio() <= 1.0);

        // A threshold above the real free ratio must not rewrite the file.
        assert!(reclaim_space_if_fragmented(&path, 1.01)
            .expect("threshold")
            .is_none());

        let reclaimed = reclaim_space(&path).expect("vacuum");
        assert!(
            reclaimed.after_bytes < reclaimed.before_bytes,
            "{reclaimed:?}"
        );
        assert_eq!(
            reclaimed.freed_bytes(),
            reclaimed.before_bytes - reclaimed.after_bytes
        );
        {
            let conn = get_connection(&path).expect("open");
            assert_eq!(
                storage_footprint(&conn).expect("footprint").freelist_pages,
                0
            );
        }
        assert!(reclaim_space_if_fragmented(&path, 0.10)
            .expect("no-op")
            .is_none());
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod antigravity_provenance_v16_tests {
    use super::*;
    struct TestDb {
        root: PathBuf,
        path: PathBuf,
    }
    impl TestDb {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!(
                "tokenledger-antigravity-v16-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            let path = root.join("isolated.db");
            Self { root, path }
        }
    }
    impl Drop for TestDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn legacy() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE token_logs (
            id INTEGER PRIMARY KEY, tool TEXT NOT NULL, model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0, timestamp TEXT NOT NULL, session_id TEXT,
            unique_key TEXT UNIQUE, cost_usd REAL, machine_id TEXT, sync_status INTEGER,
            cloud_user_id TEXT, synced_at TEXT, sync_revision INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE local_stats_cache (key TEXT); INSERT INTO local_stats_cache VALUES ('stale');
            INSERT INTO token_logs VALUES (1,'antigravity','legacy-placeholder',900,50,0,0,'2026-10-08 00:00:00','session','antigravity_session_1',0.5,'fixture',1,'user','ack',7);
            INSERT INTO token_logs VALUES (2,'claude','other',100,20,0,0,'2026-10-08 00:00:00','other','other',0.5,'fixture',1,'user','ack',3);
            PRAGMA user_version=15;").unwrap();
        conn.execute_batch(SYNC_REVISION_TRIGGER_V14_SQL).unwrap();
        conn
    }
    #[test]
    fn antigravity_v16_preserves_keys_and_requeues_only_legacy_estimates() {
        let conn = legacy();
        migrate_antigravity_provenance(&conn).unwrap();
        let row:(i64,String,i64,String,bool,i64,i64) = conn.query_row("SELECT id,unique_key,input_tokens,usage_provenance,cache_write_known,sync_revision,sync_status FROM token_logs WHERE id=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).unwrap();
        assert_eq!(
            row,
            (
                1,
                "antigravity_session_1".into(),
                900,
                "estimated".into(),
                false,
                8,
                0
            )
        );
        let other:(Option<String>,Option<bool>,i64,i64)=conn.query_row("SELECT usage_provenance,cache_write_known,sync_revision,sync_status FROM token_logs WHERE id=2",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(other, (None, None, 3, 1));
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            16
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM local_stats_cache", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        migrate_antigravity_provenance(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT sync_revision FROM token_logs WHERE id=1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            8
        );
        assert!(conn
            .execute("UPDATE token_logs SET cache_write_known=2 WHERE id=1", [])
            .is_err());
        assert!(conn
            .execute(
                "UPDATE token_logs SET usage_provenance='invented' WHERE id=1",
                []
            )
            .is_err());
    }
    #[test]
    fn antigravity_v16_failure_rolls_back_columns_rows_and_marker() {
        let conn = legacy();
        conn.execute_batch("CREATE TRIGGER fail_antigravity BEFORE UPDATE ON token_logs WHEN OLD.tool='antigravity' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
        assert!(migrate_antigravity_provenance(&conn).is_err());
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            15
        );
        assert_eq!(conn.query_row("SELECT count(*) FROM pragma_table_info('token_logs') WHERE name IN ('usage_provenance','cache_write_known')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(
            conn.query_row("SELECT sync_revision FROM token_logs WHERE id=1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            7
        );
        conn.execute_batch("DROP TRIGGER fail_antigravity").unwrap();
        migrate_antigravity_provenance(&conn).unwrap();
    }

    #[test]
    fn antigravity_v16_fresh_init_creates_cache_after_migration() {
        let db = TestDb::new();
        // Exercise init_db's shared path without looking for real legacy user databases.
        init_test_db(&db.path).unwrap();
        let conn = get_connection(&db.path).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            16
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM token_logs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM local_stats_cache", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(conn.query_row("SELECT count(*) FROM pragma_table_info('token_logs') WHERE name IN ('usage_provenance','cache_write_known')", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        drop(conn);
        init_test_db(&db.path).unwrap();
    }

    #[test]
    fn antigravity_v16_full_init_upgrades_v15_with_or_without_cache() {
        for cache_exists in [false, true] {
            let db = TestDb::new();
            init_test_db(&db.path).unwrap();
            let conn = get_connection(&db.path).unwrap();
            // Restore the complete v15 shape, rather than a miniature schema
            // that silently assumes the cache table was already initialized.
            conn.execute_batch("ALTER TABLE token_logs DROP COLUMN usage_provenance;
                ALTER TABLE token_logs DROP COLUMN cache_write_known;
                PRAGMA user_version=15;
                INSERT INTO token_logs(tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,session_id,unique_key,machine_id,sync_status,sync_revision) VALUES
                ('antigravity','legacy-label',900,50,0,0,'2026-10-08 00:00:00','s','legacy-ag','fixture',1,7),
                ('claude','unchanged',100,20,0,0,'2026-10-08 00:00:00','other','legacy-other','fixture',1,3);").unwrap();
            if cache_exists {
                conn.execute("INSERT INTO local_stats_cache(scope,range_key,device_filter,data_json,updated_at) VALUES('local','all','all','{}',1)", []).unwrap();
            } else {
                conn.execute_batch("DROP TABLE local_stats_cache").unwrap();
            }
            drop(conn);
            init_test_db(&db.path).unwrap();
            let conn = get_connection(&db.path).unwrap();
            let ag: (i64, String, bool, i64, i64) = conn.query_row("SELECT input_tokens,usage_provenance,cache_write_known,sync_status,sync_revision FROM token_logs WHERE unique_key='legacy-ag'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
            assert_eq!(ag, (900, "estimated".into(), false, 0, 8));
            let other: (Option<String>, Option<bool>, i64, i64) = conn.query_row("SELECT usage_provenance,cache_write_known,sync_status,sync_revision FROM token_logs WHERE unique_key='legacy-other'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
            assert_eq!(other, (None, None, 1, 3));
            assert_eq!(
                conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                16
            );
            assert_eq!(
                conn.query_row("SELECT count(*) FROM local_stats_cache", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            drop(conn);
            init_test_db(&db.path).unwrap();
            let conn = get_connection(&db.path).unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT sync_revision FROM token_logs WHERE unique_key='legacy-ag'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                8
            );
        }
    }

    #[test]
    fn antigravity_v16_cache_delete_failure_rolls_back_and_retry_clears_cache() {
        let conn = legacy();
        conn.execute_batch("CREATE TRIGGER fail_cache BEFORE DELETE ON local_stats_cache BEGIN SELECT RAISE(ABORT,'cache failure'); END;").unwrap();
        assert!(migrate_antigravity_provenance(&conn).is_err());
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            15
        );
        assert_eq!(conn.query_row("SELECT count(*) FROM pragma_table_info('token_logs') WHERE name IN ('usage_provenance','cache_write_known')", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(
            conn.query_row("SELECT sync_revision FROM token_logs WHERE id=1", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM local_stats_cache", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        conn.execute_batch("DROP TRIGGER fail_cache").unwrap();
        migrate_antigravity_provenance(&conn).unwrap();
        assert_eq!(
            conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            16
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM local_stats_cache", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
