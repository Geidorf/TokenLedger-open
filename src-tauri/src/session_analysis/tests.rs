use super::*;
use super::{
    reader::{project, read_snapshot, MAX_LINE},
    types::Record,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicU64,
};

const CLAUDE: &str = include_str!("../../../fixtures/session-analysis-v1/claude-main.jsonl");
const CODEX: &str = include_str!("../../../fixtures/session-analysis-v1/codex-main.jsonl");
const CODEX_ID: &str = "11111111-1111-4111-8111-111111111111";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "tokenledger-session-analysis-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, text: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, text).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn budget() -> Budget {
    Budget::new(Arc::new(AtomicBool::new(false)))
}

#[test]
fn codex_roots_include_multica_task_homes_for_session_analysis() {
    let fixture = Fixture::new();
    let multica_sessions = fixture
        .0
        .join("multica_workspaces_desktop-api.multica.ai")
        .join("workspace-id")
        .join("task-1234")
        .join("codex-home")
        .join("sessions");
    fs::create_dir_all(&multica_sessions).unwrap();

    let discovered = roots_in("codex", &fixture.0);

    assert!(discovered.contains(&fixture.0.join(".codex").join("sessions")));
    assert!(discovered.contains(&multica_sessions));
}

fn claude_record() -> Record {
    Record {
        id: 1,
        tool: "claude".into(),
        session_id: "session".into(),
        unique_key: "claude_m1_r1".into(),
    }
}
fn codex_record() -> Record {
    Record {
        id: 2,
        tool: "codex".into(),
        session_id: CODEX_ID.into(),
        unique_key: format!("codex_v2_{CODEX_ID}_1"),
    }
}
fn analyze_text(tool: &str, text: &str) -> Result<Analysis, &'static str> {
    let fixture = Fixture::new();
    let path = fixture.write("source.jsonl", text);
    let mut budget = budget();
    let snapshot = read_snapshot(&path, &mut budget)?;
    if tool == "claude" {
        claude::analyze(&claude_record(), &snapshot, &budget)
    } else {
        codex::analyze(&codex_record(), &snapshot, &budget)
    }
}
fn replace_line(text: &str, index: usize, mutate: impl FnOnce(&mut Value)) -> String {
    let mut lines: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    mutate(&mut lines[index]);
    lines.iter().map(|v| format!("{v}\n")).collect()
}

#[test]
fn claude_groups_real_inputs_dedupes_usage_and_tool_blocks_without_body() {
    let result = analyze_text("claude", CLAUDE).unwrap();
    assert_eq!(result.status, "ready");
    assert_eq!(result.turns.len(), 2);
    let first = &result.turns[0];
    assert_eq!(
        (
            first.usage.request_count,
            first.usage.input_tokens,
            first.usage.output_tokens,
            first.usage.cached_tokens
        ),
        (2, 10, 30, 220)
    );
    assert_eq!(first.cache_read_tokens, Some(200));
    assert_eq!(first.cache_write_tokens, Some(20));
    assert_eq!(
        (first.tools[0].name.as_str(), first.tools[0].count),
        ("Read", 1)
    );
    assert_eq!(first.status, "complete");
    assert!(!serde_json::to_string(&result).unwrap().contains("PRIVATE_"));
    for line in CLAUDE.lines().chain(CODEX.lines()) {
        assert!(!project(line.as_bytes())
            .unwrap()
            .to_string()
            .contains("PRIVATE_"));
    }
}

#[test]
fn codex_groups_user_events_not_context_or_response_copies_and_reuses_scanner_usage() {
    let result = analyze_text("codex", CODEX).unwrap();
    assert_eq!(result.status, "ready");
    assert_eq!(result.turns.len(), 2);
    let first = &result.turns[0];
    assert_eq!(
        (
            first.usage.request_count,
            first.usage.input_tokens,
            first.usage.output_tokens,
            first.usage.cached_tokens
        ),
        (2, 70, 30, 80)
    );
    assert_eq!(first.cache_write_tokens, None);
    assert_eq!(first.tools[0].count, 1);
    assert_eq!(result.turns[1].usage.input_tokens, 10);
    assert_eq!(result.turns[1].status, "unknown");
    let parsed = crate::scanner::codex::parse_codex_rollout_reader(
        std::io::Cursor::new(CODEX),
        Path::new("fixture"),
        CODEX_ID,
    )
    .unwrap();
    let logs = crate::scanner::codex::codex_logs_from_rollout(&parsed, 0);
    assert_eq!(
        logs.iter().map(|l| l.input_tokens).sum::<i64>(),
        result
            .turns
            .iter()
            .map(|t| t.usage.input_tokens)
            .sum::<i64>()
    );
}

#[test]
fn no_user_boundaries_does_not_relabel_requests_as_turns() {
    let text: String = CLAUDE
        .lines()
        .filter(|l| !l.contains("\"type\":\"user\""))
        .map(|l| format!("{l}\n"))
        .collect();
    assert_eq!(
        analyze_text("claude", &text).unwrap_err(),
        "insufficient_turn_metadata"
    );
}

#[test]
fn forks_subagents_and_compaction_are_explicitly_unsupported() {
    let child = replace_line(CODEX, 0, |v| {
        v["payload"]["forked_from_id"] = json!("22222222-2222-4222-8222-222222222222")
    });
    assert_eq!(
        analyze_text("codex", &child).unwrap_err(),
        "unsupported_session_shape"
    );
    let subagent = replace_line(CODEX, 0, |v| {
        v["payload"]["source"] = json!({"subagent":"review"})
    });
    assert_eq!(
        analyze_text("codex", &subagent).unwrap_err(),
        "unsupported_session_shape"
    );
    let sidechain = replace_line(CLAUDE, 1, |v| v["isSidechain"] = json!(true));
    assert_eq!(
        analyze_text("claude", &sidechain).unwrap_err(),
        "unsupported_session_shape"
    );
    assert_eq!(
        analyze_text(
            "claude",
            &format!("{CLAUDE}{{\"type\":\"system\",\"subtype\":\"compact_boundary\"}}\n")
        )
        .unwrap_err(),
        "unsupported_session_shape"
    );
}

#[test]
fn absent_or_negative_counters_never_become_known_zero() {
    let missing = replace_line(CLAUDE, 1, |v| {
        v["message"]["usage"]
            .as_object_mut()
            .unwrap()
            .remove("input_tokens");
    });
    assert_eq!(
        analyze_text("claude", &missing).unwrap_err(),
        "source_unreadable"
    );
    let negative = replace_line(CODEX, 7, |v| {
        v["payload"]["info"]["last_token_usage"]["input_tokens"] = json!(-1)
    });
    assert_eq!(
        analyze_text("codex", &negative).unwrap_err(),
        "source_unreadable"
    );
}

#[test]
fn orphan_usage_and_partial_tail_are_partial_not_full_coverage() {
    let mut lines: Vec<_> = CLAUDE.lines().collect();
    lines.swap(0, 1);
    let result = analyze_text("claude", &(lines.join("\n") + "\n")).unwrap_err();
    // The same request later crosses an input boundary: refuse ambiguous replay.
    assert_eq!(result, "unsupported_session_shape");
    let result = analyze_text("claude", &format!("{CLAUDE}{{\"unfinished\":")).unwrap();
    assert_eq!(result.status, "partial");
    assert!(!result.coverage.complete);
}

#[test]
fn tool_result_is_not_input_and_invalid_tool_name_is_not_exposed() {
    let text = replace_line(CLAUDE, 1, |v| {
        v["message"]["content"][1]["name"] = json!("bad\nPRIVATE_NAME")
    });
    let result = analyze_text("claude", &text).unwrap();
    assert_eq!(result.turns.len(), 2);
    assert_eq!(result.status, "partial");
    assert!(!result.coverage.tool_calls_known);
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("PRIVATE_NAME"));
}

#[test]
fn resolver_requires_local_record_and_exact_unique_key() {
    let fixture = Fixture::new();
    fixture.write("session.jsonl", CLAUDE);
    let db = fixture.0.join("local.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE token_logs(id INTEGER PRIMARY KEY,tool TEXT,session_id TEXT,unique_key TEXT); INSERT INTO token_logs VALUES(1,'claude','session','claude_m1_r1');").unwrap();
    let mut row = resolver::record(&db, 1).unwrap();
    assert!(
        resolver::analyze(&row, std::slice::from_ref(&fixture.0), &mut budget())
            .unwrap()
            .coverage
            .matched_record
    );
    row.unique_key = "claude_other".into();
    assert_eq!(
        resolver::analyze(&row, std::slice::from_ref(&fixture.0), &mut budget()).unwrap_err(),
        "record_not_found"
    );
    assert_eq!(resolver::record(&db, 2).unwrap_err(), "record_not_found");
    assert_eq!(resolver::record(&db, -1).unwrap_err(), "invalid_request");
}

#[test]
fn resolver_missing_unsupported_and_conflicting_sources_are_distinct() {
    let fixture = Fixture::new();
    let mut row = claude_record();
    assert_eq!(
        resolver::analyze(&row, std::slice::from_ref(&fixture.0), &mut budget()).unwrap_err(),
        "source_missing"
    );
    row.tool = "opencode".into();
    assert_eq!(
        resolver::analyze(&row, std::slice::from_ref(&fixture.0), &mut budget()).unwrap_err(),
        "unsupported_source"
    );
    row.tool = "claude".into();
    fixture.write("session.jsonl", CLAUDE);
    let nested = fixture.0.join("copy");
    fs::create_dir(&nested).unwrap();
    fs::write(
        nested.join("session.jsonl"),
        replace_line(CLAUDE, 1, |v| {
            v["message"]["usage"]["input_tokens"] = json!(99)
        }),
    )
    .unwrap();
    assert_eq!(
        resolver::analyze(&row, std::slice::from_ref(&fixture.0), &mut budget()).unwrap_err(),
        "source_ambiguous"
    );
}

#[test]
fn canonical_path_check_rejects_escape_and_directories() {
    let inside = Fixture::new();
    let outside = Fixture::new();
    let file = outside.write("session.jsonl", CLAUDE);
    let roots = vec![fs::canonicalize(&inside.0).unwrap()];
    assert_eq!(
        resolver::canonical_candidate(&file, &roots).unwrap_err(),
        "source_unreadable"
    );
    assert_eq!(
        resolver::canonical_candidate(&inside.0, &roots).unwrap_err(),
        "source_unreadable"
    );
}

#[cfg(unix)]
#[test]
fn symlink_escape_is_rejected() {
    let inside = Fixture::new();
    let outside = Fixture::new();
    let file = outside.write("session.jsonl", CLAUDE);
    let link = inside.0.join("session.jsonl");
    std::os::unix::fs::symlink(file, &link).unwrap();
    assert_eq!(
        resolver::canonical_candidate(&link, &[fs::canonicalize(&inside.0).unwrap()]).unwrap_err(),
        "source_unreadable"
    );
}

#[test]
fn bounded_reader_checks_size_line_deadline_and_cancellation() {
    let fixture = Fixture::new();
    let path = fixture.write("source.jsonl", CLAUDE);
    let mut b = budget();
    b.bytes_left = 1;
    assert_eq!(read_snapshot(&path, &mut b).err(), Some("limit_exceeded"));
    let mut b = budget();
    b.cancel.store(true, Ordering::Release);
    assert_eq!(read_snapshot(&path, &mut b).err(), Some("cancelled"));
    let mut b = budget();
    b.deadline = std::time::Instant::now();
    assert_eq!(read_snapshot(&path, &mut b).err(), Some("limit_exceeded"));
    let huge = fixture.write("huge.jsonl", &" ".repeat(MAX_LINE + 1));
    assert_eq!(
        read_snapshot(&huge, &mut budget()).err(),
        Some("limit_exceeded")
    );
    let broken = fixture.write("broken.jsonl", "{bad}\n");
    assert_eq!(
        read_snapshot(&broken, &mut budget()).err(),
        Some("source_unreadable")
    );
}

#[test]
fn codex_shared_reader_checks_cancellation_between_records() {
    let mut count = 0;
    let parsed = crate::scanner::codex::parse_codex_rollout_reader_checked(
        std::io::Cursor::new(CODEX),
        Path::new("fixture"),
        CODEX_ID,
        || {
            count += 1;
            if count == 3 {
                Err("cancelled".to_owned())
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(parsed.unwrap_err(), "cancelled");
    assert_eq!(count, 3);
}

#[test]
fn regression_claude_parent_from_previous_turn_is_not_assigned_to_current() {
    let mut lines: Vec<_> = CLAUDE.lines().collect();
    let old_answer = lines.remove(4);
    lines.insert(5, old_answer);
    assert_eq!(
        analyze_text("claude", &(lines.join("\n") + "\n")).unwrap_err(),
        "unsupported_session_shape"
    );
}

#[test]
fn regression_codex_unidentified_duplicate_user_does_not_create_pseudo_turn() {
    let text = replace_line(CODEX, 3, |v| {
        v["payload"].as_object_mut().unwrap().remove("id");
    });
    let mut lines: Vec<_> = text.lines().collect();
    let duplicate = lines[3];
    lines.insert(4, duplicate);
    let result = analyze_text("codex", &(lines.join("\n") + "\n"));
    assert!(
        result
            .as_ref()
            .is_err_and(|reason| *reason == "insufficient_turn_metadata")
            || result.as_ref().is_ok_and(|r| r.turns.len() == 2)
    );
}

#[test]
fn regression_missing_whole_usage_is_not_a_completed_zero_turn() {
    let text = replace_line(CLAUDE, 6, |v| {
        v["message"].as_object_mut().unwrap().remove("usage");
    });
    assert_eq!(
        analyze_text("claude", &text).unwrap_err(),
        "insufficient_turn_metadata"
    );
}

#[test]
fn regression_replaced_candidate_must_not_read_new_stable_target() {
    let fixture = Fixture::new();
    let source_dir = fixture.0.join("source");
    fs::create_dir(&source_dir).unwrap();
    let source = source_dir.join("session.jsonl");
    fs::write(&source, CLAUDE).unwrap();
    let candidate =
        resolver::canonical_candidate(&source, &[fs::canonicalize(&fixture.0).unwrap()]).unwrap();
    fs::rename(&source_dir, fixture.0.join("old-source")).unwrap();
    fs::create_dir(&source_dir).unwrap();
    fs::write(&source, CLAUDE).unwrap();
    assert_eq!(
        reader::read_candidate(&candidate, &mut budget()).err(),
        Some("source_changed")
    );
}

#[test]
fn missing_stream_usage_is_allowed_only_when_same_request_is_completed_later() {
    let text = replace_line(CLAUDE, 1, |v| {
        v["message"].as_object_mut().unwrap().remove("usage");
    });
    let result = analyze_text("claude", &text).unwrap();
    assert_eq!(result.turns[0].usage.request_count, 2);
    assert_eq!(result.turns[0].usage.output_tokens, 30);
}

#[test]
fn replay_of_old_user_after_new_turn_is_rejected() {
    let mut lines: Vec<_> = CODEX.lines().collect();
    let old_user = lines[3];
    lines.insert(14, old_user);
    assert_eq!(
        analyze_text("codex", &(lines.join("\n") + "\n")).unwrap_err(),
        "unsupported_session_shape"
    );
}

#[test]
fn codex_without_event_id_or_native_turn_identity_is_unavailable() {
    let text = replace_line(CODEX, 3, |v| {
        v["payload"].as_object_mut().unwrap().remove("id");
    });
    let text: String = text
        .lines()
        .filter(|line| !line.contains("turn_context") && !line.contains("task_started"))
        .map(|line| format!("{line}\n"))
        .collect();
    assert_eq!(
        analyze_text("codex", &text).unwrap_err(),
        "insufficient_turn_metadata"
    );
}
