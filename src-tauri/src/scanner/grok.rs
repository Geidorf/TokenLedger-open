use super::checkpoints::*;
use super::helpers::*;
use super::jsonl::{bounded_lines, read_text_capped, MAX_SIDECAR_BYTES};
use super::types::LogRecord;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[cfg(test)]
use super::runner::persist_scan_batch;
#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const GROK_CHECKPOINT_SOURCE_KIND: &str = "grok-unified-jsonl-v1";

pub(crate) fn grok_home(home: &Path) -> PathBuf {
    home.join(".grok")
}

fn grok_record_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn grok_nonnegative(value: &Value, field: &str) -> Option<i64> {
    value
        .get(field)
        .and_then(|value| value.as_i64().filter(|value| *value >= 0))
}

/// Grok CLI keeps one global append-only log at `~/.grok/logs/unified.jsonl`.
/// Only `msg == "shell.turn.inference_done"` rows carry per-request token
/// usage; everything else in the file is noise from unrelated subsystems.
pub(crate) fn scan_grok(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    scan_grok_root(
        &grok_home(&get_home_dir()),
        logs,
        checkpoints,
        pending_checkpoints,
    )
}

pub(crate) fn scan_grok_root(
    root: &Path,
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let unified_log = root.join("logs/unified.jsonl");
    if !unified_log.is_file() {
        return 0;
    }
    let Some(before) =
        checkpointed_file_before(&unified_log, GROK_CHECKPOINT_SOURCE_KIND, checkpoints)
    else {
        return 0;
    };
    let session_models = grok_session_models(&root.join("sessions"));
    let count = grok_parse_unified_log(&unified_log, &session_models, logs);
    finish_checkpointed_file(
        &unified_log,
        before,
        GROK_CHECKPOINT_SOURCE_KIND,
        pending_checkpoints,
    );
    count
}

/// Model names live outside the unified log: each session directory stores a
/// `summary.json` whose `current_model_id` names the model used by that `sid`.
fn grok_session_models(sessions_root: &Path) -> HashMap<String, String> {
    let mut models = HashMap::new();
    // Layout: `sessions/<url-encoded-cwd>/<session-uuid>/summary.json`.
    let entries: Vec<_> = WalkDir::new(sessions_root)
        .max_depth(3)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .collect();
    for entry in entries {
        if !entry.file_type().is_file() || entry.file_name() != "summary.json" {
            continue;
        }
        let Ok(content) = read_text_capped(entry.path(), MAX_SIDECAR_BYTES) else {
            continue;
        };
        let Ok(summary) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        // Session ids appear at the top level in older Grok builds and nested
        // under `info.id` in newer ones; accept both.
        let session_id = summary
            .get("id")
            .or_else(|| summary.pointer("/info/id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let Some(session_id) = session_id else {
            continue;
        };
        if let Some(model) = summary
            .get("current_model_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            models.insert(session_id.to_string(), clean_model_name(model));
        }
    }
    models
}

fn grok_parse_unified_log(
    unified_log: &Path,
    session_models: &HashMap<String, String>,
    logs: &mut Vec<LogRecord>,
) -> usize {
    let Ok(file) = File::open(unified_log) else {
        return 0;
    };
    let reader = BufReader::new(file);
    let mut file_logs = Vec::new();
    for (line_index, line) in bounded_lines(reader).enumerate() {
        let Ok(line) = line else {
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
            log::warn!(
                "grok: skipping malformed line {} in {}",
                line_index + 1,
                unified_log.display()
            );
            continue;
        };
        if event.get("msg").and_then(Value::as_str) != Some("shell.turn.inference_done") {
            continue;
        }
        let Some(session_id) = event
            .get("sid")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(ctx) = event.get("ctx") else {
            continue;
        };
        let prompt_tokens = grok_nonnegative(ctx, "prompt_tokens").unwrap_or(0);
        let cached = grok_nonnegative(ctx, "cached_prompt_tokens")
            .unwrap_or(0)
            .min(prompt_tokens);
        let output_tokens = grok_nonnegative(ctx, "completion_tokens").unwrap_or(0);
        let Some(timestamp) = event.get("ts").and_then(parse_timestamp) else {
            continue;
        };
        // `prompt_tokens` is inclusive of cache hits (OpenAI-style), so the
        // fresh share is netted here, matching the Codex/DSH scanners.
        let input_tokens = prompt_tokens - cached;
        let model = session_models
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| "grok-unknown".to_string());
        let loop_index = grok_nonnegative(ctx, "loop_index").unwrap_or(0);
        let unique_key = format!(
            "grok_{}_{}",
            grok_record_hash(session_id),
            grok_record_hash(&format!("{session_id}|{timestamp}|{loop_index}"))
        );
        file_logs.push(LogRecord {
            tool: "grok".to_string(),
            model,
            input_tokens,
            output_tokens,
            cached_tokens: cached,
            cache_write_tokens: 0,
            timestamp,
            session_id: session_id.to_string(),
            unique_key,
            cost_usd: None,
            cumulative: false,
        });
    }
    let count = file_logs.len();
    logs.extend(file_logs);
    count
}

#[cfg(test)]
mod scanner_grok_tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap as StdHashMap;

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tokenledger_grok_test_{suffix}"));
        fs::create_dir_all(&root).expect("create grok test root");
        root
    }

    const SESSION_ID: &str = "01a014e0-892f-7223-85ca-2b9e4cdc37ca";

    fn inference_done(
        ts: &str,
        prompt: i64,
        cached: i64,
        completion: i64,
        loop_index: i64,
    ) -> String {
        json!({
            "ts": ts,
            "src": "shell",
            "pid": 65244,
            "ver": "1.0.5",
            "lvl": "info",
            "sid": SESSION_ID,
            "msg": "shell.turn.inference_done",
            "ctx": {
                "loop_index": loop_index,
                "model_elapsed_ms": 625621,
                "ttft_ms": 1090,
                "attempts": 2,
                "prompt_tokens": prompt,
                "cached_prompt_tokens": cached,
                "completion_tokens": completion,
                "reasoning_tokens": 76,
                "tokens_per_sec": 0.9
            }
        })
        .to_string()
    }

    fn write_fixture(root: &Path, lines: &[String], with_summary: bool, model: &str) {
        let grok = root.join(".grok");
        fs::create_dir_all(grok.join("logs")).expect("create logs dir");
        let mut content = lines.to_vec().join("\n");
        if !content.is_empty() {
            content.push('\n');
        }
        fs::write(grok.join("logs/unified.jsonl"), content).expect("write unified.jsonl");
        if with_summary {
            let session_dir = grok
                .join("sessions")
                .join("C_%3A_%5CUsers_%5Cdemo-user")
                .join(SESSION_ID);
            fs::create_dir_all(&session_dir).expect("create session dir");
            fs::write(
                session_dir.join("summary.json"),
                json!({
                    "id": SESSION_ID,
                    "current_model_id": model,
                    "created_at": "2026-08-18T12:00:00.000Z"
                })
                .to_string(),
            )
            .expect("write summary.json");
        }
    }

    fn noise_line(msg: &str) -> String {
        json!({
            "ts": "2026-08-18T12:00:00.000Z",
            "src": "shell",
            "sid": SESSION_ID,
            "msg": msg,
            "ctx": {"prompt_tokens": 999, "completion_tokens": 999}
        })
        .to_string()
    }

    #[test]
    fn parses_inference_done_with_net_input_and_session_model() {
        let root = temp_root();
        write_fixture(
            &root,
            &[
                noise_line("auth.token_refresh"),
                noise_line("model.catalog_loaded"),
                inference_done("2026-08-18T12:48:21.665Z", 19000, 18944, 562, 1),
            ],
            true,
            "grok-4.6",
        );
        let mut logs = Vec::new();
        let count = scan_grok_root(
            &root.join(".grok"),
            &mut logs,
            &StdHashMap::new(),
            &mut Vec::new(),
        );
        assert_eq!(count, 1);
        assert_eq!(logs.len(), 1);
        let record = &logs[0];
        assert_eq!(record.tool, "grok");
        assert_eq!(record.model, "grok-4.6");
        assert_eq!(record.input_tokens, 19000 - 18944);
        assert_eq!(record.cached_tokens, 18944);
        assert_eq!(record.cache_write_tokens, 0);
        assert_eq!(record.output_tokens, 562);
        assert_eq!(record.session_id, SESSION_ID);
        assert!(record.unique_key.starts_with("grok_"));
        assert!(!record.cumulative);
        assert!(record.cost_usd.is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_session_falls_back_to_placeholder_model() {
        let root = temp_root();
        write_fixture(
            &root,
            &[inference_done("2026-08-18T12:48:21.665Z", 100, 0, 5, 1)],
            false,
            "",
        );
        let mut logs = Vec::new();
        let count = scan_grok_root(
            &root.join(".grok"),
            &mut logs,
            &StdHashMap::new(),
            &mut Vec::new(),
        );
        assert_eq!(count, 1);
        assert_eq!(logs[0].model, "grok-unknown");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_larger_than_prompt_is_clamped() {
        let root = temp_root();
        write_fixture(
            &root,
            &[inference_done("2026-08-18T12:48:21.665Z", 100, 500, 5, 1)],
            false,
            "",
        );
        let mut logs = Vec::new();
        scan_grok_root(
            &root.join(".grok"),
            &mut logs,
            &StdHashMap::new(),
            &mut Vec::new(),
        );
        assert_eq!(logs[0].input_tokens, 0);
        assert_eq!(logs[0].cached_tokens, 100);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn malformed_line_is_skipped_without_aborting() {
        let root = temp_root();
        let mut lines = vec![noise_line("auth.token_refresh"), "{not json".to_string()];
        lines.push(inference_done("2026-08-18T13:00:00.000Z", 42, 0, 7, 1));
        write_fixture(&root, &lines, false, "");
        let mut logs = Vec::new();
        let count = scan_grok_root(
            &root.join(".grok"),
            &mut logs,
            &StdHashMap::new(),
            &mut Vec::new(),
        );
        assert_eq!(count, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn distinct_loops_of_same_turn_stay_deduplicated() {
        let root = temp_root();
        write_fixture(
            &root,
            &[
                inference_done("2026-08-18T12:48:21.665Z", 100, 0, 5, 1),
                inference_done("2026-08-18T12:48:21.665Z", 100, 0, 5, 2),
                inference_done("2026-08-18T12:48:21.665Z", 100, 0, 5, 1),
            ],
            false,
            "",
        );
        let mut logs = Vec::new();
        let count = scan_grok_root(
            &root.join(".grok"),
            &mut logs,
            &StdHashMap::new(),
            &mut Vec::new(),
        );
        assert_eq!(count, 3);
        let keys: Vec<&str> = logs.iter().map(|r| r.unique_key.as_str()).collect();
        let unique_keys: std::collections::HashSet<&str> = keys.iter().copied().collect();
        assert_eq!(unique_keys.len(), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unparseable_timestamps_are_skipped_instead_of_keyed_by_now() {
        // A wall-clock fallback would feed "now" into the unique key and
        // re-insert the record on every scan.
        let root = temp_root();
        write_fixture(
            &root,
            &[
                inference_done("not-a-time", 100, 10, 5, 0),
                inference_done("2026-08-18T12:00:00.000Z", 200, 20, 7, 1),
            ],
            false,
            "",
        );
        let scan = || {
            let mut logs = Vec::new();
            scan_grok_root(
                &root.join(".grok"),
                &mut logs,
                &StdHashMap::new(),
                &mut Vec::new(),
            );
            logs.into_iter()
                .map(|log| log.unique_key)
                .collect::<Vec<_>>()
        };
        let first = scan();
        assert_eq!(first.len(), 1);
        assert_eq!(scan(), first);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_log_dir_yields_zero() {
        let root = temp_root();
        let mut logs = Vec::new();
        let count = scan_grok_root(
            &root.join(".grok"),
            &mut logs,
            &StdHashMap::new(),
            &mut Vec::new(),
        );
        assert_eq!(count, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_scan_rounds_are_idempotent_and_checkpoint_skips_unchanged_file() {
        let root = temp_root();
        let grok = root.join(".grok");
        write_fixture(
            &root,
            &[
                noise_line("auth.token_refresh"),
                inference_done("2026-08-18T12:48:21.665Z", 19000, 18944, 562, 1),
            ],
            true,
            "grok-4.6",
        );
        let db_path = root.join("tokenboard.db");
        crate::db::init_test_db(&db_path).expect("initialize grok fixture db");

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_grok_root(&grok, &mut logs, &StdHashMap::new(), &mut pending),
            1
        );
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None)
            .expect("persist grok scan batch");
        assert_eq!(outcome.inserted, 1);

        let conn = crate::db::get_connection(&db_path).expect("open grok fixture db");
        let totals = conn
            .query_row(
                "SELECT COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cached_tokens), SUM(cache_write_tokens)
                 FROM token_logs WHERE tool = 'grok'",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .expect("query grok totals");
        assert_eq!(totals, (1, 56, 562, 18_944, 0));
        let checkpoints = crate::db::load_scan_checkpoints(&conn, GROK_CHECKPOINT_SOURCE_KIND)
            .expect("load grok checkpoints");
        drop(conn);

        let mut repeated_logs = Vec::new();
        let mut repeated_pending = Vec::new();
        assert_eq!(
            scan_grok_root(
                &grok,
                &mut repeated_logs,
                &checkpoints,
                &mut repeated_pending
            ),
            0
        );
        assert!(repeated_logs.is_empty());
        assert!(repeated_pending.is_empty());

        // Appending new rows invalidates the checkpoint and only the new
        // record enters the database; the old unique_key is deduplicated.
        let mut appended =
            fs::read_to_string(grok.join("logs/unified.jsonl")).expect("read unified.jsonl");
        appended.push_str(&inference_done("2026-08-18T14:00:00.000Z", 300, 100, 9, 1));
        appended.push('\n');
        fs::write(grok.join("logs/unified.jsonl"), appended).expect("append new row");
        let mut changed_logs = Vec::new();
        let mut changed_pending = Vec::new();
        assert_eq!(
            scan_grok_root(&grok, &mut changed_logs, &checkpoints, &mut changed_pending),
            2
        );
        let outcome = persist_scan_batch(&db_path, changed_logs, changed_pending, Vec::new(), None)
            .expect("persist appended batch");
        assert_eq!(outcome.inserted, 1);

        fs::remove_dir_all(&root).expect("remove grok test root");
    }

    #[test]
    #[ignore = "requires an explicitly authorized local Grok home directory"]
    fn reads_authorized_real_grok_home() {
        let root = std::env::var_os("TOKENLEDGER_GROK_REAL_HOME")
            .map(PathBuf::from)
            .expect("set TOKENLEDGER_GROK_REAL_HOME explicitly");
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let scanned = scan_grok_root(&root, &mut logs, &StdHashMap::new(), &mut pending);
        assert!(scanned > 0);
        assert_eq!(logs.len(), scanned);
        assert!(logs.iter().all(|record| record.tool == "grok"));
        assert!(logs
            .iter()
            .all(|record| record.unique_key.starts_with("grok_")));
        assert!(logs
            .iter()
            .any(|record| record.input_tokens + record.cached_tokens > 0));
        for record in &logs {
            println!(
                "REAL model={} input={} cached={} output={} ts={} sid={} key={}",
                record.model,
                record.input_tokens,
                record.cached_tokens,
                record.output_tokens,
                record.timestamp,
                record.session_id,
                record.unique_key
            );
        }
    }
}
