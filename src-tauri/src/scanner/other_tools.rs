use super::checkpoints::*;
use super::helpers::*;
use super::types::LogRecord;
use chrono::{DateTime, Local};
use regex::Regex;
use rusqlite::{params, Connection, OpenFlags, Result};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;

pub(crate) fn scan_opencode_like(
    logs: &mut Vec<LogRecord>,
    tool_name: &str,
    relative_db_path: &str,
    cursors: &SourceCursorMap,
    pending_cursors: &mut Vec<crate::db::ScanSourceCursor>,
) -> usize {
    const PARSER_VERSION: i64 = 1;
    let db_path = get_home_dir().join(relative_db_path);
    if !db_path.exists() {
        log::info!(
            "Opencode-like scan: DB for {} does not exist at {:?}",
            tool_name,
            db_path
        );
        return 0;
    }

    let fingerprint = match source_fingerprint(&db_path) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            log::warn!("Opencode-like scan for {tool_name}: {error}");
            return 0;
        }
    };
    let source_kind = format!("opencode-message-{tool_name}");
    let after_id = active_source_cursor(cursors, &fingerprint, &source_kind, PARSER_VERSION)
        .map(|cursor| cursor.cursor_primary.clone())
        .unwrap_or_default();

    let mut count = 0;
    // OpenCode ids are time-ordered and indexed by the primary key. Retain a
    // bounded overlap so in-place streaming updates near the tail are seen
    // again without scanning/sorting the full message table.
    const MUTABLE_TAIL_ROWS: usize = 512;
    let mut recent_ids = VecDeque::with_capacity(MUTABLE_TAIL_ROWS + 1);
    if !after_id.is_empty() {
        recent_ids.push_back(after_id.clone());
    }
    let mut saw_row = false;
    match Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => {
            if let Err(error) = conn.busy_timeout(Duration::from_secs(5)) {
                log::warn!("Opencode-like scan for {tool_name}: busy timeout failed: {error}");
                return 0;
            }
            // Verify message table exists
            let table_check: Result<i64> = conn.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='message'",
                [],
                |r| r.get(0),
            );
            if let Err(e) = table_check {
                log::warn!("Opencode-like scan: table check for message failed or table does not exist in {} DB: {}", tool_name, e);
                return 0;
            }

            match conn.prepare(
                "SELECT id, session_id, time_created, time_updated, data
                 FROM message
                 WHERE id > ?1
                 ORDER BY id",
            ) {
                Ok(mut stmt) => {
                    let rows = stmt.query_map(params![after_id], |row| {
                        let id_val: rusqlite::types::Value = row.get(0)?;
                        let session_id: Option<String> = row.get(1)?;
                        let time_created_val: rusqlite::types::Value = row.get(2)?;
                        let time_updated_val: rusqlite::types::Value = row.get(3)?;
                        let data_str: String = row.get(4)?;
                        Ok((
                            id_val,
                            session_id,
                            time_created_val,
                            time_updated_val,
                            data_str,
                        ))
                    });

                    match rows {
                        Ok(rows_iter) => {
                            let mut skipped_rows = 0usize;
                            for r in rows_iter {
                                if let Ok((
                                    row_id,
                                    session_id,
                                    time_created_val,
                                    time_updated_val,
                                    raw_data,
                                )) = r
                                {
                                    let row_id = sqlite_value_to_string(row_id)
                                        .unwrap_or_else(|| format!("row_{}", count + skipped_rows));
                                    let time_created = sqlite_value_to_string(time_created_val);
                                    let time_updated = sqlite_value_to_string(time_updated_val);
                                    saw_row = true;
                                    recent_ids.push_back(row_id.clone());
                                    if recent_ids.len() > MUTABLE_TAIL_ROWS + 1 {
                                        recent_ids.pop_front();
                                    }
                                    if let Ok(data) = serde_json::from_str::<Value>(&raw_data) {
                                        let tokens = data.get("tokens").unwrap_or(&Value::Null);
                                        if !tokens.is_object() {
                                            skipped_rows += 1;
                                            continue;
                                        }

                                        let cache = tokens.get("cache").unwrap_or(&Value::Null);
                                        let input_tokens =
                                            to_int(tokens.get("input").unwrap_or(&Value::Null));
                                        let output_tokens =
                                            to_int(tokens.get("output").unwrap_or(&Value::Null))
                                                + to_int(
                                                    tokens.get("reasoning").unwrap_or(&Value::Null),
                                                );
                                        let cache_write =
                                            to_int(cache.get("write").unwrap_or(&Value::Null));
                                        let cached_tokens =
                                            to_int(cache.get("read").unwrap_or(&Value::Null))
                                                + cache_write;

                                        if input_tokens <= 0
                                            && output_tokens <= 0
                                            && cached_tokens <= 0
                                        {
                                            skipped_rows += 1;
                                            continue;
                                        }

                                        let fallback_model = format!("{}-model", tool_name);
                                        let raw_model = data
                                            .get("modelID")
                                            .and_then(|v| v.as_str())
                                            .or_else(|| {
                                                nested_get(&data, &["model", "modelID"]).as_str()
                                            })
                                            .unwrap_or(&fallback_model);
                                        let model = clean_model_name(raw_model);

                                        let ts_candidate =
                                            nested_get(&data, &["time", "completed"]);
                                        let ts = if !ts_candidate.is_null() {
                                            ts_candidate.clone()
                                        } else if let Some(updated) = time_updated {
                                            Value::String(updated)
                                        } else if let Some(created) = time_created {
                                            Value::String(created)
                                        } else {
                                            Value::Null
                                        };

                                        let timestamp = normalize_timestamp(&ts);
                                        let unique_key = format!("{}_{}", tool_name, row_id);
                                        let cost_usd =
                                            to_float(data.get("cost").unwrap_or(&Value::Null));

                                        logs.push(LogRecord {
                                            tool: tool_name.to_string(),
                                            model,
                                            input_tokens,
                                            output_tokens,
                                            cached_tokens,
                                            cache_write_tokens: cache_write,
                                            timestamp,
                                            session_id: session_id
                                                .unwrap_or_else(|| "unknown_session".to_string()),
                                            unique_key,
                                            cost_usd,
                                            cumulative: false,
                                        });
                                        count += 1;
                                    } else {
                                        skipped_rows += 1;
                                    }
                                } else {
                                    skipped_rows += 1;
                                }
                            }
                            if skipped_rows > 0 {
                                log::info!(
                                    "Opencode-like scan for {} skipped {} non-usage or unreadable rows",
                                    tool_name,
                                    skipped_rows
                                );
                            }
                        }
                        Err(e) => {
                            log::error!(
                                "Opencode-like scan for {}: query_map failed: {}",
                                tool_name,
                                e
                            );
                        }
                    }
                }
                Err(e) => {
                    log::error!(
                        "Opencode-like scan for {}: prepare statement failed: {}",
                        tool_name,
                        e
                    );
                }
            }
        }
        Err(e) => {
            log::error!(
                "Opencode-like scan for {}: failed to open DB: {}",
                tool_name,
                e
            );
        }
    }
    if saw_row {
        let next_id = recent_ids.front().cloned().unwrap_or_default();
        if next_id != after_id {
            pending_cursors.push(fingerprint.source_cursor(
                &source_kind,
                next_id,
                "",
                PARSER_VERSION,
            ));
        }
    }
    count
}

/// Extract the model name from a USER_SETTINGS_CHANGE block embedded in a
/// USER_INPUT transcript line.  The block looks like:
///
///   <USER_SETTINGS_CHANGE>
///   The user changed setting `Model Selection` from X to Y.
///   …
///   </USER_SETTINGS_CHANGE>
///
/// Returns a normalised, kebab-case model identifier suitable for use as the
/// `model` field in a LogRecord (e.g. "claude-sonnet-4-5", "gemini-2-5-pro").
pub(crate) fn extract_model_from_settings_change(content: &str) -> Option<String> {
    // Locate the settings-change block.
    let block_start = content.find("<USER_SETTINGS_CHANGE>")?;
    let block_end = content[block_start..].find("</USER_SETTINGS_CHANGE>")? + block_start;
    let block = &content[block_start..block_end];

    // Only care about Model Selection changes.
    if !block.contains("Model Selection") {
        return None;
    }

    // Find the first "from" and "to" markers sequentially to avoid
    // hitting system instruction verbs (like "need to ...").
    let ms_pos = block.find("Model Selection")?;
    let from_pos = block[ms_pos..].find(" from ").map(|p| p + ms_pos)?;
    let to_pos = block[from_pos..].find(" to ").map(|p| p + from_pos)?;

    let raw = block[to_pos + 4..].trim(); // skip " to "

    // A decimal point in a selected model label is not sentence punctuation.
    let bytes = raw.as_bytes();
    let dot_pos = raw
        .char_indices()
        .find_map(|(i, c)| {
            (c == '.'
                && !(i > 0
                    && bytes[i - 1].is_ascii_digit()
                    && bytes.get(i + 1).is_some_and(u8::is_ascii_digit)))
            .then_some(i)
        })
        .unwrap_or(raw.len());
    let nl_pos = raw.find('\n').unwrap_or(raw.len());
    let end_pos = dot_pos.min(nl_pos);
    let raw = raw[..end_pos].trim();

    // Keep the part before any parenthesis qualifier, e.g. "Gemini 3.5 Flash"
    // from "Gemini 3.5 Flash (High)".
    let raw = if let Some(p) = raw.find('(') {
        raw[..p].trim()
    } else {
        raw
    };

    if raw.is_empty() {
        return None;
    }

    // Normalise to a lowercase-kebab-case identifier.
    // "Claude Sonnet 4.6" → "claude-sonnet-4-6"
    let normalised = raw
        .to_lowercase()
        .replace('.', "-")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");

    let model = clean_model_name(&normalised);
    (!model.is_empty()).then_some(model)
}

pub(crate) fn scan_tencent_marvis(
    logs: &mut Vec<LogRecord>,
    cursors: &SourceCursorMap,
    pending_cursors: &mut Vec<crate::db::ScanSourceCursor>,
) -> usize {
    const SOURCE_KIND: &str = "tencent-marvis-token-usage-v1";
    const PARSER_VERSION: i64 = 1;
    let marvis_user_dir = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| get_home_dir().join("AppData/Roaming"))
            .join("Tencent/Marvis/User")
    } else if cfg!(target_os = "macos") {
        get_home_dir().join("Library/Application Support/com.tencent.mac.marvis/MarvisData/User")
    } else {
        get_home_dir().join("Library/Application Support/Tencent/Marvis/User")
    };

    if !marvis_user_dir.exists() {
        return 0;
    }

    let database_paths = match fs::read_dir(&marvis_user_dir) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path().join("database/data.db"))
            .filter(|path| path.is_file())
            .collect::<Vec<_>>(),
        Err(error) => {
            log::warn!("Tencent Marvis scan: failed to list user stores: {error}");
            return 0;
        }
    };

    let mut count = 0;
    for path in database_paths {
        let user_id = path
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("default_user")
            .to_string();

        let fingerprint = match source_fingerprint(&path) {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                log::warn!("Tencent Marvis scan: {error}");
                continue;
            }
        };
        let after_id = active_source_cursor(cursors, &fingerprint, SOURCE_KIND, PARSER_VERSION)
            .and_then(|cursor| cursor.cursor_primary.parse::<i64>().ok())
            .unwrap_or(i64::MIN);

        match Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(conn) => {
                if let Err(error) = conn.busy_timeout(Duration::from_secs(5)) {
                    log::warn!("Tencent Marvis scan: busy timeout failed: {error}");
                    continue;
                }
                // Check if table llm_token_usage exists
                let table_check: Result<i64> = conn.query_row(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='llm_token_usage'",
                    [],
                    |r| r.get(0),
                );
                if table_check.is_err() {
                    continue;
                }

                // Query usage
                let mut stmt = match conn.prepare(
                            "SELECT id, conversation_id, model_id, input_tokens, output_tokens, cached_tokens, created_at
                             FROM llm_token_usage WHERE id > ?1 ORDER BY id"
                        ) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };

                let rows = stmt.query_map([after_id], |row| {
                    let id: i64 = row.get(0)?;
                    let conversation_id: Option<String> = row.get(1)?;
                    let model_id: Option<String> = row.get(2)?;
                    let input_tokens: i64 = row.get(3)?;
                    let output_tokens: i64 = row.get(4)?;
                    let cached_tokens: Option<i64> = row.get(5)?;
                    let created_at_val: rusqlite::types::Value = row.get(6)?;
                    Ok((
                        id,
                        conversation_id,
                        model_id,
                        input_tokens,
                        output_tokens,
                        cached_tokens,
                        created_at_val,
                    ))
                });

                let mut last_id = None;
                if let Ok(rows_iter) = rows {
                    for (id, conv_id, model_id, input, output, cached, created_at_val) in
                        rows_iter.flatten()
                    {
                        last_id = Some(id);
                        let model = model_id.unwrap_or_else(|| "marvis-unknown".to_string());
                        let session_id = conv_id.unwrap_or_else(|| "unknown_session".to_string());

                        let ts_json = match created_at_val {
                            rusqlite::types::Value::Null => serde_json::Value::Null,
                            rusqlite::types::Value::Integer(i) => {
                                serde_json::Value::Number(serde_json::Number::from(i))
                            }
                            rusqlite::types::Value::Real(f) => serde_json::Value::Number(
                                serde_json::Number::from_f64(f)
                                    .unwrap_or(serde_json::Number::from(0)),
                            ),
                            rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                            rusqlite::types::Value::Blob(b) => {
                                serde_json::Value::String(String::from_utf8_lossy(&b).to_string())
                            }
                        };
                        let timestamp = normalize_timestamp(&ts_json);
                        let unique_key = format!("marvis_tencent_{}_{}", user_id, id);

                        logs.push(LogRecord {
                            tool: "marvis".to_string(),
                            model,
                            input_tokens: input,
                            output_tokens: output,
                            cached_tokens: cached.unwrap_or(0),
                            cache_write_tokens: 0,
                            timestamp,
                            session_id,
                            unique_key,
                            cost_usd: None,
                            cumulative: false,
                        });
                        count += 1;
                    }
                }
                if let Some(last_id) = last_id {
                    pending_cursors.push(fingerprint.source_cursor(
                        SOURCE_KIND,
                        last_id.to_string(),
                        "",
                        PARSER_VERSION,
                    ));
                }
            }
            Err(e) => {
                log::error!(
                    "Tencent Marvis scan: failed to open DB at {:?}: {}",
                    path,
                    e
                );
            }
        }
    }
    log::info!(
        "Tencent Marvis scan: scanned {} records successfully",
        count
    );
    count
}

/// Returns the first present (non-null) field among `names`, not the sum.
/// WorkBuddy logs mirror upstream provider usage objects, which often carry
/// the same cache figure under several aliases (e.g. OpenAI's `cached_tokens`
/// plus `prompt_tokens_details.cached_tokens`); summing them double counts.
fn first_present_int(usage: &Value, names: &[&str]) -> Option<i64> {
    for name in names {
        if let Some(v) = usage.get(*name) {
            if !v.is_null() {
                return Some(to_int(v));
            }
        }
    }
    None
}

/// Parsed usage: (input, output, cached_total, cache_write, cost).
fn parse_workbuddy_usage(usage: &Value) -> Option<(i64, i64, i64, i64, Option<f64>)> {
    if !usage.is_object() {
        return None;
    }

    // Which input alias matched matters: `prompt_tokens` (OpenAI semantics)
    // already includes cache hits, the others are cache-exclusive.
    let input_fields = [
        "inputTokens",
        "input_tokens",
        "prompt_tokens",
        "cachedMissTokens",
        "prompt_cache_miss_tokens",
    ];
    let mut matched_input_field = "";
    let mut input_tokens = 0;
    for name in input_fields {
        if let Some(v) = usage.get(name) {
            if !v.is_null() {
                matched_input_field = name;
                input_tokens = to_int(v);
                break;
            }
        }
    }

    let output_tokens = first_present_int(
        usage,
        &["outputTokens", "output_tokens", "completion_tokens"],
    )
    .unwrap_or(0);

    let prompt_details = usage.get("prompt_tokens_details").unwrap_or(&Value::Null);
    let input_details = usage.get("inputTokensDetails").unwrap_or(&Value::Null);

    let cache_read = first_present_int(
        usage,
        &[
            "cacheTokens",
            "cached_tokens",
            "cache_read_input_tokens",
            "prompt_cache_hit_tokens",
        ],
    )
    .or_else(|| first_present_int(prompt_details, &["cached_tokens"]))
    .or_else(|| first_present_int(input_details, &["cached_tokens"]))
    .unwrap_or(0);

    let cache_write = first_present_int(
        usage,
        &[
            "cache_creation_input_tokens",
            "prompt_cache_write_tokens",
            "cachedWriteTokens",
        ],
    )
    .unwrap_or(0);

    let mut final_input = input_tokens;
    // OpenAI-style prompt_tokens includes cache hits; subtract so the cache
    // share is not counted both as input and as cached.
    if matched_input_field == "prompt_tokens" {
        final_input = (final_input - cache_read).max(0);
    }

    let cached_tokens = cache_read + cache_write;

    if final_input <= 0 && output_tokens <= 0 && cached_tokens <= 0 {
        let total = to_int(
            usage
                .get("totalTokens")
                .or_else(|| usage.get("total_tokens"))
                .unwrap_or(&Value::Null),
        );
        if total > 0 {
            final_input = total;
        }
    }

    if final_input <= 0 && output_tokens <= 0 && cached_tokens <= 0 {
        return None;
    }

    let cost_usd = to_float(
        usage
            .get("cost_usd")
            .or_else(|| usage.get("cost"))
            .unwrap_or(&Value::Null),
    );

    Some((
        final_input,
        output_tokens,
        cached_tokens,
        cache_write,
        cost_usd,
    ))
}

pub(crate) const WORKBUDDY_PROJECT_CHECKPOINT_SOURCE_KIND: &str = "workbuddy-project-jsonl-v1";

pub(crate) fn scan_workbuddy_project_logs(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> (usize, bool) {
    let path = get_home_dir().join(".workbuddy/projects");
    if !path.exists() {
        return (0, false);
    }

    let mut count = 0;
    let mut saw_source_file = false;
    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        let filepath = entry.path();
        if filepath.is_file() && filepath.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            saw_source_file = true;
            let Some(before) = checkpointed_file_before(
                filepath,
                WORKBUDDY_PROJECT_CHECKPOINT_SOURCE_KIND,
                checkpoints,
            ) else {
                continue;
            };
            let session_hint = filepath
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown_session")
                .to_string();

            if let Ok(file) = File::open(filepath) {
                let reader = BufReader::new(file);
                for (line_num, line) in reader.lines().enumerate() {
                    if let Ok(line_content) = line {
                        if line_content.trim().is_empty() {
                            continue;
                        }
                        if let Ok(data) = serde_json::from_str::<Value>(&line_content) {
                            let provider = data.get("providerData").unwrap_or(&Value::Null);

                            let usage = provider
                                .get("usage")
                                .filter(|v| !v.is_null())
                                .or_else(|| data.get("usage").filter(|v| !v.is_null()))
                                .or_else(|| {
                                    data.get("message")
                                        .and_then(|m| m.get("usage"))
                                        .filter(|v| !v.is_null())
                                })
                                .or_else(|| provider.get("rawUsage").filter(|v| !v.is_null()))
                                .or_else(|| {
                                    provider
                                        .get("workbuddyToolResult")
                                        .and_then(|w| w.get("usage"))
                                        .filter(|v| !v.is_null())
                                });

                            if let Some((input, output, cached, cache_write, cost)) =
                                usage.and_then(parse_workbuddy_usage)
                            {
                                let model_val = provider
                                    .get("model")
                                    .or_else(|| data.get("model"))
                                    .unwrap_or(&Value::Null);

                                let model = if model_val.is_object() {
                                    model_val
                                        .get("modelID")
                                        .or_else(|| model_val.get("id"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("workbuddy-model")
                                } else {
                                    model_val.as_str().unwrap_or("workbuddy-model")
                                }
                                .to_string();

                                let ts = data
                                    .get("timestamp")
                                    .or_else(|| provider.get("timestamp"))
                                    .unwrap_or(&Value::Null);

                                let timestamp = normalize_timestamp(ts);
                                let session_id = data
                                    .get("sessionId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&session_hint)
                                    .to_string();

                                let msg_id = data
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&format!("line_{}", line_num + 1))
                                    .to_string();

                                let unique_key =
                                    format!("workbuddy_project_{}_{}", session_id, msg_id);

                                logs.push(LogRecord {
                                    tool: "workbuddy".to_string(),
                                    model,
                                    input_tokens: input,
                                    output_tokens: output,
                                    cached_tokens: cached,
                                    cache_write_tokens: cache_write,
                                    timestamp,
                                    session_id,
                                    unique_key,
                                    cost_usd: cost,
                                    cumulative: false,
                                });
                                count += 1;
                            }
                        }
                    }
                }
                finish_checkpointed_file(
                    filepath,
                    before,
                    WORKBUDDY_PROJECT_CHECKPOINT_SOURCE_KIND,
                    pending_checkpoints,
                );
            }
        }
    }
    (count, saw_source_file)
}

pub(crate) fn scan_workbuddy_agent_logs(logs: &mut Vec<LogRecord>) -> usize {
    let path = if cfg!(target_os = "macos") {
        get_home_dir().join("Library/Application Support/WorkBuddy/logs")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| get_home_dir().join("AppData/Roaming"))
            .join("WorkBuddy/logs")
    } else {
        get_home_dir().join(".local/share/WorkBuddy/logs")
    };

    if !path.exists() {
        return 0;
    }

    let mut count = 0;
    let mut log_files = Vec::new();
    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        let filepath = entry.path();
        let file_name = filepath.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if filepath.is_file() && file_name.starts_with("WorkBuddy") && file_name.ends_with(".log") {
            log_files.push(filepath.to_path_buf());
        }
    }

    let re_agent = Regex::new(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[info\] \[AgentReporter\] \[([a-f0-9]+)\] onAgentEnd: agent=(\w+)").unwrap();
    let re_usage = Regex::new(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[info\] \[AgentReporter\] \[([a-f0-9]+)\] Agent execution successful with usage: (\{.*?\})").unwrap();

    let mut req_to_agent = std::collections::HashMap::new();

    for filepath in log_files {
        if let Ok(file) = File::open(&filepath) {
            let reader = BufReader::new(file);
            let mut lines = Vec::new();
            for line in reader.lines().map_while(Result::ok) {
                // Pre-populate mapping of request_id -> agent_name
                if let Some(caps) = re_agent.captures(&line) {
                    let req_id = caps
                        .get(2)
                        .map(|m| m.as_str().to_string())
                        .unwrap_or_default();
                    let agent = caps
                        .get(3)
                        .map(|m| m.as_str().to_string())
                        .unwrap_or_default();
                    req_to_agent.insert(req_id, agent);
                }
                lines.push(line);
            }

            for line in lines {
                if let Some(caps) = re_usage.captures(&line) {
                    let ts_str = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                    let req_id = caps
                        .get(2)
                        .map(|m| m.as_str().to_string())
                        .unwrap_or_default();
                    let usage_json_str = caps.get(3).map(|m| m.as_str()).unwrap_or("{}");

                    if let Ok(usage) = serde_json::from_str::<Value>(usage_json_str) {
                        let input_tokens = to_int(usage.get("inputTokens").unwrap_or(&Value::Null));
                        let output_tokens =
                            to_int(usage.get("outputTokens").unwrap_or(&Value::Null));
                        let cached_tokens =
                            to_int(usage.get("cacheTokens").unwrap_or(&Value::Null));

                        let agent_name = req_to_agent
                            .get(&req_id)
                            .cloned()
                            .unwrap_or_else(|| "workbuddy-agent".to_string());
                        let model = format!("workbuddy-{}", agent_name);

                        let timestamp = normalize_timestamp(&Value::String(ts_str.to_string()));
                        let unique_key = format!("workbuddy_{}", req_id);

                        logs.push(LogRecord {
                            tool: "workbuddy".to_string(),
                            model,
                            input_tokens,
                            output_tokens,
                            cached_tokens,
                            cache_write_tokens: 0,
                            timestamp,
                            session_id: req_id,
                            unique_key,
                            cost_usd: None,
                            cumulative: false,
                        });
                        count += 1;
                    }
                }
            }
        }
    }
    count
}

pub(crate) fn scan_workbuddy(
    logs: &mut Vec<LogRecord>,
    project_checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let (project_count, saw_project_source) =
        scan_workbuddy_project_logs(logs, project_checkpoints, pending_checkpoints);
    if project_count > 0 || saw_project_source {
        project_count
    } else {
        scan_workbuddy_agent_logs(logs)
    }
}

pub(crate) fn scan_qclaw(logs: &mut Vec<LogRecord>) -> usize {
    let home = get_home_dir();
    let jsonl_pattern = home.join(".qclaw/agents");
    let mut count = 0;

    // 1. Scan jsonl files
    if jsonl_pattern.exists() {
        for entry in WalkDir::new(jsonl_pattern)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let filepath = entry.path();
            if filepath.is_file() && filepath.extension().and_then(|s| s.to_str()) == Some("jsonl")
            {
                let session_id = filepath
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown_session")
                    .to_string();

                if let Ok(file) = File::open(filepath) {
                    let reader = BufReader::new(file);
                    for (line_num, line) in reader.lines().enumerate() {
                        if let Ok(line_content) = line {
                            if line_content.trim().is_empty() {
                                continue;
                            }
                            if let Ok(data) = serde_json::from_str::<Value>(&line_content) {
                                let message = data.get("message").unwrap_or(&Value::Null);
                                let usage = message.get("usage").unwrap_or(&Value::Null);
                                if usage.is_object() {
                                    let mut input_tokens =
                                        to_int(usage.get("input").unwrap_or(&Value::Null));
                                    let output_tokens =
                                        to_int(usage.get("output").unwrap_or(&Value::Null));
                                    let qclaw_cache_write =
                                        to_int(usage.get("cacheWrite").unwrap_or(&Value::Null));
                                    let cached_tokens =
                                        to_int(usage.get("cacheRead").unwrap_or(&Value::Null))
                                            + qclaw_cache_write;

                                    if input_tokens <= 0 && output_tokens <= 0 && cached_tokens <= 0
                                    {
                                        let total = to_int(
                                            usage.get("totalTokens").unwrap_or(&Value::Null),
                                        );
                                        if total > 0 {
                                            input_tokens = total;
                                        } else {
                                            continue;
                                        }
                                    }

                                    let cost_total = nested_get(usage, &["cost", "total"]);
                                    let cost_usd = to_float(cost_total);

                                    let model = message
                                        .get("model")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("qclaw-model")
                                        .to_string();

                                    let ts = data
                                        .get("timestamp")
                                        .or_else(|| message.get("timestamp"))
                                        .unwrap_or(&Value::Null);

                                    let timestamp = normalize_timestamp(ts);
                                    let msg_id = data
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or(&format!("line_{}", line_num + 1))
                                        .to_string();

                                    let unique_key =
                                        format!("qclaw_jsonl_{}_{}", session_id, msg_id);

                                    logs.push(LogRecord {
                                        tool: "qclaw".to_string(),
                                        model,
                                        input_tokens,
                                        output_tokens,
                                        cached_tokens,
                                        cache_write_tokens: qclaw_cache_write,
                                        timestamp,
                                        session_id: session_id.clone(),
                                        unique_key,
                                        cost_usd,
                                        cumulative: false,
                                    });
                                    count += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Scan hermes response db
    let db_path = home.join(".qclaw-hermes/response_store.db");
    if db_path.exists() {
        if let Ok(conn) = Connection::open(&db_path) {
            let table_check: Result<i64> = conn.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='responses'",
                params![],
                |r| r.get::<_, i64>(0),
            );

            if table_check.is_ok() {
                if let Ok(mut stmt) =
                    conn.prepare("SELECT response_id, data, accessed_at FROM responses")
                {
                    let rows = stmt.query_map(params![], |row| {
                        let response_id: String = row.get(0)?;
                        let raw_data: String = row.get(1)?;
                        let accessed_at: String = row.get(2)?;
                        Ok((response_id, raw_data, accessed_at))
                    });

                    if let Ok(rows) = rows {
                        for r in rows.flatten() {
                            let (response_id, raw_data, accessed_at): (String, String, String) = r;
                            if let Ok(data) = serde_json::from_str::<Value>(&raw_data) {
                                let response = data.get("response").unwrap_or(&Value::Null);
                                let usage = response.get("usage").unwrap_or(&Value::Null);
                                if usage.is_object() {
                                    let input_tokens =
                                        to_int(usage.get("input_tokens").unwrap_or(&Value::Null));
                                    let output_tokens =
                                        to_int(usage.get("output_tokens").unwrap_or(&Value::Null));
                                    let cache_write = to_int(
                                        usage
                                            .get("cache_creation_input_tokens")
                                            .unwrap_or(&Value::Null),
                                    );
                                    let cached_tokens = to_int(
                                        usage
                                            .get("cache_read_input_tokens")
                                            .unwrap_or(&Value::Null),
                                    ) + cache_write;

                                    let model = response
                                        .get("model")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("hermes-model")
                                        .to_string();

                                    let timestamp =
                                        normalize_timestamp(&Value::String(accessed_at));
                                    let unique_key = format!("hermes_{}", response_id);

                                    logs.push(LogRecord {
                                        tool: "hermes".to_string(),
                                        model,
                                        input_tokens,
                                        output_tokens,
                                        cached_tokens,
                                        cache_write_tokens: cache_write,
                                        timestamp,
                                        session_id: response_id,
                                        unique_key,
                                        cost_usd: None,
                                        cumulative: false,
                                    });
                                    count += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    count
}

/// Hermes Agent's `state.db` (shared with the project index, T10.165).
pub(crate) fn hermes_state_db_path(home: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
            PathBuf::from(local_appdata).join("hermes/state.db")
        } else {
            home.join("AppData/Local/hermes/state.db")
        }
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/hermes/state.db")
    } else {
        home.join(".config/hermes/state.db")
    }
}

pub(crate) fn scan_hermes(logs: &mut Vec<LogRecord>) -> usize {
    let home = get_home_dir();
    let db_path = hermes_state_db_path(&home);

    if !db_path.exists() {
        return 0;
    }

    let mut count = 0;
    if let Ok(conn) = Connection::open(db_path) {
        let table_check: Result<i64> = conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'",
            params![],
            |r| r.get::<_, i64>(0),
        );

        if table_check.is_ok() {
            let query = "SELECT id, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, actual_cost_usd, estimated_cost_usd FROM sessions";
            if let Ok(mut stmt) = conn.prepare(query) {
                let rows = stmt.query_map(params![], |row| {
                    let id: String = row.get(0)?;
                    let model: String = row.get(1)?;
                    let started_at: f64 = row.get(2)?;
                    let input: i64 = row.get(3)?;
                    let output: i64 = row.get(4)?;
                    let c_read: i64 = row.get(5)?;
                    let c_write: i64 = row.get(6)?;
                    let actual_cost: Option<f64> = row.get(7)?;
                    let est_cost: Option<f64> = row.get(8)?;
                    Ok((
                        id,
                        model,
                        started_at,
                        input,
                        output,
                        c_read,
                        c_write,
                        actual_cost.or(est_cost),
                    ))
                });

                if let Ok(rows) = rows {
                    for r in rows.flatten() {
                        let (id, model, started_at, input, output, c_read, c_write, cost) = r;
                        if input <= 0 && output <= 0 && c_read + c_write <= 0 {
                            continue;
                        }

                        let timestamp = normalize_timestamp(&serde_json::json!(started_at));
                        let unique_key = format!("hermes_{}", id);
                        let cached = c_read + c_write;

                        // sessions rows accumulate in place while a session is
                        // running; mark cumulative so run_scan stores deltas
                        // instead of freezing the first-scan snapshot.
                        logs.push(LogRecord {
                            tool: "hermes".to_string(),
                            model: clean_model_name(&model),
                            input_tokens: input,
                            output_tokens: output,
                            cached_tokens: cached,
                            cache_write_tokens: c_write,
                            timestamp,
                            session_id: id,
                            unique_key,
                            cost_usd: cost,
                            cumulative: true,
                        });
                        count += 1;
                    }
                }
            }
        }
    }
    count
}

pub(crate) const TRAE_CHECKPOINT_SOURCE_KIND: &str = "trae-ai-agent-log-v1";

pub(crate) fn scan_trae(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let mut base_dirs = Vec::new();
    if cfg!(target_os = "macos") {
        base_dirs.push(get_home_dir().join("Library/Application Support"));
    } else if cfg!(target_os = "windows") {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            base_dirs.push(PathBuf::from(appdata));
        }
        if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
            base_dirs.push(PathBuf::from(local_appdata));
        }
        base_dirs.push(get_home_dir().join("AppData/Roaming"));
        base_dirs.push(get_home_dir().join("AppData/Local"));
    } else {
        base_dirs.push(get_home_dir().join(".config"));
    }

    let mut trae_paths = Vec::new();
    for base_dir in base_dirs {
        if base_dir.exists() {
            if let Ok(entries) = fs::read_dir(base_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.to_uppercase().starts_with("TRAE") {
                        let logs_path = entry.path().join("logs");
                        if logs_path.exists() {
                            trae_paths.push(logs_path);
                        }
                    }
                }
            }
        }
    }

    if trae_paths.is_empty() {
        return 0;
    }

    let mut count = 0;
    let re_history_id = Regex::new(r#"history_id:\s*"([^"]+)""#).unwrap();
    let re_conversation_id = Regex::new(r#"conversation_id:\s*"([^"]+)""#).unwrap();
    let re_session_id = Regex::new(r#"session_id:\s*(?:Some\("([^"]+)"\)|None)"#).unwrap();
    let re_model = Regex::new(r#"\\"(?:model|model_name)\\"\s*:\s*\\"([^\\"]+)\\""#).unwrap();
    let re_item_usage = Regex::new(r#"item_token_usage:\s*(\d+)"#).unwrap();
    let re_created_at = Regex::new(r#"created_at:\s*(\d+)"#).unwrap();
    let re_source = Regex::new(r#"source:\s*"([^"]+)""#).unwrap();

    for logs_dir in trae_paths {
        for entry in WalkDir::new(logs_dir).into_iter().filter_map(|e| e.ok()) {
            let filepath = entry.path();
            let file_name = filepath.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if filepath.is_file()
                && file_name.contains("ai-agent")
                && file_name.ends_with("_stdout.log")
            {
                let Some(before) =
                    checkpointed_file_before(filepath, TRAE_CHECKPOINT_SOURCE_KIND, checkpoints)
                else {
                    continue;
                };
                if let Ok(file) = File::open(filepath) {
                    let reader = BufReader::new(file);
                    for line in reader.lines().map_while(Result::ok) {
                        if !line.contains("HistoryEvent") {
                            continue;
                        }

                        let mut timestamp = String::new();
                        // Try parsing log prefix timestamp (ISO 8601 like: 2026-04-13T10:30:26.211Z)
                        if line.len() >= 25
                            && line.chars().nth(4) == Some('-')
                            && line.chars().nth(7) == Some('-')
                            && line.chars().nth(10) == Some('T')
                        {
                            if let Some(raw_ts) = line.split_whitespace().next() {
                                timestamp = normalize_timestamp(&Value::String(raw_ts.to_string()));
                            }
                        }

                        let m_hid = re_history_id.captures(&line);
                        if m_hid.is_none() {
                            continue;
                        }
                        let history_id = m_hid
                            .unwrap()
                            .get(1)
                            .map(|m| m.as_str())
                            .unwrap_or("")
                            .to_string();
                        if history_id.is_empty() {
                            continue;
                        }

                        let m_conv = re_conversation_id.captures(&line);
                        let conversation_id = m_conv
                            .map(|m| m.get(1).map(|x| x.as_str()).unwrap_or("unknown_conv"))
                            .unwrap_or("unknown_conv")
                            .to_string();

                        let m_sess = re_session_id.captures(&line);
                        let session_id = m_sess
                            .and_then(|m| m.get(1).map(|x| x.as_str().to_string()))
                            .unwrap_or_else(|| conversation_id.clone());

                        let m_usage = re_item_usage.captures(&line);
                        let item_usage = m_usage
                            .and_then(|m| m.get(1).and_then(|x| x.as_str().parse::<i64>().ok()))
                            .unwrap_or(0);
                        if item_usage <= 0 {
                            continue;
                        }

                        let m_source = re_source.captures(&line);
                        let source = m_source
                            .map(|m| m.get(1).map(|x| x.as_str()).unwrap_or(""))
                            .unwrap_or("");

                        if let Some(m_created) = re_created_at
                            .captures(&line)
                            .filter(|_| timestamp.is_empty())
                        {
                            let created_millis = m_created
                                .get(1)
                                .and_then(|x| x.as_str().parse::<i64>().ok())
                                .unwrap_or(0);
                            timestamp = normalize_timestamp(&Value::Number(created_millis.into()));
                        }

                        if timestamp.is_empty() {
                            if let Ok(metadata) = filepath.metadata() {
                                if let Ok(mtime) = metadata.modified() {
                                    let dt: DateTime<Local> = mtime.into();
                                    timestamp = dt.format("%Y-%m-%d %H:%M:%S").to_string();
                                }
                            }
                        }

                        let m_model = re_model.captures(&line);
                        let model = m_model
                            .map(|m| m.get(1).map(|x| x.as_str()).unwrap_or("MiniMax-M2.7"))
                            .unwrap_or("MiniMax-M2.7")
                            .to_string();

                        let (input_tokens, output_tokens) = if source == "llm_default" {
                            (0, item_usage)
                        } else {
                            (item_usage, 0)
                        };

                        let unique_key = format!("trae_{}", history_id);

                        logs.push(LogRecord {
                            tool: "trae".to_string(),
                            model,
                            input_tokens,
                            output_tokens,
                            cached_tokens: 0,
                            cache_write_tokens: 0,
                            timestamp,
                            session_id,
                            unique_key,
                            cost_usd: None,
                            cumulative: false,
                        });
                        count += 1;
                    }
                    finish_checkpointed_file(
                        filepath,
                        before,
                        TRAE_CHECKPOINT_SOURCE_KIND,
                        pending_checkpoints,
                    );
                }
            }
        }
    }
    count
}

/// Zcode CLI database (shared with the project index, T10.165).
pub(crate) fn zcode_db_path(home: &Path) -> PathBuf {
    home.join(".zcode/cli/db/db.sqlite")
}

/// Scans Zcode's CLI SQLite DB (~/.zcode/cli/db/db.sqlite).
///
/// Reads the per-request `model_usage` table (finest granularity, like Codex's
/// per-turn rows). The `turn_usage` table is an exact aggregate of these rows
/// and `tool_usage` carries no tokens, so both are skipped to avoid
/// double-counting. Zcode's `input_tokens` is inclusive of cache-read volume
/// (verified: computed_total_tokens == input + output), so the scanner nets
/// cache reads/writes out before storage — cache volume stays in the combined
/// cache column and never re-enters effective tokens. Rows are immutable per
/// request (status flips to a terminal value, tokens don't grow), so they
/// dedup by primary key with INSERT OR IGNORE rather than as deltas.
pub(crate) fn scan_zcode(logs: &mut Vec<LogRecord>) -> usize {
    let db_path = zcode_db_path(&get_home_dir());
    scan_zcode_db(&db_path, logs)
}

pub(crate) fn scan_zcode_db(db_path: &std::path::Path, logs: &mut Vec<LogRecord>) -> usize {
    if !db_path.exists() {
        return 0;
    }

    let mut count = 0;
    if let Ok(conn) = Connection::open(db_path) {
        let table_check: Result<i64> = conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_usage'",
            params![],
            |r| r.get::<_, i64>(0),
        );

        if table_check.is_ok() {
            let query = "SELECT id, session_id, model_id, started_at, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM model_usage";
            if let Ok(mut stmt) = conn.prepare(query) {
                let rows = stmt.query_map(params![], |row| {
                    let id: String = row.get(0)?;
                    let session_id: String = row.get(1)?;
                    let model_id: String = row.get(2)?;
                    let started_at: i64 = row.get(3)?;
                    let input: i64 = row.get(4)?;
                    let output: i64 = row.get(5)?;
                    let reasoning: i64 = row.get(6)?;
                    let cache_write: i64 = row.get(7)?;
                    let cache_read: i64 = row.get(8)?;
                    Ok((
                        id,
                        session_id,
                        model_id,
                        started_at,
                        input,
                        output,
                        reasoning,
                        cache_write,
                        cache_read,
                    ))
                });

                if let Ok(rows) = rows {
                    for r in rows.flatten() {
                        let (
                            id,
                            session_id,
                            model_id,
                            started_at,
                            input,
                            output,
                            reasoning,
                            cache_write,
                            cache_read,
                        ) = r;

                        // Reasoning tokens are billed as output; cache read and
                        // creation share the combined cache column.
                        let output_tokens = output + reasoning;
                        let cached = cache_read + cache_write;
                        // Zcode's input includes cache hits (computed_total ==
                        // input + output held for every row), so net the cache
                        // volume out — effective tokens must never count it
                        // twice.
                        let input_tokens = 0.max(input - cached);

                        // status='error' rows report all zeros — drop them.
                        if input_tokens <= 0 && output_tokens <= 0 && cached <= 0 {
                            continue;
                        }

                        // started_at is a 13-digit ms epoch; normalize_timestamp
                        // scales it down via its >1e11 rule.
                        let timestamp = normalize_timestamp(&serde_json::json!(started_at));
                        let unique_key = format!("zcode_{}", id);

                        logs.push(LogRecord {
                            tool: "zcode".to_string(),
                            model: clean_model_name(&model_id),
                            input_tokens,
                            output_tokens,
                            cached_tokens: cached,
                            cache_write_tokens: cache_write,
                            timestamp,
                            session_id,
                            unique_key,
                            cost_usd: None,
                            cumulative: false,
                        });
                        count += 1;
                    }
                }
            }
        }
    }
    count
}

pub(crate) const DEEPSEEKGUI_CHECKPOINT_SOURCE_KIND: &str = "deepseekgui-events-jsonl-v1";

/// DeepSeek GUI thread directory, honouring the app's `dataDir` override
/// (shared with the project index, T10.165).
pub(crate) fn deepseekgui_threads_dir() -> PathBuf {
    let base_dir = if cfg!(target_os = "macos") {
        get_home_dir().join("Library/Application Support/DeepSeek GUI")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| get_home_dir().join("AppData/Roaming"))
            .join("DeepSeek GUI")
    } else {
        get_home_dir().join(".config/DeepSeek GUI")
    };

    let mut data_dir = get_home_dir().join(".deepseekgui/kun");
    let settings_path = base_dir.join("deepseek-gui-settings.json");
    if settings_path.exists() {
        if let Ok(settings_str) = fs::read_to_string(settings_path) {
            if let Ok(settings) = serde_json::from_str::<Value>(&settings_str) {
                if let Some(custom_dir) = settings
                    .get("agents")
                    .and_then(|a| a.get("kun"))
                    .and_then(|k| k.get("dataDir"))
                    .and_then(|d| d.as_str())
                {
                    if let Some(custom_dir) = custom_dir.strip_prefix("~/") {
                        data_dir = get_home_dir().join(custom_dir);
                    } else if let Some(custom_dir) = custom_dir.strip_prefix('~') {
                        data_dir = get_home_dir().join(custom_dir);
                    } else {
                        data_dir = PathBuf::from(custom_dir);
                    }
                }
            }
        }
    }

    data_dir.join("threads")
}

pub(crate) fn scan_deepseekgui(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let threads_dir = deepseekgui_threads_dir();
    scan_deepseekgui_dir_checkpointed(&threads_dir, logs, checkpoints, pending_checkpoints)
}

#[derive(Clone, Debug)]
pub(crate) struct DeepSeekGuiUsageSnapshot {
    pub(crate) prompt_tokens: i64,
    pub(crate) output_tokens: i64,
    pub(crate) cached_tokens: i64,
    pub(crate) cache_miss_tokens: Option<i64>,
}

impl DeepSeekGuiUsageSnapshot {
    fn delta_from(&self, previous: &Self) -> Option<Self> {
        let prompt_tokens = self.prompt_tokens - previous.prompt_tokens;
        let output_tokens = self.output_tokens - previous.output_tokens;
        let cached_tokens = self.cached_tokens - previous.cached_tokens;
        let cache_miss_tokens = match (self.cache_miss_tokens, previous.cache_miss_tokens) {
            (Some(current), Some(previous)) => Some(current - previous),
            _ => None,
        };

        let cache_miss_valid = cache_miss_tokens.map(|v| v >= 0).unwrap_or(true);
        if prompt_tokens < 0 || output_tokens < 0 || cached_tokens < 0 || !cache_miss_valid {
            return None;
        }

        Some(Self {
            prompt_tokens,
            output_tokens,
            cached_tokens,
            cache_miss_tokens,
        })
    }

    fn record_tokens(&self) -> (i64, i64, i64) {
        let input_tokens = self
            .cache_miss_tokens
            .unwrap_or_else(|| self.prompt_tokens - self.cached_tokens)
            .max(0);
        (
            input_tokens,
            self.output_tokens.max(0),
            self.cached_tokens.max(0),
        )
    }
}

fn deepseekgui_int_field(value: &Value, names: &[&str]) -> (i64, bool) {
    for name in names {
        if let Some(field) = value.get(*name) {
            return (to_int(field), true);
        }
    }
    (0, false)
}

#[cfg(test)]
pub(crate) fn scan_deepseekgui_dir(threads_dir: &Path, logs: &mut Vec<LogRecord>) -> usize {
    scan_deepseekgui_dir_checkpointed(threads_dir, logs, &HashMap::new(), &mut Vec::new())
}

pub(crate) fn scan_deepseekgui_dir_checkpointed(
    threads_dir: &Path,
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    if !threads_dir.exists() {
        return 0;
    }

    let mut count = 0;
    let mut previous_by_turn: HashMap<(String, String), DeepSeekGuiUsageSnapshot> = HashMap::new();
    if let Ok(entries) = fs::read_dir(threads_dir) {
        for entry in entries.flatten() {
            let thread_path = entry.path();
            if thread_path.is_dir() {
                let thread_hint = thread_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown_thread")
                    .to_string();

                let events_path = thread_path.join("events.jsonl");
                if events_path.exists() {
                    let Some(before) = checkpointed_file_before(
                        &events_path,
                        DEEPSEEKGUI_CHECKPOINT_SOURCE_KIND,
                        checkpoints,
                    ) else {
                        continue;
                    };
                    if let Ok(file) = File::open(&events_path) {
                        let reader = BufReader::new(file);
                        for (line_num, line) in reader.lines().enumerate() {
                            if let Ok(line_content) = line {
                                if line_content.trim().is_empty() {
                                    continue;
                                }
                                if let Ok(data) = serde_json::from_str::<Value>(&line_content) {
                                    if data.get("kind").and_then(|v| v.as_str()) == Some("usage") {
                                        let usage = data.get("usage").unwrap_or(&Value::Null);
                                        if usage.is_object() {
                                            let (prompt_tokens, _) = deepseekgui_int_field(
                                                usage,
                                                &["promptTokens", "prompt_tokens"],
                                            );

                                            let (output_tokens, _) = deepseekgui_int_field(
                                                usage,
                                                &["completionTokens", "completion_tokens"],
                                            );

                                            let (cached_tokens, _) = deepseekgui_int_field(
                                                usage,
                                                &[
                                                    "cacheHitTokens",
                                                    "cachedTokens",
                                                    "cached_tokens",
                                                ],
                                            );

                                            let (cache_miss_tokens, has_cache_miss) =
                                                deepseekgui_int_field(
                                                    usage,
                                                    &["cacheMissTokens", "cache_miss_tokens"],
                                                );

                                            if prompt_tokens <= 0
                                                && output_tokens <= 0
                                                && cached_tokens <= 0
                                            {
                                                continue;
                                            }

                                            let snapshot = DeepSeekGuiUsageSnapshot {
                                                prompt_tokens,
                                                output_tokens,
                                                cached_tokens,
                                                cache_miss_tokens: if has_cache_miss {
                                                    Some(cache_miss_tokens)
                                                } else {
                                                    None
                                                },
                                            };

                                            let model = data
                                                .get("model")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("deepseek-v4-pro")
                                                .to_string();

                                            let ts = data.get("timestamp").unwrap_or(&Value::Null);
                                            let timestamp = normalize_timestamp(ts);

                                            let session_id = data
                                                .get("threadId")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or(&thread_hint)
                                                .to_string();

                                            let turn_id = data
                                                .get("turnId")
                                                .and_then(|v| v.as_str())
                                                .filter(|v| !v.is_empty())
                                                .map(|v| v.to_string());

                                            let seq = data
                                                .get("seq")
                                                .and_then(|v| v.as_i64())
                                                .unwrap_or(line_num as i64);

                                            let record_snapshot = if let Some(turn_id) = &turn_id {
                                                let key = (session_id.clone(), turn_id.clone());
                                                let next_snapshot = previous_by_turn
                                                    .get(&key)
                                                    .and_then(|previous| {
                                                        snapshot.delta_from(previous)
                                                    })
                                                    .unwrap_or_else(|| snapshot.clone());
                                                previous_by_turn.insert(key, snapshot);
                                                next_snapshot
                                            } else {
                                                snapshot
                                            };

                                            let (input_tokens, output_tokens, cached_tokens) =
                                                record_snapshot.record_tokens();
                                            if input_tokens <= 0
                                                && output_tokens <= 0
                                                && cached_tokens <= 0
                                            {
                                                continue;
                                            }

                                            let unique_key =
                                                format!("deepseekgui_{}_{}", session_id, seq);

                                            logs.push(LogRecord {
                                                tool: "deepseek".to_string(),
                                                model,
                                                input_tokens,
                                                output_tokens,
                                                cached_tokens,
                                                cache_write_tokens: 0,
                                                timestamp,
                                                session_id,
                                                unique_key,
                                                cost_usd: None,
                                                cumulative: false,
                                            });
                                            count += 1;
                                        }
                                    }
                                }
                            }
                        }
                        finish_checkpointed_file(
                            &events_path,
                            before,
                            DEEPSEEKGUI_CHECKPOINT_SOURCE_KIND,
                            pending_checkpoints,
                        );
                    }
                }
            }
        }
    }

    count
}

// DeepSeek's official DSH agent stores each session as a zstd-compressed
// JSONL stream. A completed model request appears twice: first as an
// `assistant/chunk` usage snapshot and then as the canonical
// `assistant/message`. Only the latter is ledgered so a request cannot be
// counted twice.

#[cfg(test)]
mod scanner_zcode_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    type ZcodeFixtureRow<'a> = (i64, &'a str, &'a str, i64, i64, i64, i64, i64, i64);

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tokenledger_zcode_test_{suffix}"));
        fs::create_dir_all(&root).expect("create zcode test root");
        root
    }

    fn write_zcode_db(db_path: &Path, rows: &[ZcodeFixtureRow<'_>]) {
        let conn = Connection::open(db_path).expect("create zcode fixture db");
        conn.execute_batch(
            "CREATE TABLE model_usage (
                 id TEXT PRIMARY KEY,
                 session_id TEXT NOT NULL,
                 model_id TEXT NOT NULL,
                 started_at INTEGER NOT NULL,
                 input_tokens INTEGER NOT NULL,
                 output_tokens INTEGER NOT NULL,
                 reasoning_tokens INTEGER NOT NULL,
                 cache_creation_input_tokens INTEGER NOT NULL,
                 cache_read_input_tokens INTEGER NOT NULL
             );",
        )
        .expect("create model_usage table");
        for (id, session, model, started_at, input, output, reasoning, cache_write, cache_read) in
            rows
        {
            conn.execute(
                "INSERT INTO model_usage (id, session_id, model_id, started_at, input_tokens,
                    output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    format!("row-{id}"),
                    session,
                    model,
                    started_at,
                    input,
                    output,
                    reasoning,
                    cache_write,
                    cache_read,
                ],
            )
            .expect("insert fixture row");
        }
    }

    #[test]
    fn nets_cache_out_of_inclusive_input() {
        let root = temp_root();
        let db_path = root.join("db.sqlite");
        // Real-world shape: input is inclusive of cache reads (computed_total
        // == input + output), so 126005 - 125568 = 437 fresh tokens.
        write_zcode_db(
            &db_path,
            &[(
                1,
                "s1",
                "glm-5.2",
                1787099832862,
                126005,
                275,
                42,
                0,
                125568,
            )],
        );
        let mut logs = Vec::new();
        assert_eq!(scan_zcode_db(&db_path, &mut logs), 1);
        assert_eq!(logs[0].tool, "zcode");
        assert_eq!(logs[0].input_tokens, 437);
        assert_eq!(logs[0].cached_tokens, 125568);
        assert_eq!(logs[0].cache_write_tokens, 0);
        assert_eq!(logs[0].output_tokens, 275 + 42);
        assert_eq!(logs[0].unique_key, "zcode_row-1");
        fs::remove_dir_all(&root).expect("remove zcode test root");
    }

    #[test]
    fn cache_larger_than_input_is_clamped_to_zero() {
        let root = temp_root();
        let db_path = root.join("db.sqlite");
        write_zcode_db(
            &db_path,
            &[(2, "s1", "glm-5.2", 1787099832862, 100, 10, 0, 60, 90)],
        );
        let mut logs = Vec::new();
        assert_eq!(scan_zcode_db(&db_path, &mut logs), 1);
        assert_eq!(logs[0].input_tokens, 0);
        assert_eq!(logs[0].cached_tokens, 150);
        fs::remove_dir_all(&root).expect("remove zcode test root");
    }

    #[test]
    fn all_zero_rows_are_dropped() {
        let root = temp_root();
        let db_path = root.join("db.sqlite");
        write_zcode_db(
            &db_path,
            &[(3, "s1", "glm-5.2", 1787099832862, 0, 0, 0, 0, 0)],
        );
        let mut logs = Vec::new();
        assert_eq!(scan_zcode_db(&db_path, &mut logs), 0);
        assert!(logs.is_empty());
        fs::remove_dir_all(&root).expect("remove zcode test root");
    }

    #[test]
    fn missing_db_yields_zero() {
        let root = temp_root();
        let mut logs = Vec::new();
        assert_eq!(scan_zcode_db(&root.join("absent.sqlite"), &mut logs), 0);
        fs::remove_dir_all(&root).expect("remove zcode test root");
    }
}

#[cfg(test)]
mod scanner_zcode_real_tests {
    use super::*;

    #[test]
    #[ignore = "requires an explicitly authorized local Zcode database"]
    fn reads_authorized_real_zcode_db() {
        let db_path = std::env::var_os("TOKENLEDGER_ZCODE_REAL_DB")
            .map(PathBuf::from)
            .expect("set TOKENLEDGER_ZCODE_REAL_DB explicitly");
        let mut logs = Vec::new();
        let scanned = scan_zcode_db(&db_path, &mut logs);
        assert!(scanned > 0);
        assert_eq!(logs.len(), scanned);
        assert!(logs.iter().all(|record| record.tool == "zcode"));
        let total_input: i64 = logs.iter().map(|record| record.input_tokens).sum();
        let total_cached: i64 = logs.iter().map(|record| record.cached_tokens).sum();
        let total_output: i64 = logs.iter().map(|record| record.output_tokens).sum();
        println!(
            "REAL rows={scanned} net_input={total_input} cached={total_cached} output={total_output}"
        );
        // Net input must be far below cache volume on this cache-heavy source
        // (the inclusive value previously inflated effective tokens ~58x).
        assert!(
            total_input < total_cached / 10,
            "net input {total_input} should be a small fraction of cache volume {total_cached}"
        );
    }
}
