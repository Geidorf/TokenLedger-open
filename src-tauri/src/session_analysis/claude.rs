use super::{
    aggregate::{timestamp, Aggregate},
    reader::{Budget, Snapshot},
    types::*,
};
use crate::scanner::claude::{claude_record_from_value, claude_snapshot_rank};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub(super) fn analyze(
    record: &Record,
    snapshot: &Snapshot,
    budget: &Budget,
) -> Result<Analysis, Failure> {
    let mut aggregate = Aggregate::new(record);
    aggregate.unknown = snapshot.incomplete_tail;
    let mut ancestry: HashMap<String, Option<usize>> = HashMap::new();
    let mut assistant_messages = HashSet::new();
    let mut messages_with_usage = HashSet::new();
    for (line, data) in &snapshot.records {
        budget.check()?;
        if ["isSidechain", "isCompactSummary"]
            .iter()
            .any(|key| data.get(key).and_then(Value::as_bool) == Some(true))
            || data.get("type").and_then(Value::as_str) == Some("summary")
            || matches!(
                data["subtype"].as_str(),
                Some("compact_boundary" | "microcompact_boundary")
            )
        {
            return Err("unsupported_session_shape");
        }
        match data.get("type").and_then(Value::as_str) {
            Some("user") if data.get("isMeta").and_then(Value::as_bool) != Some(true) => {
                let content = &data["message"]["content"];
                let blocks = content.as_array();
                let tool_result =
                    blocks.is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"));
                let user_input = content.is_string()
                    || blocks.is_some_and(|blocks| {
                        blocks.iter().any(|b| {
                            matches!(b["type"].as_str(), Some("text" | "image" | "document"))
                        })
                    });
                if tool_result {
                    check_parent(data, aggregate.current, &ancestry)?;
                    if let Some(id) = data["uuid"].as_str() {
                        ancestry.insert(id.to_owned(), aggregate.current);
                    }
                    continue;
                }
                if user_input {
                    let id = data["uuid"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or("insufficient_turn_metadata")?;
                    check_parent(data, aggregate.current, &ancestry)?;
                    aggregate.start(id, timestamp(data.get("timestamp")), budget)?;
                    ancestry.insert(id.to_owned(), aggregate.current);
                } else {
                    aggregate.unknown = true;
                }
            }
            Some("assistant") => {
                check_parent(data, aggregate.current, &ancestry)?;
                if let Some(id) = data["uuid"].as_str() {
                    ancestry.insert(id.to_owned(), aggregate.current);
                }
                let message_id = data["message"]["id"]
                    .as_str()
                    .or_else(|| data["uuid"].as_str())
                    .ok_or("insufficient_turn_metadata")?;
                let identity = (
                    message_id.to_owned(),
                    data["requestId"].as_str().unwrap_or("").to_owned(),
                );
                assistant_messages.insert(identity.clone());
                if let Some(blocks) = data["message"]["content"].as_array() {
                    for block in blocks {
                        if block["type"] == "tool_use" {
                            aggregate.tool(block["id"].as_str(), block["name"].as_str());
                        }
                    }
                } else {
                    aggregate.result.coverage.tool_calls_known = false;
                    aggregate.unknown = true;
                }
                let usage = &data["message"]["usage"];
                if usage.is_object() {
                    messages_with_usage.insert(identity);
                    // Unlike the scanner's legacy compatibility reader, the
                    // analysis must not call missing counters known zero.
                    if ![
                        "input_tokens",
                        "output_tokens",
                        "cache_read_input_tokens",
                        "cache_creation_input_tokens",
                    ]
                    .iter()
                    .all(|key| {
                        usage[*key]
                            .as_i64()
                            .is_some_and(|n| (0..=i64::MAX / 4).contains(&n))
                    }) {
                        return Err("source_unreadable");
                    }
                    let log = claude_record_from_value(data, &record.session_id, *line)
                        .ok_or("source_unreadable")?;
                    let entry = aggregate.requests.entry(log.unique_key.clone());
                    match entry {
                        std::collections::btree_map::Entry::Vacant(slot) => {
                            slot.insert((log, aggregate.current, true));
                        }
                        std::collections::btree_map::Entry::Occupied(mut slot) => {
                            if slot.get().1 != aggregate.current {
                                return Err("unsupported_session_shape");
                            }
                            if claude_snapshot_rank(&log) > claude_snapshot_rank(&slot.get().0) {
                                slot.insert((log, aggregate.current, true));
                            }
                        }
                    }
                }
                if matches!(
                    data["message"]["stop_reason"].as_str(),
                    Some("end_turn" | "stop_sequence")
                ) {
                    aggregate.finish(timestamp(data.get("timestamp")), true);
                }
            }
            _ => {}
        }
    }
    if assistant_messages != messages_with_usage {
        return Err("insufficient_turn_metadata");
    }
    aggregate.complete(&record.unique_key, budget)
}

fn check_parent(
    data: &Value,
    current: Option<usize>,
    ancestry: &HashMap<String, Option<usize>>,
) -> Result<(), Failure> {
    if let Some(parent) = data["parentUuid"].as_str() {
        match ancestry.get(parent) {
            Some(owner) if *owner != current => return Err("unsupported_session_shape"),
            None if current.is_some() => return Err("unsupported_session_shape"),
            _ => {}
        }
    } else if current.is_some() && data["type"] == "assistant" {
        return Err("insufficient_turn_metadata");
    }
    Ok(())
}
