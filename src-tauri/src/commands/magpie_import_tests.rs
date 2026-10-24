use super::*;
use chrono::TimeZone;
use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn test_app() -> (AppContext, PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_magpie_import_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    let app = AppContext::for_test(path.clone());
    db::init_db(&db::get_db_path(&app)).expect("init test db");
    (app, path)
}

fn local_ts(hour: u32, minute: u32, second: u32) -> DateTime<Local> {
    Local
        .with_ymd_and_hms(2026, 10, 20, hour, minute, second)
        .single()
        .expect("test wall-clock time exists")
}

fn storage(at: DateTime<Local>) -> String {
    at.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn insert_scan(conn: &Connection, key: &str, session: &str, at: &str, input: i64, output: i64) {
    conn.execute(
        "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status)
         VALUES ('claude', 'claude-sonnet-5', ?1, ?2, 0, 0, ?3, ?4, ?5, NULL, 'mac', 0)",
        params![input, output, at, session, key],
    )
    .unwrap();
}

fn magpie_line(at: DateTime<Local>, session: &str, input: i64, output: i64) -> Value {
    json!({
        "t": at.with_timezone(&Utc).to_rfc3339(), "agent": "claude", "provider": "anthropic",
        "host": "api.example.com", "providerKeyName": "work key", "providerKeyId": "fp",
        "providerAccount": "someone@example.com", "model": "claude-sonnet-5",
        "in": input, "out": output, "cache_read": 0, "cache_write": 0, "ms": 2000,
        "status": 200, "session": session, "rid": format!("req-{input}-{output}"),
        "err": "", "ep": "/v1/messages"
    })
}

fn write_magpie(root: &Path, lines: &[Value]) -> PathBuf {
    let dir = root.join("magpie-home");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(SOURCE_FILE);
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    fs::write(&path, text).unwrap();
    path
}

fn merged_totals(db_path: &Path) -> (i64, i64) {
    let conn = gateway_overlay::open_stats_connection(db_path).unwrap();
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(input_tokens + output_tokens), 0) FROM token_logs",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

#[test]
fn parse_keeps_counted_calls_and_drops_identifying_fields() {
    let (_app, root) = test_app();
    let at = local_ts(9, 0, 0);
    let mut rejected = magpie_line(at, "s", 1, 1);
    rejected["rejected"] = json!(true);
    let mut legacy_rejected = magpie_line(at, "s", 2, 1);
    legacy_rejected["provider"] = json!("");
    legacy_rejected["status"] = json!(429);
    let mut other = magpie_line(at, "s", 3, 1);
    other["computer"] = json!("abcdef0123456789");
    let mut routed = magpie_line(at, "", 7, 8);
    routed["model"] = json!("");
    routed["req"] = json!("openrouter/vendor-model");
    let source = write_magpie(
        &root,
        &[
            magpie_line(at, "s1", 100, 20),
            magpie_line(at, "s1", 100, 20), // the same line twice counts once
            magpie_line(at, "s1", 0, 0),
            rejected,
            legacy_rejected,
            other,
            routed,
            json!("not a record"),
        ],
    );
    fs::write(
        &source,
        format!("{}{{broken\n\n", fs::read_to_string(&source).unwrap()),
    )
    .unwrap();

    let (calls, counts) = parse_usage(&source).unwrap();
    assert_eq!(
        counts,
        ParseCounts {
            lines: 9,
            imported: 2,
            invalid: 2,
            zero_tokens: 1,
            rejected: 2,
            other_computer: 1,
            repeated: 1,
        }
    );
    assert_eq!(calls[0].model, "claude-sonnet-5");
    assert!(calls.iter().any(|call| call.model == "vendor-model"));
    let kept = serde_json::to_string(&calls).unwrap();
    for dropped in [
        "api.example.com",
        "work key",
        "someone@example.com",
        "req-",
        "/v1/messages",
    ] {
        assert!(!kept.contains(dropped), "{dropped} must not be kept");
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn import_supersedes_session_duplicates_and_adds_unseen_calls_without_touching_magpie() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).unwrap();
    insert_scan(&conn, "a", "sess-1", &storage(local_ts(10, 0, 1)), 100, 20);
    insert_scan(&conn, "b", "elsewhere", &storage(local_ts(12, 0, 0)), 5, 5);
    drop(conn);
    assert_eq!(merged_totals(&db_path), (2, 130));

    let source = write_magpie(
        &root,
        &[
            magpie_line(local_ts(10, 0, 2), "sess-1", 100, 20),
            magpie_line(local_ts(11, 0, 0), "", 40, 2),
        ],
    );
    let before = (
        fs::read(&source).unwrap(),
        fs::metadata(&source).unwrap().modified().unwrap(),
    );
    let meta = import_from(&db_path, &source).unwrap();
    assert_eq!(meta.counts.imported, 2);
    assert_eq!(meta.matched_scans, 1);
    assert_eq!(meta.held, 0);
    assert_eq!(meta.duplicate_of_gateway, 0);
    assert_eq!(
        before,
        (
            fs::read(&source).unwrap(),
            fs::metadata(&source).unwrap().modified().unwrap()
        ),
        "magpie's own file is never written"
    );

    // The scanned duplicate is replaced; the unseen call is added once.
    assert_eq!(merged_totals(&db_path), (3, 120 + 42 + 10));
    let conn = gateway_overlay::open_stats_connection(&db_path).unwrap();
    let id: i64 = conn
        .query_row(
            "SELECT id FROM token_logs WHERE input_tokens = 40",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        gateway_overlay::gateway_detail(&conn, id),
        Some(gateway_overlay::GatewayDetail {
            source: "imported-magpie".to_string(),
            provider: "anthropic".to_string(),
            latency_ms: Some(2000),
            context: None,
        })
    );
    drop(conn);

    // Importing again replaces the earlier import rather than adding to it.
    import_from(&db_path, &source).unwrap();
    assert_eq!(merged_totals(&db_path), (3, 172));

    clear(&db_path).unwrap();
    assert!(signature(&db_path).is_none());
    assert_eq!(merged_totals(&db_path), (2, 130));
    assert!(source.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn ambiguous_fingerprint_match_is_held_instead_of_merged() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).unwrap();
    // Two scanned calls with the same tokens, both inside the window, under
    // sessions magpie didn't see: which one magpie's call is can't be told.
    insert_scan(&conn, "a", "x", &storage(local_ts(10, 0, 0)), 50, 5);
    insert_scan(&conn, "b", "y", &storage(local_ts(10, 0, 1)), 50, 5);
    drop(conn);
    let source = write_magpie(&root, &[magpie_line(local_ts(10, 0, 1), "", 50, 5)]);
    let meta = import_from(&db_path, &source).unwrap();
    assert_eq!(meta.held, 1);
    assert_eq!(meta.matched_scans, 0);
    assert_eq!(
        merged_totals(&db_path),
        (2, 110),
        "nothing is double counted"
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn tokenledger_gateway_row_wins_over_the_same_call_in_magpie() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let dir = app.app_data_dir().join("gateway");
    fs::create_dir_all(&dir).unwrap();
    let at = local_ts(14, 0, 0);
    let line = json!({
        "ts": at.with_timezone(&Utc).to_rfc3339(), "requestId": "g1", "agent": "claude-code",
        "session": "sess-9", "endpoint": "messages", "provider": "anthropic",
        "requestedModel": "anthropic/claude-sonnet-5", "upstreamModel": "claude-sonnet-5",
        "wire": "messages", "stream": true, "status": 200, "ok": true, "input": 70,
        "output": 7, "cacheRead": 0, "cacheWrite": 0, "latencyMs": 1500, "error": null
    });
    fs::write(dir.join("usage-v1.jsonl"), format!("{line}\n")).unwrap();
    let source = write_magpie(&root, &[magpie_line(at, "sess-9", 70, 7)]);
    let meta = import_from(&db_path, &source).unwrap();
    assert_eq!(meta.duplicate_of_gateway, 1);
    assert_eq!(merged_totals(&db_path), (1, 77));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn corrupt_store_is_an_error_not_a_pure_scan_view() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    fs::create_dir_all(store_dir(&db_path)).unwrap();
    fs::write(store_path(&db_path), "{oops\n").unwrap();
    assert!(gateway_overlay::open_stats_connection(&db_path).is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn status_reports_presence_without_reading_other_magpie_files() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let missing = status_value(&db_path, Some(&root.join("absent")));
    assert_eq!(missing["magpieFound"], json!(false));
    assert_eq!(missing["usageFound"], json!(false));
    assert_eq!(missing["imported"], json!(false));
    let source = write_magpie(&root, &[magpie_line(local_ts(8, 0, 0), "s", 1, 1)]);
    let found = status_value(&db_path, source.parent());
    assert_eq!(found["magpieFound"], json!(true));
    assert_eq!(found["usageFound"], json!(true));
    let _ = fs::remove_dir_all(root);
}
