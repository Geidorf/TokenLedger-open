use super::checkpoints::*;
use super::helpers::*;
use super::jsonl::bounded_lines;
use super::types::LogRecord;
use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[cfg(test)]
use super::runner::persist_scan_batch;

/// Pi (the `pi` coding agent / `@earendil-works/pi-coding-agent`) appends one
/// JSONL session file per conversation. The file is a tree, not a log of the
/// active leaf, so every branch inside the file is a request that really
/// happened and has to be counted.
pub(crate) const PI_CHECKPOINT_SOURCE_KIND: &str = "pi-session-jsonl-v1";

/// Roots that hold Pi session files.
///
/// Two roots are needed because Multica Desktop does not use Pi's default
/// location: it spawns Pi with an explicit session dir under
/// `~/.multica/pi-sessions` (one flat directory shared by every task), so those
/// runs never show up under `~/.pi`. This is the same class of gap as the
/// Multica `codex-home` rollout root (see T10.142), only Pi keeps a single
/// global directory.
///
/// Pi's own default is `<agentDir>/sessions/<encoded-cwd>/`, where `agentDir`
/// is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` overrides it, and the whole
/// session root can be replaced by `PI_CODING_AGENT_SESSION_DIR` (or
/// `--session-dir`) — an explicit session dir wins over the derived per-cwd
/// layout, so the default root is not scanned in that case.
pub(crate) fn pi_session_roots_from(
    home: &Path,
    session_dir: Option<&OsStr>,
    agent_dir: Option<&OsStr>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    match session_dir {
        Some(session_dir) => roots.push(PathBuf::from(session_dir)),
        None => {
            let agent_dir = agent_dir
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".pi/agent"));
            roots.push(agent_dir.join("sessions"));
        }
    }
    roots.push(home.join(".multica/pi-sessions"));
    roots
}

pub(crate) fn pi_session_roots(home: &Path) -> Vec<PathBuf> {
    let session_dir = std::env::var_os("PI_CODING_AGENT_SESSION_DIR");
    let agent_dir = std::env::var_os("PI_CODING_AGENT_DIR");
    let mut roots = pi_session_roots_from(home, session_dir.as_deref(), agent_dir.as_deref());
    roots.extend(super::cindy::cindy_pi_roots_in(home));
    roots
}

fn pi_hash_prefix(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Session files are `*.jsonl`. The zero-byte `<name>.jsonl.lock` sibling that
/// a live session keeps is not picked up because its extension is `lock`.
fn is_pi_session_file(path: &Path) -> bool {
    path.is_file() && path.extension().and_then(OsStr::to_str) == Some("jsonl")
}

/// Pi timestamps are either Unix milliseconds (`message.timestamp`) or ISO-8601
/// strings (entry `timestamp`). Unlike `normalize_timestamp`, an unparseable
/// value yields `None` so the row is skipped instead of being stamped "now".
fn pi_timestamp(value: &Value) -> Option<String> {
    let format = |datetime: DateTime<Local>| datetime.format("%Y-%m-%d %H:%M:%S").to_string();
    match value {
        Value::Number(_) => {
            let raw = value.as_i64()?;
            if raw <= 0 {
                return None;
            }
            let datetime = if raw > 100_000_000_000 {
                Local.timestamp_millis_opt(raw).single()
            } else {
                Local.timestamp_opt(raw, 0).single()
            }?;
            Some(format(datetime))
        }
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            if let Ok(datetime) = DateTime::parse_from_rfc3339(text) {
                return Some(format(datetime.with_timezone(&Local)));
            }
            // Epoch seconds/milliseconds serialized as a string.
            if text.chars().all(|ch| ch.is_ascii_digit()) {
                if let Ok(raw) = text.parse::<i64>() {
                    if raw <= 0 {
                        return None;
                    }
                    let datetime = if raw > 100_000_000_000 {
                        Local.timestamp_millis_opt(raw).single()
                    } else {
                        Local.timestamp_opt(raw, 0).single()
                    }?;
                    return Some(format(datetime));
                }
            }
            let naive_source = text.replace('T', " ");
            let naive = naive_source.split('.').next().unwrap_or(&naive_source);
            let datetime = NaiveDateTime::parse_from_str(naive, "%Y-%m-%d %H:%M:%S").ok()?;
            Some(datetime.format("%Y-%m-%d %H:%M:%S").to_string())
        }
        _ => None,
    }
}

/// Raw timestamp used as part of the dedupe key. Numbers keep their exact
/// serialized form so a key never depends on the machine's timezone.
fn pi_entry_raw_timestamp(entry: &Value) -> Option<&Value> {
    entry
        .get("message")
        .and_then(|message| message.get("timestamp"))
        .filter(|value| !value.is_null())
        .or_else(|| entry.get("timestamp").filter(|value| !value.is_null()))
}

/// Usage carried by one session entry, if any.
///
/// - `message` entries bill when the role is `assistant` (the model call) or
///   `toolResult` (LLM work nested inside a tool). `stopReason == "error"` /
///   `"aborted"` rows consumed tokens too, so they are not filtered out.
/// - `compaction` and `branch_summary` entries may carry a top-level `usage`
///   for the summary call that pi itself counts into session totals.
fn pi_entry_usage(entry: &Value) -> Option<&Value> {
    let usage = match entry.get("type").and_then(Value::as_str) {
        Some("message") => {
            let message = entry.get("message")?;
            match message.get("role").and_then(Value::as_str) {
                Some("assistant") | Some("toolResult") => message.get("usage"),
                _ => None,
            }
        }
        Some("compaction") | Some("branch_summary") => entry.get("usage"),
        _ => None,
    }?;
    usage.is_object().then_some(usage)
}

/// Dedupe identity for one usage row.
///
/// Pi entry ids are the identity of the session tree and are copied verbatim
/// when `/fork` (or `/clone`) mints a **new** session id and replays the
/// retained path into a new file. Keying on `session id + entry id` would count
/// that already-billed prefix twice, so the key is entry-scoped: the 96-bit
/// entry id hash plus the raw millisecond timestamp (which also survives the
/// copy) keeps different sessions' entries apart without exposing any local
/// path. Malformed entries without an id fall back to their line number.
fn pi_record_key(entry: &Value, raw_timestamp: &Value, line_index: usize) -> String {
    let timestamp_hash = pi_hash_prefix(&raw_timestamp.to_string());
    match entry
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        Some(id) => format!("pi_{}_{}", pi_hash_prefix(id), timestamp_hash),
        None => format!("pi_L{}_{}", line_index + 1, timestamp_hash),
    }
}

enum PiFileOutcome {
    /// Session file parsed; the checkpoint may advance.
    Parsed(usize),
    /// Not a Pi session file (no `type == "session"` header); nothing to check.
    NotASession,
}

/// Parses one session file. `Err` means the file could not be read to the end,
/// so the caller must not advance the checkpoint past the unread tail.
fn scan_pi_file(
    filepath: &Path,
    logs: &mut Vec<LogRecord>,
) -> std::result::Result<PiFileOutcome, String> {
    let file = match File::open(filepath) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Session files can disappear between discovery and open (Pi's
            // interactive delete, or Multica cleanup). That is not a failure.
            log::debug!(
                "pi: session vanished before reading: {}",
                filepath.display()
            );
            return Ok(PiFileOutcome::NotASession);
        }
        Err(error) => {
            return Err(format!(
                "failed to open Pi session {}: {error}",
                filepath.display()
            ));
        }
    };
    let reader = BufReader::new(file);
    let mut session_id: Option<String> = None;
    let mut current_model = String::new();
    let mut parsed = 0;
    let mut seen_keys = HashSet::new();

    for (line_index, line) in bounded_lines(reader).enumerate() {
        let line = line.map_err(|error| {
            format!("failed to read Pi session {}: {error}", filepath.display())
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if session_id.is_none() {
            // First line is the session header. Its `id` is the session
            // identity; Multica file names are timestamps and must not be used.
            let Ok(header) = serde_json::from_str::<Value>(trimmed) else {
                return Ok(PiFileOutcome::NotASession);
            };
            if header.get("type").and_then(Value::as_str) != Some("session") {
                return Ok(PiFileOutcome::NotASession);
            }
            session_id = Some(
                header
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        filepath
                            .file_stem()
                            .and_then(OsStr::to_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "pi-session".to_string()),
            );
            continue;
        }

        let Ok(entry) = serde_json::from_str::<Value>(trimmed) else {
            // A live session can end in a half-written line; it is skipped here
            // and picked up by the next scan, which reparses any changed file
            // from byte zero.
            log::debug!(
                "pi: skipping unparsable line {} in {}",
                line_index + 1,
                filepath.display()
            );
            continue;
        };

        let entry_type = entry.get("type").and_then(Value::as_str);
        if entry_type == Some("model_change") {
            if let Some(model) = entry
                .get("modelId")
                .and_then(Value::as_str)
                .filter(|model| !model.is_empty())
            {
                current_model = clean_model_name(model);
            }
        }

        let message = entry.get("message");
        let message_model = message
            .and_then(|message| message.get("model"))
            .and_then(Value::as_str)
            .filter(|model| !model.is_empty());
        if entry_type == Some("message")
            && message.and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant")
        {
            if let Some(model) = message_model {
                current_model = clean_model_name(model);
            }
        }

        let Some(usage) = pi_entry_usage(&entry) else {
            continue;
        };
        let Some(raw_timestamp) = pi_entry_raw_timestamp(&entry) else {
            continue;
        };
        let Some(timestamp) = pi_timestamp(raw_timestamp) else {
            continue;
        };

        let input_tokens = to_int(usage.get("input").unwrap_or(&Value::Null));
        let output_tokens = to_int(usage.get("output").unwrap_or(&Value::Null));
        let cache_read = to_int(usage.get("cacheRead").unwrap_or(&Value::Null));
        let cache_write = to_int(usage.get("cacheWrite").unwrap_or(&Value::Null));
        if [input_tokens, output_tokens, cache_read, cache_write]
            .iter()
            .any(|value| *value < 0)
        {
            continue;
        }
        // Only a fully zero usage row is skipped. `reasoning` is a subset of
        // `output` and `totalTokens` equals input + output + cacheRead +
        // cacheWrite, so neither is ever added on top.
        if input_tokens == 0 && output_tokens == 0 && cache_read == 0 && cache_write == 0 {
            continue;
        }
        let Some(cached_tokens) = cache_read.checked_add(cache_write) else {
            continue;
        };
        if let Some(total) = usage.get("totalTokens").and_then(Value::as_i64) {
            let expected = input_tokens
                .saturating_add(output_tokens)
                .saturating_add(cache_read)
                .saturating_add(cache_write);
            if total != expected {
                log::debug!(
                    "pi: totalTokens {total} does not match input + output + cache ({expected}) in {}",
                    filepath.display()
                );
            }
        }

        let unique_key = pi_record_key(&entry, raw_timestamp, line_index);
        if !seen_keys.insert(unique_key.clone()) {
            continue;
        }

        // An assistant message names the model of that call; nested tool calls,
        // compaction and branch summaries reuse the session's current model.
        let model = match message_model {
            Some(model) if entry_type == Some("message") => clean_model_name(model),
            _ => current_model.clone(),
        };
        let model = if model.is_empty() {
            "pi-unknown".to_string()
        } else {
            model
        };

        logs.push(LogRecord {
            tool: "pi".to_string(),
            model,
            input_tokens,
            output_tokens,
            cached_tokens,
            cache_write_tokens: cache_write,
            timestamp,
            session_id: session_id.clone().unwrap_or_default(),
            unique_key,
            cost_usd: None,
            cumulative: false,
        });
        parsed += 1;
    }

    Ok(match session_id {
        Some(_) => PiFileOutcome::Parsed(parsed),
        // An empty file is not a session yet; leave it unchecked so the header
        // written by the running agent is picked up on a later scan.
        None => PiFileOutcome::NotASession,
    })
}

pub(crate) fn scan_pi_roots_checkpointed(
    roots: &[PathBuf],
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    logs: &mut Vec<LogRecord>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let mut count = 0;
    let mut visited_files = HashSet::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        // Session files sit one level down in Multica's flat session dir and two
        // levels down in Pi's `<sessions>/<encoded-cwd>/` layout.
        for entry in WalkDir::new(root).max_depth(3) {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    log::warn!("pi: failed to walk session root: {error}");
                    continue;
                }
            };
            let filepath = entry.path();
            if !is_pi_session_file(filepath) {
                continue;
            }
            let Some(before) =
                checkpointed_file_before(filepath, PI_CHECKPOINT_SOURCE_KIND, checkpoints)
            else {
                continue;
            };
            // Overlapping roots (an explicit session dir that also sits under a
            // scanned root) must not parse the same file twice.
            if !visited_files.insert(before.normalized_path.clone()) {
                continue;
            }
            match scan_pi_file(filepath, logs) {
                Ok(PiFileOutcome::Parsed(parsed)) => {
                    count += parsed;
                    finish_checkpointed_file(
                        filepath,
                        before,
                        PI_CHECKPOINT_SOURCE_KIND,
                        pending_checkpoints,
                    );
                }
                Ok(PiFileOutcome::NotASession) => {}
                Err(error) => log::warn!("pi: {error}"),
            }
        }
    }
    count
}

pub(crate) fn scan_pi(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let roots = pi_session_roots(&get_home_dir());
    scan_pi_roots_checkpointed(&roots, checkpoints, logs, pending_checkpoints)
}

#[cfg(test)]
mod scanner_pi_tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> PathBuf {
        static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);
        let now_nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = NEXT_TEMP_ROOT.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "tokenledger_pi_test_{}_{}_{}",
            std::process::id(),
            now_nanos,
            sequence
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn header(id: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "session",
            "version": 3,
            "id": id,
            "timestamp": "2026-09-17T04:08:46.475Z",
            "cwd": "C:\\work"
        })
    }

    fn usage(input: i64, output: i64, cache_read: i64, cache_write: i64) -> serde_json::Value {
        serde_json::json!({
            "input": input,
            "output": output,
            "cacheRead": cache_read,
            "cacheWrite": cache_write,
            "totalTokens": input + output + cache_read + cache_write
        })
    }

    fn assistant(
        id: &str,
        parent: &str,
        timestamp: i64,
        model: &str,
        usage: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::json!({
            "type": "message",
            "id": id,
            "parentId": parent,
            "timestamp": "2026-09-17T04:08:47.000Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "hi"}],
                "api": "openai-completions",
                "provider": "bcnw",
                "model": model,
                "usage": usage,
                "stopReason": "stop",
                "timestamp": timestamp
            }
        })
    }

    fn write_lines(path: &Path, lines: &[serde_json::Value]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = File::create(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn append_line(path: &Path, raw: &str) {
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        writeln!(file, "{raw}").unwrap();
    }

    fn scan(paths: &[PathBuf]) -> (usize, Vec<LogRecord>, Vec<crate::db::ScanCheckpoint>) {
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_pi_roots_checkpointed(paths, &HashMap::new(), &mut logs, &mut pending);
        (parsed, logs, pending)
    }

    #[test]
    fn parses_net_usage_and_ignores_reasoning_and_total() {
        let root = temp_root();
        let sessions = root.join("sessions");
        let file = sessions.join("20260917T040927.784477700.jsonl");
        let mut usage = usage(9773, 1734, 37504, 0);
        usage["reasoning"] = serde_json::json!(983);
        write_lines(
            &file,
            &[
                header("01a0ad8d-7e8b-7618-8aaa-0da7e84da050"),
                serde_json::json!({
                    "type": "message",
                    "id": "e7e1e336",
                    "parentId": "a63fb5d1",
                    "timestamp": "2026-09-17T04:08:47.000Z",
                    "message": {
                        "role": "assistant",
                        "provider": "bcnw",
                        "model": "bcnw/deepseek-v4-flash",
                        "usage": usage,
                        "stopReason": "error",
                        "timestamp": 1789618126791i64
                    }
                }),
            ],
        );

        let (parsed, logs, pending) = scan(std::slice::from_ref(&sessions));
        assert_eq!(parsed, 1);
        assert_eq!(logs.len(), 1);
        let record = &logs[0];
        assert_eq!(record.tool, "pi");
        // Provider prefixes are stripped, like every other scanner.
        assert_eq!(record.model, "deepseek-v4-flash");
        assert_eq!(record.input_tokens, 9773);
        assert_eq!(record.output_tokens, 1734);
        assert_eq!(record.cached_tokens, 37504);
        assert_eq!(record.cache_write_tokens, 0);
        // Session identity comes from the header, not the timestamp file name.
        assert_eq!(record.session_id, "01a0ad8d-7e8b-7618-8aaa-0da7e84da050");
        assert!(record.cost_usd.is_none());
        assert!(!record.cumulative);
        // A local wall-clock timestamp, and a key that leaks no local path.
        assert_eq!(record.timestamp.len(), 19);
        assert!(record.unique_key.starts_with("pi_"));
        assert!(!record.unique_key.contains("sessions"));
        assert!(!record.unique_key.contains("2026"));
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].source_kind, PI_CHECKPOINT_SOURCE_KIND);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn counts_every_branch_and_summary_usage() {
        let root = temp_root();
        let sessions = root.join("sessions");
        let file = sessions.join("session.jsonl");
        write_lines(
            &file,
            &[
                header("branch-session"),
                serde_json::json!({"type": "model_change", "id": "a0000001", "parentId": null, "timestamp": "2026-09-17T04:00:00.000Z", "provider": "anthropic", "modelId": "claude-sonnet-4-5"}),
                assistant(
                    "b0000001",
                    "a0000001",
                    1789617000000,
                    "claude-sonnet-4-5",
                    usage(100, 20, 5, 1),
                ),
                // Abandoned branch: still a real request, must be counted.
                assistant(
                    "b0000002",
                    "b0000001",
                    1789617001000,
                    "claude-sonnet-4-5",
                    usage(200, 30, 0, 0),
                ),
                // Compaction summary call carried on the entry itself.
                serde_json::json!({
                    "type": "compaction",
                    "id": "c0000001",
                    "parentId": "b0000002",
                    "timestamp": "2026-09-17T04:10:00.000Z",
                    "summary": "…",
                    "usage": {"input": 50, "output": 10, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 60}
                }),
                serde_json::json!({
                    "type": "branch_summary",
                    "id": "d0000001",
                    "parentId": "c0000001",
                    "timestamp": "2026-09-17T04:15:00.000Z",
                    "summary": "…",
                    "usage": {"input": 60, "output": 12, "cacheRead": 4, "cacheWrite": 0, "totalTokens": 76}
                }),
                // Nested LLM work performed by a tool.
                serde_json::json!({
                    "type": "message",
                    "id": "e0000001",
                    "parentId": "d0000001",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call_1",
                        "toolName": "task",
                        "content": [{"type": "text", "text": "ok"}],
                        "usage": {"input": 7, "output": 3, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 10},
                        "isError": false,
                        "timestamp": 1789617300000i64
                    }
                }),
                // A user message can never bill.
                serde_json::json!({"type": "message", "id": "f0000001", "parentId": "e0000001", "message": {"role": "user", "content": "hi", "timestamp": 1789617301000i64}}),
            ],
        );

        let (parsed, logs, _) = scan(std::slice::from_ref(&sessions));
        assert_eq!(parsed, 5);
        // Every row inherits the session's current model.
        assert!(logs.iter().all(|log| log.model == "claude-sonnet-4-5"));
        assert_eq!(
            logs.iter().map(|log| log.input_tokens).sum::<i64>(),
            100 + 200 + 50 + 60 + 7
        );
        assert_eq!(
            logs.iter()
                .map(|log| log.unique_key.as_str())
                .collect::<HashSet<_>>()
                .len(),
            5
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn skips_zero_missing_and_negative_usage_and_lock_files() {
        let root = temp_root();
        let sessions = root.join("sessions");
        let file = sessions.join("session.jsonl");
        write_lines(
            &file,
            &[
                header("skip-session"),
                serde_json::json!({
                    "type": "message",
                    "id": "a1000001",
                    "parentId": null,
                    "message": {"role": "assistant", "model": "m", "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}, "timestamp": 1789617000000i64}
                }),
                serde_json::json!({"type": "message", "id": "a1000002", "parentId": "a1000001", "message": {"role": "assistant", "model": "m", "timestamp": 1789617001000i64}}),
                serde_json::json!({
                    "type": "message",
                    "id": "a1000003",
                    "parentId": "a1000002",
                    "message": {"role": "assistant", "model": "m", "usage": {"input": -5, "output": 3, "cacheRead": 0, "cacheWrite": 0}, "timestamp": 1789617002000i64}
                }),
                // No parseable timestamp.
                serde_json::json!({
                    "type": "message",
                    "id": "a1000004",
                    "parentId": "a1000003",
                    "message": {"role": "assistant", "model": "m", "usage": {"input": 5, "output": 3}, "timestamp": "not-a-time"}
                }),
                // A toolResult without usage carries nothing.
                serde_json::json!({"type": "message", "id": "a1000005", "parentId": "a1000004", "message": {"role": "toolResult", "toolName": "bash", "content": [], "isError": false, "timestamp": 1789617003000i64}}),
                // Zero-byte lock sibling of a live session.
            ],
        );
        write_lines(&sessions.join("session.jsonl.lock"), &[]);

        let (parsed, logs, _) = scan(std::slice::from_ref(&sessions));
        assert_eq!(parsed, 0);
        assert!(logs.is_empty());

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn counts_appends_and_tolerates_a_half_written_tail() {
        let root = temp_root();
        let sessions = root.join("sessions");
        let file = sessions.join("live.jsonl");
        write_lines(
            &file,
            &[
                header("live-session"),
                assistant("11111111", "", 1789617000000, "m1", usage(10, 2, 0, 0)),
            ],
        );

        let (parsed, logs, pending) = scan(std::slice::from_ref(&sessions));
        assert_eq!(parsed, 1);
        assert_eq!(logs.len(), 1);
        // Persist the checkpoint so the next pass exercises the skip path.
        let db_path = root.join("pi-test.db");
        crate::db::init_db(&db_path).unwrap();
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 1);

        // Half-written trailing line: skipped, and the file stays checkpointable.
        let turn = assistant(
            "22222222",
            "11111111",
            1789617005000,
            "m2",
            usage(20, 4, 1, 0),
        );
        let turn_line = format!("{turn}\n");
        let split_at = turn_line.len() / 2;
        let mut file_handle = OpenOptions::new().append(true).open(&file).unwrap();
        file_handle
            .write_all(&turn_line.as_bytes()[..split_at])
            .unwrap();
        file_handle.flush().unwrap();
        drop(file_handle);
        let conn = crate::db::get_connection(&db_path).unwrap();
        let checkpoints =
            crate::db::load_scan_checkpoints(&conn, PI_CHECKPOINT_SOURCE_KIND).unwrap();
        drop(conn);
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_pi_roots_checkpointed(
            std::slice::from_ref(&sessions),
            &checkpoints,
            &mut logs,
            &mut pending,
        );
        // A changed file is reparsed from byte zero, so the already-persisted
        // first turn reappears here (its key collides in SQLite). The
        // half-written tail is not valid JSON yet, so it contributes nothing.
        assert_eq!(parsed, 1);
        assert_eq!(logs.len(), 1);

        // Once the writer completes that same line, the changed file is
        // reparsed from byte zero: the unchanged first row collides on its key
        // instead of double counting, and only the new turn is inserted.
        append_line(&file, turn_line[split_at..].trim_end_matches('\n'));

        let conn = crate::db::get_connection(&db_path).unwrap();
        let checkpoints =
            crate::db::load_scan_checkpoints(&conn, PI_CHECKPOINT_SOURCE_KIND).unwrap();
        drop(conn);
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_pi_roots_checkpointed(
            std::slice::from_ref(&sessions),
            &checkpoints,
            &mut logs,
            &mut pending,
        );
        assert_eq!(parsed, 2);
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 1, "only the new turn is inserted");

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn unchanged_file_is_checkpoint_skipped_and_persist_is_idempotent() {
        let root = temp_root();
        let sessions = root.join("sessions");
        let file = sessions.join("stable.jsonl");
        write_lines(
            &file,
            &[
                header("stable-session"),
                assistant("aaaa1111", "", 1789617000000, "m1", usage(10, 2, 0, 0)),
            ],
        );

        let db_path = root.join("pi-stable.db");
        crate::db::init_db(&db_path).unwrap();
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_pi_roots_checkpointed(
            std::slice::from_ref(&sessions),
            &HashMap::new(),
            &mut logs,
            &mut pending,
        );
        assert_eq!(parsed, 1);
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 1);

        let conn = crate::db::get_connection(&db_path).unwrap();
        let checkpoints =
            crate::db::load_scan_checkpoints(&conn, PI_CHECKPOINT_SOURCE_KIND).unwrap();
        drop(conn);
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_pi_roots_checkpointed(
                std::slice::from_ref(&sessions),
                &checkpoints,
                &mut logs,
                &mut pending
            ),
            0
        );
        assert!(logs.is_empty());

        // Even without a checkpoint, the key keeps INSERT OR IGNORE idempotent.
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_pi_roots_checkpointed(
                std::slice::from_ref(&sessions),
                &HashMap::new(),
                &mut logs,
                &mut pending
            ),
            1
        );
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 0);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn forked_session_copy_does_not_double_count_the_replayed_prefix() {
        let root = temp_root();
        let sessions = root.join("sessions");
        let original = sessions.join("original.jsonl");
        let replayed = assistant(
            "deadbeef",
            "aaaa0000",
            1789617000000,
            "m1",
            usage(10, 2, 0, 0),
        );
        write_lines(
            &original,
            &[
                header("parent-session"),
                replayed.clone(),
                assistant(
                    "cafe0001",
                    "deadbeef",
                    1789617001000,
                    "m1",
                    usage(30, 4, 0, 0),
                ),
            ],
        );
        // `/fork` mints a new session id and replays the retained path verbatim.
        let fork = sessions.join("fork.jsonl");
        write_lines(
            &fork,
            &[
                header("fork-session"),
                replayed,
                assistant(
                    "feed0001",
                    "deadbeef",
                    1789617005000,
                    "m2",
                    usage(40, 8, 0, 0),
                ),
            ],
        );

        let (parsed, mut logs, _) = scan(std::slice::from_ref(&sessions));
        assert_eq!(parsed, 4);
        assert_eq!(
            logs.iter()
                .map(|log| log.unique_key.clone())
                .collect::<HashSet<_>>()
                .len(),
            3,
            "the replayed turn shares the parent's key"
        );

        let db_path = root.join("pi-fork.db");
        crate::db::init_db(&db_path).unwrap();
        let outcome = persist_scan_batch(
            &db_path,
            std::mem::take(&mut logs),
            Vec::new(),
            Vec::new(),
            None,
        )
        .unwrap();
        assert_eq!(outcome.inserted, 3);
        let conn = crate::db::get_connection(&db_path).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_logs WHERE tool = 'pi'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 3);
        drop(conn);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn roots_follow_pi_env_overrides_and_keep_the_multica_directory() {
        let home = Path::new("/users/tester");
        let default_roots = pi_session_roots_from(home, None, None);
        assert_eq!(
            default_roots,
            vec![
                PathBuf::from("/users/tester/.pi/agent/sessions"),
                PathBuf::from("/users/tester/.multica/pi-sessions"),
            ]
        );

        let agent_dir_roots = pi_session_roots_from(home, None, Some(OsStr::new("/custom/agent")));
        assert_eq!(agent_dir_roots[0], PathBuf::from("/custom/agent/sessions"));
        assert_eq!(
            agent_dir_roots[1],
            PathBuf::from("/users/tester/.multica/pi-sessions")
        );

        // An explicit session dir replaces Pi's derived per-cwd layout.
        let explicit = pi_session_roots_from(home, Some(OsStr::new("/data/pi")), None);
        assert_eq!(explicit[0], PathBuf::from("/data/pi"));
        assert!(!explicit.contains(&PathBuf::from("/users/tester/.pi/agent/sessions")));
    }

    #[test]
    fn non_session_jsonl_and_missing_roots_are_ignored() {
        let root = temp_root();
        let sessions = root.join("sessions");
        write_lines(
            &sessions.join("unrelated.jsonl"),
            &[serde_json::json!({"type": "something-else", "usage": {"input": 5}})],
        );

        let (parsed, logs, pending) = scan(&[sessions.clone(), root.join("does-not-exist")]);
        assert_eq!(parsed, 0);
        assert!(logs.is_empty());
        assert!(pending.is_empty());

        fs::remove_dir_all(root).ok();
    }

    /// Real-machine probe: scans the actual Pi session roots on this host
    /// (Multica's `~/.multica/pi-sessions` plus Pi's own default root).
    ///
    /// Ignored by default because it depends on this machine's Pi/Multica
    /// installations and on live session files that keep growing. Run with:
    /// `cargo test -- --ignored pi_real_machine_probe --nocapture`
    ///
    /// Only aggregate counters are printed; session bodies (prompts, tool
    /// output) never leave the machine.
    #[test]
    #[ignore = "requires a real Pi / Multica Desktop installation on this machine"]
    fn pi_real_machine_probe() {
        let roots = pi_session_roots(&get_home_dir());
        let existing: Vec<&PathBuf> = roots.iter().filter(|root| root.is_dir()).collect();
        println!("discovered roots: {}", roots.len());
        println!("existing roots: {}", existing.len());
        for root in &existing {
            println!("  {root:?}");
        }
        if existing.is_empty() {
            println!("no Pi session root present; nothing to scan");
            return;
        }

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        scan_pi_roots_checkpointed(&roots, &HashMap::new(), &mut logs, &mut pending);
        let input: i64 = logs.iter().map(|log| log.input_tokens).sum();
        let output: i64 = logs.iter().map(|log| log.output_tokens).sum();
        let cached: i64 = logs.iter().map(|log| log.cached_tokens).sum();
        let cache_write: i64 = logs.iter().map(|log| log.cache_write_tokens).sum();
        let unique: HashSet<&str> = logs.iter().map(|log| log.unique_key.as_str()).collect();
        println!(
            "logs={} unique_keys={} input={input} output={output} cached={cached} cache_write={cache_write} effective={}",
            logs.len(),
            unique.len(),
            input + output
        );
        assert_eq!(
            logs.len(),
            unique.len(),
            "real session rows must be unique within one scan"
        );
        assert!(!logs.is_empty(), "real machine has Pi session usage");
    }
}
