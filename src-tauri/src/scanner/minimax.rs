use super::checkpoints::*;
use super::helpers::*;
use super::types::LogRecord;
use rusqlite::{Connection, OpenFlags, Result, TransactionBehavior};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(test)]
use super::runner::persist_scan_batch;
#[cfg(test)]
use std::fs::{self, File};

/// `skip_opencode` / `skip_kilo` are decided by whether the corresponding
/// native DB *file exists* — a static rule, unlike the previous "did this
/// scan pass find rows" check, which raced with locked/empty reads and could
/// write the same request under two different unique_key namespaces.
pub(crate) fn scan_minimax_marvis_incremental(
    logs: &mut Vec<LogRecord>,
    skip_opencode: bool,
    skip_kilo: bool,
    cursors: &SourceCursorMap,
    pending_cursors: &mut Vec<crate::db::ScanSourceCursor>,
) -> usize {
    let sources = minimax_database_sources(&get_home_dir());
    let mut count = 0;
    for source in sources {
        match scan_minimax_database_incremental(
            logs,
            &source,
            skip_opencode,
            skip_kilo,
            cursors,
            pending_cursors,
        ) {
            Ok(scanned) => count += scanned,
            Err(error) => log::error!(
                "Minimax incremental scan: failed to read {:?} table {}: {}",
                source.path,
                source.kind.table_name(),
                error
            ),
        }
    }
    count
}

/// 来源没有报告模型时使用的占位模型名。
///
/// 与 `claude-unknown` / `gemini-unknown` / `grok-unknown` 等既有约定保持一致：
/// 界面上明确显示"这条记录的模型未知"，而不是拼一个看起来像真模型的名字。
pub(crate) const MINIMAX_UNKNOWN_MODEL: &str = "minimax-unknown";

/// Bump whenever the reader changes what it extracts, so the stored cursor no
/// longer matches and the next scan re-reads the source from the beginning.
/// Without this, already-stored rows keep whatever the previous parser decided,
/// because `INSERT OR IGNORE` never revisits a key it has already written.
pub(crate) const MINIMAX_PARSER_VERSION: i64 = 2;

/// One request's token fingerprint, used to pair a usage row with the assistant
/// message that recorded the same request: `(input, output, cache_read, total)`.
///
/// The total is spelled `input + output + cache_read + cache_write` on the usage
/// row and `usage.total_tokens` on the message; both were verified to agree on
/// every real v2 row, and the write side is always 0 in practice. Missing JSON
/// members normalize to 0 so an absent `cache_read` still pairs with a cached
/// read of 0.
type RequestKey = (i64, i64, i64, i64);

/// Per-request models recovered from `local_runtime_message_rows`.
///
/// MiniMax Code stopped writing `local_runtime_token_usage.model` on
/// 2026-08-24, but it still records the model of every request it made on the
/// assistant message that carries the request's usage
/// (`data_json.context_usage_telemetry.model`). That field is per *request*, not
/// per session, which matters: sessions really do switch models mid-thread, and
/// the session-level `effectiveModel` is only the current value, so joining on
/// it would relabel the earlier half of every switched session.
type RequestModels = HashMap<RequestKey, String>;

/// True when this connection exposes the per-request model table.
///
/// The legacy `token_usage` store has no such table, and its `model` column is
/// always populated, so recovery is simply unavailable there.
fn has_request_model_table(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_runtime_message_rows'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .is_ok()
}

/// Loads the request fingerprints and models recorded for one session.
///
/// Only the five JSON members actually needed are pulled out, rather than the
/// whole ~13KB `data_json` blob, so a full rescan does not drag tens of
/// megabytes of message text across the FFI boundary.
fn request_models_for_session(conn: &Connection, session_id: &str) -> Result<RequestModels> {
    let mut stmt = conn.prepare(
        "SELECT CAST(json_extract(data_json, '$.usage.input_tokens') AS INTEGER),
                CAST(json_extract(data_json, '$.usage.output_tokens') AS INTEGER),
                CAST(json_extract(data_json, '$.usage.cache_read') AS INTEGER),
                CAST(json_extract(data_json, '$.usage.total_tokens') AS INTEGER),
                json_extract(data_json, '$.context_usage_telemetry.model')
           FROM local_runtime_message_rows
          WHERE session_id = ?1
            AND role = 'assistant'
            AND json_valid(data_json)
            AND json_extract(data_json, '$.context_usage_telemetry.model') IS NOT NULL",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        Ok((
            row.get::<_, Option<i64>>(0)?,
            row.get::<_, Option<i64>>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut models = HashMap::new();
    for row in rows {
        let (input, output, cache_read, total, model) = row?;
        let Some(total) = total else {
            continue;
        };
        let key = (
            input.unwrap_or(0),
            output.unwrap_or(0),
            cache_read.unwrap_or(0),
            total,
        );
        // A fingerprint pairing two different models would mean the key is not
        // unique; keep the first rather than letting the last row win silently.
        models.entry(key).or_insert(model);
    }
    Ok(models)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MinimaxDatabaseKind {
    Legacy,
    RuntimeV2,
}

impl MinimaxDatabaseKind {
    fn table_name(self) -> &'static str {
        match self {
            Self::Legacy => "token_usage",
            Self::RuntimeV2 => "local_runtime_token_usage",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MinimaxDatabaseSource {
    pub(crate) path: PathBuf,
    pub(crate) kind: MinimaxDatabaseKind,
}

pub(crate) fn minimax_database_sources(home_dir: &Path) -> Vec<MinimaxDatabaseSource> {
    let mut sources = Vec::with_capacity(2);

    let runtime_v2 = home_dir.join(".minimax/v2/sqlite/runtime-state.sqlite");
    if runtime_v2.is_file() {
        sources.push(MinimaxDatabaseSource {
            path: runtime_v2,
            kind: MinimaxDatabaseKind::RuntimeV2,
        });
    }

    // MiniMaxCode used both names for the same legacy store. Prefer the
    // current ~/.minimax alias, but never scan both aliases in one pass: on
    // migrated installations they can be identical copies of the same DB.
    let minimax_legacy = home_dir.join(".minimax/sqlite.db");
    let mavis_legacy = home_dir.join(".mavis/sqlite.db");
    let legacy_path = if minimax_legacy.is_file() {
        Some(minimax_legacy)
    } else if mavis_legacy.is_file() {
        Some(mavis_legacy)
    } else {
        None
    };
    if let Some(path) = legacy_path {
        sources.push(MinimaxDatabaseSource {
            path,
            kind: MinimaxDatabaseKind::Legacy,
        });
    }

    sources
}

#[cfg(test)]
pub(crate) fn scan_minimax_marvis_from_home(
    logs: &mut Vec<LogRecord>,
    home_dir: &Path,
    skip_opencode: bool,
    skip_kilo: bool,
) -> usize {
    let sources = minimax_database_sources(home_dir);
    if sources.is_empty() {
        log::info!(
            "Minimax scan: no v2 or legacy usage database exists under {:?}",
            home_dir
        );
        return 0;
    }

    let mut count = 0;
    for source in sources {
        match scan_minimax_database(logs, &source, skip_opencode, skip_kilo) {
            Ok(scanned) => count += scanned,
            Err(e) => log::error!(
                "Minimax scan: failed to read {:?} table {} with native WAL-aware SQLite: {}",
                source.path,
                source.kind.table_name(),
                e
            ),
        }
    }
    log::info!(
        "Minimax scan: scanned {} v2/legacy records successfully",
        count
    );
    count
}

#[cfg(test)]
pub(crate) fn scan_minimax_database(
    logs: &mut Vec<LogRecord>,
    source: &MinimaxDatabaseSource,
    skip_opencode: bool,
    skip_kilo: bool,
) -> Result<usize> {
    // The desktop binary opens the provider DB through SQLite on its native
    // platform. A normal read-only transaction participates in WAL and pins a
    // consistent snapshot; deliberately do not use immutable=1, which would
    // ignore committed frames that have not been checkpointed into the DB.
    let mut conn = Connection::open_with_flags(
        &source.path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let (count, _) = scan_minimax_connection(
        logs,
        &tx,
        source.kind.table_name(),
        skip_opencode,
        skip_kilo,
        i64::MIN,
    )?;
    tx.commit()?;
    Ok(count)
}

pub(crate) fn scan_minimax_database_incremental(
    logs: &mut Vec<LogRecord>,
    source: &MinimaxDatabaseSource,
    skip_opencode: bool,
    skip_kilo: bool,
    cursors: &SourceCursorMap,
    pending_cursors: &mut Vec<crate::db::ScanSourceCursor>,
) -> Result<usize> {
    // v2: recovers the per-request model from `local_runtime_message_rows`
    // instead of storing the `minimax-unknown` placeholder, attributes every
    // row to the producing app, and treats a source cost of 0 as unreported.
    // Bumping this resets the cursor, so the next scan re-reads the source and
    // rewrites the already-stored rows through the correction branch.
    const PARSER_VERSION: i64 = MINIMAX_PARSER_VERSION;
    let fingerprint = source_fingerprint(&source.path).map_err(|error| {
        rusqlite::Error::InvalidParameterName(format!("source fingerprint: {error}"))
    })?;
    let source_kind = match source.kind {
        MinimaxDatabaseKind::Legacy => "minimax-token-usage-v1",
        MinimaxDatabaseKind::RuntimeV2 => "minimax-runtime-token-usage-v2",
    };
    let after_id = active_source_cursor(cursors, &fingerprint, source_kind, PARSER_VERSION)
        .and_then(|cursor| cursor.cursor_primary.parse::<i64>().ok())
        .unwrap_or(i64::MIN);

    // A regular read-only transaction is intentionally WAL-aware. immutable=1
    // would be faster but can omit committed runtime-v2 rows still in -wal.
    let mut conn = Connection::open_with_flags(
        &source.path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let (count, last_id) = scan_minimax_connection(
        logs,
        &tx,
        source.kind.table_name(),
        skip_opencode,
        skip_kilo,
        after_id,
    )?;
    tx.commit()?;
    if let Some(last_id) = last_id {
        pending_cursors.push(fingerprint.source_cursor(
            source_kind,
            last_id.to_string(),
            "",
            PARSER_VERSION,
        ));
    }
    Ok(count)
}

pub(crate) fn scan_minimax_connection(
    logs: &mut Vec<LogRecord>,
    conn: &Connection,
    table_name: &str,
    skip_opencode: bool,
    skip_kilo: bool,
    after_id: i64,
) -> Result<(usize, Option<i64>)> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [table_name],
        |row| row.get::<_, i64>(0),
    )?;

    let mut pragma_stmt = conn.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let mut pragma_rows = pragma_stmt.query([])?;
    let mut has_framework = false;
    let mut has_reasoning_tokens = false;
    let mut has_cost_usd = false;
    while let Some(row) = pragma_rows.next()? {
        let col_name: String = row.get(1)?;
        match col_name.as_str() {
            "framework_type" => has_framework = true,
            "reasoning_tokens" => has_reasoning_tokens = true,
            "cost_usd" => has_cost_usd = true,
            _ => {}
        }
    }
    drop(pragma_rows);
    drop(pragma_stmt);

    let framework_expr = if has_framework {
        "framework_type"
    } else {
        "NULL"
    };
    let reasoning_expr = if has_reasoning_tokens {
        "reasoning_tokens"
    } else {
        "0"
    };
    let cost_expr = if has_cost_usd { "cost_usd" } else { "NULL" };
    let query = format!(
        "SELECT id, session_id, agent_name, model, ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, {framework_expr}, {reasoning_expr}, {cost_expr}
         FROM {table_name} WHERE id > ?1 ORDER BY id"
    );

    let mut count = 0;
    let mut last_id = None;
    let request_models_available = has_request_model_table(conn);
    // Sessions are visited repeatedly as their usage rows stream past in `id`
    // order, so cache the recovered models per session instead of re-reading
    // the message table for every single row.
    let mut session_models: HashMap<String, RequestModels> = HashMap::new();
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map([after_id], |row| {
        let id: i64 = row.get(0)?;
        let session_id: Option<String> = row.get(1)?;
        let agent_name: Option<String> = row.get(2)?;
        let model: Option<String> = row.get(3)?;
        let ts_val: rusqlite::types::Value = row.get(4)?;
        let input_tokens: i64 = row.get(5)?;
        let output_tokens: i64 = row.get(6)?;
        let cache_read: Option<i64> = row.get(7)?;
        let cache_write: Option<i64> = row.get(8)?;
        let framework: Option<String> = row.get(9)?;
        let reasoning_tokens: Option<i64> = row.get(10)?;
        let cost_usd: Option<f64> = row.get(11)?;
        Ok((
            id,
            session_id,
            agent_name,
            model,
            ts_val,
            input_tokens,
            output_tokens,
            cache_read,
            cache_write,
            framework,
            reasoning_tokens,
            cost_usd,
        ))
    })?;

    for row in rows {
        let (
            id,
            session_id,
            // 曾用于在 model 缺失时拼出 `mavis-{agent_name}`。那会造出供应商从未
            // 返回过的模型名，现已改为记 `minimax-unknown`，这一列不再参与构造。
            _agent_name,
            model,
            ts_val,
            input_tokens,
            output_tokens,
            cache_read,
            cache_write,
            framework,
            reasoning_tokens,
            cost_usd,
        ) = row?;
        last_id = Some(id);
        let framework_tool = framework
            .as_deref()
            .map(|fw| fw.to_lowercase())
            .filter(|fw| fw == "opencode" || fw == "kilo");
        match framework_tool.as_deref() {
            Some("opencode") if skip_opencode => continue,
            Some("kilo") if skip_kilo => continue,
            _ => {}
        }

        // MiniMax Code stopped writing `model` on 2026-08-24, so the per-request
        // model has to come from the assistant message that recorded the same
        // request (see `request_models_for_session`). Only when neither source
        // names a model do we fall back to the honest placeholder.
        let recovered_model = if model.is_some() || !request_models_available {
            None
        } else {
            let models = session_models
                .entry(session_id.clone().unwrap_or_default())
                .or_insert_with(|| {
                    request_models_for_session(conn, session_id.as_deref().unwrap_or(""))
                        .unwrap_or_default()
                });
            models
                .get(&(
                    input_tokens,
                    output_tokens,
                    cache_read.unwrap_or(0),
                    input_tokens
                        + output_tokens
                        + cache_read.unwrap_or(0)
                        + cache_write.unwrap_or(0),
                ))
                .cloned()
        };
        let model_str = match model {
            Some(raw_model) => clean_model_name(&raw_model),
            None => match recovered_model {
                Some(recovered) => clean_model_name(&recovered),
                None => MINIMAX_UNKNOWN_MODEL.to_string(),
            },
        };

        // Tool identity follows the app that produced the record, never the
        // model string. Deciding it from the model used to relabel every
        // third-party model run inside MiniMax Code as the unrelated Tencent
        // Marvis product, and a model-less row could not be attributed at all.
        // `framework_type` still wins when the row was produced by a framework
        // that has its own scanner.
        let tool = framework_tool.unwrap_or_else(|| "minimax".to_string());

        let ts_json = match ts_val {
            rusqlite::types::Value::Null => Value::Null,
            rusqlite::types::Value::Integer(i) => Value::Number(i.into()),
            rusqlite::types::Value::Real(f) => Value::Number(
                serde_json::Number::from_f64(f).unwrap_or(serde_json::Number::from(0)),
            ),
            rusqlite::types::Value::Text(s) => Value::String(s),
            rusqlite::types::Value::Blob(b) => {
                Value::String(String::from_utf8_lossy(&b).to_string())
            }
        };
        let timestamp = normalize_timestamp(&ts_json);
        let cache_write = cache_write.unwrap_or(0);
        let cached_tokens = cache_read.unwrap_or(0) + cache_write;
        let output_tokens = output_tokens + reasoning_tokens.unwrap_or(0);
        let session_id = session_id.unwrap_or_else(|| "unknown_session".to_string());

        // Keep the established namespace across legacy and v2. Migrated rows
        // that preserve session/id remain idempotent, while v2 sessions with a
        // restarted integer id are still distinct because session_id differs.
        let unique_key = format!("mavis_{session_id}_{id}");
        // A stored 0 is not a free request, it is an unreported one: every real
        // row in both the legacy `token_usage.cost_usd` column and the v2
        // `raw.cost` payload is 0, including rows that read 45k cached tokens.
        // Persisting that 0 pins the record at $0 forever, because a non-null
        // cost wins over the price table. Store "not reported" as NULL so the
        // pricing engine derives the cost from the model, and keep any genuine
        // non-zero supplier figure.
        let cost_usd = match cost_usd {
            Some(value) if value > 0.0 => Some(value),
            _ => None,
        };
        logs.push(LogRecord {
            tool,
            model: model_str,
            input_tokens,
            output_tokens,
            cached_tokens,
            cache_write_tokens: cache_write,
            timestamp,
            session_id,
            unique_key,
            cost_usd,
            cumulative: false,
        });
        count += 1;
    }

    Ok((count, last_id))
}

#[cfg(test)]
mod scanner_minimax_tests {
    use super::*;
    use chrono::Local;

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "tokenledger-minimax-{label}-{}-{}",
                std::process::id(),
                Local::now().timestamp_nanos_opt().unwrap_or_default()
            ));
            fs::create_dir_all(&path).expect("create MiniMax test home");
            Self(path)
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().expect("test DB parent")).expect("create test DB parent");
        File::create(path).expect("create test DB");
    }

    #[test]
    fn source_discovery_prefers_runtime_v2_and_only_one_legacy_alias() {
        let home = TestHome::new("sources");
        let runtime_v2 = home.0.join(".minimax/v2/sqlite/runtime-state.sqlite");
        let minimax_legacy = home.0.join(".minimax/sqlite.db");
        let mavis_legacy = home.0.join(".mavis/sqlite.db");
        touch(&runtime_v2);
        touch(&minimax_legacy);
        touch(&mavis_legacy);

        let sources = minimax_database_sources(&home.0);
        assert_eq!(
            sources,
            vec![
                MinimaxDatabaseSource {
                    path: runtime_v2.clone(),
                    kind: MinimaxDatabaseKind::RuntimeV2,
                },
                MinimaxDatabaseSource {
                    path: minimax_legacy.clone(),
                    kind: MinimaxDatabaseKind::Legacy,
                },
            ]
        );

        fs::remove_file(minimax_legacy).expect("remove preferred legacy alias");
        let sources = minimax_database_sources(&home.0);
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[1].path, mavis_legacy);
    }

    #[test]
    fn v2_reader_uses_live_wal_and_preserves_legacy_mapping() {
        let home = TestHome::new("wal");
        let legacy_path = home.0.join(".mavis/sqlite.db");
        fs::create_dir_all(legacy_path.parent().expect("legacy parent"))
            .expect("create legacy parent");
        let legacy_conn = Connection::open(&legacy_path).expect("open legacy fixture");
        legacy_conn
            .execute_batch(
                "CREATE TABLE token_usage (
                    id INTEGER PRIMARY KEY,
                    session_id TEXT,
                    agent_name TEXT,
                    model TEXT,
                    ts INTEGER,
                    input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    cache_read_tokens INTEGER,
                    cache_write_tokens INTEGER
                );",
            )
            .expect("create legacy schema");
        legacy_conn
            .execute(
                "INSERT INTO token_usage (
                    id, session_id, agent_name, model, ts,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
                ) VALUES (7, 'legacy-session', 'agent', NULL, 1784475200000, 11, 13, 17, 19)",
                [],
            )
            .expect("insert legacy fixture");

        let runtime_v2_path = home.0.join(".minimax/v2/sqlite/runtime-state.sqlite");
        fs::create_dir_all(runtime_v2_path.parent().expect("v2 parent")).expect("create v2 parent");
        let runtime_v2_conn = Connection::open(&runtime_v2_path).expect("open v2 fixture");
        runtime_v2_conn
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA wal_autocheckpoint=0;
                 CREATE TABLE local_runtime_token_usage (
                    id INTEGER PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    framework_type TEXT NOT NULL,
                    turn_id TEXT,
                    model TEXT,
                    ts INTEGER NOT NULL,
                    input_tokens INTEGER NOT NULL,
                    output_tokens INTEGER NOT NULL,
                    reasoning_tokens INTEGER NOT NULL,
                    cache_read_tokens INTEGER NOT NULL,
                    cache_write_tokens INTEGER NOT NULL,
                    cost_usd REAL,
                    raw TEXT
                 );
                 PRAGMA wal_checkpoint(TRUNCATE);",
            )
            .expect("create checkpointed v2 schema");
        runtime_v2_conn
            .execute(
                "INSERT INTO local_runtime_token_usage (
                    id, session_id, agent_name, framework_type, turn_id, model, ts,
                    input_tokens, output_tokens, reasoning_tokens,
                    cache_read_tokens, cache_write_tokens, cost_usd, raw
                 ) VALUES (
                    1, 'v2-session', 'mavis', 'pi-agent', 'turn-1', 'MiniMax-M2.7',
                    1784475300000, 100, 20, 3, 40, 5, 0.5, NULL
                 )",
                [],
            )
            .expect("insert uncheckpointed v2 WAL row");

        let wal_path = PathBuf::from(format!("{}-wal", runtime_v2_path.display()));
        assert!(
            fs::metadata(&wal_path)
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false),
            "fixture row must still live in the WAL"
        );

        let mut logs = Vec::new();
        let scanned = scan_minimax_marvis_from_home(&mut logs, &home.0, false, false);
        assert_eq!(scanned, 2);
        assert_eq!(logs.len(), 2);

        let v2 = logs
            .iter()
            .find(|record| record.session_id == "v2-session")
            .expect("v2 WAL record");
        assert_eq!(v2.tool, "minimax");
        assert_eq!(v2.model, "MiniMax-M2.7");
        assert_eq!(v2.input_tokens, 100);
        assert_eq!(v2.output_tokens, 23);
        assert_eq!(v2.cached_tokens, 45);
        assert_eq!(v2.cache_write_tokens, 5);
        assert_eq!(v2.unique_key, "mavis_v2-session_1");
        assert_eq!(v2.cost_usd, Some(0.5));

        let legacy = logs
            .iter()
            .find(|record| record.session_id == "legacy-session")
            .expect("legacy record");
        // 来源没报模型时不再拼 `mavis-{agent_name}`：那会造出供应商从未返回过的
        // 模型名，还会把同一个 App 的消耗从 `minimax` 改判成 `marvis`。
        assert_eq!(legacy.tool, "minimax");
        assert_eq!(legacy.model, MINIMAX_UNKNOWN_MODEL);
        assert_eq!(legacy.output_tokens, 13);
        assert_eq!(legacy.cached_tokens, 36);
        assert_eq!(legacy.cache_write_tokens, 19);
        assert_eq!(legacy.unique_key, "mavis_legacy-session_7");
        assert_eq!(legacy.cost_usd, None);

        let source = MinimaxDatabaseSource {
            path: runtime_v2_path.clone(),
            kind: MinimaxDatabaseKind::RuntimeV2,
        };
        let fingerprint = source_fingerprint(&runtime_v2_path).expect("fingerprint v2 fixture");
        let cursor = fingerprint.source_cursor(
            "minimax-runtime-token-usage-v2",
            "1",
            "",
            MINIMAX_PARSER_VERSION,
        );
        let mut cursors = SourceCursorMap::new();
        cursors.insert(
            (cursor.source_kind.clone(), cursor.source_path.clone()),
            cursor,
        );
        runtime_v2_conn
            .execute(
                "INSERT INTO local_runtime_token_usage (
                    id, session_id, agent_name, framework_type, turn_id, model, ts,
                    input_tokens, output_tokens, reasoning_tokens,
                    cache_read_tokens, cache_write_tokens, cost_usd, raw
                 ) VALUES (
                    2, 'v2-session', 'mavis', 'pi-agent', 'turn-2', 'MiniMax-M2.7',
                    1784475400000, 12, 4, 1, 3, 2, 0.06, NULL
                 )",
                [],
            )
            .expect("append second WAL row");
        let mut incremental_logs = Vec::new();
        let mut pending_cursors = Vec::new();
        let incremental = scan_minimax_database_incremental(
            &mut incremental_logs,
            &source,
            false,
            false,
            &cursors,
            &mut pending_cursors,
        )
        .expect("incremental WAL scan");
        assert_eq!(incremental, 1);
        assert_eq!(incremental_logs[0].unique_key, "mavis_v2-session_2");
        assert_eq!(pending_cursors[0].cursor_primary, "2");

        drop(runtime_v2_conn);
        drop(legacy_conn);
    }

    #[test]
    fn rescanning_relabels_stored_minimax_rows_in_place() {
        // 本机 1,748 行 `minimax-unknown` 就是靠这条路径修复的：它们早已按
        // `unique_key` 落库，`INSERT OR IGNORE` 不会回头看第二眼，只有显式的
        // 改写分支能把标签换成恢复出来的真实模型，并把 0 成本的行退回 NULL
        // 交给价格表。同时钉住命名空间边界：腾讯 Marvis 的行不得被牵连。
        let db_path = std::env::temp_dir().join(format!(
            "tokenledger-minimax-relabel-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        crate::db::init_test_db(&db_path).expect("initialize fixture db");
        let conn = Connection::open(&db_path).expect("open fixture db");
        conn.execute_batch(
            "INSERT INTO token_logs
                (tool, model, input_tokens, output_tokens, cached_tokens, timestamp,
                 session_id, unique_key, cost_usd, machine_id, sync_status,
                 cloud_user_id, synced_at)
             VALUES
             ('minimax', 'minimax-unknown', 100, 20, 300, '2026-09-24 11:57:49',
              'mvs_a', 'mavis_mvs_a_1', 0, 'm', 1, 'cloud-user', '2026-09-24 12:00:00'),
             ('minimax', 'minimax-unknown', 10, 5, 0, '2026-09-24 11:57:10',
              'mvs_b', 'mavis_mvs_b_2', 0, 'm', 1, 'cloud-user', '2026-09-24 12:00:00'),
             -- 旧版本曾把别家模型记到腾讯 Marvis 名下，改写要一并纠正工具。
             ('marvis', 'deepseek-v4-pro-external', 7, 3, 0, '2026-08-21 16:46:00',
              'mvs_c', 'mavis_mvs_c_3', 0, 'm', 1, 'cloud-user', '2026-08-21 17:00:00'),
             -- 腾讯 Marvis 自己的行：同工具不同命名空间，必须原样不动。
             ('marvis', 'main-auto', 11, 4, 0, '2026-09-01 10:00:00',
              'conv-1', 'marvis_tencent_u1_9', 0, 'm', 1, 'cloud-user', '2026-09-01 11:00:00');",
        )
        .expect("seed fixture rows");
        drop(conn);

        let corrected = LogRecord {
            tool: "minimax".to_string(),
            model: "gpt-5.6-sol".to_string(),
            input_tokens: 100,
            output_tokens: 20,
            cached_tokens: 300,
            cache_write_tokens: 0,
            timestamp: "2026-09-24 11:57:49".to_string(),
            session_id: "mvs_a".to_string(),
            unique_key: "mavis_mvs_a_1".to_string(),
            cost_usd: None,
            cumulative: false,
        };
        let relabelled = LogRecord {
            unique_key: "mavis_mvs_c_3".to_string(),
            session_id: "mvs_c".to_string(),
            timestamp: "2026-08-21 16:46:00".to_string(),
            input_tokens: 7,
            output_tokens: 3,
            ..corrected.clone()
        };
        // 腾讯 Marvis 的行原样重扫：工具、模型、键都不该变。
        let tencent = LogRecord {
            tool: "marvis".to_string(),
            model: "main-auto".to_string(),
            unique_key: "marvis_tencent_u1_9".to_string(),
            session_id: "conv-1".to_string(),
            timestamp: "2026-09-01 10:00:00".to_string(),
            input_tokens: 11,
            output_tokens: 4,
            cached_tokens: 0,
            cache_write_tokens: 0,
            cost_usd: None,
            cumulative: false,
        };
        let outcome = persist_scan_batch(
            &db_path,
            vec![corrected, relabelled, tencent],
            Vec::new(),
            Vec::new(),
            None,
        )
        .expect("persist relabel batch");
        // 只有两条 MiniMax Code 行需要改写。
        assert_eq!(outcome.inserted, 2);

        let conn = Connection::open(&db_path).expect("reopen fixture db");
        let row = |key: &str| {
            conn.query_row(
                "SELECT tool, model, cost_usd, sync_status FROM token_logs WHERE unique_key = ?1",
                [key],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<f64>>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap_or_else(|e| panic!("missing {key}: {e}"))
        };

        let (tool, model, cost, sync) = row("mavis_mvs_a_1");
        assert_eq!((tool.as_str(), model.as_str()), ("minimax", "gpt-5.6-sol"));
        // 0 成本退回 NULL，交给价格表派生。
        assert_eq!(cost, None);
        // 重置同步状态，让云端 upsert 覆盖旧标签。
        assert_eq!(sync, 0);
        // 工具从 marvis 纠正回 minimax。
        let (tool, model, _, _) = row("mavis_mvs_c_3");
        assert_eq!((tool.as_str(), model.as_str()), ("minimax", "gpt-5.6-sol"));

        // 腾讯 Marvis 的行分毫未动，仍是已同步状态。
        let (tool, model, _, sync) = row("marvis_tencent_u1_9");
        assert_eq!((tool.as_str(), model.as_str()), ("marvis", "main-auto"));
        assert_eq!(sync, 1);

        drop(conn);
        let _ = fs::remove_file(&db_path);
    }

    #[test]
    fn a_stale_parser_version_forces_a_full_rescan() {
        // 修复历史行靠的就是这条：游标按 (kind, path) 命中后还要比对
        // `parser_version`，版本一变就当没有游标，整表重读。少了它，
        // `INSERT OR IGNORE` 会让已落库的 `minimax-unknown` 永远停在旧标签上。
        let home = TestHome::new("parser-version");
        let path = home.0.join(".minimax/v2/sqlite/runtime-state.sqlite");
        fs::create_dir_all(path.parent().expect("v2 parent")).expect("create v2 parent");
        let conn = Connection::open(&path).expect("open v2 fixture");
        conn.execute_batch(
            "CREATE TABLE local_runtime_token_usage (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                framework_type TEXT NOT NULL,
                turn_id TEXT,
                model TEXT,
                ts INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                reasoning_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_write_tokens INTEGER NOT NULL,
                cost_usd REAL,
                raw TEXT
             );
             INSERT INTO local_runtime_token_usage (
                id, session_id, agent_name, framework_type, turn_id, model, ts,
                input_tokens, output_tokens, reasoning_tokens,
                cache_read_tokens, cache_write_tokens, cost_usd, raw
             ) VALUES
             (1, 's1', 'mavis', 'pi-agent', NULL, NULL, 1787535003090, 1, 2, 0, 0, 0, 0, NULL),
             (2, 's1', 'mavis', 'pi-agent', NULL, NULL, 1787535004090, 3, 4, 0, 0, 0, 0, NULL);",
        )
        .expect("create v2 fixture");
        let fingerprint = source_fingerprint(&path).expect("fingerprint v2 fixture");
        let source = MinimaxDatabaseSource {
            path: path.clone(),
            kind: MinimaxDatabaseKind::RuntimeV2,
        };
        let cursor_for = |version: i64| {
            let cursor =
                fingerprint.source_cursor("minimax-runtime-token-usage-v2", "2", "", version);
            let mut map = SourceCursorMap::new();
            map.insert(
                (cursor.source_kind.clone(), cursor.source_path.clone()),
                cursor,
            );
            map
        };

        // 版本一致：只读游标之后的新行。
        let mut fresh = Vec::new();
        let scanned = scan_minimax_database_incremental(
            &mut fresh,
            &source,
            false,
            false,
            &cursor_for(MINIMAX_PARSER_VERSION),
            &mut Vec::new(),
        )
        .expect("incremental scan with current version");
        assert_eq!(scanned, 0);

        // 版本落后：整表重读，2 条都回来，才能把历史行改写成恢复后的模型。
        let mut stale = Vec::new();
        let rescanned = scan_minimax_database_incremental(
            &mut stale,
            &source,
            false,
            false,
            &cursor_for(MINIMAX_PARSER_VERSION - 1),
            &mut Vec::new(),
        )
        .expect("incremental scan with stale version");
        assert_eq!(rescanned, 2);
        assert_eq!(stale.len(), 2);
        drop(conn);
    }

    #[test]
    fn missing_model_stays_with_the_producing_app_and_is_never_fabricated() {
        // 回归 2026-08-24 的真实事故：MiniMax Code 更新后不再写 `model` 列，旧
        // 实现回退到 `mavis-{agent_name}`，于是账本里出现了 `mavis-mavis` 这种
        // 供应商从未返回过的模型名；而且因为它不以 "minimax" 开头，同一个 App
        // 的消耗还被从 `minimax` 改判成 `marvis`，看板上 `minimax` 直接拉平。
        //
        // 本夹具刻意不带 `local_runtime_message_rows`，覆盖的是「两个来源都没有
        // 模型」这条最后的退路；模型可恢复的路径见
        // `recovers_the_per_request_model_when_the_usage_row_has_none`。
        let home = TestHome::new("null-model");
        let runtime_v2_path = home.0.join(".minimax/v2/sqlite/runtime-state.sqlite");
        fs::create_dir_all(runtime_v2_path.parent().expect("v2 parent")).expect("create v2 parent");
        let conn = Connection::open(&runtime_v2_path).expect("open v2 fixture");
        conn.execute_batch(
            "CREATE TABLE local_runtime_token_usage (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                framework_type TEXT NOT NULL,
                turn_id TEXT,
                model TEXT,
                ts INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                reasoning_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_write_tokens INTEGER NOT NULL,
                cost_usd REAL,
                raw TEXT
             );",
        )
        .expect("create v2 schema");
        conn.execute_batch(
            "INSERT INTO local_runtime_token_usage (
                id, session_id, agent_name, framework_type, turn_id, model, ts,
                input_tokens, output_tokens, reasoning_tokens,
                cache_read_tokens, cache_write_tokens, cost_usd, raw
             ) VALUES
             (1, 'mvs_null', 'mavis', 'pi-agent', NULL, NULL, 1787535003090, 584, 937, 0, 159345, 0, 0, NULL),
             (2, 'mvs_named', 'mavis', 'pi-agent', NULL, 'minimax/MiniMax-M3', 1787297440932, 10, 20, 0, 0, 0, 0.5, NULL),
             (3, 'mvs_other', 'agent', 'pi-agent', NULL, 'deepseek-v4-pro-external', 1787297440000, 5, 6, 0, 0, 0, 0, NULL),
             (4, 'mvs_fw', 'agent', 'opencode', NULL, NULL, 1787297400000, 7, 8, 0, 0, 0, 0, NULL)",
        )
        .expect("insert v2 fixture rows");
        drop(conn);

        let mut logs = Vec::new();
        let scanned = scan_minimax_marvis_from_home(&mut logs, &home.0, false, false);
        assert_eq!(scanned, 4);

        let by_session = |session: &str| {
            logs.iter()
                .find(|record| record.session_id == session)
                .unwrap_or_else(|| panic!("missing record for {session}"))
        };

        // 模型缺失：归给产生它的 App，模型明确标为未知，绝不拼名字。
        let unknown = by_session("mvs_null");
        assert_eq!(unknown.tool, "minimax");
        assert_eq!(unknown.model, MINIMAX_UNKNOWN_MODEL);
        assert!(!unknown.model.starts_with("mavis-"), "不得再拼造模型名");
        // 数值照常入账——这条记录本来就没丢，丢的只是标签。
        assert_eq!(unknown.input_tokens, 584);
        assert_eq!(unknown.output_tokens, 937);
        assert_eq!(unknown.cached_tokens, 159_345);

        // 工具身份只看 App，不看模型串：MiniMax Code 跑别家模型仍然是 minimax，
        // 不能再被记到无关的腾讯 Marvis 名下。
        assert_eq!(by_session("mvs_named").tool, "minimax");
        assert_eq!(by_session("mvs_named").model, "MiniMax-M3");
        assert_eq!(by_session("mvs_other").tool, "minimax");
        assert_eq!(by_session("mvs_other").model, "deepseek-v4-pro-external");

        // framework 优先级不受影响：即使模型缺失也仍归 opencode。
        let framework = by_session("mvs_fw");
        assert_eq!(framework.tool, "opencode");
        assert_eq!(framework.model, MINIMAX_UNKNOWN_MODEL);

        // 来源的 0 成本是「没报」不是「免费」，落库必须是 NULL 才会走价格表。
        assert_eq!(unknown.cost_usd, None);
        assert_eq!(by_session("mvs_other").cost_usd, None);
        // 真实供应商成本原样保留。
        assert_eq!(by_session("mvs_named").cost_usd, Some(0.5));
    }

    #[test]
    fn recovers_the_per_request_model_when_the_usage_row_has_none() {
        // MiniMax Code 自 2026-08-24 起不再写 `local_runtime_token_usage.model`，
        // 但每条助手消息仍带 `context_usage_telemetry.model`，且它的 usage 与
        // 同一请求的用量行逐字段相等。扫描器据此恢复真实模型，而不是记未知。
        let home = TestHome::new("recover-model");
        let runtime_v2_path = home.0.join(".minimax/v2/sqlite/runtime-state.sqlite");
        fs::create_dir_all(runtime_v2_path.parent().expect("v2 parent")).expect("create v2 parent");
        let conn = Connection::open(&runtime_v2_path).expect("open v2 fixture");
        conn.execute_batch(
            "CREATE TABLE local_runtime_token_usage (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                framework_type TEXT NOT NULL,
                turn_id TEXT,
                model TEXT,
                ts INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                reasoning_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_write_tokens INTEGER NOT NULL,
                cost_usd REAL,
                raw TEXT
             );
             CREATE TABLE local_runtime_message_rows (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                data_json TEXT
             );",
        )
        .expect("create v2 schema");
        // 同一会话中途换模型：usage 行的 model 全空，只能靠逐请求 telemetry 区分。
        conn.execute_batch(
            "INSERT INTO local_runtime_token_usage (
                id, session_id, agent_name, framework_type, turn_id, model, ts,
                input_tokens, output_tokens, reasoning_tokens,
                cache_read_tokens, cache_write_tokens, cost_usd, raw
             ) VALUES
             (1, 'mvs_switch', 'mavis', 'pi-agent', 't1', NULL, 1787535003090, 100, 20, 0, 400, 0, 0, NULL),
             (2, 'mvs_switch', 'mavis', 'pi-agent', 't2', NULL, 1787535004090, 200, 30, 0, 500, 0, 0, NULL),
             -- `cache_read` 字段缺失的一条：必须按 0 归一化后仍能配对。
             (3, 'mvs_nocache', 'mavis', 'pi-agent', 't3', NULL, 1787535005090, 11, 22, 0, 0, 0, 0, NULL),
             -- 没有任何消息记录：老老实实记未知。
             (4, 'mvs_orphan', 'mavis', 'pi-agent', 't4', NULL, 1787535006090, 1, 2, 0, 0, 0, 0, NULL);
             INSERT INTO local_runtime_message_rows (id, session_id, role, data_json) VALUES
             (1, 'mvs_switch', 'assistant', '{\"usage\":{\"input_tokens\":100,\"output_tokens\":20,\"cache_read\":400,\"total_tokens\":520},\"context_usage_telemetry\":{\"model\":\"deepseek-v4-flash\"}}'),
             (2, 'mvs_switch', 'assistant', '{\"usage\":{\"input_tokens\":200,\"output_tokens\":30,\"cache_read\":500,\"total_tokens\":730},\"context_usage_telemetry\":{\"model\":\"gpt-5.6-sol\"}}'),
             (3, 'mvs_nocache', 'assistant', '{\"usage\":{\"input_tokens\":11,\"output_tokens\":22,\"total_tokens\":33},\"context_usage_telemetry\":{\"model\":\"MiniMax-M3.1-Flash-Preview\"}}'),
             -- 同会话同 token 指纹的助手消息，但 role 不是 assistant：不得配对。
             (4, 'mvs_orphan', 'user', '{\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3},\"context_usage_telemetry\":{\"model\":\"should-not-be-used\"}}');",
        )
        .expect("insert v2 fixture rows");
        drop(conn);

        let mut logs = Vec::new();
        let scanned = scan_minimax_marvis_from_home(&mut logs, &home.0, false, false);
        assert_eq!(scanned, 4);

        let by_turn_index = |index: usize| &logs[index];
        let first = by_turn_index(0);
        assert_eq!(first.model, "deepseek-v4-flash");
        assert_eq!(first.tool, "minimax");
        // 同一会话的第二轮换了模型：逐请求来源能区分，会话级 effectiveModel 不能。
        let second = by_turn_index(1);
        assert_eq!(second.model, "gpt-5.6-sol");
        assert_eq!(second.tool, "minimax");
        // 缺字段归一化后仍配对成功。
        assert_eq!(by_turn_index(2).model, "MiniMax-M3.1-Flash-Preview");
        // 无来源可依时保持诚实。
        assert_eq!(by_turn_index(3).model, MINIMAX_UNKNOWN_MODEL);
        // 数值不受恢复过程影响。
        assert_eq!(first.input_tokens, 100);
        assert_eq!(first.cached_tokens, 400);
    }

    #[test]
    #[ignore = "requires an explicitly authorized local MiniMaxCode home directory"]
    fn reads_authorized_real_v2_database_with_native_sqlite() {
        let home = std::env::var_os("TOKENLEDGER_MINIMAX_REAL_HOME")
            .map(PathBuf::from)
            .expect("set TOKENLEDGER_MINIMAX_REAL_HOME explicitly");
        let source = minimax_database_sources(&home)
            .into_iter()
            .find(|source| source.kind == MinimaxDatabaseKind::RuntimeV2)
            .expect("MiniMaxCode v2 runtime database");
        let mut logs = Vec::new();
        let scanned = scan_minimax_database(&mut logs, &source, false, false)
            .expect("read authorized MiniMaxCode v2 database");
        assert!(scanned > 0);
        assert_eq!(logs.len(), scanned);

        let input_tokens: i64 = logs.iter().map(|record| record.input_tokens).sum();
        let output_tokens: i64 = logs.iter().map(|record| record.output_tokens).sum();
        println!(
            "authorized MiniMaxCode v2 rows={scanned} input_tokens={input_tokens} output_tokens={output_tokens}"
        );

        // 真机门禁要能看见模型恢复本身：来源自 2026-08-24 起不写 `model`，所以
        // 绝大多数行必须由逐请求 telemetry 补出真实模型名；仍未知的应当只是零星
        // 没有消息记录的孤行。任何一条行归属到 `marvis` 都说明工具口径回退了。
        let mut by_model: HashMap<&str, usize> = HashMap::new();
        for record in &logs {
            *by_model.entry(record.model.as_str()).or_default() += 1;
        }
        let mut distribution: Vec<(&str, usize)> = by_model.into_iter().collect();
        distribution.sort_by(|a, b| b.1.cmp(&a.1));
        println!("authorized MiniMaxCode v2 model distribution:");
        for (model, count) in &distribution {
            println!("  {count:>6}  {model}");
        }
        let unknown = logs
            .iter()
            .filter(|record| record.model == MINIMAX_UNKNOWN_MODEL)
            .count();
        println!("authorized MiniMaxCode v2 unresolved={unknown}");
        assert!(
            logs.iter().all(|record| record.tool != "marvis"),
            "工具口径回退：MiniMax Code 的行不得归到 marvis"
        );
        assert!(
            logs.iter()
                .filter(|record| record.model != MINIMAX_UNKNOWN_MODEL)
                .count()
                > scanned / 2,
            "模型恢复率异常：超过一半的行仍未知"
        );
        assert!(
            unknown * 20 < scanned,
            "未知模型占比过高：{unknown}/{scanned}"
        );
    }
}
