use super::checkpoints::*;
use super::gemini::gemini_counter_value;
use super::helpers::*;
use super::types::LogRecord;
use chrono::TimeZone;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(crate) const CLINE_FAMILY_CHECKPOINT_SOURCE_KIND: &str = "cline-family-ui-messages-v1";

/// Cline and the extensions forked from it (Roo Code, Kilo Code) keep one
/// directory per task with a `ui_messages.json` array. Every model request is
/// a `say: "api_req_started"` message whose `text` is a JSON string carrying
/// `tokensIn`, `tokensOut`, `cacheWrites`, `cacheReads` and `cost`. Only that
/// file and Cline's `task_metadata.json` (model per timestamp) are read;
/// conversation history, settings and secrets are never opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClineFamilyTool {
    pub(crate) tool: &'static str,
    extension_id: &'static str,
}

pub(crate) const CLINE_FAMILY_TOOLS: &[ClineFamilyTool] = &[
    ClineFamilyTool {
        tool: "cline",
        extension_id: "saoudrizwan.claude-dev",
    },
    ClineFamilyTool {
        tool: "roo",
        extension_id: "rooveterinaryinc.roo-cline",
    },
    ClineFamilyTool {
        tool: "kilocode",
        extension_id: "kilocode.kilo-code",
    },
];

/// VS Code and the editors built on it that install these extensions.
const EDITOR_DIRS: &[&str] = &[
    "Code",
    "Code - Insiders",
    "VSCodium",
    "Cursor",
    "Windsurf",
    "Kiro",
];

fn editor_user_roots(home: &Path) -> Vec<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"))
    };
    EDITOR_DIRS
        .iter()
        .map(|editor| base.join(editor).join("User").join("globalStorage"))
        .collect()
}

/// `(tool, tasks dir)` pairs to scan. Cline's CLI and newer builds also keep
/// tasks under `~/.cline/data/tasks`.
pub(crate) fn cline_family_task_roots(home: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut roots = Vec::new();
    for global_storage in editor_user_roots(home) {
        for tool in CLINE_FAMILY_TOOLS {
            roots.push((
                tool.tool,
                global_storage.join(tool.extension_id).join("tasks"),
            ));
        }
    }
    roots.push(("cline", home.join(".cline").join("data").join("tasks")));
    roots
}

fn cline_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn scan_cline_family(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    cline_family_task_roots(&get_home_dir())
        .into_iter()
        .map(|(tool, root)| {
            scan_cline_tasks_dir(tool, &root, logs, checkpoints, pending_checkpoints)
        })
        .sum()
}

pub(crate) fn scan_cline_tasks_dir(
    tool: &str,
    tasks_dir: &Path,
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let Ok(entries) = std::fs::read_dir(tasks_dir) else {
        return 0;
    };
    let mut task_dirs: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.join("ui_messages.json").is_file())
        .collect();
    task_dirs.sort();

    let mut count = 0;
    for task_dir in task_dirs {
        let filepath = task_dir.join("ui_messages.json");
        let Some(before) =
            checkpointed_file_before(&filepath, CLINE_FAMILY_CHECKPOINT_SOURCE_KIND, checkpoints)
        else {
            continue;
        };
        let file_logs_before = logs.len();
        // The file is rewritten as a whole; a read that does not parse is
        // most likely mid-write and is retried on the next scan.
        if !cline_parse_task(tool, &task_dir, logs) {
            log::warn!(
                "{tool}: leaving checkpoint unchanged after an incomplete read of {}",
                filepath.display()
            );
            continue;
        }
        count += logs.len() - file_logs_before;
        finish_checkpointed_file(
            &filepath,
            before,
            CLINE_FAMILY_CHECKPOINT_SOURCE_KIND,
            pending_checkpoints,
        );
    }
    count
}

/// Cline's `task_metadata.json` lists `{ts, model_id}` whenever the model in
/// use changes. Roo and Kilo do not record the model per request. A missing
/// file yields an empty history; one that exists but does not read or parse
/// yields `None` so the task is retried instead of frozen as unknown.
fn cline_model_history(task_dir: &Path) -> Option<Vec<(i64, String)>> {
    let content = match std::fs::read_to_string(task_dir.join("task_metadata.json")) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    let metadata = serde_json::from_str::<Value>(&content).ok()?;
    let mut history: Vec<(i64, String)> = metadata
        .get("model_usage")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let ts = entry.get("ts").and_then(Value::as_i64)?;
            let model = entry
                .get("model_id")
                .and_then(Value::as_str)
                .map(clean_model_name)
                .filter(|value| !value.is_empty())?;
            Some((ts, model))
        })
        .collect();
    history.sort();
    Some(history)
}

fn cline_parse_task(tool: &str, task_dir: &Path, logs: &mut Vec<LogRecord>) -> bool {
    let Ok(content) = std::fs::read_to_string(task_dir.join("ui_messages.json")) else {
        return false;
    };
    let Ok(messages) = serde_json::from_str::<Value>(&content) else {
        return false;
    };
    let Some(messages) = messages.as_array() else {
        return false;
    };
    let task_id = task_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown_task")
        .to_string();
    let Some(models) = cline_model_history(task_dir) else {
        return false;
    };
    for message in messages {
        if let Some(record) = cline_request_record(tool, &task_id, &models, message) {
            logs.push(record);
        }
    }
    true
}

fn cline_request_record(
    tool: &str,
    task_id: &str,
    models: &[(i64, String)],
    message: &Value,
) -> Option<LogRecord> {
    if message.get("say").and_then(Value::as_str) != Some("api_req_started") {
        return None;
    }
    // A request that is still streaming has no usage yet; it is picked up
    // once the extension rewrites the message with the final counts.
    if message.get("partial").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let ts = message.get("ts").and_then(Value::as_i64)?;
    let info: Value = serde_json::from_str(message.get("text").and_then(Value::as_str)?).ok()?;
    let counter = |name: &str| -> Option<i64> {
        match info.get(name) {
            None | Some(Value::Null) => Some(0),
            Some(value) => gemini_counter_value(value),
        }
    };
    // Without `tokensIn` the request never reported usage (failed before the
    // first chunk); skip rather than book zeros.
    info.get("tokensIn")?;
    let tokens_in = counter("tokensIn")?;
    let tokens_out = counter("tokensOut")?;
    let cache_writes = counter("cacheWrites")?;
    let cache_reads = counter("cacheReads")?;
    let input = cline_net_input(
        message.get("apiProtocol").and_then(Value::as_str),
        tokens_in,
        cache_reads,
        cache_writes,
    );
    let cached = cache_reads + cache_writes;
    if input <= 0 && tokens_out <= 0 && cached <= 0 {
        return None;
    }
    let timestamp = chrono::Local
        .timestamp_millis_opt(ts)
        .single()?
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let model = models
        .iter()
        .rev()
        .find(|(model_ts, _)| *model_ts <= ts)
        .or_else(|| models.first())
        .map(|(_, model)| model.clone())
        .unwrap_or_else(|| format!("{tool}-unknown"));
    let cost_usd = info
        .get("cost")
        .and_then(to_float)
        .filter(|cost| cost.is_finite() && *cost > 0.0);
    Some(LogRecord {
        tool: tool.to_string(),
        model,
        input_tokens: input,
        output_tokens: tokens_out,
        cached_tokens: cached,
        cache_write_tokens: cache_writes,
        timestamp,
        session_id: task_id.to_string(),
        unique_key: format!("{tool}_{}_{ts}", cline_hash(task_id)),
        cost_usd,
        cumulative: false,
    })
}

/// Anthropic-protocol providers report `tokensIn` without cache traffic;
/// OpenAI-protocol providers include cache reads in it. Roo and Kilo tag
/// each request with `apiProtocol`; for untagged requests (Cline) an input
/// that covers the cache reads with no cache writes is treated as inclusive.
fn cline_net_input(
    protocol: Option<&str>,
    tokens_in: i64,
    cache_reads: i64,
    cache_writes: i64,
) -> i64 {
    let inclusive = match protocol {
        Some("openai") => true,
        Some("anthropic") => false,
        _ => cache_writes == 0 && cache_reads > 0 && tokens_in >= cache_reads,
    };
    if inclusive {
        (tokens_in - cache_reads).max(0)
    } else {
        tokens_in
    }
}

#[cfg(test)]
mod scanner_cline_tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    const UI_MESSAGES: &str = include_str!("../../tests/fixtures/cline-family/ui_messages.json");
    const TASK_METADATA: &str =
        include_str!("../../tests/fixtures/cline-family/task_metadata.json");

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tokenledger_cline_test_{suffix}"));
        fs::create_dir_all(&root).expect("create cline test root");
        root
    }

    fn write_task(root: &Path, task: &str, metadata: bool) {
        let dir = root.join(task);
        fs::create_dir_all(&dir).expect("create task dir");
        fs::write(dir.join("ui_messages.json"), UI_MESSAGES).expect("write ui messages");
        fs::write(dir.join("api_conversation_history.json"), "not read").expect("write history");
        if metadata {
            fs::write(dir.join("task_metadata.json"), TASK_METADATA).expect("write metadata");
        }
    }

    fn scan(tool: &str, root: &Path) -> Vec<LogRecord> {
        let mut logs = Vec::new();
        scan_cline_tasks_dir(tool, root, &mut logs, &HashMap::new(), &mut Vec::new());
        logs
    }

    #[test]
    fn parses_requests_with_models_from_task_metadata() {
        let root = temp_root();
        write_task(&root, "1760000000000", true);
        let logs = scan("cline", &root);
        // Partial, unfinished, failed and non-request messages are skipped.
        assert_eq!(logs.len(), 3);

        let first = &logs[0];
        assert_eq!(first.tool, "cline");
        assert_eq!(first.model, "claude-sonnet-4.6");
        assert_eq!(first.session_id, "1760000000000");
        assert_eq!(first.input_tokens, 1_200);
        assert_eq!(first.output_tokens, 300);
        assert_eq!(first.cached_tokens, 20_000 + 4_000);
        assert_eq!(first.cache_write_tokens, 4_000);
        assert_eq!(first.cost_usd, Some(0.0321));
        assert!(first.unique_key.starts_with("cline_"));

        // Model switched mid-task; OpenAI-tagged input includes cache reads.
        let second = &logs[1];
        assert_eq!(second.model, "gpt-5.4");
        assert_eq!(second.input_tokens, 9_000 - 6_000);
        assert_eq!(second.cached_tokens, 6_000);
        assert_eq!(second.cost_usd, None, "zero cost falls back to estimates");

        // Untagged request: input that covers cache reads is inclusive.
        let third = &logs[2];
        assert_eq!(third.input_tokens, 5_000 - 3_000);
        assert_eq!(third.cached_tokens, 3_000);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn forks_without_metadata_get_a_placeholder_model() {
        let root = temp_root();
        write_task(&root, "task-a", false);
        let logs = scan("roo", &root);
        assert_eq!(logs.len(), 3);
        assert!(logs
            .iter()
            .all(|log| log.model == "roo-unknown" && log.tool == "roo"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn half_written_file_is_retried_and_not_checkpointed() {
        let root = temp_root();
        let dir = root.join("t");
        fs::create_dir_all(&dir).expect("create task dir");
        fs::write(
            dir.join("ui_messages.json"),
            &UI_MESSAGES[..UI_MESSAGES.len() / 2],
        )
        .expect("write partial");
        let mut pending = Vec::new();
        let mut logs = Vec::new();
        scan_cline_tasks_dir("cline", &root, &mut logs, &HashMap::new(), &mut pending);
        assert!(logs.is_empty());
        assert!(pending.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn half_written_metadata_is_retried_instead_of_freezing_unknown_models() {
        let root = temp_root();
        write_task(&root, "t", false);
        fs::write(
            root.join("t").join("task_metadata.json"),
            &TASK_METADATA[..TASK_METADATA.len() / 2],
        )
        .expect("write partial metadata");
        let mut pending = Vec::new();
        let mut logs = Vec::new();
        scan_cline_tasks_dir("cline", &root, &mut logs, &HashMap::new(), &mut pending);
        assert!(logs.is_empty());
        assert!(pending.is_empty());

        fs::write(root.join("t").join("task_metadata.json"), TASK_METADATA)
            .expect("write metadata");
        scan_cline_tasks_dir("cline", &root, &mut logs, &HashMap::new(), &mut pending);
        assert_eq!(logs.len(), 3);
        assert_eq!(logs[0].model, "claude-sonnet-4.6");
        assert_eq!(pending.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unchanged_file_is_skipped_and_keys_are_stable() {
        let root = temp_root();
        write_task(&root, "t", true);
        let mut pending = Vec::new();
        let mut first = Vec::new();
        scan_cline_tasks_dir("cline", &root, &mut first, &HashMap::new(), &mut pending);
        assert_eq!(pending.len(), 1);
        let keys: Vec<_> = first.iter().map(|log| log.unique_key.clone()).collect();
        assert_eq!(
            keys,
            scan("cline", &root)
                .iter()
                .map(|log| log.unique_key.clone())
                .collect::<Vec<_>>()
        );
        let checkpoints: HashMap<_, _> = pending
            .into_iter()
            .map(|checkpoint| (checkpoint.source_path.clone(), checkpoint))
            .collect();
        let mut again = Vec::new();
        scan_cline_tasks_dir("cline", &root, &mut again, &checkpoints, &mut Vec::new());
        assert!(again.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn net_input_follows_protocol_tag() {
        assert_eq!(cline_net_input(Some("anthropic"), 5_000, 3_000, 0), 5_000);
        assert_eq!(cline_net_input(Some("openai"), 2_000, 3_000, 0), 0);
        assert_eq!(cline_net_input(None, 1_000, 3_000, 0), 1_000);
        assert_eq!(cline_net_input(None, 5_000, 3_000, 100), 5_000);
    }

    #[test]
    fn task_roots_cover_each_extension_and_the_cli() {
        let roots = cline_family_task_roots(Path::new("/h"));
        assert!(roots.iter().any(|(tool, path)| *tool == "roo"
            && path.ends_with("Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks")));
        assert!(roots.iter().any(|(tool, path)| *tool == "kilocode"
            && path.ends_with("Cursor/User/globalStorage/kilocode.kilo-code/tasks")));
        assert!(roots
            .iter()
            .any(|(tool, path)| *tool == "cline" && path.ends_with(".cline/data/tasks")));
    }
}
