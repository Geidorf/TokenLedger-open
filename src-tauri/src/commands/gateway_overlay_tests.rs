use super::*;
use crate::app_paths::AppContext;
use chrono::TimeZone;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

const FIXTURE: &str = include_str!("../../../fixtures/dashboard-stats-v2/gateway-dedupe-v2.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("gateway dedupe fixture is valid JSON")
}

fn fixture_rows(fixture: &Value) -> Vec<GatewayRow> {
    let tz: chrono_tz::Tz = fixture["timezone"].as_str().unwrap().parse().unwrap();
    let storage = move |ts: DateTime<Utc>| {
        ts.with_timezone(&tz)
            .naive_local()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string()
    };
    fixture["gatewayRecords"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| serde_json::from_value::<LedgerRecord>(value.clone()).unwrap())
        .filter_map(|record| map_record(&record, &storage))
        .collect()
}

fn fixture_scans(fixture: &Value) -> Vec<ScanCandidate> {
    fixture["scanRows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| ScanCandidate {
            id: row["id"].as_i64().unwrap(),
            tool: row["tool"].as_str().unwrap().to_string(),
            session_id: row["sessionId"].as_str().unwrap().to_string(),
            timestamp: row["timestamp"].as_str().unwrap().to_string(),
            input_tokens: row["inputTokens"].as_i64().unwrap(),
            output_tokens: row["outputTokens"].as_i64().unwrap(),
            cached_tokens: row["cachedTokens"].as_i64().unwrap(),
        })
        .collect()
}

#[test]
fn fixture_maps_gateway_records_to_stats_rows() {
    let fixture = fixture();
    let rows = fixture_rows(&fixture);
    let expected = fixture["expected"]["gatewayRows"].as_array().unwrap();
    assert_eq!(rows.len(), expected.len());
    for (row, want) in rows.iter().zip(expected) {
        assert_eq!(row.request_id, want["requestId"].as_str().unwrap());
        assert_eq!(row.tool, want["tool"].as_str().unwrap());
        assert_eq!(row.model, want["model"].as_str().unwrap());
        assert_eq!(row.provider, want["provider"].as_str().unwrap());
        assert_eq!(row.session_id, want["sessionId"].as_str().unwrap());
        assert_eq!(row.timestamp, want["timestamp"].as_str().unwrap());
        assert_eq!(
            row.start_timestamp,
            want["startTimestamp"].as_str().unwrap()
        );
        assert_eq!(row.input_tokens, want["inputTokens"].as_i64().unwrap());
        assert_eq!(row.output_tokens, want["outputTokens"].as_i64().unwrap());
        assert_eq!(row.cached_tokens, want["cachedTokens"].as_i64().unwrap());
        assert_eq!(
            row.cache_write_tokens,
            want["cacheWriteTokens"].as_i64().unwrap()
        );
        assert!(row.id < 0, "gateway ids must not collide with scanned ids");
    }
}

#[test]
fn fixture_supersedes_scanned_duplicates_and_keeps_effective_tokens() {
    let fixture = fixture();
    let rows = fixture_rows(&fixture);
    let scans = fixture_scans(&fixture);
    let window = fixture["windowSeconds"].as_i64().unwrap();
    assert_eq!(window, DEDUPE_WINDOW_SECS);
    let superseded = superseded_scan_ids(&rows, &scans, window);
    let expected: BTreeSet<i64> = fixture["expected"]["supersededScanIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_i64().unwrap())
        .collect();
    assert_eq!(superseded, expected);

    let kept = scans.iter().filter(|scan| !superseded.contains(&scan.id));
    let (mut input, mut output, mut cached, mut requests) = (0, 0, 0, 0);
    for scan in kept {
        input += scan.input_tokens;
        output += scan.output_tokens;
        cached += scan.cached_tokens;
        requests += 1;
    }
    for row in &rows {
        input += row.input_tokens;
        output += row.output_tokens;
        cached += row.cached_tokens;
        requests += 1;
    }
    let summary = &fixture["expected"]["mergedSummary"];
    assert_eq!(input, summary["inputTokens"].as_i64().unwrap());
    assert_eq!(output, summary["outputTokens"].as_i64().unwrap());
    assert_eq!(input + output, summary["effectiveTokens"].as_i64().unwrap());
    assert_eq!(cached, summary["cachedTokens"].as_i64().unwrap());
    assert_eq!(requests, summary["requests"].as_i64().unwrap());
}

#[test]
fn unknown_agent_and_empty_upstream_fall_back() {
    assert_eq!(tool_for_agent(None), "gateway");
    assert_eq!(tool_for_agent(Some("  ")), "gateway");
    assert_eq!(tool_for_agent(Some("claude-code")), "claude");
    assert_eq!(tool_for_agent(Some("opencode")), "opencode");
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn test_app() -> (AppContext, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_gw_overlay_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    let app = AppContext::for_test(path.clone());
    db::init_db(&db::get_db_path(&app)).expect("init test db");
    (app, path)
}

fn local_ts(hour: u32, minute: u32, second: u32) -> chrono::DateTime<Local> {
    Local
        .with_ymd_and_hms(2026, 10, 4, hour, minute, second)
        .single()
        .expect("test wall-clock time exists")
}

fn insert_scan(
    conn: &Connection,
    key: &str,
    session: &str,
    at: &str,
    input: i64,
    output: i64,
) -> i64 {
    conn.execute(
        "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status)
         VALUES ('codex', 'openai/gpt-5.5', ?1, ?2, 0, 0, ?3, ?4, ?5, NULL, 'mac', 0)",
        params![input, output, at, session, key],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn write_ledger(app: &AppContext, lines: &[Value]) {
    let dir = app.app_data_dir().join("gateway");
    fs::create_dir_all(&dir).unwrap();
    let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
    fs::write(dir.join("usage-v1.jsonl"), text).unwrap();
}

fn ledger_line(
    id: &str,
    session: Option<&str>,
    at: chrono::DateTime<Local>,
    input: u64,
    output: u64,
) -> Value {
    json!({
        "ts": at.with_timezone(&Utc).to_rfc3339(), "requestId": id, "agent": "codex",
        "session": session, "endpoint": "responses", "provider": "openai",
        "requestedModel": "openai/gpt-5.5", "upstreamModel": "gpt-5.5", "wire": "responses",
        "stream": true, "status": 200, "ok": true, "input": input, "output": output,
        "cacheRead": 0, "cacheWrite": 0, "latencyMs": 10, "error": null
    })
}

#[test]
fn stats_connection_merges_ledger_without_touching_scanned_rows() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).unwrap();
    let duplicate = insert_scan(&conn, "a", "s1", "2026-10-04 10:00:05", 200, 80);
    insert_scan(&conn, "b", "other", "2026-10-04 10:30:00", 5, 5);
    drop(conn);

    let plain = open_stats_connection(&db_path).unwrap();
    let before: (i64, i64) = plain
        .query_row(
            "SELECT COUNT(*), SUM(input_tokens + output_tokens) FROM token_logs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(before, (2, 290));
    drop(plain);

    write_ledger(
        &app,
        &[
            ledger_line("g1", Some("s1"), local_ts(10, 0, 10), 200, 80),
            ledger_line("g2", None, local_ts(11, 0, 0), 40, 2),
            json!({"not": "a ledger line"}),
        ],
    );
    let merged = open_stats_connection(&db_path).unwrap();
    let after: (i64, i64) = merged
        .query_row(
            "SELECT COUNT(*), SUM(input_tokens + output_tokens) FROM token_logs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(after, (3, 280 + 42 + 10));
    let hidden: i64 = merged
        .query_row(
            "SELECT COUNT(*) FROM token_logs WHERE id = ?1",
            params![duplicate],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        hidden, 0,
        "scanned duplicate is superseded in the merged view"
    );
    let raw: i64 = merged
        .query_row("SELECT COUNT(*) FROM main.token_logs", [], |row| row.get(0))
        .unwrap();
    assert_eq!(raw, 2, "scanned rows stay in the ledger database");
    let provider_id: i64 = merged
        .query_row(
            "SELECT id FROM token_logs WHERE input_tokens = 40",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        gateway_detail(&merged, provider_id),
        Some(GatewayDetail {
            source: "gateway".to_string(),
            provider: "openai".to_string(),
            latency_ms: Some(10),
            context: None,
        })
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn usage_details_mark_gateway_source_and_capability() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).unwrap();
    insert_scan(&conn, "a", "s9", "2026-10-04 09:00:00", 7, 3);
    drop(conn);
    let mut with_context = ledger_line("g1", Some("s1"), local_ts(10, 0, 10), 200, 80);
    with_context["context"] = json!({
        "systemBytes": 120, "toolsBytes": 900, "historyBytes": 300, "toolResultsBytes": 60,
        "attachmentsBytes": 0, "messages": 3, "toolResults": 1, "attachments": 0
    });
    write_ledger(&app, &[with_context]);

    let query: super::super::UsageDetailsQuery = serde_json::from_value(json!({
        "range": "today",
        "timezone": iana_time_zone::get_timezone().unwrap(),
    }))
    .unwrap();
    let details = super::super::get_usage_details_impl_at(&app, query, local_ts(12, 0, 0)).unwrap();
    assert_eq!(
        details["meta"]["capabilities"]["gatewayLedger"],
        json!(true)
    );
    let items = details["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["source"], json!("gateway"));
    assert_eq!(items[0]["provider"], json!("openai"));
    assert_eq!(items[0]["model"], json!("gpt-5.5"));
    assert_eq!(items[0]["latencyMs"], json!(10));
    assert_eq!(items[1]["source"], json!("scan"));
    assert!(items[1].get("provider").is_none());
    assert!(items[1].get("latencyMs").is_none());
    assert_eq!(items[0]["context"]["toolsBytes"], json!(900));
    assert_eq!(items[0]["context"]["toolResults"], json!(1));
    assert!(items[1].get("context").is_none());
    assert_eq!(details["filteredSummary"]["totalTokens"], json!(290));
    assert_eq!(details["filteredSummary"]["timedRequests"], json!(1));
    assert_eq!(details["filteredSummary"]["timedOutputTokens"], json!(80));
    assert_eq!(details["filteredSummary"]["timedLatencyMs"], json!(10));

    let scan_only: super::super::UsageDetailsQuery = serde_json::from_value(json!({
        "range": "today",
        "timezone": iana_time_zone::get_timezone().unwrap(),
        "models": ["openai/gpt-5.5"],
    }))
    .unwrap();
    let details =
        super::super::get_usage_details_impl_at(&app, scan_only, local_ts(12, 0, 0)).unwrap();
    assert!(details["filteredSummary"].get("timedRequests").is_none());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn permanent_stats_survive_diagnostic_rotation_and_revision_invalidates_cache() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let line = ledger_line("durable-first", None, local_ts(10, 0, 10), 10, 2);
    write_ledger(&app, &[line.clone()]);
    let first_signature = ledger_signature(&db_path).unwrap();
    assert_eq!(
        gateway_rows_cached(&db_path, &first_signature)
            .unwrap()
            .len(),
        1
    );
    fs::remove_file(gateway_dir(&db_path).join("usage-v1.jsonl")).unwrap();
    let mut second: LedgerRecord = serde_json::from_value(line).unwrap();
    second.request_id = "durable-second".into();
    second.input = 20;
    accounting::append(&gateway_dir(&db_path), &second).unwrap();
    let next_signature = ledger_signature(&db_path).unwrap();
    assert_ne!(first_signature, next_signature);
    let conn = open_stats_connection(&db_path).unwrap();
    let totals: (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*),SUM(input_tokens+output_tokens) FROM token_logs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(totals, (2, 34));
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn corrupt_permanent_accounting_returns_error_instead_of_pure_scan_fallback() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let dir = gateway_dir(&db_path);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(accounting::FILE), b"broken database").unwrap();
    assert_eq!(
        ledger_signature(&db_path).as_deref(),
        Some("accounting:unreadable")
    );
    assert!(open_stats_connection(&db_path).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn dangling_accounting_symlink_is_not_mistaken_for_an_absent_gateway() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let dir = gateway_dir(&db_path);
    fs::create_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(dir.join("missing.sqlite3"), dir.join(accounting::FILE)).unwrap();
    assert_eq!(
        ledger_signature(&db_path).as_deref(),
        Some("accounting:unreadable")
    );
    assert!(open_stats_connection(&db_path).is_err());
    fs::remove_dir_all(root).unwrap();
}

// Retains the pre-optimization contract algorithm as an independent oracle.
fn reference_superseded_scan_ids(
    gateway: &[GatewayRow],
    scans: &[ScanCandidate],
    window_secs: i64,
) -> BTreeSet<i64> {
    let window = chrono::Duration::seconds(window_secs);
    let mut superseded = BTreeSet::new();

    let mut spans: HashMap<(&str, &str), (NaiveDateTime, NaiveDateTime)> = HashMap::new();
    for row in gateway.iter().filter(|row| row.real_session) {
        let Some((start, end)) = span_of(row) else {
            continue;
        };
        spans
            .entry((row.tool.as_str(), row.session_id.as_str()))
            .and_modify(|(first, last)| {
                *first = (*first).min(start);
                *last = (*last).max(end);
            })
            .or_insert((start, end));
    }
    let mut anchored: BTreeSet<(&str, &str)> = BTreeSet::new();
    for scan in scans {
        let key = (scan.tool.as_str(), scan.session_id.as_str());
        let (Some((first, last)), Some(ts)) = (spans.get(&key), parse_storage(&scan.timestamp))
        else {
            continue;
        };
        if ts >= *first - window && ts <= *last + window {
            superseded.insert(scan.id);
            anchored.insert(key);
        }
    }

    let mut fallback: Vec<&GatewayRow> = gateway
        .iter()
        .filter(|row| {
            !row.real_session || !anchored.contains(&(row.tool.as_str(), row.session_id.as_str()))
        })
        .collect();
    fallback.sort_by(|a, b| {
        a.timestamp
            .cmp(&b.timestamp)
            .then_with(|| a.request_id.as_bytes().cmp(b.request_id.as_bytes()))
    });
    for row in fallback {
        let Some((start, end)) = span_of(row) else {
            continue;
        };
        let best = scans
            .iter()
            .filter(|scan| {
                !superseded.contains(&scan.id)
                    && scan.tool == row.tool
                    && scan.input_tokens == row.input_tokens
                    && scan.output_tokens == row.output_tokens
                    && scan.cached_tokens == row.cached_tokens
            })
            .filter_map(|scan| {
                let at = parse_storage(&scan.timestamp)?;
                let delta = if at < start {
                    (start - at).num_seconds()
                } else if at > end {
                    (at - end).num_seconds()
                } else {
                    0
                };
                (delta <= window_secs).then_some((delta, scan.id))
            })
            .min();
        if let Some((_, id)) = best {
            superseded.insert(id);
        }
    }
    superseded
}

#[test]
fn indexed_fallback_preserves_window_ties_and_one_to_one_matches() {
    let mut base = fixture_rows(&fixture())[0].clone();
    base.real_session = false;
    base.tool = "codex".into();
    base.timestamp = "2026-10-04 10:00:10".into();
    base.start_timestamp = "2026-10-04 10:00:08".into();
    base.input_tokens = 5;
    base.output_tokens = 2;
    base.cached_tokens = 1;
    let gateway: Vec<_> = (0..6)
        .rev()
        .map(|index| {
            let mut row = base.clone();
            row.request_id = format!("r{index}");
            row
        })
        .collect();
    let mut scans: Vec<_> = [(9, 7), (8, 11), (2, 9), (1, 8), (7, 15), (10, 3), (6, 2)]
        .into_iter()
        .map(|(id, second)| ScanCandidate {
            id,
            tool: "codex".into(),
            session_id: "root".into(),
            timestamp: format!("2026-10-04 10:00:{second:02}"),
            input_tokens: 5,
            output_tokens: 2,
            cached_tokens: 1,
        })
        .collect();
    let mut wrong_tool = scans[0].clone();
    wrong_tool.id = 3;
    wrong_tool.tool = "claude".into();
    scans.push(wrong_tool);
    let mut wrong_tokens = scans[0].clone();
    wrong_tokens.id = 4;
    wrong_tokens.cached_tokens = 2;
    scans.push(wrong_tokens);
    let mut invalid = scans[0].clone();
    invalid.id = 5;
    invalid.timestamp = "invalid".into();
    scans.push(invalid);
    assert_eq!(
        superseded_scan_ids(&gateway[3..], &scans, 5),
        BTreeSet::from([1, 2, 8])
    );
    assert_eq!(
        superseded_scan_ids(&gateway[2..], &scans, 5),
        BTreeSet::from([1, 2, 8, 9])
    );
    assert_eq!(
        superseded_scan_ids(&gateway[1..], &scans, 5),
        BTreeSet::from([1, 2, 7, 8, 9])
    );
    assert_eq!(
        superseded_scan_ids(&gateway, &scans, 5),
        BTreeSet::from([1, 2, 7, 8, 9, 10])
    );
}

#[test]
fn indexed_dedupe_matches_reference_across_mixed_sessions_and_fingerprints() {
    let fixture = fixture();
    let base_gateway = fixture_rows(&fixture)[0].clone();
    let base_scan = fixture_scans(&fixture)[0].clone();
    let mut seed = 17u64;
    let mut next = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        seed >> 32
    };
    let at = NaiveDateTime::parse_from_str("2026-10-04 12:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
    for round in 0..32 {
        let mut gateways = Vec::new();
        let mut scans = Vec::new();
        for index in 0..48 {
            let mut row = base_gateway.clone();
            row.request_id = format!("request-{round}-{index}");
            row.real_session = next() % 2 == 0;
            row.tool = format!("tool-{}", next() % 3);
            row.session_id = format!("session-{}", next() % 6);
            row.input_tokens = (next() % 3) as i64;
            row.output_tokens = (next() % 3) as i64;
            row.cached_tokens = (next() % 2) as i64;
            let end = at + chrono::Duration::seconds((next() % 120) as i64);
            // Includes clamped backward spans, long spans, and repeated seconds.
            let start = end - chrono::Duration::seconds((next() % 24) as i64 - 4);
            row.timestamp = end.format("%Y-%m-%d %H:%M:%S").to_string();
            row.start_timestamp = start.format("%Y-%m-%d %H:%M:%S").to_string();
            gateways.push(row);
            let mut scan = base_scan.clone();
            scan.id = index + 1;
            scan.tool = format!("tool-{}", next() % 3);
            scan.session_id = format!("session-{}", next() % 6);
            scan.input_tokens = (next() % 3) as i64;
            scan.output_tokens = (next() % 3) as i64;
            scan.cached_tokens = (next() % 2) as i64;
            scan.timestamp = (at + chrono::Duration::seconds((next() % 130) as i64 - 5))
                .format("%Y-%m-%d %H:%M:%S")
                .to_string();
            scans.push(scan);
        }
        assert_eq!(
            superseded_scan_ids(&gateways, &scans, 5),
            reference_superseded_scan_ids(&gateways, &scans, 5),
            "round {round}"
        );
        gateways.reverse();
        scans.reverse();
        assert_eq!(
            superseded_scan_ids(&gateways, &scans, 5),
            reference_superseded_scan_ids(&gateways, &scans, 5),
            "reversed round {round}"
        );
    }
}

#[test]
fn retained_shared_rows_remain_immutable_when_accounting_revision_changes() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    write_ledger(
        &app,
        &[ledger_line("shared-first", None, local_ts(10, 0, 0), 10, 2)],
    );
    let first_signature = ledger_signature(&db_path).unwrap();
    let first = gateway_rows_cached(&db_path, &first_signature).unwrap();
    let clone = Arc::clone(&first);
    assert!(Arc::ptr_eq(&first, &clone));
    let record: LedgerRecord = serde_json::from_value(ledger_line(
        "shared-second",
        None,
        local_ts(11, 0, 0),
        20,
        3,
    ))
    .unwrap();
    accounting::append(&gateway_dir(&db_path), &record).unwrap();
    let second = gateway_rows_cached(&db_path, &ledger_signature(&db_path).unwrap()).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].input_tokens, 10);
    assert_eq!(second.len(), 2);
    assert!(!Arc::ptr_eq(&first, &second));
    drop(first);
    drop(clone);
    drop(second);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn antigravity_cache_unknown_survives_temp_gateway_union() {
    let (app, root) = test_app();
    let conn = db::get_connection(&db::get_db_path(&app)).unwrap();
    conn.execute("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,session_id,unique_key,machine_id,usage_provenance,cache_write_known) VALUES('antigravity','selected',10,2,0,0,'2026-10-08 00:00:00','fixture','ag-overlay','fixture','reported',0)",[]).unwrap();
    install_overlay(&conn, &[]).unwrap();
    let row=conn.query_row("SELECT id,tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,session_id,cost_usd,machine_id,cache_write_known,usage_provenance FROM token_logs WHERE tool='antigravity'",[],super::super::map_stat_row).unwrap();
    assert_eq!(row.cache_write_known, Some(false));
    assert_eq!(row.usage_provenance.as_deref(), Some("reported"));
    assert!(!row.cache_split_is_proven());
    drop(conn);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn overview_splits_gateway_rows_by_provider_account() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).unwrap();
    insert_scan(&conn, "a", "s9", "2026-10-04 09:00:00", 7, 3);
    drop(conn);
    let mut second = ledger_line("g2", Some("s2"), local_ts(11, 0, 0), 30, 10);
    second["provider"] = json!("relay");
    write_ledger(
        &app,
        &[
            ledger_line("g1", Some("s1"), local_ts(10, 0, 10), 200, 80),
            second,
        ],
    );

    let query: super::super::LocalStatsQuery = serde_json::from_value(json!({
        "range": "today",
        "timezone": iana_time_zone::get_timezone().unwrap(),
    }))
    .unwrap();
    let stats = super::super::get_local_stats_v2_impl_at(&app, query, local_ts(12, 0, 0)).unwrap();
    let providers = stats["providers"].as_object().unwrap();
    assert_eq!(providers.len(), 2, "scan rows carry no account");
    assert_eq!(stats["providers"]["openai"]["total"], json!(280));
    assert_eq!(stats["providers"]["openai"]["requests"], json!(1));
    assert_eq!(stats["providers"]["relay"]["total"], json!(40));
    assert_eq!(stats["summary"]["totalRequests"], json!(3));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn account_split_matches_deduplicated_summary_in_a_non_default_time_zone() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).unwrap();
    // 被 g1 取代的扫描行不得计入任何账号，也不得重复进入汇总。
    insert_scan(&conn, "dup", "s1", "2026-10-04 10:00:05", 200, 80);
    insert_scan(&conn, "plain", "other", "2026-10-04 10:30:00", 5, 5);
    drop(conn);
    let mut relay = ledger_line("g2", Some("s2"), local_ts(11, 0, 0), 30, 10);
    relay["provider"] = json!("relay");
    write_ledger(
        &app,
        &[
            ledger_line("g1", Some("s1"), local_ts(10, 0, 10), 200, 80),
            relay,
        ],
    );

    let query: super::super::LocalStatsQuery = serde_json::from_value(json!({
        "range": "all",
        "timezone": "Pacific/Kiritimati",
    }))
    .unwrap();
    let stats = super::super::get_local_stats_v2_impl_at(&app, query, local_ts(12, 0, 0)).unwrap();
    let providers = stats["providers"].as_object().unwrap();
    let account_total: i64 = providers
        .values()
        .map(|p| p["total"].as_i64().unwrap())
        .sum();
    let account_requests: i64 = providers
        .values()
        .map(|p| p["requests"].as_i64().unwrap())
        .sum();
    assert_eq!((account_total, account_requests), (280 + 40, 2));
    // 汇总 = 各账号 + 没有账号的扫描行（只剩 plain 一条）。
    assert_eq!(stats["summary"]["totalTokens"], json!(account_total + 10));
    assert_eq!(
        stats["summary"]["totalRequests"],
        json!(account_requests + 1)
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn overview_sums_context_composition_of_gateway_rows_in_the_window() {
    let (app, root) = test_app();
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).unwrap();
    insert_scan(&conn, "a", "s9", "2026-10-04 09:00:00", 7, 3);
    drop(conn);
    let context = |system: u64, tools: u64| {
        json!({
            "systemBytes": system, "toolsBytes": tools, "historyBytes": 300, "toolResultsBytes": 60,
            "attachmentsBytes": 0, "messages": 3, "toolResults": 1, "attachments": 0
        })
    };
    let mut first = ledger_line("g1", Some("s1"), local_ts(10, 0, 10), 200, 80);
    first["context"] = context(100, 900);
    let mut second = ledger_line("g2", Some("s2"), local_ts(11, 0, 0), 50, 20);
    second["context"] = context(20, 100);
    // 没有构成的网关行不计入请求数与输入合计。
    let plain = ledger_line("g3", Some("s3"), local_ts(11, 30, 0), 30, 10);
    write_ledger(&app, &[first, second, plain]);

    let query: super::super::LocalStatsQuery = serde_json::from_value(json!({
        "range": "today",
        "timezone": iana_time_zone::get_timezone().unwrap(),
    }))
    .unwrap();
    let stats = super::super::get_local_stats_v2_impl_at(&app, query, local_ts(12, 0, 0)).unwrap();
    let composition = &stats["contextComposition"];
    assert_eq!(composition["requests"], json!(2));
    assert_eq!(composition["promptTokens"], json!(250));
    assert_eq!(composition["systemBytes"], json!(120));
    assert_eq!(composition["toolsBytes"], json!(1000));
    assert_eq!(composition["historyBytes"], json!(600));
    assert_eq!(composition["messages"], json!(6));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn overview_omits_context_composition_without_measured_rows() {
    let (app, root) = test_app();
    write_ledger(
        &app,
        &[ledger_line("g1", Some("s1"), local_ts(10, 0, 10), 200, 80)],
    );
    let query: super::super::LocalStatsQuery = serde_json::from_value(json!({
        "range": "today",
        "timezone": iana_time_zone::get_timezone().unwrap(),
    }))
    .unwrap();
    let stats = super::super::get_local_stats_v2_impl_at(&app, query, local_ts(12, 0, 0)).unwrap();
    assert!(stats.get("contextComposition").is_none());
    let _ = fs::remove_dir_all(root);
}
