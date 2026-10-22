//! T10.165 guards (T10.155 spec §3.5, §3.7, §7 G1–G4): the local project
//! index never reaches cloud sync, CSV export, Stats v2, the usage detail
//! and entity dashboard views, diagnostics, the share poster or the HTML
//! brief.
//!
//! The existing sync guard is structural, and each piece is locked here:
//! the two fixed statements `PENDING_SYNC_WORK_SQL` / `RAW_SYNC_LOGS_SQL` over
//! the ledger and local sync repair queues only; the
//! `AggKey { tool, model, hour_bucket, machine_id }` aggregation; the fixed
//! `json!` payload whose `session_id` is always `"agg"` and whose `raw_ids`
//! are stripped before sending; and a cloud schema without project columns.
//! The payload itself is not built here: that needs the payload builder
//! extracted into a pure function (spec PD-8), which stays out of this task.

use super::*;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

const CANARY_LABEL: &str = "CANARY_PROJECT_LABEL";
const CANARY_KEY: &str = "n:canary_project_label";
const COMMANDS_SOURCE: &str = include_str!("mod.rs");
const GATEWAY_CLOUD_SOURCE: &str = include_str!("gateway_cloud.rs");
const SCANNER_SYNC_SOURCE: &str = include_str!("scanner_sync.rs");

/// Identifiers only the project index (and its migration) may use.
const PROJECT_IDENTIFIERS: &[&str] = &[
    "local_session_projects",
    "local_project_index_state",
    "project_index",
    "project_label",
    "project_key",
    "project_kind",
    "projectDimension",
];

/// A ledger with two sessions whose project index holds the canary label.
fn canary_app(tag: &str) -> AppContext {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_project_guard_{tag}_{}_{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, AtomicOrdering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    let app = AppContext::for_test(path);
    let db_path = db::get_db_path(&app);
    db::init_db(&db_path).expect("initialize test database");
    let conn = db::get_connection(&db_path).expect("open test database");
    conn.execute_batch(
        "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id,
             sync_status)
         VALUES ('claude', 'claude-sonnet-4', 120, 30, 10, 0, '2026-09-24 10:15:00',
                 'guard-s1', 'claude_guard_1', 0.01, 'machine-a', 0),
                ('codex', 'gpt-5', 80, 20, 0, 0, '2026-09-24 11:15:00',
                 'guard-s2', 'codex_v2_guard_2', NULL, 'machine-a', 0);
         INSERT INTO local_project_index_state
             (id, enabled, consent_version, generation, backfill_status)
         VALUES (1, 1, 1, 1, 'done');
         INSERT INTO local_session_projects
             (tool, session_id, source_family, project_kind, project_key, project_label,
              resolution, generation, resolver_version)
         VALUES ('claude', 'guard-s1', 'claude', 'named', 'n:canary_project_label',
                 'CANARY_PROJECT_LABEL', 'folder', 1, 2),
                ('codex', 'guard-s2', 'codex', 'named', 'n:canary_project_label',
                 'CANARY_PROJECT_LABEL', 'git_root', 1, 2);",
    )
    .expect("seed canary project index");
    app
}

#[track_caller]
fn assert_no_project_data(context: &str, text: &str) {
    assert!(
        !text.contains(CANARY_LABEL),
        "{context}: project label leaked"
    );
    assert!(
        !text.to_lowercase().contains(CANARY_KEY),
        "{context}: project key leaked"
    );
}

/// Source of a top-level function: from its signature to the first closing
/// brace in column 0.
fn fn_source<'a>(source: &'a str, signature: &str) -> &'a str {
    let start = source
        .find(signature)
        .unwrap_or_else(|| panic!("{signature} not found"));
    let rest = &source[start..];
    let end = rest.find("\n}\n").expect("function end");
    &rest[..end]
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> &'a str {
    let start = text
        .find(open)
        .unwrap_or_else(|| panic!("{open} not found"))
        + open.len();
    let length = text[start..]
        .find(close)
        .unwrap_or_else(|| panic!("{close} not found after {open}"));
    &text[start..start + length]
}

/// Table names that follow `FROM` / `JOIN`.
fn sql_tables(sql: &str) -> Vec<String> {
    let words: Vec<&str> = sql.split_whitespace().collect();
    words
        .windows(2)
        .filter(|pair| pair[0].eq_ignore_ascii_case("from") || pair[0].eq_ignore_ascii_case("join"))
        .map(|pair| {
            pair[1]
                .trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
                .to_string()
        })
        .collect()
}

#[test]
fn g1_sync_payload_and_aggregation_key_are_fixed() {
    let body = fn_source(COMMANDS_SOURCE, "pub async fn sync_to_supabase_impl(");
    let payload = between(body, "sync_logs.push(json!({", "}));");
    let keys: Vec<&str> = payload
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"'))
        .filter_map(|rest| rest.split('"').next())
        .collect();
    assert_eq!(
        keys,
        vec![
            "raw_ids",
            "user_id",
            "tool",
            "model",
            "input_tokens",
            "output_tokens",
            "cached_tokens",
            "cache_write_tokens",
            "timestamp",
            "session_id",
            "unique_key",
            "cost_usd",
            "machine_id",
            "requests",
            "gateway_requests",
        ],
        "the cloud payload key set is fixed (spec §3.5 item 3)"
    );
    let gateway_payload = between(GATEWAY_CLOUD_SOURCE, "json!({", "})");
    let gateway_keys: Vec<&str> = gateway_payload
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"'))
        .filter_map(|rest| rest.split('"').next())
        .collect();
    assert_eq!(
        gateway_keys,
        keys[1..].to_vec(),
        "gateway-merged aggregates send the same keys (dashboard-stats-v2 §2.5)"
    );
    assert!(gateway_payload.contains("\"session_id\": \"agg\""));
    for identifier in PROJECT_IDENTIFIERS {
        assert!(
            !GATEWAY_CLOUD_SOURCE.contains(identifier),
            "gateway cloud sync must not read {identifier}"
        );
    }
    assert!(
        payload.contains("\"session_id\": \"agg\""),
        "session ids never leave the machine"
    );
    assert!(
        body.contains("obj.remove(\"raw_ids\");"),
        "local row ids are stripped before sending"
    );
    assert!(body.contains("use scanner_sync::Bucket as AggKey;"));
    let aggregation_key: Vec<&str> = between(SCANNER_SYNC_SOURCE, "struct Bucket {", "}")
        .lines()
        .filter_map(|line| line.trim().split(':').next())
        .map(|field| field.strip_prefix("pub ").unwrap_or(field))
        .filter(|field| !field.is_empty())
        .collect();
    assert_eq!(
        aggregation_key,
        vec!["tool", "model", "hour_bucket", "machine_id"]
    );
    for identifier in PROJECT_IDENTIFIERS {
        assert!(
            !body.contains(identifier),
            "cloud sync must not read {identifier}"
        );
        assert!(
            !SCANNER_SYNC_SOURCE.contains(identifier),
            "scan sync repair must not read {identifier}"
        );
    }
}

#[test]
fn g2_sync_sql_reads_only_the_ledger_and_sync_repair_queues() {
    for (name, sql) in [
        ("PENDING_SYNC_WORK_SQL", PENDING_SYNC_WORK_SQL),
        ("RAW_SYNC_LOGS_SQL", RAW_SYNC_LOGS_SQL),
    ] {
        let tables = sql_tables(sql);
        assert!(!tables.is_empty(), "{name} names its tables");
        for table in &tables {
            assert!(
                matches!(
                    table.as_str(),
                    "token_logs" | "pending_cloud_purges" | "scan_cloud_dirty_buckets"
                ),
                "{name} reads {table}"
            );
        }
        assert!(
            !sql.to_ascii_lowercase().contains("project"),
            "{name} mentions projects"
        );
    }
    let app = canary_app("sync_repair_schema");
    let conn = db::get_connection(&db::get_db_path(&app)).expect("open repair schema");
    for (table, expected) in [
        (
            "scan_cloud_sent_identities",
            vec![
                "user_id",
                "source_key",
                "tool",
                "model",
                "hour_bucket",
                "machine_id",
            ],
        ),
        (
            "scan_cloud_dirty_buckets",
            vec![
                "id",
                "user_id",
                "tool",
                "model",
                "hour_bucket",
                "machine_id",
            ],
        ),
    ] {
        let mut statement = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let columns: Vec<String> = statement
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(columns, expected, "{table} stores sync identity only");
    }
    let columns: Vec<&str> = between(RAW_SYNC_LOGS_SQL, "SELECT ", "FROM token_logs")
        .split(',')
        .map(str::trim)
        .collect();
    assert_eq!(
        columns,
        vec![
            "id",
            "tool",
            "model",
            "input_tokens",
            "output_tokens",
            "cached_tokens",
            "cache_write_tokens",
            "timestamp",
            "cost_usd",
            "machine_id",
            "sync_status",
            "cloud_user_id",
            "sync_revision",
            "cache_write_known",
        ],
        "no session id, unique key or project column is read for sync"
    );
}

#[test]
fn g1_sync_rows_from_a_canary_ledger_carry_no_project_data() {
    let app = canary_app("sync_rows");
    let conn = db::get_connection(&db::get_db_path(&app)).expect("open test database");
    let pending: bool = conn
        .query_row(
            PENDING_SYNC_WORK_SQL,
            rusqlite::params!["user-guard", "machine-a"],
            |row| row.get(0),
        )
        .expect("pending sync work");
    assert!(pending, "the canary rows are waiting for sync");
    let mut statement = conn.prepare(RAW_SYNC_LOGS_SQL).expect("prepare sync rows");
    let columns = statement.column_count();
    assert_eq!(columns, 14);
    let mut rows = statement
        .query(rusqlite::params!["user-guard", "machine-a"])
        .expect("query sync rows");
    let mut seen = 0;
    while let Some(row) = rows.next().expect("sync row") {
        for index in 0..columns {
            let value: SqlValue = row.get(index).expect("sync value");
            assert_no_project_data("sync row", &format!("{value:?}"));
        }
        seen += 1;
    }
    assert_eq!(seen, 2);
}

#[test]
fn g3_csv_export_keeps_its_fixed_header_and_no_project_data() {
    let app = canary_app("csv");
    let result = export_db_csv_impl(&app).expect("export csv");
    assert_no_project_data("csv result", &result.to_string());
    let csv = fs::read_to_string(app.app_data_dir().join("tokenledger_export.csv"))
        .expect("read exported csv");
    // `estimated_cost_usd` 紧跟 `cost_usd`（用户决定 U-11，T10.196）；项目字段一个都不能进。
    assert_eq!(
        csv.lines().next(),
        Some(
            "id,tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,\
             timestamp,session_id,unique_key,cost_usd,estimated_cost_usd,machine_id,\
             sync_status,cloud_user_id,synced_at"
        )
    );
    assert_eq!(csv.lines().count(), 3, "header plus the two ledger rows");
    assert_no_project_data("csv", &csv);
}

#[test]
fn stats_details_entity_dashboard_and_db_info_carry_no_project_data() {
    let app = canary_app("views");
    let stats = get_local_stats_v2_impl(
        &app,
        serde_json::from_value(json!({ "range": "all", "timezone": "UTC" })).expect("stats query"),
    )
    .expect("local stats v2");
    let stats_text = stats.to_string();
    assert!(stats_text.contains("gpt-5"), "the ledger rows are visible");
    assert_no_project_data("stats v2", &stats_text);

    let details = get_usage_details_impl(
        &app,
        serde_json::from_value(json!({ "scope": "local", "range": "all", "timezone": "UTC" }))
            .expect("details query"),
    )
    .expect("usage details");
    assert_no_project_data("usage details", &details.to_string());

    let entity = get_local_entity_dashboard_impl(
        &app,
        serde_json::from_value(json!({
            "scope": "local",
            "entity": { "kind": "tool", "id": "claude" },
            "range": "all",
            "timezone": "UTC"
        }))
        .expect("entity query"),
    )
    .expect("entity dashboard");
    assert_no_project_data("entity dashboard", &entity.to_string());

    let info = get_db_info_impl(&app).expect("db info");
    let keys: BTreeSet<&str> = info
        .as_object()
        .expect("db info object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            "path",
            "totalRecords",
            "unsyncedRecords",
            "sizeBytes",
            "reclaimableBytes",
            "freelistPages",
            "earliest",
            "latest",
        ])
    );
    assert_no_project_data("db info", &info.to_string());
}

#[test]
fn only_the_project_index_and_its_migration_touch_the_project_tables() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut readers = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("rs") {
            continue;
        }
        let relative = path
            .strip_prefix(&root)
            .expect("inside src")
            .to_string_lossy()
            .replace('\\', "/");
        let source = fs::read_to_string(path).expect("read source file");
        if source.contains("local_session_projects") || source.contains("local_project_index_state")
        {
            readers.push(relative);
        }
    }
    readers.sort();
    // A new reader must be a local-only view (spec §3.7) and is added here
    // deliberately, e.g. the behavior aggregation of PD-6.
    let allowed = |path: &str| {
        path == "db.rs"
            || path == "project_index.rs"
            || path.starts_with("project_index/")
            || path == "commands/project_dimension_guard_tests.rs"
    };
    for reader in &readers {
        assert!(allowed(reader), "{reader} reads the project index tables");
    }
    assert!(readers.iter().any(|reader| reader == "db.rs"));
}

#[test]
fn cloud_schema_and_migrations_have_no_project_columns() {
    let supabase = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("supabase");
    let mut files = vec![supabase.join("schema.sql")];
    files.extend(
        fs::read_dir(supabase.join("migrations"))
            .expect("supabase migrations")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("sql")),
    );
    assert!(files.len() > 1, "schema and migrations are checked");
    for file in files {
        let sql = fs::read_to_string(&file)
            .expect("read supabase sql")
            .to_lowercase();
        for identifier in [
            "project_key",
            "project_label",
            "project_kind",
            "project_dimension",
            "local_session_projects",
            "local_project_index_state",
        ] {
            assert!(
                !sql.contains(identifier),
                "{:?} adds cloud project data ({identifier})",
                file.file_name()
            );
        }
    }
}

#[test]
fn g4_share_poster_and_html_brief_are_built_from_stats_data_only() {
    let utils = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src")
        .join("utils");
    for file in ["shareCardRenderer.ts", "shareSummary.ts", "reportExport.ts"] {
        let source = fs::read_to_string(utils.join(file))
            .unwrap_or_else(|error| panic!("read {file}: {error}"));
        assert!(source.contains("StatsData"), "{file} takes StatsData");
        assert!(
            !has_private_dimension_reference(&source),
            "{file} must not reference behavior or project data"
        );
    }
}

/// Inspect identifier words (including import paths and quoted object keys),
/// not prose comments or substrings such as `projection`. CamelCase and
/// snake_case both expose their words, so `projectLabel` is not a loophole.
fn has_private_dimension_reference(source: &str) -> bool {
    let chars: Vec<char> = source.chars().collect();
    let mut code = String::new();
    let mut index = 0;
    let mut quote = None;
    while index < chars.len() {
        let ch = chars[index];
        if let Some(delimiter) = quote {
            code.push(ch);
            if ch == '\\' && index + 1 < chars.len() {
                index += 1;
                code.push(chars[index]);
            } else if ch == delimiter {
                quote = None;
            }
        } else if ch == '/' && chars.get(index + 1) == Some(&'/') {
            index += 2;
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            code.push(' ');
            continue;
        } else if ch == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index < chars.len()
                && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/'))
            {
                index += 1;
            }
            index = (index + 2).min(chars.len());
            code.push(' ');
            continue;
        } else {
            if matches!(ch, '\'' | '"' | '`') {
                quote = Some(ch);
            }
            code.push(ch);
        }
        index += 1;
    }
    code.split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|identifier| {
            let chars: Vec<char> = identifier.chars().collect();
            let mut words = String::new();
            for (index, &ch) in chars.iter().enumerate() {
                if ch.is_ascii_uppercase()
                    && index > 0
                    && (chars[index - 1].is_ascii_lowercase()
                        || chars.get(index + 1).is_some_and(char::is_ascii_lowercase))
                {
                    words.push(' ');
                }
                words.push(ch.to_ascii_lowercase());
            }
            words
                .split_whitespace()
                .any(|word| matches!(word, "project" | "projects" | "behavior" | "behaviors"))
        })
}

#[test]
fn g4_identifier_guard_accepts_projection_but_rejects_private_data_references() {
    for safe in [
        "// project and behavior stay private\nconst projection = stats.summary;",
        "/* projectLabel, BehaviorStats */ const projectedCost = stats.summary.totalCost;",
        "const url = 'https://example.invalid/projection';",
    ] {
        assert!(
            !has_private_dimension_reference(safe),
            "false positive: {safe}"
        );
    }
    for leak in [
        "const title = stats.projectLabel;",
        "const title = stats.project_id;",
        "const title = stats['project_label'];",
        "import type { ProjectSummary } from './types';",
        "import { load } from './projectDimension';",
        "const rows = behaviorStats.sessions;",
        "const rows = localSessionProjects;",
        "const title = `${stats.projectLabel}`;",
        "/* safe */ const key = PROJECT_ID;",
    ] {
        assert!(has_private_dimension_reference(leak), "missed leak: {leak}");
    }
}
