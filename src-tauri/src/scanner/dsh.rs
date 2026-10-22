use super::checkpoints::*;
use super::helpers::*;
use super::types::LogRecord;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[cfg(test)]
use super::runner::persist_scan_batch;
#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const DSH_CHECKPOINT_SOURCE_KIND: &str = "dsh-session-zstd-v1";

pub(crate) fn dsh_sessions_root(home: &Path) -> PathBuf {
    home.join(".dsh/sessions")
}

/// 返回日志文件的世代序数：旧版 `session.jsonl.zstd` 记为 0，版本化的
/// `session.vN.jsonl.zstd` 记为 N。非会话日志返回 `None`。
///
/// DSH 会话日志的文件名在版本间改过名（旧版 `session.jsonl.zstd`，自 2026-09-11 起为
/// `session.v3.jsonl.zstd`），精确文件名相等匹配会让改名后的会话整目录静默跳过
/// （不报错、不落库），因此改为结构化识别以兼容两代及后续 `session.vN` 形态。
///
/// DSH 改名时还会**就地重写历史会话**——实测部分会话目录同时留下旧名文件与内容完全
/// 相同的 `session.v3.jsonl.zstd`（同会话 id、同 message id、同时间戳）。两者逐条解析
/// 会产生同一 `unique_key` 的重复行，因此同一目录内必须只取世代最高的文件。
pub(crate) fn dsh_session_log_generation(file_name: &OsStr) -> Option<u32> {
    let name = file_name.to_str()?;
    let stem = name.strip_suffix(".jsonl.zstd")?;
    match stem.strip_prefix("session")? {
        // legacy: session.jsonl.zstd
        "" => Some(0),
        // versioned: session.v3.jsonl.zstd / session.v4.jsonl.zstd ...
        rest => rest
            .strip_prefix(".v")?
            .parse::<u32>()
            .ok()
            .filter(|_| rest[2..].bytes().all(|b| b.is_ascii_digit())),
    }
}

fn dsh_session_hint(filepath: &Path) -> String {
    filepath
        .parent()
        .and_then(Path::file_name)
        .and_then(OsStr::to_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown_session")
        .to_string()
}

fn dsh_nonnegative_counter(usage: &Value, field: &str, required: bool) -> Option<i64> {
    let Some(value) = usage.get(field) else {
        return (!required).then_some(0);
    };
    value
        .as_i64()
        .filter(|value| *value >= 0)
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
}

fn dsh_record_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn dsh_timestamp(value: &Value) -> Option<String> {
    let raw = value.as_i64().filter(|value| *value > 0).or_else(|| {
        value
            .as_u64()
            .filter(|value| *value > 0)
            .and_then(|value| i64::try_from(value).ok())
    })?;
    Some(normalize_timestamp(&Value::Number(raw.into())))
}

pub(crate) fn scan_dsh_file(
    filepath: &Path,
    logs: &mut Vec<LogRecord>,
) -> std::result::Result<usize, String> {
    let file = File::open(filepath)
        .map_err(|error| format!("failed to open DSH session {}: {error}", filepath.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file).map_err(|error| {
        format!(
            "failed to open DSH zstd stream {}: {error}",
            filepath.display()
        )
    })?;
    let mut reader = BufReader::new(decoder);
    let mut line = String::new();
    let mut line_number = 0usize;
    let session_hint = dsh_session_hint(filepath);
    let mut session_id = session_hint.clone();
    let mut session_created_at = Value::Null;
    let mut latest_model: Option<String> = None;
    let mut file_logs = Vec::new();

    loop {
        line.clear();
        let bytes = reader.read_line(&mut line).map_err(|error| {
            format!(
                "failed to decompress DSH session {} at line {}: {error}",
                filepath.display(),
                line_number + 1
            )
        })?;
        if bytes == 0 {
            break;
        }
        line_number += 1;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event = serde_json::from_str::<Value>(trimmed).map_err(|error| {
            format!(
                "failed to parse DSH session {} at line {line_number}: {error}",
                filepath.display()
            )
        })?;
        let event_type = event.get("type").and_then(Value::as_str);
        if event_type == Some("session") {
            if let Some(value) = event
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                session_id = value.to_string();
            }
            session_created_at = event.get("createdAt").cloned().unwrap_or(Value::Null);
            continue;
        }
        if event_type == Some("request/header") {
            latest_model = event
                .pointer("/data/header/config/model")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(clean_model_name);
            continue;
        }
        if event_type != Some("assistant/message") {
            continue;
        }

        let data = event.get("data").unwrap_or(&Value::Null);
        let usage = data.get("usage").unwrap_or(&Value::Null);
        if !usage.is_object() {
            continue;
        }
        let Some(input_tokens) = dsh_nonnegative_counter(usage, "inputTokens", true) else {
            continue;
        };
        let Some(output_tokens) = dsh_nonnegative_counter(usage, "outputTokens", true) else {
            continue;
        };
        let Some(cached_tokens) = dsh_nonnegative_counter(usage, "cacheReadTokens", false) else {
            continue;
        };
        // DSH exposes reasoningTokens as an output detail. Like Codex's
        // reasoning_output_tokens, it is already included in outputTokens and
        // is validated but never added a second time.
        if dsh_nonnegative_counter(usage, "reasoningTokens", false).is_none() {
            continue;
        }
        if input_tokens == 0 && output_tokens == 0 && cached_tokens == 0 {
            continue;
        }

        let message = data.get("message").unwrap_or(&Value::Null);
        let model = message
            .pointer("/source/model")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(clean_model_name)
            .or_else(|| latest_model.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "dsh-unknown".to_string());
        let message_id = message
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                event
                    .get("seq")
                    .and_then(Value::as_i64)
                    .map(|seq| format!("seq-{seq}"))
            })
            .unwrap_or_else(|| format!("line-{line_number}"));
        let timestamp_value = event
            .get("time")
            .or_else(|| event.get("time0"))
            .filter(|value| !value.is_null())
            .unwrap_or(&session_created_at);
        let Some(timestamp) = dsh_timestamp(timestamp_value) else {
            continue;
        };
        let unique_key = format!(
            "dsh_{}_{}",
            dsh_record_hash(&session_id),
            dsh_record_hash(&message_id)
        );

        file_logs.push(LogRecord {
            tool: "dsh".to_string(),
            model,
            input_tokens,
            output_tokens,
            cached_tokens,
            cache_write_tokens: 0,
            timestamp,
            session_id: session_id.clone(),
            unique_key,
            cost_usd: None,
            cumulative: false,
        });
    }

    let count = file_logs.len();
    logs.extend(file_logs);
    Ok(count)
}

pub(crate) fn scan_dsh_root_checkpointed(
    sessions_root: &Path,
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    if !sessions_root.exists() {
        return 0;
    }
    // 同一会话目录内若新旧两代文件并存（DSH 改名时就地重写了历史会话），只保留世代最高
    // 的那个，避免同一 message id 产生重复 unique_key。
    let mut selected: HashMap<PathBuf, (u32, PathBuf)> = HashMap::new();
    for entry in WalkDir::new(sessions_root)
        .max_depth(4)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| match entry {
            Ok(entry) if entry.file_type().is_file() => Some(entry),
            Ok(_) => None,
            Err(error) => {
                log::warn!("failed to walk DSH sessions: {error}");
                None
            }
        })
    {
        let Some(generation) = dsh_session_log_generation(entry.file_name()) else {
            continue;
        };
        let filepath = entry.into_path();
        let directory = filepath
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| filepath.clone());
        match selected.get(&directory) {
            Some((kept, _)) if *kept >= generation => {}
            _ => {
                selected.insert(directory, (generation, filepath));
            }
        }
    }
    let mut files = selected
        .into_values()
        .map(|(_, filepath)| filepath)
        .collect::<Vec<_>>();
    files.sort();

    let mut count = 0;
    for filepath in files {
        let Some(before) =
            checkpointed_file_before(&filepath, DSH_CHECKPOINT_SOURCE_KIND, checkpoints)
        else {
            continue;
        };
        match scan_dsh_file(&filepath, logs) {
            Ok(parsed) => count += parsed,
            Err(error) => {
                log::warn!("{error}");
                continue;
            }
        }
        finish_checkpointed_file(
            &filepath,
            before,
            DSH_CHECKPOINT_SOURCE_KIND,
            pending_checkpoints,
        );
    }
    count
}

pub(crate) fn scan_dsh(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    scan_dsh_root_checkpointed(
        &dsh_sessions_root(&get_home_dir()),
        logs,
        checkpoints,
        pending_checkpoints,
    )
}

#[cfg(test)]
mod scanner_dsh_tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    fn temp_root() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("tokenledger_dsh_test_{suffix}"));
        fs::create_dir_all(&root).expect("create DSH test root");
        root
    }

    fn message_event(id: &str, seq: i64, time: i64, input: i64) -> Value {
        json!({
            "type": "assistant/message",
            "seq": seq,
            "time": time,
            "data": {
                "turn": 1,
                "step": seq,
                "message": {
                    "role": "assistant",
                    "source": {
                        "kind": "model",
                        "provider": "deepseek-official",
                        "model": "deepseek-v4-pro"
                    },
                    "id": id
                },
                "usage": {
                    "inputTokens": input,
                    "outputTokens": 520,
                    "cacheReadTokens": 12800,
                    "reasoningTokens": 369
                }
            }
        })
    }

    fn write_session(filepath: &Path, messages: &[Value]) {
        fs::create_dir_all(filepath.parent().expect("session parent"))
            .expect("create session parent");
        let file = File::create(filepath).expect("create compressed session");
        let mut encoder = zstd::stream::write::Encoder::new(file, 1).expect("create encoder");
        let rows = [
            json!({
                "type": "session",
                "version": 1,
                "id": "session-00000000-0000-4000-8000-000000000028",
                "createdAt": 1786629900000_i64,
                "cwd": "C:/fixture",
                "delegationDepth": 0,
                "agentPreset": "fixture"
            }),
            json!({
                "type": "request/header",
                "seq": 10,
                "time": 1786629900100_i64,
                "data": {
                    "header": {
                        "config": {
                            "provider": "deepseek-official",
                            "model": "deepseek-v4-pro",
                            "reasoningEffort": "high",
                            "maxTokens": 256000
                        }
                    },
                    "reason": "fixture"
                }
            }),
            // DSH writes this usage snapshot before the canonical message.
            // It must never become a second ledger row.
            json!({
                "type": "assistant/chunk",
                "seq": 51,
                "time": 1786629979942_i64,
                "data": {
                    "turn": 1,
                    "step": 1,
                    "chunk": {
                        "type": "usage",
                        "usage": {
                            "inputTokens": 12553,
                            "outputTokens": 359,
                            "cacheReadTokens": 0,
                            "reasoningTokens": 140
                        }
                    }
                }
            }),
        ];
        for row in rows.iter().chain(messages.iter()) {
            serde_json::to_writer(&mut encoder, row).expect("write JSON row");
            encoder.write_all(b"\n").expect("write newline");
        }
        encoder.finish().expect("finish compressed session");
    }

    #[test]
    fn parses_canonical_messages_without_double_counting_chunk_or_reasoning() {
        let root = temp_root();
        let filepath = root.join(
            "--fixture-workspace--/session-00000000-0000-4000-8000-000000000028/session.jsonl.zstd",
        );
        let first = message_event("message-1", 53, 1786629979947, 12_553);
        let mut second = message_event("message-2", 99, 1786630050584, 805);
        second
            .pointer_mut("/data/message/source")
            .expect("source")
            .take();
        let invalid = message_event("message-negative", 100, 1786630050585, -1);
        write_session(&filepath, &[first, second, invalid]);

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_dsh_root_checkpointed(&root, &mut logs, &HashMap::new(), &mut pending);

        assert_eq!(parsed, 2);
        assert_eq!(logs.len(), 2);
        assert_eq!(pending.len(), 1);
        assert!(logs.iter().all(|record| record.tool == "dsh"));
        assert!(logs.iter().all(|record| record.model == "deepseek-v4-pro"));
        assert!(logs
            .iter()
            .all(|record| { record.session_id == "session-00000000-0000-4000-8000-000000000028" }));
        assert_eq!(logs[0].input_tokens, 12_553);
        assert_eq!(logs[0].output_tokens, 520);
        assert_eq!(
            logs[0].output_tokens, 520,
            "reasoningTokens is already part of outputTokens"
        );
        assert_eq!(logs[0].cached_tokens, 12_800);
        assert_eq!(logs[0].cache_write_tokens, 0);
        assert_eq!(
            logs[0].timestamp,
            normalize_timestamp(&json!(1786629979947_i64))
        );
        assert_ne!(logs[0].unique_key, logs[1].unique_key);
        assert!(logs
            .iter()
            .all(|record| record.unique_key.starts_with("dsh_")));

        fs::remove_dir_all(&root).expect("remove DSH test root");
    }

    #[test]
    fn session_log_filename_predicate_accepts_both_generations() {
        for (accepted, expected) in [
            ("session.jsonl.zstd", 0),
            ("session.v3.jsonl.zstd", 3),
            // DSH 未来的版本化命名应继续被接受，避免再次静默漏扫。
            ("session.v4.jsonl.zstd", 4),
            ("session.v10.jsonl.zstd", 10),
        ] {
            assert_eq!(
                dsh_session_log_generation(OsStr::new(accepted)),
                Some(expected),
                "{accepted} should be scanned as generation {expected}"
            );
        }
        for rejected in [
            "session.jsonl",
            "session.v3.jsonl",
            "session.v3.jsonl.zstd.tmp",
            "notsession.v3.jsonl.zstd",
            "session.v3.jsonl.gz",
            "sessions.jsonl.zstd",
            "session.v.jsonl.zstd",
            "session.vX.jsonl.zstd",
            "session.v3.extra.jsonl.zstd",
        ] {
            assert_eq!(
                dsh_session_log_generation(OsStr::new(rejected)),
                None,
                "{rejected} should not be scanned"
            );
        }
    }

    /// 回归：DSH 自 2026-09-11 起把落盘文件名改为 `session.v3.jsonl.zstd`，
    /// 旧版精确相等匹配会让新版会话整目录静默跳过。该用例在修复前为红。
    #[test]
    fn v3_renamed_session_log_is_scanned_and_matches_legacy_semantics() {
        let root = temp_root();
        let v3_path = root.join(
            "--fixture-workspace--/session-00000000-0000-4000-8000-000000000031/session.v3.jsonl.zstd",
        );
        write_session(
            &v3_path,
            &[message_event("message-v3", 17, 1786629979947, 15_295)],
        );

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_dsh_root_checkpointed(&root, &mut logs, &HashMap::new(), &mut pending);

        assert_eq!(parsed, 1, "v3-named session log must be scanned");
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].tool, "dsh");
        assert_eq!(logs[0].model, "deepseek-v4-pro");
        assert_eq!(logs[0].input_tokens, 15_295);
        assert_eq!(logs[0].output_tokens, 520);
        assert_eq!(logs[0].cached_tokens, 12_800);
        assert_eq!(logs[0].cache_write_tokens, 0);
        assert!(logs[0].unique_key.starts_with("dsh_"));
        assert_eq!(pending.len(), 1);

        fs::remove_dir_all(&root).expect("remove DSH test root");
    }

    /// 两代命名混存时都应被扫描，且去重键空间一致（不得因文件名差异重复计账）。
    #[test]
    fn legacy_and_v3_named_logs_are_both_scanned() {
        let root = temp_root();
        let legacy_path = root.join(
            "--fixture-workspace--/session-00000000-0000-4000-8000-000000000032/session.jsonl.zstd",
        );
        let v3_path = root.join(
            "--fixture-workspace--/session-00000000-0000-4000-8000-000000000033/session.v3.jsonl.zstd",
        );
        write_session(
            &legacy_path,
            &[message_event("message-legacy", 53, 1786629979947, 1_000)],
        );
        write_session(
            &v3_path,
            &[message_event("message-v3", 17, 1786629979948, 2_000)],
        );

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_dsh_root_checkpointed(&root, &mut logs, &HashMap::new(), &mut pending);

        assert_eq!(parsed, 2);
        assert_eq!(logs.len(), 2);
        assert_eq!(
            pending.len(),
            2,
            "each session file keeps its own checkpoint"
        );
        assert_ne!(logs[0].unique_key, logs[1].unique_key);
        assert!(logs
            .iter()
            .all(|record| record.unique_key.starts_with("dsh_")));

        fs::remove_dir_all(&root).expect("remove DSH test root");
    }

    #[test]
    fn unchanged_file_is_checkpointed_and_rewrite_is_safely_rescanned() {
        let root = temp_root();
        let filepath = root.join(
            "--fixture-workspace--/session-00000000-0000-4000-8000-000000000028/session.jsonl.zstd",
        );
        write_session(
            &filepath,
            &[message_event("message-1", 53, 1786629979947, 12_553)],
        );

        let mut first_logs = Vec::new();
        let mut first_pending = Vec::new();
        assert_eq!(
            scan_dsh_root_checkpointed(&root, &mut first_logs, &HashMap::new(), &mut first_pending,),
            1
        );
        let checkpoints = first_pending
            .iter()
            .cloned()
            .map(|checkpoint| (checkpoint.source_path.clone(), checkpoint))
            .collect::<HashMap<_, _>>();

        let mut unchanged_logs = Vec::new();
        let mut unchanged_pending = Vec::new();
        assert_eq!(
            scan_dsh_root_checkpointed(
                &root,
                &mut unchanged_logs,
                &checkpoints,
                &mut unchanged_pending,
            ),
            0
        );
        assert!(unchanged_logs.is_empty());
        assert!(unchanged_pending.is_empty());

        write_session(
            &filepath,
            &[
                message_event("message-1", 53, 1786629979947, 12_553),
                message_event("message-2", 99, 1786630050584, 805),
            ],
        );
        let mut changed_logs = Vec::new();
        let mut changed_pending = Vec::new();
        assert_eq!(
            scan_dsh_root_checkpointed(
                &root,
                &mut changed_logs,
                &checkpoints,
                &mut changed_pending,
            ),
            2
        );
        assert_eq!(changed_pending.len(), 1);

        fs::remove_dir_all(&root).expect("remove DSH test root");
    }

    #[test]
    fn corrupt_zstd_is_not_partially_ledgered_or_checkpointed() {
        let root = temp_root();
        let filepath = root.join(
            "--fixture-workspace--/session-00000000-0000-4000-8000-000000000028/session.jsonl.zstd",
        );
        fs::create_dir_all(filepath.parent().expect("session parent"))
            .expect("create session parent");
        fs::write(&filepath, b"not-a-zstd-frame").expect("write corrupt fixture");

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_dsh_root_checkpointed(&root, &mut logs, &HashMap::new(), &mut pending),
            0
        );
        assert!(logs.is_empty());
        assert!(pending.is_empty());

        fs::remove_dir_all(&root).expect("remove DSH test root");
    }

    #[test]
    fn persists_rows_and_checkpoint_in_one_scan_batch() {
        let root = temp_root();
        let filepath = root.join(
            "--fixture-workspace--/session-00000000-0000-4000-8000-000000000028/session.jsonl.zstd",
        );
        write_session(
            &filepath,
            &[
                message_event("message-1", 53, 1786629979947, 12_553),
                message_event("message-2", 99, 1786630050584, 805),
            ],
        );
        let db_path = root.join("tokenboard.db");
        crate::db::init_test_db(&db_path).expect("initialize DSH fixture db");

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_dsh_root_checkpointed(&root, &mut logs, &HashMap::new(), &mut pending),
            2
        );
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None)
            .expect("persist DSH scan batch");
        assert_eq!(outcome.inserted, 2);

        let conn = crate::db::get_connection(&db_path).expect("open DSH fixture db");
        let totals = conn
            .query_row(
                "SELECT COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cached_tokens), SUM(cache_write_tokens)
                 FROM token_logs WHERE tool = 'dsh'",
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
            .expect("query DSH totals");
        assert_eq!(totals, (2, 13_358, 1_040, 25_600, 0));
        let checkpoints = crate::db::load_scan_checkpoints(&conn, DSH_CHECKPOINT_SOURCE_KIND)
            .expect("load DSH checkpoint");
        drop(conn);

        let mut repeated_logs = Vec::new();
        let mut repeated_pending = Vec::new();
        assert_eq!(
            scan_dsh_root_checkpointed(
                &root,
                &mut repeated_logs,
                &checkpoints,
                &mut repeated_pending,
            ),
            0
        );
        assert!(repeated_logs.is_empty());
        assert!(repeated_pending.is_empty());

        fs::remove_dir_all(&root).expect("remove DSH test root");
    }

    /// 真实数据探针（需显式授权目录）：不仅要求扫到行，还要求整轮扫描**不产生重复
    /// `unique_key`**——DSH 改名时会就地重写历史会话，同一目录可能新旧并存。
    #[test]
    #[ignore = "requires an explicitly authorized local DSH sessions directory"]
    fn reads_authorized_real_dsh_sessions() {
        use std::collections::HashSet;
        let root = std::env::var_os("TOKENLEDGER_DSH_REAL_SESSIONS")
            .map(PathBuf::from)
            .expect("set TOKENLEDGER_DSH_REAL_SESSIONS explicitly");
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let scanned = scan_dsh_root_checkpointed(&root, &mut logs, &HashMap::new(), &mut pending);
        assert!(scanned > 0);
        assert_eq!(logs.len(), scanned);
        assert!(!pending.is_empty());

        let keys: HashSet<_> = logs
            .iter()
            .map(|record| record.unique_key.clone())
            .collect();
        assert_eq!(
            keys.len(),
            logs.len(),
            "同一 message id 不得因新旧两代文件并存而重复计账"
        );

        let input_tokens: i64 = logs.iter().map(|record| record.input_tokens).sum();
        let output_tokens: i64 = logs.iter().map(|record| record.output_tokens).sum();
        let cached_tokens: i64 = logs.iter().map(|record| record.cached_tokens).sum();
        println!(
            "authorized DSH rows={scanned} unique_keys={} input_tokens={input_tokens} output_tokens={output_tokens} cached_tokens={cached_tokens}",
            keys.len()
        );
    }

    /// 回归：新旧两代文件并存于同一会话目录时（DSH 改名时就地重写历史会话的真实形态），
    /// 只取世代最高的一个，不得对同一 message id 重复计账。
    #[test]
    fn coexisting_generations_in_one_directory_are_not_double_counted() {
        let root = temp_root();
        let directory = "--fixture-workspace--/session-00000000-0000-4000-8000-000000000034";
        // 同名 id / 同 seq / 同时间戳 = 同一消息，仅文件名世代不同。
        let shared = message_event("message-shared", 53, 1786629979947, 12_553);
        let legacy_path = root.join(directory).join("session.jsonl.zstd");
        let v3_path = root.join(directory).join("session.v3.jsonl.zstd");
        write_session(&legacy_path, std::slice::from_ref(&shared));
        write_session(&v3_path, std::slice::from_ref(&shared));

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_dsh_root_checkpointed(&root, &mut logs, &HashMap::new(), &mut pending);

        assert_eq!(parsed, 1, "同一目录只应计一次");
        assert_eq!(logs.len(), 1);
        assert_eq!(pending.len(), 1, "只应为被选中的那一代建立检查点");
        assert_eq!(logs[0].input_tokens, 12_553);
        // 选中的必须是高世代文件
        let selected = pending
            .iter()
            .find(|checkpoint| checkpoint.source_path.contains("000000000034"))
            .expect("checkpoint for the fixture session");
        assert!(
            selected.source_path.ends_with("session.v3.jsonl.zstd"),
            "世代更高的文件应胜出，实际为 {}",
            selected.source_path
        );

        fs::remove_dir_all(&root).expect("remove DSH test root");
    }
}
