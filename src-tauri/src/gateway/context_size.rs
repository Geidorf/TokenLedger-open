//! Per-request prompt composition: serialized UTF-8 byte sizes and counts of
//! each part of the request the client sent. Only sizes leave this module; no
//! text or hashes are kept. See docs/design/request-context-composition-v1.md.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextSize {
    pub system_bytes: u64,
    pub tools_bytes: u64,
    pub history_bytes: u64,
    pub tool_results_bytes: u64,
    pub attachments_bytes: u64,
    /// Conversation messages (or Responses items) outside the system part.
    pub messages: u64,
    pub tool_results: u64,
    pub attachments: u64,
}

/// The request API the client used, before any conversion to the upstream wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextApi {
    Messages,
    Chat,
    Responses,
    Gemini,
}

fn size(value: &Value) -> u64 {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len() as u64)
}

impl ContextSize {
    fn is_empty(&self) -> bool {
        self.system_bytes
            + self.tools_bytes
            + self.history_bytes
            + self.tool_results_bytes
            + self.attachments_bytes
            == 0
    }

    fn attachment(&mut self, value: &Value) {
        self.attachments += 1;
        self.attachments_bytes += size(value);
    }

    fn tool_result(&mut self, value: &Value) {
        self.tool_results += 1;
        self.tool_results_bytes += size(value);
    }
}

/// `None` when the body has no recognizable prompt parts.
pub fn measure(api: ContextApi, body: &Value) -> Option<ContextSize> {
    let mut out = ContextSize::default();
    match api {
        ContextApi::Messages => messages_api(body, &mut out),
        ContextApi::Chat => chat_api(body, &mut out),
        ContextApi::Responses => responses_api(body, &mut out),
        ContextApi::Gemini => gemini_api(body, &mut out),
    }
    (!out.is_empty()).then_some(out)
}

fn tools(body: &Value, keys: &[&str], out: &mut ContextSize) {
    for key in keys {
        if let Some(value) = body.get(*key) {
            out.tools_bytes += size(value);
        }
    }
}

fn messages_api(body: &Value, out: &mut ContextSize) {
    if let Some(system) = body.get("system") {
        out.system_bytes += size(system);
    }
    tools(body, &["tools"], out);
    for message in body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        out.messages += 1;
        let Some(blocks) = message.get("content").and_then(Value::as_array) else {
            out.history_bytes += size(message);
            continue;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("tool_result") => out.tool_result(block),
                Some("image" | "document") => out.attachment(block),
                _ => out.history_bytes += size(block),
            }
        }
    }
}

fn chat_part_is_attachment(part: &Value) -> bool {
    matches!(
        part.get("type").and_then(Value::as_str),
        Some("image_url" | "input_audio" | "file")
    )
}

fn chat_api(body: &Value, out: &mut ContextSize) {
    tools(body, &["tools", "functions"], out);
    for message in body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match message.get("role").and_then(Value::as_str) {
            Some("system" | "developer") => out.system_bytes += size(message),
            Some("tool" | "function") => out.tool_result(message),
            _ => {
                out.messages += 1;
                let Some(parts) = message.get("content").and_then(Value::as_array) else {
                    out.history_bytes += size(message);
                    continue;
                };
                for part in parts {
                    if chat_part_is_attachment(part) {
                        out.attachment(part);
                    } else {
                        out.history_bytes += size(part);
                    }
                }
                // Tool calls an assistant turn made are part of the history.
                if let Some(calls) = message.get("tool_calls") {
                    out.history_bytes += size(calls);
                }
            }
        }
    }
}

fn responses_api(body: &Value, out: &mut ContextSize) {
    if let Some(instructions) = body.get("instructions") {
        out.system_bytes += size(instructions);
    }
    tools(body, &["tools"], out);
    let items = match body.get("input") {
        Some(Value::Array(items)) => items.as_slice(),
        Some(text @ Value::String(_)) => {
            out.messages += 1;
            out.history_bytes += size(text);
            return;
        }
        _ => return,
    };
    for item in items {
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        let role = item.get("role").and_then(Value::as_str);
        match (kind, role) {
            ("function_call_output" | "custom_tool_call_output", _) => out.tool_result(item),
            ("message", Some("system" | "developer")) => out.system_bytes += size(item),
            ("message", _) => {
                out.messages += 1;
                let Some(parts) = item.get("content").and_then(Value::as_array) else {
                    out.history_bytes += size(item);
                    continue;
                };
                for part in parts {
                    match part.get("type").and_then(Value::as_str) {
                        Some("input_image" | "input_file") => out.attachment(part),
                        _ => out.history_bytes += size(part),
                    }
                }
            }
            _ => {
                out.messages += 1;
                out.history_bytes += size(item);
            }
        }
    }
}

fn gemini_api(body: &Value, out: &mut ContextSize) {
    if let Some(system) = body
        .get("systemInstruction")
        .or_else(|| body.get("system_instruction"))
    {
        out.system_bytes += size(system);
    }
    tools(body, &["tools"], out);
    for content in body
        .get("contents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        out.messages += 1;
        let Some(parts) = content.get("parts").and_then(Value::as_array) else {
            out.history_bytes += size(content);
            continue;
        };
        for part in parts {
            if part.get("functionResponse").is_some() {
                out.tool_result(part);
            } else if part.get("inlineData").is_some() || part.get("fileData").is_some() {
                out.attachment(part);
            } else {
                out.history_bytes += size(part);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn messages_api_splits_system_tools_history_results_and_attachments() {
        let body = json!({
            "system": "be brief",
            "tools": [{"name": "read", "input_schema": {"type": "object"}}],
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "read", "input": {}}]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "file body"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
                    {"type": "future_block"}
                ]}
            ]
        });
        let size = measure(ContextApi::Messages, &body).unwrap();
        assert_eq!(size.system_bytes, "\"be brief\"".len() as u64);
        assert!(size.tools_bytes > 0);
        assert_eq!(size.messages, 3);
        assert_eq!(size.tool_results, 1);
        assert_eq!(size.attachments, 1);
        // Plain string content counts as the whole message; unknown blocks are history.
        assert!(size.history_bytes > size_of_json(&json!({"type": "future_block"})));
    }

    fn size_of_json(value: &Value) -> u64 {
        serde_json::to_vec(value).unwrap().len() as u64
    }

    #[test]
    fn chat_api_counts_system_and_tool_roles_apart_from_history() {
        let body = json!({
            "tools": [{"type": "function", "function": {"name": "read"}}],
            "messages": [
                {"role": "system", "content": "rules"},
                {"role": "developer", "content": "more rules"},
                {"role": "user", "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image_url", "image_url": {"url": "data:x"}}
                ]},
                {"role": "assistant", "content": null, "tool_calls": [{"id": "c1"}]},
                {"role": "tool", "tool_call_id": "c1", "content": "result"}
            ]
        });
        let size = measure(ContextApi::Chat, &body).unwrap();
        assert_eq!(
            size.system_bytes,
            size_of_json(&body["messages"][0]) + size_of_json(&body["messages"][1])
        );
        assert_eq!(size.messages, 2);
        assert_eq!(size.tool_results, 1);
        assert_eq!(size.tool_results_bytes, size_of_json(&body["messages"][4]));
        assert_eq!(size.attachments, 1);
        assert!(size.history_bytes >= size_of_json(&json!([{"id": "c1"}])));
    }

    #[test]
    fn responses_api_handles_instructions_items_and_string_input() {
        let body = json!({
            "instructions": "sys",
            "tools": [{"type": "function", "name": "shell"}],
            "input": [
                {"role": "developer", "content": "dev"},
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "go"},
                    {"type": "input_file", "file_data": "BBBB"}
                ]},
                {"type": "function_call", "call_id": "c", "name": "shell", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "c", "output": "ok"},
                {"type": "reasoning", "summary": []}
            ]
        });
        let size = measure(ContextApi::Responses, &body).unwrap();
        assert_eq!(
            size.system_bytes,
            size_of_json(&json!("sys")) + size_of_json(&body["input"][0])
        );
        assert_eq!(size.messages, 3);
        assert_eq!(size.tool_results, 1);
        assert_eq!(size.attachments, 1);

        let text = measure(ContextApi::Responses, &json!({"input": "hello"})).unwrap();
        assert_eq!((text.messages, text.history_bytes), (1, 7));
    }

    #[test]
    fn gemini_api_splits_function_responses_and_inline_data() {
        let body = json!({
            "systemInstruction": {"parts": [{"text": "sys"}]},
            "contents": [
                {"role": "user", "parts": [{"text": "hi"}, {"inlineData": {"mimeType": "image/png", "data": "AA"}}]},
                {"role": "model", "parts": [{"functionCall": {"name": "f"}}]},
                {"role": "user", "parts": [{"functionResponse": {"name": "f", "response": {}}}]}
            ]
        });
        let size = measure(ContextApi::Gemini, &body).unwrap();
        assert!(size.system_bytes > 0);
        assert_eq!(
            (size.messages, size.tool_results, size.attachments),
            (3, 1, 1)
        );
    }

    #[test]
    fn empty_or_unknown_bodies_have_no_composition() {
        assert_eq!(measure(ContextApi::Chat, &json!({"model": "x"})), None);
        assert_eq!(measure(ContextApi::Responses, &json!({"input": 3})), None);
    }
}
