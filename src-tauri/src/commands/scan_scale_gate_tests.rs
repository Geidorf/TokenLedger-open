use super::*;
use std::collections::HashSet;
use std::time::{Duration as StdDuration, Instant};

const DETAIL_PAGE_SIZE: usize = 100;

#[derive(Clone, Copy)]
struct ScaleCase {
    rows: usize,
    seed_budget: StdDuration,
    query_budget: StdDuration,
}

fn open_scale_fixture() -> Connection {
    let conn = Connection::open_in_memory().expect("open isolated in-memory scale fixture");
    conn.execute_batch(
        "PRAGMA journal_mode = OFF;
         PRAGMA synchronous = OFF;
         PRAGMA temp_store = MEMORY;
         CREATE TABLE token_logs (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             tool TEXT NOT NULL,
             model TEXT NOT NULL,
             input_tokens INTEGER NOT NULL,
             output_tokens INTEGER NOT NULL,
             cached_tokens INTEGER DEFAULT 0,
             cache_write_tokens INTEGER NOT NULL DEFAULT 0,
             cache_write_known INTEGER,
             usage_provenance TEXT,
             timestamp TEXT NOT NULL,
             session_id TEXT NOT NULL,
             unique_key TEXT UNIQUE NOT NULL,
             cost_usd REAL,
             machine_id TEXT NOT NULL DEFAULT '',
             sync_status INTEGER NOT NULL DEFAULT 0,
             cloud_user_id TEXT,
             synced_at TEXT
         );
         CREATE INDEX token_logs_timestamp_idx
             ON token_logs (timestamp);
         CREATE INDEX token_logs_tool_timestamp_idx
             ON token_logs (tool, timestamp);
         CREATE INDEX token_logs_timestamp_id_idx
             ON token_logs (timestamp DESC, id DESC);
         CREATE INDEX token_logs_tool_timestamp_id_idx
             ON token_logs (tool, timestamp DESC, id DESC);
         CREATE INDEX token_logs_model_timestamp_id_idx
             ON token_logs (model, timestamp DESC, id DESC);
         CREATE INDEX token_logs_machine_timestamp_id_idx
             ON token_logs (machine_id, timestamp DESC, id DESC);
         CREATE INDEX token_logs_tool_model_machine_timestamp_id_idx
             ON token_logs (tool, model, machine_id, timestamp DESC, id DESC);",
    )
    .expect("initialize scale fixture schema and production-equivalent indexes");
    conn
}

fn seed_fixture(conn: &Connection, rows: usize) -> StdDuration {
    let started = Instant::now();
    conn.execute(
        "WITH RECURSIVE counter(i) AS (
             SELECT 0
             UNION ALL
             SELECT i + 1 FROM counter WHERE i + 1 < ?1
         )
         INSERT INTO token_logs (
             tool, model, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, timestamp, session_id, unique_key,
             cost_usd, machine_id, sync_status
         )
         SELECT
             CASE WHEN i % 2 = 0 THEN 'codex' ELSE 'claude' END,
             CASE WHEN (i / 2) % 2 = 0 THEN 'gpt-scale' ELSE 'claude-scale' END,
             1,
             2,
             3,
             1,
             printf(
                 '2026-07-15 %02d:%02d:%02d',
                 8 + ((i / 3600) % 4),
                 (i / 60) % 60,
                 i % 60
             ),
             printf('scale-session-%d', i / 32),
             printf('scale-row-%d', i),
             0.0,
             CASE WHEN (i / 4) % 2 = 0 THEN 'mac' ELSE 'windows' END,
             0
         FROM counter",
        [rows as i64],
    )
    .expect("seed deterministic scale fixture");
    started.elapsed()
}

fn fixed_query() -> (NormalizedStatsQuery, QueryBounds) {
    let query = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: "today".to_string(),
        timezone: "UTC".to_string(),
        machines: None,
        machine: Some("mac".to_string()),
        tools: None,
        tool: Some("codex".to_string()),
        models: None,
        model: Some("gpt-scale".to_string()),
        search: None,
        token_mode: Some("effective".to_string()),
        start: None,
        end: None,
    })
    .expect("normalize deterministic scale query");
    let now = Utc
        .with_ymd_and_hms(2026, 7, 15, 12, 0, 0)
        .single()
        .expect("fixed UTC instant")
        .with_timezone(&query.tz);
    let bounds = query_bounds(query.range, now).expect("build fixed query bounds");
    (query, bounds)
}

fn facet_count(facets: &[Value], value: &str) -> i64 {
    facets
        .iter()
        .find(|facet| facet["value"] == value)
        .and_then(|facet| facet["count"].as_i64())
        .unwrap_or_default()
}

fn run_scale_case(case: ScaleCase) {
    let conn = open_scale_fixture();
    let seed_elapsed = seed_fixture(&conn, case.rows);
    assert!(
        seed_elapsed <= case.seed_budget,
        "{}-row in-memory fixture seed took {:?}, budget {:?}",
        case.rows,
        seed_elapsed,
        case.seed_budget
    );

    let (query, bounds) = fixed_query();
    let expected = (case.rows / 8) as i64;
    let prices = default_prices();
    let query_started = Instant::now();

    let summary = query_filtered_summary(&conn, &query, &bounds, &prices)
        .expect("aggregate filtered scale summary");
    assert_eq!(summary.requests, expected);
    assert_eq!(summary.input, expected);
    assert_eq!(summary.output, expected * 2);
    assert_eq!(summary.cached, expected * 3);
    assert_eq!(summary.cache_read, expected * 2);
    assert_eq!(summary.cache_write, expected);

    let first_page = query_detail_items(&conn, &query, &bounds, None, DETAIL_PAGE_SIZE)
        .expect("query first keyset page at scale");
    assert_eq!(first_page.len(), DETAIL_PAGE_SIZE + 1);
    assert!(first_page.windows(2).all(|pair| {
        pair[0].timestamp > pair[1].timestamp
            || (pair[0].timestamp == pair[1].timestamp && pair[0].id > pair[1].id)
    }));

    let cursor = decode_detail_cursor(
        &encode_detail_cursor(&first_page[DETAIL_PAGE_SIZE - 1], &query, None),
        &query,
        None,
    )
    .expect("round-trip production detail cursor");
    let second_page = query_detail_items(&conn, &query, &bounds, Some(&cursor), DETAIL_PAGE_SIZE)
        .expect("query second keyset page at scale");
    assert_eq!(second_page.len(), DETAIL_PAGE_SIZE + 1);
    assert!(second_page.windows(2).all(|pair| {
        pair[0].timestamp > pair[1].timestamp
            || (pair[0].timestamp == pair[1].timestamp && pair[0].id > pair[1].id)
    }));
    let first_page_ids = first_page[..DETAIL_PAGE_SIZE]
        .iter()
        .map(|row| row.id)
        .collect::<HashSet<_>>();
    assert!(
        second_page
            .iter()
            .all(|row| !first_page_ids.contains(&row.id)),
        "keyset pages must not overlap"
    );

    let tools = query_detail_facet(&conn, &query, &bounds, DetailFacet::Tool)
        .expect("query tool facets at scale");
    let models = query_detail_facet(&conn, &query, &bounds, DetailFacet::Model)
        .expect("query model facets at scale");
    let machines = query_detail_facet(&conn, &query, &bounds, DetailFacet::Machine)
        .expect("query machine facets at scale");
    assert_eq!(facet_count(&tools, "codex"), expected);
    assert_eq!(facet_count(&tools, "claude"), expected);
    assert_eq!(facet_count(&models, "gpt-scale"), expected);
    assert_eq!(facet_count(&models, "claude-scale"), expected);
    assert_eq!(facet_count(&machines, "mac"), expected);
    assert_eq!(facet_count(&machines, "windows"), expected);

    let query_elapsed = query_started.elapsed();
    assert!(
        query_elapsed <= case.query_budget,
        "{}-row filtered summary/facets/two-page query took {:?}, budget {:?}",
        case.rows,
        query_elapsed,
        case.query_budget
    );
    eprintln!(
        "T5.1 scale gate rows={} matched={} seed_ms={} query_ms={} seed_budget_ms={} query_budget_ms={}",
        case.rows,
        expected,
        seed_elapsed.as_millis(),
        query_elapsed.as_millis(),
        case.seed_budget.as_millis(),
        case.query_budget.as_millis()
    );
}

/// Opt-in because one million indexed rows intentionally consume substantial
/// memory and time. The fixture is SQLite `:memory:` only: it never resolves
/// AppContext, `$HOME`, scanner source paths, or a user's TokenLedger database.
#[test]
#[ignore = "opt-in 100k/1m in-memory SQLite performance gate"]
fn local_detail_queries_meet_100k_and_1m_budgets() {
    for case in [
        ScaleCase {
            rows: 100_000,
            seed_budget: StdDuration::from_secs(10),
            query_budget: StdDuration::from_secs(1),
        },
        ScaleCase {
            rows: 1_000_000,
            seed_budget: StdDuration::from_secs(60),
            query_budget: StdDuration::from_secs(8),
        },
    ] {
        run_scale_case(case);
    }
}
