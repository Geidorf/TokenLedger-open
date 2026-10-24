use super::*;
use crate::stats_query::{literal_search_matches, MAX_FILTER_BYTES, MAX_FILTER_ITEMS};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration as StdDuration;

static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn test_app(label: &str) -> (AppContext, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_t12_{}_{}_{}",
        label,
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    let app = AppContext::for_test(path.clone());
    let db_path = db::get_db_path(&app);
    db::init_db(&db_path).expect("initialize test database");
    (app, path)
}

fn local_now(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Local> {
    Local
        .with_ymd_and_hms(year, month, day, hour, minute, 0)
        .single()
        .expect("test wall-clock time must exist in the host timezone")
}

fn local_timezone() -> String {
    iana_time_zone::get_timezone().expect("test host must expose its IANA timezone")
}

fn zoned_now(
    timezone: &str,
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
) -> DateTime<Tz> {
    timezone
        .parse::<Tz>()
        .expect("valid test timezone")
        .with_ymd_and_hms(year, month, day, hour, minute, 0)
        .single()
        .expect("unambiguous test instant")
}

fn comparison_query(range: &str, timezone: &str) -> NormalizedStatsQuery {
    NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: range.to_string(),
        timezone: timezone.to_string(),
        machines: None,
        machine: None,
        tools: None,
        tool: None,
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .expect("normalize comparison query")
}

fn comparison_row(id: i64, timestamp: &str, tokens: i64) -> StatRow {
    StatRow {
        pricing_timestamp: None,
        id,
        tool: "codex".to_string(),
        model: "gpt".to_string(),
        input_tokens: tokens,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_write_known: None,
        usage_provenance: None,
        timestamp: timestamp.to_string(),
        session_id: format!("dst-{id}"),
        cost_usd: Some(0.0),
        machine_id: "mac".to_string(),
    }
}

fn series_buckets(series: &[Value]) -> Vec<String> {
    series
        .iter()
        .map(|bucket| bucket["bucket"].as_str().unwrap().to_string())
        .collect()
}

fn series_tokens(series: &[Value]) -> Vec<i64> {
    series
        .iter()
        .map(|bucket| bucket["tokens"].as_i64().unwrap())
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn insert_log(
    conn: &Connection,
    key: &str,
    tool: &str,
    model: &str,
    machine: &str,
    timestamp: &str,
    input: i64,
    output: i64,
) -> i64 {
    conn.execute(
        "INSERT INTO token_logs
            (tool, model, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, timestamp, session_id, unique_key,
             cost_usd, machine_id, sync_status)
         VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?6, ?7, 0.0, ?8, 0)",
        params![tool, model, input, output, timestamp, key, key, machine],
    )
    .expect("insert test log");
    conn.last_insert_rowid()
}

fn stats_query(
    range: &str,
    machine: Option<&str>,
    tool: Option<&str>,
    model: Option<&str>,
) -> LocalStatsQuery {
    LocalStatsQuery {
        range: range.to_string(),
        timezone: local_timezone(),
        machines: None,
        machine: machine.map(str::to_string),
        tools: None,
        tool: tool.map(str::to_string),
        models: None,
        model: model.map(str::to_string),
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    }
}

fn details_query(
    range: &str,
    machine: Option<&str>,
    tool: Option<&str>,
    model: Option<&str>,
    cursor: Option<String>,
    limit: usize,
) -> UsageDetailsQuery {
    UsageDetailsQuery {
        scope: None,
        range: range.to_string(),
        timezone: local_timezone(),
        machines: None,
        machine: machine.map(str::to_string),
        tools: None,
        tool: tool.map(str::to_string),
        models: None,
        model: model.map(str::to_string),
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
        cursor,
        limit: Some(limit),
        providers: None,
    }
}

#[test]
fn shared_query_fixtures_drive_canonical_normalization_and_literal_search() {
    let multi: Value = serde_json::from_str(include_str!(
        "../../../fixtures/dashboard-stats-v2/multi-filter-search-query-v2.json"
    ))
    .expect("multi-filter fixture must parse");
    let normalized = NormalizedStatsQuery::from_query(
        serde_json::from_value(multi["input"].clone()).expect("fixture input must deserialize"),
    )
    .expect("fixture input must normalize");
    assert_eq!(normalized.request_json(), multi["normalized"]);

    for case in multi["searchCases"]
        .as_array()
        .expect("search cases must be an array")
    {
        let query = case["query"].as_str().expect("search query string");
        let matching_ids = case["candidates"]
            .as_array()
            .expect("candidate array")
            .iter()
            .filter(|candidate| {
                literal_search_matches(
                    query,
                    [
                        candidate["tool"].as_str().unwrap(),
                        candidate["model"].as_str().unwrap(),
                        candidate["machineId"].as_str().unwrap(),
                        candidate["sessionId"].as_str().unwrap(),
                    ],
                )
            })
            .map(|candidate| candidate["id"].clone())
            .collect::<Vec<_>>();
        assert_eq!(Value::Array(matching_ids), case["matchingIds"]);
    }

    for case in multi["invalidCases"]
        .as_array()
        .expect("invalid cases must be an array")
    {
        let raw: LocalStatsQuery = serde_json::from_value(case["input"].clone())
            .expect("invalid input still deserializes");
        let error = NormalizedStatsQuery::from_query(raw).expect_err("case must be rejected");
        assert!(
            error.contains(case["expectedError"].as_str().unwrap()),
            "unexpected normalization error: {error}"
        );
    }

    let preserved = NormalizedStatsQuery::from_query(
        serde_json::from_value(multi["preservedWhitespaceCase"]["input"].clone())
            .expect("preserved whitespace input"),
    )
    .expect("non-ASCII whitespace must be preserved");
    assert_eq!(
        preserved.request_json(),
        multi["preservedWhitespaceCase"]["normalized"]
    );

    let canonical = NormalizedStatsQuery::from_query(
        serde_json::from_value(multi["normalized"].clone()).expect("canonical fixture query"),
    )
    .unwrap();
    let canonical_key = cache::CacheKey::for_query(
        "local",
        canonical.range.as_str(),
        &canonical.fingerprint(None),
    );
    let permuted_key = cache::CacheKey::for_query(
        "local",
        normalized.range.as_str(),
        &normalized.fingerprint(None),
    );
    assert_eq!(
        canonical_key, permuted_key,
        "permutations and duplicates must share a canonical cache key"
    );
    let mut changed_search = canonical.clone();
    changed_search.search = Some("Session_43%".to_string());
    let changed_key = cache::CacheKey::for_query(
        "local",
        changed_search.range.as_str(),
        &changed_search.fingerprint(None),
    );
    assert_ne!(
        canonical_key, changed_key,
        "search must isolate cache entries"
    );

    let mut entity_input = multi["entityRequest"]["query"]
        .as_object()
        .expect("entity query object")
        .clone();
    entity_input.insert(
        "entity".to_string(),
        multi["entityRequest"]["entity"].clone(),
    );
    let entity = normalize_entity_query(
        &serde_json::from_value(Value::Object(entity_input)).expect("entity fixture input"),
    )
    .expect("entity fixture must normalize");
    assert_eq!(
        entity_json(&entity.entity),
        multi["entityRequest"]["entity"]
    );
    assert_eq!(entity.query.request_json(), multi["entityRequest"]["query"]);

    let legacy: Value = serde_json::from_str(include_str!(
        "../../../fixtures/dashboard-stats-v2/legacy-single-query-v2.json"
    ))
    .expect("legacy query fixture must parse");
    for case in legacy["cases"].as_array().expect("legacy cases array") {
        let raw: LocalStatsQuery =
            serde_json::from_value(case["input"].clone()).expect("legacy input must deserialize");
        if case["outcome"] == json!("reject") {
            assert!(NormalizedStatsQuery::from_query(raw).is_err());
        } else {
            let query = NormalizedStatsQuery::from_query(raw).expect("legacy input normalizes");
            assert_eq!(query.request_json(), case["normalized"]);
        }
    }

    let mut too_many: LocalStatsQuery =
        serde_json::from_value(multi["normalized"].clone()).unwrap();
    too_many.machines = Some(
        (0..=MAX_FILTER_ITEMS)
            .map(|index| format!("m{index}"))
            .collect(),
    );
    assert!(NormalizedStatsQuery::from_query(too_many)
        .unwrap_err()
        .contains("too-many-items"));

    let mut over_budget: LocalStatsQuery =
        serde_json::from_value(multi["normalized"].clone()).unwrap();
    over_budget.models = Some(vec!["é".repeat(129)]);
    assert!(NormalizedStatsQuery::from_query(over_budget)
        .unwrap_err()
        .contains("item-too-long"));

    let mut exact_budget: LocalStatsQuery =
        serde_json::from_value(multi["normalized"].clone()).unwrap();
    exact_budget.models = Some(vec!["é".repeat(128)]);
    assert_eq!(
        NormalizedStatsQuery::from_query(exact_budget)
            .unwrap()
            .models[0]
            .len(),
        MAX_FILTER_BYTES
    );

    let mut search_over_budget: LocalStatsQuery =
        serde_json::from_value(multi["normalized"].clone()).unwrap();
    search_over_budget.search = Some("界".repeat(86));
    assert!(NormalizedStatsQuery::from_query(search_over_budget)
        .unwrap_err()
        .contains("search-too-long"));
}

#[test]
fn local_cache_split_is_omitted_when_any_cached_row_lacks_provenance() {
    let (app, app_dir) = test_app("cache_split_fail_closed");
    let db_path = db::get_db_path(&app);
    let conn = Connection::open(&db_path).expect("open test database");
    conn.execute_batch(
        "INSERT INTO token_logs
            (tool, model, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, timestamp, session_id, unique_key,
             cost_usd, machine_id, sync_status)
         VALUES
            ('codex', 'gpt-unknown', 10, 2, 120, 0,
             '2026-07-15 09:00:00', 'unknown', 'unknown', 0.0, 'mac', 0),
            ('codex', 'gpt-proven', 8, 2, 100, 20,
             '2026-07-15 10:00:00', 'proven', 'proven', 0.0, 'mac', 0),
            ('claude', 'zero-cache', 4, 1, 0, 0,
             '2026-07-15 11:00:00', 'zero', 'zero', 0.0, 'windows', 0);",
    )
    .expect("insert cache provenance fixtures");
    drop(conn);

    let now = local_now(2026, 7, 15, 12, 0);
    let stats = get_local_stats_v2_impl_at(&app, stats_query("all", None, None, None), now)
        .expect("load local stats");
    assert_eq!(stats["summary"]["cachedTokens"], json!(220));
    assert!(stats["summary"].get("cacheReadTokens").is_none());
    assert!(stats["summary"].get("cacheWriteTokens").is_none());
    assert!(stats["summary"].get("cacheSavedUsd").is_none());
    assert!(stats["tools"]["codex"].get("cacheRead").is_none());
    assert!(stats["tools"]["codex"].get("cacheWrite").is_none());
    assert_eq!(stats["tools"]["claude"]["cacheRead"], json!(0));
    assert_eq!(stats["tools"]["claude"]["cacheWrite"], json!(0));
    // 模型级缓存读写拆分与工具同口径：缺 provenance 的模型剥离 cacheRead/cacheWrite，
    // 已证明的模型输出读（cached - write）与写拆分。
    assert!(stats["models"]["gpt-unknown"].get("cacheRead").is_none());
    assert!(stats["models"]["gpt-unknown"].get("cacheWrite").is_none());
    assert_eq!(stats["models"]["gpt-proven"]["cacheRead"], json!(80));
    assert_eq!(stats["models"]["gpt-proven"]["cacheWrite"], json!(20));
    assert_eq!(stats["models"]["zero-cache"]["cacheRead"], json!(0));
    assert_eq!(stats["models"]["zero-cache"]["cacheWrite"], json!(0));

    let machine_distribution = stats["machineDistribution"].as_array().unwrap();
    let mac = machine_distribution
        .iter()
        .find(|item| item["value"] == "mac")
        .expect("mac distribution");
    let windows = machine_distribution
        .iter()
        .find(|item| item["value"] == "windows")
        .expect("windows distribution");
    assert!(mac.get("cacheWriteTokens").is_none());
    assert_eq!(windows["cacheWriteTokens"], json!(0));

    let history = stats["history"].as_array().unwrap();
    let unknown = history
        .iter()
        .find(|item| item["sessionId"] == "unknown")
        .expect("unknown cache row");
    let proven = history
        .iter()
        .find(|item| item["sessionId"] == "proven")
        .expect("proven cache row");
    let zero = history
        .iter()
        .find(|item| item["sessionId"] == "zero")
        .expect("zero cache row");
    assert!(unknown.get("cacheReadTokens").is_none());
    assert!(unknown.get("cacheWriteTokens").is_none());
    assert_eq!(proven["cacheReadTokens"], json!(80));
    assert_eq!(proven["cacheWriteTokens"], json!(20));
    assert_eq!(zero["cacheReadTokens"], json!(0));
    assert_eq!(zero["cacheWriteTokens"], json!(0));

    let details = get_usage_details_impl_at(
        &app,
        details_query("all", None, None, None, None, 10),
        local_now(2026, 7, 15, 12, 0),
    )
    .expect("load local detail");
    assert!(details["filteredSummary"].get("cacheReadTokens").is_none());
    assert!(details["filteredSummary"].get("cacheWriteTokens").is_none());
    let detail_items = details["items"].as_array().unwrap();
    let unknown_detail = detail_items
        .iter()
        .find(|item| item["sessionId"] == "unknown")
        .expect("unknown detail row");
    let proven_detail = detail_items
        .iter()
        .find(|item| item["sessionId"] == "proven")
        .expect("proven detail row");
    assert!(unknown_detail.get("cacheReadTokens").is_none());
    assert!(unknown_detail.get("cacheWriteTokens").is_none());
    assert_eq!(proven_detail["cacheReadTokens"], json!(80));
    assert_eq!(proven_detail["cacheWriteTokens"], json!(20));

    let proven_only = get_usage_details_impl_at(
        &app,
        details_query("all", None, Some("codex"), Some("gpt-proven"), None, 10),
        local_now(2026, 7, 15, 12, 0),
    )
    .expect("load proven split only");
    assert_eq!(proven_only["filteredSummary"]["cacheReadTokens"], json!(80));
    assert_eq!(
        proven_only["filteredSummary"]["cacheWriteTokens"],
        json!(20)
    );

    let _ = fs::remove_dir_all(app_dir);
}

#[test]
fn multi_filters_search_cursor_and_entity_share_one_local_query() {
    let (app, app_dir) = test_app("canonical_query_chain");
    let db_path = db::get_db_path(&app);
    let conn = Connection::open(&db_path).expect("open test database");
    insert_log(
        &conn,
        "literal-mac",
        "codex",
        "gpt-5",
        "mac",
        "2026-07-15 09:00:00",
        8,
        2,
    );
    conn.execute(
        "UPDATE token_logs SET session_id = 'prefix-session_42%-suffix' WHERE unique_key = 'literal-mac'",
        [],
    )
    .unwrap();
    insert_log(
        &conn,
        "literal-windows",
        "claude",
        "gpt-5",
        "windows",
        "2026-07-15 10:00:00",
        15,
        5,
    );
    conn.execute(
        "UPDATE token_logs SET session_id = 'PREFIX-SESSION_42%-SUFFIX' WHERE unique_key = 'literal-windows'",
        [],
    )
    .unwrap();
    insert_log(
        &conn,
        "wrong-tool",
        "gemini",
        "gpt-5",
        "mac",
        "2026-07-15 11:00:00",
        100,
        0,
    );
    insert_log(
        &conn,
        "wrong-model",
        "codex",
        "other-model",
        "mac",
        "2026-07-15 11:10:00",
        100,
        0,
    );
    insert_log(
        &conn,
        "wildcard-miss",
        "codex",
        "gpt-5",
        "mac",
        "2026-07-15 11:20:00",
        100,
        0,
    );
    insert_log(
        &conn,
        "outside-machine",
        "codex",
        "gpt-5",
        "linux",
        "2026-07-15 11:30:00",
        100,
        0,
    );
    conn.execute(
        "UPDATE token_logs SET session_id = 'prefix-sessionX42-anything' WHERE unique_key = 'wildcard-miss'",
        [],
    )
    .unwrap();
    for key in ["wrong-tool", "wrong-model", "outside-machine"] {
        conn.execute(
            "UPDATE token_logs SET session_id = 'session_42%' WHERE unique_key = ?1",
            [key],
        )
        .unwrap();
    }
    drop(conn);

    let stats_query = LocalStatsQuery {
        range: "all".to_string(),
        timezone: "UTC".to_string(),
        machines: Some(vec!["windows".into(), "mac".into(), "mac".into()]),
        machine: None,
        tools: Some(vec!["codex".into(), "claude".into()]),
        tool: None,
        models: Some(vec!["gpt-5".into()]),
        model: None,
        search: Some(" Session_42% ".to_string()),
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    };
    let now = local_now(2026, 7, 15, 12, 0);
    let stats =
        get_local_stats_v2_impl_at(&app, stats_query, now).expect("canonical dashboard query");
    assert_eq!(stats["summary"]["totalTokens"], json!(30));
    assert_eq!(stats["summary"]["totalRequests"], json!(2));
    assert_eq!(
        stats["meta"]["query"]["machines"],
        json!(["mac", "windows"])
    );
    assert_eq!(stats["meta"]["query"]["tools"], json!(["claude", "codex"]));
    assert!(stats["meta"]["query"].get("machine").is_none());
    assert!(stats["meta"]["query"].get("tool").is_none());
    assert_eq!(stats["meta"]["query"]["model"], json!("gpt-5"));
    assert_eq!(
        stats["machineDistribution"],
        json!([
            {
                "value": "windows",
                "tokens": 20,
                "inputTokens": 15,
                "outputTokens": 5,
                "cachedTokens": 0,
                "cacheWriteTokens": 0,
                "requests": 1,
                "cost": 0.0
            },
            {
                "value": "mac",
                "tokens": 10,
                "inputTokens": 8,
                "outputTokens": 2,
                "cachedTokens": 0,
                "cacheWriteTokens": 0,
                "requests": 1,
                "cost": 0.0
            }
        ])
    );

    let detail_query = UsageDetailsQuery {
        scope: Some("local".to_string()),
        range: "all".to_string(),
        timezone: "UTC".to_string(),
        machines: Some(vec!["windows".into(), "mac".into()]),
        machine: None,
        tools: Some(vec!["codex".into(), "claude".into()]),
        tool: None,
        models: Some(vec!["gpt-5".into()]),
        model: None,
        search: Some("Session_42%".to_string()),
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
        cursor: None,
        limit: Some(1),
        providers: None,
    };
    let first = get_usage_details_impl_at(&app, detail_query.clone(), now)
        .expect("first canonical detail page");
    assert_eq!(first["filteredSummary"]["totalTokens"], json!(30));
    assert_eq!(first["totalCount"], json!(2));
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["hasMore"], json!(true));
    let model_facets = first["availableFilters"]["models"].as_array().unwrap();
    assert!(model_facets
        .iter()
        .any(|facet| facet["value"] == "other-model" && facet["count"] == 1));
    let tool_facets = first["availableFilters"]["tools"].as_array().unwrap();
    assert!(tool_facets
        .iter()
        .any(|facet| facet["value"] == "gemini" && facet["count"] == 1));
    let machine_facets = first["availableFilters"]["machines"].as_array().unwrap();
    assert!(machine_facets
        .iter()
        .any(|facet| facet["value"] == "linux" && facet["count"] == 1));

    let cursor = first["nextCursor"].as_str().unwrap().to_string();
    let mut second_query = detail_query.clone();
    second_query.cursor = Some(cursor.clone());
    let second =
        get_usage_details_impl_at(&app, second_query, now).expect("second query-bound detail page");
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);

    let mut changed_query = detail_query;
    changed_query.cursor = Some(cursor);
    changed_query.search = Some("different".to_string());
    let cursor_error = get_usage_details_impl_at(&app, changed_query, now)
        .expect_err("cursor must not cross canonical queries");
    assert!(cursor_error.contains("fingerprint"));

    let entity = get_local_entity_dashboard_impl_at(
        &app,
        EntityDashboardQuery {
            scope: Some("local".to_string()),
            entity: Some(EntitySelectorInput {
                kind: "model".to_string(),
                id: " gpt-5 ".to_string(),
            }),
            range: "all".to_string(),
            timezone: "UTC".to_string(),
            machines: Some(vec!["windows".into(), "mac".into()]),
            machine: None,
            tools: Some(vec!["codex".into(), "claude".into()]),
            tool: None,
            models: Some(vec![]),
            model: None,
            search: Some("Session_42%".to_string()),
            token_mode: Some("effective".to_string()),
            start: None,
            end: None,
        },
        now,
    )
    .expect("entity dashboard must use the same canonical query");
    assert_eq!(entity["summary"]["totalTokens"], json!(30));
    assert_eq!(entity["historyPage"]["totalCount"], json!(2));
    assert_eq!(
        entity["meta"]["entity"],
        json!({ "kind": "model", "id": "gpt-5" })
    );
    assert_eq!(entity["meta"]["query"]["tools"], json!(["claude", "codex"]));

    let _ = fs::remove_dir_all(app_dir);
}

#[test]
fn comparison_uses_aligned_filters_and_tool_models_use_current_period() {
    let (app, app_dir) = test_app("comparison_filters");
    let db_path = db::get_db_path(&app);
    let conn = Connection::open(&db_path).expect("open test database");
    insert_log(
        &conn,
        "previous",
        "codex",
        "old-model",
        "mac",
        "2026-07-14 11:00:00",
        40,
        10,
    );
    insert_log(
        &conn,
        "previous-after-cutoff",
        "codex",
        "late-model",
        "mac",
        "2026-07-14 13:00:00",
        900,
        100,
    );
    insert_log(
        &conn,
        "current",
        "codex",
        "current-model",
        "mac",
        "2026-07-15 11:00:00",
        80,
        20,
    );
    insert_log(
        &conn,
        "other-machine",
        "codex",
        "other-model",
        "windows",
        "2026-07-15 11:00:00",
        800,
        200,
    );
    insert_log(
        &conn,
        "other-tool",
        "claude",
        "claude-model",
        "mac",
        "2026-07-15 11:00:00",
        800,
        200,
    );
    drop(conn);

    let stats = get_local_stats_v2_impl_at(
        &app,
        stats_query("today", Some("mac"), Some("codex"), None),
        local_now(2026, 7, 15, 12, 30),
    )
    .expect("load local v2 stats");

    assert_eq!(stats["summary"]["totalTokens"], json!(100));
    assert_eq!(
        stats["comparison"]["current"]["summary"]["totalTokens"],
        json!(100)
    );
    assert_eq!(
        stats["comparison"]["previous"]["summary"]["totalTokens"],
        json!(50)
    );
    assert_eq!(
        stats["comparison"]["delta"]["tokens"]["percent"],
        json!(100.0)
    );
    assert_eq!(
        stats["tools"]["codex"]["models"],
        json!({ "current-model": 100 })
    );
    assert_eq!(stats["meta"]["query"]["machine"], json!("mac"));
    assert_eq!(stats["meta"]["query"]["tool"], json!("codex"));

    let _ = fs::remove_dir_all(app_dir);
}

#[test]
fn month_alignment_clamps_to_shorter_previous_month_and_rolls_year() {
    let march = query_bounds(
        StatsRange::Month,
        zoned_now("Asia/Shanghai", 2026, 3, 31, 18, 45),
    )
    .expect("March bounds");
    let comparison = march.comparison.expect("month comparison");
    assert_eq!(
        comparison.current_end.naive_local(),
        NaiveDate::from_ymd_opt(2026, 3, 28)
            .unwrap()
            .and_hms_opt(18, 45, 0)
            .unwrap()
    );
    assert_eq!(
        comparison.previous_end.naive_local(),
        NaiveDate::from_ymd_opt(2026, 2, 28)
            .unwrap()
            .and_hms_opt(18, 45, 0)
            .unwrap()
    );

    let january = query_bounds(
        StatsRange::Month,
        zoned_now("Asia/Shanghai", 2026, 1, 15, 9, 30),
    )
    .expect("January bounds");
    assert_eq!(
        january.comparison.unwrap().previous_start.naive_local(),
        NaiveDate::from_ymd_opt(2025, 12, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    );
}

#[test]
fn calendar_alignment_keeps_wall_clock_across_dst_transition_dates() {
    // 2026-03-08 02:30 is inside New York's spring-forward gap. Both the
    // internal query boundary and the reported window advance to 03:00 EDT.
    let bounds = query_bounds(
        StatsRange::Today,
        zoned_now("America/New_York", 2026, 3, 9, 2, 30),
    )
    .expect("DST bounds");
    let previous_end = bounds.comparison.unwrap().previous_end;
    assert_eq!(
        previous_end.naive_local(),
        NaiveDate::from_ymd_opt(2026, 3, 8)
            .unwrap()
            .and_hms_opt(3, 0, 0)
            .unwrap()
    );
    assert!(previous_end.to_rfc3339().ends_with("-04:00"));
}

#[test]
fn day_over_day_spring_gap_keeps_equal_wall_clock_buckets() {
    // On the day after spring-forward, 02:30 exists in the current period but
    // not in the previous one. The resolved instant advances to 03:00 EDT for
    // storage bounds, while the comparison remains aligned through the same
    // three wall-clock buckets: 00, 01 and the empty 02 gap.
    let query = comparison_query("today", "America/New_York");
    let bounds = query_bounds(
        query.range,
        zoned_now("America/New_York", 2026, 3, 9, 2, 30),
    )
    .expect("spring-forward bounds");
    let window = bounds.comparison.expect("day comparison");
    let comparison = build_comparison(
        &[
            comparison_row(1, "2026-03-08 01:15:00", 10),
            comparison_row(2, "2026-03-09 01:15:00", 20),
            comparison_row(3, "2026-03-09 02:15:00", 30),
        ],
        &window,
        &query,
        &json!({}),
    );
    let current = comparison["current"]["series"].as_array().unwrap();
    let previous = comparison["previous"]["series"].as_array().unwrap();

    assert_eq!(current.len(), previous.len());
    assert_eq!(series_buckets(current), ["00:00", "01:00", "02:00"]);
    assert_eq!(series_buckets(previous), ["00:00", "01:00", "02:00"]);
    assert_eq!(series_tokens(current), [0, 20, 30]);
    assert_eq!(series_tokens(previous), [0, 10, 0]);
    assert_eq!(comparison["window"]["alignedThrough"], "2026-03-09 02:30");
    assert!(comparison["window"]["previousEnd"]
        .as_str()
        .unwrap()
        .ends_with("2026-03-08T03:00:00-04:00"));
}

#[test]
fn day_over_day_fall_fold_collapses_repeated_hour_into_one_aligned_bucket() {
    let timezone = "America/New_York".parse::<Tz>().unwrap();
    let repeated = NaiveDate::from_ymd_opt(2026, 11, 1)
        .unwrap()
        .and_hms_opt(1, 30, 0)
        .unwrap();
    let now = resolve_wall_time(timezone, repeated, BoundarySide::End).unwrap();
    let query = comparison_query("today", timezone.name());
    let window = query_bounds(query.range, now)
        .expect("fall-back bounds")
        .comparison
        .expect("day comparison");
    let comparison = build_comparison(
        &[
            comparison_row(1, "2026-10-31 00:45:00", 5),
            comparison_row(2, "2026-10-31 01:15:00", 10),
            // Legacy local rows cannot retain the fold offset, so both
            // occurrences deterministically share the 01 wall-clock bucket.
            comparison_row(3, "2026-11-01 01:10:00", 20),
            comparison_row(4, "2026-11-01 01:10:00", 30),
        ],
        &window,
        &query,
        &json!({}),
    );
    let current = comparison["current"]["series"].as_array().unwrap();
    let previous = comparison["previous"]["series"].as_array().unwrap();

    assert_eq!(current.len(), previous.len());
    assert_eq!(series_buckets(current), ["00:00", "01:00"]);
    assert_eq!(series_buckets(previous), ["00:00", "01:00"]);
    assert_eq!(series_tokens(current), [0, 50]);
    assert_eq!(series_tokens(previous), [5, 10]);
    assert!(comparison["window"]["currentEnd"]
        .as_str()
        .unwrap()
        .ends_with("-05:00"));
}

#[test]
fn dst_fold_chooses_start_and_end_offsets_deterministically() {
    let timezone = "America/New_York".parse::<Tz>().unwrap();
    let repeated = NaiveDate::from_ymd_opt(2026, 11, 1)
        .unwrap()
        .and_hms_opt(1, 30, 0)
        .unwrap();
    let start = resolve_wall_time(timezone, repeated, BoundarySide::Start).unwrap();
    let end = resolve_wall_time(timezone, repeated, BoundarySide::End).unwrap();

    assert!(start.to_rfc3339().ends_with("-04:00"));
    assert!(end.to_rfc3339().ends_with("-05:00"));
    assert_eq!((end - start).num_hours(), 1);
}

#[test]
fn the_same_instant_produces_distinct_cross_timezone_windows() {
    let instant = Utc
        .with_ymd_and_hms(2026, 7, 15, 2, 30, 0)
        .single()
        .unwrap();
    let shanghai = query_bounds(
        StatsRange::Today,
        instant.with_timezone(&"Asia/Shanghai".parse::<Tz>().unwrap()),
    )
    .unwrap();
    let new_york = query_bounds(
        StatsRange::Today,
        instant.with_timezone(&"America/New_York".parse::<Tz>().unwrap()),
    )
    .unwrap();

    assert_eq!(
        shanghai.current_end.format("%Y-%m-%d %H:%M").to_string(),
        "2026-07-15 10:30"
    );
    assert_eq!(
        new_york.current_end.format("%Y-%m-%d %H:%M").to_string(),
        "2026-07-14 22:30"
    );
    assert_ne!(
        shanghai.current_start.unwrap().to_rfc3339(),
        new_york.current_start.unwrap().to_rfc3339()
    );
}

#[test]
fn requested_iana_timezone_drives_sql_window_series_and_meta() {
    let (app, app_dir) = test_app("cross_timezone_query");
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).expect("open test database");
    let row_instant = Utc
        .with_ymd_and_hms(2026, 7, 14, 10, 0, 0)
        .single()
        .unwrap();
    let storage_time = row_instant
        .with_timezone(&Local)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    insert_log(
        &conn,
        "cross-zone-row",
        "codex",
        "gpt",
        "mac",
        &storage_time,
        8,
        2,
    );
    drop(conn);

    let now = Utc
        .with_ymd_and_hms(2026, 7, 15, 2, 30, 0)
        .single()
        .unwrap()
        .with_timezone(&Local);
    let query = |timezone: &str| LocalStatsQuery {
        range: "today".to_string(),
        timezone: timezone.to_string(),
        machines: None,
        machine: Some("mac".to_string()),
        tools: None,
        tool: Some("codex".to_string()),
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    };
    let new_york =
        get_local_stats_v2_impl_at(&app, query("America/New_York"), now).expect("New York stats");
    let shanghai =
        get_local_stats_v2_impl_at(&app, query("Asia/Shanghai"), now).expect("Shanghai stats");

    assert_eq!(new_york["summary"]["totalTokens"], json!(10));
    assert_eq!(shanghai["summary"]["totalTokens"], json!(0));
    assert_eq!(new_york["meta"]["timezone"], json!("America/New_York"));
    assert_eq!(
        new_york["comparison"]["window"]["timezone"],
        new_york["meta"]["timezone"]
    );
    assert!(new_york["meta"]["generatedAt"]
        .as_str()
        .unwrap()
        .ends_with("-04:00"));
    assert_eq!(
        new_york["comparison"]["current"]["series"][6]["tokens"],
        json!(10)
    );

    let _ = fs::remove_dir_all(app_dir);
}

#[test]
fn unsupported_token_mode_and_invalid_timezone_are_rejected() {
    let mut query = stats_query("today", None, None, None);
    query.token_mode = Some("total".to_string());
    let error = NormalizedStatsQuery::from_query(query).unwrap_err();
    assert!(error.contains("tokenMode 'total' is not supported"));

    let mut query = stats_query("today", None, None, None);
    query.timezone = "Mars/Olympus_Mons".to_string();
    let error = NormalizedStatsQuery::from_query(query).unwrap_err();
    assert!(error.contains("invalid IANA timezone"));
}

#[test]
fn year_and_all_do_not_emit_an_automatic_comparison() {
    let now = zoned_now("Asia/Shanghai", 2026, 7, 15, 12, 0);
    assert!(query_bounds(StatsRange::Year, now)
        .unwrap()
        .comparison
        .is_none());
    assert!(query_bounds(StatsRange::All, now)
        .unwrap()
        .comparison
        .is_none());
}

#[test]
fn week_alignment_starts_on_monday_and_zero_baseline_is_new_not_infinite() {
    let now = zoned_now("Asia/Shanghai", 2026, 1, 1, 9, 15);
    let comparison = query_bounds(StatsRange::Week, now)
        .unwrap()
        .comparison
        .expect("week comparison");
    assert_eq!(
        comparison.current_start.naive_local(),
        NaiveDate::from_ymd_opt(2025, 12, 29)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    );
    assert_eq!(
        comparison.previous_start.naive_local(),
        NaiveDate::from_ymd_opt(2025, 12, 22)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
    );

    let delta = delta_value(12.0, 0.0, true);
    assert_eq!(delta["direction"], json!("new"));
    assert!(delta["percent"].is_null());
    assert_eq!(delta_value(0.0, 0.0, true)["direction"], json!("flat"));
}

#[test]
fn detail_keyset_is_stable_for_equal_timestamps_and_concurrent_new_rows() {
    let (app, app_dir) = test_app("detail_cursor");
    let db_path = db::get_db_path(&app);
    let conn = Connection::open(&db_path).expect("open test database");
    let id1 = insert_log(
        &conn,
        "one",
        "codex",
        "gpt",
        "mac",
        "2026-07-15 10:00:00",
        1,
        0,
    );
    let id2 = insert_log(
        &conn,
        "two",
        "codex",
        "gpt",
        "mac",
        "2026-07-15 10:00:00",
        2,
        0,
    );
    let id3 = insert_log(
        &conn,
        "three",
        "codex",
        "gpt",
        "mac",
        "2026-07-15 11:00:00",
        3,
        0,
    );
    let id4 = insert_log(
        &conn,
        "four",
        "codex",
        "gpt",
        "mac",
        "2026-07-15 11:00:00",
        4,
        0,
    );
    drop(conn);

    let now = local_now(2026, 7, 15, 12, 0);
    let first = get_usage_details_impl_at(
        &app,
        details_query("today", Some("mac"), Some("codex"), Some("gpt"), None, 2),
        now,
    )
    .expect("first detail page");
    assert_eq!(first["hasMore"], json!(true));
    assert_eq!(first["granularity"], json!("request"));
    assert_eq!(first["items"][0]["id"], json!(id4));
    assert_eq!(first["items"][1]["id"], json!(id3));
    let cursor = first["nextCursor"]
        .as_str()
        .expect("next cursor")
        .to_string();

    let conn = Connection::open(&db_path).expect("reopen test database");
    insert_log(
        &conn,
        "newer-after-page-one",
        "codex",
        "gpt",
        "mac",
        "2026-07-15 11:30:00",
        5,
        0,
    );
    drop(conn);

    let second = get_usage_details_impl_at(
        &app,
        details_query(
            "today",
            Some("mac"),
            Some("codex"),
            Some("gpt"),
            Some(cursor),
            2,
        ),
        now,
    )
    .expect("second detail page");
    assert_eq!(second["items"][0]["id"], json!(id2));
    assert_eq!(second["items"][1]["id"], json!(id1));
    assert_eq!(second["hasMore"], json!(false));
    assert!(second["nextCursor"].is_null());

    let _ = fs::remove_dir_all(app_dir);
}

#[test]
fn wal_detail_snapshot_allows_a_concurrent_writer_to_commit() {
    let (app, app_dir) = test_app("detail_wal_concurrency");
    let db_path = db::get_db_path(&app);
    let conn = db::get_connection(&db_path).expect("open test database");
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("read journal mode");
    let busy_timeout_ms: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .expect("read busy timeout");
    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    assert!(busy_timeout_ms >= 5_000);
    insert_log(
        &conn,
        "snapshot-before",
        "codex",
        "gpt",
        "mac",
        "2026-07-15 09:00:00",
        1,
        1,
    );
    drop(conn);

    let query = NormalizedStatsQuery::from_query(stats_query(
        "today",
        Some("mac"),
        Some("codex"),
        Some("gpt"),
    ))
    .expect("normalize stats query");
    let now = local_now(2026, 7, 15, 12, 0).with_timezone(&query.tz);
    let bounds = query_bounds(query.range, now).expect("query bounds");
    let prices = load_prices(&app);
    let mut read_conn = db::get_connection(&db_path).expect("open read connection");
    let transaction = read_conn.transaction().expect("start read transaction");
    let before = query_filtered_summary(&transaction, &query, &bounds, &prices)
        .expect("establish read snapshot");
    assert_eq!(before.requests, 1);

    let writer_path = db_path.clone();
    let (sender, receiver) = mpsc::channel();
    let writer = thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let conn = db::get_connection(&writer_path).map_err(|error| error.to_string())?;
            conn.execute(
                "INSERT INTO token_logs
                    (tool, model, input_tokens, output_tokens, cached_tokens,
                     cache_write_tokens, timestamp, session_id, unique_key,
                     cost_usd, machine_id, sync_status)
                 VALUES ('codex', 'gpt', 2, 2, 0, 0,
                         '2026-07-15 10:00:00', 'snapshot-during',
                         'snapshot-during', 0.0, 'mac', 0)",
                [],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })();
        let _ = sender.send(result);
    });

    let write_result = match receiver.recv_timeout(StdDuration::from_secs(3)) {
        Ok(result) => result,
        Err(error) => {
            drop(transaction);
            let _ = writer.join();
            panic!("concurrent writer did not finish while read snapshot was open: {error}");
        }
    };
    write_result.expect("concurrent writer commits under WAL");
    let during = query_filtered_summary(&transaction, &query, &bounds, &prices)
        .expect("repeat snapshot read");
    assert_eq!(during.requests, 1, "read transaction keeps one snapshot");
    transaction.commit().expect("commit read transaction");
    writer.join().expect("join writer");

    let after = get_usage_details_impl_at(
        &app,
        details_query("today", Some("mac"), Some("codex"), Some("gpt"), None, 10),
        local_now(2026, 7, 15, 12, 0),
    )
    .expect("read committed rows");
    assert_eq!(after["totalCount"], json!(2));

    let _ = fs::remove_dir_all(app_dir);
}

#[test]
fn detail_combines_range_tool_model_and_machine_filters() {
    let (app, app_dir) = test_app("detail_filters");
    let db_path = db::get_db_path(&app);
    let conn = Connection::open(&db_path).expect("open test database");
    let matching_id = insert_log(
        &conn,
        "matching",
        "codex",
        "gpt-5",
        "mac",
        "2026-07-15 09:00:00",
        10,
        2,
    );
    insert_log(
        &conn,
        "old",
        "codex",
        "gpt-5",
        "mac",
        "2026-07-14 09:00:00",
        10,
        2,
    );
    insert_log(
        &conn,
        "wrong-tool",
        "claude",
        "gpt-5",
        "mac",
        "2026-07-15 09:00:00",
        10,
        2,
    );
    insert_log(
        &conn,
        "wrong-model",
        "codex",
        "gpt-4",
        "mac",
        "2026-07-15 09:00:00",
        10,
        2,
    );
    insert_log(
        &conn,
        "wrong-machine",
        "codex",
        "gpt-5",
        "windows",
        "2026-07-15 09:00:00",
        10,
        2,
    );
    drop(conn);

    let result = get_usage_details_impl_at(
        &app,
        details_query("today", Some("mac"), Some("codex"), Some("gpt-5"), None, 25),
        local_now(2026, 7, 15, 12, 0),
    )
    .expect("filtered detail page");
    assert_eq!(result["totalCount"], json!(1));
    assert_eq!(result["filteredSummary"]["totalTokens"], json!(12));
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["id"], json!(matching_id));
    assert_eq!(
        result["availableFilters"]["machines"],
        json!([
            { "value": "mac", "count": 1 },
            { "value": "windows", "count": 1 }
        ])
    );

    let _ = fs::remove_dir_all(app_dir);
}

#[test]
fn detail_limit_is_clamped_to_one_hundred_at_scale() {
    let (app, app_dir) = test_app("detail_scale");
    let db_path = db::get_db_path(&app);
    let mut conn = Connection::open(&db_path).expect("open test database");
    let transaction = conn.transaction().expect("start bulk insert");
    {
        let mut stmt = transaction
            .prepare(
                "INSERT INTO token_logs
                    (tool, model, input_tokens, output_tokens, cached_tokens,
                     cache_write_tokens, timestamp, session_id, unique_key,
                     cost_usd, machine_id, sync_status)
                 VALUES ('codex', 'gpt-scale', 1, 1, 0, 0,
                         '2026-07-15 08:00:00', ?1, ?1, 0.0, 'mac', 0)",
            )
            .expect("prepare bulk insert");
        for index in 0..100_001 {
            stmt.execute([format!("scale-{index}")])
                .expect("insert scale row");
        }
    }
    transaction.commit().expect("commit bulk insert");
    drop(conn);

    let result = get_usage_details_impl_at(
        &app,
        details_query(
            "today",
            Some("mac"),
            Some("codex"),
            Some("gpt-scale"),
            None,
            10_000,
        ),
        local_now(2026, 7, 15, 12, 0),
    )
    .expect("query scale detail page");
    assert_eq!(result["items"].as_array().unwrap().len(), 100);
    assert_eq!(result["hasMore"], json!(true));
    assert_eq!(result["totalCount"], json!(100_001));

    let _ = fs::remove_dir_all(app_dir);
}

#[test]
fn entity_dashboard_keeps_ytd_heatmap_and_full_current_metrics() {
    let (app, app_dir) = test_app("entity_contract");
    let db_path = db::get_db_path(&app);
    let conn = Connection::open(&db_path).expect("open test database");
    insert_log(
        &conn,
        "ytd-before-current-range",
        "codex",
        "gpt-5",
        "mac",
        "2026-01-10 09:00:00",
        80,
        20,
    );
    insert_log(
        &conn,
        "current-mac",
        "codex",
        "gpt-5",
        "mac",
        "2026-07-15 10:00:00",
        15,
        5,
    );
    insert_log(
        &conn,
        "current-windows",
        "codex",
        "gpt-5",
        "windows",
        "2026-07-15 11:00:00",
        20,
        10,
    );
    drop(conn);

    let dashboard = get_local_entity_dashboard_impl_at(
        &app,
        EntityDashboardQuery {
            scope: Some("local".to_string()),
            entity: None,
            range: "today".to_string(),
            timezone: local_timezone(),
            machines: None,
            machine: None,
            tools: None,
            tool: Some("codex".to_string()),
            models: None,
            model: None,
            search: None,
            token_mode: Some("effective".to_string()),
            start: None,
            end: None,
        },
        local_now(2026, 7, 15, 12, 0),
    )
    .expect("load local entity dashboard");

    assert_eq!(dashboard["summary"]["totalTokens"], json!(50));
    assert_eq!(dashboard["historyPage"]["totalCount"], json!(2));
    assert_eq!(dashboard["heatmap"]["2026-01-10"], json!(100));
    assert_eq!(dashboard["heatmap"]["2026-07-15"], json!(50));
    assert_eq!(dashboard["activity"]["activeDays"], json!(1));
    assert_eq!(
        dashboard["activity"]["firstSeenAt"],
        json!("2026-07-15 10:00:00")
    );
    assert_eq!(
        dashboard["activity"]["lastSeenAt"],
        json!("2026-07-15 11:00:00")
    );
    assert_eq!(dashboard["peak"]["bucket"], json!("11:00"));
    assert_eq!(dashboard["peak"]["tokens"], json!(30));
    assert_eq!(dashboard["peak"]["requests"], json!(1));
    assert!(dashboard["peak"].get("cost").is_some());
    assert_eq!(
        dashboard["composition"]["machines"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(dashboard["composition"]["machines"][0]
        .get("tokens")
        .is_some());
    assert!(dashboard["composition"]["machines"][0]
        .get("cost")
        .is_some());

    let _ = fs::remove_dir_all(app_dir);
}

#[test]
fn malformed_detail_cursor_is_rejected() {
    let query = comparison_query("today", &local_timezone());
    assert!(decode_detail_cursor("v1.not-hex.12", &query, None).is_err());
    assert!(decode_detail_cursor("v2.00.1", &query, None).is_err());
    assert!(decode_detail_cursor(&"x".repeat(MAX_CURSOR_BYTES + 1), &query, None).is_err());
}

#[test]
fn antigravity_zero_read_unknown_write_is_not_proven_in_any_local_summary() {
    let (app, root) = test_app("antigravity_zero_read_unknown");
    let conn = db::get_connection(&db::get_db_path(&app)).unwrap();
    conn.execute_batch("INSERT INTO token_logs(tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,session_id,unique_key,machine_id,usage_provenance,cache_write_known) VALUES
        ('antigravity','selected-label',10,2,0,0,'2026-07-15 09:00:00','unknown','ag-zero-unknown','fixture','reported',0),
        ('antigravity','selected-label',10,2,20,5,'2026-07-15 10:00:00','known','ag-positive-known','fixture','reported',1);").unwrap();
    drop(conn);
    let now = local_now(2026, 7, 15, 12, 0);
    let stats =
        get_local_stats_v2_impl_at(&app, stats_query("all", None, None, None), now).unwrap();
    assert_eq!(stats["summary"]["totalTokens"], json!(24));
    assert_eq!(stats["summary"]["cachedTokens"], json!(20));
    for field in [
        "cacheReadTokens",
        "cacheWriteTokens",
        "cacheSavings",
        "cacheSavedUsd",
    ] {
        assert!(stats["summary"].get(field).is_none(), "{field}");
    }
    assert!(stats["tools"]["antigravity"].get("cacheRead").is_none());
    assert!(stats["models"]["selected-label"]
        .get("cacheWrite")
        .is_none());
    assert!(stats["machineDistribution"][0]
        .get("cacheWriteTokens")
        .is_none());
    let history = stats["history"].as_array().unwrap();
    let unknown = history
        .iter()
        .find(|r| r["sessionId"] == "unknown")
        .unwrap();
    assert!(unknown.get("cacheWriteTokens").is_none());
    assert_eq!(unknown["usageProvenance"], json!("reported"));
    let known = history.iter().find(|r| r["sessionId"] == "known").unwrap();
    assert_eq!(known["cacheReadTokens"], json!(15));
    assert_eq!(known["cacheWriteTokens"], json!(5));
    let details =
        get_usage_details_impl_at(&app, details_query("all", None, None, None, None, 10), now)
            .unwrap();
    assert!(details["filteredSummary"].get("cacheReadTokens").is_none());
    let item = details["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["sessionId"] == "unknown")
        .unwrap();
    assert!(item.get("cacheWriteTokens").is_none());
    assert_eq!(item["usageProvenance"], json!("reported"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_usage_provenance_distinguishes_zero_cache_rows_and_is_optional() {
    let (app, root) = test_app("usage_provenance");
    let conn = db::get_connection(&db::get_db_path(&app)).unwrap();
    for (key, tool, provenance) in [
        ("reported", "antigravity", Some("reported")),
        ("estimated", "antigravity", Some("estimated")),
        ("legacy", "codex", None),
    ] {
        let id = insert_log(
            &conn,
            key,
            tool,
            "model",
            "fixture",
            "2026-07-15 09:00:00",
            10,
            2,
        );
        conn.execute(
            "UPDATE token_logs SET usage_provenance=?1 WHERE id=?2",
            params![provenance, id],
        )
        .unwrap();
    }
    drop(conn);
    let now = local_now(2026, 7, 15, 12, 0);
    let stats =
        get_local_stats_v2_impl_at(&app, stats_query("all", None, None, None), now).unwrap();
    let details =
        get_usage_details_impl_at(&app, details_query("all", None, None, None, None, 10), now)
            .unwrap();
    for rows in [&stats["history"], &details["items"]] {
        for item in rows.as_array().unwrap() {
            match item["sessionId"].as_str().unwrap() {
                "reported" => assert_eq!(item["usageProvenance"], json!("reported")),
                "estimated" => assert_eq!(item["usageProvenance"], json!("estimated")),
                "legacy" => assert!(item.get("usageProvenance").is_none()),
                other => panic!("unexpected session {other}"),
            }
        }
    }
    fs::remove_dir_all(root).unwrap();
}
