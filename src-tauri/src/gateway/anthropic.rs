//! Anthropic Messages (`/v1/messages`) for Claude Code and similar Agents
//! (T10.289). An Anthropic-protocol provider gets the request untouched, so
//! `cache_control` and other fields survive; a Chat Completions provider gets
//! it rewritten to Chat, and the reply (whole or streamed) is rewritten back
//! to Messages. Unsupported semantic features require a native Anthropic provider.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::convert::{supported_fields, ChatStream};
use super::ledger::Usage;

pub const DEFAULT_VERSION: &str = "2023-06-01";
/// Client headers passed on to an Anthropic-protocol provider.
pub const FORWARDED_HEADERS: [&str; 2] = ["anthropic-version", "anthropic-beta"];
const IMAGE_TOKENS: u64 = 1_600;
const MAX_ESTIMATE_DEPTH: usize = 64;

/// Accepts both styles users copy from vendor docs: `https://host/anthropic`
/// (what `ANTHROPIC_BASE_URL` takes) and `https://host/v1`.
pub fn messages_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn kind(block: &Value) -> &str {
    block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn text_of(content: &Value, separator: &str) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| kind(block) == "text")
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(separator),
        _ => String::new(),
    }
}

fn image_url(block: &Value) -> Option<String> {
    let source = block.get("source")?;
    match source.get("type").and_then(Value::as_str)? {
        "base64" => Some(format!(
            "data:{};base64,{}",
            source.get("media_type")?.as_str()?,
            source.get("data")?.as_str()?
        )),
        "url" => source
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

/// Validation ensures Chat tool messages carry text only.
fn tool_result_text(block: &Value) -> String {
    let text = match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match kind(part) {
                "text" => part.get("text").and_then(Value::as_str).map(str::to_string),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    if block.get("is_error").and_then(Value::as_bool) == Some(true) {
        format!("[tool error] {text}")
    } else {
        text
    }
}

/// Tool results become `tool` messages ahead of the user's own text, since
/// Chat wants them right after the assistant message that asked for them.
fn push_user(content: &Value, messages: &mut Vec<Value>) {
    let blocks = match content {
        Value::String(text) => {
            messages.push(json!({"role": "user", "content": text}));
            return;
        }
        Value::Array(blocks) => blocks,
        _ => return,
    };
    let mut parts = Vec::new();
    let mut has_image = false;
    for block in blocks {
        match kind(block) {
            "tool_result" => messages.push(json!({
                "role": "tool",
                "tool_call_id": block.get("tool_use_id").cloned().unwrap_or_default(),
                "content": tool_result_text(block),
            })),
            "text" => parts.push(
                json!({"type": "text", "text": block.get("text").cloned().unwrap_or_default()}),
            ),
            "image" => {
                if let Some(url) = image_url(block) {
                    has_image = true;
                    parts.push(json!({"type": "image_url", "image_url": {"url": url}}));
                }
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        return;
    }
    let content = if has_image {
        Value::Array(parts)
    } else {
        Value::String(
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    };
    messages.push(json!({"role": "user", "content": content}));
}

/// Validation rejects signed thinking blocks that Chat cannot preserve.
fn push_assistant(content: &Value, messages: &mut Vec<Value>) {
    let text = text_of(content, "");
    let calls: Vec<Value> = match content {
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| kind(block) == "tool_use")
            .map(|block| {
                json!({"id": block.get("id").cloned().unwrap_or_default(), "type": "function", "function": {
                    "name": block.get("name").cloned().unwrap_or_default(),
                    "arguments": block.get("input").cloned().unwrap_or_else(|| json!({})).to_string(),
                }})
            })
            .collect(),
        _ => Vec::new(),
    };
    if text.is_empty() && calls.is_empty() {
        return;
    }
    let mut message = json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { Value::String(text) }});
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }
    messages.push(message);
}

/// Validation admits only client-side tools with an input schema.
fn convert_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name").and_then(Value::as_str)?;
            let schema = tool.get("input_schema")?;
            let mut function = json!({"name": name, "parameters": schema});
            if let Some(description) = tool.get("description") {
                function["description"] = description.clone();
            }
            Some(json!({"type": "function", "function": function}))
        })
        .collect()
}

fn validate_messages(request: &Value) -> Result<(), String> {
    let object = request.as_object().ok_or("Messages 请求必须是对象。")?;
    for key in object.keys() {
        if ![
            "model",
            "messages",
            "system",
            "tools",
            "tool_choice",
            "max_tokens",
            "temperature",
            "top_p",
            "stop_sequences",
            "stream",
            "metadata",
        ]
        .contains(&key.as_str())
        {
            return Err(format!(
                "Chat 转换不支持 Anthropic 字段「{key}」，请选择原生 Anthropic 供应商。"
            ));
        }
    }
    fn blocks(content: &Value, role: &str) -> Result<(), String> {
        if content.is_string() {
            return Ok(());
        }
        let parts = content
            .as_array()
            .ok_or("Messages 内容必须是字符串或内容块数组。")?;
        for block in parts {
            if block.get("cache_control").is_some() {
                return Err(
                    "Chat 转换不能保留 cache_control，请选择原生 Anthropic 供应商。".into(),
                );
            }
            match kind(block) {
                "text" if block.get("text").is_some_and(Value::is_string) => {
                    supported_fields(block, &["type", "text", "citations", "id", "status"], "Anthropic 文本块")?;
                    if block.get("citations").is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty)) {
                        return Err("Chat 转换不能保留文本 citations，请选择原生 Anthropic 供应商。".into());
                    }
                },
                "image" if role == "user" && image_url(block).is_some() => {
                    supported_fields(block, &["type", "source", "id", "status"], "Anthropic 图片块")?;
                    let source = &block["source"];
                    let fields = if source["type"] == "base64" { &["type", "media_type", "data"][..] }
                        else { &["type", "url"][..] };
                    supported_fields(source, fields, "Anthropic 图片 source")?;
                },
                "tool_use" if role == "assistant" && block.get("id").is_some_and(Value::is_string)
                    && block.get("name").is_some_and(Value::is_string) && block.get("input").is_some_and(Value::is_object) => {
                        supported_fields(block, &["type", "id", "name", "input", "status"], "Anthropic 工具调用")?;
                    },
                "tool_result" if role == "user" && block.get("tool_use_id").is_some_and(Value::is_string) => {
                    supported_fields(block, &["type", "tool_use_id", "content", "is_error", "id", "status"], "Anthropic 工具结果")?;
                    if block.get("is_error").is_some_and(|v| !v.is_boolean()) {return Err("tool_result is_error 必须是布尔值。".into());}
                    if let Some(content) = block.get("content") { blocks(content, "tool")?; }
                },
                unsupported => return Err(format!("Chat 转换不支持或无法解析 Anthropic 内容块「{unsupported}」，请选择原生 Anthropic 供应商。")),
            }
        }
        Ok(())
    }
    if let Some(system) = request.get("system") {
        blocks(system, "system")?;
    }
    for item in request
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("请求缺少 messages 数组。")?
    {
        supported_fields(
            item,
            &["role", "content", "id", "status"],
            "Anthropic 消息项",
        )?;
        let role = item
            .get("role")
            .and_then(Value::as_str)
            .ok_or("消息缺少 role。")?;
        if !["user", "assistant"].contains(&role) {
            return Err("Messages role 不受支持。".into());
        }
        blocks(item.get("content").ok_or("消息缺少 content。")?, role)?;
    }
    let mut names = std::collections::HashSet::new();
    if let Some(tools) = request.get("tools") {
        for tool in tools.as_array().ok_or("tools 必须是数组。")? {
            supported_fields(
                tool,
                &[
                    "type",
                    "name",
                    "input_schema",
                    "description",
                    "cache_control",
                ],
                "Anthropic 工具定义",
            )?;
            if tool.get("description").is_some_and(|v| !v.is_string()) {
                return Err("工具 description 必须是字符串。".into());
            }
            if !tool.get("input_schema").is_some_and(Value::is_object)
                || tool.get("type").is_some_and(|v| v != "custom")
            {
                return Err(
                    "Chat 转换不支持 Anthropic 服务端工具或无 input_schema 的工具。".into(),
                );
            }
            if tool.get("cache_control").is_some() {
                return Err("Chat 转换不能保留工具 cache_control。".into());
            }
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("工具缺少 name。")?;
            names.insert(name);
        }
    }
    if let Some(choice) = request.get("tool_choice") {
        let fields = if kind(choice) == "tool" {
            &["type", "name", "disable_parallel_tool_use"][..]
        } else {
            &["type", "disable_parallel_tool_use"][..]
        };
        supported_fields(choice, fields, "Anthropic tool_choice")?;
        if choice
            .get("disable_parallel_tool_use")
            .is_some_and(|v| !v.is_boolean())
        {
            return Err("disable_parallel_tool_use 必须是布尔值。".into());
        }
        match kind(choice) {
            "auto" | "any" | "none" => {}
            "tool"
                if choice
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| names.contains(name)) => {}
            _ => return Err("Chat 转换不支持 tool_choice 或其工具不存在。".into()),
        }
        if names.is_empty() && kind(choice) != "none" {
            return Err("tool_choice 要求至少一个工具。".into());
        }
    }
    Ok(())
}

pub fn messages_to_chat(
    request: &Value,
    upstream_model: &str,
    stream: bool,
) -> Result<Value, String> {
    validate_messages(request)?;
    let Some(Value::Array(items)) = request.get("messages") else {
        return Err("请求缺少 messages。".to_string());
    };
    let mut messages = Vec::new();
    if let Some(system) = request.get("system") {
        let text = text_of(system, "\n\n");
        if !text.is_empty() {
            messages.push(json!({"role": "system", "content": text}));
        }
    }
    for item in items {
        let content = item.get("content").unwrap_or(&Value::Null);
        match item.get("role").and_then(Value::as_str) {
            Some("assistant") => push_assistant(content, &mut messages),
            _ => push_user(content, &mut messages),
        }
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(upstream_model));
    body.insert("messages".into(), Value::Array(messages));
    if let Some(Value::Array(tools)) = request.get("tools") {
        let tools = convert_tools(tools);
        let choice = request.get("tool_choice");
        let choice_kind = choice.map(kind).unwrap_or_default();
        if !tools.is_empty() {
            body.insert("tools".into(), Value::Array(tools));
            match choice_kind {
                "any" => {
                    body.insert("tool_choice".into(), json!("required"));
                }
                "none" => {
                    body.insert("tool_choice".into(), json!("none"));
                }
                "tool" => {
                    if let Some(name) = choice.and_then(|choice| choice.get("name")) {
                        body.insert(
                            "tool_choice".into(),
                            json!({"type": "function", "function": {"name": name}}),
                        );
                    }
                }
                _ => {}
            }
            if choice
                .and_then(|choice| choice.get("disable_parallel_tool_use"))
                .and_then(Value::as_bool)
                == Some(true)
            {
                body.insert("parallel_tool_calls".into(), json!(false));
            }
        }
    }
    for key in ["max_tokens", "temperature", "top_p"] {
        if let Some(value) = request.get(key) {
            body.insert(key.into(), value.clone());
        }
    }
    if let Some(stop) = request
        .get("stop_sequences")
        .filter(|stop| stop.as_array().is_some_and(|items| !items.is_empty()))
    {
        body.insert("stop".into(), stop.clone());
    }
    if stream {
        body.insert("stream".into(), json!(true));
        body.insert("stream_options".into(), json!({"include_usage": true}));
    }
    Ok(Value::Object(body))
}

fn usage_json(usage: Usage) -> Value {
    json!({
        "input_tokens": usage.input,
        "output_tokens": usage.output,
        "cache_read_input_tokens": usage.cache_read,
        "cache_creation_input_tokens": usage.cache_write,
    })
}

fn stop_reason(finish_reason: Option<&str>, has_tools: bool) -> &'static str {
    match finish_reason {
        Some("length") => "max_tokens",
        Some("tool_calls") | Some("function_call") => "tool_use",
        Some("content_filter") => "refusal",
        _ if has_tools => "tool_use",
        _ => "end_turn",
    }
}

/// `tool_use.input` must be an object; unparsable arguments become `{}`.
fn tool_input(arguments: &str) -> Value {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn tool_id(id: &str, message_id: &str, index: usize) -> String {
    if id.is_empty() {
        format!("toolu_{message_id}_{index}")
    } else {
        id.to_string()
    }
}

fn thinking_block(text: &str) -> Value {
    json!({"type": "thinking", "thinking": text, "signature": ""})
}

pub fn chat_to_message(chat: &Value, message_id: &str, model: &str) -> Value {
    let choice = chat.pointer("/choices/0").cloned().unwrap_or_default();
    let message = choice.get("message").cloned().unwrap_or_default();
    let mut content = Vec::new();
    if let Some(reasoning) = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        content.push(thinking_block(reasoning));
    }
    let text = text_of(message.get("content").unwrap_or(&Value::Null), "");
    if !text.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    let mut has_tools = false;
    if let Some(Value::Array(calls)) = message.get("tool_calls") {
        for (index, call) in calls.iter().enumerate() {
            has_tools = true;
            let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
            content.push(json!({
                "type": "tool_use",
                "id": tool_id(id, message_id, index),
                "name": call.pointer("/function/name").cloned().unwrap_or_default(),
                "input": tool_input(call.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("{}")),
            }));
        }
    }
    let usage = chat
        .get("usage")
        .and_then(Usage::from_chat)
        .unwrap_or_default();
    json!({
        "id": message_id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason(choice.get("finish_reason").and_then(Value::as_str), has_tools),
        "stop_sequence": null,
        "usage": usage_json(usage),
    })
}

pub fn error_event(message: &str) -> String {
    let payload = json!({"type": "error", "error": {"type": "api_error", "message": message}});
    format!("event: error\ndata: {payload}\n\n")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Open {
    Thinking,
    Text,
}

#[derive(Default)]
struct PendingTool {
    id: String,
    name: String,
    arguments: String,
}

/// Chat chunks → Messages events. Text and thinking stream as they arrive;
/// tool calls are buffered and sent whole at the end, because Chat may
/// interleave several calls while Messages blocks must not overlap.
pub struct MessageStream {
    message_id: String,
    model: String,
    next_index: usize,
    open: Option<(Open, usize)>,
    tools: BTreeMap<u64, PendingTool>,
    finish_reason: Option<String>,
    chat_usage: Option<Value>,
}

impl MessageStream {
    pub fn new(message_id: &str, model: &str) -> Self {
        Self {
            message_id: message_id.to_string(),
            model: model.to_string(),
            next_index: 0,
            open: None,
            tools: BTreeMap::new(),
            finish_reason: None,
            chat_usage: None,
        }
    }

    fn event(kind: &str, mut payload: Value, out: &mut Vec<String>) {
        payload["type"] = json!(kind);
        out.push(format!("event: {kind}\ndata: {payload}\n\n"));
    }

    fn close(&mut self, out: &mut Vec<String>) {
        if let Some((_, index)) = self.open.take() {
            Self::event("content_block_stop", json!({"index": index}), out);
        }
    }

    fn open_block(&mut self, open: Open, block: Value, out: &mut Vec<String>) -> usize {
        if let Some((current, index)) = self.open {
            if current == open {
                return index;
            }
        }
        self.close(out);
        let index = self.next_index;
        self.next_index += 1;
        Self::event(
            "content_block_start",
            json!({"index": index, "content_block": block}),
            out,
        );
        self.open = Some((open, index));
        index
    }
}

impl ChatStream for MessageStream {
    fn start(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        Self::event(
            "message_start",
            json!({"message": {
                "id": self.message_id, "type": "message", "role": "assistant", "model": self.model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            }}),
            &mut out,
        );
        out
    }

    fn push_chunk(&mut self, chunk: &Value) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
            self.chat_usage = Some(usage.clone());
        }
        let Some(choice) = chunk.pointer("/choices/0") else {
            return out;
        };
        let delta = choice.get("delta").cloned().unwrap_or_default();
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let index = self.open_block(Open::Thinking, thinking_block(""), &mut out);
            Self::event(
                "content_block_delta",
                json!({"index": index, "delta": {"type": "thinking_delta", "thinking": reasoning}}),
                &mut out,
            );
        }
        if let Some(text) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            let index = self.open_block(Open::Text, json!({"type": "text", "text": ""}), &mut out);
            Self::event(
                "content_block_delta",
                json!({"index": index, "delta": {"type": "text_delta", "text": text}}),
                &mut out,
            );
        }
        if let Some(Value::Array(calls)) = delta.get("tool_calls") {
            for call in calls {
                let key = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                let tool = self.tools.entry(key).or_default();
                if let Some(id) = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    tool.id = id.to_string();
                }
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    tool.name.push_str(name);
                }
                if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str)
                {
                    tool.arguments.push_str(arguments);
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        out
    }

    fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        self.close(&mut out);
        let tools = std::mem::take(&mut self.tools);
        let has_tools = !tools.is_empty();
        for (position, tool) in tools.into_values().enumerate() {
            let index = self.next_index;
            self.next_index += 1;
            Self::event(
                "content_block_start",
                json!({"index": index, "content_block": {
                    "type": "tool_use", "id": tool_id(&tool.id, &self.message_id, position),
                    "name": tool.name, "input": {},
                }}),
                &mut out,
            );
            Self::event(
                "content_block_delta",
                json!({"index": index, "delta": {"type": "input_json_delta", "partial_json": tool_input(&tool.arguments).to_string()}}),
                &mut out,
            );
            Self::event("content_block_stop", json!({"index": index}), &mut out);
        }
        Self::event(
            "message_delta",
            json!({
                "delta": {"stop_reason": stop_reason(self.finish_reason.as_deref(), has_tools), "stop_sequence": null},
                "usage": usage_json(self.usage().unwrap_or_default()),
            }),
            &mut out,
        );
        Self::event("message_stop", json!({}), &mut out);
        out
    }

    fn fail(&mut self, message: &str) -> Vec<String> {
        vec![error_event(message)]
    }

    fn usage(&self) -> Option<Usage> {
        self.chat_usage.as_ref().and_then(Usage::from_chat)
    }
}

#[derive(Default)]
struct Estimate {
    ascii: u64,
    other: u64,
    fixed: u64,
}

fn walk(value: &Value, depth: usize, out: &mut Estimate) {
    if depth > MAX_ESTIMATE_DEPTH {
        return;
    }
    match value {
        Value::String(text) => {
            for c in text.chars() {
                if c.is_ascii() {
                    out.ascii += 1;
                } else {
                    out.other += 1;
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| walk(item, depth + 1, out)),
        Value::Object(map) => {
            if matches!(kind(value), "image" | "document") {
                out.fixed += IMAGE_TOKENS;
                return;
            }
            for (key, item) in map {
                if matches!(
                    key.as_str(),
                    "type" | "cache_control" | "id" | "tool_use_id" | "signature"
                ) {
                    continue;
                }
                out.ascii += key.len() as u64;
                walk(item, depth + 1, out);
            }
        }
        _ => {}
    }
}

/// Rough local count for `/v1/messages/count_tokens`: about four ASCII
/// characters or one CJK character per token, a flat cost per image. Claude
/// Code only uses it for context hints, and compatible endpoints often lack
/// the API, so nothing is sent upstream.
pub fn estimate_input_tokens(request: &Value) -> u64 {
    let mut estimate = Estimate::default();
    for key in ["system", "messages", "tools"] {
        if let Some(value) = request.get(key) {
            walk(value, 0, &mut estimate);
        }
    }
    (estimate.ascii.div_ceil(4) + estimate.other + estimate.fixed).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[String]) -> Vec<(String, Value)> {
        chunks
            .iter()
            .map(|chunk| {
                let mut lines = chunk.lines();
                let name = lines
                    .next()
                    .unwrap()
                    .strip_prefix("event: ")
                    .unwrap()
                    .to_string();
                let data = lines.next().unwrap().strip_prefix("data: ").unwrap();
                (name, serde_json::from_str(data).unwrap())
            })
            .collect()
    }

    #[test]
    fn messages_url_accepts_both_base_styles() {
        assert_eq!(
            messages_url("https://api.deepseek.com/anthropic"),
            "https://api.deepseek.com/anthropic/v1/messages"
        );
        assert_eq!(
            messages_url("https://api.anthropic.com/v1/"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn request_maps_system_blocks_tools_and_results() {
        let request = json!({
            "model": "deepseek/deepseek-chat",
            "max_tokens": 1024,
            "system": [
                {"type": "text", "text": "You are Claude Code."},
                {"type": "text", "text": "Be brief."}
            ],
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AA"}}
                ]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "running"},
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": [{"type": "text", "text": "a.txt"}]},
                    {"type": "text", "text": "next"}
                ]},
                {"role": "user", "content": "plain"}
            ],
            "tools": [
                {"name": "Bash", "description": "run", "input_schema": {"type": "object"}}
            ],
            "tool_choice": {"type": "any", "disable_parallel_tool_use": true},
            "stop_sequences": ["END"],
            "temperature": 0.3
        });
        let body = messages_to_chat(&request, "deepseek-chat", true).unwrap();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(
            messages[0],
            json!({"role": "system", "content": "You are Claude Code.\n\nBe brief."})
        );
        assert_eq!(
            messages[1]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AA"
        );
        assert_eq!(messages[2]["content"], "running");
        assert_eq!(
            messages[2]["tool_calls"][0]["function"]["arguments"],
            "{\"command\":\"ls\"}"
        );
        assert_eq!(
            messages[3],
            json!({"role": "tool", "tool_call_id": "toolu_1", "content": "a.txt"})
        );
        assert_eq!(messages[4], json!({"role": "user", "content": "next"}));
        assert_eq!(messages[5], json!({"role": "user", "content": "plain"}));
        assert_eq!(messages.len(), 6);
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
        assert_eq!(body["tool_choice"], "required");
        assert_eq!(body["parallel_tool_calls"], false);
        assert_eq!(body["stop"], json!(["END"]));
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(body.get("thinking").is_none());
        assert!(messages_to_chat(&json!({"model": "m"}), "m", false).is_err());
    }

    #[test]
    fn whole_reply_becomes_message_with_net_input_usage() {
        let chat = json!({
            "choices": [{"finish_reason": "tool_calls", "message": {
                "content": "ok", "reasoning_content": "think",
                "tool_calls": [{"id": "", "type": "function", "function": {"name": "Bash", "arguments": "{\"command\":\"ls\"}"}}]
            }}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10, "prompt_cache_hit_tokens": 60}
        });
        let message = chat_to_message(&chat, "msg_1", "deepseek/deepseek-chat");
        let kinds: Vec<_> = message["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|block| block["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["thinking", "text", "tool_use"]);
        assert_eq!(message["content"][2]["id"], "toolu_msg_1_0");
        assert_eq!(message["content"][2]["input"]["command"], "ls");
        assert_eq!(message["stop_reason"], "tool_use");
        assert_eq!(
            message["usage"],
            json!({"input_tokens": 40, "output_tokens": 10, "cache_read_input_tokens": 60, "cache_creation_input_tokens": 0})
        );
        let length = chat_to_message(
            &json!({"choices": [{"finish_reason": "length", "message": {"content": "x"}}]}),
            "m",
            "m",
        );
        assert_eq!(length["stop_reason"], "max_tokens");
    }

    #[test]
    fn stream_emits_ordered_message_events() {
        let mut stream = MessageStream::new("msg_1", "deepseek/deepseek-chat");
        let mut chunks = stream.start();
        for chunk in [
            json!({"choices": [{"delta": {"reasoning_content": "hm"}}]}),
            json!({"choices": [{"delta": {"content": "Hel"}}]}),
            json!({"choices": [{"delta": {"content": "lo"}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "Bash", "arguments": "{\"command\""}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "c2", "function": {"name": "Read", "arguments": "{}"}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ":\"ls\"}"}}]}}]}),
            json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
            json!({"choices": [], "usage": {"prompt_tokens": 50, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 40}}}),
        ] {
            chunks.extend(stream.push_chunk(&chunk));
        }
        chunks.extend(stream.finish());
        let parsed = events(&chunks);
        let names: Vec<_> = parsed.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );
        assert!(parsed.iter().all(|(name, data)| data["type"] == *name));
        assert_eq!(parsed[1].1["content_block"]["type"], "thinking");
        assert_eq!(parsed[4].1["index"], 1);
        assert_eq!(parsed[6].1["delta"]["text"], "lo");
        assert_eq!(parsed[8].1["content_block"]["id"], "c1");
        assert_eq!(parsed[9].1["delta"]["partial_json"], "{\"command\":\"ls\"}");
        assert_eq!(parsed[11].1["index"], 3);
        let delta = &parsed[14].1;
        assert_eq!(delta["delta"]["stop_reason"], "tool_use");
        assert_eq!(delta["usage"]["input_tokens"], 10);
        assert_eq!(delta["usage"]["cache_read_input_tokens"], 40);
        assert_eq!(
            stream.usage(),
            Some(Usage {
                input: 10,
                output: 5,
                cache_read: 40,
                cache_write: 0
            })
        );
        let failed = events(&stream.fail("上游流中断"));
        assert_eq!(failed[0].0, "error");
        assert_eq!(failed[0].1["error"]["message"], "上游流中断");
    }

    #[test]
    fn token_estimate_counts_text_cjk_and_images() {
        let request = json!({
            "system": "abcdefgh",
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "你好"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAAAAAAAAAAAAAA"}}
            ]}]
        });
        let plain = estimate_input_tokens(&json!({"messages": []}));
        assert!(plain >= 1);
        let estimate = estimate_input_tokens(&request);
        assert!(
            estimate > IMAGE_TOKENS && estimate < IMAGE_TOKENS + 20,
            "{estimate}"
        );
    }
}

#[cfg(test)]
mod nested_semantic_tests {
    use super::*;

    fn request() -> Value {
        json!({
            "system":[{"type":"text","text":"rules","citations":[]}],
            "messages":[
                {"role":"user","id":"m1","status":"completed","content":[
                    {"type":"text","text":"look","id":"t1","status":"completed","citations":[]},
                    {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA"}},
                    {"type":"image","source":{"type":"url","url":"https://example.com/a.png"}}
                ]},
                {"role":"assistant","content":[{"type":"text","text":"calling"},{"type":"tool_use","id":"c1","name":"f","input":{"future_semantic_requirement":"tool-data"},"status":"completed"}]},
                {"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","is_error":true,"content":[{"type":"text","text":"failed"}]}]}
            ],
            "tools":[{"type":"custom","name":"f","description":"run","input_schema":{"type":"object","properties":{"future_semantic_requirement":{"type":"string"}},"x-schema-extension":"preserved"}}],
            "tool_choice":{"type":"tool","name":"f","disable_parallel_tool_use":true}
        })
    }

    #[test]
    fn nested_unknown_fields_are_rejected_including_image_sources_and_tool_results() {
        for pointer in [
            "/system/0",
            "/messages/0",
            "/messages/0/content/0",
            "/messages/0/content/1",
            "/messages/0/content/1/source",
            "/messages/0/content/2/source",
            "/messages/1/content/1",
            "/messages/2/content/0",
            "/messages/2/content/0/content/0",
            "/tools/0",
            "/tool_choice",
        ] {
            let mut payload = request();
            payload
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("future_semantic_requirement".into(), json!("must-preserve"));
            let error = messages_to_chat(&payload, "m", false)
                .err()
                .unwrap_or_else(|| panic!("accepted {pointer}"));
            assert!(
                error.contains("future_semantic_requirement"),
                "{pointer}: {error}"
            );
        }
    }

    #[test]
    fn citations_cannot_be_silently_flattened_to_text() {
        let mut payload = request();
        payload["messages"][0]["content"][0]["citations"] = json!([{
            "type":"char_location","cited_text":"source","document_index":0,
            "document_title":"evidence","start_char_index":0,"end_char_index":6
        }]);
        assert!(messages_to_chat(&payload, "m", false)
            .unwrap_err()
            .contains("citations"));
    }

    #[test]
    fn known_metadata_images_schema_tool_input_and_choice_preserve_normal_conversion() {
        let payload = request();
        let converted = messages_to_chat(&payload, "m", false).unwrap();
        assert_eq!(converted["messages"][0]["content"], "rules");
        assert_eq!(converted["messages"][1]["content"][0]["text"], "look");
        assert_eq!(
            converted["messages"][1]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AA"
        );
        assert_eq!(
            converted["messages"][1]["content"][2]["image_url"]["url"],
            "https://example.com/a.png"
        );
        let arguments: Value = serde_json::from_str(
            converted["messages"][2]["tool_calls"][0]["function"]["arguments"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(arguments, payload["messages"][1]["content"][1]["input"]);
        assert_eq!(converted["messages"][3]["content"], "[tool error] failed");
        assert_eq!(
            converted["tools"][0]["function"]["parameters"],
            payload["tools"][0]["input_schema"]
        );
        assert_eq!(converted["tool_choice"]["function"]["name"], "f");
        assert_eq!(converted["parallel_tool_calls"], false);
        for (key, value) in [("id", json!(42)), ("status", json!("future-status"))] {
            let mut bad = payload.clone();
            bad["messages"][0][key] = value;
            assert!(messages_to_chat(&bad, "m", false).is_err());
        }
    }
}
