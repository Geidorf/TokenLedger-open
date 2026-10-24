use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

// The ledger stores wall-clock time of the host `Local` zone, while every query
// names its own IANA zone. Each case therefore pins its instants in the selected
// zone and converts them to the host storage value, so the result is the same on
// any host. On Windows chrono's `Local` ignores `TZ`, which is why host-zone
// independence is shown by this construction plus explicit far-apart zones
// instead of re-running the suite under another `TZ`.
const SHANGHAI: &str = "Asia/Shanghai";
const LOS_ANGELES: &str = "America/Los_Angeles";

fn test_app(label: &str) -> AppContext {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_behavior_{label}_{}_{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    let app = AppContext::for_test(path);
    db::init_db(&db::get_db_path(&app)).expect("initialize test database");
    app
}

fn instant(timezone: &str, wall: &str) -> DateTime<Tz> {
    let naive = NaiveDateTime::parse_from_str(wall, "%Y-%m-%d %H:%M:%S")
        .expect("test wall time uses YYYY-MM-DD HH:MM:SS");
    timezone
        .parse::<Tz>()
        .expect("valid test timezone")
        .from_local_datetime(&naive)
        .single()
        .expect("unambiguous test wall time")
}

/// Wall-clock time in the selected zone -> ledger storage value (host `Local`).
fn stored_at(timezone: &str, wall: &str) -> String {
    storage_timestamp(storage_boundary(&instant(timezone, wall)))
}

/// Wall-clock time in the selected zone -> the `Local` "now" the command receives.
fn now_at(timezone: &str, wall: &str) -> DateTime<Local> {
    instant(timezone, wall).with_timezone(&Local)
}

/// Full ledger row; `cost: None` leaves `cost_usd` NULL so the price table
/// estimates it, exactly like rows a scanner has not priced yet.
struct LogRow<'a> {
    key: &'a str,
    tool: &'a str,
    model: &'a str,
    session: &'a str,
    timestamp: String,
    input: i64,
    output: i64,
    cached: i64,
    cache_write: i64,
    cost: Option<f64>,
}

fn insert_row(app: &AppContext, row: LogRow<'_>) {
    let conn = db::get_connection(&db::get_db_path(app)).expect("open test database");
    conn.execute(
        "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'machine', 0)",
        rusqlite::params![
            row.tool,
            row.model,
            row.input,
            row.output,
            row.cached,
            row.cache_write,
            row.timestamp,
            row.session,
            row.key,
            row.cost
        ],
    )
    .expect("insert test log");
}

#[allow(clippy::too_many_arguments)]
fn insert_log(
    app: &AppContext,
    key: &str,
    tool: &str,
    model: &str,
    session: &str,
    timestamp: &str,
    input: i64,
    output: i64,
) {
    insert_row(
        app,
        LogRow {
            key,
            tool,
            model,
            session,
            timestamp: timestamp.to_string(),
            input,
            output,
            cached: 0,
            cache_write: 0,
            cost: Some(0.0),
        },
    );
}

#[allow(clippy::too_many_arguments)]
fn insert_priced_log(
    app: &AppContext,
    key: &str,
    tool: &str,
    model: &str,
    session: &str,
    timestamp: &str,
    tokens: (i64, i64),
    cost: Option<f64>,
) {
    insert_row(
        app,
        LogRow {
            key,
            tool,
            model,
            session,
            timestamp: timestamp.to_string(),
            input: tokens.0,
            output: tokens.1,
            cached: 0,
            cache_write: 0,
            cost,
        },
    );
}

fn assert_usd(actual: &Value, expected: f64) {
    let actual = actual
        .as_f64()
        .unwrap_or_else(|| panic!("expected a USD number, got {actual}"));
    assert!(
        (actual - expected).abs() < 1e-9,
        "expected {expected}, got {actual}"
    );
}

fn session<'a>(result: &'a Value, tool: &str, id: &str) -> &'a Value {
    result["sessions"]
        .as_array()
        .expect("sessions array")
        .iter()
        .find(|session| session["tool"] == tool && session["id"] == id)
        .unwrap_or_else(|| panic!("missing session {tool}/{id}"))
}

fn query(start: &str, end: &str, timezone: &str) -> LocalStatsQuery {
    LocalStatsQuery {
        range: "custom".to_string(),
        timezone: timezone.to_string(),
        machines: None,
        machine: None,
        tools: None,
        tool: None,
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: Some(start.to_string()),
        end: Some(end.to_string()),
    }
}

/// Preset query carrying the synthetic rolling bounds older clients used to send;
/// presets must ignore them and resolve the calendar window on the backend.
fn preset_query(range: &str, timezone: &str) -> LocalStatsQuery {
    LocalStatsQuery {
        range: range.to_string(),
        ..query("2020-01-01", "2020-01-07", timezone)
    }
}

fn day_hours(result: &Value) -> Vec<(String, u64)> {
    result["dayHours"]
        .as_array()
        .expect("dayHours array")
        .iter()
        .map(|bucket| {
            (
                bucket["date"].as_str().unwrap().to_string(),
                bucket["hour"].as_u64().unwrap(),
            )
        })
        .collect()
}

fn session_ids(result: &Value) -> Vec<String> {
    let mut ids: Vec<_> = result["sessions"]
        .as_array()
        .expect("sessions array")
        .iter()
        .map(|session| session["id"].as_str().unwrap().to_string())
        .collect();
    ids.sort();
    ids
}

#[test]
fn custom_range_aggregates_full_multi_day_window_and_request_sizes() {
    let app = test_app("full");
    insert_log(
        &app,
        "a",
        "Codex",
        "gpt",
        "s1",
        &stored_at(SHANGHAI, "2026-09-01 23:30:00"),
        100,
        10,
    );
    insert_log(
        &app,
        "b",
        "Codex",
        "gpt",
        "s1",
        &stored_at(SHANGHAI, "2026-09-02 00:30:00"),
        200,
        20,
    );
    insert_log(
        &app,
        "c",
        "Claude",
        "sonnet",
        "s2",
        &stored_at(SHANGHAI, "2026-09-02 12:00:00"),
        300,
        30,
    );
    let result = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-01", "2026-09-02", SHANGHAI),
        now_at(SHANGHAI, "2026-09-03 12:00:00"),
    )
    .unwrap();
    assert_eq!(result["meta"]["recordCount"], 3);
    assert_eq!(result["meta"]["firstRecordAt"], "2026-09-01 23:30:00");
    assert_eq!(result["meta"]["lastRecordAt"], "2026-09-02 12:00:00");
    assert_eq!(result["summary"]["tokens"], 660);
    assert_eq!(result["summary"]["activeDays"], 2);
    assert_eq!(
        day_hours(&result),
        vec![
            ("2026-09-01".to_string(), 23),
            ("2026-09-02".to_string(), 0),
            ("2026-09-02".to_string(), 12),
        ]
    );
    assert_eq!(result["requestSizes"][0]["model"], "gpt");
    assert_eq!(result["requestSizes"][0]["requests"], 2);
    assert_eq!(result["requestSizes"][0]["p50"], 110);
    assert_eq!(result["requestSizes"][0]["p90"], 220);
}

#[test]
fn timezone_boundary_and_filters_use_same_selected_window() {
    // One zone east and one far west of UTC: the 23:30 row of the previous day
    // and the 00:30 row of the next day stay out, the 00:30 and 23:30 rows of
    // the selected day are in. No search filter hides the boundary rows.
    for timezone in [SHANGHAI, LOS_ANGELES] {
        let app = test_app("timezone");
        let at = |wall: &str| stored_at(timezone, wall);
        insert_log(
            &app,
            "before",
            "Codex",
            "gpt",
            "before",
            &at("2026-09-01 23:30:00"),
            1,
            1,
        );
        insert_log(
            &app,
            "early",
            "Codex",
            "gpt",
            "early",
            &at("2026-09-02 00:30:00"),
            10,
            5,
        );
        insert_log(
            &app,
            "late",
            "Codex",
            "gpt",
            "late",
            &at("2026-09-02 23:30:00"),
            20,
            5,
        );
        insert_log(
            &app,
            "after",
            "Codex",
            "gpt",
            "after",
            &at("2026-09-03 00:30:00"),
            1000,
            1,
        );
        insert_log(
            &app,
            "other",
            "Claude",
            "sonnet",
            "other",
            &at("2026-09-02 00:45:00"),
            100,
            5,
        );
        let mut filtered = query("2026-09-02", "2026-09-02", timezone);
        filtered.tools = Some(vec!["Codex".to_string()]);
        let result = get_local_behavior_analysis_impl_at(
            &app,
            filtered,
            now_at(timezone, "2026-09-04 12:00:00"),
        )
        .unwrap();
        assert_eq!(result["meta"]["timezone"], timezone);
        assert_eq!(result["meta"]["start"], "2026-09-02", "{timezone}");
        assert_eq!(result["meta"]["end"], "2026-09-02", "{timezone}");
        assert_eq!(result["summary"]["requests"], 2, "{timezone}");
        assert_eq!(result["summary"]["tokens"], 40, "{timezone}");
        assert_eq!(
            session_ids(&result),
            vec!["early".to_string(), "late".to_string()],
            "{timezone}"
        );
        assert_eq!(
            day_hours(&result),
            vec![
                ("2026-09-02".to_string(), 0),
                ("2026-09-02".to_string(), 23)
            ],
            "{timezone}"
        );
        assert_eq!(result["meta"]["firstRecordAt"], "2026-09-02 00:30:00");
        assert_eq!(result["meta"]["lastRecordAt"], "2026-09-02 23:30:00");
        assert_eq!(result["tools"].as_array().unwrap().len(), 1, "{timezone}");
    }
}

#[test]
fn same_instants_are_bucketed_in_the_selected_timezone() {
    let app = test_app("zones");
    // 2026-09-02 12:00 in Shanghai (UTC+8) is 2026-09-01 21:00 in Los Angeles (PDT, UTC-7).
    insert_log(
        &app,
        "noon",
        "Codex",
        "gpt",
        "noon",
        &stored_at(SHANGHAI, "2026-09-02 12:00:00"),
        10,
        0,
    );
    let shanghai = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-01", "2026-09-02", SHANGHAI),
        now_at(SHANGHAI, "2026-09-03 12:00:00"),
    )
    .unwrap();
    assert_eq!(day_hours(&shanghai), vec![("2026-09-02".to_string(), 12)]);
    assert_eq!(shanghai["meta"]["firstRecordAt"], "2026-09-02 12:00:00");

    let los_angeles = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-01", "2026-09-02", LOS_ANGELES),
        now_at(LOS_ANGELES, "2026-09-03 12:00:00"),
    )
    .unwrap();
    assert_eq!(
        day_hours(&los_angeles),
        vec![("2026-09-01".to_string(), 21)]
    );
    assert_eq!(los_angeles["meta"]["firstRecordAt"], "2026-09-01 21:00:00");

    let los_angeles_day = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-02", "2026-09-02", LOS_ANGELES),
        now_at(LOS_ANGELES, "2026-09-03 12:00:00"),
    )
    .unwrap();
    assert_eq!(los_angeles_day["summary"]["requests"], 0);
}

#[test]
fn presets_use_calendar_windows_and_ignore_request_bounds() {
    let app = test_app("presets");
    let at = |wall: &str| stored_at(LOS_ANGELES, wall);
    // 2026-09-24 is a Thursday; "now" is 12:00 in Los Angeles.
    for (key, wall) in [
        ("last-year", "2025-12-31 23:30:00"),
        ("last-month", "2026-08-31 23:30:00"),
        ("last-week", "2026-09-20 23:30:00"),
        ("monday", "2026-09-21 00:30:00"),
        ("today", "2026-09-24 10:00:00"),
        ("future", "2026-09-24 12:30:00"),
    ] {
        insert_log(&app, key, "Codex", "gpt", key, &at(wall), 1, 0);
    }
    let now = now_at(LOS_ANGELES, "2026-09-24 12:00:00");
    for (range, start, sessions) in [
        ("today", "2026-09-24", vec!["today"]),
        ("week", "2026-09-21", vec!["monday", "today"]),
        ("month", "2026-09-01", vec!["last-week", "monday", "today"]),
        (
            "year",
            "2026-01-01",
            vec!["last-month", "last-week", "monday", "today"],
        ),
        (
            "all",
            "2025-12-31",
            vec!["last-month", "last-week", "last-year", "monday", "today"],
        ),
    ] {
        let result =
            get_local_behavior_analysis_impl_at(&app, preset_query(range, LOS_ANGELES), now)
                .unwrap();
        assert_eq!(result["meta"]["range"], range);
        assert_eq!(result["meta"]["start"], start, "{range}");
        assert_eq!(result["meta"]["end"], "2026-09-24", "{range}");
        assert_eq!(session_ids(&result), sessions, "{range}");
        assert_eq!(result["meta"]["rangeTruncated"], false, "{range}");
        assert_eq!(result["meta"]["rangeDayLimit"], 731, "{range}");
    }
}

#[test]
fn all_range_is_capped_to_the_last_731_local_days() {
    let app = test_app("all_cap");
    let at = |wall: &str| stored_at(LOS_ANGELES, wall);
    let now = now_at(LOS_ANGELES, "2026-09-24 12:00:00");
    // 731 local calendar days including today start on 2024-09-24.
    assert_eq!(
        NaiveDate::from_ymd_opt(2026, 9, 24).unwrap() - Duration::days(MAX_CUSTOM_RANGE_DAYS - 1),
        NaiveDate::from_ymd_opt(2024, 9, 24).unwrap()
    );
    insert_log(
        &app,
        "october",
        "Codex",
        "gpt",
        "october",
        &at("2024-10-01 10:00:00"),
        10,
        0,
    );
    insert_log(
        &app,
        "today",
        "Codex",
        "gpt",
        "today",
        &at("2026-09-24 10:00:00"),
        20,
        0,
    );
    let within =
        get_local_behavior_analysis_impl_at(&app, preset_query("all", LOS_ANGELES), now).unwrap();
    assert_eq!(within["meta"]["rangeTruncated"], false);
    assert_eq!(within["meta"]["start"], "2024-10-01");
    assert_eq!(within["meta"]["recordCount"], 2);

    // One minute before the window: out of the aggregation, but it proves the
    // window is truncated. The flag honours the same filters as the window.
    insert_log(
        &app,
        "before-window",
        "Claude",
        "sonnet",
        "before-window",
        &at("2024-09-23 23:59:00"),
        1000,
        0,
    );
    let mut codex_only = preset_query("all", LOS_ANGELES);
    codex_only.tools = Some(vec!["Codex".to_string()]);
    let filtered = get_local_behavior_analysis_impl_at(&app, codex_only, now).unwrap();
    assert_eq!(filtered["meta"]["rangeTruncated"], false);
    assert_eq!(filtered["meta"]["start"], "2024-10-01");

    let capped =
        get_local_behavior_analysis_impl_at(&app, preset_query("all", LOS_ANGELES), now).unwrap();
    assert_eq!(capped["meta"]["rangeTruncated"], true);
    assert_eq!(capped["meta"]["start"], "2024-09-24");
    assert_eq!(capped["meta"]["end"], "2026-09-24");
    assert_eq!(capped["meta"]["recordCount"], 2);
    assert_eq!(capped["summary"]["tokens"], 30);

    // The first minute of the first window day is inside.
    insert_log(
        &app,
        "first-day",
        "Codex",
        "gpt",
        "first-day",
        &at("2024-09-24 00:00:00"),
        5,
        0,
    );
    let first_day =
        get_local_behavior_analysis_impl_at(&app, preset_query("all", LOS_ANGELES), now).unwrap();
    assert_eq!(first_day["meta"]["recordCount"], 3);
    assert_eq!(first_day["meta"]["firstRecordAt"], "2024-09-24 00:00:00");
    assert_eq!(first_day["meta"]["rangeTruncated"], true);
}

#[test]
fn sessions_are_ranked_and_truncated_after_full_scan() {
    let app = test_app("sessions");
    let timestamp = stored_at(SHANGHAI, "2026-09-01 10:00:00");
    for index in 0..205 {
        insert_log(
            &app,
            &format!("row-{index}"),
            "Codex",
            "gpt",
            &format!("session-{index}"),
            &timestamp,
            index + 1,
            0,
        );
    }
    let result = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-01", "2026-09-01", SHANGHAI),
        now_at(SHANGHAI, "2026-09-02 12:00:00"),
    )
    .unwrap();
    assert_eq!(result["meta"]["recordCount"], 205);
    assert_eq!(result["summary"]["sessionCount"], 205);
    assert_eq!(result["sessions"].as_array().unwrap().len(), 100);
    assert_eq!(result["meta"]["sessionsTruncated"], true);
    assert_eq!(result["sessions"][0]["id"], "session-204");
}

#[test]
fn same_session_id_from_different_tools_remains_separate() {
    let app = test_app("shared_session_id");
    insert_log(
        &app,
        "codex",
        "Codex",
        "gpt",
        "shared-session",
        &stored_at(SHANGHAI, "2026-09-01 10:00:00"),
        10,
        0,
    );
    insert_log(
        &app,
        "claude",
        "Claude",
        "sonnet",
        "shared-session",
        &stored_at(SHANGHAI, "2026-09-01 11:00:00"),
        20,
        0,
    );
    let result = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-01", "2026-09-01", SHANGHAI),
        now_at(SHANGHAI, "2026-09-02 12:00:00"),
    )
    .unwrap();
    assert_eq!(result["summary"]["sessionCount"], 2);
    assert_eq!(result["summary"]["unknownSessionRecords"], 0);
    assert!(result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["sessionCount"] == 1 && tool["unknownSessionRecords"] == 0));
    assert_eq!(result["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(result["sessions"][0]["tool"], "Claude");
    assert_eq!(result["sessions"][0]["id"], "shared-session");
    assert_eq!(result["sessions"][1]["tool"], "Codex");
    assert_eq!(result["sessions"][1]["id"], "shared-session");
}

#[test]
fn missing_session_ids_are_counted_as_unknown_records_not_sessions() {
    let app = test_app("unknown_session");
    let at = |wall: &str| stored_at(LOS_ANGELES, wall);
    insert_log(
        &app,
        "real",
        "Codex",
        "gpt",
        "real-session",
        &at("2026-09-01 09:00:00"),
        5,
        5,
    );
    // Scanner placeholder, empty and blank IDs from the same and another tool:
    // none of them may be merged into a single fake session.
    insert_log(
        &app,
        "placeholder",
        "Codex",
        "gpt",
        "unknown_session",
        &at("2026-09-01 10:00:00"),
        300,
        20,
    );
    insert_log(
        &app,
        "empty",
        "MiniMax",
        "minimax-m1",
        "",
        &at("2026-09-01 11:00:00"),
        400,
        30,
    );
    insert_log(
        &app,
        "blank",
        "MiniMax",
        "minimax-m1",
        "   ",
        &at("2026-09-01 12:00:00"),
        500,
        40,
    );
    let result = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-01", "2026-09-01", LOS_ANGELES),
        now_at(LOS_ANGELES, "2026-09-02 12:00:00"),
    )
    .unwrap();

    assert_eq!(result["meta"]["recordCount"], 4);
    assert_eq!(result["summary"]["tokens"], 1300);
    assert_eq!(result["summary"]["sessionCount"], 1);
    assert_eq!(result["summary"]["unknownSessionRecords"], 3);
    // Effective tokens only: 320 + 430 + 540; cache never joins the count.
    assert_eq!(result["summary"]["unknownSessionTokens"], 1290);
    let sessions = result["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], "real-session");
    assert!(sessions
        .iter()
        .all(|session| session["id"] != "unknown_session" && session["id"] != ""));
    let tools = result["tools"].as_array().unwrap();
    let tool = |id: &str| {
        tools
            .iter()
            .find(|tool| tool["id"] == id)
            .unwrap_or_else(|| panic!("missing tool {id}"))
    };
    // Records and tokens still belong to their tool; only the session count
    // ignores rows without a real session ID, and each tool says how many of its
    // records lack one, so a 0 session count is never shown as a known value.
    assert_eq!(tool("Codex")["sessionCount"], 1);
    assert_eq!(tool("Codex")["requests"], 2);
    assert_eq!(tool("Codex")["unknownSessionRecords"], 1);
    assert_eq!(tool("MiniMax")["sessionCount"], 0);
    assert_eq!(tool("MiniMax")["requests"], 2);
    assert_eq!(tool("MiniMax")["tokens"], 970);
    assert_eq!(tool("MiniMax")["unknownSessionRecords"], 2);
}

#[test]
fn sessions_report_cost_time_span_and_top_model() {
    let app = test_app("session_metadata");
    let at = |wall: &str| stored_at(LOS_ANGELES, wall);
    // Codex s1: gpt-5.5 has 250 tokens over two records, gpt-5.5-mini 300 in one.
    insert_priced_log(
        &app,
        "r1",
        "Codex",
        "gpt-5.5",
        "s1",
        &at("2026-09-01 08:00:00"),
        (60, 40),
        Some(0.10),
    );
    insert_priced_log(
        &app,
        "r2",
        "Codex",
        "gpt-5.5-mini",
        "s1",
        &at("2026-09-01 09:30:00"),
        (200, 100),
        Some(0.02),
    );
    insert_priced_log(
        &app,
        "r3",
        "Codex",
        "gpt-5.5",
        "s1",
        &at("2026-09-01 11:15:00"),
        (100, 50),
        Some(0.15),
    );
    // Claude s2: equal tokens, "b" wins on records.
    insert_priced_log(
        &app,
        "r4",
        "Claude",
        "b",
        "s2",
        &at("2026-09-01 10:00:00"),
        (50, 0),
        Some(0.01),
    );
    insert_priced_log(
        &app,
        "r5",
        "Claude",
        "b",
        "s2",
        &at("2026-09-01 10:05:00"),
        (50, 0),
        Some(0.01),
    );
    insert_priced_log(
        &app,
        "r6",
        "Claude",
        "a",
        "s2",
        &at("2026-09-01 10:10:00"),
        (100, 0),
        Some(0.05),
    );
    // Claude s3: a full tie falls back to the model name; a real zero cost stays 0.
    insert_priced_log(
        &app,
        "r7",
        "Claude",
        "z",
        "s3",
        &at("2026-09-01 12:00:00"),
        (10, 0),
        Some(0.0),
    );
    insert_priced_log(
        &app,
        "r8",
        "Claude",
        "y",
        "s3",
        &at("2026-09-01 12:01:00"),
        (10, 0),
        Some(0.0),
    );
    // No session ID: costed in the summary, never a session.
    insert_priced_log(
        &app,
        "r9",
        "Codex",
        "gpt-5.5",
        "unknown_session",
        &at("2026-09-01 13:00:00"),
        (1000, 0),
        Some(1.0),
    );
    let result = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-01", "2026-09-01", LOS_ANGELES),
        now_at(LOS_ANGELES, "2026-09-02 12:00:00"),
    )
    .unwrap();

    let s1 = session(&result, "Codex", "s1");
    assert_eq!(s1["tokens"], 550);
    assert_eq!(s1["requests"], 3);
    assert_usd(&s1["cost"], 0.27);
    assert_eq!(s1["firstAt"], "2026-09-01 08:00:00");
    assert_eq!(s1["lastAt"], "2026-09-01 11:15:00");
    assert_eq!(s1["topModel"], "gpt-5.5-mini");

    let s2 = session(&result, "Claude", "s2");
    assert_usd(&s2["cost"], 0.07);
    assert_eq!(s2["firstAt"], "2026-09-01 10:00:00");
    assert_eq!(s2["lastAt"], "2026-09-01 10:10:00");
    assert_eq!(s2["topModel"], "b");

    let s3 = session(&result, "Claude", "s3");
    assert_usd(&s3["cost"], 0.0);
    assert_eq!(s3["topModel"], "y");

    assert_eq!(result["summary"]["sessionCount"], 3);
    assert_eq!(result["summary"]["costComplete"], true);
    assert_usd(&result["summary"]["totalCost"], 1.34);
}

#[test]
fn total_cost_matches_the_local_stats_v2_summary() {
    let app = test_app("cost_parity");
    let at = |wall: &str| stored_at(SHANGHAI, wall);
    // Unpriced rows (cost_usd NULL) are estimated from the same price table,
    // including cache reads/writes; stored costs are used as they are.
    for row in [
        LogRow {
            key: "estimated-cache",
            tool: "Codex",
            model: "gpt-5.5",
            session: "s1",
            timestamp: at("2026-09-01 09:00:00"),
            input: 1_000_000,
            output: 200_000,
            cached: 500_000,
            cache_write: 100_000,
            cost: None,
        },
        LogRow {
            key: "stored",
            tool: "Claude",
            model: "claude-sonnet-4-6",
            session: "s2",
            timestamp: at("2026-09-01 10:00:00"),
            input: 5_000,
            output: 1_000,
            cached: 0,
            cache_write: 0,
            cost: Some(0.42),
        },
        LogRow {
            key: "fallback-price",
            tool: "Codex",
            model: "mystery-model-x",
            session: "s1",
            timestamp: at("2026-09-02 11:00:00"),
            input: 10_000,
            output: 1_000,
            cached: 0,
            cache_write: 0,
            cost: None,
        },
        LogRow {
            key: "no-session",
            tool: "MiniMax",
            model: "minimax-m1",
            session: "",
            timestamp: at("2026-09-02 12:00:00"),
            input: 3_000,
            output: 300,
            cached: 0,
            cache_write: 0,
            cost: None,
        },
    ] {
        insert_row(&app, row);
    }
    let now = now_at(SHANGHAI, "2026-09-03 12:00:00");
    let behavior =
        get_local_behavior_analysis_impl_at(&app, query("2026-09-01", "2026-09-02", SHANGHAI), now)
            .unwrap();
    let stats =
        get_local_stats_v2_impl_at(&app, query("2026-09-01", "2026-09-02", SHANGHAI), now).unwrap();

    let dashboard_total = stats["summary"]["totalCost"].as_f64().unwrap();
    assert!(dashboard_total > 0.42);
    assert_eq!(behavior["summary"]["costComplete"], true);
    assert_usd(&behavior["summary"]["totalCost"], dashboard_total);
    assert_usd(&session(&behavior, "Claude", "s2")["cost"], 0.42);
    let session_costs: f64 = behavior["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|session| session["cost"].as_f64().unwrap())
        .sum();
    assert!(session_costs > 0.42 && session_costs < dashboard_total);
}

#[test]
fn unusable_costs_are_unavailable_not_zero() {
    let app = test_app("cost_unavailable");
    let at = |wall: &str| stored_at(SHANGHAI, wall);
    insert_priced_log(
        &app,
        "valid",
        "Codex",
        "gpt-5.5",
        "priced",
        &at("2026-09-01 09:00:00"),
        (100, 10),
        Some(0.5),
    );
    // Stored values that cannot be a price: the session and the total become
    // unavailable instead of silently summing only the known part.
    insert_priced_log(
        &app,
        "negative",
        "Codex",
        "gpt-5.5",
        "broken",
        &at("2026-09-01 10:00:00"),
        (100, 10),
        Some(-1.0),
    );
    insert_priced_log(
        &app,
        "infinite",
        "Codex",
        "gpt-5.5",
        "broken",
        &at("2026-09-01 11:00:00"),
        (100, 10),
        Some(f64::INFINITY),
    );
    let result = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-01", "2026-09-01", SHANGHAI),
        now_at(SHANGHAI, "2026-09-02 12:00:00"),
    )
    .unwrap();
    assert_usd(&session(&result, "Codex", "priced")["cost"], 0.5);
    assert!(session(&result, "Codex", "broken")["cost"].is_null());
    assert!(result["summary"]["totalCost"].is_null());
    assert_eq!(result["summary"]["costComplete"], false);
    // Tokens are unaffected by an unavailable cost.
    assert_eq!(result["summary"]["tokens"], 330);
}

#[test]
fn request_size_bins_stay_bounded_without_collapsing_real_values() {
    let bins = build_request_size_bins(&[100, 1200, 15_000, 420_000]);
    assert!(bins.len() <= 32);
    assert!(bins.len() > 1);
    let requests: u64 = bins
        .iter()
        .map(|bin| bin["requests"].as_u64().unwrap())
        .sum();
    assert_eq!(requests, 4);
    assert!(bins[0]["requests"].as_u64().unwrap() > 0);
    assert!(bins.last().unwrap()["requests"].as_u64().unwrap() > 0);
    // Exact shape shared with the browser-preview mock: 421 one-thousand buckets
    // are widened to 14K so 31 bins remain, first bin starts at 0.
    assert_eq!(bins.len(), 31);
    assert_eq!(
        bins[0],
        json!({ "lower": 0, "upper": 14_000, "requests": 2 })
    );
    assert_eq!(
        bins[1],
        json!({ "lower": 14_000, "upper": 28_000, "requests": 1 })
    );
    assert_eq!(
        bins[30],
        json!({ "lower": 420_000, "upper": 434_000, "requests": 1 })
    );
    assert_eq!(
        build_request_size_bins(&[0, 999, 1000]),
        vec![
            json!({ "lower": 0, "upper": 1000, "requests": 2 }),
            json!({ "lower": 1000, "upper": 2000, "requests": 1 }),
        ]
    );
}

#[test]
fn request_sizes_default_to_the_model_with_most_records() {
    let app = test_app("request_size_order");
    let at = |wall: &str| stored_at(SHANGHAI, wall);
    // Alphabetically first but rare, the busiest model, and a tie broken by name.
    insert_log(
        &app,
        "rare",
        "Codex",
        "aaa-rare",
        "s1",
        &at("2026-09-01 08:00:00"),
        900_000,
        0,
    );
    for index in 0..3 {
        insert_log(
            &app,
            &format!("main-{index}"),
            "Claude",
            "zzz-main",
            "s2",
            &at("2026-09-01 09:00:00"),
            100,
            index,
        );
    }
    for (key, model) in [
        ("tie-b-1", "mid-b"),
        ("tie-b-2", "mid-b"),
        ("tie-a-1", "mid-a"),
        ("tie-a-2", "mid-a"),
    ] {
        insert_log(
            &app,
            key,
            "Codex",
            model,
            "s3",
            &at("2026-09-01 10:00:00"),
            10,
            0,
        );
    }
    let result = get_local_behavior_analysis_impl_at(
        &app,
        query("2026-09-01", "2026-09-01", SHANGHAI),
        now_at(SHANGHAI, "2026-09-02 12:00:00"),
    )
    .unwrap();
    let order: Vec<_> = result["requestSizes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["model"].as_str().unwrap().to_string(),
                entry["requests"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        order,
        vec![
            ("zzz-main".to_string(), 3),
            ("mid-a".to_string(), 2),
            ("mid-b".to_string(), 2),
            ("aaa-rare".to_string(), 1),
        ]
    );
}

/// In-memory ledger row for pricing checks that need no SQLite.
fn stat_row(
    tool: &str,
    model: &str,
    tokens: (i64, i64),
    cache: (i64, i64),
    cost: Option<f64>,
) -> StatRow {
    StatRow {
        pricing_timestamp: None,
        id: 0,
        tool: tool.to_string(),
        model: model.to_string(),
        input_tokens: tokens.0,
        output_tokens: tokens.1,
        // `cached_tokens` holds reads + writes; `cache_write_tokens` the write share.
        cached_tokens: cache.0 + cache.1,
        cache_write_tokens: cache.1,
        cache_write_known: None,
        usage_provenance: None,
        timestamp: "2026-09-01 09:00:00".to_string(),
        session_id: "session".to_string(),
        cost_usd: cost,
        machine_id: "machine".to_string(),
    }
}

/// The uncached per-row price Stats v2 adds (`SummaryAccumulator::add_row`),
/// with the behavior rule that an unusable value is unavailable.
fn uncached_row_cost(row: &StatRow, prices: &Value) -> Option<f64> {
    let cost = row.cost_usd.unwrap_or_else(|| {
        estimate_cost(
            prices,
            &row.tool,
            &row.model,
            row.input_tokens,
            row.output_tokens,
            row.cache_read_tokens(),
            row.cache_write_tokens,
        )
    });
    (cost.is_finite() && cost >= 0.0).then_some(cost)
}

#[test]
fn cached_prices_match_per_row_estimates_bit_for_bit() {
    // A small table that reaches every lookup path, next to the bundled table.
    let controlled = json!({
        "gpt-5.5": { "input": 1.25, "output": 10.0, "cache_input": 0.125 },
        "gpt-5.5-mini": { "input": 0.25, "output": 2.0 },
        "claude-sonnet-4-6": { "input": 3.0, "output": 15.0, "cache_input": 0.3, "cache_write": 3.75 },
        "claude-unknown": { "input": 3.3, "output": 16.5 },
        "codex-agent": { "input": 1.5, "output": 6.0 },
        "default": { "input": 0.7, "output": 2.1 }
    });
    let matched = |tool: &str, model: &str| lookup_model_prices(&controlled, tool, model);
    // Exact key, snapshot suffix, provider path, tool fallback and `default`.
    assert_eq!(matched("Codex", "gpt-5.5"), &controlled["gpt-5.5"]);
    assert_eq!(
        matched("Codex", "gpt-5.5-2026-01-15"),
        &controlled["gpt-5.5"]
    );
    assert_eq!(
        matched("Codex", "openai/gpt-5.5-mini"),
        &controlled["gpt-5.5-mini"]
    );
    assert_eq!(
        matched("Claude", "claude-next"),
        &controlled["claude-unknown"]
    );
    assert_eq!(matched("Kimi", "mystery"), &controlled["default"]);
    // The same unmatched model name falls back per tool, so the cache key must
    // keep the tool: keyed by model alone, one of these would reuse the other's price.
    assert_eq!(matched("Codex", "mystery"), &controlled["codex-agent"]);
    // Without `default` the lookup yields null and the built-in 1.0/3.0 applies.
    let without_default = json!({ "gpt-5.5": { "input": 1.25, "output": 10.0 } });
    assert!(lookup_model_prices(&without_default, "Kimi", "mystery").is_null());
    let bundled = default_prices();

    let pairs = [
        ("Codex", "gpt-5.5"),
        ("Codex", "gpt-5.5-2026-01-15"),
        ("Codex", "openai/gpt-5.5-mini"),
        ("Claude", "claude-sonnet-4-6"),
        ("Claude", "claude-next"),
        ("Kimi", "mystery"),
        ("Codex", "mystery"),
        ("MiniMax", "minimax-m2.7"),
    ];
    // Every pair recurs with other volumes, so most rows are priced from the
    // cache; cache reads/writes and stored costs are mixed in.
    let mut rows = Vec::new();
    for round in 0..4_i64 {
        for (index, (tool, model)) in pairs.iter().enumerate() {
            let index = index as i64;
            rows.push(stat_row(
                tool,
                model,
                (1_000 * (round + 1) + 37 * index, 250 * round + 11 * index),
                (400 * index, 90 * round),
                None,
            ));
        }
        rows.push(stat_row(
            "Codex",
            "gpt-5.5",
            (100, 10),
            (0, 0),
            Some(0.42 + round as f64),
        ));
    }

    for prices in [&controlled, &without_default, &bundled] {
        let mut pricer = BehaviorPricer::new(prices);
        let mut cached_total = Some(0.0);
        let mut uncached_total = Some(0.0);
        for row in &rows {
            let cached = pricer.row_cost(row);
            let uncached = uncached_row_cost(row, prices);
            assert!(cached.is_some(), "{} / {} is priced", row.tool, row.model);
            assert_eq!(
                cached.map(f64::to_bits),
                uncached.map(f64::to_bits),
                "{} / {}",
                row.tool,
                row.model
            );
            add_behavior_cost(&mut cached_total, cached);
            add_behavior_cost(&mut uncached_total, uncached);
        }
        assert_eq!(
            cached_total.map(f64::to_bits),
            uncached_total.map(f64::to_bits)
        );
        // One price lookup per distinct unpriced (tool, model), not one per row.
        assert_eq!(pricer.matched.len(), pairs.len());
    }

    // A corrupt stored cost stays unavailable on the cached path as well.
    let corrupt = stat_row("Codex", "gpt-5.5", (100, 10), (0, 0), Some(-1.0));
    assert_eq!(BehaviorPricer::new(&controlled).row_cost(&corrupt), None);
}

/// Manual timing check for the per-aggregation price cache (T10.151 review F1).
/// It asserts only that every path agrees on the total, so it cannot flake:
/// `BEHAVIOR_BENCH_ROWS=200000 cargo test --manifest-path src-tauri/Cargo.toml
/// --lib behavior_pricing_benchmark -- --ignored --nocapture` (add `--release`
/// for representative absolute numbers).
#[test]
#[ignore = "timing benchmark; run on demand with --ignored --nocapture"]
fn behavior_pricing_benchmark() {
    let row_count = std::env::var("BEHAVIOR_BENCH_ROWS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(200_000);
    let prices = default_prices();
    // Like a real ledger: scanners leave `cost_usd` NULL for Claude and Codex,
    // and some models only reach a snapshot key, the tool fallback or `default`.
    let pairs = [
        ("Claude", "claude-sonnet-4-6"),
        ("Claude", "claude-opus-4-7"),
        ("Claude", "claude-haiku-4-5-20251001"),
        ("Codex", "gpt-5.5"),
        ("Codex", "gpt-5.3-codex"),
        ("Codex", "gpt-5.5-codex-preview"),
        ("Gemini", "gemini-3.5-flash"),
        ("Kimi", "kimi-k2.6"),
        ("MiniMax", "minimax-m2.7"),
        ("OpenCode", "provider/unlisted-model"),
    ];
    let rows: Vec<StatRow> = (0..row_count)
        .map(|index| {
            let (tool, model) = pairs[index % pairs.len()];
            let volume = (index % 997) as i64;
            StatRow {
                pricing_timestamp: None,
                id: index as i64,
                timestamp: format!(
                    "2026-09-{:02} {:02}:{:02}:00",
                    1 + index % 28,
                    index % 24,
                    index % 60
                ),
                session_id: format!("session-{}", index % 4_000),
                ..stat_row(
                    tool,
                    model,
                    (1_000 + volume * 40, 200 + volume * 7),
                    (volume * 90, volume * 3),
                    None,
                )
            }
        })
        .collect();

    let started = std::time::Instant::now();
    let mut uncached = Some(0.0);
    for row in &rows {
        add_behavior_cost(&mut uncached, uncached_row_cost(row, &prices));
    }
    let uncached_elapsed = started.elapsed();

    let started = std::time::Instant::now();
    let mut pricer = BehaviorPricer::new(&prices);
    let mut cached = Some(0.0);
    for row in &rows {
        add_behavior_cost(&mut cached, pricer.row_cost(row));
    }
    let cached_elapsed = started.elapsed();
    assert_eq!(cached.map(f64::to_bits), uncached.map(f64::to_bits));

    let query =
        NormalizedStatsQuery::from_query(query("2026-09-01", "2026-09-28", SHANGHAI)).unwrap();
    let now = instant(SHANGHAI, "2026-09-29 12:00:00");
    let bounds = query_bounds(query.range, now).unwrap();
    let window = BehaviorWindow {
        start: bounds.current_start,
        truncated: false,
    };
    let started = std::time::Instant::now();
    let result = build_local_behavior_analysis(
        rows,
        &query,
        &bounds,
        &window,
        &prices,
        now,
        &BehaviorProjectScope::Off("disabled"),
    )
    .unwrap();
    let aggregate_elapsed = started.elapsed();
    assert_eq!(
        result["summary"]["totalCost"].as_f64().map(f64::to_bits),
        cached.map(f64::to_bits)
    );
    println!(
        "behavior pricing, {row_count} rows: per-row lookup {uncached_elapsed:?}, \
         cached {cached_elapsed:?}, whole aggregation with the cache {aggregate_elapsed:?}"
    );
}

/// Behavior contract v1.2 project fields (T10.182); shares the fixtures above.
#[path = "behavior_project_tests.rs"]
mod project_dimension;
