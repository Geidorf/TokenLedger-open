use super::checkpoints::*;
use super::gemini::{gemini_counter_value, gemini_timestamp};
use super::helpers::*;
use super::types::LogRecord;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub(crate) const QWEN_CODE_CHECKPOINT_SOURCE_KIND: &str = "qwen-code-chats-jsonl-v1";

/// Qwen Code writes one JSONL transcript per session under
/// `<runtime>/projects/<sanitized cwd>/chats/<sessionId>.jsonl`. The runtime
/// root is `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, else `~/.qwen`. Each line is a
/// `ChatRecord`; assistant records carry the Gemini-shaped `usageMetadata` of
/// the model response that produced them. Nothing else in the Qwen home
/// (settings, account or OAuth files) is opened.
pub(crate) fn qwen_projects_roots() -> Vec<PathBuf> {
    qwen_projects_roots_from(
        std::env::var_os("QWEN_RUNTIME_DIR"),
        std::env::var_os("QWEN_HOME"),
        get_home_dir(),
    )
}

fn qwen_projects_roots_from(
    runtime_dir: Option<std::ffi::OsString>,
    qwen_home: Option<std::ffi::OsString>,
    home: PathBuf,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for base in [runtime_dir, qwen_home]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .chain(std::iter::once(home.join(".qwen")))
    {
        let projects = base.join("projects");
        if !roots.contains(&projects) {
            roots.push(projects);
        }
    }
    roots
}

fn qwen_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn scan_qwen(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let mut seen = HashSet::new();
    qwen_projects_roots()
        .iter()
        .map(|root| scan_qwen_root(root, logs, checkpoints, pending_checkpoints, &mut seen))
        .sum()
}

pub(crate) fn scan_qwen_root(
    projects_root: &Path,
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
    seen: &mut HashSet<String>,
) -> usize {
    if !projects_root.is_dir() {
        return 0;
    }
    // Only `*.jsonl` files below a `chats` directory are transcripts; other
    // project files (plans, file history, memory) are never parsed.
    let mut files: Vec<PathBuf> = WalkDir::new(projects_root)
        .max_depth(6)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            let in_chats = entry
                .path()
                .strip_prefix(projects_root)
                .ok()
                .is_some_and(|relative| {
                    relative
                        .components()
                        .any(|component| component.as_os_str() == "chats")
                });
            in_chats && entry.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl")
        })
        .map(|entry| entry.into_path())
        .collect();
    files.sort();

    let mut count = 0;
    for filepath in files {
        let Some(before) =
            checkpointed_file_before(&filepath, QWEN_CODE_CHECKPOINT_SOURCE_KIND, checkpoints)
        else {
            continue;
        };
        let file_logs_before = logs.len();
        let parse_complete = qwen_parse_jsonl_file(&filepath, logs, seen);
        count += logs.len() - file_logs_before;
        if parse_complete {
            finish_checkpointed_file(
                &filepath,
                before,
                QWEN_CODE_CHECKPOINT_SOURCE_KIND,
                pending_checkpoints,
            );
        } else {
            log::warn!(
                "qwen: leaving checkpoint unchanged after an incomplete read of {}",
                filepath.display()
            );
        }
    }
    count
}

/// Malformed middle lines are skipped; a malformed last line (likely a write
/// in progress) or a read error leaves the checkpoint where it was.
fn qwen_parse_jsonl_file(
    filepath: &Path,
    logs: &mut Vec<LogRecord>,
    seen: &mut HashSet<String>,
) -> bool {
    let Ok(file) = File::open(filepath) else {
        return false;
    };
    let fallback_session = filepath
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown_session")
        .to_string();
    let mut lines = BufReader::new(file).lines().enumerate().peekable();
    while let Some((line_index, line)) = lines.next() {
        let Ok(line) = line else {
            return false;
        };
        let trimmed = line.trim();
        // Cheap pre-filter: transcripts hold full prompts and tool output, and
        // only assistant records with usage are worth a JSON parse.
        if trimmed.is_empty() || !trimmed.contains("\"usageMetadata\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(trimmed) else {
            log::warn!(
                "qwen: skipping malformed line {} in {}",
                line_index + 1,
                filepath.display()
            );
            if lines.peek().is_none() {
                return false;
            }
            continue;
        };
        if let Some(log) = qwen_record(&record, &fallback_session, line_index) {
            // A resumed or forked session can carry the same record (same
            // `uuid`) in more than one file; count it once.
            if seen.insert(log.unique_key.clone()) {
                logs.push(log);
            }
        }
    }
    true
}

/// Turns one assistant `ChatRecord` into a ledger row.
///
/// `usageMetadata` follows the Gemini shape for every provider Qwen Code
/// talks to: `promptTokenCount` includes cache reads
/// (`cachedContentTokenCount`), so net input is the difference. Output
/// depends on the provider path: for Gemini-native responses
/// `candidatesTokenCount` excludes `thoughtsTokenCount` and
/// `totalTokenCount = prompt + candidates + thoughts`; for OpenAI- and
/// Anthropic-compatible responses `candidatesTokenCount` is the full
/// completion and thoughts are only a (possibly estimated) breakdown of it.
/// Thoughts are added only when the reported total proves they are separate.
fn qwen_record(record: &Value, fallback_session: &str, line_index: usize) -> Option<LogRecord> {
    if record.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let usage = record.get("usageMetadata")?;
    let counter = |name: &str| -> Option<i64> {
        match usage.get(name) {
            None | Some(Value::Null) => Some(0),
            Some(value) => gemini_counter_value(value),
        }
    };
    let prompt = counter("promptTokenCount")?;
    let candidates = counter("candidatesTokenCount")?;
    let cached = counter("cachedContentTokenCount")?;
    let thoughts = counter("thoughtsTokenCount")?;
    let total = counter("totalTokenCount")?;
    if cached > prompt {
        return None;
    }
    let input = prompt - cached;
    let thoughts_are_separate =
        thoughts > 0 && total >= prompt.saturating_add(candidates).saturating_add(thoughts);
    let output = if thoughts_are_separate {
        candidates.checked_add(thoughts)?
    } else {
        candidates
    };
    if input <= 0 && output <= 0 && cached <= 0 {
        return None;
    }
    let timestamp = record.get("timestamp").and_then(gemini_timestamp)?;
    let session_id = record
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_session)
        .to_string();
    let record_id = record
        .get("uuid")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("line-{line_index}"));
    let model = record
        .get("model")
        .and_then(Value::as_str)
        .map(clean_model_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "qwen-unknown".to_string());
    Some(LogRecord {
        tool: "qwen".to_string(),
        model,
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
        cache_write_tokens: 0,
        timestamp,
        unique_key: format!("qwen_{}_{}", qwen_hash(&session_id), qwen_hash(&record_id)),
        session_id,
        cost_usd: None,
        cumulative: false,
    })
}

#[cfg(test)]
mod scanner_qwen_tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const FIXTURE: &str = include_str!("../../tests/fixtures/qwen-code/session.jsonl");

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tokenledger_qwen_test_{suffix}"));
        fs::create_dir_all(&root).expect("create qwen test root");
        root
    }

    fn write_chat(root: &Path, project: &str, name: &str, content: &str) -> PathBuf {
        let dir = root.join(project).join("chats");
        fs::create_dir_all(&dir).expect("create chats dir");
        let path = dir.join(name);
        fs::write(&path, content).expect("write chat");
        path
    }

    fn scan(root: &Path) -> Vec<LogRecord> {
        let mut logs = Vec::new();
        scan_qwen_root(
            root,
            &mut logs,
            &HashMap::new(),
            &mut Vec::new(),
            &mut HashSet::new(),
        );
        logs
    }

    #[test]
    fn parses_fixture_session_per_provider_shape() {
        let root = temp_root();
        write_chat(
            &root,
            "-work-demo",
            "6f1d2c3a-0000-4000-8000-000000000001.jsonl",
            FIXTURE,
        );
        let logs = scan(&root);
        assert_eq!(logs.len(), 3, "user, tool and system records are skipped");

        // OpenAI-compatible: candidates already include the reasoning tokens.
        assert_eq!(logs[0].tool, "qwen");
        assert_eq!(logs[0].model, "qwen3-coder-plus");
        assert_eq!(logs[0].input_tokens, 12_000 - 9_000);
        assert_eq!(logs[0].cached_tokens, 9_000);
        assert_eq!(logs[0].output_tokens, 400);
        assert_eq!(logs[0].cache_write_tokens, 0);
        assert_eq!(logs[0].session_id, "6f1d2c3a-0000-4000-8000-000000000001");
        assert!(logs[0].unique_key.starts_with("qwen_"));
        assert!(!logs[0].cumulative);

        // Gemini-native: thoughts are reported outside candidates.
        assert_eq!(logs[1].model, "gemini-3.5-flash");
        assert_eq!(logs[1].input_tokens, 2_000);
        assert_eq!(logs[1].output_tokens, 100 + 50);

        // Missing model falls back to a placeholder; no cache field means 0.
        assert_eq!(logs[2].model, "qwen-unknown");
        assert_eq!(logs[2].input_tokens, 500);
        assert_eq!(logs[2].cached_tokens, 0);
        assert_eq!(logs[2].output_tokens, 20);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn same_record_in_two_session_files_counts_once() {
        let root = temp_root();
        write_chat(&root, "-work-demo", "a.jsonl", FIXTURE);
        write_chat(&root, "-work-other", "b.jsonl", FIXTURE);
        assert_eq!(scan(&root).len(), 3);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_bad_counters_and_timestamps() {
        let root = temp_root();
        let base = |usage: Value, timestamp: &str| {
            json!({
                "uuid": format!("u-{timestamp}-{usage}"),
                "sessionId": "s",
                "timestamp": timestamp,
                "type": "assistant",
                "model": "qwen3-coder-plus",
                "usageMetadata": usage,
            })
            .to_string()
        };
        let content = [
            base(
                json!({"promptTokenCount": -1, "candidatesTokenCount": 3}),
                "2026-10-01T00:00:00Z",
            ),
            base(
                json!({"promptTokenCount": 10, "cachedContentTokenCount": 20}),
                "2026-10-01T00:00:00Z",
            ),
            base(
                json!({"promptTokenCount": 1.5, "candidatesTokenCount": 3}),
                "2026-10-01T00:00:00Z",
            ),
            base(
                json!({"promptTokenCount": 10, "candidatesTokenCount": 3}),
                "not a time",
            ),
            base(
                json!({"promptTokenCount": 0, "candidatesTokenCount": 0}),
                "2026-10-01T00:00:00Z",
            ),
            base(
                json!({"promptTokenCount": 10, "candidatesTokenCount": 3}),
                "2026-10-01T00:00:00Z",
            ),
        ]
        .join("\n");
        write_chat(&root, "-p", "s.jsonl", &content);
        let logs = scan(&root);
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].input_tokens, 10);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_files_outside_chats_and_non_jsonl() {
        let root = temp_root();
        let other = root.join("-p").join("file-history");
        fs::create_dir_all(&other).expect("create other dir");
        fs::write(other.join("x.jsonl"), FIXTURE).expect("write other");
        write_chat(&root, "-p", "notes.json", FIXTURE);
        assert!(scan(&root).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_last_line_keeps_checkpoint_pending() {
        let root = temp_root();
        let content = format!("{FIXTURE}{{\"type\":\"assistant\",\"usageMetadata\":");
        write_chat(&root, "-p", "s.jsonl", &content);
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        scan_qwen_root(
            &root,
            &mut logs,
            &HashMap::new(),
            &mut pending,
            &mut HashSet::new(),
        );
        assert_eq!(logs.len(), 3);
        assert!(pending.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unchanged_file_is_skipped_by_checkpoint() {
        let root = temp_root();
        write_chat(&root, "-p", "s.jsonl", FIXTURE);
        let mut pending = Vec::new();
        let mut logs = Vec::new();
        scan_qwen_root(
            &root,
            &mut logs,
            &HashMap::new(),
            &mut pending,
            &mut HashSet::new(),
        );
        assert_eq!(pending.len(), 1);
        let checkpoints: HashMap<_, _> = pending
            .into_iter()
            .map(|checkpoint| (checkpoint.source_path.clone(), checkpoint))
            .collect();
        let mut again = Vec::new();
        scan_qwen_root(
            &root,
            &mut again,
            &checkpoints,
            &mut Vec::new(),
            &mut HashSet::new(),
        );
        assert!(again.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn roots_follow_runtime_dir_then_qwen_home_then_default() {
        assert_eq!(
            qwen_projects_roots_from(Some("/rt".into()), Some("/qh".into()), "/home/u".into()),
            vec![
                PathBuf::from("/rt/projects"),
                PathBuf::from("/qh/projects"),
                PathBuf::from("/home/u/.qwen/projects"),
            ]
        );
        assert_eq!(
            qwen_projects_roots_from(None, Some("".into()), "/home/u".into()),
            vec![PathBuf::from("/home/u/.qwen/projects")]
        );
    }
}
