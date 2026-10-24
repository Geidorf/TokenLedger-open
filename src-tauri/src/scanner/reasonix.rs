use super::helpers::*;
use super::jsonl::{read_text_capped, MAX_SIDECAR_BYTES};
use super::types::LogRecord;
use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use regex::Regex;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn scan_reasonix(logs: &mut Vec<LogRecord>) -> usize {
    let bases = reasonix_data_bases();
    let roots = reasonix_session_roots(&bases);
    scan_reasonix_from(&roots, &bases, logs)
}

/// Candidate ReasoniX data roots. The classic layout is `~/.reasonix`; newer
/// Windows installs may place the data root under `%APPDATA%` / `%LOCALAPPDATA%`
/// instead, so those are probed as well (each root is only scanned when it
/// actually exists, so the extra candidates are no-ops on other platforms).
pub(crate) fn reasonix_data_bases() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    let mut bases = vec![get_home_dir().join(".reasonix")];
    #[cfg(not(target_os = "windows"))]
    let bases = vec![get_home_dir().join(".reasonix")];
    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            bases.push(PathBuf::from(appdata).join("reasonix"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            bases.push(PathBuf::from(local).join("reasonix"));
        }
    }
    bases
}

/// Session dirs under each data root: the classic `<base>/sessions` plus the
/// per-workspace `<base>/projects/<encoded-workspace>/sessions` layout that
/// newer ReasoniX releases use.
pub(crate) fn reasonix_session_roots(bases: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for base in bases {
        roots.push(base.join("sessions"));
        if let Ok(entries) = fs::read_dir(base.join("projects")) {
            for entry in entries.flatten() {
                let project_dir = entry.path();
                if project_dir.is_dir() {
                    roots.push(project_dir.join("sessions"));
                }
            }
        }
    }
    roots
}

/// Model name from the first existing config file; falls back to
/// `reasonix-agent` when no config is found.
///
/// Current ReasoniX releases keep `default_model` in `<base>/config.toml`;
/// only pre-TOML installs still carry `<base>/config.json` with a `model`
/// key. TOML wins because a machine that has both usually kept the JSON file
/// from an old install, where it is stale. The value is read with a line scan
/// instead of a TOML parser so this stays dependency-free (the lockfile is
/// coordinator-single-write).
pub(crate) fn reasonix_default_model(bases: &[PathBuf]) -> String {
    for base in bases {
        if let Ok(config_str) = read_text_capped(&base.join("config.toml"), MAX_SIDECAR_BYTES) {
            if let Some(model) = reasonix_toml_default_model(&config_str) {
                return clean_model_name(&model);
            }
        }
    }
    for base in bases {
        let config_path = base.join("config.json");
        if let Ok(config_str) = read_text_capped(&config_path, MAX_SIDECAR_BYTES) {
            if let Ok(config) = serde_json::from_str::<Value>(&config_str) {
                if let Some(m) = config.get("model").and_then(|v| v.as_str()) {
                    return clean_model_name(m);
                }
            }
        }
    }
    "reasonix-agent".to_string()
}

/// Top-level `default_model = "<model>"` from a ReasoniX `config.toml`.
///
/// Only the root table is honoured: the same key inside a `[[providers]]`
/// entry names that provider's default, not the session default. Commented
/// lines are ignored so the shipped template (which documents the key) does
/// not win over a real setting.
pub(crate) fn reasonix_toml_default_model(config: &str) -> Option<String> {
    for raw_line in config.lines() {
        let line = raw_line.trim();
        if line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            // Left the root table; every later key belongs to a section.
            break;
        }
        let Some(rest) = line.strip_prefix("default_model") else {
            continue;
        };
        let Some(rest) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = rest
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// Picks the first present (non-null) key from `keys`, mapping it through
/// `to_int`. Candidates are ordered newest-first so future format drift only
/// needs a new entry at the front.
fn reasonix_pick_int(meta: &Value, keys: &[&str]) -> i64 {
    for key in keys {
        if let Some(v) = meta.get(key) {
            if !v.is_null() {
                return to_int(v);
            }
        }
    }
    0
}

fn reasonix_pick_float(meta: &Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(v) = meta.get(key) {
            if !v.is_null() {
                return to_float(v);
            }
        }
    }
    None
}

/// Parses the session start out of a ReasoniX session id. Ids embed either
/// `YYYYMMDDHHMM` (`desktop-202605271533-1`) or `YYYYMMDD-HHMMSS` followed by
/// a fraction (`20260603-165101.114909000-deepseek-v4-flash ...`).
///
/// The embedded stamp is a UTC wall-clock snapshot (ReasoniX writes it from
/// `DateTime.UtcNow`); it is returned as a `NaiveDateTime` in UTC and the
/// caller converts it to local time with `Local.from_utc_datetime`.
pub(crate) fn reasonix_timestamp_from_session_id(session_id: &str) -> Option<NaiveDateTime> {
    let compact = Regex::new(r"(20\d{12}|20\d{10})").unwrap();
    if let Some(caps) = compact.captures(session_id) {
        if let Some(stamp) = caps.get(1) {
            let s = stamp.as_str();
            if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y%m%d%H%M%S") {
                return Some(dt);
            }
            if s.len() == 12 {
                if let Ok(dt) = NaiveDateTime::parse_from_str(&format!("{}00", s), "%Y%m%d%H%M%S") {
                    return Some(dt);
                }
            }
        }
    }
    if let Some(caps) = Regex::new(r"(\d{8})-(\d{6})").unwrap().captures(session_id) {
        let combined = format!("{}{}", &caps[1], &caps[2]);
        if let Ok(dt) = NaiveDateTime::parse_from_str(&combined, "%Y%m%d%H%M%S") {
            return Some(dt);
        }
    }
    None
}

/// Fields the scanner needs from a session's `.jsonl.meta` sidecar.
#[derive(Debug, Default, Clone)]
pub(crate) struct ReasonixSessionMeta {
    /// Real model the session ran on, already cleaned.
    pub(crate) model: Option<String>,
    /// RFC 3339 `created_at` (session start), as UTC.
    pub(crate) created: Option<NaiveDateTime>,
    /// RFC 3339 `updated_at` (last activity), as UTC.
    pub(crate) updated: Option<NaiveDateTime>,
}

/// Reads a `.jsonl.meta` sidecar for a newer-format session (same base name
/// as the telemetry file).
pub(crate) fn reasonix_read_meta_sidecar(filepath: &Path) -> ReasonixSessionMeta {
    // `<id>.jsonl.telemetry.json` → `<id>.jsonl.meta`. `with_extension`
    // would only replace the last extension, so rebuild the name explicitly.
    let file_name = filepath.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let Some(stem) = file_name.strip_suffix(".jsonl.telemetry.json") else {
        return ReasonixSessionMeta::default();
    };
    let meta_path = filepath.with_file_name(format!("{stem}.jsonl.meta"));
    let Ok(meta_str) = read_text_capped(&meta_path, MAX_SIDECAR_BYTES) else {
        return ReasonixSessionMeta::default();
    };
    let Ok(meta) = serde_json::from_str::<Value>(&meta_str) else {
        return ReasonixSessionMeta::default();
    };
    let utc_field = |key: &str| {
        meta.get(key).and_then(|v| v.as_str()).and_then(|s| {
            DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.naive_utc())
        })
    };
    ReasonixSessionMeta {
        model: meta
            .get("model")
            .and_then(|v| v.as_str())
            .map(clean_model_name),
        created: utc_field("created_at"),
        updated: utc_field("updated_at"),
    }
}

/// Collapses a ReasoniX crash-recovery fork id back to the session it forked
/// from.
///
/// A recovered session is written as a brand-new file whose telemetry
/// *inherits the parent's cumulative counters*, and whose id appends
/// `[-<hex>]…-recovery-<hex>` to the parent id (each further recovery appends
/// another segment, so a family forms a chain). Keying those files by their
/// own id made every ancestor's tokens land in the ledger again — measured at
/// roughly +50% on a real Windows profile, with three byte-identical rows for
/// one 2026-06-16 session. Every member therefore reports under the root id
/// and `scan_reasonix_from` keeps only the family's high-water mark.
pub(crate) fn reasonix_root_session_id(session_id: &str) -> String {
    const MARKER: &str = "-recovery-";
    let Some(marker_at) = session_id.find(MARKER) else {
        return session_id.to_string();
    };
    let mut root = &session_id[..marker_at];
    // Strip the per-fork hashes ReasoniX splices in ahead of the marker.
    while let Some(dash_at) = root.rfind('-') {
        let segment = &root[dash_at + 1..];
        if segment.len() == 12 && segment.chars().all(|c| c.is_ascii_hexdigit()) {
            root = &root[..dash_at];
        } else {
            break;
        }
    }
    root.to_string()
}

pub(crate) fn scan_reasonix_from(
    roots: &[PathBuf],
    bases: &[PathBuf],
    logs: &mut Vec<LogRecord>,
) -> usize {
    use std::collections::btree_map::Entry;

    let default_model = reasonix_default_model(bases);
    // Keyed by root session id so a crash-recovery family collapses to one
    // cumulative record. Ordered so the emitted batch is deterministic.
    let mut families: std::collections::BTreeMap<String, LogRecord> =
        std::collections::BTreeMap::new();
    let mut count = 0;
    for root in roots {
        if !root.exists() {
            continue;
        }
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let filepath = entry.path();
                let file_name = filepath.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if !filepath.is_file() {
                    continue;
                }
                // Classic format: `<session_id>.meta.json`; newer releases keep
                // the usage snapshot in `<session_id>.jsonl.telemetry.json`
                // (per-workspace sessions under `<base>/projects/...`).
                let session_id = if let Some(id) = file_name.strip_suffix(".meta.json") {
                    id.to_string()
                } else if let Some(id) = file_name.strip_suffix(".jsonl.telemetry.json") {
                    id.to_string()
                } else {
                    continue;
                };

                if let Ok(meta_str) = read_text_capped(&filepath, MAX_SIDECAR_BYTES) {
                    if let Ok(meta) = serde_json::from_str::<Value>(&meta_str) {
                        // Newer telemetry nests the counters under `usage`;
                        // classic meta files keep them at the top level.
                        let usage = match meta.get("usage") {
                            Some(v) if v.is_object() => v,
                            _ => &meta,
                        };

                        let cache_miss = reasonix_pick_int(usage, &["cacheMissTokens"]);
                        let cached_tokens = reasonix_pick_int(usage, &["cacheHitTokens"]);
                        // Relay providers (custom OpenAI/Anthropic-compatible
                        // gateways) do not always return a cache breakdown, so
                        // `cacheMissTokens` alone silently drops prompt tokens
                        // the session really paid for. `promptTokens` is the
                        // authoritative total; whatever it holds beyond the
                        // cache hits is uncached input.
                        let prompt_tokens =
                            reasonix_pick_int(usage, &["promptTokens", "totalPromptTokens"]);
                        let input_tokens = cache_miss
                            .max(prompt_tokens.saturating_sub(cached_tokens))
                            .max(0);
                        let output_tokens = reasonix_pick_int(
                            usage,
                            &["completionTokens", "totalCompletionTokens"],
                        );
                        // A reported cost of exactly 0 is "this provider has no
                        // price table", not "this session was free": ReasoniX
                        // leaves `sessionCostUsd` behind for relay providers
                        // configured without prices. Keeping the 0 would pin
                        // the row at $0 forever, because repricing only ever
                        // revisits rows whose cost is NULL.
                        let cost_usd =
                            reasonix_pick_float(usage, &["sessionCostUsd", "totalCostUsd"])
                                .filter(|cost| *cost > 0.0);

                        if input_tokens <= 0 && cached_tokens <= 0 && output_tokens <= 0 {
                            log::debug!(
                                "reasonix: skip {} (all token fields zero); meta keys: {:?}, usage keys: {:?}",
                                session_id,
                                meta.as_object().map(|o| o.keys().collect::<Vec<_>>()),
                                usage.as_object().map(|o| o.keys().collect::<Vec<_>>())
                            );
                            continue;
                        }

                        // Newer-format sessions carry a `.jsonl.meta` sidecar
                        // with the real model and RFC 3339 (UTC) session
                        // timestamps. Prefer those over the defaults: the
                        // session-id stamp is a UTC wall clock and the config
                        // model is a global default that may not match the
                        // model the session actually ran on.
                        let sidecar = reasonix_read_meta_sidecar(&filepath);
                        let model = sidecar
                            .model
                            .as_deref()
                            .map(clean_model_name)
                            .unwrap_or_else(|| clean_model_name(&default_model));

                        let mut timestamp = String::new();
                        // `updated_at` wins over `created_at`: the snapshot
                        // covers everything the session spent up to its last
                        // activity, and a session can sit idle for days before
                        // its first request (observed on Windows: a session
                        // created 08-04 17:44 whose only traffic ran 08-06
                        // 11:08 was booked two days early).
                        if let Some(stamp) = sidecar.updated.or(sidecar.created) {
                            timestamp = Local
                                .from_utc_datetime(&stamp)
                                .format("%Y-%m-%d %H:%M:%S")
                                .to_string();
                        }
                        if timestamp.is_empty() {
                            if let Some(utc) = reasonix_timestamp_from_session_id(&session_id) {
                                timestamp = Local
                                    .from_utc_datetime(&utc)
                                    .format("%Y-%m-%d %H:%M:%S")
                                    .to_string();
                            }
                        }
                        if timestamp.is_empty() {
                            if let Ok(metadata) = filepath.metadata() {
                                if let Ok(mtime) = metadata.modified() {
                                    let dt: DateTime<Local> = mtime.into();
                                    timestamp = dt.format("%Y-%m-%d %H:%M:%S").to_string();
                                }
                            }
                        }
                        if timestamp.is_empty() {
                            timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                        }

                        // Crash-recovery forks re-report their ancestors'
                        // counters, so the whole family reports under the root
                        // id and only the high-water mark survives.
                        let root_id = reasonix_root_session_id(&session_id);
                        let unique_key = format!("reasonix_{}", root_id);

                        // Both formats are cumulative session snapshots updated
                        // while the session runs; run_scan stores deltas.
                        let record = LogRecord {
                            tool: "reasonix".to_string(),
                            model,
                            input_tokens,
                            output_tokens,
                            cached_tokens,
                            cache_write_tokens: 0,
                            timestamp,
                            session_id: root_id.clone(),
                            unique_key,
                            cost_usd,
                            cumulative: true,
                        };
                        match families.entry(root_id) {
                            Entry::Vacant(slot) => {
                                slot.insert(record);
                                count += 1;
                            }
                            Entry::Occupied(mut slot) => {
                                reasonix_merge_family_member(slot.get_mut(), record);
                            }
                        }
                    }
                }
            }
        }
    }
    logs.extend(families.into_values());
    count
}

/// Folds one recovery-family member into the family's representative record.
///
/// Members form a chain (each fork continues its parent's counters), so the
/// family total is the per-field high-water mark rather than a sum. Identity
/// fields follow the member that carries the most tokens, which is the newest
/// link in the chain and therefore the most current model/timestamp.
fn reasonix_merge_family_member(kept: &mut LogRecord, candidate: LogRecord) {
    let total = |r: &LogRecord| {
        r.input_tokens
            .saturating_add(r.output_tokens)
            .saturating_add(r.cached_tokens)
    };
    if total(&candidate) > total(kept) {
        kept.model = candidate.model;
        kept.timestamp = candidate.timestamp;
    }
    kept.input_tokens = kept.input_tokens.max(candidate.input_tokens);
    kept.output_tokens = kept.output_tokens.max(candidate.output_tokens);
    kept.cached_tokens = kept.cached_tokens.max(candidate.cached_tokens);
    kept.cost_usd = match (kept.cost_usd, candidate.cost_usd) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
}
