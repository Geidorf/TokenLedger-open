use super::*;
use chrono::TimeZone;
use rusqlite::{params, Connection};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn test_app() -> (AppContext, PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_peer_shared_{}_{}",
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

fn insert_scan(conn: &Connection, key: &str, session: &str, at: &str, input: i64, output: i64) {
    conn.execute(
        "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status)
         VALUES ('claude', 'claude-sonnet-5', ?1, ?2, 0, 0, ?3, ?4, ?5, NULL, 'mac', 0)",
        params![input, output, at, session, key],
    )
    .unwrap();
}

fn shared(
    computer: &str,
    at: DateTime<Local>,
    session: &str,
    input: i64,
    output: i64,
) -> SharedCall {
    parse_call(
        computer,
        &json!({
            "t": at.with_timezone(&Utc).to_rfc3339(), "agent": "claude", "provider": "anthropic",
            "model": "claude-sonnet-5", "in": input, "out": output, "ms": 2000,
            "status": 200, "session": session, "rid": format!("req-{input}"), "source": "gateway"
        }),
    )
    .expect("counted call")
}

fn merged(db_path: &Path) -> Vec<(i64, String)> {
    let conn = gateway_overlay::open_stats_connection(db_path).unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT input_tokens, machine_id FROM token_logs ORDER BY input_tokens, machine_id",
        )
        .unwrap();
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows
}

#[test]
fn shared_calls_are_counted_under_their_computer_and_never_replace_a_scan() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).unwrap();
    insert_scan(
        &conn,
        "a",
        "sess-1",
        &local_ts(10, 0, 1).format("%Y-%m-%d %H:%M:%S").to_string(),
        100,
        20,
    );
    drop(conn);
    assert!(gateway_overlay::ledger_signature(&db_path).is_none());

    // The same session and fingerprint as the scan: still another computer's call.
    let calls = vec![
        shared("aa", local_ts(10, 0, 2), "sess-1", 100, 20),
        shared("aa", local_ts(10, 0, 2), "sess-1", 100, 20),
        shared("bb", local_ts(11, 0, 0), "", 40, 2),
    ];
    let meta = write_store(
        &db_path,
        &calls,
        vec![SharedComputer {
            id: "aa".into(),
            name: "studio".into(),
            days: 1,
            calls: 2,
        }],
    )
    .unwrap();
    assert_eq!(read_meta(&db_path), Some(meta));
    assert!(signature(&db_path).is_some());
    assert!(gateway_overlay::ledger_signature(&db_path).is_some());

    assert_eq!(
        merged(&db_path),
        vec![
            (40, "peer:bb".to_string()),
            (100, "mac".to_string()),
            (100, "peer:aa".to_string()),
        ]
    );
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
            source: "shared-peer".to_string(),
            provider: "anthropic".to_string(),
            latency_ms: Some(2000),
            context: None,
        })
    );
    drop(conn);

    // Shared rows are another computer's to upload.
    assert!(
        super::super::gateway_cloud::collect_hours(&db_path, "user-a", "mac")
            .unwrap()
            .is_empty()
    );

    clear(&db_path).unwrap();
    assert!(signature(&db_path).is_none() && read_meta(&db_path).is_none());
    assert_eq!(merged(&db_path), vec![(100, "mac".to_string())]);
    clear(&db_path).unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rows_keep_session_tool_and_tokens() {
    let call = shared("aa", local_ts(9, 30, 0), "", 7, 3);
    let row = call_to_row(&call, &local_storage_time).unwrap();
    assert_eq!(row.source, RowSource::SharedPeer);
    assert_eq!(row.machine_id.as_deref(), Some("peer:aa"));
    assert!(!row.real_session);
    assert!(gateway_overlay::is_synthetic_session(&row.session_id));
    assert!(row.session_id.ends_with(&row.request_id));
    assert_eq!((row.input_tokens, row.output_tokens), (7, 3));
    assert_eq!(row.timestamp, "2026-10-20 09:30:00");
    assert_eq!(row.start_timestamp, "2026-10-20 09:29:58");
}

#[test]
fn identity_is_stable_and_model_falls_back() {
    let value = json!({"t": "2026-10-20T01:00:00+08:00", "provider": "p", "req": "p/m-1", "in": 1});
    let first = parse_call("aa", &value).unwrap();
    assert_eq!(first.model, "m-1");
    assert_eq!(first.t, "2026-10-19T17:00:00+00:00");
    assert_eq!(first, parse_call("aa", &value).unwrap());
    let served = json!({"t": "2026-10-20T01:00:00+08:00", "provider": "p", "served": "s", "req": "p/m-1", "in": 1});
    assert_eq!(parse_call("aa", &served).unwrap().model, "s");
}

#[test]
fn corrupt_store_is_an_error_not_dropped() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    fs::create_dir_all(store_dir(&db_path)).unwrap();
    fs::write(store_path(&db_path), "not json\n").unwrap();
    assert!(read_rows(&db_path).is_err());
    assert!(gateway_overlay::open_stats_connection(&db_path).is_err());
    let _ = fs::remove_dir_all(root);
}
