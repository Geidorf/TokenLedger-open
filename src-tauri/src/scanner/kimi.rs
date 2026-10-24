use super::checkpoints::*;
use super::helpers::*;
use super::jsonl::bounded_lines;
use super::types::LogRecord;
use chrono::{Local, TimeZone};
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

// v2 corrects the v1 scope interpretation. Changing the source kind forces a
// one-time rescan so session-origin records skipped by v1 are backfilled.
pub(crate) const KIMI_CHECKPOINT_SOURCE_KIND: &str = "kimi-wire-jsonl-v2";

/// Kimi Code writes one append-only `wire.jsonl` per agent run under
/// `~/.kimi-code/sessions/wd_*/session_*/agents/*/`. The main agent and every
/// subagent get their own wire file; subagent spend is real spend, so all of
/// them are scanned.
pub(crate) fn kimi_wire_candidates_from(
    home: &Path,
    configured_home: Option<&OsStr>,
) -> Vec<PathBuf> {
    let primary = configured_home
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".kimi-code"))
        .join("sessions");
    // Pre-rename installs kept the same layout; harmless when absent.
    let legacy = home.join(".kimi/sessions");
    if primary == legacy {
        vec![primary]
    } else {
        vec![primary, legacy]
    }
}

pub(crate) fn kimi_wire_candidates(home: &Path) -> Vec<PathBuf> {
    let configured_home = std::env::var_os("KIMI_CODE_HOME");
    kimi_wire_candidates_from(home, configured_home.as_deref())
}

fn kimi_hash_prefix(value: &[u8]) -> String {
    Sha256::digest(value)[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn kimi_timestamp(value: &Value) -> Option<String> {
    let raw = to_int(value);
    if raw <= 0 {
        return None;
    }
    let datetime = if raw > 100_000_000_000 {
        Local.timestamp_millis_opt(raw).single()
    } else {
        Local.timestamp_opt(raw, 0).single()
    }?;
    Some(datetime.format("%Y-%m-%d %H:%M:%S").to_string())
}

fn is_kimi_wire(path: &Path) -> bool {
    if !path.is_file() || path.file_name().and_then(|v| v.to_str()) != Some("wire.jsonl") {
        return false;
    }
    // Only accept the sessions/<wd>/<session>/agents/<agent>/wire.jsonl layout
    // so unrelated wire dumps never enter token accounting.
    path.parent()
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .and_then(|v| v.to_str())
        == Some("agents")
}

/// Shared wire.jsonl parser for both Kimi flavors. `tool` selects the stored
/// tool name and unique-key prefix: `kimi` keeps the historical `kimi_` /
/// `kimi_v2_` keyspace (v1/v2 backfill compatibility), while `kimidesktop`
/// uses its own prefixes so desktop records can never alias CLI records even
/// if a user points both roots at the same directory.
pub(crate) fn scan_kimi_file_as(
    filepath: &Path,
    source_identity: &str,
    tool: &str,
    logs: &mut Vec<LogRecord>,
) -> std::result::Result<usize, String> {
    let agent_dir = filepath
        .parent()
        .ok_or_else(|| format!("Kimi wire path has no agent dir: {}", filepath.display()))?;
    let agent_id = agent_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown_agent");
    let session_id = agent_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .and_then(|v| v.to_str())
        .unwrap_or("unknown_session")
        .to_string();

    let file = File::open(filepath)
        .map_err(|error| format!("failed to open Kimi wire {}: {error}", filepath.display()))?;
    let reader = BufReader::new(file);
    let mut count = 0;

    let source_hash = kimi_hash_prefix(source_identity.as_bytes());
    // kimi keeps its historical keyspace; other flavors (kimidesktop) get
    // isolated prefixes so their records can never alias CLI records.
    let legacy_prefix = tool;
    let v2_prefix = format!("{tool}_v2");
    let mut seen_legacy_keys = HashSet::new();
    for (line_index, line) in bounded_lines(reader).enumerate() {
        let Ok(line_content) = line else {
            continue;
        };
        let trimmed = line_content.trim();
        // Wire rows carry full prompt and tool context; only usage rows matter
        // for token accounting, so skip the rest before paying for a JSON parse.
        if !trimmed.contains("\"usage.record\"") {
            continue;
        }
        let Ok(data) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if data.get("type").and_then(Value::as_str) != Some("usage.record") {
            continue;
        }
        // Kimi records every model request exactly once. `usageScope` describes
        // whether the request originated from the active turn or session-level
        // work; it is not an aggregation flag. Older rows may omit the field.
        let usage_scope = match data.get("usageScope") {
            Some(Value::String(scope)) if scope == "turn" => "turn",
            Some(Value::String(scope)) if scope == "session" => "session",
            None | Some(Value::Null) => "session",
            Some(_) => continue,
        };
        let usage = data.get("usage").unwrap_or(&Value::Null);
        if !usage.is_object() {
            continue;
        }

        let input_tokens = to_int(usage.get("inputOther").unwrap_or(&Value::Null));
        let output_tokens = to_int(usage.get("output").unwrap_or(&Value::Null));
        let cache_read = to_int(usage.get("inputCacheRead").unwrap_or(&Value::Null));
        let cache_write = to_int(usage.get("inputCacheCreation").unwrap_or(&Value::Null));
        if [input_tokens, output_tokens, cache_read, cache_write]
            .iter()
            .any(|value| *value < 0)
        {
            continue;
        }
        if input_tokens == 0 && output_tokens == 0 && cache_read == 0 && cache_write == 0 {
            continue;
        }
        let Some(cached_tokens) = cache_read.checked_add(cache_write) else {
            continue;
        };

        let model = data
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("kimi-unknown")
            .to_string();
        let Some(timestamp) = data.get("time").and_then(kimi_timestamp) else {
            continue;
        };
        // Preserve v1 turn keys so the v2 backfill does not reinsert rows that
        // were already stored. New scopes and real v1-key collisions use a
        // stronger path/line/content key without exposing the local path.
        let legacy_key = format!(
            "{legacy_prefix}_{session_id}_{agent_id}_{}_{}_{}_{}_{}",
            to_int(data.get("time").unwrap_or(&Value::Null)),
            input_tokens,
            output_tokens,
            cache_read,
            cache_write
        );
        let record_hash = kimi_hash_prefix(trimmed.as_bytes());
        let unique_key = if usage_scope == "turn" && seen_legacy_keys.insert(legacy_key.clone()) {
            legacy_key
        } else {
            format!("{v2_prefix}_{source_hash}_{}_{record_hash}", line_index + 1)
        };

        logs.push(LogRecord {
            tool: tool.to_string(),
            model,
            input_tokens,
            output_tokens,
            cached_tokens,
            cache_write_tokens: cache_write,
            timestamp,
            session_id: session_id.clone(),
            unique_key,
            cost_usd: None,
            cumulative: false,
        });
        count += 1;
    }
    Ok(count)
}

pub(crate) fn scan_kimi_roots_checkpointed(
    roots: &[PathBuf],
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    logs: &mut Vec<LogRecord>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
    tool: &str,
    checkpoint_kind: &str,
) -> usize {
    let mut count = 0;
    let mut visited_files = HashSet::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        // wire files sit at sessions/<wd>/<session>/agents/<agent>/wire.jsonl,
        // five levels below the root; nothing deeper is relevant.
        for entry in WalkDir::new(root).max_depth(5) {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    log::warn!("failed to walk Kimi wire source: {error}");
                    continue;
                }
            };
            let filepath = entry.path();
            if !is_kimi_wire(filepath) {
                continue;
            }
            let Some(before) = checkpointed_file_before(filepath, checkpoint_kind, checkpoints)
            else {
                continue;
            };
            if !visited_files.insert(before.normalized_path.clone()) {
                continue;
            }
            match scan_kimi_file_as(filepath, &before.normalized_path, tool, logs) {
                Ok(parsed) => count += parsed,
                Err(error) => {
                    log::warn!("{error}");
                    continue;
                }
            }
            finish_checkpointed_file(filepath, before, checkpoint_kind, pending_checkpoints);
        }
    }
    count
}

pub(crate) fn scan_kimi(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let roots = kimi_wire_candidates(&get_home_dir());
    scan_kimi_roots_checkpointed(
        &roots,
        checkpoints,
        logs,
        pending_checkpoints,
        "kimi",
        KIMI_CHECKPOINT_SOURCE_KIND,
    )
}

// Kimi Desktop (the kimi-desktop app) embeds its own kimi-code runtime, whose
// wire files use the identical schema but live under the app's data root.
// Tracked as a separate tool so desktop spend never aliases CLI spend.
pub(crate) const KIMI_DESKTOP_CHECKPOINT_SOURCE_KIND: &str = "kimidesktop-wire-jsonl-v2";

pub(crate) fn kimi_desktop_wire_candidates() -> Vec<PathBuf> {
    #[allow(unused_variables)]
    let home = get_home_dir();
    let suffix = "daimon-share/daimon/runtime/kimi-code/home/sessions";
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("kimi-desktop")
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support/kimi-desktop")
    } else {
        home.join(".config/kimi-desktop")
    };
    vec![base.join(suffix)]
}

pub(crate) fn scan_kimi_desktop(
    logs: &mut Vec<LogRecord>,
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> usize {
    let roots = kimi_desktop_wire_candidates();
    scan_kimi_roots_checkpointed(
        &roots,
        checkpoints,
        logs,
        pending_checkpoints,
        "kimidesktop",
        KIMI_DESKTOP_CHECKPOINT_SOURCE_KIND,
    )
}

#[cfg(test)]
mod scanner_kimi_tests {
    use super::*;
    use std::fs::{self, File};
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
            "tokenledger_kimi_test_{}_{}_{}",
            std::process::id(),
            now_nanos,
            sequence
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_wire(path: &Path, lines: &[serde_json::Value]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = File::create(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn usage_record(
        scope: Option<&str>,
        time: i64,
        input: i64,
        output: i64,
        cache_read: i64,
        cache_write: i64,
    ) -> serde_json::Value {
        let mut record = serde_json::json!({
            "type": "usage.record",
            "model": "kimi-k3",
            "usage": {
                "inputOther": input,
                "output": output,
                "inputCacheRead": cache_read,
                "inputCacheCreation": cache_write
            },
            "time": time
        });
        if let Some(scope) = scope {
            record["usageScope"] = Value::String(scope.to_string());
        }
        record
    }

    #[test]
    fn parses_each_supported_scope_and_rejects_invalid_usage() {
        let root = temp_root();
        let sessions = root.join(".kimi-code/sessions");
        let main_wire = sessions.join("wd_a/session_s1/agents/main/wire.jsonl");
        let sub_wire = sessions.join("wd_a/session_s1/agents/agent-0/wire.jsonl");
        write_wire(
            &main_wire,
            &[
                usage_record(Some("turn"), 1784534400000, 120, 34, 500, 40),
                // Identical rows are still separate model requests.
                usage_record(Some("turn"), 1784534400000, 120, 34, 500, 40),
                usage_record(Some("session"), 1784534401000, 30, 9, 70, 8),
                // Older Kimi rows did not require usageScope.
                usage_record(None, 1784534402000, 7, 3, 2, 1),
                usage_record(Some("future-scope"), 1784534403000, 99, 99, 0, 0),
                serde_json::json!({
                    "type": "usage.record",
                    "model": "kimi-k3",
                    "usage": {"inputOther": 99, "output": 99},
                    "usageScope": 7,
                    "time": 1784534403500i64
                }),
                usage_record(Some("turn"), 0, 99, 99, 0, 0),
                usage_record(Some("turn"), 1784534404000, -1, 4, 0, 0),
                usage_record(Some("turn"), 1784534405000, 0, 0, 0, 0),
                // Non-usage wire rows are ignored.
                serde_json::json!({"type": "step.end", "time": 1784534406000i64}),
            ],
        );
        write_wire(
            &sub_wire,
            &[usage_record(Some("turn"), 1784534407000, 10, 5, 0, 0)],
        );

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_kimi_roots_checkpointed(
            std::slice::from_ref(&sessions),
            &HashMap::new(),
            &mut logs,
            &mut pending,
            "kimi",
            KIMI_CHECKPOINT_SOURCE_KIND,
        );
        assert_eq!(parsed, 5);
        assert_eq!(logs.len(), 5);
        assert!(logs
            .iter()
            .all(|log| log.unique_key.starts_with("kimi_") && !log.cumulative));
        assert_eq!(
            logs.iter()
                .map(|log| &log.unique_key)
                .collect::<HashSet<_>>()
                .len(),
            5
        );

        let main = logs
            .iter()
            .find(|log| log.input_tokens == 120)
            .expect("main agent record");
        assert_eq!(main.tool, "kimi");
        assert_eq!(main.model, "kimi-k3");
        assert_eq!(main.input_tokens, 120);
        assert_eq!(main.output_tokens, 34);
        assert_eq!(main.cached_tokens, 540);
        assert_eq!(main.cache_write_tokens, 40);
        assert_eq!(main.session_id, "session_s1");
        assert!(!main.cumulative);
        assert!(main.cost_usd.is_none());

        assert_eq!(logs.iter().filter(|log| log.input_tokens == 120).count(), 2);
        assert!(logs
            .iter()
            .any(|log| { log.unique_key == "kimi_session_s1_main_1784534400000_120_34_500_40" }));
        assert!(logs
            .iter()
            .any(|log| log.input_tokens == 30 && log.output_tokens == 9));
        assert!(logs
            .iter()
            .any(|log| log.input_tokens == 7 && log.output_tokens == 3));
        assert!(logs
            .iter()
            .filter(|log| log.input_tokens == 30 || log.input_tokens == 7)
            .all(|log| log.unique_key.starts_with("kimi_v2_")));
        assert_eq!(
            logs.iter()
                .filter(|log| log.input_tokens == 120)
                .filter(|log| log.unique_key.starts_with("kimi_v2_"))
                .count(),
            1
        );

        let sub = logs
            .iter()
            .find(|log| log.input_tokens == 10)
            .expect("subagent record");
        assert_eq!(sub.input_tokens, 10);

        // Both wire files advanced their checkpoints.
        assert_eq!(pending.len(), 2);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn honors_kimi_code_home_and_keeps_legacy_fallback() {
        let home = Path::new("/users/tester");
        let roots = kimi_wire_candidates_from(home, Some(OsStr::new("/data/kimi")));
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/data/kimi/sessions"),
                PathBuf::from("/users/tester/.kimi/sessions")
            ]
        );

        let default_roots = kimi_wire_candidates_from(home, None);
        assert_eq!(
            default_roots[0],
            PathBuf::from("/users/tester/.kimi-code/sessions")
        );
    }

    #[test]
    fn v1_checkpoint_does_not_block_v2_backfill() {
        let root = temp_root();
        let sessions = root.join(".kimi-code/sessions");
        let main_wire = sessions.join("wd_a/session_s1/agents/main/wire.jsonl");
        write_wire(
            &main_wire,
            &[usage_record(
                Some("session"),
                1784534400000,
                120,
                34,
                500,
                40,
            )],
        );
        let fingerprint = source_fingerprint(&main_wire).unwrap();
        let legacy = fingerprint.checkpoint_for("kimi-wire-jsonl-v1");
        let checkpoints = HashMap::from([(fingerprint.normalized_path.clone(), legacy)]);

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        assert_eq!(
            scan_kimi_roots_checkpointed(
                std::slice::from_ref(&sessions),
                &checkpoints,
                &mut logs,
                &mut pending,
                "kimi",
                KIMI_CHECKPOINT_SOURCE_KIND,
            ),
            1
        );
        assert_eq!(logs.len(), 1);
        assert_eq!(pending[0].source_kind, KIMI_CHECKPOINT_SOURCE_KIND);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn checkpoint_skips_unchanged_wire_and_persist_is_idempotent() {
        let root = temp_root();
        let sessions = root.join(".kimi-code/sessions");
        let main_wire = sessions.join("wd_a/session_s1/agents/main/wire.jsonl");
        write_wire(
            &main_wire,
            &[usage_record(Some("turn"), 1784534400000, 120, 34, 500, 40)],
        );

        let db_path = root.join("kimi-test.db");
        crate::db::init_db(&db_path).unwrap();
        let conn = crate::db::get_connection(&db_path).unwrap();
        let checkpoints =
            crate::db::load_scan_checkpoints(&conn, KIMI_CHECKPOINT_SOURCE_KIND).unwrap();
        drop(conn);

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_kimi_roots_checkpointed(
            std::slice::from_ref(&sessions),
            &checkpoints,
            &mut logs,
            &mut pending,
            "kimi",
            KIMI_CHECKPOINT_SOURCE_KIND,
        );
        assert_eq!(parsed, 1);
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 1);

        // Second pass: the unchanged wire is checkpoint-skipped entirely.
        let conn = crate::db::get_connection(&db_path).unwrap();
        let checkpoints =
            crate::db::load_scan_checkpoints(&conn, KIMI_CHECKPOINT_SOURCE_KIND).unwrap();
        drop(conn);
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_kimi_roots_checkpointed(
            std::slice::from_ref(&sessions),
            &checkpoints,
            &mut logs,
            &mut pending,
            "kimi",
            KIMI_CHECKPOINT_SOURCE_KIND,
        );
        assert_eq!(parsed, 0);
        assert!(logs.is_empty());
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 0);

        // Even without checkpoints, INSERT OR IGNORE keeps the row unique.
        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_kimi_roots_checkpointed(
            &[sessions],
            &HashMap::new(),
            &mut logs,
            &mut pending,
            "kimi",
            KIMI_CHECKPOINT_SOURCE_KIND,
        );
        assert_eq!(parsed, 1);
        let outcome = persist_scan_batch(&db_path, logs, pending, Vec::new(), None).unwrap();
        assert_eq!(outcome.inserted, 0);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn kimidesktop_roots_follow_platform_conventions() {
        let roots = kimi_desktop_wire_candidates();
        assert_eq!(roots.len(), 1);
        let root = roots[0].to_string_lossy().replace('\\', "/");
        assert!(root.contains("kimi-desktop"));
        assert!(root.ends_with("daimon-share/daimon/runtime/kimi-code/home/sessions"));
        if cfg!(target_os = "windows") {
            assert!(
                root.contains("Roaming/kimi-desktop") || root.contains("Roaming\\kimi-desktop")
            );
        } else if cfg!(target_os = "macos") {
            assert!(root.contains("Library/Application Support/kimi-desktop"));
        } else {
            assert!(root.contains(".config/kimi-desktop"));
        }
    }

    #[test]
    fn kimidesktop_uses_own_keyspace_and_tool() {
        let root = temp_root();
        // Desktop sessions also use conv-*/ctitle-* directory shapes; only the
        // agents/<agent>/wire.jsonl tail is enforced.
        let sessions = root.join("kimi-desktop/sessions");
        let wire = sessions.join("conv-abc123/agents/main/wire.jsonl");
        write_wire(
            &wire,
            &[
                usage_record(Some("turn"), 1784534400000, 120, 34, 500, 40),
                usage_record(Some("session"), 1784534401000, 30, 9, 70, 8),
            ],
        );

        let mut logs = Vec::new();
        let mut pending = Vec::new();
        let parsed = scan_kimi_roots_checkpointed(
            std::slice::from_ref(&sessions),
            &HashMap::new(),
            &mut logs,
            &mut pending,
            "kimidesktop",
            KIMI_DESKTOP_CHECKPOINT_SOURCE_KIND,
        );
        assert_eq!(parsed, 2);
        assert_eq!(logs.len(), 2);
        assert!(logs.iter().all(|log| log.tool == "kimidesktop"));
        assert!(logs.iter().all(|log| log.session_id == "conv-abc123"));
        assert!(logs
            .iter()
            .all(|log| log.unique_key.starts_with("kimidesktop_")));
        // No key may fall into the bare CLI kimi keyspace.
        assert!(logs.iter().all(|log| !log.unique_key.starts_with("kimi_")));
        assert!(logs
            .iter()
            .any(|log| log.unique_key.starts_with("kimidesktop_conv-abc123_main_")));
        assert!(logs
            .iter()
            .any(|log| log.unique_key.starts_with("kimidesktop_v2_")));
        assert_eq!(pending[0].source_kind, KIMI_DESKTOP_CHECKPOINT_SOURCE_KIND);

        fs::remove_dir_all(root).ok();
    }
}
