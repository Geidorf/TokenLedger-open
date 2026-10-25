//! Synthetic mutation targets for event logs and editor task documents.
//!
//! These targets deliberately avoid real user directories. They exercise the
//! production scanners, persistence path, and rescans through the parent
//! harness while keeping source-specific edge cases local to the file format.

use super::{join, ledger_after, render, Scan, Shape, Target, TempDir};
use crate::scanner::cline::scan_cline_tasks_dir;
use crate::scanner::copilot::scan_copilot_dir;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

const COPILOT_SESSION: &str = "synthetic-copilot-session";
const EDITOR_TASK: &str = "synthetic-editor-task";

fn copilot_seed() -> Vec<Value> {
    vec![
        json!({
            "type": "session.start",
            "id": "start-1",
            "timestamp": "2026-10-21T09:00:00.000Z",
            "data": {"sessionId": COPILOT_SESSION}
        }),
        json!({
            "type": "session.shutdown",
            "id": "shutdown-a",
            "timestamp": "2026-10-21T09:30:00.000Z",
            "data": {"modelMetrics": {
                "alpha-model": {"usage": {
                    "inputTokens": 12_000,
                    "outputTokens": 1_000,
                    "cacheReadTokens": 10_000,
                    "cacheWriteTokens": 0
                }},
                "beta-model": {"usage": {
                    "inputTokens": 5_000,
                    "outputTokens": 100,
                    "cacheReadTokens": 30_000,
                    "cacheWriteTokens": 0
                }}
            }}
        }),
        json!({
            "type": "session.shutdown",
            "id": "shutdown-b",
            "timestamp": "2026-10-22T08:40:00.000Z",
            "data": {"modelMetrics": {
                "alpha-model": {"usage": {
                    "inputTokens": 35_800,
                    "outputTokens": 2_000,
                    "cacheReadTokens": 25_000,
                    "cacheWriteTokens": 2_000
                }}
            }}
        }),
    ]
}

fn write_copilot(root: &Path, bytes: &[u8]) {
    super::write_file(&root.join(COPILOT_SESSION).join("events.jsonl"), bytes);
}

fn scan_copilot(root: &Path) -> Scan {
    let mut scan = Scan::default();
    scan_copilot_dir(root, &mut scan.logs, &HashMap::new(), &mut Vec::new());
    scan
}

fn editor_request(ts: i64, protocol: Option<&str>, info: Value, partial: bool) -> Value {
    let mut message = json!({
        "ts": ts,
        "type": "say",
        "say": "api_req_started",
        "text": info.to_string()
    });
    if let Some(protocol) = protocol {
        message["apiProtocol"] = json!(protocol);
    }
    if partial {
        message["partial"] = json!(true);
    }
    message
}

fn editor_seed(protocol: Option<&str>) -> Vec<Value> {
    let requests = vec![
        json!({"ts": 1_760_000_000_000_i64, "type": "say", "say": "text", "text": "synthetic task"}),
        editor_request(
            1_760_000_001_000,
            protocol,
            json!({
                "request": "streaming",
                "tokensIn": 99_000,
                "tokensOut": 9_000,
                "cacheReads": 80_000,
                "cacheWrites": 1_000
            }),
            true,
        ),
        editor_request(
            1_760_000_002_000,
            protocol,
            json!({
                "request": "first completed request",
                "tokensIn": 9_000,
                "tokensOut": 300,
                "cacheReads": 6_000,
                "cacheWrites": 0,
                "cost": 0.02
            }),
            false,
        ),
        json!({"ts": 1_760_000_003_000_i64, "type": "say", "say": "text", "text": "synthetic progress"}),
        editor_request(
            1_760_000_004_000,
            protocol,
            json!({
                "request": "second completed request",
                "tokensIn": 7_000,
                "tokensOut": 200,
                "cacheReads": 4_000,
                "cacheWrites": 1_000,
                "cost": 0.01
            }),
            false,
        ),
        editor_request(
            1_760_000_005_000,
            protocol,
            json!({"request": "failed before usage"}),
            false,
        ),
        editor_request(
            1_760_000_006_000,
            protocol,
            json!({
                "request": "third completed request",
                "tokensIn": 1_200,
                "tokensOut": 100,
                "cacheReads": 0,
                "cacheWrites": 0
            }),
            false,
        ),
        json!({"ts": 1_760_000_007_000_i64, "type": "say", "say": "completion_result", "text": "done"}),
    ];
    vec![Value::Array(requests)]
}

fn cline_seed() -> Vec<Value> {
    editor_seed(None)
}

fn roo_seed() -> Vec<Value> {
    editor_seed(Some("openai"))
}

fn kilocode_seed() -> Vec<Value> {
    editor_seed(Some("anthropic"))
}

fn write_editor_task(root: &Path, bytes: &[u8]) {
    let task = root.join(EDITOR_TASK);
    super::write_file(&task.join("ui_messages.json"), bytes);
    super::write_file(
        &task.join("task_metadata.json"),
        br#"{"model_usage":[{"ts":1760000000000,"model_id":"synthetic/model-alpha"}]}"#,
    );
}

fn scan_editor(tool: &str, root: &Path) -> Scan {
    let mut scan = Scan::default();
    scan_cline_tasks_dir(tool, root, &mut scan.logs, &HashMap::new(), &mut Vec::new());
    scan
}

pub(super) fn targets() -> Vec<Target> {
    vec![
        Target {
            name: "copilot-events",
            shape: Shape::Lines,
            seed: copilot_seed,
            write: write_copilot,
            scan: scan_copilot,
            // Shutdown ids identify rows, while cumulative order is semantic.
            stable_ids: true,
            order_free: false,
        },
        Target {
            name: "cline-document",
            shape: Shape::Document,
            seed: cline_seed,
            write: write_editor_task,
            scan: |root| scan_editor("cline", root),
            stable_ids: true,
            order_free: true,
        },
        Target {
            name: "roo-document",
            shape: Shape::Document,
            seed: roo_seed,
            write: write_editor_task,
            scan: |root| scan_editor("roo", root),
            stable_ids: true,
            order_free: true,
        },
        Target {
            name: "kilocode-document",
            shape: Shape::Document,
            seed: kilocode_seed,
            write: write_editor_task,
            scan: |root| scan_editor("kilocode", root),
            stable_ids: true,
            order_free: true,
        },
    ]
}

fn find_target(name: &str) -> Target {
    targets()
        .into_iter()
        .find(|target| target.name == name)
        .unwrap_or_else(|| panic!("missing target {name}"))
}

fn clean_bytes(target: &Target) -> Vec<u8> {
    join(&render(target.shape, &(target.seed)()), b"\n", true)
}

fn document_bytes(messages: &[Value]) -> Vec<u8> {
    let document = Value::Array(messages.to_vec());
    join(&render(Shape::Document, &[document]), b"\n", true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PersistedTotals {
    rows: i64,
    input: i64,
    output: i64,
    cached: i64,
    cache_write: i64,
}

/// Persists one clean source without the rescan performed by `ledger_after`,
/// so the cache-write column can be asserted separately from aggregate totals.
fn persisted_totals(target: &Target, bytes: &[u8]) -> PersistedTotals {
    let db_dir = TempDir::new("file_source_exact_db");
    let db = db_dir.0.join("ledger.db");
    crate::db::init_test_db(&db).expect("init exact ledger");
    let source = TempDir::new(target.name);
    (target.write)(&source.0, bytes);
    let scan = (target.scan)(&source.0);
    super::persist(&db, scan).expect("persist exact source");

    let conn = crate::db::get_connection(&db).expect("open exact ledger");
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cached_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0)
         FROM token_logs",
        [],
        |row| {
            Ok(PersistedTotals {
                rows: row.get(0)?,
                input: row.get(1)?,
                output: row.get(2)?,
                cached: row.get(3)?,
                cache_write: row.get(4)?,
            })
        },
    )
    .expect("aggregate exact source")
}

#[test]
fn synthetic_file_targets_have_exact_nonempty_seeds() {
    let expected = [
        (
            "copilot-events",
            PersistedTotals {
                rows: 3,
                input: 13_800,
                output: 2_100,
                cached: 57_000,
                cache_write: 2_000,
            },
        ),
        (
            "cline-document",
            PersistedTotals {
                rows: 3,
                input: 11_200,
                output: 600,
                cached: 11_000,
                cache_write: 1_000,
            },
        ),
        (
            "roo-document",
            PersistedTotals {
                rows: 3,
                input: 7_200,
                output: 600,
                cached: 11_000,
                cache_write: 1_000,
            },
        ),
        (
            "kilocode-document",
            PersistedTotals {
                rows: 3,
                input: 17_200,
                output: 600,
                cached: 11_000,
                cache_write: 1_000,
            },
        ),
    ];

    for (name, expected) in expected {
        let target = find_target(name);
        let bytes = clean_bytes(&target);
        let stored = ledger_after(&target, &bytes)
            .unwrap_or_else(|error| panic!("{name} clean seed failed: {error}"));
        assert_eq!(stored.rows, expected.rows, "{name}: row count");
        assert_eq!(stored.input, expected.input, "{name}: input");
        assert_eq!(stored.output, expected.output, "{name}: output");
        assert_eq!(stored.cached, expected.cached, "{name}: cached");
        assert_eq!(
            persisted_totals(&target, &bytes),
            expected,
            "{name}: production persistence"
        );
    }
}

#[test]
fn editor_documents_dedupe_repeated_requests_and_tolerate_reordering() {
    for target in targets()
        .into_iter()
        .filter(|target| target.shape == Shape::Document)
    {
        let seed = (target.seed)();
        let mut messages = seed[0].as_array().expect("editor seed is an array").clone();
        let expected = ledger_after(&target, &document_bytes(&messages))
            .unwrap_or_else(|error| panic!("{} clean document failed: {error}", target.name));

        messages.reverse();
        let reordered = ledger_after(&target, &document_bytes(&messages))
            .unwrap_or_else(|error| panic!("{} reordered document failed: {error}", target.name));
        assert_eq!(
            reordered, expected,
            "{}: reordering requests changed totals",
            target.name
        );

        let request_index = messages
            .iter()
            .position(|message| {
                message.get("say").and_then(Value::as_str) == Some("api_req_started")
                    && message.get("partial").and_then(Value::as_bool) != Some(true)
                    && message
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| text.contains("\"tokensIn\":9000"))
            })
            .expect("completed request");
        let duplicate = messages[request_index].clone();
        messages.insert(request_index + 1, duplicate);
        let repeated = ledger_after(&target, &document_bytes(&messages))
            .unwrap_or_else(|error| panic!("{} repeated document failed: {error}", target.name));
        assert_eq!(
            repeated, expected,
            "{}: repeated request was counted twice",
            target.name
        );
    }
}

#[test]
fn editor_inner_usage_rejects_extremes_and_keeps_later_records() {
    for target in targets()
        .into_iter()
        .filter(|target| target.shape == Shape::Document)
    {
        let protocol = match target.name {
            "roo-document" => Some("openai"),
            "kilocode-document" => Some("anthropic"),
            _ => None,
        };
        let messages = vec![
            editor_request(
                1_760_000_010_000,
                protocol,
                json!({"tokensIn": 1_000_000_001_i64, "tokensOut": 1,
                    "cacheReads": 0, "cacheWrites": 0}),
                false,
            ),
            editor_request(
                1_760_000_011_000,
                protocol,
                json!({"tokensIn": 100, "tokensOut": {"bad": true},
                    "cacheReads": 0, "cacheWrites": 0}),
                false,
            ),
            editor_request(
                1_760_000_012_000,
                protocol,
                json!({"tokensIn": 100, "tokensOut": 1,
                    "cacheReads": 1.5, "cacheWrites": 0}),
                false,
            ),
            editor_request(
                1_760_000_013_000,
                protocol,
                json!({"tokensIn": 1_000_000_000_i64, "tokensOut": 7,
                    "cacheReads": 1_000_000_000_i64,
                    "cacheWrites": 1_000_000_000_i64}),
                false,
            ),
            editor_request(
                1_760_000_014_000,
                protocol,
                json!({"tokensIn": 1_200, "tokensOut": 100,
                    "cacheReads": 0, "cacheWrites": 0}),
                false,
            ),
        ];
        let bytes = document_bytes(&messages);
        let stored = ledger_after(&target, &bytes)
            .unwrap_or_else(|error| panic!("{} hostile inner usage failed: {error}", target.name));
        let expected_input = if target.name == "roo-document" {
            1_200
        } else {
            1_000_001_200
        };
        assert_eq!(
            stored.rows, 2,
            "{}: bad records must not be fabricated",
            target.name
        );
        assert_eq!(stored.input, expected_input, "{}: valid input", target.name);
        assert_eq!(stored.output, 107, "{}: valid output", target.name);
        assert_eq!(
            stored.cached, 2_000_000_000,
            "{}: cache total overflowed or was dropped",
            target.name
        );

        let exact = persisted_totals(&target, &bytes);
        assert_eq!(
            exact.cache_write, 1_000_000_000,
            "{}: cache write was not preserved",
            target.name
        );
    }
}
