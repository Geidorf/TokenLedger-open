//! Bounded metadata projection. Unknown fields (including text, arguments,
//! tool results and instruction bodies) are consumed with IgnoredAny.
use super::types::Failure;
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
#[cfg(test)]
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

pub(super) const MAX_BYTES: u64 = 32 * 1024 * 1024;
pub(super) const MAX_LINE: usize = 1024 * 1024;
pub(super) const MAX_TURNS: usize = 2_000;

pub(super) struct Budget {
    pub cancel: Arc<AtomicBool>,
    pub deadline: Instant,
    pub bytes_left: u64,
}
impl Budget {
    pub fn new(cancel: Arc<AtomicBool>) -> Self {
        Self {
            cancel,
            deadline: Instant::now() + Duration::from_secs(3),
            bytes_left: MAX_BYTES,
        }
    }
    pub fn check(&self) -> Result<(), Failure> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("cancelled");
        }
        if Instant::now() >= self.deadline {
            return Err("limit_exceeded");
        }
        Ok(())
    }
}

// This is a metadata vocabulary, not a content serializer. Container strings
// are replaced by an empty structural marker; no prompt string is allocated.
fn allowed(key: &str) -> bool {
    matches!(
        key,
        "type"
            | "subtype"
            | "timestamp"
            | "uuid"
            | "parentUuid"
            | "isMeta"
            | "isSidechain"
            | "isCompactSummary"
            | "requestId"
            | "message"
            | "content"
            | "usage"
            | "id"
            | "model"
            | "name"
            | "stop_reason"
            | "payload"
            | "role"
            | "call_id"
            | "turn_id"
            | "info"
            | "rate_limits"
            | "limit_id"
            | "thread_id"
            | "threadId"
            | "forked_from_id"
            | "parent_thread_id"
            | "source"
            | "subagent"
            | "thread_spawn"
            | "total_token_usage"
            | "last_token_usage"
            | "model_name"
            | "input_tokens"
            | "output_tokens"
            | "cache_read_input_tokens"
            | "cache_creation_input_tokens"
            | "cached_input_tokens"
            | "cached_tokens"
            | "cache_write_input_tokens"
            | "cache_write_tokens"
            | "input_tokens_details"
            | "prompt_tokens_details"
            | "reasoning_output_tokens"
            | "total_tokens"
    )
}

struct Project {
    scalar: bool,
}
impl<'de> DeserializeSeed<'de> for Project {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<Value, D::Error> {
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Project {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("JSON metadata")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut out = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if allowed(&key) {
                let scalar = !matches!(key.as_str(), "content" | "message");
                out.insert(key, map.next_value_seed(Project { scalar })?);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(Value::Object(out))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut out = Vec::new();
        while let Some(value) = seq.next_element_seed(Project { scalar: false })? {
            out.push(value);
        }
        Ok(Value::Array(out))
    }
    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(if self.scalar {
            value.to_owned()
        } else {
            String::new()
        }))
    }
    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Value, E> {
        Ok(Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null))
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
}

pub(super) fn project(bytes: &[u8]) -> Result<Value, Failure> {
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let value = Project { scalar: false }
        .deserialize(&mut d)
        .map_err(|_| "source_unreadable")?;
    d.end().map_err(|_| "source_unreadable")?;
    Ok(value)
}

pub(super) struct Snapshot {
    pub records: Vec<(usize, Value)>,
    pub incomplete_tail: bool,
}

#[cfg(test)]
pub(super) fn read_snapshot(path: &Path, budget: &mut Budget) -> Result<Snapshot, Failure> {
    let parent = std::fs::canonicalize(path.parent().ok_or("source_unreadable")?)
        .map_err(|_| "source_unreadable")?;
    let candidate = super::resolver::canonical_candidate(path, &[parent])?;
    read_candidate(&candidate, budget)
}

pub(super) fn read_candidate(
    candidate: &super::resolver::Candidate,
    budget: &mut Budget,
) -> Result<Snapshot, Failure> {
    let path = &candidate.path;
    use crate::scanner::checkpoints::source_fingerprint;
    budget.check()?;
    let before = source_fingerprint(path).map_err(|_| "source_unreadable")?;
    if before.normalized_path != candidate.fingerprint.normalized_path
        || before.source_identity != candidate.fingerprint.source_identity
    {
        return Err("source_changed");
    }
    let size = u64::try_from(before.size_bytes).map_err(|_| "limit_exceeded")?;
    if size > budget.bytes_left {
        return Err("limit_exceeded");
    }
    budget.bytes_left -= size;
    let file = File::open(path).map_err(|_| "source_unreadable")?;
    verify_handle(&file, candidate)?;
    if file.metadata().map_err(|_| "source_unreadable")?.len() < size {
        return Err("source_changed");
    }
    // Freeze the prefix. Concurrent appends do not change this analysis.
    let mut reader = BufReader::new((&file).take(size));
    let mut records = Vec::new();
    let mut line = Vec::new();
    let mut line_no = 0;
    let mut incomplete_tail = false;
    loop {
        budget.check()?;
        line.clear();
        let read = reader
            .by_ref()
            .take((MAX_LINE + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "source_unreadable")?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_LINE {
            return Err("limit_exceeded");
        }
        line_no += 1;
        if line.last() != Some(&b'\n') {
            incomplete_tail = true;
            break;
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        records.push((line_no, project(&line)?));
        if records.len() > 100_000 {
            return Err("limit_exceeded");
        }
    }
    verify_handle(&file, candidate)?;
    let after = source_fingerprint(path).map_err(|_| "source_changed")?;
    if before.normalized_path != after.normalized_path
        || before.source_identity != after.source_identity
        || after.size_bytes < before.size_bytes
        || (after.size_bytes == before.size_bytes && after.modified_ns != before.modified_ns)
    {
        return Err("source_changed");
    }
    budget.check()?;
    Ok(Snapshot {
        records,
        incomplete_tail,
    })
}

fn verify_handle(file: &File, candidate: &super::resolver::Candidate) -> Result<(), Failure> {
    let (identity, handle_path) = super::handle::identity_and_path(file)?;
    if identity != candidate.fingerprint.source_identity
        || handle_path != candidate.path
        || !candidate
            .roots
            .iter()
            .any(|root| handle_path.starts_with(root))
    {
        return Err("source_changed");
    }
    Ok(())
}
