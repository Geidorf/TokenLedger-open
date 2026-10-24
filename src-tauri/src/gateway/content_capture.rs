//! Bounded, attachment-free content sampling for gateway requests and replies.
//!
//! Request bodies are redacted while they are serialized, so inline attachment
//! payloads are never copied into the sample. Stream replies keep only the
//! merged text, reasoning and tool calls; raw SSE events are discarded.

use serde_json::{json, Map, Value};

const ATTACHMENT_TYPE: &str = "attachment";
const MAX_DEPTH: usize = 128;
const MAX_TOOL_CALLS: usize = 128;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;
const MAX_SSE_EVENT_BYTES: usize = 2 * 1024 * 1024;
const NONSTREAM_INVALID: &str = "正文不可解析或已截断，未保存原文。";
const SANITIZE_OVERSIZE: &str = "正文超过采样上限，未保存原文。";
const STREAM_OVERSIZE: &str = "采样内容超过上限，已截断。";

#[derive(Clone, PartialEq, Eq)]
pub(super) struct CapturedContent {
    pub text: String,
    pub truncated: bool,
    pub failed: bool,
}

/// Returns a JSON serialization of `value` with provider-native attachments
/// reduced to media type and size. If the safe result cannot fit, no part of
/// the original body is returned.
pub(super) fn sanitize_body(value: &Value, max_bytes: usize) -> CapturedContent {
    let failed = value_contains_error(value);
    let mut sink = JsonSink::new(max_bytes);
    if write_sanitized(&mut sink, value, 0).is_err() || sink.overflow {
        return CapturedContent {
            text: neutral_json(max_bytes, SANITIZE_OVERSIZE),
            truncated: true,
            failed,
        };
    }
    CapturedContent {
        text: sink.finish(),
        truncated: false,
        failed,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Protocol {
    Chat,
    Responses,
    Messages,
    Gemini,
}

impl Protocol {
    fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Responses => "responses",
            Self::Messages => "messages",
            Self::Gemini => "gemini",
        }
    }
}

#[derive(Clone, Default)]
struct ToolCall {
    key: String,
    id: Option<String>,
    call_id: Option<String>,
    name: Option<String>,
    arguments: String,
    index: Option<u64>,
    arguments_from_delta: bool,
}

#[derive(Default)]
struct StreamAccumulator {
    protocol: Option<Protocol>,
    text: String,
    reasoning: String,
    tool_calls: Vec<ToolCall>,
    stored_bytes: usize,
    truncated: bool,
    failed: bool,
    invalid_event: bool,
}

impl StreamAccumulator {
    fn remaining(&self, max_bytes: usize) -> usize {
        max_bytes.saturating_sub(self.stored_bytes)
    }

    fn append_text(&mut self, field: TextField, value: &str, max_bytes: usize) {
        if value.is_empty() {
            return;
        }
        let prefix = utf8_prefix(value, self.remaining(max_bytes));
        match field {
            TextField::Text => self.text.push_str(prefix),
            TextField::Reasoning => self.reasoning.push_str(prefix),
        }
        self.stored_bytes = self.stored_bytes.saturating_add(prefix.len());
        if prefix.len() != value.len() {
            self.truncated = true;
        }
    }

    fn append_arguments(&mut self, call: usize, value: &str, max_bytes: usize) {
        if value.is_empty() {
            return;
        }
        if !self.tool_calls[call].arguments_from_delta {
            self.stored_bytes = self
                .stored_bytes
                .saturating_sub(self.tool_calls[call].arguments.len());
            self.tool_calls[call].arguments.clear();
            self.tool_calls[call].arguments_from_delta = true;
        }
        let prefix = utf8_prefix(value, self.remaining(max_bytes));
        self.tool_calls[call].arguments.push_str(prefix);
        self.stored_bytes = self.stored_bytes.saturating_add(prefix.len());
        if prefix.len() != value.len() {
            self.truncated = true;
        }
    }

    fn replace_arguments(&mut self, call: usize, value: &str, max_bytes: usize) {
        if self.tool_calls[call].arguments_from_delta || value.is_empty() {
            return;
        }
        let available = self
            .remaining(max_bytes)
            .saturating_add(self.tool_calls[call].arguments.len());
        let prefix = utf8_prefix(value, available);
        self.stored_bytes = self
            .stored_bytes
            .saturating_sub(self.tool_calls[call].arguments.len())
            .saturating_add(prefix.len());
        self.tool_calls[call].arguments.clear();
        self.tool_calls[call].arguments.push_str(prefix);
        if prefix.len() != value.len() {
            self.truncated = true;
        }
    }

    fn set_identifier(
        &mut self,
        call: usize,
        field: IdentifierField,
        value: &str,
        max_bytes: usize,
    ) {
        if value.is_empty() {
            return;
        }
        let target = match field {
            IdentifierField::Id => &self.tool_calls[call].id,
            IdentifierField::CallId => &self.tool_calls[call].call_id,
            IdentifierField::Name => &self.tool_calls[call].name,
        };
        if target.as_deref() == Some(value) {
            return;
        }
        let old_len = target.as_ref().map_or(0, String::len);
        let available = self
            .remaining(max_bytes)
            .saturating_add(old_len)
            .min(MAX_IDENTIFIER_BYTES);
        let prefix = utf8_prefix(value, available);
        if prefix.is_empty() {
            self.truncated = true;
            return;
        }
        self.stored_bytes = self
            .stored_bytes
            .saturating_sub(old_len)
            .saturating_add(prefix.len());
        let target = match field {
            IdentifierField::Id => &mut self.tool_calls[call].id,
            IdentifierField::CallId => &mut self.tool_calls[call].call_id,
            IdentifierField::Name => &mut self.tool_calls[call].name,
        };
        *target = Some(prefix.to_string());
        if prefix.len() != value.len() {
            self.truncated = true;
        }
    }

    fn tool_call(&mut self, key: String, index: Option<u64>, _max_bytes: usize) -> Option<usize> {
        if let Some(position) = self.tool_calls.iter().position(|call| call.key == key) {
            if index.is_some() {
                self.tool_calls[position].index = index;
            }
            return Some(position);
        }
        if self.tool_calls.len() >= MAX_TOOL_CALLS {
            self.truncated = true;
            return None;
        }
        self.tool_calls.push(ToolCall {
            key,
            index,
            ..ToolCall::default()
        });
        Some(self.tool_calls.len() - 1)
    }

    fn sanitize_tool_arguments(&mut self, max_bytes: usize) {
        let mut remaining = self.remaining(max_bytes);
        for call in &mut self.tool_calls {
            if call.arguments.is_empty() {
                continue;
            }
            let old_len = call.arguments.len();
            let available = remaining.saturating_add(old_len);
            let sanitized = sanitize_argument(&call.arguments, available);
            self.stored_bytes = self.stored_bytes.saturating_sub(old_len);
            match sanitized {
                Some((arguments, truncated)) => {
                    self.stored_bytes = self.stored_bytes.saturating_add(arguments.len());
                    self.truncated |= truncated;
                    call.arguments = arguments;
                }
                None => {
                    self.truncated = true;
                    call.arguments.clear();
                }
            }
            remaining = max_bytes.saturating_sub(self.stored_bytes);
        }
    }

    fn handle_event(&mut self, data: &[u8], max_bytes: usize) {
        let data = trim_ascii(data);
        if data.is_empty() || data == b"[DONE]" {
            return;
        }
        let value = match serde_json::from_slice::<Value>(data) {
            Ok(value) => value,
            Err(_) => {
                self.invalid_event = true;
                return;
            }
        };
        if value_contains_error(&value) {
            self.failed = true;
        }
        let protocol = self.protocol.or_else(|| detect_protocol(&value));
        if let Some(protocol) = protocol {
            self.protocol = Some(protocol);
        }
        match protocol {
            Some(Protocol::Chat) => self.handle_chat(&value, max_bytes),
            Some(Protocol::Responses) => self.handle_responses(&value, max_bytes),
            Some(Protocol::Messages) => self.handle_messages(&value, max_bytes),
            Some(Protocol::Gemini) => self.handle_gemini(&value, max_bytes),
            None => {}
        }
    }

    fn handle_chat(&mut self, value: &Value, max_bytes: usize) {
        let Some(choices) = value.get("choices").and_then(Value::as_array) else {
            return;
        };
        for (choice_position, choice) in choices.iter().enumerate() {
            let choice_index = choice
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(choice_position as u64);
            if let Some(delta) = choice.get("delta").and_then(Value::as_object) {
                if let Some(text) = delta.get("content").and_then(Value::as_str) {
                    self.append_text(TextField::Text, text, max_bytes);
                }
                for key in ["reasoning_content", "reasoning"] {
                    if let Some(text) = delta.get(key).and_then(Value::as_str) {
                        self.append_text(TextField::Reasoning, text, max_bytes);
                    }
                }
                if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                    for (position, call) in calls.iter().enumerate() {
                        let tool_index = call
                            .get("index")
                            .and_then(Value::as_u64)
                            .unwrap_or(position as u64);
                        let key = format!("chat:{choice_index}:{tool_index}");
                        let Some(call_position) = self.tool_call(key, Some(tool_index), max_bytes)
                        else {
                            continue;
                        };
                        if let Some(id) = call.get("id").and_then(Value::as_str) {
                            self.set_identifier(call_position, IdentifierField::Id, id, max_bytes);
                        }
                        if let Some(function) = call.get("function") {
                            if let Some(name) = function.get("name").and_then(Value::as_str) {
                                self.set_identifier(
                                    call_position,
                                    IdentifierField::Name,
                                    name,
                                    max_bytes,
                                );
                            }
                            if let Some(arguments) =
                                function.get("arguments").and_then(Value::as_str)
                            {
                                self.append_arguments(call_position, arguments, max_bytes);
                            }
                        }
                    }
                }
            }

            // Some compatible providers put one full message in the final
            // chunk. It is only a fallback for streams that sent no deltas.
            if let Some(message) = choice.get("message").and_then(Value::as_object) {
                if self.text.is_empty() {
                    if let Some(text) = message.get("content").and_then(Value::as_str) {
                        self.append_text(TextField::Text, text, max_bytes);
                    }
                }
                if self.reasoning.is_empty() {
                    for key in ["reasoning_content", "reasoning"] {
                        if let Some(text) = message.get(key).and_then(Value::as_str) {
                            self.append_text(TextField::Reasoning, text, max_bytes);
                        }
                    }
                }
                if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for (position, call) in calls.iter().enumerate() {
                        let tool_index = position as u64;
                        let key = format!("chat:{choice_index}:{tool_index}");
                        let Some(call_position) = self.tool_call(key, Some(tool_index), max_bytes)
                        else {
                            continue;
                        };
                        if let Some(id) = call.get("id").and_then(Value::as_str) {
                            self.set_identifier(call_position, IdentifierField::Id, id, max_bytes);
                        }
                        if let Some(function) = call.get("function") {
                            if let Some(name) = function.get("name").and_then(Value::as_str) {
                                self.set_identifier(
                                    call_position,
                                    IdentifierField::Name,
                                    name,
                                    max_bytes,
                                );
                            }
                            if let Some(arguments) =
                                function.get("arguments").and_then(Value::as_str)
                            {
                                self.replace_arguments(call_position, arguments, max_bytes);
                            }
                        }
                    }
                }
            }
        }
    }

    fn handle_responses(&mut self, value: &Value, max_bytes: usize) {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if let Some(delta) = value.get("delta").and_then(Value::as_str) {
            match kind {
                "response.output_text.delta" => self.append_text(TextField::Text, delta, max_bytes),
                "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                    self.append_text(TextField::Reasoning, delta, max_bytes)
                }
                "response.function_call_arguments.delta" => {
                    let position = self.response_call_position(value, max_bytes);
                    if let Some(position) = position {
                        self.append_arguments(position, delta, max_bytes);
                    }
                }
                _ => {}
            }
        }

        match kind {
            "response.output_text.done" => {
                if self.text.is_empty() {
                    if let Some(text) = value.get("text").and_then(Value::as_str) {
                        self.append_text(TextField::Text, text, max_bytes);
                    }
                }
            }
            "response.reasoning_summary_text.done" | "response.reasoning_text.done" => {
                if self.reasoning.is_empty() {
                    if let Some(text) = value.get("text").and_then(Value::as_str) {
                        self.append_text(TextField::Reasoning, text, max_bytes);
                    }
                }
            }
            "response.function_call_arguments.done" => {
                let position = self.response_call_position(value, max_bytes);
                if let Some(position) = position {
                    if let Some(arguments) = value.get("arguments").and_then(Value::as_str) {
                        self.replace_arguments(position, arguments, max_bytes);
                    }
                }
            }
            "response.output_item.added" => {
                if let Some(item) = value.get("item") {
                    self.absorb_responses_item(item, value, max_bytes, false);
                }
            }
            "response.output_item.done" => {
                if let Some(item) = value.get("item") {
                    self.absorb_responses_item(item, value, max_bytes, true);
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                if let Some(output) = value.pointer("/response/output").and_then(Value::as_array) {
                    for (index, item) in output.iter().enumerate() {
                        self.absorb_responses_output_item(item, index as u64, max_bytes);
                    }
                }
            }
            _ => {}
        }
    }

    fn response_call_position(&mut self, value: &Value, max_bytes: usize) -> Option<usize> {
        let output_index = value.get("output_index").and_then(Value::as_u64);
        let item_id = value.get("item_id").and_then(Value::as_str);
        let call_id = value.get("call_id").and_then(Value::as_str);
        let key = if let Some(index) = output_index {
            format!("responses:index:{index}")
        } else if let Some(id) = item_id.or(call_id) {
            format!("responses:id:{}", utf8_prefix(id, MAX_IDENTIFIER_BYTES))
        } else {
            "responses:unknown".to_string()
        };
        let position = self.tool_call(key, output_index, max_bytes)?;
        if let Some(id) = item_id {
            self.set_identifier(position, IdentifierField::Id, id, max_bytes);
        }
        if let Some(id) = call_id {
            self.set_identifier(position, IdentifierField::CallId, id, max_bytes);
        }
        Some(position)
    }

    fn absorb_responses_item(
        &mut self,
        item: &Value,
        event: &Value,
        max_bytes: usize,
        final_item: bool,
    ) {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                if self.text.is_empty() {
                    if let Some(content) = item.get("content").and_then(Value::as_array) {
                        for part in content {
                            if part.get("type").and_then(Value::as_str) == Some("output_text") {
                                if let Some(text) = part.get("text").and_then(Value::as_str) {
                                    self.append_text(TextField::Text, text, max_bytes);
                                }
                            }
                        }
                    }
                }
            }
            Some("function_call") => {
                let output_index = event.get("output_index").and_then(Value::as_u64);
                let key = output_index
                    .map(|index| format!("responses:index:{index}"))
                    .or_else(|| {
                        item.get("id")
                            .and_then(Value::as_str)
                            .map(|id| format!("responses:id:{}", utf8_prefix(id, 256)))
                    })
                    .unwrap_or_else(|| "responses:unknown".to_string());
                let Some(position) = self.tool_call(key, output_index, max_bytes) else {
                    return;
                };
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    self.set_identifier(position, IdentifierField::Id, id, max_bytes);
                }
                if let Some(id) = item.get("call_id").and_then(Value::as_str) {
                    self.set_identifier(position, IdentifierField::CallId, id, max_bytes);
                }
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    self.set_identifier(position, IdentifierField::Name, name, max_bytes);
                }
                if final_item {
                    if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                        self.replace_arguments(position, arguments, max_bytes);
                    }
                }
            }
            Some("reasoning") if self.reasoning.is_empty() => {
                if let Some(summary) = item.get("summary").and_then(Value::as_array) {
                    for part in summary {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            self.append_text(TextField::Reasoning, text, max_bytes);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn absorb_responses_output_item(&mut self, item: &Value, index: u64, max_bytes: usize) {
        let event = json!({"output_index": index});
        self.absorb_responses_item(item, &event, max_bytes, true);
    }

    fn handle_messages(&mut self, value: &Value, max_bytes: usize) {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "content_block_start" => {
                let block_index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
                let Some(block) = value.get("content_block") else {
                    return;
                };
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            self.append_text(TextField::Text, text, max_bytes);
                        }
                    }
                    Some("thinking") => {
                        if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                            self.append_text(TextField::Reasoning, text, max_bytes);
                        }
                    }
                    Some("tool_use") => {
                        let key = format!("messages:{block_index}");
                        let Some(position) = self.tool_call(key, Some(block_index), max_bytes)
                        else {
                            return;
                        };
                        if let Some(id) = block.get("id").and_then(Value::as_str) {
                            self.set_identifier(position, IdentifierField::Id, id, max_bytes);
                        }
                        if let Some(name) = block.get("name").and_then(Value::as_str) {
                            self.set_identifier(position, IdentifierField::Name, name, max_bytes);
                        }
                        if let Some(input) = block.get("input") {
                            if !input.is_null() && input != &json!({}) {
                                self.replace_arguments(position, &input.to_string(), max_bytes);
                            }
                        }
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let block_index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
                let Some(delta) = value.get("delta").and_then(Value::as_object) else {
                    return;
                };
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            self.append_text(TextField::Text, text, max_bytes);
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            self.append_text(TextField::Reasoning, text, max_bytes);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                            let key = format!("messages:{block_index}");
                            if let Some(position) =
                                self.tool_call(key, Some(block_index), max_bytes)
                            {
                                self.append_arguments(position, partial, max_bytes);
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn handle_gemini(&mut self, value: &Value, max_bytes: usize) {
        let Some(candidates) = value.get("candidates").and_then(Value::as_array) else {
            return;
        };
        for (candidate_position, candidate) in candidates.iter().enumerate() {
            let candidate_index = candidate
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(candidate_position as u64);
            let Some(parts) = candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
            else {
                continue;
            };
            for (part_position, part) in parts.iter().enumerate() {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if part
                        .get("thought")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        self.append_text(TextField::Reasoning, text, max_bytes);
                    } else {
                        self.append_gemini_text(text, max_bytes);
                    }
                }
                if let Some(call) = part.get("functionCall") {
                    let name = call.get("name").and_then(Value::as_str);
                    let key = format!(
                        "gemini:{candidate_index}:{part_position}:{}",
                        utf8_prefix(name.unwrap_or(""), MAX_IDENTIFIER_BYTES)
                    );
                    let Some(position) = self.tool_call(key, Some(part_position as u64), max_bytes)
                    else {
                        continue;
                    };
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        self.set_identifier(position, IdentifierField::Id, id, max_bytes);
                    }
                    if let Some(name) = name {
                        self.set_identifier(position, IdentifierField::Name, name, max_bytes);
                    }
                    if let Some(arguments) = call.get("args") {
                        self.replace_arguments(position, &arguments.to_string(), max_bytes);
                    }
                }
            }
        }
    }

    fn append_gemini_text(&mut self, text: &str, max_bytes: usize) {
        self.append_text(TextField::Text, text, max_bytes);
    }
}

#[derive(Clone, Copy)]
enum TextField {
    Text,
    Reasoning,
}

#[derive(Clone, Copy)]
enum IdentifierField {
    Id,
    CallId,
    Name,
}

/// Incremental capture for either a complete JSON body or an SSE stream.
pub(super) struct ContentCapture {
    stream: bool,
    max_bytes: usize,
    raw: Vec<u8>,
    truncated: bool,
    accumulator: StreamAccumulator,
    sse_line: Vec<u8>,
    sse_data: Vec<u8>,
    discard_line: bool,
    discard_event: bool,
}

impl ContentCapture {
    pub(super) fn new(stream: bool, max_bytes: usize) -> Self {
        Self {
            stream,
            max_bytes,
            raw: Vec::new(),
            truncated: false,
            accumulator: StreamAccumulator::default(),
            sse_line: Vec::new(),
            sse_data: Vec::new(),
            discard_line: false,
            discard_event: false,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) {
        if self.stream {
            self.push_stream(bytes);
            return;
        }
        let available = self.max_bytes.saturating_sub(self.raw.len());
        let take = available.min(bytes.len());
        self.raw.extend_from_slice(&bytes[..take]);
        if take != bytes.len() {
            self.truncated = true;
        }
    }

    pub(super) fn finish(self) -> CapturedContent {
        if self.stream {
            self.finish_stream()
        } else {
            self.finish_nonstream()
        }
    }

    fn finish_nonstream(self) -> CapturedContent {
        if self.truncated {
            return CapturedContent {
                text: neutral_json(self.max_bytes, NONSTREAM_INVALID),
                truncated: true,
                failed: false,
            };
        }
        let value = match serde_json::from_slice::<Value>(&self.raw) {
            Ok(value) => value,
            Err(_) => {
                return CapturedContent {
                    text: neutral_json(self.max_bytes, NONSTREAM_INVALID),
                    truncated: true,
                    failed: false,
                };
            }
        };
        sanitize_body(&value, self.max_bytes)
    }

    fn push_stream(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if byte == b'\n' {
                self.finish_sse_line();
            } else if !self.discard_line {
                if self.sse_line.len() < MAX_SSE_LINE_BYTES {
                    self.sse_line.push(byte);
                } else {
                    self.discard_line = true;
                    self.discard_event = true;
                    self.truncated = true;
                    self.sse_line.clear();
                    self.sse_data.clear();
                }
            }
        }
    }

    fn finish_stream(mut self) -> CapturedContent {
        if self.discard_line {
            self.truncated = true;
            self.sse_line.clear();
        } else if !self.sse_line.is_empty() {
            self.finish_sse_line();
        }
        if !self.sse_data.is_empty() {
            self.dispatch_sse_data();
        }
        self.accumulator.truncated |= self.truncated;
        self.accumulator.truncated |=
            self.accumulator.invalid_event && self.accumulator.protocol.is_some();

        let protocol = self.accumulator.protocol;
        let unavailable = protocol.is_none();
        self.accumulator.sanitize_tool_arguments(self.max_bytes);
        let (mut rendered, render_truncated) = render_stream(
            protocol,
            &self.accumulator.text,
            &self.accumulator.reasoning,
            &self.accumulator.tool_calls,
            unavailable,
            self.max_bytes,
        );
        self.accumulator.truncated |= render_truncated;
        if rendered.is_none() {
            self.accumulator.truncated = true;
            rendered = render_stream(protocol, "", "", &[], unavailable, self.max_bytes).0;
        }
        CapturedContent {
            text: rendered.unwrap_or_else(|| empty_or_notice(self.max_bytes, STREAM_OVERSIZE)),
            truncated: self.accumulator.truncated,
            failed: self.accumulator.failed,
        }
    }

    fn finish_sse_line(&mut self) {
        let mut line = std::mem::take(&mut self.sse_line);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if self.discard_line {
            self.discard_line = false;
            return;
        }
        if line.is_empty() {
            self.dispatch_sse_data();
            return;
        }
        if self.discard_event || line.starts_with(b":") {
            return;
        }
        let Some(mut value) = line.strip_prefix(b"data:") else {
            return;
        };
        if value.first() == Some(&b' ') {
            value = &value[1..];
        }
        let separator = usize::from(!self.sse_data.is_empty());
        let required = separator.saturating_add(value.len());
        if required > MAX_SSE_EVENT_BYTES.saturating_sub(self.sse_data.len()) {
            self.discard_event = true;
            self.truncated = true;
            self.sse_data.clear();
            return;
        }
        if separator == 1 {
            self.sse_data.push(b'\n');
        }
        self.sse_data.extend_from_slice(value);
    }

    fn dispatch_sse_data(&mut self) {
        self.discard_event = false;
        let data = std::mem::take(&mut self.sse_data);
        if !data.is_empty() {
            self.accumulator.handle_event(&data, self.max_bytes);
        }
    }
}

fn render_stream(
    protocol: Option<Protocol>,
    text: &str,
    reasoning: &str,
    calls: &[ToolCall],
    unavailable: bool,
    max_bytes: usize,
) -> (Option<String>, bool) {
    let value = stream_value(protocol, text, reasoning, calls, unavailable);
    let Ok(rendered) = serde_json::to_vec(&value) else {
        return (None, true);
    };
    if rendered.len() <= max_bytes {
        return (String::from_utf8(rendered).ok(), false);
    }
    if max_bytes == 0 {
        return (None, true);
    }
    if max_bytes < 2 {
        return (None, true);
    }
    let empty = stream_value(protocol, "", "", &[], unavailable);
    if serde_json::to_vec(&empty).map_or(true, |bytes| bytes.len() > max_bytes) {
        return (None, true);
    }

    // Keep the structure valid while using the remaining budget for the most
    // valuable field first: text, then reasoning, then tool arguments.
    let mut text = text.to_string();
    let mut reasoning = reasoning.to_string();
    let mut calls = calls.to_vec();
    for field in 0..3 {
        let high = match field {
            0 => text.len(),
            1 => reasoning.len(),
            _ => calls
                .iter()
                .map(|call| call.arguments.len())
                .max()
                .unwrap_or(0),
        };
        let mut low = 0usize;
        let mut high = high;
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            let candidate = match field {
                0 => stream_value(
                    protocol,
                    utf8_prefix(&text, middle),
                    &reasoning,
                    &calls,
                    unavailable,
                ),
                1 => stream_value(
                    protocol,
                    &text,
                    utf8_prefix(&reasoning, middle),
                    &calls,
                    unavailable,
                ),
                _ => {
                    let mut candidate_calls = calls.clone();
                    for call in &mut candidate_calls {
                        call.arguments = utf8_prefix(&call.arguments, middle).to_string();
                    }
                    stream_value(protocol, &text, &reasoning, &candidate_calls, unavailable)
                }
            };
            if serde_json::to_vec(&candidate).is_ok_and(|bytes| bytes.len() <= max_bytes) {
                low = middle;
            } else {
                high = middle.saturating_sub(1);
            }
        }
        match field {
            0 => text = utf8_prefix(&text, low).to_string(),
            1 => reasoning = utf8_prefix(&reasoning, low).to_string(),
            _ => {
                for call in &mut calls {
                    call.arguments = utf8_prefix(&call.arguments, low).to_string();
                }
            }
        }
    }
    let fitted = stream_value(protocol, &text, &reasoning, &calls, unavailable);
    let Ok(bytes) = serde_json::to_vec(&fitted) else {
        return (None, true);
    };
    if bytes.len() > max_bytes {
        return (None, true);
    }
    (String::from_utf8(bytes).ok(), true)
}

fn stream_value(
    protocol: Option<Protocol>,
    text: &str,
    reasoning: &str,
    calls: &[ToolCall],
    unavailable: bool,
) -> Value {
    let mut value = Map::new();
    value.insert(
        "protocol".to_string(),
        json!(protocol.map_or("unknown", Protocol::as_str)),
    );
    value.insert("text".to_string(), json!(text));
    value.insert("reasoning".to_string(), json!(reasoning));
    value.insert(
        "tool_calls".to_string(),
        Value::Array(
            calls
                .iter()
                .map(|call| {
                    let mut item = Map::new();
                    item.insert("type".to_string(), json!("function"));
                    if let Some(index) = call.index {
                        item.insert("index".to_string(), json!(index));
                    }
                    if let Some(id) = &call.id {
                        item.insert("id".to_string(), json!(id));
                    }
                    if let Some(id) = &call.call_id {
                        item.insert("call_id".to_string(), json!(id));
                    }
                    if let Some(name) = &call.name {
                        item.insert("name".to_string(), json!(name));
                    }
                    item.insert("arguments".to_string(), json!(call.arguments));
                    Value::Object(item)
                })
                .collect(),
        ),
    );
    if unavailable {
        value.insert("unavailable".to_string(), json!(true));
    }
    Value::Object(value)
}

fn detect_protocol(value: &Value) -> Option<Protocol> {
    if value.get("choices").and_then(Value::as_array).is_some() {
        return Some(Protocol::Chat);
    }
    if value.get("candidates").and_then(Value::as_array).is_some()
        || value.get("promptFeedback").is_some()
    {
        return Some(Protocol::Gemini);
    }
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    if kind.starts_with("response.") || value.get("response").is_some() {
        return Some(Protocol::Responses);
    }
    if matches!(
        kind,
        "message_start"
            | "message_delta"
            | "message_stop"
            | "content_block_start"
            | "content_block_delta"
            | "content_block_stop"
    ) {
        return Some(Protocol::Messages);
    }
    None
}

fn value_contains_error(value: &Value) -> bool {
    if value.get("error").is_some_and(|error| !error.is_null()) {
        return true;
    }
    if value
        .pointer("/response/error")
        .is_some_and(|error| !error.is_null())
    {
        return true;
    }
    matches!(
        value.get("type").and_then(Value::as_str),
        Some("error" | "response.failed")
    )
}

fn trim_ascii(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(u8::is_ascii_whitespace) {
        value = &value[1..];
    }
    while value.last().is_some_and(u8::is_ascii_whitespace) {
        value = &value[..value.len() - 1];
    }
    value
}

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn empty_or_notice(max_bytes: usize, notice: &str) -> String {
    if max_bytes >= 2 {
        neutral_json(max_bytes, notice)
    } else {
        String::new()
    }
}

fn neutral_json(max_bytes: usize, notice: &str) -> String {
    if max_bytes < 2 {
        return String::new();
    }
    let value = json!({"notice": notice});
    let Ok(rendered) = serde_json::to_string(&value) else {
        return "{}".to_string();
    };
    if rendered.len() <= max_bytes {
        rendered
    } else {
        "{}".to_string()
    }
}

struct JsonSink {
    output: String,
    max_bytes: usize,
    overflow: bool,
}

impl JsonSink {
    fn new(max_bytes: usize) -> Self {
        Self {
            output: String::new(),
            max_bytes,
            overflow: false,
        }
    }

    fn finish(self) -> String {
        self.output
    }

    fn raw(&mut self, value: &str) -> bool {
        if self.overflow {
            return false;
        }
        if value.len() > self.max_bytes.saturating_sub(self.output.len()) {
            self.overflow = true;
            return false;
        }
        self.output.push_str(value);
        true
    }

    fn quoted(&mut self, value: &str) -> bool {
        if !self.raw("\"") {
            return false;
        }
        for character in value.chars() {
            let written = match character {
                '"' => self.raw("\\\""),
                '\\' => self.raw("\\\\"),
                '\u{08}' => self.raw("\\b"),
                '\u{0c}' => self.raw("\\f"),
                '\n' => self.raw("\\n"),
                '\r' => self.raw("\\r"),
                '\t' => self.raw("\\t"),
                '\u{00}'..='\u{1f}' => {
                    let escaped = format!("\\u{:04x}", character as u32);
                    self.raw(&escaped)
                }
                _ => {
                    let mut buffer = [0; 4];
                    self.raw(character.encode_utf8(&mut buffer))
                }
            };
            if !written {
                return false;
            }
        }
        self.raw("\"")
    }

    fn attachment(&mut self, media_type: &str, size: Option<u64>) -> bool {
        if !self.raw("{\"type\":\"") || !self.raw(ATTACHMENT_TYPE) {
            return false;
        }
        if !self.raw("\",\"media_type\":") || !self.quoted(media_type) {
            return false;
        }
        if !self.raw(",\"size_bytes\":") {
            return false;
        }
        (match size {
            Some(size) => self.raw(&size.to_string()),
            None => self.raw("null"),
        }) && self.raw("}")
    }
}

fn write_sanitized(sink: &mut JsonSink, value: &Value, depth: usize) -> Result<(), ()> {
    if sink.overflow {
        return Err(());
    }
    if depth > MAX_DEPTH {
        sink.overflow = true;
        return Err(());
    }
    if let Some((media_type, size)) = attachment_marker(value) {
        return sink.attachment(&media_type, size).then_some(()).ok_or(());
    }
    match value {
        Value::Null => sink.raw("null"),
        Value::Bool(value) => sink.raw(if *value { "true" } else { "false" }),
        Value::Number(value) => sink.raw(&value.to_string()),
        Value::String(value) => sink.quoted(value),
        Value::Array(values) => {
            if !sink.raw("[") {
                return Err(());
            }
            for (index, value) in values.iter().enumerate() {
                if index != 0 && !sink.raw(",") {
                    return Err(());
                }
                write_sanitized(sink, value, depth + 1)?;
            }
            sink.raw("]")
        }
        Value::Object(values) => {
            if !sink.raw("{") {
                return Err(());
            }
            for (index, (key, value)) in values.iter().enumerate() {
                if index != 0 && !sink.raw(",") {
                    return Err(());
                }
                if !sink.quoted(key) || !sink.raw(":") {
                    return Err(());
                }
                write_sanitized(sink, value, depth + 1)?;
            }
            sink.raw("}")
        }
    }
    .then_some(())
    .ok_or(())
}

fn attachment_marker(value: &Value) -> Option<(String, Option<u64>)> {
    let object = value.as_object()?;
    let kind = object.get("type").and_then(Value::as_str).unwrap_or("");

    if let Some(inline) = object
        .get("inlineData")
        .or_else(|| object.get("inline_data"))
    {
        return Some((
            inline_media_type(inline, "application/octet-stream"),
            inline_size(inline),
        ));
    }
    if let Some(file) = object.get("fileData").or_else(|| object.get("file_data")) {
        return Some((
            inline_media_type(file, "application/octet-stream"),
            explicit_size(file),
        ));
    }
    if let Some(source) = object.get("source").and_then(Value::as_object) {
        if is_attachment_source(source) {
            return Some((source_media_type(source, kind), source_size(source)));
        }
    }
    if let Some(image) = object.get("image_url") {
        return Some((image_media_type(image, "image"), inline_size(image)));
    }
    if let Some(audio) = object.get("input_audio").or_else(|| object.get("audio")) {
        return Some((inline_media_type(audio, "audio"), inline_size(audio)));
    }
    if let Some(video) = object.get("video_url") {
        return Some((image_media_type(video, "video"), inline_size(video)));
    }

    let attachment_kind = matches!(
        kind,
        "image_url"
            | "input_image"
            | "input_file"
            | "input_audio"
            | "file"
            | "image"
            | "audio"
            | "video"
            | "document"
    );
    let has_payload = [
        "data",
        "base64",
        "url",
        "file_data",
        "file_url",
        "file_id",
        "fileId",
        "filename",
    ]
    .iter()
    .any(|key| object.contains_key(*key));
    if attachment_kind && (has_payload || matches!(kind, "input_image" | "input_file")) {
        return Some((kind_media_type(kind, object), object_payload_size(object)));
    }
    None
}

fn is_attachment_source(source: &Map<String, Value>) -> bool {
    let kind = source.get("type").and_then(Value::as_str).unwrap_or("");
    matches!(kind, "base64" | "url" | "file")
        && ["data", "url", "file_id", "fileId"]
            .iter()
            .any(|key| source.contains_key(*key))
}

fn kind_media_type(kind: &str, object: &Map<String, Value>) -> String {
    let fallback = match kind {
        "image" | "image_url" | "input_image" => "image",
        "audio" | "input_audio" => "audio",
        "video" => "video",
        "file" | "input_file" | "document" => "application/octet-stream",
        _ => "application/octet-stream",
    };
    object
        .get("media_type")
        .or_else(|| object.get("mimeType"))
        .or_else(|| object.get("mime_type"))
        .and_then(Value::as_str)
        .map(|value| safe_media_type(value, fallback))
        .unwrap_or_else(|| fallback.to_string())
}

fn source_media_type(source: &Map<String, Value>, parent_kind: &str) -> String {
    let fallback = match parent_kind {
        "image" => "image",
        "audio" => "audio",
        "video" => "video",
        "document" => "application/octet-stream",
        _ => "application/octet-stream",
    };
    source
        .get("media_type")
        .or_else(|| source.get("mimeType"))
        .or_else(|| source.get("mime_type"))
        .and_then(Value::as_str)
        .map(|value| safe_media_type(value, fallback))
        .unwrap_or_else(|| fallback.to_string())
}

fn inline_media_type(value: &Value, fallback: &str) -> String {
    value
        .get("mimeType")
        .or_else(|| value.get("mime_type"))
        .or_else(|| value.get("media_type"))
        .and_then(Value::as_str)
        .map(|value| safe_media_type(value, fallback))
        .unwrap_or_else(|| fallback.to_string())
}

fn image_media_type(value: &Value, fallback: &str) -> String {
    if let Some(text) = value.as_str() {
        return data_uri_media_type(text).unwrap_or_else(|| fallback.to_string());
    }
    value
        .get("url")
        .and_then(Value::as_str)
        .and_then(data_uri_media_type)
        .or_else(|| {
            value
                .get("media_type")
                .or_else(|| value.get("mimeType"))
                .and_then(Value::as_str)
                .map(|value| safe_media_type(value, fallback))
        })
        .unwrap_or_else(|| fallback.to_string())
}

fn safe_media_type(value: &str, fallback: &str) -> String {
    if value.len() <= 128
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/+-.;=_.*".contains(&byte))
    {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

fn data_uri_media_type(value: &str) -> Option<String> {
    let rest = value.strip_prefix("data:")?;
    let end = rest.find([';', ','])?;
    let media_type = &rest[..end];
    (!media_type.is_empty()).then(|| safe_media_type(media_type, "application/octet-stream"))
}

fn explicit_size(value: &Value) -> Option<u64> {
    explicit_object_size(value.as_object()?)
}

fn explicit_object_size(value: &Map<String, Value>) -> Option<u64> {
    value
        .get("size_bytes")
        .or_else(|| value.get("sizeBytes"))
        .or_else(|| value.get("fileSize"))
        .or_else(|| value.get("size"))
        .and_then(Value::as_u64)
}

fn inline_size(value: &Value) -> Option<u64> {
    if let Some(text) = value.as_str() {
        return data_uri_payload_size(text);
    }
    explicit_size(value).or_else(|| {
        value
            .get("data")
            .or_else(|| value.get("base64"))
            .and_then(Value::as_str)
            .map(payload_size)
            .or_else(|| {
                value
                    .get("url")
                    .and_then(Value::as_str)
                    .and_then(data_uri_payload_size)
            })
    })
}

fn source_size(source: &Map<String, Value>) -> Option<u64> {
    explicit_object_size(source)
        .or_else(|| source.get("data").and_then(Value::as_str).map(payload_size))
}

fn object_payload_size(object: &Map<String, Value>) -> Option<u64> {
    explicit_object_size(object).or_else(|| {
        ["data", "base64"]
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_str).map(payload_size))
            .or_else(|| {
                ["url", "file_url", "file_data"].iter().find_map(|key| {
                    object
                        .get(*key)
                        .and_then(Value::as_str)
                        .and_then(data_uri_payload_size)
                })
            })
    })
}

fn data_uri_payload_size(value: &str) -> Option<u64> {
    value.starts_with("data:").then(|| payload_size(value))
}

fn sanitize_argument(value: &str, max_bytes: usize) -> Option<(String, bool)> {
    if max_bytes == 0 {
        return Some((String::new(), !value.is_empty()));
    }
    let parsed = serde_json::from_str::<Value>(value).ok()?;
    let mut sink = JsonSink::new(max_bytes);
    write_sanitized(&mut sink, &parsed, 0).ok()?;
    Some((sink.finish(), false))
}

fn payload_size(value: &str) -> u64 {
    let payload = value
        .find(',')
        .filter(|_| value.starts_with("data:"))
        .map_or(value, |comma| &value[comma + 1..]);
    let mut characters = 0u64;
    let mut padding = 0u64;
    for byte in payload.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        characters = characters.saturating_add(1);
        if byte == b'=' {
            padding = padding.saturating_add(1);
        }
    }
    if characters == 0 {
        return 0;
    }
    characters
        .saturating_add(3)
        .saturating_div(4)
        .saturating_mul(3)
        .saturating_sub(padding)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_output(captured: &CapturedContent) -> Value {
        serde_json::from_str(&captured.text)
            .unwrap_or_else(|error| panic!("capture is not JSON: {error}"))
    }

    fn feed(capture: &mut ContentCapture, chunks: &[&[u8]]) {
        for chunk in chunks {
            capture.push(chunk);
        }
    }

    #[test]
    fn request_sanitization_strips_standard_attachments() {
        let body = json!({
            "messages": [
                {"role": "system", "content": "keep system"},
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {
                        "url": "data:image/png;base64,AAAA", "detail": "high"
                    }}
                ]}
            ],
            "input": [
                {"type": "input_image", "image_url": "data:image/jpeg;base64,AAAA", "file_id": "file-secret"}
            ],
            "content": [
                {"type": "image", "source": {
                    "type": "base64", "media_type": "image/webp", "data": "AAAA"
                }},
                {"type": "document", "source": {
                    "type": "url", "url": "https://private.example/report.pdf"
                }, "title": "secret.pdf"}
            ],
            "parts": [
                {"inlineData": {"mimeType": "image/gif", "data": "AAAA"}},
                {"fileData": {"mimeType": "application/pdf", "fileUri": "gs://private/report.pdf"}}
            ],
            "tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object"}}],
            "tool_result": {"role": "tool", "content": "tool output stays"}
        });
        let captured = sanitize_body(&body, 32 * 1024);
        assert!(!captured.truncated);
        let text = &captured.text;
        for secret in [
            "base64,AAAA",
            "file-secret",
            "private.example",
            "gs://private",
            "secret.pdf",
        ] {
            assert!(!text.contains(secret), "leaked {secret}: {text}");
        }
        assert!(text.contains("image/png"));
        assert!(text.contains("image/jpeg"));
        assert!(text.contains("image/webp"));
        assert!(text.contains("image/gif"));
        assert!(text.contains("application/pdf"));
        assert!(text.contains("keep system"));
        assert!(text.contains("tool output stays"));
        assert!(text.contains("\"name\":\"lookup\""));
        let output = json_output(&captured);
        assert_eq!(output["messages"][1]["content"][0]["type"], "attachment");
        assert_eq!(output["messages"][1]["content"][0]["size_bytes"], 3);
    }

    #[test]
    fn nonstream_rejects_invalid_and_truncated_json() {
        let mut invalid = ContentCapture::new(false, 4096);
        invalid.push(br#"{"messages":[{"content":"secret"}"#);
        let invalid = invalid.finish();
        assert!(invalid.truncated);
        assert!(!invalid.text.contains("secret"));

        let mut oversized = ContentCapture::new(false, 8);
        oversized.push(br#"{"messages":"secret"}"#);
        let oversized = oversized.finish();
        assert!(oversized.truncated);
        assert!(!oversized.text.contains("secret"));
        assert!(oversized.text.len() <= 8);
        assert!(serde_json::from_str::<Value>(&oversized.text).is_ok());
    }

    #[test]
    fn chat_stream_merges_split_utf8_crlf_multiline_and_tools() {
        let event =
            json!({"choices":[{"index":0,"delta":{"content":"你","reasoning_content":"想"}}]});
        let first = serde_json::to_string_pretty(&event)
            .unwrap()
            .lines()
            .map(|line| format!("data: {line}\r\n"))
            .collect::<String>()
            + "\r\n";
        let mut bytes = first.into_bytes();
        // Force the first Chinese character to span push boundaries.
        let split = bytes
            .windows(3)
            .position(|window| window == "你".as_bytes())
            .unwrap()
            + 1;
        let second = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"好\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":\"}}]}}]}\r\n\r\n".as_bytes();
        let third = b"data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"1}\"}}]}}]}\r\n\r\n";
        let tail = bytes.split_off(split);
        let mut capture = ContentCapture::new(true, 4096);
        feed(
            &mut capture,
            &[&bytes, &tail, second, third, b"data: [DONE]\r\n\r\n"],
        );
        let captured = capture.finish();
        assert!(!captured.truncated);
        let output = json_output(&captured);
        assert_eq!(output["protocol"], "chat");
        assert_eq!(output["text"], "你好");
        assert_eq!(output["reasoning"], "想");
        assert_eq!(output["tool_calls"][0]["id"], "call_1");
        assert_eq!(output["tool_calls"][0]["name"], "lookup");
        assert_eq!(output["tool_calls"][0]["arguments"], "{\"q\":1}");
    }

    #[test]
    fn responses_stream_does_not_duplicate_completed_content() {
        let mut capture = ContentCapture::new(true, 16 * 1024);
        feed(
            &mut capture,
            &[
                b"event: response.output_item.added\n",
                b"data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"id\":\"item_1\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n",
                b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\n",
                b"data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{\\\"q\\\":\"}\n\n",
                b"data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"1}\"}\n\n",
                b"data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":1,\"arguments\":\"{\\\"q\\\":1}\"}\n\n",
                b"data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello\"}]},{\"type\":\"function_call\",\"id\":\"item_1\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"{\\\"q\\\":1}\"}]}}\n\n",
            ],
        );
        let captured = capture.finish();
        let output = json_output(&captured);
        assert_eq!(output["protocol"], "responses");
        assert_eq!(output["text"], "Hello");
        assert_eq!(output["tool_calls"][0]["call_id"], "call_1");
        assert_eq!(output["tool_calls"][0]["arguments"], "{\"q\":1}");
        assert_eq!(output["text"].as_str().unwrap().matches("Hello").count(), 1);
    }

    #[test]
    fn tool_arguments_are_sanitized_recursively() {
        let arguments = json!({"image":{"image_url":"data:image/png;base64,AAAA"}}).to_string();
        let cases = [
            (
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{
                    "name":"f","arguments":arguments
                }}]}}]}),
                "/image/type",
            ),
            (
                json!({"type":"response.output_item.done","output_index":0,"item":{
                    "type":"function_call","id":"t","name":"f","arguments":arguments
                }}),
                "/image/type",
            ),
            (
                json!({"type":"content_block_start","index":0,"content_block":{
                    "type":"tool_use","id":"t","name":"g","input":{
                        "source":{"type":"base64","media_type":"image/jpeg","data":"BBBB"}
                    }
                }}),
                "/type",
            ),
            (
                json!({"candidates":[{"content":{"parts":[{"functionCall":{
                    "name":"h","args":{"inlineData":{"mimeType":"image/gif","data":"CCCC"}}
                }}]}}]}),
                "/type",
            ),
        ];
        for (event, marker) in cases {
            let mut capture = ContentCapture::new(true, 8192);
            capture.push(format!("data: {event}\n\n").as_bytes());
            let captured = capture.finish();
            for payload in ["AAAA", "BBBB", "CCCC"] {
                assert!(!captured.text.contains(payload));
            }
            let output = json_output(&captured);
            assert_eq!(output["tool_calls"].as_array().unwrap().len(), 1);
            let arguments: Value =
                serde_json::from_str(output["tool_calls"][0]["arguments"].as_str().unwrap())
                    .unwrap();
            assert_eq!(arguments.pointer(marker), Some(&json!("attachment")));
        }
    }

    #[test]
    fn incomplete_tool_arguments_never_reveal_attachment_fragments() {
        let mut capture = ContentCapture::new(true, 4096);
        let event = json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{
            "name":"f","arguments":"{\"image_url\":\"data:image/png;base64,attachment-fragment"
        }}]}}]});
        capture.push(format!("data: {event}\n\n").as_bytes());
        let captured = capture.finish();
        assert!(captured.truncated);
        assert!(!captured.text.contains("attachment-fragment"));
        assert_eq!(json_output(&captured)["tool_calls"][0]["arguments"], "");
    }

    #[test]
    fn messages_stream_merges_blocks_and_keeps_late_error_after_capacity() {
        let mut capture = ContentCapture::new(true, 180);
        let long_text = "你好，世界你好，世界你好，世界你好，世界你好，世界你好，世界你好，世界";
        let long_event = format!(
            "data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{long_text}\"}}}}\r\n\r\n"
        );
        feed(
            &mut capture,
            &[
                b"event: content_block_start\r\n",
                b"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\r\n\r\n",
                long_event.as_bytes(),
                b"data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"lookup\",\"input\":{}}}\r\n\r\n",
                b"data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"reason\"}}\r\n\r\n",
                b"data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"q\\\":1}\"}}\r\n\r\n",
                b"event: error\r\n",
                b"data: {\"type\":\"error\",\"error\":{\"message\":\"do not retain this\"}}\r\n\r\n",
            ],
        );
        let captured = capture.finish();
        assert!(captured.failed);
        assert!(captured.truncated);
        let output = json_output(&captured);
        assert_eq!(output["protocol"], "messages");
        assert!(output["text"].as_str().unwrap().starts_with("你好"));
        assert_eq!(output["tool_calls"][0]["id"], "toolu_1");
        assert!(!captured.text.contains("do not retain this"));
        assert!(captured.text.len() <= 180);
        assert!(captured.text.is_char_boundary(captured.text.len()));
    }

    #[test]
    fn gemini_stream_merges_parts_and_function_calls() {
        let mut capture = ContentCapture::new(true, 4096);
        feed(
            &mut capture,
            &[
                b"data: {\"candidates\":[{\"index\":0,\"content\":{\"parts\":[{\"text\":\"Hello\"}]}}]}\r\n\r\n",
                b"data: {\"candidates\":[{\"index\":0,\"content\":{\"parts\":[{\"text\":\" world\"},{\"thought\":true,\"text\":\"think\"}]}}]}\r\n\r\n",
                b"data: {\"candidates\":[{\"index\":0,\"content\":{\"parts\":[{\"functionCall\":{\"id\":\"fc_1\",\"name\":\"lookup\",\"args\":{\"q\":\"x\"}}}]},\"finishReason\":\"STOP\"}]}\r\n\r\n",
            ],
        );
        let captured = capture.finish();
        let output = json_output(&captured);
        assert_eq!(output["protocol"], "gemini");
        assert_eq!(output["text"], "Hello world");
        assert_eq!(output["reasoning"], "think");
        assert_eq!(output["tool_calls"][0]["id"], "fc_1");
        assert_eq!(output["tool_calls"][0]["name"], "lookup");
        assert_eq!(output["tool_calls"][0]["arguments"], "{\"q\":\"x\"}");
    }

    #[test]
    fn gemini_keeps_repeated_and_prefix_matching_text_deltas() {
        let mut capture = ContentCapture::new(true, 4096);
        for text in ["a", "a", "aab"] {
            let event = json!({"candidates":[{"content":{"parts":[{"text":text}]}}]});
            capture.push(format!("data: {event}\n\n").as_bytes());
        }
        assert_eq!(json_output(&capture.finish())["text"], "aaaab");
    }

    #[test]
    fn unknown_stream_shape_is_not_returned_as_raw_sse() {
        let mut capture = ContentCapture::new(true, 4096);
        capture.push(b"data: {\"opaque\":\"raw-event-secret\"}\n\n");
        let captured = capture.finish();
        let output = json_output(&captured);
        assert_eq!(output["protocol"], "unknown");
        assert_eq!(output["unavailable"], true);
        assert!(!captured.text.contains("raw-event-secret"));
    }

    #[test]
    fn capacity_keeps_valid_utf8_and_json() {
        let mut capture = ContentCapture::new(true, 48);
        capture.push(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好世界你好世界你好世界\"}}]}\n\n"
                .as_bytes(),
        );
        let captured = capture.finish();
        assert!(captured.truncated);
        assert!(captured.text.len() <= 48);
        assert!(std::str::from_utf8(captured.text.as_bytes()).is_ok());
        assert!(serde_json::from_str::<Value>(&captured.text).is_ok());
    }

    #[test]
    fn tiny_capacity_always_returns_valid_bounded_output() {
        for limit in [0, 1, 2, 12, 40] {
            let mut capture = ContentCapture::new(true, limit);
            capture.push(b"data: {\"unknown\":\"secret\"}\n\n");
            let captured = capture.finish();
            assert!(captured.text.len() <= limit);
            if limit < 2 {
                assert!(captured.text.is_empty());
            } else {
                assert!(serde_json::from_str::<Value>(&captured.text).is_ok());
            }
        }
        let captured = sanitize_body(&json!({"value": "secret"}), 2);
        assert_eq!(captured.text, "{}");
        assert!(captured.text.len() <= 2);
    }
}
