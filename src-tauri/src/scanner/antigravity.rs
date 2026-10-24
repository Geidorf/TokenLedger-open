use super::checkpoints::*;
use super::helpers::get_home_dir;
use super::jsonl::bounded_lines;
use super::other_tools::extract_model_from_settings_change;
use super::types::*;
use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};

pub(crate) const ANTIGRAVITY_CHECKPOINT_SOURCE_KIND: &str = "antigravity-transcript-jsonl-v3";
const MAX_SAFE_COUNTER: i64 = 9_007_199_254_740_991;
struct Candidate {
    path: PathBuf,
    cli: bool,
    fingerprint: SourceFingerprint,
}

pub(crate) fn scan_antigravity(
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
) -> AntigravityScanBatch {
    let home = get_home_dir();
    scan_antigravity_roots_checkpointed(
        &[
            (home.join(".gemini/antigravity/brain"), false),
            (home.join(".gemini/antigravity-cli/brain"), true),
        ],
        checkpoints,
    )
}

fn legal_session_id(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        && name != "unknown_session"
}

// Injectable roots keep tests away from the developer's home and other tools.
pub(crate) fn scan_antigravity_roots_checkpointed(
    roots: &[(PathBuf, bool)],
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
) -> AntigravityScanBatch {
    let mut groups: BTreeMap<String, Vec<Candidate>> = BTreeMap::new();
    for (root, cli) in roots {
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                log::warn!("Antigravity inventory failed: {error}");
                return AntigravityScanBatch::default();
            }
        };
        for entry in entries {
            let candidate = (|| -> std::io::Result<Option<(String, Candidate)>> {
                let entry = entry?;
                if !entry.file_type()?.is_dir() {
                    return Ok(None);
                }
                let session = entry.file_name().to_string_lossy().into_owned();
                if !legal_session_id(&session) {
                    return Ok(None);
                }
                // Do not traverse full transcripts, chunks, attachments or symlink sessions.
                let generated = entry.path().join(".system_generated");
                let logs = generated.join("logs");
                for directory in [&generated, &logs] {
                    match fs::symlink_metadata(directory) {
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            return Ok(None)
                        }
                        Ok(metadata) if !metadata.is_dir() || metadata.is_symlink() => {
                            return Ok(None)
                        }
                        Err(error) => return Err(error),
                        Ok(_) => {}
                    }
                }
                let path = logs.join("transcript.jsonl");
                match fs::symlink_metadata(&path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Ok(metadata) if !metadata.is_file() => return Ok(None),
                    Err(error) => return Err(error),
                    Ok(_) => {}
                }
                let fingerprint =
                    cached_source_fingerprint(&path).map_err(std::io::Error::other)?;
                Ok(Some((
                    session,
                    Candidate {
                        path,
                        cli: *cli,
                        fingerprint,
                    },
                )))
            })();
            match candidate {
                Ok(Some((session, candidate))) => {
                    groups.entry(session).or_default().push(candidate)
                }
                Ok(None) => {}
                Err(error) => {
                    log::warn!("Antigravity inventory failed: {error}");
                    return AntigravityScanBatch::default();
                }
            }
        }
    }
    let mut batch = AntigravityScanBatch::default();
    for (session, mut candidates) in groups {
        candidates.sort_by(|a, b| {
            a.fingerprint
                .normalized_path
                .cmp(&b.fingerprint.normalized_path)
        });
        candidates.dedup_by(|a, b| {
            if a.fingerprint.normalized_path == b.fingerprint.normalized_path {
                b.cli |= a.cli;
                true
            } else {
                false
            }
        });
        let expected = group_checkpoints(&candidates);
        if expected.iter().all(|expected| {
            checkpoints.get(&expected.source_path).is_some_and(|old| {
                old.source_kind == expected.source_kind
                    && old.source_identity == expected.source_identity
                    && old.size_bytes == expected.size_bytes
                    && old.modified_ns == expected.modified_ns
                    && old.processed_offset == expected.processed_offset
            })
        }) {
            continue;
        }
        let mut selected: ParsedRows = BTreeMap::new();
        let mut checkpointable = true;
        let mut failed = false;
        for candidate in &candidates {
            let parsed = match parse_transcript(&candidate.path, &session, candidate.cli) {
                Ok(parsed) => parsed,
                Err(error) => {
                    log::warn!("Antigravity session read failed: {error}");
                    failed = true;
                    break;
                }
            };
            checkpointable &= parsed.1;
            for (key, (row, provenance)) in parsed.0 {
                if let Some((previous, old_provenance)) = selected.get(&key) {
                    match (old_provenance.usage, provenance.usage) {
                        (
                            AntigravityUsageProvenance::Reported,
                            AntigravityUsageProvenance::Estimated,
                        ) => continue,
                        (
                            AntigravityUsageProvenance::Estimated,
                            AntigravityUsageProvenance::Reported,
                        ) => {}
                        _ if !same_record(previous, &row) || *old_provenance != provenance => {
                            log::warn!("Antigravity conflicting copies for session {session}; retrying group");
                            failed = true;
                            break;
                        }
                        _ => continue,
                    }
                }
                selected.insert(key, (row, provenance));
            }
            if failed {
                break;
            }
        }
        // Recheck every candidate, including those whose own checkpoint was current.
        if failed
            || candidates.iter().any(|candidate| {
                cached_source_fingerprint(&candidate.path).ok().as_ref()
                    != Some(&candidate.fingerprint)
            })
        {
            continue;
        }
        for (key, (row, provenance)) in selected {
            batch.logs.push(row);
            batch.provenance.insert(key, provenance);
        }
        if checkpointable {
            batch.checkpoints.extend(expected);
        }
    }
    batch
}

fn group_checkpoints(candidates: &[Candidate]) -> Vec<crate::db::ScanCheckpoint> {
    let mut digest = Sha256::new();
    for candidate in candidates {
        let source = &candidate.fingerprint;
        for value in [&source.normalized_path, &source.source_identity] {
            digest.update((value.len() as u64).to_le_bytes());
            digest.update(value.as_bytes());
        }
        digest.update(source.size_bytes.to_le_bytes());
        digest.update(source.modified_ns.to_le_bytes());
        digest.update([u8::from(candidate.cli)]);
    }
    let group = format!("{:x}", digest.finalize());
    candidates
        .iter()
        .map(|candidate| {
            let mut checkpoint = candidate
                .fingerprint
                .checkpoint_for(ANTIGRAVITY_CHECKPOINT_SOURCE_KIND);
            checkpoint.source_identity = format!("{}:group:{group}", checkpoint.source_identity);
            checkpoint
        })
        .collect()
}

fn safe_counter(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|n| (0..=MAX_SAFE_COUNTER).contains(n))
}

fn transcript_timestamp(value: Option<&Value>, reported: bool) -> Option<String> {
    let value = value?;
    if let Some(time) = value
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s.trim()).ok())
    {
        return Some(
            time.with_timezone(&Local)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
        );
    }
    if reported {
        return None;
    }
    // Preserve valid legacy App timestamp formats without the old now() fallback.
    let epoch = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok());
    if let Some(epoch) = epoch.filter(|n| n.is_finite() && n.abs() <= MAX_SAFE_COUNTER as f64) {
        let seconds = if epoch > 1e11 { epoch / 1000.0 } else { epoch };
        return Local
            .timestamp_opt(seconds as i64, 0)
            .single()
            .map(|time| time.format("%Y-%m-%d %H:%M:%S").to_string());
    }
    let text = value.as_str()?.trim().replace('T', " ").replace('Z', "");
    NaiveDateTime::parse_from_str(text.split('.').next()?, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|time| time.format("%Y-%m-%d %H:%M:%S").to_string())
}
type ParsedRows = BTreeMap<String, (LogRecord, AntigravityRecordProvenance)>;

fn parse_transcript(path: &Path, session: &str, cli: bool) -> std::io::Result<(ParsedRows, bool)> {
    let reader = BufReader::new(fs::File::open(path)?);
    let mut rows = BTreeMap::new();
    let mut complete = true;
    let mut selected_model = "antigravity-unknown".to_string();
    let mut cumulative_chars = 0usize;
    for line in bounded_lines(reader) {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let data: Value = match serde_json::from_str::<Value>(&line) {
            Ok(data) if data.is_object() => data,
            Ok(_) => {
                complete = false;
                continue;
            }
            Err(_) => {
                complete = false;
                continue;
            }
        };
        let source = data.get("source").and_then(Value::as_str).unwrap_or("");
        let kind = data.get("type").and_then(Value::as_str).unwrap_or("");
        let text = data.get("content").and_then(Value::as_str).unwrap_or("");
        if kind == "USER_INPUT"
            && text.contains("<USER_SETTINGS_CHANGE>")
            && text.contains("Model Selection")
        {
            selected_model = extract_model_from_settings_change(text)
                .unwrap_or_else(|| "antigravity-unknown".to_string());
        }
        if source == "MODEL" && kind == "PLANNER_RESPONSE" {
            let has_usage = [
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "usage",
            ]
            .iter()
            .any(|key| data.get(key).is_some());
            let status = data.get("status").and_then(Value::as_str);
            let reported = has_usage || cli || data.get("status").is_some();
            if reported && status != Some("DONE") {
                complete = false;
                continue;
            }
            let Some(step) = safe_counter(data.get("step_index")) else {
                complete = false;
                continue;
            };
            // Never replace malformed/missing timestamps with the current scan time.
            let Some(timestamp) = transcript_timestamp(data.get("created_at"), reported) else {
                complete = false;
                continue;
            };
            let mut out_chars = text.len();
            if let Some(calls) = data.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    out_chars = out_chars.saturating_add(
                        call.get("name").and_then(Value::as_str).unwrap_or("").len(),
                    );
                    out_chars = out_chars.saturating_add(
                        call.get("args")
                            .map(Value::to_string)
                            .unwrap_or_default()
                            .len(),
                    );
                }
            }
            let (input_tokens, output_tokens, cached_tokens, cache_write_tokens, provenance) =
                if reported {
                    let (Some(input), Some(output), Some(read)) = (
                        safe_counter(data.get("input_tokens")),
                        safe_counter(data.get("output_tokens")),
                        safe_counter(data.get("cache_read_tokens")),
                    ) else {
                        complete = false;
                        continue;
                    };
                    // Missing writes remain unknown even when the observed read count is zero.
                    let write = match data.get("cache_write_tokens") {
                        Some(value) => match safe_counter(Some(value)) {
                            Some(n) => Some(n),
                            None => {
                                complete = false;
                                continue;
                            }
                        },
                        None => None,
                    };
                    let Some(cached) = read
                        .checked_add(write.unwrap_or(0))
                        .filter(|n| *n <= MAX_SAFE_COUNTER)
                    else {
                        complete = false;
                        continue;
                    };
                    (
                        input,
                        output,
                        cached,
                        write.unwrap_or(0),
                        AntigravityRecordProvenance {
                            usage: AntigravityUsageProvenance::Reported,
                            cache_write_known: write.is_some(),
                        },
                    )
                } else {
                    (
                        1.max((cumulative_chars as f64 / 3.5) as i64),
                        1.max((out_chars as f64 / 3.5) as i64),
                        0,
                        0,
                        AntigravityRecordProvenance {
                            usage: AntigravityUsageProvenance::Estimated,
                            cache_write_known: false,
                        },
                    )
                };
            let key = format!("antigravity_{session}_{step}");
            let row = LogRecord {
                tool: "antigravity".to_string(),
                model: selected_model.clone(),
                input_tokens,
                output_tokens,
                cached_tokens,
                cache_write_tokens,
                timestamp,
                session_id: session.to_string(),
                unique_key: key.clone(),
                cost_usd: None,
                cumulative: false,
            };
            // A single ordered file uses its last complete snapshot, including decreases.
            // Cross-file conflicts are resolved separately, never by traversal order.
            let downgrade = rows.get(&key).is_some_and(
                |(_, previous): &(LogRecord, AntigravityRecordProvenance)| {
                    previous.usage == AntigravityUsageProvenance::Reported
                        && provenance.usage == AntigravityUsageProvenance::Estimated
                },
            );
            if !downgrade {
                rows.insert(key, (row, provenance));
            }
            cumulative_chars = cumulative_chars.saturating_add(out_chars);
        }
        if source == "USER" || source == "SYSTEM" || kind == "USER_INPUT" || kind == "TOOL_OUTPUT" {
            cumulative_chars = cumulative_chars.saturating_add(text.len());
        }
    }
    Ok((rows, complete))
}

fn same_record(a: &LogRecord, b: &LogRecord) -> bool {
    a.model == b.model
        && a.input_tokens == b.input_tokens
        && a.output_tokens == b.output_tokens
        && a.cached_tokens == b.cached_tokens
        && a.cache_write_tokens == b.cache_write_tokens
        && a.timestamp == b.timestamp
        && a.session_id == b.session_id
}
