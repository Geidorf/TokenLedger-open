use super::checkpoints::*;
use super::helpers::*;
use super::jsonl::bounded_lines;
use super::types::{CheckpointScanStats, LogRecord};
use chrono::{DateTime, Utc};
use rusqlite::Result;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub(crate) const CODEX_CHECKPOINT_SOURCE_KIND: &str = "codex-rollout-jsonl-v2";

/// Root prefix used by Multica Desktop for its per-task agent homes.
///
/// Multica is a multi-runtime orchestrator: it runs each task in an isolated
/// agent HOME under `multica_workspaces_<host>/<workspace>/<task>/`.
/// Codex is launched with an explicit `CODEX_HOME=<task>/codex-home`, so its
/// rollouts never reach `~/.codex/sessions` and would otherwise be invisible.
const MULTICA_WORKSPACE_PREFIX: &str = "multica_workspaces_";
const MULTICA_CODEX_HOME_DIR: &str = "codex-home";
/// Cap on directory levels walked from a workspace root to find `codex-home`.
/// Real layouts are `<workspace>/<task>/codex-home` (2 levels); the margin
/// tolerates hosts that nest one extra grouping directory.
const MULTICA_CODEX_HOME_MAX_DEPTH: usize = 4;

/// Discovers Multica task-scoped Codex homes.
///
/// Returns the `sessions` and `archived_sessions` roots of every
/// `<workspace>/multica_workspaces_*/<workspace-id>/<task>/codex-home`
/// directory found under the user's home. Directories removed by the daemon GC
/// are skipped, while permission and I/O failures mark discovery incomplete so
/// a rebuild cannot treat a partial source inventory as authoritative.
#[derive(Debug)]
struct MulticaCodexRootDiscovery {
    roots: Vec<PathBuf>,
    complete: bool,
}

fn discover_multica_codex_roots() -> MulticaCodexRootDiscovery {
    discover_multica_codex_roots_checked_in(&get_home_dir())
}

/// Home-parameterized form of [`discover_multica_codex_roots`] for testing.
pub(crate) fn discover_multica_codex_roots_in(home: &Path) -> Vec<PathBuf> {
    discover_multica_codex_roots_checked_in(home).roots
}

fn discover_multica_codex_roots_checked_in(home: &Path) -> MulticaCodexRootDiscovery {
    let mut discovery = MulticaCodexRootDiscovery {
        roots: Vec::new(),
        complete: true,
    };
    let entries = match fs::read_dir(home) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return discovery,
        Err(_) => {
            discovery.complete = false;
            return discovery;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                discovery.complete = false;
                continue;
            }
        };
        let workspace_root = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                discovery.complete = false;
                continue;
            }
        };
        if !file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        let Some(name) = workspace_root.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.starts_with(MULTICA_WORKSPACE_PREFIX) {
            continue;
        }
        let found = find_multica_codex_homes(&workspace_root);
        discovery.complete &= found.complete;
        for codex_home in found.roots {
            discovery.roots.push(codex_home.join("sessions"));
            discovery.roots.push(codex_home.join("archived_sessions"));
        }
    }
    discovery.roots.sort();
    discovery.roots.dedup();
    discovery
}

/// Finds `codex-home` directories at or below `workspace_root`.
fn find_multica_codex_homes(workspace_root: &Path) -> MulticaCodexRootDiscovery {
    let mut discovery = MulticaCodexRootDiscovery {
        roots: Vec::new(),
        complete: true,
    };
    for entry in WalkDir::new(workspace_root)
        .min_depth(1)
        .max_depth(MULTICA_CODEX_HOME_MAX_DEPTH)
        .follow_links(false)
        .into_iter()
    {
        let entry = match entry {
            Ok(entry) => entry,
            // A task directory removed by the Multica GC mid-walk is expected.
            Err(error)
                if error
                    .io_error()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                continue;
            }
            Err(_) => {
                discovery.complete = false;
                continue;
            }
        };
        if !entry.file_type().is_dir() || entry.file_name().to_str() != Some(MULTICA_CODEX_HOME_DIR)
        {
            continue;
        }
        discovery.roots.push(entry.path().to_path_buf());
    }
    discovery
}

pub(crate) fn codex_home_session_roots(codex_home: &Path) -> [PathBuf; 2] {
    [
        codex_home.join("sessions"),
        codex_home.join("archived_sessions"),
    ]
}

/// Expands a leading `~` and `%NAME%` environment placeholders in a
/// user-configured directory. Unknown placeholders are left untouched so the
/// path simply does not exist instead of pointing somewhere unexpected.
fn expand_configured_dir(raw: &str, home: &Path) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut expanded = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else {
            break;
        };
        let name = &rest[start + 1..start + 1 + len];
        expanded.push_str(&rest[..start]);
        match std::env::var(name).ok().filter(|_| !name.is_empty()) {
            Some(value) => expanded.push_str(&value),
            None => expanded.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    expanded.push_str(rest);
    let path = if expanded == "~" {
        home.to_path_buf()
    } else if let Some(stripped) = expanded
        .strip_prefix("~/")
        .or_else(|| expanded.strip_prefix("~\\"))
    {
        home.join(stripped)
    } else {
        PathBuf::from(expanded)
    };
    path.is_absolute().then_some(path)
}

/// Session roots for directories added in settings. An entry may name a Codex
/// home (containing `sessions`) or a `sessions`/`archived_sessions` directory
/// itself; any other directory is walked as-is for `rollout-*.jsonl` files.
pub(crate) fn configured_codex_roots(entries: &[String], home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for entry in entries {
        let Some(dir) = expand_configured_dir(entry, home) else {
            continue;
        };
        let is_sessions_dir = dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "sessions" || name == "archived_sessions");
        if !is_sessions_dir && dir.join("sessions").is_dir() {
            roots.extend(codex_home_session_roots(&dir));
        } else {
            roots.push(dir);
        }
    }
    roots
}

pub(crate) fn discover_codex_log_roots_in(home: &Path) -> Vec<PathBuf> {
    let mut roots = codex_home_session_roots(&home.join(".codex")).to_vec();
    roots.extend(discover_multica_codex_roots_in(home));
    roots.extend(super::cindy::cindy_codex_roots_in(home));
    roots
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub(crate) struct CodexCountersSignature {
    pub(crate) input: Option<u64>,
    pub(crate) cache_read: Option<u64>,
    pub(crate) cache_write: Option<u64>,
    pub(crate) output: Option<u64>,
    pub(crate) reasoning_output: Option<u64>,
    pub(crate) total: Option<u64>,
}

impl CodexCountersSignature {
    fn has_any_counter(&self) -> bool {
        self.input.is_some()
            || self.cache_read.is_some()
            || self.cache_write.is_some()
            || self.output.is_some()
            || self.reasoning_output.is_some()
            || self.total.is_some()
    }

    pub(crate) fn usage(&self) -> CodexUsageCounters {
        CodexUsageCounters {
            input: self.input.unwrap_or(0),
            cache_read: self.cache_read.unwrap_or(0),
            cache_write: self.cache_write.unwrap_or(0),
            output: self.output.unwrap_or(0),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct CodexUsageSignature {
    pub(crate) total: Option<CodexCountersSignature>,
    pub(crate) last: Option<CodexCountersSignature>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CodexUsageCounters {
    pub(crate) input: u64,
    pub(crate) cache_read: u64,
    pub(crate) cache_write: u64,
    pub(crate) output: u64,
}

impl CodexUsageCounters {
    fn delta_from_high_water(self, high_water: Option<Self>) -> Self {
        let Some(previous) = high_water else {
            return self;
        };
        Self {
            input: self.input.saturating_sub(previous.input),
            cache_read: self.cache_read.saturating_sub(previous.cache_read),
            cache_write: self.cache_write.saturating_sub(previous.cache_write),
            output: self.output.saturating_sub(previous.output),
        }
    }

    fn merge_high_water(&mut self, current: Self) {
        self.input = self.input.max(current.input);
        self.cache_read = self.cache_read.max(current.cache_read);
        self.cache_write = self.cache_write.max(current.cache_write);
        self.output = self.output.max(current.output);
    }

    fn is_zero(self) -> bool {
        self.input == 0 && self.cache_read == 0 && self.cache_write == 0 && self.output == 0
    }
}

fn codex_u64(value: &Value, field: &str) -> std::result::Result<u64, String> {
    if let Some(value) = value.as_u64() {
        return Ok(value);
    }
    if let Some(value) = value.as_i64().filter(|value| *value >= 0) {
        return Ok(value as u64);
    }
    Err(format!(
        "Codex counter {field} is not a non-negative integer"
    ))
}

fn codex_optional_counter(
    usage: &Value,
    candidates: &[(&[&str], &str)],
) -> std::result::Result<Option<u64>, String> {
    for (path, canonical_name) in candidates {
        let value = nested_get(usage, path);
        if !value.is_null() {
            return codex_u64(value, canonical_name).map(Some);
        }
    }
    Ok(None)
}

pub(crate) fn codex_counters_signature(
    usage: Option<&Value>,
) -> std::result::Result<Option<CodexCountersSignature>, String> {
    let Some(usage) = usage.filter(|usage| !usage.is_null()) else {
        return Ok(None);
    };
    if !usage.is_object() {
        return Err("Codex token usage is not an object".to_string());
    }

    let signature = CodexCountersSignature {
        input: codex_optional_counter(usage, &[(&["input_tokens"], "input_tokens")])?,
        cache_read: codex_optional_counter(
            usage,
            &[
                (&["cached_input_tokens"], "cached_input_tokens"),
                (&["cache_read_input_tokens"], "cache_read_input_tokens"),
                (&["cached_tokens"], "cached_tokens"),
                (
                    &["input_tokens_details", "cached_tokens"],
                    "input_tokens_details.cached_tokens",
                ),
                (
                    &["prompt_tokens_details", "cached_tokens"],
                    "prompt_tokens_details.cached_tokens",
                ),
            ],
        )?,
        cache_write: codex_optional_counter(
            usage,
            &[
                (&["cache_write_input_tokens"], "cache_write_input_tokens"),
                (&["cache_write_tokens"], "cache_write_tokens"),
                (
                    &["input_tokens_details", "cache_write_tokens"],
                    "input_tokens_details.cache_write_tokens",
                ),
                (
                    &["prompt_tokens_details", "cache_write_tokens"],
                    "prompt_tokens_details.cache_write_tokens",
                ),
            ],
        )?,
        output: codex_optional_counter(usage, &[(&["output_tokens"], "output_tokens")])?,
        reasoning_output: codex_optional_counter(
            usage,
            &[(&["reasoning_output_tokens"], "reasoning_output_tokens")],
        )?,
        total: codex_optional_counter(usage, &[(&["total_tokens"], "total_tokens")])?,
    };
    Ok(signature.has_any_counter().then_some(signature))
}

pub(crate) fn codex_usage_signature(
    info: &Value,
) -> std::result::Result<Option<CodexUsageSignature>, String> {
    // Codex emits token_count lifecycle notifications before usage is
    // available. Missing/null info is not a malformed counter snapshot and
    // carries no billable data, so ignore it. Any non-null non-object remains
    // fail-closed because silently accepting that shape could lose usage.
    if info.is_null() {
        return Ok(None);
    }
    if !info.is_object() {
        return Err("Codex token_count info is not an object".to_string());
    }
    let total = codex_counters_signature(info.get("total_token_usage"))?;
    let last = codex_counters_signature(info.get("last_token_usage"))?;
    Ok((total.is_some() || last.is_some()).then_some(CodexUsageSignature { total, last }))
}

pub(crate) fn is_codex_rollout(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    path.is_file() && file_name.starts_with("rollout-") && file_name.ends_with(".jsonl")
}

fn codex_uuid(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    for (index, byte) in bytes.iter().copied().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if byte != b'-' {
                return None;
            }
        } else if !byte.is_ascii_hexdigit() {
            return None;
        }
    }
    Some(raw.to_ascii_lowercase())
}

pub(crate) fn codex_thread_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    codex_uuid(stem.get(stem.len().checked_sub(36)?..)?)
}

pub(crate) fn codex_legacy_session_id(path: &Path) -> Option<String> {
    path.file_stem()?
        .to_str()?
        .strip_prefix("rollout-")
        .map(str::to_owned)
}

fn codex_timestamp(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CodexParentResolution {
    None,
    Parent(String),
    Deferred(String),
}

fn codex_parent_from_meta(payload: &Value, root_thread_id: &str) -> CodexParentResolution {
    let candidates = [
        ("forked_from_id", payload.get("forked_from_id")),
        ("parent_thread_id", payload.get("parent_thread_id")),
        (
            "source.subagent.thread_spawn.parent_thread_id",
            payload
                .get("source")
                .and_then(|source| source.get("subagent"))
                .and_then(|subagent| subagent.get("thread_spawn"))
                .and_then(|spawn| spawn.get("parent_thread_id")),
        ),
    ];
    let mut parent: Option<String> = None;
    for (field, value) in candidates {
        let Some(raw) = value
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(normalized) = codex_uuid(raw) else {
            return CodexParentResolution::Deferred(format!(
                "{field} is not a valid Codex thread UUID"
            ));
        };
        if let Some(existing) = &parent {
            if existing != &normalized {
                return CodexParentResolution::Deferred("Codex parent fields disagree".to_string());
            }
        } else {
            parent = Some(normalized);
        }
    }
    match parent {
        Some(parent) if parent == root_thread_id => {
            CodexParentResolution::Deferred("Codex rollout points to itself as parent".to_string())
        }
        Some(parent) => CodexParentResolution::Parent(parent),
        None => CodexParentResolution::None,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ParsedCodexTokenEvent {
    pub(crate) signature: CodexUsageSignature,
    pub(crate) delta: CodexUsageCounters,
    pub(crate) event_index: Option<u32>,
    pub(crate) model: String,
    pub(crate) timestamp: String,
    pub(crate) timestamp_utc: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
pub(crate) struct ParsedCodexRollout {
    pub(crate) root_thread_id: String,
    pub(crate) root_meta_seen: bool,
    pub(crate) root_timestamp: Option<DateTime<Utc>>,
    pub(crate) parent: CodexParentResolution,
    pub(crate) token_events: Vec<ParsedCodexTokenEvent>,
    pub(crate) max_timestamp: Option<DateTime<Utc>>,
    pub(crate) token_without_timestamp: bool,
    pub(crate) has_billable_tokens: bool,
}

fn codex_model_from_record(record: &Value) -> Option<String> {
    record
        .get("payload")
        .and_then(|payload| {
            payload
                .get("model")
                .or_else(|| payload.get("info").and_then(|info| info.get("model")))
        })
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(clean_model_name)
}

pub(crate) fn parse_codex_rollout(
    filepath: &Path,
    filename_thread_id: &str,
    frozen_size: i64,
) -> std::result::Result<ParsedCodexRollout, String> {
    let mut file = File::open(filepath).map_err(|error| {
        format!(
            "failed to open Codex rollout {}: {error}",
            filepath.display()
        )
    })?;
    let frozen_size = u64::try_from(frozen_size).map_err(|_| {
        format!(
            "Codex rollout has invalid frozen size: {}",
            filepath.display()
        )
    })?;
    if frozen_size > 0 {
        file.seek(SeekFrom::Start(frozen_size - 1))
            .map_err(|error| {
                format!(
                    "failed to seek frozen Codex rollout {}: {error}",
                    filepath.display()
                )
            })?;
        let mut final_byte = [0u8; 1];
        file.read_exact(&mut final_byte).map_err(|error| {
            format!(
                "Codex rollout {} was truncated below its frozen size: {error}",
                filepath.display()
            )
        })?;
        if final_byte[0] != b'\n' {
            return Err(format!(
                "frozen Codex rollout prefix does not end at a JSONL boundary: {}",
                filepath.display()
            ));
        }
        file.seek(SeekFrom::Start(0)).map_err(|error| {
            format!(
                "failed to rewind frozen Codex rollout {}: {error}",
                filepath.display()
            )
        })?;
    }
    let reader = BufReader::new(file.take(frozen_size));
    parse_codex_rollout_reader(reader, filepath, filename_thread_id)
}

/// Same counter normalization for bounded, metadata-only session analysis.
pub(crate) fn parse_codex_rollout_reader<R: BufRead>(
    reader: R,
    filepath: &Path,
    filename_thread_id: &str,
) -> std::result::Result<ParsedCodexRollout, String> {
    parse_codex_rollout_reader_checked(reader, filepath, filename_thread_id, || Ok(()))
}

pub(crate) fn parse_codex_rollout_reader_checked<
    R: BufRead,
    F: FnMut() -> std::result::Result<(), String>,
>(
    reader: R,
    filepath: &Path,
    filename_thread_id: &str,
    mut check: F,
) -> std::result::Result<ParsedCodexRollout, String> {
    let mut root_meta_seen = false;
    let mut root_timestamp = None;
    let mut parent = CodexParentResolution::None;
    let mut current_model = "codex-agent".to_string();
    let mut first_model_seen = false;
    let mut pending_model_indices: Vec<usize> = Vec::new();
    let mut total_high_water: Option<CodexUsageCounters> = None;
    let mut last_signature_by_lane: HashMap<Option<String>, CodexUsageSignature> = HashMap::new();
    let mut previous_signature: Option<CodexUsageSignature> = None;
    let mut event_index = 0u32;
    let mut token_events: Vec<ParsedCodexTokenEvent> = Vec::new();
    let mut max_timestamp: Option<DateTime<Utc>> = None;
    let mut token_without_timestamp = false;
    let mut has_billable_tokens = false;

    for (line_number, line) in bounded_lines(reader).enumerate() {
        check()?;
        let line = line.map_err(|error| {
            format!(
                "failed to read Codex rollout {} at line {}: {error}",
                filepath.display(),
                line_number + 1
            )
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let record: Value = serde_json::from_str(&line).map_err(|error| {
            format!(
                "invalid Codex JSONL {} at line {}: {error}",
                filepath.display(),
                line_number + 1
            )
        })?;
        let parsed_timestamp = codex_timestamp(record.get("timestamp"));
        if let Some(timestamp) = parsed_timestamp {
            max_timestamp = Some(max_timestamp.map_or(timestamp, |current| current.max(timestamp)));
        }
        let record_type = record.get("type").and_then(Value::as_str);
        if record_type == Some("session_meta") && !root_meta_seen {
            root_meta_seen = true;
            root_timestamp = parsed_timestamp;
            let payload = record.get("payload").unwrap_or(&Value::Null);
            let meta_id = payload
                .get("id")
                .or_else(|| payload.get("thread_id"))
                .or_else(|| payload.get("threadId"))
                .and_then(Value::as_str)
                .and_then(codex_uuid);
            if meta_id.as_deref() != Some(filename_thread_id) {
                parent = CodexParentResolution::Deferred(
                    "Codex filename UUID and root session_meta ID disagree".to_string(),
                );
            } else {
                parent = codex_parent_from_meta(payload, filename_thread_id);
            }
            if let Some(model) = codex_model_from_record(&record) {
                current_model = model;
                first_model_seen = true;
            }
            continue;
        }
        if record_type == Some("turn_context") {
            if let Some(model) = codex_model_from_record(&record) {
                current_model = model;
                if !first_model_seen {
                    first_model_seen = true;
                    for index in pending_model_indices.drain(..) {
                        token_events[index].model = current_model.clone();
                    }
                }
            }
            continue;
        }
        if record_type != Some("event_msg") {
            continue;
        }
        let payload = record.get("payload").unwrap_or(&Value::Null);
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let info = payload.get("info").unwrap_or(&Value::Null);
        let Some(signature) = codex_usage_signature(info)? else {
            continue;
        };
        if parsed_timestamp.is_none() {
            token_without_timestamp = true;
        }
        if let Some(model) = info
            .get("model")
            .or_else(|| info.get("model_name"))
            .or_else(|| payload.get("model"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            current_model = clean_model_name(model);
            if !first_model_seen {
                first_model_seen = true;
                for index in pending_model_indices.drain(..) {
                    token_events[index].model = current_model.clone();
                }
            }
        }
        let lane = match payload
            .get("rate_limits")
            .and_then(|limits| limits.get("limit_id"))
        {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
            Some(Value::String(_)) => None,
            Some(_) => return Err("Codex rate_limits.limit_id is not a string".to_string()),
        };
        let has_total = signature.total.is_some();
        let duplicate = has_total
            && (last_signature_by_lane.get(&lane) == Some(&signature)
                || previous_signature.as_ref() == Some(&signature));
        if has_total {
            last_signature_by_lane.insert(lane, signature.clone());
        }
        previous_signature = Some(signature.clone());

        let total = signature.total.as_ref().map(CodexCountersSignature::usage);
        let mut delta = if duplicate {
            CodexUsageCounters::default()
        } else if let Some(last) = signature.last.as_ref() {
            last.usage()
        } else if let Some(total) = total {
            total.delta_from_high_water(total_high_water)
        } else {
            CodexUsageCounters::default()
        };
        if let Some(total) = total {
            if let Some(high_water) = &mut total_high_water {
                high_water.merge_high_water(total);
            } else {
                total_high_water = Some(total);
            }
        }
        let combined_cache = delta
            .cache_read
            .saturating_add(delta.cache_write)
            .min(delta.input);
        delta.cache_write = delta.cache_write.min(combined_cache);
        delta.cache_read = combined_cache.saturating_sub(delta.cache_write);
        let nonzero_index = if delta.is_zero() {
            None
        } else {
            has_billable_tokens = true;
            event_index = event_index.saturating_add(1);
            Some(event_index)
        };
        token_events.push(ParsedCodexTokenEvent {
            signature,
            delta,
            event_index: nonzero_index,
            model: current_model.clone(),
            timestamp: normalize_timestamp(record.get("timestamp").unwrap_or(&Value::Null)),
            timestamp_utc: parsed_timestamp,
        });
        if !first_model_seen {
            pending_model_indices.push(token_events.len() - 1);
        }
    }

    Ok(ParsedCodexRollout {
        root_thread_id: filename_thread_id.to_string(),
        root_meta_seen,
        root_timestamp,
        parent,
        token_events,
        max_timestamp,
        token_without_timestamp,
        has_billable_tokens,
    })
}

#[derive(Clone, Debug)]
pub(crate) struct CodexSourceCandidate {
    pub(crate) path: PathBuf,
    pub(crate) fingerprint: SourceFingerprint,
    pub(crate) checkpoint_current: bool,
}

type CodexRolloutIndex = HashMap<String, Vec<CodexSourceCandidate>>;
pub(crate) type CodexParseCache = HashMap<PathBuf, std::result::Result<ParsedCodexRollout, String>>;

fn codex_event_prefix_compatible(
    shorter: &ParsedCodexRollout,
    longer: &ParsedCodexRollout,
) -> bool {
    shorter.root_thread_id == longer.root_thread_id
        && shorter.root_meta_seen == longer.root_meta_seen
        && shorter.root_timestamp == longer.root_timestamp
        && shorter.parent == longer.parent
        && shorter.token_events.len() <= longer.token_events.len()
        && shorter
            .token_events
            .iter()
            .zip(&longer.token_events)
            .all(|(left, right)| {
                left.signature == right.signature
                    && left.delta == right.delta
                    && left.event_index == right.event_index
                    && left.model == right.model
                    && left.timestamp == right.timestamp
                    && left.timestamp_utc == right.timestamp_utc
            })
}

pub(crate) fn parse_codex_candidate(
    candidate: &CodexSourceCandidate,
    thread_id: &str,
    cache: &mut CodexParseCache,
) -> std::result::Result<ParsedCodexRollout, String> {
    if let Some(cached) = cache.get(&candidate.path) {
        return cached.clone();
    }
    let result = parse_codex_rollout(&candidate.path, thread_id, candidate.fingerprint.size_bytes)
        .and_then(|parsed| {
            let after = source_fingerprint(&candidate.path)?;
            let before = &candidate.fingerprint;
            let same_source = after.normalized_path == before.normalized_path
                && after.source_identity == before.source_identity;
            let stable_same_size =
                after.size_bytes == before.size_bytes && after.modified_ns == before.modified_ns;
            let append_only_growth = after.size_bytes > before.size_bytes;
            if !same_source || (!stable_same_size && !append_only_growth) {
                return Err(format!(
                    "Codex rollout was replaced, truncated, or rewritten while scanning: {}",
                    candidate.path.display()
                ));
            }
            Ok(parsed)
        });
    cache.insert(candidate.path.clone(), result.clone());
    result
}

fn select_codex_rollout(
    thread_id: &str,
    index: &CodexRolloutIndex,
    cache: &mut CodexParseCache,
) -> std::result::Result<ParsedCodexRollout, String> {
    let candidates = index
        .get(thread_id)
        .ok_or_else(|| format!("missing parent Codex rollout {thread_id}"))?;
    let mut selected: Option<ParsedCodexRollout> = None;
    for candidate in candidates {
        let parsed = parse_codex_candidate(candidate, thread_id, cache)?;
        selected = Some(match selected {
            None => parsed,
            Some(current) if codex_event_prefix_compatible(&current, &parsed) => parsed,
            Some(current) if codex_event_prefix_compatible(&parsed, &current) => current,
            Some(_) => {
                return Err(format!(
                    "Codex thread {thread_id} has divergent active/archive rollouts"
                ));
            }
        });
    }
    selected.ok_or_else(|| format!("missing Codex rollout candidate {thread_id}"))
}

fn codex_parent_signatures_before(
    parent_id: &str,
    cutoff: DateTime<Utc>,
    index: &CodexRolloutIndex,
    cache: &mut CodexParseCache,
) -> std::result::Result<Vec<CodexUsageSignature>, String> {
    let parent = select_codex_rollout(parent_id, index, cache)?;
    if !parent.root_meta_seen || matches!(parent.parent, CodexParentResolution::Deferred(_)) {
        return Err(format!(
            "parent Codex rollout {parent_id} has invalid root metadata"
        ));
    }
    if parent.token_without_timestamp {
        return Err(format!(
            "parent Codex rollout {parent_id} has token_count without timestamp"
        ));
    }
    if parent
        .max_timestamp
        .is_none_or(|max_timestamp| max_timestamp < cutoff)
    {
        return Err(format!(
            "parent Codex rollout {parent_id} has not reached the child fork timestamp"
        ));
    }
    Ok(parent
        .token_events
        .iter()
        .filter(|event| {
            event
                .timestamp_utc
                .is_some_and(|timestamp| timestamp <= cutoff)
        })
        .map(|event| event.signature.clone())
        .collect())
}

fn codex_replay_prefix(child: &[ParsedCodexTokenEvent], parent: &[CodexUsageSignature]) -> usize {
    let mut parent_offset = 0usize;
    let mut matched = 0usize;
    for event in child {
        let Some(relative_match) = parent[parent_offset..]
            .iter()
            .position(|signature| signature == &event.signature)
        else {
            break;
        };
        parent_offset += relative_match + 1;
        matched += 1;
    }
    matched
}

pub(crate) fn codex_logs_from_rollout(
    rollout: &ParsedCodexRollout,
    replay_prefix: usize,
) -> Vec<LogRecord> {
    rollout
        .token_events
        .iter()
        .enumerate()
        .filter_map(|(offset, event)| {
            let event_index = event.event_index?;
            (offset >= replay_prefix).then(|| {
                let combined_cache = event
                    .delta
                    .cache_read
                    .saturating_add(event.delta.cache_write)
                    .min(event.delta.input);
                let fresh_input = event.delta.input.saturating_sub(combined_cache);
                let to_i64 = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
                LogRecord {
                    tool: "codex".to_string(),
                    model: event.model.clone(),
                    input_tokens: to_i64(fresh_input),
                    output_tokens: to_i64(event.delta.output),
                    cached_tokens: to_i64(combined_cache),
                    cache_write_tokens: to_i64(event.delta.cache_write.min(combined_cache)),
                    timestamp: event.timestamp.clone(),
                    session_id: rollout.root_thread_id.clone(),
                    unique_key: format!("codex_v2_{}_{}", rollout.root_thread_id, event_index),
                    cost_usd: None,
                    cumulative: false,
                }
            })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum CodexDeferredReason {
    SourceUnavailable,
    SourceWalk,
    SourceFingerprint,
    InvalidFilename,
    SourceChanged,
    PartialJsonlTail,
    InvalidJson,
    InvalidUsageShape,
    CandidateDivergence,
    MissingRootMeta,
    InvalidParentMeta,
    MissingParent,
    ParentCutoff,
    MissingTokenTimestamp,
    MissingParentedRootTimestamp,
    SourceRead,
    OtherParse,
}

impl CodexDeferredReason {
    fn label(self) -> &'static str {
        match self {
            Self::SourceUnavailable => "source_unavailable",
            Self::SourceWalk => "source_walk",
            Self::SourceFingerprint => "source_fingerprint",
            Self::InvalidFilename => "invalid_filename",
            Self::SourceChanged => "source_changed",
            Self::PartialJsonlTail => "partial_jsonl_tail",
            Self::InvalidJson => "invalid_json",
            Self::InvalidUsageShape => "invalid_usage_shape",
            Self::CandidateDivergence => "candidate_divergence",
            Self::MissingRootMeta => "missing_root_meta",
            Self::InvalidParentMeta => "invalid_parent_meta",
            Self::MissingParent => "missing_parent",
            Self::ParentCutoff => "parent_cutoff",
            Self::MissingTokenTimestamp => "missing_token_timestamp",
            Self::MissingParentedRootTimestamp => "missing_parented_root_timestamp",
            Self::SourceRead => "source_read",
            Self::OtherParse => "other_parse",
        }
    }
}

fn codex_deferred_reason(error: &str) -> CodexDeferredReason {
    if error.contains("divergent active/archive") {
        CodexDeferredReason::CandidateDivergence
    } else if error.contains("missing parent Codex rollout") {
        CodexDeferredReason::MissingParent
    } else if error.contains("has not reached the child fork timestamp") {
        CodexDeferredReason::ParentCutoff
    } else if error.contains("parent Codex rollout") {
        CodexDeferredReason::InvalidParentMeta
    } else if error.contains("does not end at a JSONL boundary") {
        CodexDeferredReason::PartialJsonlTail
    } else if error.contains("replaced, truncated, or rewritten")
        || error.contains("truncated below its frozen size")
    {
        CodexDeferredReason::SourceChanged
    } else if error.contains("invalid Codex JSONL") {
        CodexDeferredReason::InvalidJson
    } else if error.contains("not an object")
        || error.contains("not a non-negative integer")
        || error.contains("limit_id is not a string")
    {
        CodexDeferredReason::InvalidUsageShape
    } else if error.contains("failed to open")
        || error.contains("failed to read")
        || error.contains("failed to seek")
        || error.contains("failed to rewind")
    {
        CodexDeferredReason::SourceRead
    } else {
        CodexDeferredReason::OtherParse
    }
}

#[derive(Default)]
pub(crate) struct CodexScanBatch {
    pub(crate) logs: Vec<LogRecord>,
    pub(crate) checkpoints: Vec<crate::db::ScanCheckpoint>,
    pub(crate) stats: CheckpointScanStats,
    pub(crate) complete: bool,
    pub(crate) legacy_session_ids: Vec<String>,
    pub(crate) root_session_ids: Vec<String>,
    pub(crate) deferred_reasons: BTreeMap<CodexDeferredReason, usize>,
}

impl CodexScanBatch {
    fn defer(&mut self, reason: CodexDeferredReason, files: usize) {
        self.complete = false;
        self.stats.failed_files += files;
        *self.deferred_reasons.entry(reason).or_default() += files;
    }

    fn deferred_summary(&self) -> String {
        self.deferred_reasons
            .iter()
            .map(|(reason, count)| format!("{}={count}", reason.label()))
            .collect::<Vec<_>>()
            .join(",")
    }
}

pub(crate) fn scan_codex_roots_checkpointed(
    roots: &[PathBuf],
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
    force_full_scan: bool,
) -> CodexScanBatch {
    let mut batch = CodexScanBatch {
        complete: true,
        ..CodexScanBatch::default()
    };
    let mut index = CodexRolloutIndex::new();
    let mut visited_paths = HashSet::new();
    for root in roots {
        match fs::metadata(root) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                batch.defer(CodexDeferredReason::SourceUnavailable, 1);
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                batch.defer(CodexDeferredReason::SourceUnavailable, 1);
                continue;
            }
        }
        for entry in WalkDir::new(root) {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    batch.defer(CodexDeferredReason::SourceWalk, 1);
                    continue;
                }
            };
            let path = entry.path();
            if !is_codex_rollout(path) {
                continue;
            }
            let fingerprint = match cached_source_fingerprint(path) {
                Ok(fingerprint) => fingerprint,
                Err(_) => {
                    batch.defer(CodexDeferredReason::SourceFingerprint, 1);
                    continue;
                }
            };
            if !visited_paths.insert(fingerprint.normalized_path.clone()) {
                continue;
            }
            let Some(thread_id) = codex_thread_id_from_path(path) else {
                batch.defer(CodexDeferredReason::InvalidFilename, 1);
                continue;
            };
            if let Some(legacy_session_id) = codex_legacy_session_id(path) {
                batch.legacy_session_ids.push(legacy_session_id);
            }
            batch.root_session_ids.push(thread_id.clone());
            let checkpoint_current = !force_full_scan
                && checkpoints
                    .get(&fingerprint.normalized_path)
                    .is_some_and(|checkpoint| checkpoint_is_current(checkpoint, &fingerprint));
            index
                .entry(thread_id)
                .or_default()
                .push(CodexSourceCandidate {
                    path: path.to_path_buf(),
                    fingerprint,
                    checkpoint_current,
                });
        }
    }
    for candidates in index.values_mut() {
        candidates.sort_by(|left, right| left.path.cmp(&right.path));
    }
    batch.legacy_session_ids.sort();
    batch.legacy_session_ids.dedup();
    batch.root_session_ids.sort();
    batch.root_session_ids.dedup();

    let mut thread_ids = index.keys().cloned().collect::<Vec<_>>();
    thread_ids.sort();
    let mut cache = CodexParseCache::new();
    for thread_id in thread_ids {
        let candidates = &index[&thread_id];
        if candidates
            .iter()
            .all(|candidate| candidate.checkpoint_current)
        {
            batch.stats.skipped_files += candidates.len();
            continue;
        }
        let parsed = match select_codex_rollout(&thread_id, &index, &mut cache) {
            Ok(parsed) => parsed,
            Err(error) => {
                batch.defer(codex_deferred_reason(&error), candidates.len());
                continue;
            }
        };
        if !parsed.root_meta_seen {
            batch.defer(CodexDeferredReason::MissingRootMeta, candidates.len());
            continue;
        }
        if parsed.has_billable_tokens && parsed.token_without_timestamp {
            batch.defer(CodexDeferredReason::MissingTokenTimestamp, candidates.len());
            continue;
        }
        let replay_prefix = match &parsed.parent {
            CodexParentResolution::None => 0,
            CodexParentResolution::Deferred(_) => {
                batch.defer(CodexDeferredReason::InvalidParentMeta, candidates.len());
                continue;
            }
            CodexParentResolution::Parent(parent_id) => {
                let Some(cutoff) = parsed.root_timestamp else {
                    batch.defer(
                        CodexDeferredReason::MissingParentedRootTimestamp,
                        candidates.len(),
                    );
                    continue;
                };
                match codex_parent_signatures_before(parent_id, cutoff, &index, &mut cache) {
                    Ok(parent) => codex_replay_prefix(&parsed.token_events, &parent),
                    Err(error) => {
                        batch.defer(codex_deferred_reason(&error), candidates.len());
                        continue;
                    }
                }
            }
        };
        let file_logs = codex_logs_from_rollout(&parsed, replay_prefix);
        batch.stats.parsed_records += file_logs.len();
        batch.logs.extend(file_logs);
        for candidate in candidates {
            if !candidate.checkpoint_current {
                batch.checkpoints.push(candidate.fingerprint.checkpoint());
                batch.stats.parsed_files += 1;
            }
        }
    }
    batch
}

pub(crate) fn scan_codex_roots_for_rebuild(
    roots: &[PathBuf],
    checkpoints: &HashMap<String, crate::db::ScanCheckpoint>,
) -> CodexScanBatch {
    let sessions_ready = |root: &PathBuf| {
        root.file_name().is_some_and(|name| name == "sessions")
            && fs::metadata(root).is_ok_and(|metadata| metadata.is_dir())
            && fs::read_dir(root).is_ok()
    };
    if !roots.iter().any(sessions_ready) {
        let mut batch = CodexScanBatch {
            complete: false,
            ..CodexScanBatch::default()
        };
        batch.defer(CodexDeferredReason::SourceUnavailable, 1);
        return batch;
    }
    let mut batch = scan_codex_roots_checkpointed(roots, checkpoints, true);
    if !roots.iter().any(|root| {
        root.file_name().is_some_and(|name| name == "sessions")
            && fs::metadata(root).is_ok_and(|metadata| metadata.is_dir())
            && fs::read_dir(root).is_ok()
    }) {
        batch.defer(CodexDeferredReason::SourceUnavailable, 1);
    }
    batch
}

pub(crate) fn scan_codex(
    db_path: &Path,
    extra_codex_dirs: &[String],
    logs: &mut Vec<LogRecord>,
    pending_checkpoints: &mut Vec<crate::db::ScanCheckpoint>,
) -> Result<(
    CheckpointScanStats,
    Option<crate::db::CodexRebuildPlan>,
    bool,
)> {
    let multica = discover_multica_codex_roots();
    let home = get_home_dir();
    let mut roots = codex_home_session_roots(&home.join(".codex")).to_vec();
    roots.extend(multica.roots);
    roots.extend(super::cindy::cindy_codex_roots_in(&home));
    roots.extend(configured_codex_roots(extra_codex_dirs, &home));
    let machine_id = crate::device_identity::for_db_or_unknown(db_path);
    let conn = crate::db::get_connection(db_path)?;
    let rebuild_pending = crate::db::codex_rebuild_pending(&conn, &machine_id)?;
    let checkpoints = crate::db::load_scan_checkpoints(&conn, CODEX_CHECKPOINT_SOURCE_KIND)?;
    drop(conn);
    let mut batch = if rebuild_pending {
        scan_codex_roots_for_rebuild(&roots, &checkpoints)
    } else {
        scan_codex_roots_checkpointed(&roots, &checkpoints, false)
    };
    if !multica.complete {
        batch.defer(CodexDeferredReason::SourceWalk, 1);
    }
    if !batch.deferred_reasons.is_empty() {
        let summary = batch.deferred_summary();
        log::warn!("Codex scan deferred categories: {summary}");
        if std::env::var("TOKENLEDGER_RUN_REAL_SCAN_GATE").as_deref() == Ok("1") {
            eprintln!("Codex scan deferred categories: {summary}");
        }
    }
    if rebuild_pending {
        if !batch.complete
            || batch.legacy_session_ids.is_empty()
            || batch.root_session_ids.is_empty()
        {
            log::warn!("Codex rebuild remains pending because the rollout inventory is incomplete");
            return Ok((batch.stats, None, true));
        }
        let plan = crate::db::CodexRebuildPlan {
            legacy_session_ids: batch.legacy_session_ids,
            root_session_ids: batch.root_session_ids,
        };
        logs.append(&mut batch.logs);
        pending_checkpoints.append(&mut batch.checkpoints);
        return Ok((batch.stats, Some(plan), false));
    }
    logs.append(&mut batch.logs);
    pending_checkpoints.append(&mut batch.checkpoints);
    Ok((batch.stats, None, false))
}

#[cfg(test)]
pub(crate) fn scan_codex_roots(roots: &[PathBuf], logs: &mut Vec<LogRecord>) -> CodexScanBatch {
    let mut batch = scan_codex_roots_checkpointed(roots, &HashMap::new(), true);
    logs.append(&mut batch.logs);
    batch
}
