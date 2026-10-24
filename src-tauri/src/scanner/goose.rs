use super::helpers::*;
use super::types::LogRecord;
use chrono::TimeZone;
use rusqlite::{Connection, OpenFlags};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// goose keeps its sessions in `<data dir>/sessions/sessions.db`. The data
/// dir is `$GOOSE_PATH_ROOT/data` when that is an absolute path, otherwise
/// the platform app dir for "Block / goose": `~/.local/share/goose` (or
/// `$XDG_DATA_HOME/goose`), `~/Library/Application Support/Block.goose`, or
/// `%APPDATA%\Block\goose\data`.
pub(crate) fn goose_db_candidates(home: &Path) -> Vec<PathBuf> {
    goose_db_candidates_from(
        std::env::var_os("GOOSE_PATH_ROOT"),
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("APPDATA"),
        home,
    )
}

fn goose_db_candidates_from(
    path_root: Option<std::ffi::OsString>,
    xdg_data_home: Option<std::ffi::OsString>,
    appdata: Option<std::ffi::OsString>,
    home: &Path,
) -> Vec<PathBuf> {
    let absolute = |value: Option<std::ffi::OsString>| {
        value.map(PathBuf::from).filter(|path| path.is_absolute())
    };
    let data_dir = if let Some(root) = absolute(path_root) {
        root.join("data")
    } else if cfg!(target_os = "windows") {
        absolute(appdata)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Block")
            .join("goose")
            .join("data")
    } else if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Block.goose")
    } else {
        absolute(xdg_data_home)
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join("goose")
    };
    vec![data_dir.join("sessions").join("sessions.db")]
}

fn goose_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn scan_goose(logs: &mut Vec<LogRecord>) -> usize {
    goose_db_candidates(&get_home_dir())
        .iter()
        .map(|db| scan_goose_db(db, logs))
        .sum()
}

/// Reads the per-request `usage_ledger` table (one row per model call,
/// compaction calls included, written since goose's ledger migration). The
/// per-session totals in `sessions` aggregate these rows and are not read,
/// so nothing is counted twice. Message content is never selected.
///
/// goose stores the whole prompt in `input_tokens` (cache reads and writes
/// included, for both Anthropic- and OpenAI-style providers); the ledger
/// keeps net input and books cache traffic separately. Rows never change
/// after insert, so they dedupe by the ledger's primary key.
pub(crate) fn scan_goose_db(db_path: &Path, logs: &mut Vec<LogRecord>) -> usize {
    if !db_path.is_file() {
        return 0;
    }
    let Ok(conn) = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return 0;
    };
    let has_ledger = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_ledger'",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !has_ledger {
        return 0;
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, session_id, created_timestamp, model, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, cost, cost_source
         FROM usage_ledger ORDER BY id",
    ) else {
        return 0;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<i64>>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<i64>>(7)?,
            row.get::<_, Option<f64>>(8)?,
            row.get::<_, Option<String>>(9)?,
        ))
    }) else {
        return 0;
    };

    let mut count = 0;
    for row in rows.flatten() {
        let (
            id,
            session_id,
            created,
            model,
            input,
            output,
            cache_read,
            cache_write,
            cost,
            cost_source,
        ) = row;
        let counters = [input, output, cache_read, cache_write].map(|value| value.unwrap_or(0));
        if counters.iter().any(|value| *value < 0) {
            continue;
        }
        let [input, output, cache_read, cache_write] = counters;
        let cached = cache_read + cache_write;
        let net_input = if input >= cached {
            input - cached
        } else {
            input
        };
        if net_input <= 0 && output <= 0 && cached <= 0 {
            continue;
        }
        let Some(timestamp) = created
            .and_then(|seconds| chrono::Local.timestamp_opt(seconds, 0).single())
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        else {
            continue;
        };
        let model = model
            .as_deref()
            .map(clean_model_name)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "goose-unknown".to_string());
        // Only provider-reported bills are kept; goose's own estimates are
        // left to the ledger's price table like every other estimate.
        let cost_usd = cost
            .filter(|_| cost_source.as_deref() == Some("provider_reported"))
            .filter(|value| value.is_finite() && *value > 0.0);
        logs.push(LogRecord {
            tool: "goose".to_string(),
            model,
            input_tokens: net_input,
            output_tokens: output,
            cached_tokens: cached,
            cache_write_tokens: cache_write,
            timestamp,
            unique_key: format!("goose_{}_{id}", goose_hash(&session_id)),
            session_id,
            cost_usd,
            cumulative: false,
        });
        count += 1;
    }
    count
}

#[cfg(test)]
mod scanner_goose_tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const FIXTURE_SQL: &str = include_str!("../../tests/fixtures/goose/sessions.sql");

    fn fixture_db() -> (PathBuf, PathBuf) {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tokenledger_goose_test_{suffix}"));
        let db = root.join("sessions").join("sessions.db");
        fs::create_dir_all(db.parent().expect("db dir")).expect("create db dir");
        let conn = Connection::open(&db).expect("open fixture db");
        conn.execute_batch(FIXTURE_SQL).expect("load fixture");
        (root, db)
    }

    #[test]
    fn reads_ledger_rows_as_net_input_with_cache_split() {
        let (root, db) = fixture_db();
        let mut logs = Vec::new();
        assert_eq!(scan_goose_db(&db, &mut logs), 3);

        let first = &logs[0];
        assert_eq!(first.tool, "goose");
        assert_eq!(first.model, "claude-sonnet-4.6");
        assert_eq!(first.session_id, "20261021_1");
        assert_eq!(first.input_tokens, 30_000 - 25_000 - 1_000);
        assert_eq!(first.cached_tokens, 26_000);
        assert_eq!(first.cache_write_tokens, 1_000);
        assert_eq!(first.output_tokens, 700);
        assert_eq!(first.cost_usd, Some(0.021));

        // Estimated costs are not carried over; compaction calls still count.
        assert_eq!(logs[1].cost_usd, None);
        assert_eq!(logs[1].input_tokens, 4_000);
        assert_eq!(logs[2].model, "goose-unknown");
        assert_ne!(first.unique_key, logs[1].unique_key);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn database_without_ledger_yields_nothing() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let db = std::env::temp_dir().join(format!("tokenledger_goose_old_{suffix}.db"));
        Connection::open(&db)
            .expect("open")
            .execute_batch(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY, accumulated_input_tokens INTEGER);",
            )
            .expect("create");
        assert_eq!(scan_goose_db(&db, &mut Vec::new()), 0);
        assert_eq!(
            scan_goose_db(Path::new("/missing/sessions.db"), &mut Vec::new()),
            0
        );
        let _ = fs::remove_file(db);
    }

    #[test]
    fn path_root_overrides_platform_dir() {
        let root = std::env::temp_dir().join("goose-root");
        assert_eq!(
            goose_db_candidates_from(Some(root.clone().into()), None, None, Path::new("/h")),
            vec![root.join("data").join("sessions").join("sessions.db")]
        );
        let default =
            goose_db_candidates_from(Some("relative".into()), None, None, Path::new("/h"));
        assert!(default[0].ends_with("sessions/sessions.db"));
        assert!(!default[0].starts_with("relative"));
    }
}
