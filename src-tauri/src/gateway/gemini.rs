//! Gemini `generateContent` / `streamGenerateContent` requests served by a
//! Chat Completions upstream (T10.290): the request is rewritten to Chat, and
//! the reply (whole or SSE) back to a GenerateContentResponse. `countTokens`
//! is estimated locally and never reaches an upstream.

use std::collections::{BTreeMap, HashMap, VecDeque};

use serde_json::{json, Map, Value};

use super::ledger::Usage;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Generate,
    Stream,
    CountTokens,
}

#[derive(Debug, PartialEq, Eq)]
pub enum GeminiPath {
    /// `GET /v1beta/models`
    List,
    /// `GET /v1beta/models/{model}`
    Model(String),
    /// `POST /v1beta/models/{model}:{method}`
    Call {
        model: String,
        method: Method,
    },
    Unsupported(String),
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if let Some(byte) = bytes
                .get(index + 1..index + 3)
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Gemini routes; the model (`provider/model` or `group/<id>`, possibly
/// percent-encoded) is everything before the last `:`. `/v1/models/…` only
/// counts when it names a method, so the OpenAI `GET /v1/models` stays.
pub fn parse_path(path: &str) -> Option<GeminiPath> {
    if path == "/v1beta/models" {
        return Some(GeminiPath::List);
    }
    let (rest, beta) = if let Some(rest) = path.strip_prefix("/v1beta/models/") {
        (rest, true)
    } else if let Some(rest) = path.strip_prefix("/v1/models/") {
        (rest, false)
    } else {
        return None;
    };
    let rest = percent_decode(rest);
    let call = rest
        .rsplit_once(':')
        .filter(|(model, method)| {
            !model.is_empty()
                && !method.is_empty()
                && method.chars().all(|c| c.is_ascii_alphabetic())
        })
        .map(|(model, method)| (model.to_string(), method.to_string()));
    let Some((model, method)) = call else {
        return (beta && !rest.is_empty()).then_some(GeminiPath::Model(rest));
    };
    Some(match method.as_str() {
        "generateContent" => GeminiPath::Call {
            model,
            method: Method::Generate,
        },
        "streamGenerateContent" => GeminiPath::Call {
            model,
            method: Method::Stream,
        },
        "countTokens" => GeminiPath::Call {
            model,
            method: Method::CountTokens,
        },
        _ => GeminiPath::Unsupported(method),
    })
}

pub fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(&key.replace('+', " ")) == name)
            .then(|| percent_decode(&value.replace('+', " ")))
    })
}

fn status_name(status: u16) -> &'static str {
    match status {
        400 | 413 => "INVALID_ARGUMENT",
        401 => "UNAUTHENTICATED",
        403 => "PERMISSION_DENIED",
        404 => "NOT_FOUND",
        405 | 501 => "UNIMPLEMENTED",
        429 => "RESOURCE_EXHAUSTED",
        502 | 503 => "UNAVAILABLE",
        504 => "DEADLINE_EXCEEDED",
        _ => "INTERNAL",
    }
}

pub fn error_body(status: u16, message: &str) -> Value {
    json!({"error": {"code": status, "message": message, "status": status_name(status)}})
}

/// The human-readable message of a gateway or upstream error body.
pub fn error_message(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let parsed = serde_json::from_str::<Value>(&text).ok();
    parsed
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("error"))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.chars().take(500).collect())
}

pub fn model_entry(id: &str) -> Value {
    json!({
        "name": format!("models/{id}"),
        "baseModelId": id,
        "version": "tokenledger",
        "displayName": id,
        "description": "TokenLedger 网关模型",
        "supportedGenerationMethods": ["generateContent", "streamGenerateContent", "countTokens"],
    })
}

/// Gemini `Schema` (upper-case types, `nullable`) → JSON Schema.
fn json_schema(value: &Value) -> Value {
    let Value::Object(map) = value else {
        return value.clone();
    };
    let nullable = map.get("nullable").and_then(Value::as_bool) == Some(true);
    let mut out = Map::new();
    for (key, item) in map {
        let converted = match key.as_str() {
            "nullable" | "propertyOrdering" => continue,
            "type" => match item.as_str() {
                Some(kind) if kind.eq_ignore_ascii_case("TYPE_UNSPECIFIED") => continue,
                Some(kind) if nullable => json!([kind.to_ascii_lowercase(), "null"]),
                Some(kind) => json!(kind.to_ascii_lowercase()),
                None => item.clone(),
            },
            "properties" => match item {
                Value::Object(props) => Value::Object(
                    props
                        .iter()
                        .map(|(name, schema)| (name.clone(), json_schema(schema)))
                        .collect(),
                ),
                _ => item.clone(),
            },
            "items" | "additionalProperties" | "not" => json_schema(item),
            "anyOf" | "oneOf" | "allOf" | "prefixItems" => match item {
                Value::Array(list) => Value::Array(list.iter().map(json_schema).collect()),
                _ => item.clone(),
            },
            "minItems" | "maxItems" | "minLength" | "maxLength" | "minProperties"
            | "maxProperties" => match item.as_str().and_then(|text| text.parse::<u64>().ok()) {
                Some(number) => json!(number),
                None => item.clone(),
            },
            _ => item.clone(),
        };
        out.insert(key.clone(), converted);
    }
    Value::Object(out)
}

fn convert_tools(request: &Value) -> Vec<Value> {
    let Some(Value::Array(tools)) = request.get("tools") else {
        return Vec::new();
    };
    tools
        .iter()
        .filter_map(|tool| tool.get("functionDeclarations").and_then(Value::as_array))
        .flatten()
        .filter_map(|declaration| {
            let name = declaration.get("name").and_then(Value::as_str)?;
            let parameters = declaration
                .get("parametersJsonSchema")
                .cloned()
                .or_else(|| declaration.get("parameters").map(json_schema))
                .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
            let mut function = json!({"name": name, "parameters": parameters});
            if let Some(description) = declaration.get("description") {
                function["description"] = description.clone();
            }
            Some(json!({"type": "function", "function": function}))
        })
        .collect()
}

fn tool_choice(request: &Value) -> Option<Value> {
    let config = request.pointer("/toolConfig/functionCallingConfig")?;
    let allowed: Vec<&str> = config
        .get("allowedFunctionNames")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    match config.get("mode").and_then(Value::as_str)? {
        "NONE" => Some(json!("none")),
        "ANY" if allowed.len() == 1 => {
            Some(json!({"type": "function", "function": {"name": allowed[0]}}))
        }
        "ANY" => Some(json!("required")),
        _ => Some(json!("auto")),
    }
}

fn texts(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(content) => content
            .get("parts")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        None => String::new(),
    }
}

/// Gemini call ids are optional; Chat needs them to pair tool results.
#[derive(Default)]
struct CallIds {
    pending: HashMap<String, VecDeque<String>>,
    counter: usize,
}

impl CallIds {
    fn fresh(&mut self) -> String {
        self.counter += 1;
        format!("call_{}", self.counter)
    }

    fn for_call(&mut self, call: &Value, name: &str) -> String {
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| self.fresh());
        self.pending
            .entry(name.to_string())
            .or_default()
            .push_back(id.clone());
        id
    }

    fn for_response(&mut self, response: &Value, name: &str) -> String {
        let queue = self.pending.entry(name.to_string()).or_default();
        match response
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            Some(id) => {
                queue.retain(|pending| pending != id);
                id.to_string()
            }
            None => queue.pop_front().unwrap_or_else(|| self.fresh()),
        }
    }
}

fn tool_output(response: &Value) -> String {
    match response.get("response") {
        Some(Value::Object(map)) if map.len() == 1 => match map.values().next() {
            Some(Value::String(text)) if map.contains_key("output") => text.clone(),
            _ => Value::Object(map.clone()).to_string(),
        },
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn media_part(mime: &str, url: String, label: &str, forward: bool) -> Value {
    if forward && mime.starts_with("image/") {
        json!({"type": "image_url", "image_url": {"url": url}})
    } else {
        json!({"type": "text", "text": format!("[网关未转发的{label}：{mime}]")})
    }
}

fn user_messages(parts: &[Value], ids: &mut CallIds, messages: &mut Vec<Value>) {
    let mut content = Vec::new();
    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            content.push(json!({"type": "text", "text": text}));
        } else if let Some(data) = part.get("inlineData") {
            let mime = data
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let base64 = data.get("data").and_then(Value::as_str).unwrap_or_default();
            content.push(media_part(
                mime,
                format!("data:{mime};base64,{base64}"),
                "附件",
                true,
            ));
        } else if let Some(file) = part.get("fileData") {
            let mime = file
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let uri = file
                .get("fileUri")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // Url parsing normalizes mixed-case schemes accepted by validation.
            let parsed = reqwest::Url::parse(uri).ok();
            let web = parsed
                .as_ref()
                .is_some_and(|url| matches!(url.scheme(), "http" | "https"));
            let uri = parsed.as_ref().map(reqwest::Url::as_str).unwrap_or(uri);
            content.push(media_part(mime, uri.to_string(), "文件", web));
        } else if let Some(response) = part.get("functionResponse") {
            let name = response
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            messages.push(json!({
                "role": "tool",
                "tool_call_id": ids.for_response(response, name),
                "content": tool_output(response),
            }));
        }
    }
    if content.is_empty() {
        return;
    }
    let has_image = content.iter().any(|part| part["type"] == "image_url");
    let content = if has_image {
        Value::Array(content)
    } else {
        json!(content
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"))
    };
    messages.push(json!({"role": "user", "content": content}));
}

fn model_message(parts: &[Value], ids: &mut CallIds, messages: &mut Vec<Value>) {
    let mut text = String::new();
    let mut calls = Vec::new();
    for part in parts {
        if part.get("thought").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(delta) = part.get("text").and_then(Value::as_str) {
            text.push_str(delta);
        } else if let Some(call) = part.get("functionCall") {
            let name = call.get("name").and_then(Value::as_str).unwrap_or_default();
            let arguments = call
                .get("args")
                .map(Value::to_string)
                .unwrap_or_else(|| "{}".to_string());
            calls.push(json!({"id": ids.for_call(call, name), "type": "function",
                "function": {"name": name, "arguments": arguments}}));
        }
    }
    if text.is_empty() && calls.is_empty() {
        return;
    }
    let mut message = json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }});
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }
    messages.push(message);
}

fn object_keys<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or("Gemini 请求结构无效，未连接上游。")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Gemini 请求包含无法转换为 Chat 的字段，未连接上游。".into());
    }
    Ok(object)
}

fn validate_gemini_schema(schema: &Value) -> Result<(), String> {
    let object = schema
        .as_object()
        .ok_or("Gemini 参数 schema 必须是对象。")?;
    if object.contains_key("propertyOrdering")
        || object.get("type").is_some_and(|kind| {
            !matches!(
                kind.as_str(),
                Some(
                    "OBJECT"
                        | "STRING"
                        | "NUMBER"
                        | "BOOLEAN"
                        | "INTEGER"
                        | "ARRAY"
                        | "NULL"
                        | "object"
                        | "string"
                        | "number"
                        | "boolean"
                        | "integer"
                        | "array"
                        | "null"
                )
            )
        })
        || (object.get("nullable") == Some(&Value::Bool(true)) && !object.contains_key("type"))
    {
        return Err("Gemini 参数 schema 无法保真转换。".into());
    }
    if let Some(properties) = object.get("properties") {
        for value in properties
            .as_object()
            .ok_or("Gemini schema properties 无效。")?
            .values()
        {
            validate_gemini_schema(value)?;
        }
    }
    for key in ["items", "additionalProperties", "not"] {
        if let Some(child) = object.get(key).filter(|child| !child.is_boolean()) {
            validate_gemini_schema(child)?;
        }
    }
    for key in ["anyOf", "oneOf", "allOf", "prefixItems"] {
        if let Some(children) = object.get(key) {
            for child in children
                .as_array()
                .ok_or("Gemini schema 组合必须是数组。")?
            {
                validate_gemini_schema(child)?;
            }
        }
    }
    Ok(())
}

fn nonempty_string(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}

/// Validate the original request before conversion can discard any semantics.
pub fn validate_request(request: &Value) -> Result<(), String> {
    object_keys(
        request,
        &[
            "contents",
            "systemInstruction",
            "tools",
            "toolConfig",
            "generationConfig",
        ],
    )?;
    if let Some(system) = request.get("systemInstruction") {
        if !system.is_string() {
            object_keys(system, &["role", "parts"])?;
            let parts = system
                .get("parts")
                .and_then(Value::as_array)
                .ok_or("systemInstruction 缺少文本 parts。")?;
            for part in parts {
                object_keys(part, &["text"])?;
                if !part.get("text").is_some_and(Value::is_string) {
                    return Err("systemInstruction 仅支持文本。".into());
                }
            }
        }
    }
    let contents = request
        .get("contents")
        .and_then(Value::as_array)
        .ok_or("请求缺少 contents。")?;
    for content in contents {
        object_keys(content, &["role", "parts"])?;
        let model = match content.get("role") {
            None => false,
            Some(Value::String(role)) if role == "user" => false,
            Some(Value::String(role)) if role == "model" => true,
            _ => return Err("Gemini 消息 role 无法转换。".into()),
        };
        let parts = content
            .get("parts")
            .and_then(Value::as_array)
            .ok_or("Gemini 消息缺少 parts。")?;
        for part in parts {
            let map = object_keys(
                part,
                if model {
                    &["text", "functionCall"]
                } else {
                    &["text", "inlineData", "fileData", "functionResponse"]
                },
            )?;
            if map.len() != 1 {
                return Err("Gemini 每个 part 必须只有一种受支持内容。".into());
            }
            if let Some(text) = part.get("text") {
                if !text.is_string() {
                    return Err("Gemini text 必须是字符串。".into());
                }
            } else if let Some(data) = part.get("inlineData").or_else(|| part.get("fileData")) {
                let inline = part.get("inlineData").is_some();
                object_keys(
                    data,
                    if inline {
                        &["mimeType", "data"]
                    } else {
                        &["mimeType", "fileUri"]
                    },
                )?;
                if !matches!(
                    data.get("mimeType").and_then(Value::as_str),
                    Some("image/png" | "image/jpeg" | "image/gif" | "image/webp")
                ) {
                    return Err("Gemini 转换仅支持图片；PDF、音频或其他附件未连接上游。".into());
                }
                if inline {
                    if !nonempty_string(data.get("data")) {
                        return Err("Gemini 图片缺少 data。".into());
                    }
                } else {
                    let uri = data
                        .get("fileUri")
                        .and_then(Value::as_str)
                        .ok_or("Gemini 图片缺少 fileUri。")?;
                    if !reqwest::Url::parse(uri).is_ok_and(|url| {
                        matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
                    }) {
                        return Err("Gemini 图片仅支持 HTTP 地址。".into());
                    }
                }
            } else if let Some(call) = part.get("functionCall") {
                object_keys(call, &["name", "args", "id"])?;
                if !nonempty_string(call.get("name"))
                    || call.get("args").is_some_and(|args| !args.is_object())
                    || call.get("id").is_some_and(|id| !nonempty_string(Some(id)))
                {
                    return Err("Gemini functionCall 结构无效。".into());
                }
            } else if let Some(response) = part.get("functionResponse") {
                object_keys(response, &["name", "response", "id"])?;
                if !nonempty_string(response.get("name"))
                    || response.get("response").is_none()
                    || response
                        .get("id")
                        .is_some_and(|id| !nonempty_string(Some(id)))
                {
                    return Err("Gemini functionResponse 结构无效。".into());
                }
            }
        }
    }
    if let Some(tools) = request.get("tools") {
        let tools = tools.as_array().ok_or("Gemini tools 必须是数组。")?;
        for tool in tools {
            object_keys(tool, &["functionDeclarations"])?;
            let declarations = tool
                .get("functionDeclarations")
                .and_then(Value::as_array)
                .ok_or("Gemini 仅支持 functionDeclarations 工具。")?;
            for declaration in declarations {
                object_keys(
                    declaration,
                    &["name", "description", "parameters", "parametersJsonSchema"],
                )?;
                if !nonempty_string(declaration.get("name"))
                    || declaration
                        .get("description")
                        .is_some_and(|v| !v.is_string())
                {
                    return Err("Gemini 函数声明结构无效。".into());
                }
                if declaration.get("parameters").is_some()
                    && declaration.get("parametersJsonSchema").is_some()
                {
                    return Err("Gemini 函数声明只能指定一种参数 schema。".into());
                }
                for key in ["parameters", "parametersJsonSchema"] {
                    if let Some(schema) = declaration.get(key) {
                        if key == "parameters" {
                            validate_gemini_schema(schema)?;
                        } else if !schema.is_object() {
                            return Err("Gemini 函数参数 JSON schema 必须是对象。".into());
                        }
                    }
                }
            }
        }
    }
    if let Some(tool_config) = request.get("toolConfig") {
        if !request
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| {
                tools.iter().any(|tool| {
                    tool.get("functionDeclarations")
                        .and_then(Value::as_array)
                        .is_some_and(|declarations| !declarations.is_empty())
                })
            })
        {
            return Err("Gemini toolConfig 缺少可转换的函数工具。".into());
        }
        object_keys(tool_config, &["functionCallingConfig"])?;
        let config = tool_config
            .get("functionCallingConfig")
            .ok_or("Gemini toolConfig 缺少 functionCallingConfig。")?;
        object_keys(config, &["mode", "allowedFunctionNames"])?;
        let mode = match config.get("mode") {
            None => "AUTO",
            Some(Value::String(mode)) => mode.as_str(),
            _ => return Err("Gemini 函数调用模式结构无效。".into()),
        };
        if !matches!(mode, "AUTO" | "ANY" | "NONE") {
            return Err("Gemini 函数调用模式无法转换。".into());
        }
        if let Some(names) = config.get("allowedFunctionNames") {
            let names = names
                .as_array()
                .ok_or("allowedFunctionNames 必须是数组。")?;
            if names.iter().any(|name| !nonempty_string(Some(name)))
                || names.len() > 1
                || (!names.is_empty() && mode != "ANY")
            {
                return Err("Gemini 函数允许列表无法保真转换。".into());
            }
        }
    }
    if let Some(config) = request.get("generationConfig") {
        object_keys(
            config,
            &[
                "temperature",
                "topP",
                "maxOutputTokens",
                "stopSequences",
                "presencePenalty",
                "frequencyPenalty",
                "seed",
                "responseMimeType",
            ],
        )?;
        if config
            .get("responseMimeType")
            .is_some_and(|mime| !matches!(mime.as_str(), Some("application/json" | "text/plain")))
        {
            return Err("Gemini responseMimeType 无法转换。".into());
        }
    }
    Ok(())
}

/// The Chat body for `request`; `model` is filled in per upstream attempt.
pub fn gemini_to_chat(request: &Value, model: &str, stream: bool) -> Result<Value, String> {
    validate_request(request)?;
    let Some(Value::Array(contents)) = request.get("contents") else {
        return Err("请求缺少 contents。".to_string());
    };
    let mut messages = Vec::new();
    let system = texts(request.get("systemInstruction"));
    if !system.is_empty() {
        messages.push(json!({"role": "system", "content": system}));
    }
    let mut ids = CallIds::default();
    for content in contents {
        let empty = Vec::new();
        let parts = content
            .get("parts")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        match content.get("role").and_then(Value::as_str) {
            Some("model") => model_message(parts, &mut ids, &mut messages),
            _ => user_messages(parts, &mut ids, &mut messages),
        }
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    let tools = convert_tools(request);
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
        if let Some(choice) = tool_choice(request) {
            body.insert("tool_choice".into(), choice);
        }
    }
    let config = request.get("generationConfig").cloned().unwrap_or_default();
    for (from, to) in [
        ("temperature", "temperature"),
        ("topP", "top_p"),
        ("maxOutputTokens", "max_tokens"),
        ("stopSequences", "stop"),
        ("presencePenalty", "presence_penalty"),
        ("frequencyPenalty", "frequency_penalty"),
        ("seed", "seed"),
    ] {
        if let Some(value) = config.get(from).filter(|value| !value.is_null()) {
            body.insert(to.into(), value.clone());
        }
    }
    if config.get("responseMimeType").and_then(Value::as_str) == Some("application/json") {
        // json_schema is not offered by every Chat provider; json_object is.
        let schema = config
            .get("responseJsonSchema")
            .cloned()
            .or_else(|| config.get("responseSchema").map(json_schema));
        let hint = match schema {
            Some(schema) => {
                format!("Reply with a single JSON value matching this JSON schema:\n{schema}")
            }
            None => "Reply with a single JSON value.".to_string(),
        };
        messages.push(json!({"role": "system", "content": hint}));
        body.insert("response_format".into(), json!({"type": "json_object"}));
    }
    body.insert("messages".into(), Value::Array(messages));
    if stream {
        body.insert("stream".into(), json!(true));
        body.insert("stream_options".into(), json!({"include_usage": true}));
    }
    Ok(Value::Object(body))
}

fn finish_reason(reason: Option<&str>) -> &'static str {
    match reason {
        None | Some("stop") | Some("tool_calls") | Some("function_call") => "STOP",
        Some("length") => "MAX_TOKENS",
        Some("content_filter") => "SAFETY",
        Some(_) => "OTHER",
    }
}

/// Gemini counts thoughts apart from candidates; Chat's completion_tokens
/// includes reasoning, so the total stays prompt + completion.
fn usage_metadata(usage: &Value) -> Value {
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
    let thoughts = usage
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(completion);
    let mut metadata = json!({
        "promptTokenCount": prompt,
        "candidatesTokenCount": completion - thoughts,
        "totalTokenCount": prompt + completion,
    });
    if cached > 0 {
        metadata["cachedContentTokenCount"] = json!(cached);
    }
    if thoughts > 0 {
        metadata["thoughtsTokenCount"] = json!(thoughts);
    }
    metadata
}

fn function_call_part(id: &str, name: &str, arguments: &str) -> Value {
    let args = if arguments.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(arguments)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({"arguments": arguments}))
    };
    let mut call = json!({"name": name, "args": args});
    if !id.is_empty() {
        call["id"] = json!(id);
    }
    json!({"functionCall": call})
}

fn reply(
    parts: Vec<Value>,
    finish: Option<&str>,
    usage: Option<&Value>,
    model: &str,
    response_id: &str,
) -> Value {
    let mut candidate = json!({"index": 0});
    if !parts.is_empty() {
        candidate["content"] = json!({"role": "model", "parts": parts});
    }
    if let Some(finish) = finish {
        candidate["finishReason"] = json!(finish);
    }
    let mut body =
        json!({"candidates": [candidate], "modelVersion": model, "responseId": response_id});
    if let Some(usage) = usage.filter(|usage| usage.is_object()) {
        body["usageMetadata"] = usage_metadata(usage);
    }
    body
}

pub fn chat_to_gemini(chat: &Value, model: &str, response_id: &str) -> Value {
    let choice = chat.pointer("/choices/0").cloned().unwrap_or_default();
    let message = choice.get("message").cloned().unwrap_or_default();
    let mut parts = Vec::new();
    if let Some(reasoning) = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        parts.push(json!({"text": reasoning, "thought": true}));
    }
    if let Some(text) = message
        .get("content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        parts.push(json!({"text": text}));
    }
    if let Some(Value::Array(calls)) = message.get("tool_calls") {
        for call in calls {
            parts.push(function_call_part(
                call.get("id").and_then(Value::as_str).unwrap_or_default(),
                call.pointer("/function/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                call.pointer("/function/arguments")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ));
        }
    }
    reply(
        parts,
        Some(finish_reason(
            choice.get("finish_reason").and_then(Value::as_str),
        )),
        chat.get("usage"),
        model,
        response_id,
    )
}

#[derive(Default)]
struct ToolState {
    id: String,
    name: String,
    arguments: String,
}

/// Chat SSE chunks → Gemini SSE chunks. Text and thoughts are forwarded as
/// they arrive; function calls are sent whole in the final chunk, together
/// with the finish reason and usage (Chat sends usage after finish_reason).
pub struct GeminiStream {
    model: String,
    response_id: String,
    tools: BTreeMap<u64, ToolState>,
    finish_reason: Option<String>,
    chat_usage: Option<Value>,
}

impl GeminiStream {
    pub fn new(model: &str, response_id: &str) -> Self {
        Self {
            model: model.to_string(),
            response_id: response_id.to_string(),
            tools: BTreeMap::new(),
            finish_reason: None,
            chat_usage: None,
        }
    }

    fn event(&self, parts: Vec<Value>, finish: Option<&str>, usage: Option<&Value>) -> String {
        let body = reply(parts, finish, usage, &self.model, &self.response_id);
        format!("data: {body}\r\n\r\n")
    }

    pub fn usage(&self) -> Option<Usage> {
        self.chat_usage.as_ref().and_then(Usage::from_chat)
    }

    pub fn push_chunk(&mut self, chunk: &Value) -> Vec<String> {
        if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
            self.chat_usage = Some(usage.clone());
        }
        let Some(choice) = chunk.pointer("/choices/0") else {
            return Vec::new();
        };
        let delta = choice.get("delta").cloned().unwrap_or_default();
        let mut parts = Vec::new();
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            parts.push(json!({"text": reasoning, "thought": true}));
        }
        if let Some(text) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            parts.push(json!({"text": text}));
        }
        if let Some(Value::Array(calls)) = delta.get("tool_calls") {
            for call in calls {
                let key = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                let state = self.tools.entry(key).or_default();
                if let Some(id) = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    state.id = id.to_string();
                }
                if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                    state.name.push_str(name);
                }
                if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str)
                {
                    state.arguments.push_str(arguments);
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        if parts.is_empty() {
            Vec::new()
        } else {
            vec![self.event(parts, None, None)]
        }
    }

    pub fn finish(&mut self) -> Vec<String> {
        let parts = std::mem::take(&mut self.tools)
            .into_values()
            .filter(|state| !state.name.is_empty())
            .map(|state| function_call_part(&state.id, &state.name, &state.arguments))
            .collect();
        let finish = finish_reason(self.finish_reason.as_deref());
        vec![self.event(parts, Some(finish), self.chat_usage.as_ref())]
    }

    pub fn fail(&mut self, message: &str) -> Vec<String> {
        vec![format!("data: {}\r\n\r\n", error_body(502, message))]
    }
}

fn text_bytes(value: &Value) -> usize {
    match value {
        Value::Object(map) => map
            .iter()
            .map(|(key, item)| match (key.as_str(), item) {
                ("inlineData" | "fileData", _) => 0,
                ("text", Value::String(text)) => text.len(),
                ("functionCall" | "functionResponse", item) => item.to_string().len(),
                (_, item) => text_bytes(item),
            })
            .sum(),
        Value::Array(list) => list.iter().map(text_bytes).sum(),
        _ => 0,
    }
}

/// A local estimate (UTF-8 bytes / 4); media parts are not counted.
pub fn count_tokens(request: &Value) -> Value {
    let source = request.get("generateContentRequest").unwrap_or(request);
    let bytes: usize = ["contents", "systemInstruction"]
        .iter()
        .filter_map(|key| source.get(*key))
        .map(text_bytes)
        .sum();
    json!({"totalTokens": bytes.div_ceil(4)})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[String]) -> Vec<Value> {
        chunks
            .iter()
            .map(|chunk| {
                assert!(chunk.ends_with("\r\n\r\n"));
                serde_json::from_str(chunk.strip_prefix("data: ").unwrap().trim_end()).unwrap()
            })
            .collect()
    }

    #[test]
    fn paths_split_the_model_at_the_last_colon() {
        assert_eq!(parse_path("/v1beta/models"), Some(GeminiPath::List));
        assert_eq!(
            parse_path("/v1beta/models/deepseek/deepseek-chat:streamGenerateContent"),
            Some(GeminiPath::Call {
                model: "deepseek/deepseek-chat".into(),
                method: Method::Stream
            })
        );
        assert_eq!(
            parse_path("/v1beta/models/group%2Fcoding:generateContent"),
            Some(GeminiPath::Call {
                model: "group/coding".into(),
                method: Method::Generate
            })
        );
        assert_eq!(
            parse_path("/v1/models/ollama/qwen3:8b:countTokens"),
            Some(GeminiPath::Call {
                model: "ollama/qwen3:8b".into(),
                method: Method::CountTokens
            })
        );
        assert_eq!(
            parse_path("/v1beta/models/ollama/qwen3:8b"),
            Some(GeminiPath::Model("ollama/qwen3:8b".into()))
        );
        assert_eq!(
            parse_path("/v1beta/models/a/b:embedContent"),
            Some(GeminiPath::Unsupported("embedContent".into()))
        );
        assert_eq!(parse_path("/v1/models"), None);
        assert_eq!(parse_path("/v1/models/a/b"), None);
        assert_eq!(parse_path("/v1/chat/completions"), None);
    }

    #[test]
    fn query_values_are_decoded() {
        let query = Some("alt=sse&key=tl-ab%2Bc");
        assert_eq!(query_param(query, "alt").as_deref(), Some("sse"));
        assert_eq!(query_param(query, "key").as_deref(), Some("tl-ab+c"));
        assert_eq!(query_param(query, "x"), None);
        assert_eq!(query_param(None, "key"), None);
    }

    #[test]
    fn request_maps_contents_tools_and_config() {
        let request = json!({
            "systemInstruction": {"role": "user", "parts": [{"text": "be brief"}, {"text": "rules"}]},
            "contents": [
                {"role": "user", "parts": [{"text": "look"}, {"inlineData": {"mimeType": "image/png", "data": "AA"}}]},
                {"role": "model", "parts": [
                    {"text": "ok"},
                    {"functionCall": {"name": "shell", "args": {"cmd": "ls"}}},
                    {"functionCall": {"id": "c9", "name": "read", "args": {}}}
                ]},
                {"role": "user", "parts": [
                    {"functionResponse": {"name": "shell", "response": {"output": "a.txt"}}},
                    {"functionResponse": {"id": "c9", "name": "read", "response": {"error": "nope"}}}
                ]},
                {"role": "user", "parts": [{"text": "next"}]}
            ],
            "tools": [
                {"functionDeclarations": [
                    {"name": "shell", "description": "run", "parametersJsonSchema": {"type": "object", "properties": {"cmd": {"type": "string"}}}},
                    {"name": "read", "parameters": {"type": "OBJECT", "properties": {"path": {"type": "STRING", "nullable": true}, "lines": {"type": "ARRAY", "items": {"type": "INTEGER"}, "minItems": "1"}}}}
                ]}
            ],
            "toolConfig": {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["shell"]}},
            "generationConfig": {"temperature": 0.2, "topP": 0.9, "maxOutputTokens": 512, "stopSequences": ["END"]}
        });
        let body = gemini_to_chat(&request, "group/coding", true).unwrap();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(
            messages[0],
            json!({"role": "system", "content": "be brief\nrules"})
        );
        assert_eq!(
            messages[1]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AA"
        );
        assert_eq!(messages[2]["content"], "ok");
        let calls = messages[2]["tool_calls"].as_array().unwrap();
        assert_eq!(calls[0]["id"], "call_1");
        assert_eq!(calls[0]["function"]["arguments"], "{\"cmd\":\"ls\"}");
        assert_eq!(calls[1]["id"], "c9");
        assert_eq!(
            messages[3],
            json!({"role": "tool", "tool_call_id": "call_1", "content": "a.txt"})
        );
        assert_eq!(
            messages[4],
            json!({"role": "tool", "tool_call_id": "c9", "content": "{\"error\":\"nope\"}"})
        );
        assert_eq!(messages[5]["content"], "next");
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        let read = &tools[1]["function"]["parameters"];
        assert_eq!(read["type"], "object");
        assert_eq!(
            read["properties"]["path"]["type"],
            json!(["string", "null"])
        );
        assert_eq!(read["properties"]["lines"]["items"]["type"], "integer");
        assert_eq!(read["properties"]["lines"]["minItems"], 1);
        assert_eq!(body["tool_choice"]["function"]["name"], "shell");
        assert_eq!(body["max_tokens"], 512);
        assert_eq!(body["top_p"], 0.9);
        assert_eq!(body["stop"], json!(["END"]));
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(body.get("thinkingConfig").is_none());
    }

    #[test]
    fn json_mode_is_supported_but_schema_constraints_are_refused() {
        let request = json!({
            "contents": [{"role": "user", "parts": [{"text": "q"}]}],
            "generationConfig": {"responseMimeType": "application/json"}
        });
        let body = gemini_to_chat(&request, "m", false).unwrap();
        assert_eq!(body["response_format"]["type"], "json_object");
        let last = body["messages"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(last["role"], "system");
        assert_eq!(last["content"], "Reply with a single JSON value.");
        let mut constrained = request.clone();
        constrained["generationConfig"]["responseJsonSchema"] = json!({"type":"object"});
        assert!(gemini_to_chat(&constrained, "m", false).is_err());
        assert!(body.get("stream").is_none());
        assert!(gemini_to_chat(&json!({}), "m", false).is_err());
    }

    #[test]
    fn whole_reply_becomes_candidates_with_usage() {
        let chat = json!({
            "choices": [{"finish_reason": "tool_calls", "message": {
                "content": "running", "reasoning_content": "think",
                "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "shell", "arguments": "{\"cmd\":\"ls\"}"}}]
            }}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 30, "prompt_cache_hit_tokens": 60,
                "completion_tokens_details": {"reasoning_tokens": 10}}
        });
        let reply = chat_to_gemini(&chat, "deepseek/deepseek-v4", "r1");
        let parts = reply["candidates"][0]["content"]["parts"]
            .as_array()
            .unwrap();
        assert_eq!(parts[0], json!({"text": "think", "thought": true}));
        assert_eq!(parts[1], json!({"text": "running"}));
        assert_eq!(
            parts[2],
            json!({"functionCall": {"id": "c1", "name": "shell", "args": {"cmd": "ls"}}})
        );
        assert_eq!(reply["candidates"][0]["finishReason"], "STOP");
        assert_eq!(
            reply["usageMetadata"],
            json!({"promptTokenCount": 100, "candidatesTokenCount": 20, "totalTokenCount": 130,
                "cachedContentTokenCount": 60, "thoughtsTokenCount": 10})
        );
        let truncated = chat_to_gemini(
            &json!({"choices": [{"finish_reason": "length", "message": {"content": "x"}}]}),
            "m",
            "r2",
        );
        assert_eq!(truncated["candidates"][0]["finishReason"], "MAX_TOKENS");
        assert!(truncated.get("usageMetadata").is_none());
    }

    #[test]
    fn stream_forwards_text_and_sends_calls_with_the_final_chunk() {
        let mut stream = GeminiStream::new("chat/m1", "r1");
        let mut chunks = Vec::new();
        for chunk in [
            json!({"choices": [{"delta": {"reasoning_content": "hm"}}]}),
            json!({"choices": [{"delta": {"content": "Hel"}}]}),
            json!({"choices": [{"delta": {"content": "lo"}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "shell", "arguments": "{\"a\""}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ":1}"}}]}}]}),
            json!({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}),
            json!({"choices": [], "usage": {"prompt_tokens": 50, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 40}}}),
        ] {
            chunks.extend(stream.push_chunk(&chunk));
        }
        chunks.extend(stream.finish());
        let parsed = events(&chunks);
        assert_eq!(parsed.len(), 4);
        assert_eq!(
            parsed[0]["candidates"][0]["content"]["parts"][0]["thought"],
            true
        );
        assert_eq!(
            parsed[1]["candidates"][0]["content"]["parts"][0]["text"],
            "Hel"
        );
        let last = parsed.last().unwrap();
        assert_eq!(
            last["candidates"][0]["content"]["parts"][0]["functionCall"],
            json!({"id": "c1", "name": "shell", "args": {"a": 1}})
        );
        assert_eq!(last["candidates"][0]["finishReason"], "STOP");
        assert_eq!(last["usageMetadata"]["cachedContentTokenCount"], 40);
        assert_eq!(
            stream.usage(),
            Some(Usage {
                input: 10,
                output: 5,
                cache_read: 40,
                cache_write: 0
            })
        );
        let failed = events(&stream.fail("boom"));
        assert_eq!(failed[0]["error"]["status"], "UNAVAILABLE");
    }

    #[test]
    fn errors_and_token_estimates() {
        assert_eq!(
            error_message(br#"{"error":{"message":"bad key","type":"x"}}"#),
            "bad key"
        );
        assert_eq!(error_message(b"plain"), "plain");
        assert_eq!(
            error_body(429, "slow")["error"]["status"],
            "RESOURCE_EXHAUSTED"
        );
        let counted = count_tokens(
            &json!({"contents": [{"parts": [{"text": "12345678"}, {"inlineData": {"data": "AAAA"}}]}]}),
        );
        assert_eq!(counted["totalTokens"], 2);
        let wrapped = count_tokens(
            &json!({"generateContentRequest": {"contents": [{"parts": [{"text": "abc"}]}]}}),
        );
        assert_eq!(wrapped["totalTokens"], 1);
    }
}
