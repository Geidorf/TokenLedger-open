use super::{
    aggregate::{timestamp, Aggregate},
    reader::{Budget, Snapshot},
    types::*,
};
use crate::scanner::codex::{
    codex_logs_from_rollout, codex_usage_signature, parse_codex_rollout_reader_checked,
    CodexParentResolution,
};
use std::{collections::HashMap, io::Cursor, path::Path};

pub(super) fn analyze(
    record: &Record,
    snapshot: &Snapshot,
    budget: &Budget,
) -> Result<Analysis, Failure> {
    // Reuse scanner counter lanes, high water, cache normalization and stable
    // event identities, feeding only the bounded metadata projection.
    let mut bytes = Vec::new();
    for (_, value) in &snapshot.records {
        budget.check()?;
        serde_json::to_writer(&mut bytes, value).map_err(|_| "source_unreadable")?;
        bytes.push(b'\n');
    }
    let parsed = parse_codex_rollout_reader_checked(
        Cursor::new(bytes),
        Path::new("metadata"),
        &record.session_id,
        || budget.check().map_err(str::to_owned),
    )
    .map_err(|_| budget.check().err().unwrap_or("source_unreadable"))?;
    budget.check()?;
    if !parsed.root_meta_seen || parsed.token_without_timestamp {
        return Err("insufficient_turn_metadata");
    }
    if !matches!(parsed.parent, CodexParentResolution::None)
        || snapshot.records.iter().any(|(_, v)| {
            v["type"] == "session_meta" && v["payload"]["source"].get("subagent").is_some()
        })
        || snapshot
            .records
            .iter()
            .filter(|(_, v)| v["type"] == "session_meta")
            .count()
            != 1
    {
        return Err("unsupported_session_shape");
    }
    let logs: HashMap<_, _> = codex_logs_from_rollout(&parsed, 0)
        .into_iter()
        .map(|l| (l.unique_key.clone(), l))
        .collect();
    let mut aggregate = Aggregate::new(record);
    aggregate.unknown = snapshot.incomplete_tail;
    let mut event_offset = 0;
    let mut current_native_turn: Option<String> = None;
    let mut anonymous_inputs: HashMap<String, String> = HashMap::new();
    for (_, value) in &snapshot.records {
        budget.check()?;
        let payload = &value["payload"];
        if value["type"] == "turn_context"
            || (value["type"] == "event_msg" && payload["type"] == "task_started")
        {
            if let Some(id) = payload["turn_id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
            {
                current_native_turn = Some(id.to_owned());
            }
        }
        match (value["type"].as_str(), payload["type"].as_str()) {
            (Some("event_msg"), Some("user_message")) => {
                let id = if let Some(id) = payload["id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                {
                    format!("event:{id}")
                } else {
                    let native = payload["turn_id"]
                        .as_str()
                        .or(current_native_turn.as_deref())
                        .ok_or("insufficient_turn_metadata")?;
                    let time =
                        timestamp(value.get("timestamp")).ok_or("insufficient_turn_metadata")?;
                    if anonymous_inputs
                        .get(native)
                        .is_some_and(|previous| previous != &time)
                    {
                        return Err("insufficient_turn_metadata");
                    }
                    anonymous_inputs.insert(native.to_owned(), time);
                    format!("native:{native}")
                };
                aggregate.start(&id, timestamp(value.get("timestamp")), budget)?;
            }
            (Some("event_msg"), Some("task_complete" | "task_completed")) => {
                aggregate.finish(timestamp(value.get("timestamp")), true);
            }
            (Some("event_msg"), Some("turn_aborted")) => {
                aggregate.finish(timestamp(value.get("timestamp")), false);
            }
            (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
                aggregate.tool(
                    payload["call_id"]
                        .as_str()
                        .or_else(|| payload["id"].as_str()),
                    payload["name"].as_str(),
                );
            }
            (Some("event_msg"), Some("token_count")) => {
                let Some(signature) =
                    codex_usage_signature(&payload["info"]).map_err(|_| "source_unreadable")?
                else {
                    continue;
                };
                let counters = signature
                    .last
                    .as_ref()
                    .or(signature.total.as_ref())
                    .ok_or("source_unreadable")?;
                // No invented input/output/cache values from partial counters.
                if counters.input.is_none()
                    || counters.output.is_none()
                    || counters.cache_read.is_none()
                {
                    return Err("source_unreadable");
                }
                let event = parsed
                    .token_events
                    .get(event_offset)
                    .ok_or("source_unreadable")?;
                event_offset += 1;
                if let Some(index) = event.event_index {
                    let key = format!("codex_v2_{}_{index}", record.session_id);
                    let log = logs.get(&key).ok_or("source_unreadable")?.clone();
                    aggregate.requests.insert(
                        key,
                        (log, aggregate.current, counters.cache_write.is_some()),
                    );
                }
            }
            _ => {}
        }
    }
    aggregate.complete(&record.unique_key, budget)
}
