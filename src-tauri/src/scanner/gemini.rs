use super::checkpoints::*;
use super::helpers::*;
use super::types::LogRecord;
use chrono::TimeZone;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[cfg(test)]
use super::runner::persist_scan_batch;
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const GEMINI_CLI_CHECKPOINT_SOURCE_KIND: &str = "gemini-cli-chats-v2";
const GEMINI_MAX_COUNTER: i64 = 1_000_000_000;

/// Gemini CLI stores chat transcripts under `~/.gemini/tmp/<project>/chats/`.
/// Newer builds append one JSON object per line (`session-*.jsonl`, first line
/// is a session header); older builds write the whole session as one JSON
/// document (`session-*.json`). Assistant messages carry a `tokens` object in
/// both layouts. The AntGravity scanner reads `~/.gemini/antigravity/brain`
/// and never touches this `tmp` subtree, so the two stay disjoint.
pub(crate) fn gemini_chats_root(gemini_home: &Path) -> PathBuf {
    gemini_home.join("tmp")
}

pub(crate) fn gemini_home_dir() -> PathBuf {
    gemini_home_dir_from(std::env::var_os("GEMINI_CLI_HOME"), get_home_dir())
}

fn gemini_home_dir_from(value: Option<std::ffi::OsString>, default_home: PathBuf) -> PathBuf {
    let base = value
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_home);
    base.join(".gemini")
}

fn gemini_record_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn scan_gemini(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    scan_gemini_root(
        &gemini_chats_root(&gemini_home_dir()),
        logs,
        checkpoints,
        pending_checkpoints,
    )
}

pub(crate) fn scan_gemini_root(
    chats_root: &Path,
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    if !chats_root.is_dir() {
        return 0;
    }
    // Layout: `<tmp>/<project>/chats/**/*.{json,jsonl}`. Main sessions use a
    // `session-` filename while subagents are nested under `chats/<parent>/`
    // and use their bare session id. Collect and sort for deterministic order,
    // while restricting matches to the chats subtree and known document types.
    let mut files: Vec<PathBuf> = WalkDir::new(chats_root)
        .max_depth(8)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            let is_chat_path = entry
                .path()
                .strip_prefix(chats_root)
                .ok()
                .is_some_and(|relative| {
                    relative
                        .components()
                        .any(|component| component.as_os_str() == "chats")
                });
            let is_session_document = entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| matches!(ext, "json" | "jsonl"));
            is_chat_path && is_session_document
        })
        .map(|entry| entry.into_path())
        .collect();
    files.sort();

    let mut count = 0;
    for filepath in files {
        let Some(before) =
            checkpointed_file_before(&filepath, GEMINI_CLI_CHECKPOINT_SOURCE_KIND, checkpoints)
        else {
            continue;
        };
        let file_logs_before = logs.len();
        let parse_complete = if filepath.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            gemini_parse_jsonl_file(&filepath, logs)
        } else {
            gemini_parse_json_file(&filepath, logs)
        };
        let file_count = logs.len() - file_logs_before;
        // Only checkpoint files that parsed without hard failures; a partially
        // read or mid-write file resurfaces next scan via the fingerprint.
        if parse_complete {
            finish_checkpointed_file(
                &filepath,
                before,
                GEMINI_CLI_CHECKPOINT_SOURCE_KIND,
                pending_checkpoints,
            );
        } else {
            log::warn!(
                "gemini: leaving checkpoint unchanged after an incomplete read of {}",
                filepath.display()
            );
        }
        count += file_count;
    }
    count
}

/// Newer layout: one JSON object per line. The first line is a session header
/// (`kind`/`sessionId`); assistant lines carry `type == "gemini"` plus a
/// `tokens` object. Malformed lines are skipped without aborting the file.
fn gemini_parse_jsonl_file(filepath: &Path, logs: &mut Vec<LogRecord>) -> bool {
    let Ok(file) = File::open(filepath) else {
        return false;
    };
    let reader = BufReader::new(file);
    let mut session_id = gemini_session_hint(filepath);
    let mut lines = reader.lines().enumerate().peekable();
    while let Some((line_index, line)) = lines.next() {
        let Ok(line) = line else {
            return false;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
            log::warn!(
                "gemini: skipping malformed line {} in {}",
                line_index + 1,
                filepath.display()
            );
            if lines.peek().is_none() {
                return false;
            }
            continue;
        };
        if event.get("kind").is_some() {
            if let Some(id) = event
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                session_id = id.to_string();
            }
            continue;
        }
        if let Some(record) = gemini_message_record(&event, &session_id, line_index) {
            logs.push(record);
        }
    }
    true
}

/// Older layout: the whole session is one JSON document with a `messages`
/// array and a top-level `sessionId`.
fn gemini_parse_json_file(filepath: &Path, logs: &mut Vec<LogRecord>) -> bool {
    let Ok(content) = fs::read_to_string(filepath) else {
        return false;
    };
    let Ok(session) = serde_json::from_str::<Value>(&content) else {
        log::warn!(
            "gemini: skipping malformed session file {}",
            filepath.display()
        );
        return false;
    };
    let session_id = session
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| gemini_session_hint(filepath));
    for (message_index, message) in session
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if let Some(record) = gemini_message_record(message, &session_id, message_index) {
            logs.push(record);
        }
    }
    true
}

fn gemini_session_hint(filepath: &Path) -> String {
    filepath
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown_session")
        .to_string()
}

/// Turns one assistant message with a `tokens` object into a ledger row.
/// Gemini CLI records the API's `promptTokenCount` (which includes cached
/// content), `candidatesTokenCount`, `cachedContentTokenCount`, optional
/// `thoughtsTokenCount`, and `totalTokenCount`. The ledger stores net input and
/// output including thoughts, so cache volume is not counted twice and thinking
/// work is not silently dropped.
fn gemini_message_record(
    message: &Value,
    session_id: &str,
    fallback_position: usize,
) -> Option<LogRecord> {
    // Only assistant completion rows carry billable Gemini usage. Other
    // transcript events may contain token-like metadata for tools or previews;
    // accepting them would double-count a request.
    if message.get("type").and_then(Value::as_str) != Some("gemini") {
        return None;
    }
    let tokens = message.get("tokens")?;
    let prompt = gemini_counter(tokens, "input")?;
    let candidates = gemini_counter(tokens, "output")?;
    let cached = gemini_counter(tokens, "cached")?;
    let thoughts = gemini_optional_counter(tokens, "thoughts")?;
    // `total` is required by Gemini CLI's TokensSummary.  Without it we
    // cannot prove whether a cache-bearing prompt is inclusive or already
    // netted, so fail closed instead of guessing the accounting semantics.
    let total = gemini_counter(tokens, "total")?;
    let input = prompt.checked_sub(cached)?;
    let output = candidates.checked_add(thoughts)?;
    let official_total = prompt.checked_add(candidates)?.checked_add(thoughts)?;
    let legacy_total = prompt
        .checked_add(candidates)?
        .checked_add(thoughts)?
        .checked_add(cached)?;
    if total != official_total && total != legacy_total {
        return None;
    }
    // Legacy Gemini captures wrote net input but included cache in total;
    // preserve that historical shape while the official shape above is
    // normalized to net input. Both forms remain auditable by the equation.
    let input = if total == legacy_total { prompt } else { input };
    gemini_record_with_usage(
        message,
        session_id,
        fallback_position,
        input,
        output,
        cached,
    )
}

fn gemini_record_with_usage(
    message: &Value,
    session_id: &str,
    fallback_position: usize,
    input: i64,
    output: i64,
    cached: i64,
) -> Option<LogRecord> {
    if input <= 0 && output <= 0 && cached <= 0 {
        return None;
    }
    let timestamp = message
        .get("timestamp")
        .or_else(|| message.get("lastUpdated"))
        .and_then(gemini_timestamp)?;
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(clean_model_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "gemini-unknown".to_string());
    let message_id = message
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        // Older .json sessions have no message ids; the per-file array position
        // is stable because messages only append.
        .unwrap_or_else(|| format!("line-{fallback_position}"));
    let unique_key = format!(
        "gemini_cli_{}_{}",
        gemini_record_hash(session_id),
        gemini_record_hash(&message_id)
    );
    Some(LogRecord {
        tool: "gemini".to_string(),
        model,
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
        cache_write_tokens: 0,
        timestamp,
        session_id: session_id.to_string(),
        unique_key,
        cost_usd: None,
        cumulative: false,
    })
}

/// Gemini counters are integer token counts. Required fields must be present;
/// optional fields may be absent but malformed, fractional, negative, or
/// out-of-range values must not enter the ledger as fabricated zeroes.
fn gemini_counter(tokens: &Value, name: &str) -> Option<i64> {
    tokens.get(name).and_then(gemini_counter_value)
}

fn gemini_optional_counter(tokens: &Value, name: &str) -> Option<i64> {
    let Some(value) = tokens.get(name) else {
        return Some(0);
    };
    gemini_counter_value(value)
}

pub(crate) fn gemini_counter_value(value: &Value) -> Option<i64> {
    let parsed = match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok())),
        Value::String(raw) => raw.trim().parse::<i64>().ok(),
        _ => None,
    }?;
    (0..=GEMINI_MAX_COUNTER).contains(&parsed).then_some(parsed)
}

/// `normalize_timestamp` intentionally has a wall-clock fallback for legacy
/// sources. Gemini must reject malformed timestamps instead, otherwise one
/// broken message would be silently assigned the current time. Formatting is
/// done here directly so a value accepted by validation can never fall back to
/// the current wall-clock time during normalization.
pub(crate) fn gemini_timestamp(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => number
            .as_f64()
            .and_then(gemini_epoch_seconds)
            .and_then(gemini_format_epoch),
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(trimmed) {
                Some(
                    parsed
                        .with_timezone(&chrono::Local)
                        .format("%Y-%m-%d %H:%M:%S")
                        .to_string(),
                )
            } else {
                let cleaned = trimmed.replace('T', " ").replace('Z', "");
                let (without_fraction, fraction_valid) = match cleaned.split_once('.') {
                    Some((base, fraction)) => (
                        base,
                        !fraction.is_empty() && fraction.chars().all(|ch| ch.is_ascii_digit()),
                    ),
                    None => (cleaned.as_str(), true),
                };
                if fraction_valid {
                    if let Ok(parsed) =
                        chrono::NaiveDateTime::parse_from_str(without_fraction, "%Y-%m-%d %H:%M:%S")
                    {
                        return Some(parsed.format("%Y-%m-%d %H:%M:%S").to_string());
                    }
                }
                trimmed
                    .parse::<f64>()
                    .ok()
                    .and_then(gemini_epoch_seconds)
                    .and_then(gemini_format_epoch)
            }
        }
        _ => None,
    }
}

fn gemini_epoch_seconds(value: f64) -> Option<f64> {
    if !value.is_finite() || value < 0.0 {
        return None;
    }
    let seconds = if value > 1e11 { value / 1000.0 } else { value };
    if seconds < i64::MIN as f64 || seconds > i64::MAX as f64 {
        return None;
    }
    chrono::Local
        .timestamp_opt(seconds as i64, 0)
        .single()
        .map(|_| seconds)
}

fn gemini_format_epoch(seconds: f64) -> Option<String> {
    chrono::Local
        .timestamp_opt(seconds as i64, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
}

#[cfg(test)]
mod scanner_gemini_tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap as StdHashMap;

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tokenledger_gemini_test_{suffix}"));
        fs::create_dir_all(&root).expect("create gemini test root");
        root
    }

    fn write_jsonl_session(project: &str, filename: &str, lines: &[Value]) -> PathBuf {
        let dir = temp_root().join("tmp").join(project).join("chats");
        fs::create_dir_all(&dir).expect("create chats dir");
        let path = dir.join(filename);
        let mut content = String::new();
        for line in lines {
            content.push_str(&line.to_string());
            content.push('\n');
        }
        fs::write(&path, content).expect("write jsonl session");
        path
    }

    fn write_json_session(project: &str, filename: &str, session: &Value) -> PathBuf {
        let dir = temp_root().join("tmp").join(project).join("chats");
        fs::create_dir_all(&dir).expect("create chats dir");
        let path = dir.join(filename);
        fs::write(&path, session.to_string()).expect("write json session");
        path
    }

    fn gemini_message(id: &str, model: &str, input: i64, output: i64, cached: i64) -> Value {
        let prompt = input + cached;
        let thoughts = if input == 0 && output == 0 && cached == 0 {
            0
        } else {
            292
        };
        json!({
            "id": id,
            "type": "gemini",
            "model": model,
            "timestamp": "2026-08-19T00:40:03.421Z",
            "tokens": {
                "input": prompt,
                "output": output,
                "cached": cached,
                "thoughts": thoughts,
                "tool": 0,
                "total": prompt + output + thoughts
            }
        })
    }

    fn user_message() -> Value {
        json!({
            "id": "u1",
            "type": "user",
            "timestamp": "2026-08-19T00:39:53.525Z",
            "content": [{"text": "hi"}]
        })
    }

    #[test]
    fn parses_new_jsonl_layout_with_session_header() {
        let path = write_jsonl_session(
            "demo-user",
            "session-2026-08-19T00-39-0ac01f74.jsonl",
            &[
                json!({
                    "kind": "chat",
                    "sessionId": "0ac01f74-a7a1-400b-8ac5-408ae4c97cac",
                    "startTime": "2026-08-19T00:39:53.525Z"
                }),
                user_message(),
                gemini_message("m1", "gemini-3.5-flash", 16438, 12, 0),
            ],
        );
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        let count = scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut Vec::new());
        assert_eq!(count, 1);
        let record = &logs[0];
        assert_eq!(record.tool, "gemini");
        assert_eq!(record.model, "gemini-3.5-flash");
        assert_eq!(record.input_tokens, 16438);
        assert_eq!(record.output_tokens, 304);
        assert_eq!(record.cached_tokens, 0);
        assert_eq!(record.cache_write_tokens, 0);
        assert_eq!(record.session_id, "0ac01f74-a7a1-400b-8ac5-408ae4c97cac");
        assert!(record.unique_key.starts_with("gemini_cli_"));
        assert!(!record.cumulative);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scans_nested_subagent_sessions_and_ignores_non_documents() {
        let root = temp_root().join("tmp").join("proj");
        let chats = root.join("chats").join("parent-session");
        fs::create_dir_all(&chats).expect("create subagent chats dir");
        fs::write(
            chats.join("child-session.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"sessionId":"child-session","projectHash":"p","kind":"subagent"}),
                gemini_message("child-message", "gemini-3.5-flash", 100, 5, 0)
            ),
        )
        .expect("write subagent session");
        fs::write(
            root.join("chats").join("session-backup.txt"),
            gemini_message("ignored", "gemini-3.5-flash", 999, 999, 0).to_string(),
        )
        .expect("write non-document");
        let mut logs = Vec::new();
        let count = scan_gemini_root(&root, &mut logs, &StdHashMap::new(), &mut Vec::new());
        assert_eq!(count, 1);
        assert_eq!(logs[0].session_id, "child-session");
        let _ = fs::remove_dir_all(root.parent().expect("tmp root"));
    }

    #[test]
    fn custom_cli_home_resolves_to_dot_gemini_storage() {
        assert_eq!(
            gemini_home_dir_from(Some("/isolated".into()), PathBuf::from("/default")),
            PathBuf::from("/isolated/.gemini")
        );
        assert_eq!(
            gemini_home_dir_from(None, PathBuf::from("/default")),
            PathBuf::from("/default/.gemini")
        );
    }

    #[test]
    fn parses_old_json_layout_with_messages_array() {
        let path = write_json_session(
            "2604",
            "session-2026-04-13T04-33-f3f3c7a5.json",
            &json!({
                "sessionId": "f3f3c7a5-session",
                "startTime": "2026-04-13T04:33:00.000Z",
                "messages": [
                    user_message(),
                    gemini_message("m1", "gemini-3.1-pro", 15754, 256, 12699),
                    gemini_message("m2", "gemini-3.1-pro", 11089, 231, 0),
                ]
            }),
        );
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        let count = scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut Vec::new());
        assert_eq!(count, 2);
        assert!(logs.iter().all(|r| r.session_id == "f3f3c7a5-session"));
        assert_eq!(logs[0].input_tokens, 15754);
        assert_eq!(logs[0].cached_tokens, 12699);
        assert_eq!(logs[1].input_tokens, 11089);
        assert_ne!(logs[0].unique_key, logs[1].unique_key);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn official_usage_normalizes_prompt_cache_and_thoughts() {
        let path = write_jsonl_session(
            "proj",
            "session-2026-08-19T00-40-official.jsonl",
            &[
                json!({"kind": "chat", "sessionId": "s-official"}),
                gemini_message("m1", "gemini-3.5-flash", 70, 7, 30),
            ],
        );
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        assert_eq!(
            scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut Vec::new()),
            1
        );
        assert_eq!(logs[0].input_tokens, 70);
        assert_eq!(logs[0].output_tokens, 299);
        assert_eq!(logs[0].cached_tokens, 30);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn old_json_without_message_ids_uses_stable_array_positions() {
        let mut first = gemini_message("m1", "gemini-3.1-pro", 15754, 256, 12699);
        let mut second = gemini_message("m2", "gemini-3.1-pro", 11089, 231, 0);
        first.as_object_mut().expect("first object").remove("id");
        second.as_object_mut().expect("second object").remove("id");
        let path = write_json_session(
            "2604",
            "session-2026-04-13T04-33-f3f3c7a5.json",
            &json!({
                "sessionId": "f3f3c7a5-session",
                "messages": [user_message(), first, second]
            }),
        );
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        let count = scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut Vec::new());
        assert_eq!(count, 2);
        assert_ne!(logs[0].unique_key, logs[1].unique_key);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn message_without_model_falls_back_to_placeholder() {
        let path = write_jsonl_session(
            "temp",
            "session-2026-08-18T12-47-0adbbd08.jsonl",
            &[json!({"kind": "chat", "sessionId": "s-no-model"}), {
                let mut m = gemini_message("m1", "", 100, 5, 0);
                m.as_object_mut().expect("obj").remove("model");
                m
            }],
        );
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut Vec::new());
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].model, "gemini-unknown");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn blank_model_falls_back_to_placeholder() {
        let path = write_jsonl_session(
            "temp",
            "session-2026-08-18T12-47-blank-model.jsonl",
            &[json!({"kind": "chat", "sessionId": "s-blank-model"}), {
                let mut m = gemini_message("m1", "gemini-3.5-flash", 100, 5, 0);
                m.as_object_mut()
                    .expect("obj")
                    .insert("model".to_string(), json!("   "));
                m
            }],
        );
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut Vec::new());
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].model, "gemini-unknown");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn all_zero_tokens_and_noise_files_are_ignored() {
        let dir = temp_root().join("tmp").join("proj").join("chats");
        fs::create_dir_all(&dir).expect("create chats dir");
        fs::write(
            dir.join("session-2026-01-01T00-00-zero.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"kind": "chat", "sessionId": "s-zero"}),
                gemini_message("m0", "gemini-3.5-flash", 0, 0, 0)
            ),
        )
        .expect("write zero session");
        // Non-session files under tmp must not be scanned.
        fs::create_dir_all(dir.parent().expect("proj").join("bin")).expect("create bin dir");
        fs::write(
            dir.parent()
                .expect("proj")
                .join("bin")
                .join("tool-output.json"),
            gemini_message("noise", "gemini-3.5-flash", 999, 999, 0).to_string(),
        )
        .expect("write noise file");
        let tokenized_non_assistant = json!({
            "id": "tool-preview",
            "type": "tool",
            "timestamp": "2026-08-19T00:40:03.421Z",
            "tokens": {"input": 999, "output": 999, "cached": 0}
        });
        fs::write(
            dir.join("session-2026-01-02T00-00-tokenized-tool.jsonl"),
            format!(
                "{}\n{}\n",
                json!({"kind": "chat", "sessionId": "s-tool"}),
                tokenized_non_assistant
            ),
        )
        .expect("write tokenized non-assistant session");
        let root = dir.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        let count = scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut Vec::new());
        assert_eq!(count, 0);
        assert!(logs.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_line_is_skipped_without_aborting() {
        let path = write_jsonl_session(
            "proj",
            "session-2026-08-19T01-00-broken.jsonl",
            &[
                json!({"kind": "chat", "sessionId": "s-broken"}),
                json!({"not": "an object"}),
                gemini_message("m1", "gemini-3.5-flash", 42, 7, 0),
            ],
        );
        // Corrupt the second line into invalid JSON.
        let content = fs::read_to_string(&path).expect("read session");
        let lines: Vec<&str> = content.lines().collect();
        let mut fixed = String::new();
        fixed.push_str(lines[0]);
        fixed.push('\n');
        fixed.push_str("{not json");
        fixed.push('\n');
        fixed.push_str(lines[2]);
        fixed.push('\n');
        fs::write(&path, fixed).expect("rewrite session");
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let count = scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut pending);
        assert_eq!(count, 1);
        assert_eq!(pending.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_trailing_line_does_not_advance_checkpoint() {
        let path = write_jsonl_session(
            "proj",
            "session-2026-08-19T01-00-trailing.jsonl",
            &[
                json!({"kind": "chat", "sessionId": "s-trailing"}),
                gemini_message("m1", "gemini-3.5-flash", 42, 7, 0),
            ],
        );
        let mut content = fs::read_to_string(&path).expect("read session");
        content.push_str("{incomplete");
        fs::write(&path, content).expect("rewrite trailing session");
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut pending),
            1
        );
        assert!(pending.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_json_file_does_not_advance_checkpoint() {
        let dir = temp_root().join("tmp").join("proj").join("chats");
        fs::create_dir_all(&dir).expect("create chats dir");
        let path = dir.join("session-2026-08-19T01-00-broken.json");
        fs::write(&path, "{not json").expect("write broken session");
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut pending),
            0
        );
        assert!(pending.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_counters_and_timestamps_are_ignored() {
        let dir = temp_root().join("tmp").join("proj").join("chats");
        fs::create_dir_all(&dir).expect("create chats dir");
        let path = dir.join("session-2026-08-19T01-00-invalid.jsonl");
        let negative = gemini_message("negative", "gemini-3.5-flash", -1, 5, 0);
        let mut fractional = gemini_message("fractional", "gemini-3.5-flash", 1, 5, 0);
        let mut bad_time = gemini_message("bad-time", "gemini-3.5-flash", 1, 5, 0);
        fractional
            .pointer_mut("/tokens/input")
            .expect("fractional input")
            .clone_from(&json!(1.5));
        bad_time
            .as_object_mut()
            .expect("bad time object")
            .insert("timestamp".to_string(), json!("not-a-time"));
        fs::write(
            &path,
            format!(
                "{}\n{}\n{}\n{}\n",
                json!({"kind":"chat","sessionId":"s-invalid"}),
                negative,
                fractional,
                bad_time
            ),
        )
        .expect("write invalid session");
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        assert_eq!(
            scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut Vec::new()),
            0
        );
        assert!(logs.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_or_overflowed_usage_fields_are_ignored() {
        let path = write_jsonl_session(
            "proj",
            "session-2026-08-19T01-00-missing.jsonl",
            &[
                json!({"kind": "chat", "sessionId": "s-missing"}),
                json!({
                    "id":"missing-input", "type":"gemini", "timestamp":"2026-08-19T00:40:03Z",
                    "tokens":{"output":5,"cached":0,"thoughts":0,"total":5}
                }),
                json!({
                    "id":"missing-total", "type":"gemini", "timestamp":"2026-08-19T00:40:03Z",
                    "tokens":{"input":5,"output":5,"cached":0,"thoughts":0}
                }),
                json!({
                    "id":"too-large", "type":"gemini", "timestamp":"2026-08-19T00:40:03Z",
                    "tokens":{"input":1000000001,"output":1,"cached":0,"thoughts":0,"total":1000000002}
                }),
            ],
        );
        let root = path.ancestors().nth(2).expect("tmp root");
        let mut logs = Vec::new();
        assert_eq!(
            scan_gemini_root(root, &mut logs, &StdHashMap::new(), &mut Vec::new()),
            0
        );
        assert!(logs.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn epoch_timestamp_validation_is_fail_closed_and_supports_numeric_strings() {
        assert!(gemini_timestamp(&json!(-1)).is_none());
        assert!(gemini_timestamp(&json!("-1")).is_none());
        assert!(gemini_timestamp(&json!("1e9"))
            .as_deref()
            .is_some_and(|timestamp| timestamp.starts_with("2001-09-09 ")));
    }

    #[test]
    fn missing_root_yields_zero() {
        let root = temp_root().join("absent");
        let mut logs = Vec::new();
        assert_eq!(
            scan_gemini_root(&root, &mut logs, &StdHashMap::new(), &mut Vec::new()),
            0
        );
    }

    #[test]
    fn two_scan_rounds_are_idempotent_and_checkpoint_skips_unchanged_file() {
        let path = write_jsonl_session(
            "demo-user",
            "session-2026-08-19T00-39-0ac01f74.jsonl",
            &[
                json!({"kind": "chat", "sessionId": "0ac01f74-a7a1-400b-8ac5-408ae4c97cac"}),
                user_message(),
                gemini_message("m1", "gemini-3.5-flash", 16438, 12, 0),
            ],
        );
        let root = path.ancestors().nth(2).expect("tmp root").to_path_buf();
        let db_path = root.parent().expect("test root").join("tokenboard.db");
        crate::db::init_test_db(&db_path).expect("initialize gemini fixture db");

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_gemini_root(&root, &mut logs, &StdHashMap::new(), &mut pending),
            1
        );
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None)
            .expect("persist gemini scan batch");
        assert_eq!(outcome.inserted, 1);

        let conn = crate::db::get_connection(&db_path).expect("open gemini fixture db");
        let checkpoints =
            crate::db::load_scan_checkpoints(&conn, GEMINI_CLI_CHECKPOINT_SOURCE_KIND)
                .expect("load gemini checkpoints");
        drop(conn);

        let mut repeated_logs = Vec::new();
        let mut repeated_pending = Vec::new();
        assert_eq!(
            scan_gemini_root(
                &root,
                &mut repeated_logs,
                &checkpoints,
                &mut repeated_pending
            ),
            0
        );
        assert!(repeated_logs.is_empty());
        assert!(repeated_pending.is_empty());

        // Appending a new assistant message resurfaces the file and only the
        // new row enters the database.
        let mut appended = fs::read_to_string(&path).expect("read session");
        appended.push_str(&gemini_message("m2", "gemini-3.5-flash", 16454, 19, 0).to_string());
        appended.push('\n');
        fs::write(&path, appended).expect("append message");
        let mut changed_logs = Vec::new();
        let mut changed_pending = Vec::new();
        assert_eq!(
            scan_gemini_root(&root, &mut changed_logs, &checkpoints, &mut changed_pending),
            2
        );
        let outcome = persist_scan_batch(&db_path, changed_logs, changed_pending, Vec::new(), None)
            .expect("persist appended batch");
        assert_eq!(outcome.inserted, 1);

        let _ = fs::remove_dir_all(root.parent().expect("test root"));
    }

    #[test]
    #[ignore = "requires an explicitly authorized local Gemini home directory"]
    fn reads_authorized_real_gemini_home() {
        let root = std::env::var_os("TOKENLEDGER_GEMINI_REAL_HOME")
            .map(PathBuf::from)
            .expect("set TOKENLEDGER_GEMINI_REAL_HOME explicitly")
            .join("tmp");
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let scanned = scan_gemini_root(&root, &mut logs, &StdHashMap::new(), &mut pending);
        assert!(scanned > 0);
        assert_eq!(logs.len(), scanned);
        assert!(logs.iter().all(|record| record.tool == "gemini"));
        assert!(logs
            .iter()
            .all(|record| record.unique_key.starts_with("gemini_cli_")));
        let total_input: i64 = logs.iter().map(|r| r.input_tokens).sum();
        let total_output: i64 = logs.iter().map(|r| r.output_tokens).sum();
        let total_cached: i64 = logs.iter().map(|r| r.cached_tokens).sum();
        println!(
            "REAL rows={scanned} input={total_input} output={total_output} cached={total_cached}"
        );
        for record in logs.iter().take(5) {
            println!(
                "REAL model={} input={} output={} cached={} ts={} key={}",
                record.model,
                record.input_tokens,
                record.output_tokens,
                record.cached_tokens,
                record.timestamp,
                record.unique_key
            );
        }
    }
}
