//! Behavior contract v1.2: the project dimension (T10.182; spec PD-6, C1).
//!
//! The index is seeded through the store's own write path
//! (`project_index::behavior_view::test_support`, with its consent and
//! generation guards), so these tests never name the index tables: the
//! T10.165 guard keeps those inside `project_index`.

use super::*;
use crate::project_index::behavior_view::test_support::{self as index, Outcome};

const DAY_ONE: &str = "2026-09-01";
const DAY_TWO: &str = "2026-09-02";

/// `(unique key, tool, model, session, Shanghai wall time, input, output,
/// cached, stored cost)`.
type Fixture<'a> = (
    &'a str,
    &'a str,
    &'a str,
    &'a str,
    &'a str,
    i64,
    i64,
    i64,
    Option<f64>,
);

/// Two named spellings of one project, a fixed group, every unattributed
/// reason and cached tokens that must stay out of the effective count.
const MIXED: &[Fixture<'static>] = &[
    (
        "a1",
        "Codex",
        "gpt-5.5",
        "alpha-1",
        "2026-09-01 09:00:00",
        1_000,
        200,
        5_000,
        Some(0.10),
    ),
    (
        "a2",
        "Codex",
        "gpt-5.5",
        "alpha-1",
        "2026-09-01 10:00:00",
        500,
        100,
        0,
        Some(0.05),
    ),
    (
        "a3",
        "Claude",
        "claude-sonnet-4-6",
        "alpha-2",
        "2026-09-02 11:00:00",
        300,
        30,
        0,
        Some(0.03),
    ),
    (
        "h1",
        "Claude",
        "claude-sonnet-4-6",
        "home-1",
        "2026-09-01 12:00:00",
        200,
        20,
        0,
        Some(0.02),
    ),
    (
        "u1",
        "Antigravity",
        "gemini-3-pro",
        "ag-1",
        "2026-09-01 13:00:00",
        400,
        40,
        0,
        Some(0.04),
    ),
    (
        "x1",
        "Claude",
        "claude-sonnet-4-6",
        "gone-1",
        "2026-09-02 14:00:00",
        100,
        10,
        0,
        Some(0.01),
    ),
    (
        "p1",
        "Codex",
        "gpt-5.5",
        "new-1",
        "2026-09-02 15:00:00",
        60,
        6,
        0,
        Some(0.006),
    ),
    (
        "m1",
        "MiniMax",
        "minimax-m1",
        "",
        "2026-09-02 16:00:00",
        70,
        7,
        0,
        Some(0.007),
    ),
    (
        "m2",
        "MiniMax",
        "minimax-m1",
        "unknown_session",
        "2026-09-02 17:00:00",
        80,
        8,
        0,
        Some(0.008),
    ),
];

/// Top-level fields that v1.2 adds while the index collects.
const V1_2_FIELDS: [&str; 5] = [
    "projects",
    "projectLimit",
    "projectsTruncated",
    "projectsRemainder",
    "unattributed",
];

fn seed(app: &AppContext, rows: &[Fixture<'_>]) {
    for &(key, tool, model, session, wall, input, output, cached, cost) in rows {
        insert_row(
            app,
            LogRow {
                key,
                tool,
                model,
                session,
                timestamp: stored_at(SHANGHAI, wall),
                input,
                output,
                cached,
                cache_write: 0,
                cost,
            },
        );
    }
}

fn db_path(app: &AppContext) -> PathBuf {
    db::get_db_path(app)
}

fn now() -> DateTime<Local> {
    now_at(SHANGHAI, "2026-09-03 12:00:00")
}

fn run(
    app: &AppContext,
    query: LocalStatsQuery,
    projects: Option<&[&str]>,
) -> Result<Value, String> {
    let keys: Option<Vec<String>> =
        projects.map(|keys| keys.iter().map(|key| key.to_string()).collect());
    local_behavior_analysis_at(app, query, keys.as_deref(), now())
}

fn analyse(app: &AppContext, projects: Option<&[&str]>) -> Result<Value, String> {
    run(app, query(DAY_ONE, DAY_TWO, SHANGHAI), projects)
}

/// The mixed ledger with a ready index. `alpha-1` and `alpha-2` use two
/// spellings of one folder; `new-1` has no index row yet; `orphan-1` is an
/// index row whose session left the ledger.
fn mixed_app(tag: &str) -> AppContext {
    let app = test_app(tag);
    seed(&app, MIXED);
    let db = db_path(&app);
    index::enable(&db);
    index::store_sessions(
        &db,
        &[
            ("Codex", "alpha-1", Outcome::Named("Alpha")),
            ("Claude", "alpha-2", Outcome::Named("alpha")),
            ("Claude", "home-1", Outcome::Home),
            ("Antigravity", "ag-1", Outcome::UnsupportedSource),
            ("Claude", "gone-1", Outcome::Unresolved("source_missing")),
            ("Codex", "orphan-1", Outcome::Named("Orphan")),
        ],
    );
    index::mark_ready(&db);
    app
}

#[track_caller]
fn int(value: &Value) -> i64 {
    value
        .as_i64()
        .unwrap_or_else(|| panic!("expected an integer, got {value}"))
}

fn project<'a>(result: &'a Value, key: &str) -> &'a Value {
    result["projects"]
        .as_array()
        .expect("projects array")
        .iter()
        .find(|project| project["key"] == key)
        .unwrap_or_else(|| panic!("missing project {key}"))
}

fn reason<'a>(result: &'a Value, reason: &str) -> &'a Value {
    result["unattributed"]["reasons"]
        .as_array()
        .expect("reasons array")
        .iter()
        .find(|entry| entry["reason"] == reason)
        .unwrap_or_else(|| panic!("missing reason {reason}"))
}

#[track_caller]
fn assert_share(share: &Value, tokens: i64, total: i64) {
    if total == 0 {
        assert!(
            share.is_null(),
            "a share of nothing is unavailable, got {share}"
        );
        return;
    }
    let actual = share
        .as_f64()
        .unwrap_or_else(|| panic!("expected a share, got {share}"));
    let expected = tokens as f64 / total as f64;
    assert!(
        (actual - expected).abs() < 1e-12,
        "share {actual} != {tokens}/{total}"
    );
}

/// Only `meta.projectDimension.state`: no project field anywhere.
#[track_caller]
fn assert_no_project_fields(result: &Value, state: &str) {
    assert_eq!(
        result["meta"]["projectDimension"],
        json!({ "state": state })
    );
    for field in V1_2_FIELDS {
        assert!(result.get(field).is_none(), "{field} appears while {state}");
    }
    for session in result["sessions"].as_array().expect("sessions array") {
        assert!(
            session.get("project").is_none(),
            "session project while {state}"
        );
        assert!(session.get("projectReason").is_none());
    }
    let text = result.to_string();
    assert!(!text.contains("\"label\""), "no project name while {state}");
    assert!(!text.contains("n:"), "no project key while {state}");
}

/// Contract invariants 1–2, the same partition for sessions, and every
/// share against `summary.tokens` (unattributed included).
#[track_caller]
fn assert_partition(result: &Value) {
    let projects = result["projects"].as_array().expect("projects array");
    let remainder = &result["projectsRemainder"];
    let unattributed = &result["unattributed"];
    for field in ["tokens", "requests", "sessionCount"] {
        let ranked: i64 = projects.iter().map(|project| int(&project[field])).sum();
        let rest = if remainder.is_null() {
            0
        } else {
            int(&remainder[field])
        };
        assert_eq!(
            ranked + rest + int(&unattributed[field]),
            int(&result["summary"][field]),
            "{field}: projects + remainder + unattributed = summary"
        );
    }
    let reasons = unattributed["reasons"].as_array().expect("reasons array");
    for field in ["tokens", "requests"] {
        let by_reason: i64 = reasons.iter().map(|entry| int(&entry[field])).sum();
        assert_eq!(by_reason, int(&unattributed[field]), "unattributed {field}");
    }
    let total = int(&result["summary"]["tokens"]);
    let items = projects
        .iter()
        .chain(reasons)
        .chain(std::iter::once(unattributed))
        .chain((!remainder.is_null()).then_some(remainder));
    for item in items {
        assert_share(&item["share"], int(&item["tokens"]), total);
    }
}

#[test]
fn the_dimension_is_off_by_default_and_reports_only_its_state() {
    let app = test_app("projects_off");
    seed(&app, MIXED);
    assert_no_project_fields(&analyse(&app, None).unwrap(), "disabled");
    // An empty filter is no filter.
    assert_no_project_fields(&analyse(&app, Some(&[])).unwrap(), "disabled");
    // A filter while off is rejected, never silently ignored.
    for keys in [&["n:alpha"][..], &["@unattributed"]] {
        assert_eq!(
            analyse(&app, Some(keys)).unwrap_err(),
            "project_dimension_disabled"
        );
    }
}

#[test]
fn outdated_consent_or_a_switched_off_index_hides_stored_projects() {
    // Enabled under an older consent version: collection pauses and the
    // stored rows stay hidden until the user confirms again.
    let app = mixed_app("projects_consent");
    index::downgrade_consent(&db_path(&app));
    assert_no_project_fields(&analyse(&app, None).unwrap(), "consent_required");
    assert_eq!(
        analyse(&app, Some(&["n:alpha"])).unwrap_err(),
        "project_dimension_disabled"
    );

    // Rows left behind with the switch off (e.g. a restored database).
    let app = mixed_app("projects_leftover");
    index::switch_off_keeping_rows(&db_path(&app));
    assert_no_project_fields(&analyse(&app, None).unwrap(), "disabled");
    assert_eq!(
        analyse(&app, Some(&["n:alpha"])).unwrap_err(),
        "project_dimension_disabled"
    );

    // Disabling through the command purges; nothing comes back.
    let app = mixed_app("projects_disabled");
    index::disable(&db_path(&app));
    assert_no_project_fields(&analyse(&app, None).unwrap(), "disabled");
}

#[test]
fn projects_and_every_unattributed_reason_partition_the_summary() {
    let app = mixed_app("projects_partition");
    let result = analyse(&app, None).unwrap();

    assert_eq!(
        result["meta"]["projectDimension"],
        json!({ "state": "ready", "indexedSessions": 5, "pendingSessions": 1, "filter": [] })
    );
    // Effective tokens only: the 5,000 cached tokens of `a1` stay out.
    assert_eq!(result["summary"]["tokens"], 3131);
    assert_eq!(result["summary"]["sessionCount"], 6);

    let projects = result["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 2, "the orphan index row never shows up");
    // One session per spelling: the tie falls to code-point order.
    assert_eq!(projects[0]["key"], "n:alpha");
    assert_eq!(projects[0]["label"], "Alpha");
    assert_eq!(projects[0]["kind"], "named");
    assert_eq!(projects[0]["tokens"], 2130);
    assert_eq!(projects[0]["requests"], 3);
    assert_eq!(projects[0]["sessionCount"], 2);
    assert_usd(&projects[0]["cost"], 0.18);
    assert_eq!(
        projects[0]["tools"],
        json!([{ "id": "Codex", "tokens": 1800 }, { "id": "Claude", "tokens": 330 }])
    );
    assert_eq!(projects[1]["key"], "@home");
    assert!(projects[1]["label"].is_null());
    assert_eq!(projects[1]["kind"], "home");
    assert_eq!(projects[1]["tokens"], 220);
    assert_eq!(projects[1]["sessionCount"], 1);
    assert_usd(&projects[1]["cost"], 0.02);
    assert_eq!(result["projectLimit"], 50);
    assert_eq!(result["projectsTruncated"], false);
    assert!(result["projectsRemainder"].is_null());

    let unattributed = &result["unattributed"];
    assert_eq!(unattributed["tokens"], 781);
    assert_eq!(unattributed["requests"], 5);
    assert_eq!(unattributed["sessionCount"], 3);
    assert_usd(&unattributed["cost"], 0.071);
    let reasons: Vec<(String, i64, i64, Value)> = unattributed["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["reason"].as_str().unwrap().to_string(),
                int(&entry["tokens"]),
                int(&entry["requests"]),
                entry["sessionCount"].clone(),
            )
        })
        .collect();
    assert_eq!(
        reasons,
        vec![
            ("unsupported_source".to_string(), 440, 1, json!(1)),
            ("unresolved".to_string(), 110, 1, json!(1)),
            ("pending".to_string(), 66, 1, json!(1)),
            // Records without a session ID are no sessions: unknown, not 0.
            ("missing_session".to_string(), 165, 2, Value::Null),
        ]
    );
    // `missing_session` is exactly the v1.1 set of records without an ID.
    assert_eq!(
        reason(&result, "missing_session")["tokens"],
        result["summary"]["unknownSessionTokens"]
    );
    assert_eq!(
        reason(&result, "missing_session")["requests"],
        result["summary"]["unknownSessionRecords"]
    );
    // The denominator includes unattributed usage: 2130 / 3131, not 2130 / 2350.
    assert_share(&projects[0]["share"], 2130, 3131);
    assert_share(&unattributed["share"], 781, 3131);
    assert_partition(&result);

    // Sessions carry the ranking's key and name, or null plus the reason.
    let alpha = json!({ "key": "n:alpha", "label": "Alpha", "kind": "named" });
    assert_eq!(session(&result, "Codex", "alpha-1")["project"], alpha);
    assert_eq!(session(&result, "Claude", "alpha-2")["project"], alpha);
    assert_eq!(
        session(&result, "Claude", "home-1")["project"],
        json!({ "key": "@home", "label": null, "kind": "home" })
    );
    assert!(session(&result, "Codex", "alpha-1")
        .get("projectReason")
        .is_none());
    for (tool, id, expected) in [
        ("Antigravity", "ag-1", "unsupported_source"),
        ("Claude", "gone-1", "unresolved"),
        ("Codex", "new-1", "pending"),
    ] {
        let row = session(&result, tool, id);
        assert!(row["project"].is_null());
        assert_eq!(row["projectReason"], expected);
    }
    assert!(!result.to_string().contains("n:orphan"));
}

#[test]
fn a_project_cost_is_unavailable_when_any_of_its_records_is() {
    let app = test_app("projects_cost");
    seed(
        &app,
        &[
            (
                "g1",
                "Codex",
                "gpt-5.5",
                "good-1",
                "2026-09-01 09:00:00",
                100,
                10,
                0,
                Some(0.5),
            ),
            (
                "b1",
                "Codex",
                "gpt-5.5",
                "mixed-1",
                "2026-09-01 10:00:00",
                100,
                10,
                0,
                Some(0.2),
            ),
            (
                "b2",
                "Codex",
                "gpt-5.5",
                "mixed-1",
                "2026-09-01 11:00:00",
                100,
                10,
                0,
                Some(-1.0),
            ),
            (
                "z1",
                "Codex",
                "gpt-5.5",
                "zero-1",
                "2026-09-01 12:00:00",
                100,
                10,
                0,
                Some(0.0),
            ),
            (
                "u1",
                "Antigravity",
                "gemini-3-pro",
                "ag-1",
                "2026-09-01 13:00:00",
                100,
                10,
                0,
                Some(f64::INFINITY),
            ),
            (
                "u2",
                "Antigravity",
                "gemini-3-pro",
                "ag-2",
                "2026-09-01 14:00:00",
                100,
                10,
                0,
                Some(0.3),
            ),
        ],
    );
    let db = db_path(&app);
    index::enable(&db);
    index::store_sessions(
        &db,
        &[
            ("Codex", "good-1", Outcome::Named("Good")),
            ("Codex", "mixed-1", Outcome::Named("Mixed")),
            ("Codex", "zero-1", Outcome::Named("Zero")),
            ("Antigravity", "ag-1", Outcome::UnsupportedSource),
            ("Antigravity", "ag-2", Outcome::UnsupportedSource),
        ],
    );
    index::mark_ready(&db);
    let result = analyse(&app, None).unwrap();

    assert_usd(&project(&result, "n:good")["cost"], 0.5);
    // Never the known 0.2 alone, never 0.
    assert!(project(&result, "n:mixed")["cost"].is_null());
    // A real zero stays 0.
    assert_usd(&project(&result, "n:zero")["cost"], 0.0);
    assert!(result["unattributed"]["cost"].is_null());
    assert!(result["summary"]["totalCost"].is_null());
    assert_eq!(result["summary"]["costComplete"], false);
    // An unavailable cost does not touch tokens or shares.
    assert_eq!(project(&result, "n:mixed")["tokens"], 220);
    assert_partition(&result);
}

#[test]
fn the_ranking_stops_at_fifty_with_an_honest_remainder() {
    let app = test_app("projects_limit");
    let names: Vec<String> = (0..53).map(|index| format!("proj-{index:02}")).collect();
    let sessions: Vec<String> = (0..53).map(|index| format!("s-{index:02}")).collect();
    for (index, session) in sessions.iter().enumerate() {
        // proj-10 and proj-11 tie on tokens; key order decides.
        let input = if index == 11 {
            9_000
        } else {
            10_000 - 100 * index as i64
        };
        insert_row(
            &app,
            LogRow {
                key: &format!("k{index}"),
                tool: "Codex",
                model: "gpt-5.5",
                session,
                timestamp: stored_at(SHANGHAI, "2026-09-01 09:00:00"),
                input,
                output: 0,
                cached: 0,
                cache_write: 0,
                // The smallest project has a corrupt stored cost.
                cost: Some(if index == 52 { -1.0 } else { 0.01 }),
            },
        );
    }
    let db = db_path(&app);
    index::enable(&db);
    let rows: Vec<(&str, &str, Outcome<'_>)> = sessions
        .iter()
        .zip(&names)
        .map(|(session, name)| ("Codex", session.as_str(), Outcome::Named(name)))
        .collect();
    index::store_sessions(&db, &rows);
    index::mark_ready(&db);
    let result = analyse(&app, None).unwrap();

    let projects = result["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 50);
    assert_eq!(result["projectsTruncated"], true);
    for pair in projects.windows(2) {
        let (left, right) = (&pair[0], &pair[1]);
        assert!(
            int(&left["tokens"]) > int(&right["tokens"])
                || (left["tokens"] == right["tokens"]
                    && left["key"].as_str().unwrap() < right["key"].as_str().unwrap()),
            "ranked by tokens, then key"
        );
    }
    assert_eq!(projects[10]["key"], "n:proj-10");
    assert_eq!(projects[11]["key"], "n:proj-11");
    assert!(projects.iter().all(|project| project["cost"].is_number()));
    let remainder = &result["projectsRemainder"];
    assert_eq!(remainder["projectCount"], 3);
    assert_eq!(remainder["tokens"], 5_000 + 4_900 + 4_800);
    assert_eq!(remainder["requests"], 3);
    assert_eq!(remainder["sessionCount"], 3);
    // GLB-01 holds for the remainder too.
    assert!(remainder["cost"].is_null());
    assert_partition(&result);
}

#[test]
fn shares_are_unavailable_when_the_range_has_no_effective_tokens() {
    let app = test_app("projects_zero_total");
    seed(
        &app,
        &[(
            "c1",
            "Claude",
            "claude-sonnet-4-6",
            "cache-1",
            "2026-09-01 09:00:00",
            0,
            0,
            900,
            Some(0.01),
        )],
    );
    let db = db_path(&app);
    index::enable(&db);
    index::store_sessions(&db, &[("Claude", "cache-1", Outcome::Named("CacheOnly"))]);
    index::mark_ready(&db);
    let result = analyse(&app, None).unwrap();
    assert_eq!(result["summary"]["tokens"], 0);
    assert_eq!(project(&result, "n:cacheonly")["requests"], 1);
    assert!(project(&result, "n:cacheonly")["share"].is_null());
    assert!(result["unattributed"]["share"].is_null());
    assert_partition(&result);
}

#[test]
fn the_filter_applies_to_every_dimension() {
    let app = mixed_app("projects_filter");
    let all = analyse(&app, None).unwrap();

    // Invariant 4: filtering to K gives K's own totals.
    let alpha = analyse(&app, Some(&["n:alpha"])).unwrap();
    for field in ["tokens", "requests", "sessionCount"] {
        assert_eq!(alpha["summary"][field], project(&all, "n:alpha")[field]);
    }
    assert_eq!(alpha["meta"]["recordCount"], 3);
    assert_eq!(
        alpha["meta"]["projectDimension"],
        json!({ "state": "ready", "indexedSessions": 5, "pendingSessions": 1, "filter": ["n:alpha"] })
    );
    assert_eq!(session_ids(&alpha), vec!["alpha-1", "alpha-2"]);
    let tools: Vec<(&str, i64)> = alpha["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| (tool["id"].as_str().unwrap(), int(&tool["tokens"])))
        .collect();
    assert_eq!(tools, vec![("Codex", 1800), ("Claude", 330)]);
    assert_eq!(
        day_hours(&alpha),
        vec![
            ("2026-09-01".to_string(), 9),
            ("2026-09-01".to_string(), 10),
            ("2026-09-02".to_string(), 11),
        ]
    );
    let models: Vec<&str> = alpha["requestSizes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["model"].as_str().unwrap())
        .collect();
    assert_eq!(models, vec!["gpt-5.5", "claude-sonnet-4-6"]);
    assert_eq!(alpha["modelDays"].as_array().unwrap().len(), 2);
    assert_eq!(alpha["modelHours"].as_array().unwrap().len(), 3);
    assert_eq!(alpha["summary"]["unknownSessionRecords"], 0);
    assert_eq!(alpha["projects"].as_array().unwrap().len(), 1);
    assert_eq!(
        alpha["unattributed"],
        json!({ "tokens": 0, "requests": 0, "sessionCount": 0, "cost": 0.0, "share": 0.0, "reasons": [] })
    );
    assert_partition(&alpha);

    // The reserved key selects every unattributed record and nothing else.
    let rest = analyse(&app, Some(&["@unattributed"])).unwrap();
    assert_eq!(rest["summary"]["tokens"], all["unattributed"]["tokens"]);
    assert_eq!(rest["summary"]["unknownSessionRecords"], 2);
    assert_eq!(rest["projects"], json!([]));
    assert_eq!(session_ids(&rest), vec!["ag-1", "gone-1", "new-1"]);
    for name in [
        "unsupported_source",
        "unresolved",
        "pending",
        "missing_session",
    ] {
        assert_eq!(reason(&rest, name)["tokens"], reason(&all, name)["tokens"]);
    }
    assert_partition(&rest);

    // Keys are deduplicated and echoed in code-point order.
    let both = analyse(&app, Some(&["n:alpha", "@home", "n:alpha"])).unwrap();
    assert_eq!(
        both["meta"]["projectDimension"]["filter"],
        json!(["@home", "n:alpha"])
    );
    assert_eq!(both["summary"]["tokens"], 2130 + 220);

    // Keys are opaque: another spelling, an unknown or internal key, or a
    // bare name matches nothing, and is no error. Coverage ignores the filter.
    for keys in [
        &["n:Alpha"][..],
        &["n:missing"],
        &["@unresolved"],
        &["Alpha"],
    ] {
        let result = analyse(&app, Some(keys)).unwrap();
        assert_eq!(result["meta"]["recordCount"], 0, "{keys:?}");
        assert_eq!(result["projects"], json!([]));
        assert_eq!(result["unattributed"]["requests"], 0);
        assert_eq!(result["meta"]["projectDimension"]["indexedSessions"], 5);
        assert_eq!(result["meta"]["projectDimension"]["pendingSessions"], 1);
        assert_partition(&result);
    }
}

#[test]
fn indexing_and_failed_states_still_show_what_is_stored() {
    let app = test_app("projects_states");
    seed(&app, MIXED);
    let db = db_path(&app);
    index::enable(&db);
    index::store_sessions(&db, &[("Codex", "alpha-1", Outcome::Named("Alpha"))]);

    let indexing = analyse(&app, None).unwrap();
    assert_eq!(
        indexing["meta"]["projectDimension"],
        json!({ "state": "indexing", "indexedSessions": 1, "pendingSessions": 5, "filter": [] })
    );
    assert_eq!(project(&indexing, "n:alpha")["tokens"], 1800);
    assert_eq!(reason(&indexing, "pending")["sessionCount"], 5);
    assert_eq!(
        reason(&indexing, "pending")["tokens"],
        330 + 220 + 440 + 110 + 66
    );
    assert_partition(&indexing);

    index::mark_failed(&db, "database_error");
    let failed = analyse(&app, None).unwrap();
    assert_eq!(failed["meta"]["projectDimension"]["state"], "failed");
    assert_eq!(
        failed["meta"]["projectDimension"]["lastFailure"],
        "database_error"
    );
    assert_eq!(project(&failed, "n:alpha")["tokens"], 1800);
    let filtered = analyse(&app, Some(&["n:alpha"])).unwrap();
    assert_eq!(filtered["summary"]["tokens"], 1800);

    // Only fixed backfill codes pass; any other stored value becomes null.
    index::mark_failed(&db, "purge_pending");
    assert!(analyse(&app, None).unwrap()["meta"]["projectDimension"]["lastFailure"].is_null());
    // Outside `failed` there is no failure field at all.
    index::mark_ready(&db);
    let ready = analyse(&app, None).unwrap();
    assert!(ready["meta"]["projectDimension"]
        .get("lastFailure")
        .is_none());
}

/// Removes everything v1.2 adds, leaving what a v1.1 client reads.
fn v1_1_view(mut result: Value) -> Value {
    let object = result.as_object_mut().expect("response object");
    for field in V1_2_FIELDS {
        object.remove(field);
    }
    object["meta"]
        .as_object_mut()
        .expect("meta object")
        .remove("projectDimension");
    for session in object["sessions"].as_array_mut().expect("sessions array") {
        let session = session.as_object_mut().expect("session object");
        session.remove("project");
        session.remove("projectReason");
    }
    result
}

#[test]
fn a_client_without_the_filter_gets_the_v1_1_response_unchanged() {
    let app = mixed_app("projects_additive");
    let enabled =
        get_local_behavior_analysis_impl_at(&app, query(DAY_ONE, DAY_TWO, SHANGHAI), now())
            .unwrap();
    // Exactly the documented additions, nothing else.
    let v1_1_keys = [
        "meta",
        "summary",
        "tools",
        "sessions",
        "dayHours",
        "modelHours",
        "modelDays",
        "requestSizes",
    ];
    let keys: HashSet<&str> = enabled
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let expected: HashSet<&str> = v1_1_keys
        .iter()
        .chain(V1_2_FIELDS.iter())
        .copied()
        .collect();
    assert_eq!(keys, expected);
    for session in enabled["sessions"].as_array().unwrap() {
        assert!(session.get("project").is_some());
    }

    index::disable(&db_path(&app));
    let disabled =
        get_local_behavior_analysis_impl_at(&app, query(DAY_ONE, DAY_TWO, SHANGHAI), now())
            .unwrap();
    // Every v1.1 field keeps its value whether the dimension is on or off.
    assert_eq!(v1_1_view(enabled), v1_1_view(disabled));
}

/// A damaged database for each index state: off with its state table gone,
/// and collecting with its session table gone (review P3-4, root R-32).
fn unreadable_apps(tag: &str) -> Vec<(AppContext, Value)> {
    let off = test_app(&format!("{tag}_off"));
    seed(&off, MIXED);
    let on = mixed_app(&format!("{tag}_on"));
    [
        (off, index::MissingTable::State),
        (on, index::MissingTable::Sessions),
    ]
    .into_iter()
    .map(|(app, table)| {
        let intact = analyse(&app, None).unwrap();
        index::hide_table(&db_path(&app), table);
        (app, intact)
    })
    .collect()
}

/// What a backend without the project dimension sends: no project field at
/// all, `meta.projectDimension` included.
#[track_caller]
fn assert_without_project_dimension(result: &Value) {
    assert!(
        result["meta"].get("projectDimension").is_none(),
        "the dimension is omitted, never reported as off"
    );
    for field in V1_2_FIELDS {
        assert!(result.get(field).is_none(), "{field} without the dimension");
    }
    for session in result["sessions"].as_array().expect("sessions array") {
        assert!(session.get("project").is_none());
        assert!(session.get("projectReason").is_none());
    }
}

#[test]
fn an_unreadable_index_degrades_to_the_v1_1_response() {
    for (app, intact) in unreadable_apps("projects_unreadable") {
        let degraded = analyse(&app, None).expect("the v1.1 fields still come back");
        assert_without_project_dimension(&degraded);
        assert_eq!(degraded, v1_1_view(intact));
        // An empty filter is no filter.
        assert_without_project_dimension(&analyse(&app, Some(&[])).unwrap());
    }
}

#[test]
fn a_project_filter_on_an_unreadable_index_is_a_fixed_error() {
    for (app, _) in unreadable_apps("projects_unreadable_filter") {
        for keys in [&["n:alpha"][..], &["@unattributed"]] {
            // The fixed code only: never the SQLite text of the failed read.
            assert_eq!(
                analyse(&app, Some(keys)).unwrap_err(),
                "project_dimension_unavailable"
            );
        }
    }
}

#[test]
fn range_truncation_follows_the_project_filter() {
    let app = test_app("projects_truncation");
    seed(
        &app,
        &[
            // Before the 731-day `all` window that ends on 2026-09-03.
            (
                "old",
                "Codex",
                "gpt-5.5",
                "beta-old",
                "2024-06-01 09:00:00",
                100,
                10,
                0,
                Some(0.1),
            ),
            (
                "new",
                "Codex",
                "gpt-5.5",
                "alpha-new",
                "2026-09-02 09:00:00",
                100,
                10,
                0,
                Some(0.1),
            ),
        ],
    );
    let db = db_path(&app);
    index::enable(&db);
    index::store_sessions(
        &db,
        &[
            ("Codex", "beta-old", Outcome::Named("Beta")),
            ("Codex", "alpha-new", Outcome::Named("Alpha")),
        ],
    );
    index::mark_ready(&db);
    let truncated = |keys: Option<&[&str]>| {
        run(&app, preset_query("all", SHANGHAI), keys).unwrap()["meta"]["rangeTruncated"].clone()
    };
    assert_eq!(truncated(None), true);
    assert_eq!(truncated(Some(&["n:alpha"])), false);
    assert_eq!(truncated(Some(&["n:beta"])), true);
    assert_eq!(truncated(Some(&["@unattributed"])), false);
}

#[test]
fn the_aggregation_only_reads_the_index_and_nothing_reaches_sync_or_export() {
    const CANARY: &str = "CANARY_PROJECT_LABEL";
    let app = test_app("projects_local_only");
    seed(
        &app,
        &[
            (
                "c1",
                "Codex",
                "gpt-5.5",
                "canary-1",
                "2026-09-01 09:00:00",
                100,
                10,
                0,
                None,
            ),
            (
                "c2",
                "Claude",
                "claude-sonnet-4-6",
                "canary-2",
                "2026-09-02 09:00:00",
                200,
                20,
                0,
                Some(0.01),
            ),
        ],
    );
    let db = db_path(&app);
    index::enable(&db);
    index::store_sessions(
        &db,
        &[
            ("Codex", "canary-1", Outcome::Named(CANARY)),
            ("Claude", "canary-2", Outcome::Named(CANARY)),
        ],
    );
    index::mark_ready(&db);
    let before = crate::project_index::status_impl(&db).unwrap();
    let behavior = analyse(&app, None).unwrap();
    assert!(
        behavior.to_string().contains(CANARY),
        "the behavior view shows it"
    );
    analyse(&app, Some(&["n:canary_project_label"])).unwrap();
    assert_eq!(
        crate::project_index::status_impl(&db).unwrap(),
        before,
        "aggregating never writes the index"
    );

    let leaks = |text: &str| text.to_lowercase().contains("canary_project_label");
    let conn = db::get_connection(&db).unwrap();
    let mut statement = conn.prepare(RAW_SYNC_LOGS_SQL).unwrap();
    let columns = statement.column_count();
    let mut rows = statement
        .query(rusqlite::params!["user-guard", "machine"])
        .unwrap();
    let mut seen = 0;
    while let Some(row) = rows.next().unwrap() {
        for column in 0..columns {
            let value: SqlValue = row.get(column).unwrap();
            assert!(!leaks(&format!("{value:?}")), "sync row");
        }
        seen += 1;
    }
    assert_eq!(seen, 2, "both rows wait for sync");
    let export = export_db_csv_impl(&app).unwrap();
    assert!(!leaks(&export.to_string()));
    let csv = fs::read_to_string(app.app_data_dir().join("tokenledger_export.csv")).unwrap();
    assert!(!leaks(&csv), "csv export");
    let stats = get_local_stats_v2_impl_at(&app, query(DAY_ONE, DAY_TWO, SHANGHAI), now()).unwrap();
    assert!(!leaks(&stats.to_string()), "stats v2");
}

#[test]
fn the_index_view_neither_logs_nor_prints() {
    // The G5 guard of `project_index` lists its files explicitly; this keeps
    // the read-only view under the same rule.
    const VIEW_SOURCE: &str = include_str!("../project_index/behavior_view.rs");
    for forbidden in [
        "log::",
        "println!",
        "eprintln!",
        "print!(",
        "eprint!(",
        "dbg!",
        ".display()",
        "stderr(",
        "stdout(",
    ] {
        assert!(
            !VIEW_SOURCE.contains(forbidden),
            "behavior_view.rs uses {forbidden}"
        );
    }
}
