//! Responses API requests served by a Chat Completions upstream: the request
//! is rewritten to Chat, and the reply (whole or streamed) back to Responses.

use std::collections::{BTreeMap, HashSet};

use serde_json::{json, Map, Value};

use super::ledger::Usage;

pub struct ChatRequest {
    pub body: Value,
    pub custom_tools: HashSet<String>,
}

fn text_of_parts(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn chat_content(content: &Value, assistant: bool) -> Value {
    let Value::Array(parts) = content else {
        return Value::String(text_of_parts(content));
    };
    let has_image = parts
        .iter()
        .any(|part| part.get("type").and_then(Value::as_str) == Some("input_image"));
    if assistant || !has_image {
        return Value::String(text_of_parts(content));
    }
    Value::Array(
        parts
            .iter()
            .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                Some("input_text") | Some("output_text") | Some("text") => Some(
                    json!({"type": "text", "text": part.get("text").cloned().unwrap_or_default()}),
                ),
                Some("input_image") => {
                    let url = part.get("image_url").and_then(Value::as_str)?;
                    let mut image = json!({"url": url});
                    if let Some(detail) = part.get("detail") {
                        image["detail"] = detail.clone();
                    }
                    Some(json!({"type": "image_url", "image_url": image}))
                }
                _ => None,
            })
            .collect(),
    )
}

fn push_tool_call(messages: &mut Vec<Value>, call: Value) {
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(Value::as_str) == Some("assistant") {
            let calls = last
                .as_object_mut()
                .expect("message is an object")
                .entry("tool_calls")
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Value::Array(calls) = calls {
                calls.push(call);
                return;
            }
        }
    }
    messages.push(json!({"role": "assistant", "content": null, "tool_calls": [call]}));
}

fn convert_tools(tools: &[Value], custom_tools: &mut HashSet<String>) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name").and_then(Value::as_str)?;
            match tool.get("type").and_then(Value::as_str) {
                Some("function") => {
                    let mut function = json!({
                        "name": name,
                        "parameters": tool.get("parameters").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
                    });
                    if let Some(strict) = tool.get("strict") {
                        function["strict"] = strict.clone();
                    }
                    if let Some(description) = tool.get("description") {
                        function["description"] = description.clone();
                    }
                    Some(json!({"type": "function", "function": function}))
                }
                Some("custom") => {
                    custom_tools.insert(name.to_string());
                    let description = tool.get("description").and_then(Value::as_str).unwrap_or_default();
                    Some(json!({"type": "function", "function": {
                        "name": name,
                        "description": format!("{description}\n\nPut the complete raw tool input in the `input` string."),
                        "parameters": {"type": "object", "properties": {"input": {"type": "string"}}, "required": ["input"]},
                    }}))
                }
                _ => None,
            }
        })
        .collect()
}

/// Only explicitly represented fields may cross a protocol conversion.
/// Object payloads forwarded verbatim (JSON Schema and tool arguments) are
/// deliberately checked by their outer node only, preserving all their data.
pub(super) fn supported_fields(
    value: &Value,
    fields: &[&str],
    context: &str,
) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{context} 必须是对象。"))?;
    if let Some(key) = object.keys().find(|key| !fields.contains(&key.as_str())) {
        return Err(format!(
            "Chat 转换不支持 {context} 字段「{key}」，请选择原生协议供应商。"
        ));
    }
    // Historical item identity/lifecycle metadata does not change its content
    // or tool linkage. Admit only known, typed metadata, never arbitrary keys.
    if value.get("id").is_some_and(|v| !v.is_string()) {
        return Err(format!("{context} id 必须是字符串。"));
    }
    if value
        .get("status")
        .is_some_and(|v| !matches!(v.as_str(), Some("completed" | "in_progress" | "incomplete")))
    {
        return Err(format!("{context} status 不是已知状态。"));
    }
    Ok(())
}

fn empty_annotations(value: &Value, name: &str, context: &str) -> Result<(), String> {
    if value
        .get(name)
        .is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty))
    {
        return Err(format!(
            "Chat 转换不能保留 {context} 的 {name}，请选择原生协议供应商。"
        ));
    }
    Ok(())
}

/// Validate the complete semantic surface before any upstream connection.
/// Unknown content and server tools cannot be represented by Chat; callers
/// may select another routing member with a native protocol instead.
fn validate_responses(request: &Value) -> Result<(), String> {
    let object = request.as_object().ok_or("Responses 请求必须是对象。")?;
    for key in object.keys() {
        if ![
            "model",
            "input",
            "instructions",
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "temperature",
            "top_p",
            "max_output_tokens",
            "stream",
            "previous_response_id",
            "reasoning",
            "metadata",
            "store",
        ]
        .contains(&key.as_str())
        {
            return Err(format!(
                "Chat 转换不支持 Responses 字段「{key}」，请选择原生 Responses 供应商。"
            ));
        }
    }
    if request.get("store").is_some_and(|v| v != &json!(false)) {
        return Err("Chat 转换不支持 Responses 服务端存储。".into());
    }
    if let Some(value) = request.get("instructions") {
        if !value.is_string() {
            return Err("instructions 必须是字符串。".into());
        }
    }
    if let Some(reasoning) = request.get("reasoning") {
        let reasoning = reasoning.as_object().ok_or("reasoning 必须是对象。")?;
        if reasoning.keys().any(|key| key != "effort")
            || reasoning.get("effort").is_some_and(|v| !v.is_string())
        {
            return Err("Chat 转换仅支持 reasoning.effort。".into());
        }
    }
    fn content(content: &Value, images: bool) -> Result<(), String> {
        if content.is_string() {
            return Ok(());
        }
        let parts = content
            .as_array()
            .ok_or("消息内容必须是字符串或内容块数组。")?;
        for part in parts {
            match part.get("type").and_then(Value::as_str) {
                Some("input_text" | "output_text" | "text")
                    if part.get("text").is_some_and(Value::is_string) =>
                {
                    supported_fields(
                        part,
                        &["type", "text", "annotations", "id", "status"],
                        "Responses 文本块",
                    )?;
                    empty_annotations(part, "annotations", "Responses 文本块")?;
                }
                Some("input_image")
                    if images && part.get("image_url").is_some_and(Value::is_string) =>
                {
                    supported_fields(
                        part,
                        &["type", "image_url", "detail", "id", "status"],
                        "Responses 图片块",
                    )?;
                    if part
                        .get("detail")
                        .is_some_and(|v| !matches!(v.as_str(), Some("auto" | "low" | "high")))
                    {
                        return Err("图片 detail 不受支持。".into());
                    }
                }
                _ => {
                    return Err(format!(
                        "Chat 转换不支持或无法解析内容块：{}。",
                        part.get("type").unwrap_or(&Value::Null)
                    ))
                }
            }
        }
        Ok(())
    }
    if let Some(items) = request.get("input").and_then(Value::as_array) {
        for item in items {
            match item
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("message")
            {
                "message" => {
                    supported_fields(
                        item,
                        &["type", "role", "content", "id", "status"],
                        "Responses 消息项",
                    )?;
                    let role = item
                        .get("role")
                        .and_then(Value::as_str)
                        .ok_or("消息缺少 role。")?;
                    if !["user", "assistant", "developer", "system"].contains(&role) {
                        return Err("消息 role 不受支持。".into());
                    }
                    content(
                        item.get("content").ok_or("消息缺少 content。")?,
                        role == "user",
                    )?;
                }
                "function_call" | "custom_tool_call" => {
                    let fields = if item["type"] == "function_call" {
                        &["type", "call_id", "name", "arguments", "id", "status"][..]
                    } else {
                        &["type", "call_id", "name", "input", "id", "status"][..]
                    };
                    supported_fields(item, fields, "Responses 工具调用")?;
                    for key in ["call_id", "name"] {
                        if !item.get(key).is_some_and(Value::is_string) {
                            return Err(format!("工具调用缺少 {key}。"));
                        }
                    }
                    let key = if item["type"] == "function_call" {
                        "arguments"
                    } else {
                        "input"
                    };
                    if !item.get(key).is_some_and(Value::is_string) {
                        return Err(format!("工具调用 {key} 必须是字符串。"));
                    }
                }
                "function_call_output" | "custom_tool_call_output" => {
                    supported_fields(
                        item,
                        &["type", "call_id", "output", "id", "status"],
                        "Responses 工具结果",
                    )?;
                    if !item.get("call_id").is_some_and(Value::is_string) {
                        return Err("工具结果缺少 call_id。".into());
                    }
                    content(item.get("output").ok_or("工具结果缺少 output。")?, false)?;
                }
                // Empty summaries contain no information. Nonempty or encrypted
                // reasoning must go to a native Responses member.
                "reasoning"
                    if item
                        .get("summary")
                        .is_some_and(|v| v.as_array().is_some_and(Vec::is_empty))
                        && item.get("encrypted_content").is_none() =>
                {
                    supported_fields(
                        item,
                        &["type", "summary", "id", "status"],
                        "Responses reasoning 项",
                    )?;
                }
                kind => return Err(format!("Chat 转换不支持 Responses 输入类型「{kind}」。")),
            }
        }
    }
    let mut names = HashSet::new();
    if let Some(tools) = request.get("tools") {
        for tool in tools.as_array().ok_or("tools 必须是数组。")? {
            let kind = tool
                .get("type")
                .and_then(Value::as_str)
                .ok_or("工具缺少 type。")?;
            if !["function", "custom"].contains(&kind) {
                return Err(format!("Chat 转换不支持服务端工具「{kind}」。"));
            }
            let fields = if kind == "function" {
                &["type", "name", "parameters", "description", "strict"][..]
            } else {
                &["type", "name", "description", "format"][..]
            };
            supported_fields(tool, fields, "Responses 工具定义")?;
            if tool.get("description").is_some_and(|v| !v.is_string()) {
                return Err("工具 description 必须是字符串。".into());
            }
            if tool.get("strict").is_some_and(|v| !v.is_boolean()) {
                return Err("工具 strict 必须是布尔值。".into());
            }
            if let Some(format) = tool.get("format") {
                supported_fields(format, &["type"], "Responses 自定义工具格式")?;
            }
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or("工具缺少 name。")?;
            names.insert(name);
            if tool.get("parameters").is_some_and(|v| !v.is_object()) {
                return Err("工具 parameters 必须是对象。".into());
            }
            if kind == "custom"
                && tool
                    .get("format")
                    .is_some_and(|v| v.get("type").and_then(Value::as_str) != Some("text"))
            {
                return Err("Chat 转换不支持自定义工具 grammar 格式。".into());
            }
        }
    }
    if let Some(choice) = request.get("tool_choice") {
        if choice.is_object() {
            supported_fields(choice, &["type", "name"], "Responses tool_choice")?;
        }
        match choice {
            Value::String(v) if ["auto", "none", "required"].contains(&v.as_str()) => {}
            Value::Object(_)
                if matches!(
                    choice.get("type").and_then(Value::as_str),
                    Some("function" | "custom")
                ) && choice
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| names.contains(name)) => {}
            _ => return Err("Chat 转换不支持 tool_choice 或其工具不存在。".into()),
        }
        if names.is_empty() && choice != "none" {
            return Err("tool_choice 要求至少一个工具。".into());
        }
    }
    Ok(())
}

pub fn responses_to_chat(
    request: &Value,
    upstream_model: &str,
    stream: bool,
) -> Result<ChatRequest, String> {
    validate_responses(request)?;
    if request
        .get("previous_response_id")
        .is_some_and(|value| !value.is_null())
    {
        return Err(
            "经 Chat 接口转换时不支持 previous_response_id，请让客户端发送完整上下文。".to_string(),
        );
    }
    let mut messages = Vec::new();
    if let Some(instructions) = request.get("instructions").and_then(Value::as_str) {
        if !instructions.is_empty() {
            messages.push(json!({"role": "system", "content": instructions}));
        }
    }
    match request.get("input") {
        Some(Value::String(text)) => messages.push(json!({"role": "user", "content": text})),
        Some(Value::Array(items)) => {
            for item in items {
                let kind = item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("message");
                match kind {
                    "message" => {
                        let role = match item.get("role").and_then(Value::as_str).unwrap_or("user")
                        {
                            "developer" | "system" => "system",
                            "assistant" => "assistant",
                            _ => "user",
                        };
                        let content = chat_content(
                            item.get("content").unwrap_or(&Value::Null),
                            role == "assistant",
                        );
                        messages.push(json!({"role": role, "content": content}));
                    }
                    "function_call" => push_tool_call(
                        &mut messages,
                        json!({"id": item.get("call_id").cloned().unwrap_or_default(), "type": "function", "function": {
                            "name": item.get("name").cloned().unwrap_or_default(),
                            "arguments": item.get("arguments").cloned().unwrap_or_else(|| json!("{}")),
                        }}),
                    ),
                    "custom_tool_call" => {
                        let input = item
                            .get("input")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        push_tool_call(
                            &mut messages,
                            json!({"id": item.get("call_id").cloned().unwrap_or_default(), "type": "function", "function": {
                                "name": item.get("name").cloned().unwrap_or_default(),
                                "arguments": json!({"input": input}).to_string(),
                            }}),
                        );
                    }
                    "function_call_output" | "custom_tool_call_output" => messages.push(json!({
                        "role": "tool",
                        "tool_call_id": item.get("call_id").cloned().unwrap_or_default(),
                        "content": text_of_parts(item.get("output").unwrap_or(&Value::Null)),
                    })),
                    _ => {}
                }
            }
        }
        _ => return Err("请求缺少 input。".to_string()),
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(upstream_model));
    body.insert("messages".into(), Value::Array(messages));
    let mut custom_tools = HashSet::new();
    if let Some(Value::Array(tools)) = request.get("tools") {
        let tools = convert_tools(tools, &mut custom_tools);
        if !tools.is_empty() {
            body.insert("tools".into(), Value::Array(tools));
            match request.get("tool_choice") {
                Some(Value::String(choice)) => {
                    body.insert("tool_choice".into(), json!(choice));
                }
                Some(choice @ Value::Object(_)) => {
                    if let Some(name) = choice.get("name").and_then(Value::as_str) {
                        body.insert(
                            "tool_choice".into(),
                            json!({"type": "function", "function": {"name": name}}),
                        );
                    }
                }
                _ => {}
            }
            if let Some(parallel) = request.get("parallel_tool_calls") {
                body.insert("parallel_tool_calls".into(), parallel.clone());
            }
        }
    }
    for key in ["temperature", "top_p"] {
        if let Some(value) = request.get(key) {
            body.insert(key.into(), value.clone());
        }
    }
    if let Some(effort) = request.pointer("/reasoning/effort") {
        body.insert("reasoning_effort".into(), effort.clone());
    }
    if let Some(max) = request.get("max_output_tokens") {
        body.insert("max_tokens".into(), max.clone());
    }
    if stream {
        body.insert("stream".into(), json!(true));
        body.insert("stream_options".into(), json!({"include_usage": true}));
    }
    Ok(ChatRequest {
        body: Value::Object(body),
        custom_tools,
    })
}

fn responses_usage(usage: &Value) -> Value {
    let prompt = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let completion = usage
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = Usage::from_chat(usage)
        .map(|usage| usage.cache_read)
        .unwrap_or(0);
    let reasoning = usage
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    json!({
        "input_tokens": prompt,
        "input_tokens_details": {"cached_tokens": cached},
        "output_tokens": completion,
        "output_tokens_details": {"reasoning_tokens": reasoning},
        "total_tokens": prompt + completion,
    })
}

fn custom_input(arguments: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("input")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| arguments.to_string())
}

fn tool_item(id: &str, call_id: &str, name: &str, arguments: &str, custom: bool) -> Value {
    if custom {
        json!({"type": "custom_tool_call", "id": id, "status": "completed", "call_id": call_id, "name": name, "input": custom_input(arguments)})
    } else {
        json!({"type": "function_call", "id": id, "status": "completed", "call_id": call_id, "name": name, "arguments": arguments})
    }
}

fn message_item(id: &str, text: &str) -> Value {
    json!({"type": "message", "id": id, "status": "completed", "role": "assistant",
        "content": [{"type": "output_text", "text": text, "annotations": []}]})
}

fn reasoning_item(id: &str, text: &str) -> Value {
    json!({"type": "reasoning", "id": id, "summary": [{"type": "summary_text", "text": text}]})
}

fn response_shell(id: &str, model: &str, created_at: i64, status: &str) -> Value {
    json!({"id": id, "object": "response", "created_at": created_at, "status": status, "model": model,
        "output": [], "usage": null, "error": null, "incomplete_details": null})
}

fn finish_status(response: &mut Value, finish_reason: Option<&str>) {
    if finish_reason == Some("length") {
        response["status"] = json!("incomplete");
        response["incomplete_details"] = json!({"reason": "max_output_tokens"});
    } else {
        response["status"] = json!("completed");
    }
}

pub fn chat_to_response(
    chat: &Value,
    response_id: &str,
    model: &str,
    created_at: i64,
    custom_tools: &HashSet<String>,
) -> Value {
    let choice = chat.pointer("/choices/0").cloned().unwrap_or_default();
    let message = choice.get("message").cloned().unwrap_or_default();
    let mut output = Vec::new();
    if let Some(reasoning) = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        output.push(reasoning_item(&format!("rs_{response_id}"), reasoning));
    }
    let text = text_of_parts(message.get("content").unwrap_or(&Value::Null));
    if !text.is_empty() {
        output.push(message_item(&format!("msg_{response_id}"), &text));
    }
    if let Some(Value::Array(calls)) = message.get("tool_calls") {
        for (index, call) in calls.iter().enumerate() {
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let call_id = call.get("id").and_then(Value::as_str).unwrap_or_default();
            output.push(tool_item(
                &format!("fc_{response_id}_{index}"),
                call_id,
                name,
                arguments,
                custom_tools.contains(name),
            ));
        }
    }
    let mut response = response_shell(response_id, model, created_at, "completed");
    finish_status(
        &mut response,
        choice.get("finish_reason").and_then(Value::as_str),
    );
    response["output"] = Value::Array(output);
    if let Some(usage) = chat.get("usage").filter(|usage| usage.is_object()) {
        response["usage"] = responses_usage(usage);
    }
    response
}

struct OpenText {
    output_index: usize,
    id: String,
    text: String,
}

struct ToolState {
    output_index: usize,
    id: String,
    call_id: String,
    name: String,
    arguments: String,
    custom: bool,
    opened: bool,
}

pub struct StreamConverter {
    response_id: String,
    model: String,
    created_at: i64,
    custom_tools: HashSet<String>,
    sequence: u64,
    next_output_index: usize,
    reasoning: Option<OpenText>,
    text: Option<OpenText>,
    tools: BTreeMap<u64, ToolState>,
    done: Vec<(usize, Value)>,
    finish_reason: Option<String>,
    chat_usage: Option<Value>,
}

impl StreamConverter {
    pub fn new(
        response_id: &str,
        model: &str,
        created_at: i64,
        custom_tools: HashSet<String>,
    ) -> Self {
        Self {
            response_id: response_id.to_string(),
            model: model.to_string(),
            created_at,
            custom_tools,
            sequence: 0,
            next_output_index: 0,
            reasoning: None,
            text: None,
            tools: BTreeMap::new(),
            done: Vec::new(),
            finish_reason: None,
            chat_usage: None,
        }
    }

    pub fn usage(&self) -> Option<Usage> {
        self.chat_usage.as_ref().and_then(Usage::from_chat)
    }

    fn event(&mut self, kind: &str, mut payload: Value, out: &mut Vec<String>) {
        payload["type"] = json!(kind);
        payload["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        out.push(format!("event: {kind}\ndata: {payload}\n\n"));
    }

    fn allocate(&mut self) -> usize {
        let index = self.next_output_index;
        self.next_output_index += 1;
        index
    }

    pub fn start(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        let shell = response_shell(
            &self.response_id,
            &self.model,
            self.created_at,
            "in_progress",
        );
        self.event(
            "response.created",
            json!({"response": shell.clone()}),
            &mut out,
        );
        self.event("response.in_progress", json!({"response": shell}), &mut out);
        out
    }

    fn close_reasoning(&mut self, out: &mut Vec<String>) {
        let Some(open) = self.reasoning.take() else {
            return;
        };
        let (index, id, text) = (open.output_index, open.id, open.text);
        self.event(
            "response.reasoning_summary_text.done",
            json!({"item_id": id, "output_index": index, "summary_index": 0, "text": text}),
            out,
        );
        self.event("response.reasoning_summary_part.done",
            json!({"item_id": id, "output_index": index, "summary_index": 0, "part": {"type": "summary_text", "text": text}}), out);
        let item = reasoning_item(&id, &text);
        self.event(
            "response.output_item.done",
            json!({"output_index": index, "item": item.clone()}),
            out,
        );
        self.done.push((index, item));
    }

    fn close_text(&mut self, out: &mut Vec<String>) {
        let Some(open) = self.text.take() else { return };
        let (index, id, text) = (open.output_index, open.id, open.text);
        self.event(
            "response.output_text.done",
            json!({"item_id": id, "output_index": index, "content_index": 0, "text": text}),
            out,
        );
        self.event("response.content_part.done",
            json!({"item_id": id, "output_index": index, "content_index": 0, "part": {"type": "output_text", "text": text, "annotations": []}}), out);
        let item = message_item(&id, &text);
        self.event(
            "response.output_item.done",
            json!({"output_index": index, "item": item.clone()}),
            out,
        );
        self.done.push((index, item));
    }

    fn on_reasoning(&mut self, delta: &str, out: &mut Vec<String>) {
        if self.reasoning.is_none() {
            let index = self.allocate();
            let id = format!("rs_{}_{index}", self.response_id);
            self.event("response.output_item.added",
                json!({"output_index": index, "item": {"type": "reasoning", "id": id, "summary": []}}), out);
            self.event("response.reasoning_summary_part.added",
                json!({"item_id": id, "output_index": index, "summary_index": 0, "part": {"type": "summary_text", "text": ""}}), out);
            self.reasoning = Some(OpenText {
                output_index: index,
                id,
                text: String::new(),
            });
        }
        let open = self.reasoning.as_mut().expect("reasoning is open");
        open.text.push_str(delta);
        let (id, index) = (open.id.clone(), open.output_index);
        self.event(
            "response.reasoning_summary_text.delta",
            json!({"item_id": id, "output_index": index, "summary_index": 0, "delta": delta}),
            out,
        );
    }

    fn on_text(&mut self, delta: &str, out: &mut Vec<String>) {
        self.close_reasoning(out);
        if self.text.is_none() {
            let index = self.allocate();
            let id = format!("msg_{}_{index}", self.response_id);
            self.event("response.output_item.added", json!({"output_index": index, "item": {
                "type": "message", "id": id, "status": "in_progress", "role": "assistant", "content": []}}), out);
            self.event(
                "response.content_part.added",
                json!({"item_id": id, "output_index": index, "content_index": 0,
                "part": {"type": "output_text", "text": "", "annotations": []}}),
                out,
            );
            self.text = Some(OpenText {
                output_index: index,
                id,
                text: String::new(),
            });
        }
        let open = self.text.as_mut().expect("text is open");
        open.text.push_str(delta);
        let (id, index) = (open.id.clone(), open.output_index);
        self.event(
            "response.output_text.delta",
            json!({"item_id": id, "output_index": index, "content_index": 0, "delta": delta}),
            out,
        );
    }

    fn on_tool_call(&mut self, call: &Value, out: &mut Vec<String>) {
        self.close_reasoning(out);
        self.close_text(out);
        let key = call.get("index").and_then(Value::as_u64).unwrap_or(0);
        if !self.tools.contains_key(&key) {
            let index = self.allocate();
            let id = format!("fc_{}_{index}", self.response_id);
            self.tools.insert(
                key,
                ToolState {
                    output_index: index,
                    id,
                    call_id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                    custom: false,
                    opened: false,
                },
            );
        }
        let custom_tools = &self.custom_tools;
        let state = self.tools.get_mut(&key).expect("tool exists");
        if let Some(call_id) = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            state.call_id = call_id.to_string();
        }
        if let Some(name) = call
            .pointer("/function/name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        {
            state.name.push_str(name);
            state.custom = custom_tools.contains(&state.name);
        }
        let delta = call
            .pointer("/function/arguments")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        state.arguments.push_str(&delta);
        if state.custom || state.name.is_empty() {
            return;
        }
        let (id, index) = (state.id.clone(), state.output_index);
        let pending = if state.opened {
            delta
        } else {
            state.opened = true;
            let (call_id, name, buffered) = (
                state.call_id.clone(),
                state.name.clone(),
                state.arguments.clone(),
            );
            self.event("response.output_item.added", json!({"output_index": index, "item": {
                "type": "function_call", "id": id, "status": "in_progress", "call_id": call_id, "name": name, "arguments": ""}}), out);
            buffered
        };
        if !pending.is_empty() {
            self.event(
                "response.function_call_arguments.delta",
                json!({"item_id": id, "output_index": index, "delta": pending}),
                out,
            );
        }
    }

    pub fn push_chunk(&mut self, chunk: &Value) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
            self.chat_usage = Some(usage.clone());
        }
        let Some(choice) = chunk.pointer("/choices/0") else {
            return out;
        };
        let delta = choice.get("delta").cloned().unwrap_or_default();
        let reasoning = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !reasoning.is_empty() {
            self.on_reasoning(reasoning, &mut out);
        }
        if let Some(text) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            self.on_text(text, &mut out);
        }
        if let Some(Value::Array(calls)) = delta.get("tool_calls") {
            for call in calls {
                self.on_tool_call(call, &mut out);
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        out
    }

    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        self.close_reasoning(&mut out);
        self.close_text(&mut out);
        let tools = std::mem::take(&mut self.tools);
        for state in tools.into_values() {
            let item = tool_item(
                &state.id,
                &state.call_id,
                &state.name,
                &state.arguments,
                state.custom,
            );
            if state.custom || !state.opened {
                let mut added = item.clone();
                added["status"] = json!("in_progress");
                self.event(
                    "response.output_item.added",
                    json!({"output_index": state.output_index, "item": added}),
                    &mut out,
                );
            } else {
                self.event("response.function_call_arguments.done", json!({
                    "item_id": state.id, "output_index": state.output_index, "arguments": state.arguments}), &mut out);
            }
            self.event(
                "response.output_item.done",
                json!({"output_index": state.output_index, "item": item.clone()}),
                &mut out,
            );
            self.done.push((state.output_index, item));
        }
        self.done.sort_by_key(|(index, _)| *index);
        let mut response =
            response_shell(&self.response_id, &self.model, self.created_at, "completed");
        finish_status(&mut response, self.finish_reason.as_deref());
        response["output"] = Value::Array(self.done.iter().map(|(_, item)| item.clone()).collect());
        if let Some(usage) = &self.chat_usage {
            response["usage"] = responses_usage(usage);
        }
        let kind = if response["status"] == "incomplete" {
            "response.incomplete"
        } else {
            "response.completed"
        };
        self.event(kind, json!({"response": response}), &mut out);
        out
    }

    pub fn fail(&mut self, message: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut response =
            response_shell(&self.response_id, &self.model, self.created_at, "failed");
        response["error"] = json!({"code": "upstream_error", "message": message});
        self.event("response.failed", json!({"response": response}), &mut out);
        out
    }
}

/// Turns a Chat Completions chunk stream into the client's event stream.
pub trait ChatStream: Send {
    fn start(&mut self) -> Vec<String>;
    fn push_chunk(&mut self, chunk: &Value) -> Vec<String>;
    fn finish(&mut self) -> Vec<String>;
    fn fail(&mut self, message: &str) -> Vec<String>;
    fn usage(&self) -> Option<Usage>;
}

impl ChatStream for StreamConverter {
    fn start(&mut self) -> Vec<String> {
        StreamConverter::start(self)
    }
    fn push_chunk(&mut self, chunk: &Value) -> Vec<String> {
        StreamConverter::push_chunk(self, chunk)
    }
    fn finish(&mut self) -> Vec<String> {
        StreamConverter::finish(self)
    }
    fn fail(&mut self, message: &str) -> Vec<String> {
        StreamConverter::fail(self, message)
    }
    fn usage(&self) -> Option<Usage> {
        StreamConverter::usage(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[String]) -> Vec<Value> {
        chunks
            .iter()
            .map(|chunk| {
                let data = chunk
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .unwrap();
                serde_json::from_str(data).unwrap()
            })
            .collect()
    }

    #[test]
    fn request_maps_items_tools_and_limits() {
        let request = json!({
            "model": "deepseek/deepseek-v4",
            "instructions": "be brief",
            "input": [
                {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "rules"}]},
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "look"},
                    {"type": "input_image", "image_url": "data:image/png;base64,AA"}
                ]},
                {"type": "reasoning", "summary": []},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "ok"}]},
                {"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{\"cmd\":\"ls\"}"},
                {"type": "custom_tool_call", "call_id": "c2", "name": "apply_patch", "input": "*** Begin Patch"},
                {"type": "function_call_output", "call_id": "c1", "output": "a.txt"},
                {"type": "custom_tool_call_output", "call_id": "c2", "output": "done"}
            ],
            "tools": [
                {"type": "function", "name": "shell", "parameters": {"type": "object"}},
                {"type": "custom", "name": "apply_patch", "description": "patch"}
            ],
            "tool_choice": "auto",
            "max_output_tokens": 512,
            "temperature": 0.2
        });
        let converted = responses_to_chat(&request, "deepseek-v4", true).unwrap();
        let body = converted.body;
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(
            messages[0],
            json!({"role": "system", "content": "be brief"})
        );
        assert_eq!(messages[1], json!({"role": "system", "content": "rules"}));
        assert_eq!(
            messages[2]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AA"
        );
        assert_eq!(messages[3]["content"], "ok");
        let calls = messages[3]["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[1]["function"]["arguments"],
            "{\"input\":\"*** Begin Patch\"}"
        );
        assert_eq!(
            messages[4],
            json!({"role": "tool", "tool_call_id": "c1", "content": "a.txt"})
        );
        assert_eq!(body["tools"].as_array().unwrap().len(), 2);
        assert_eq!(body["max_tokens"], 512);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(converted.custom_tools.contains("apply_patch"));
    }

    #[test]
    fn previous_response_id_is_rejected() {
        let request = json!({"input": "hi", "previous_response_id": "resp_1"});
        assert!(responses_to_chat(&request, "m", false).is_err());
    }

    #[test]
    fn whole_reply_becomes_response_items() {
        let chat = json!({
            "choices": [{"finish_reason": "tool_calls", "message": {
                "content": "running", "reasoning_content": "think",
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "shell", "arguments": "{}"}},
                    {"id": "c2", "type": "function", "function": {"name": "apply_patch", "arguments": "{\"input\":\"P\"}"}}
                ]
            }}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 10, "prompt_cache_hit_tokens": 60}
        });
        let custom = HashSet::from(["apply_patch".to_string()]);
        let response = chat_to_response(&chat, "r1", "deepseek/deepseek-v4", 1, &custom);
        let kinds: Vec<_> = response["output"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["type"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            vec!["reasoning", "message", "function_call", "custom_tool_call"]
        );
        assert_eq!(response["output"][3]["input"], "P");
        assert_eq!(
            response["usage"]["input_tokens_details"]["cached_tokens"],
            60
        );
        assert_eq!(response["status"], "completed");
    }

    #[test]
    fn stream_emits_ordered_responses_events() {
        let custom = HashSet::from(["apply_patch".to_string()]);
        let mut converter = StreamConverter::new("r1", "deepseek/deepseek-v4", 1, custom);
        let mut chunks = converter.start();
        for chunk in [
            json!({"choices": [{"delta": {"reasoning_content": "hm"}}]}),
            json!({"choices": [{"delta": {"content": "Hel"}}]}),
            json!({"choices": [{"delta": {"content": "lo"}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "shell", "arguments": "{\"a\""}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ":1}"}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 1, "id": "c2", "function": {"name": "apply_patch", "arguments": "{\"input\":\"P\"}"}}]}}]}),
            json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
            json!({"choices": [], "usage": {"prompt_tokens": 50, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 40}}}),
        ] {
            chunks.extend(converter.push_chunk(&chunk));
        }
        chunks.extend(converter.finish());
        let parsed = events(&chunks);
        let kinds: Vec<_> = parsed
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect();
        assert_eq!(kinds.first(), Some(&"response.created"));
        assert_eq!(kinds.last(), Some(&"response.completed"));
        assert!(parsed
            .iter()
            .enumerate()
            .all(|(index, event)| event["sequence_number"] == index as u64));
        let text_done = parsed
            .iter()
            .find(|event| event["type"] == "response.output_text.done")
            .unwrap();
        assert_eq!(text_done["text"], "Hello");
        let args_done = parsed
            .iter()
            .find(|event| event["type"] == "response.function_call_arguments.done")
            .unwrap();
        assert_eq!(args_done["arguments"], "{\"a\":1}");
        let completed = parsed.last().unwrap();
        let output = completed["response"]["output"].as_array().unwrap();
        assert_eq!(output.len(), 4);
        assert_eq!(output[3]["type"], "custom_tool_call");
        assert_eq!(output[3]["input"], "P");
        assert_eq!(
            converter.usage(),
            Some(Usage {
                input: 10,
                output: 5,
                cache_read: 40,
                cache_write: 0
            })
        );
    }

    #[test]
    fn length_finish_is_incomplete() {
        let mut converter = StreamConverter::new("r1", "m", 1, HashSet::new());
        converter.start();
        converter.push_chunk(
            &json!({"choices": [{"delta": {"content": "x"}, "finish_reason": "length"}]}),
        );
        let last = events(&converter.finish()).pop().unwrap();
        assert_eq!(last["type"], "response.incomplete");
        assert_eq!(
            last["response"]["incomplete_details"]["reason"],
            "max_output_tokens"
        );
    }
}

#[cfg(test)]
mod nested_semantic_tests {
    use super::*;

    fn request() -> Value {
        json!({
            "input":[
                {"type":"message","role":"user","id":"m1","status":"completed","content":[
                    {"type":"input_text","text":"look","id":"t1","status":"completed"},
                    {"type":"input_image","image_url":"data:image/png;base64,AA","detail":"high"}
                ]},
                {"type":"message","role":"assistant","id":"m2","status":"completed","content":[{"type":"output_text","text":"answer","annotations":[]}]},
                {"type":"function_call","id":"fc1","status":"completed","call_id":"c1","name":"f","arguments":"{\"future_semantic_requirement\":\"tool-data\"}"},
                {"type":"function_call_output","id":"o1","status":"completed","call_id":"c1","output":[{"type":"input_text","text":"result"}]},
                {"type":"reasoning","id":"r1","status":"completed","summary":[]},
                {"type":"custom_tool_call","id":"fc2","status":"completed","call_id":"c2","name":"raw","input":"raw-data"},
                {"type":"custom_tool_call_output","id":"o2","status":"completed","call_id":"c2","output":"done"}
            ],
            "tools":[
                {"type":"function","name":"f","description":"run","strict":true,"parameters":{"type":"object","properties":{"future_semantic_requirement":{"type":"string"}},"x-schema-extension":"preserved"}},
                {"type":"custom","name":"raw","description":"raw","format":{"type":"text"}}
            ],
            "tool_choice":{"type":"function","name":"f"}
        })
    }

    #[test]
    fn nested_unknown_fields_are_rejected_at_every_conversion_node() {
        for pointer in [
            "/input/0",
            "/input/0/content/0",
            "/input/0/content/1",
            "/input/1/content/0",
            "/input/2",
            "/input/3",
            "/input/3/output/0",
            "/input/4",
            "/input/5",
            "/input/6",
            "/tools/0",
            "/tools/1",
            "/tools/1/format",
            "/tool_choice",
        ] {
            let mut payload = request();
            payload
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("future_semantic_requirement".into(), json!("must-preserve"));
            let error = responses_to_chat(&payload, "m", false)
                .err()
                .unwrap_or_else(|| panic!("accepted {pointer}"));
            assert!(
                error.contains("future_semantic_requirement"),
                "{pointer}: {error}"
            );
        }
    }

    #[test]
    fn historical_citation_annotations_require_native_responses() {
        let mut payload = request();
        payload["input"][1]["content"][0]["annotations"] = json!([{
            "type":"url_citation","start_index":0,"end_index":6,
            "url":"https://example.com/evidence","title":"source"
        }]);
        let error = responses_to_chat(&payload, "m", false).err().unwrap();
        assert!(error.contains("annotations"));
    }

    #[test]
    fn known_metadata_and_verbatim_schema_arguments_preserve_normal_conversion() {
        let payload = request();
        let converted = responses_to_chat(&payload, "m", false).unwrap().body;
        assert_eq!(converted["messages"][0]["content"][0]["text"], "look");
        assert_eq!(
            converted["messages"][0]["content"][1]["image_url"],
            json!({"url":"data:image/png;base64,AA","detail":"high"})
        );
        assert_eq!(converted["messages"][1]["content"], "answer");
        assert_eq!(
            converted["messages"][1]["tool_calls"][0]["function"]["arguments"],
            payload["input"][2]["arguments"]
        );
        assert_eq!(
            converted["tools"][0]["function"]["parameters"],
            payload["tools"][0]["parameters"]
        );
        assert_eq!(converted["tools"][0]["function"]["strict"], true);
        assert_eq!(converted["tool_choice"]["function"]["name"], "f");
        for (key, value) in [("id", json!(42)), ("status", json!("future-status"))] {
            let mut bad = payload.clone();
            bad["input"][0][key] = value;
            assert!(responses_to_chat(&bad, "m", false).is_err());
        }
    }
}
