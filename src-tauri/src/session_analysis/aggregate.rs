use super::{
    reader::{Budget, MAX_TURNS},
    types::*,
};
use crate::scanner::types::LogRecord;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};

pub(super) fn timestamp(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.to_rfc3339())
}

pub(super) struct Aggregate {
    pub result: Analysis,
    pub current: Option<usize>,
    pub unknown: bool,
    pub calls: HashSet<String>,
    pub users: HashMap<String, usize>,
    pub requests: BTreeMap<String, (LogRecord, Option<usize>, bool)>,
}
impl Aggregate {
    pub fn new(record: &Record) -> Self {
        let mut result = Analysis::unavailable(record.id, "insufficient_turn_metadata");
        result.session_id = record.session_id.clone();
        result.tool = record.tool.clone();
        result.coverage.tool_calls_known = true;
        Self {
            result,
            current: None,
            unknown: false,
            calls: HashSet::new(),
            users: HashMap::new(),
            requests: BTreeMap::new(),
        }
    }
    pub fn start(
        &mut self,
        id: &str,
        time: Option<String>,
        budget: &Budget,
    ) -> Result<(), Failure> {
        budget.check()?;
        if let Some(index) = self.users.get(id) {
            return if self.current == Some(*index) {
                Ok(())
            } else {
                Err("unsupported_session_shape")
            };
        }
        if self.result.turns.len() >= MAX_TURNS {
            return Err("limit_exceeded");
        }
        // A new input proves the preceding grouping has ended, but does not
        // prove that the prior model response successfully completed.
        if let Some(index) = self.current {
            if self.result.turns[index].ended_at.is_none() {
                self.result.turns[index].ended_at = time.clone();
            }
        }
        let ordinal = self.result.turns.len() + 1;
        self.users.insert(id.to_owned(), ordinal - 1);
        self.result.turns.push(Turn {
            // Native IDs are only used internally for de-duplication.
            id: format!("turn-{ordinal}"),
            ordinal,
            started_at: time,
            ended_at: None,
            status: "unknown",
            usage: Usage::default(),
            cache_read_tokens: Some(0),
            cache_write_tokens: Some(0),
            models: Vec::new(),
            tools: Vec::new(),
        });
        self.current = Some(ordinal - 1);
        Ok(())
    }
    pub fn finish(&mut self, time: Option<String>, successful: bool) {
        if let Some(index) = self.current {
            let turn = &mut self.result.turns[index];
            turn.ended_at = time;
            turn.status = if successful { "complete" } else { "unknown" };
        }
    }
    pub fn tool(&mut self, id: Option<&str>, name: Option<&str>) {
        let Some((id, name)) = id.zip(name).filter(|(id, name)| {
            !id.is_empty()
                && id.len() <= 256
                && !name.is_empty()
                && name.len() <= 128
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '/'))
        }) else {
            self.result.coverage.tool_calls_known = false;
            self.unknown = true;
            return;
        };
        if !self.calls.insert(id.to_owned()) {
            return;
        }
        let Some(index) = self.current else {
            self.unknown = true;
            self.result.coverage.tool_calls_known = false;
            return;
        };
        let tools = &mut self.result.turns[index].tools;
        if let Some(tool) = tools.iter_mut().find(|t| t.name == name) {
            tool.count += 1;
        } else {
            tools.push(ToolCount {
                name: name.to_owned(),
                count: 1,
            });
        }
    }
    pub fn complete(mut self, selected_key: &str, budget: &Budget) -> Result<Analysis, Failure> {
        budget.check()?;
        if !self.requests.contains_key(selected_key) {
            return Err("record_not_found");
        }
        self.result.coverage.matched_record = true;
        if self.result.turns.is_empty() {
            return Err("insufficient_turn_metadata");
        }
        let mut unassigned = Usage::default();
        for (_, (log, turn, split_known)) in self.requests {
            budget.check()?;
            let usage = if let Some(index) = turn {
                let row = &mut self.result.turns[index];
                if log.model.len() <= 256
                    && !log.model.chars().any(char::is_control)
                    && !row.models.contains(&log.model)
                {
                    row.models.push(log.model.clone());
                }
                if split_known {
                    if let Some(read) = &mut row.cache_read_tokens {
                        *read = read
                            .checked_add(log.cached_tokens - log.cache_write_tokens)
                            .ok_or("source_unreadable")?;
                    }
                    if let Some(write) = &mut row.cache_write_tokens {
                        *write = write
                            .checked_add(log.cache_write_tokens)
                            .ok_or("source_unreadable")?;
                    }
                } else {
                    row.cache_read_tokens = None;
                    row.cache_write_tokens = None;
                }
                &mut row.usage
            } else {
                self.unknown = true;
                &mut unassigned
            };
            usage.request_count += 1;
            usage.input_tokens = usage
                .input_tokens
                .checked_add(log.input_tokens)
                .ok_or("source_unreadable")?;
            usage.output_tokens = usage
                .output_tokens
                .checked_add(log.output_tokens)
                .ok_or("source_unreadable")?;
            usage.cached_tokens = usage
                .cached_tokens
                .checked_add(log.cached_tokens)
                .ok_or("source_unreadable")?;
        }
        if unassigned.request_count > 0 {
            self.result.unassigned_usage = Some(unassigned);
        }
        for turn in &mut self.result.turns {
            turn.models.sort();
            turn.tools.sort_by(|a, b| a.name.cmp(&b.name));
            if turn.usage.request_count == 0 {
                turn.cache_read_tokens = None;
                turn.cache_write_tokens = None;
            }
        }
        self.result.status = if self.unknown { "partial" } else { "ready" };
        self.result.reason = self.unknown.then_some("insufficient_turn_metadata");
        self.result.coverage.complete = !self.unknown;
        Ok(self.result)
    }
}
