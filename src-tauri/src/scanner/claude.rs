use super::checkpoints::*;
use super::helpers::*;
use super::types::{CheckpointScanStats, LogRecord};
use rusqlite::Result;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub(crate) const CLAUDE_CHECKPOINT_SOURCE_KIND: &str = "claude-jsonl-v2";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeHostPlatform {
    Macos,
    Windows,
    Other,
}

pub(crate) fn current_claude_host_platform() -> ClaudeHostPlatform {
    if cfg!(target_os = "macos") {
        ClaudeHostPlatform::Macos
    } else if cfg!(target_os = "windows") {
        ClaudeHostPlatform::Windows
    } else {
        ClaudeHostPlatform::Other
    }
}

fn push_claude_cowork_candidates(paths: &mut Vec<PathBuf>, base: &Path) {
    for app_dir in ["Claude", "Claude-3p"] {
        paths.push(base.join(app_dir).join("local-agent-mode-sessions"));
    }
}

/// Produces candidates without requiring them to exist so every platform
/// branch can be exercised by unit tests on any host. Windows Store installs
/// use filesystem virtualization, so enumerate every Claude_* package family
/// in addition to the currently known package id.
pub(crate) fn claude_log_candidates_for(
    platform: ClaudeHostPlatform,
    home: &Path,
    appdata: Option<&Path>,
    local_appdata: Option<&Path>,
    xdg_config_home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut paths = vec![home.join(".claude/projects")];
    match platform {
        ClaudeHostPlatform::Macos => {
            push_claude_cowork_candidates(&mut paths, &home.join("Library/Application Support"));
        }
        ClaudeHostPlatform::Windows => {
            if let Some(appdata) = appdata {
                push_claude_cowork_candidates(&mut paths, appdata);
            }
            if let Some(local_appdata) = local_appdata {
                push_claude_cowork_candidates(&mut paths, local_appdata);
                let packages_dir = local_appdata.join("Packages");
                let known_package = packages_dir.join("Claude_pzs8sxrjxfjjc");
                push_claude_cowork_candidates(
                    &mut paths,
                    &known_package.join("LocalCache/Roaming"),
                );
                match fs::read_dir(&packages_dir) {
                    Ok(entries) => {
                        for entry in entries.flatten() {
                            let name = entry.file_name();
                            if !name.to_string_lossy().starts_with("Claude_") {
                                continue;
                            }
                            let package_dir = entry.path();
                            if package_dir == known_package || !package_dir.is_dir() {
                                continue;
                            }
                            push_claude_cowork_candidates(
                                &mut paths,
                                &package_dir.join("LocalCache/Roaming"),
                            );
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => log::warn!("failed to enumerate Claude MSIX packages: {error}"),
                }
            }
        }
        ClaudeHostPlatform::Other => {
            let config_home = xdg_config_home
                .map(Path::to_path_buf)
                .unwrap_or_else(|| home.join(".config"));
            push_claude_cowork_candidates(&mut paths, &config_home);
        }
    }
    paths
}

pub(crate) fn discover_claude_log_roots() -> Vec<PathBuf> {
    let home = get_home_dir();
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let local_appdata = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let xdg_config_home = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let candidates = claude_log_candidates_for(
        current_claude_host_platform(),
        &home,
        appdata.as_deref(),
        local_appdata.as_deref(),
        xdg_config_home.as_deref(),
    );

    let mut roots = Vec::new();
    for candidate in candidates {
        match fs::metadata(&candidate) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                log::warn!("failed to inspect Claude log root: {error}");
                continue;
            }
        }
        let canonical = match fs::canonicalize(&candidate) {
            Ok(path) => path,
            Err(error) => {
                log::warn!("failed to resolve Claude log root: {error}");
                continue;
            }
        };
        if roots
            .iter()
            .any(|root: &PathBuf| canonical.starts_with(root))
        {
            continue;
        }
        roots.retain(|root| !root.starts_with(&canonical));
        roots.push(canonical);
    }
    roots
}

fn is_claude_jsonl(path: &Path) -> bool {
    path.is_file() && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
}

pub(crate) fn scan_claude_file(
    filepath: &Path,
    logs: &mut Vec<LogRecord>,
) -> std::result::Result<usize, String> {
    let session_id = filepath
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown_session")
        .to_string();
    let file = File::open(filepath).map_err(|error| {
        format!(
            "failed to open Claude JSONL {}: {error}",
            filepath.display()
        )
    })?;
    let reader = BufReader::new(file);
    let mut count = 0;

    for (line_num, line) in reader.lines().enumerate() {
        let line_content = line.map_err(|error| {
            format!(
                "failed to read Claude JSONL {} at line {}: {error}",
                filepath.display(),
                line_num + 1
            )
        })?;
        if line_content.trim().is_empty() {
            continue;
        }
        let Ok(data) = serde_json::from_str::<Value>(&line_content) else {
            // Active sessions can leave a trailing partial line. A changed
            // fingerprint forces a retry, so never persist the raw content.
            continue;
        };
        if let Some(record) = claude_record_from_value(&data, &session_id, line_num + 1) {
            logs.push(record);
        } else {
            continue;
        }
        count += 1;
    }
    Ok(count)
}

/// Shared normalized usage projection; callers never need to retain message bodies.
pub(crate) fn claude_record_from_value(
    data: &Value,
    session_id: &str,
    line_number: usize,
) -> Option<LogRecord> {
    if data.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let message = data.get("message").unwrap_or(&Value::Null);
    let usage = message.get("usage").unwrap_or(&Value::Null);
    if !usage.is_object() {
        return None;
    }

    let input_tokens = to_int(usage.get("input_tokens").unwrap_or(&Value::Null));
    let output_tokens = to_int(usage.get("output_tokens").unwrap_or(&Value::Null));
    let cache_read = to_int(usage.get("cache_read_input_tokens").unwrap_or(&Value::Null));
    let cache_write = to_int(
        usage
            .get("cache_creation_input_tokens")
            .unwrap_or(&Value::Null),
    );
    let raw_model = message
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("claude-unknown");
    let model = clean_model_name(raw_model);
    let timestamp = normalize_timestamp(data.get("timestamp").unwrap_or(&Value::Null));
    let message_id = message.get("id").and_then(Value::as_str).unwrap_or("");
    let unique_key = if message_id.is_empty() {
        let uuid = data.get("uuid").and_then(Value::as_str).unwrap_or("");
        format!(
            "claude_{}_{}",
            session_id,
            if uuid.is_empty() {
                format!("line_{}", line_number)
            } else {
                uuid.to_string()
            }
        )
    } else {
        let request_id = data.get("requestId").and_then(Value::as_str).unwrap_or("");
        if request_id.is_empty() {
            format!("claude_{message_id}")
        } else {
            format!("claude_{message_id}_{request_id}")
        }
    };

    Some(LogRecord {
        tool: "claude".to_string(),
        model,
        input_tokens,
        output_tokens,
        cached_tokens: cache_read + cache_write,
        cache_write_tokens: cache_write,
        timestamp,
        session_id: session_id.to_string(),
        unique_key,
        cost_usd: None,
        cumulative: false,
    })
}

pub(crate) fn claude_snapshot_rank(log: &LogRecord) -> (i64, i64, i64) {
    (
        log.output_tokens,
        log.input_tokens.saturating_add(log.cached_tokens),
        log.cache_write_tokens,
    )
}

/// Claude repeats usage once per assistant content block and can copy history
/// between CLI, Desktop and resumed sandbox files. The unique key deliberately
/// excludes the source path; all changed files from all roots share this map.
fn merge_claude_records(
    by_request: &mut HashMap<String, LogRecord>,
    candidates: impl IntoIterator<Item = LogRecord>,
) {
    for candidate in candidates {
        match by_request.entry(candidate.unique_key.clone()) {
            std::collections::hash_map::Entry::Occupied(mut slot) => {
                if claude_snapshot_rank(&candidate) > claude_snapshot_rank(slot.get()) {
                    slot.insert(candidate);
                }
            }
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(candidate);
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn scan_claude_dir(root: &Path, logs: &mut Vec<LogRecord>) -> usize {
    let mut by_request = HashMap::new();
    for entry in WalkDir::new(root) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                log::warn!("failed to walk Claude test source: {error}");
                continue;
            }
        };
        if !is_claude_jsonl(entry.path()) {
            continue;
        }
        let mut file_logs = Vec::new();
        match scan_claude_file(entry.path(), &mut file_logs) {
            Ok(_) => merge_claude_records(&mut by_request, file_logs),
            Err(error) => log::warn!("{error}"),
        }
    }
    let mut deduped = by_request.into_values().collect::<Vec<_>>();
    deduped.sort_by(|left, right| left.unique_key.cmp(&right.unique_key));
    let count = deduped.len();
    logs.extend(deduped);
    count
}

fn scan_claude_roots_checkpointed_with<F>(
    roots: &[PathBuf],
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    logs: &mut Vec<LogRecord>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
    mut parse_file: F,
) -> CheckpointScanStats
where
    F: FnMut(&Path, &mut Vec<LogRecord>) -> std::result::Result<usize, String>,
{
    let mut stats = CheckpointScanStats::default();
    let mut visited_files = HashSet::new();
    let mut by_request = HashMap::new();

    for root in roots {
        for entry in WalkDir::new(root) {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    stats.failed_files += 1;
                    log::warn!("failed to walk Claude log source: {error}");
                    continue;
                }
            };
            let filepath = entry.path();
            if !is_claude_jsonl(filepath) {
                continue;
            }
            let before = match cached_source_fingerprint(filepath) {
                Ok(fingerprint) => fingerprint,
                Err(error) => {
                    stats.failed_files += 1;
                    log::warn!("{error}");
                    continue;
                }
            };
            if !visited_files.insert(before.normalized_path.clone()) {
                continue;
            }
            if checkpoints
                .get(&before.normalized_path)
                .is_some_and(|checkpoint| {
                    checkpoint_is_current_for(checkpoint, &before, CLAUDE_CHECKPOINT_SOURCE_KIND)
                })
            {
                stats.skipped_files += 1;
                continue;
            }

            let mut file_logs = Vec::new();
            if let Err(error) = parse_file(filepath, &mut file_logs) {
                stats.failed_files += 1;
                log::warn!("{error}");
                continue;
            }
            let after = match cached_source_fingerprint(filepath) {
                Ok(fingerprint) => fingerprint,
                Err(error) => {
                    stats.failed_files += 1;
                    log::warn!("{error}");
                    continue;
                }
            };
            if before != after {
                stats.failed_files += 1;
                log::debug!(
                    "Claude JSONL changed during scan; checkpoint not advanced: {}",
                    filepath.display()
                );
                continue;
            }

            stats.parsed_files += 1;
            merge_claude_records(&mut by_request, file_logs);
            pending_checkpoints.push(after.checkpoint_for(CLAUDE_CHECKPOINT_SOURCE_KIND));
        }
    }

    let mut deduped = by_request.into_values().collect::<Vec<_>>();
    deduped.sort_by(|left, right| left.unique_key.cmp(&right.unique_key));
    stats.parsed_records = deduped.len();
    logs.extend(deduped);
    stats
}

pub(crate) fn scan_claude_roots_checkpointed(
    roots: &[PathBuf],
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    logs: &mut Vec<LogRecord>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> CheckpointScanStats {
    scan_claude_roots_checkpointed_with(
        roots,
        checkpoints,
        logs,
        pending_checkpoints,
        scan_claude_file,
    )
}

pub(crate) fn scan_claude(
    db_path: &Path,
    logs: &mut Vec<LogRecord>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> Result<(usize, CheckpointScanStats)> {
    let roots = discover_claude_log_roots();
    if roots.is_empty() {
        return Ok((0, CheckpointScanStats::default()));
    }
    let conn = crate::db::get_connection(db_path)?;
    let checkpoints = crate::db::load_scan_checkpoints(&conn, CLAUDE_CHECKPOINT_SOURCE_KIND)?;
    drop(conn);
    let stats = scan_claude_roots_checkpointed(&roots, &checkpoints, logs, pending_checkpoints);
    Ok((roots.len(), stats))
}
