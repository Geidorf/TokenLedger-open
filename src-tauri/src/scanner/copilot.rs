use super::checkpoints::*;
use super::gemini::{gemini_counter_value, gemini_timestamp};
use super::helpers::*;
use super::types::LogRecord;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub(crate) const COPILOT_CLI_CHECKPOINT_SOURCE_KIND: &str = "copilot-cli-events-jsonl-v1";

/// GitHub Copilot CLI keeps one event log per session at
/// `<COPILOT_HOME or ~/.copilot>/session-state/<sessionId>/events.jsonl`.
/// Per-call `assistant.usage` events are ephemeral and never reach disk; the
/// only persisted usage is the per-model breakdown in `session.shutdown`
/// (`data.modelMetrics.<model>.usage`). Nothing else under the Copilot home
/// (config, auth, MCP or plugin files) is opened.
pub(crate) fn copilot_session_state_dir() -> PathBuf {
    copilot_session_state_dir_from(std::env::var_os("COPILOT_HOME"), get_home_dir())
}

fn copilot_session_state_dir_from(
    copilot_home: Option<std::ffi::OsString>,
    home: PathBuf,
) -> PathBuf {
    copilot_home
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".copilot"))
        .join("session-state")
}

fn copilot_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn scan_copilot(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    scan_copilot_dir(
        &copilot_session_state_dir(),
        logs,
        checkpoints,
        pending_checkpoints,
    )
}

pub(crate) fn scan_copilot_dir(
    session_state: &Path,
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let Ok(entries) = std::fs::read_dir(session_state) else {
        return 0;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().join("events.jsonl"))
        .filter(|path| path.is_file())
        .collect();
    files.sort();

    let mut count = 0;
    for filepath in files {
        let Some(before) =
            checkpointed_file_before(&filepath, COPILOT_CLI_CHECKPOINT_SOURCE_KIND, checkpoints)
        else {
            continue;
        };
        let file_logs_before = logs.len();
        let parse_complete = copilot_parse_events_file(&filepath, logs);
        count += logs.len() - file_logs_before;
        if parse_complete {
            finish_checkpointed_file(
                &filepath,
                before,
                COPILOT_CLI_CHECKPOINT_SOURCE_KIND,
                pending_checkpoints,
            );
        } else {
            log::warn!(
                "copilot: leaving checkpoint unchanged after an incomplete read of {}",
                filepath.display()
            );
        }
    }
    count
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CopilotUsage {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
}

impl CopilotUsage {
    fn covers(&self, previous: &Self) -> bool {
        self.input >= previous.input
            && self.output >= previous.output
            && self.cache_read >= previous.cache_read
            && self.cache_write >= previous.cache_write
    }

    fn minus(&self, previous: &Self) -> Self {
        Self {
            input: self.input - previous.input,
            output: self.output - previous.output,
            cache_read: self.cache_read - previous.cache_read,
            cache_write: self.cache_write - previous.cache_write,
        }
    }
}

/// Every `session.shutdown` in a log becomes one row per model. A resumed
/// session writes another shutdown later in the same file; when its totals
/// cover the previous shutdown's for that model they are session-wide
/// running totals and only the growth is booked, otherwise (a counter went
/// down) they restarted with the resumed process and are booked as they are.
/// Rows are keyed by the shutdown event id, so rescans are idempotent.
fn copilot_parse_events_file(filepath: &Path, logs: &mut Vec<LogRecord>) -> bool {
    let Ok(file) = File::open(filepath) else {
        return false;
    };
    let fallback_session = filepath
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown_session")
        .to_string();
    let mut session_id = fallback_session;
    let mut previous: BTreeMap<String, CopilotUsage> = BTreeMap::new();
    let mut lines = BufReader::new(file).lines().enumerate().peekable();
    while let Some((line_index, line)) = lines.next() {
        let Ok(line) = line else {
            return false;
        };
        let trimmed = line.trim();
        // The log holds full prompts and tool output; only the session start
        // and shutdown events are parsed.
        if trimmed.is_empty()
            || !(trimmed.contains("\"session.shutdown\"") || trimmed.contains("\"session.start\""))
        {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(trimmed) else {
            log::warn!(
                "copilot: skipping malformed line {} in {}",
                line_index + 1,
                filepath.display()
            );
            if lines.peek().is_none() {
                return false;
            }
            continue;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("session.start") => {
                if let Some(id) = event
                    .pointer("/data/sessionId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    session_id = id.to_string();
                }
            }
            Some("session.shutdown") => {
                copilot_shutdown_records(&event, &session_id, line_index, &mut previous, logs);
            }
            _ => {}
        }
    }
    true
}

fn copilot_shutdown_records(
    event: &Value,
    session_id: &str,
    line_index: usize,
    previous: &mut BTreeMap<String, CopilotUsage>,
    logs: &mut Vec<LogRecord>,
) {
    let Some(timestamp) = event.get("timestamp").and_then(gemini_timestamp) else {
        return;
    };
    let Some(metrics) = event
        .pointer("/data/modelMetrics")
        .and_then(Value::as_object)
    else {
        return;
    };
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("line-{line_index}"));
    for (model_key, metric) in metrics {
        let Some(usage) = metric.get("usage").and_then(copilot_usage) else {
            continue;
        };
        let delta = match previous.get(model_key) {
            Some(before) if usage.covers(before) => usage.minus(before),
            _ => usage,
        };
        previous.insert(model_key.clone(), usage);
        let (input, cached, cache_write) = copilot_split_input(&delta);
        if input <= 0 && delta.output <= 0 && cached <= 0 {
            continue;
        }
        let model = Some(clean_model_name(model_key))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "copilot-unknown".to_string());
        logs.push(LogRecord {
            tool: "copilot".to_string(),
            model,
            input_tokens: input,
            output_tokens: delta.output,
            cached_tokens: cached,
            cache_write_tokens: cache_write,
            timestamp: timestamp.clone(),
            session_id: session_id.to_string(),
            unique_key: format!(
                "copilot_{}_{}_{}",
                copilot_hash(session_id),
                copilot_hash(&event_id),
                copilot_hash(model_key)
            ),
            cost_usd: None,
            cumulative: false,
        });
    }
}

/// All four counters are required; a malformed, fractional or negative one
/// drops the model entry instead of booking a fabricated zero.
fn copilot_usage(usage: &Value) -> Option<CopilotUsage> {
    let counter = |name: &str| usage.get(name).and_then(gemini_counter_value);
    Some(CopilotUsage {
        input: counter("inputTokens")?,
        output: counter("outputTokens")?,
        cache_read: counter("cacheReadTokens")?,
        cache_write: counter("cacheWriteTokens")?,
    })
}

/// Copilot reports the prompt OpenAI-style, so `inputTokens` normally
/// includes the cache reads and writes; net input is what remains. When the
/// cache counters exceed the input the input is already net (Anthropic
/// style) and is kept as is. Returns `(net input, cached incl. writes,
/// cache writes)`, matching the ledger's `cached_tokens` convention.
fn copilot_split_input(usage: &CopilotUsage) -> (i64, i64, i64) {
    let cache_total = usage.cache_read + usage.cache_write;
    let input = if usage.input >= cache_total {
        usage.input - cache_total
    } else {
        usage.input
    };
    (input, cache_total, usage.cache_write)
}

#[cfg(test)]
mod scanner_copilot_tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const FIXTURE: &str = include_str!("../../tests/fixtures/copilot-cli/events.jsonl");

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tokenledger_copilot_test_{suffix}"));
        fs::create_dir_all(&root).expect("create copilot test root");
        root
    }

    fn write_session(root: &Path, id: &str, content: &str) -> PathBuf {
        let dir = root.join(id);
        fs::create_dir_all(&dir).expect("create session dir");
        let path = dir.join("events.jsonl");
        fs::write(&path, content).expect("write events");
        path
    }

    fn scan(root: &Path) -> Vec<LogRecord> {
        let mut logs = Vec::new();
        scan_copilot_dir(root, &mut logs, &HashMap::new(), &mut Vec::new());
        logs
    }

    #[test]
    fn books_shutdown_metrics_and_resume_growth_once() {
        let root = temp_root();
        write_session(&root, "dir-name-is-fallback", FIXTURE);
        let logs = scan(&root);
        // First run: two models. Resumed run: totals grew for one model only.
        assert_eq!(logs.len(), 3);

        let first = &logs[0];
        assert_eq!(first.tool, "copilot");
        assert_eq!(first.model, "claude-sonnet-4.6");
        assert_eq!(first.session_id, "3b6c1f0e-0000-4000-8000-00000000c0de");
        assert_eq!(first.input_tokens, 50_000 - 40_000 - 2_000);
        assert_eq!(first.cached_tokens, 42_000);
        assert_eq!(first.cache_write_tokens, 2_000);
        assert_eq!(first.output_tokens, 1_500);
        assert!(!first.cumulative);

        assert_eq!(logs[1].model, "gpt-5.4-mini");
        assert_eq!(logs[1].input_tokens, 800);
        assert_eq!(logs[1].cached_tokens, 0);

        // Second shutdown repeats the earlier totals plus growth.
        let resumed = &logs[2];
        assert_eq!(resumed.model, "claude-sonnet-4.6");
        assert_eq!(resumed.input_tokens, 20_000 - 15_000);
        assert_eq!(resumed.cached_tokens, 15_000);
        assert_eq!(resumed.output_tokens, 500);
        assert_ne!(resumed.unique_key, first.unique_key);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn counters_that_restart_are_booked_as_is() {
        let root = temp_root();
        let shutdown = |id: &str, input: i64| {
            json!({
                "type": "session.shutdown",
                "id": id,
                "timestamp": "2026-10-21T10:00:00.000Z",
                "data": {"modelMetrics": {"gpt-5.4": {"usage": {
                    "inputTokens": input, "outputTokens": 10,
                    "cacheReadTokens": 0, "cacheWriteTokens": 0
                }}}}
            })
            .to_string()
        };
        write_session(
            &root,
            "s",
            &format!("{}\n{}\n", shutdown("a", 900), shutdown("b", 300)),
        );
        let logs = scan(&root);
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].input_tokens, 900);
        assert_eq!(logs[1].input_tokens, 300);
        assert_eq!(logs[1].session_id, "s");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_incomplete_usage_and_bad_timestamps() {
        let root = temp_root();
        let content = [
            json!({"type":"session.shutdown","id":"x","timestamp":"2026-10-21T10:00:00Z",
                "data":{"modelMetrics":{"m":{"usage":{"inputTokens":5,"outputTokens":1,"cacheReadTokens":0}}}}}),
            json!({"type":"session.shutdown","id":"y","timestamp":"2026-10-21T10:00:00Z",
                "data":{"modelMetrics":{"m":{"usage":{"inputTokens":-5,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}}}}),
            json!({"type":"session.shutdown","id":"z","timestamp":"later",
                "data":{"modelMetrics":{"m":{"usage":{"inputTokens":5,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}}}}),
        ]
        .map(|value| value.to_string())
        .join("\n");
        write_session(&root, "s", &content);
        assert!(scan(&root).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rescans_are_idempotent_and_checkpointed() {
        let root = temp_root();
        write_session(&root, "s", FIXTURE);
        let first = scan(&root);
        let second = scan(&root);
        let keys = |logs: &[LogRecord]| {
            logs.iter()
                .map(|l| l.unique_key.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&first), keys(&second));

        let mut pending = Vec::new();
        scan_copilot_dir(&root, &mut Vec::new(), &HashMap::new(), &mut pending);
        let checkpoints: HashMap<_, _> = pending
            .into_iter()
            .map(|checkpoint| (checkpoint.source_path.clone(), checkpoint))
            .collect();
        let mut again = Vec::new();
        scan_copilot_dir(&root, &mut again, &checkpoints, &mut Vec::new());
        assert!(again.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_last_line_keeps_checkpoint_pending() {
        let root = temp_root();
        write_session(
            &root,
            "s",
            &format!("{FIXTURE}{{\"type\":\"session.shutdown\","),
        );
        let mut pending = Vec::new();
        let mut logs = Vec::new();
        scan_copilot_dir(&root, &mut logs, &HashMap::new(), &mut pending);
        assert_eq!(logs.len(), 3);
        assert!(pending.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn home_follows_copilot_home() {
        assert_eq!(
            copilot_session_state_dir_from(Some("/cfg".into()), "/home/u".into()),
            PathBuf::from("/cfg/session-state")
        );
        assert_eq!(
            copilot_session_state_dir_from(None, "/home/u".into()),
            PathBuf::from("/home/u/.copilot/session-state")
        );
    }
}
