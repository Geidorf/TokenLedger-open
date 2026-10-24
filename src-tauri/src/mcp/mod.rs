//! `tokenledger-cli mcp`：本机 MCP 服务（stdio），给 Claude Code、Codex 等 Agent 查自己的用量。
//!
//! - 传输只用标准输入输出：一行一条 JSON-RPC 2.0 消息，不监听任何端口；日志只写标准错误。
//! - 工具全部只读，数字一律取自命令行工具同一套实现（`crate::cli`），命令行与看板同口径，
//!   这里不另算一遍。
//! - 不输出密钥、订阅凭据、请求或回复正文、上游地址、额度来源的账号标签与会话 ID。
//! - 不扫描、不写账本、不推云端：数据由桌面端（或 `tokenledger-cli scan`）负责更新。
//!
//! 工具与提示词说明见 docs/mcp.md。

use std::io::{BufRead, Write};

use serde_json::{json, Map, Value};

use crate::app_paths::AppContext;
use crate::cli::args::{GatewayArgs, RangeArg, UsageArgs, UsageGroup};

/// 支持的 MCP 协议版本，新的在前；客户端要的版本不在其中时回最新的。
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const SERVER_NAME: &str = "tokenledger";

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

const GATEWAY_LIMIT_DEFAULT: u64 = 10;
const GATEWAY_LIMIT_MAX: u64 = 50;
const PACE_THRESHOLD_DEFAULT: f64 = 20.0;

const INSTRUCTIONS: &str = "TokenLedger is the user's local AI token ledger. \
All tools are read-only and return JSON. Effective tokens = input + output; cached tokens are \
reported separately and never added to the effective total. Costs are estimates in USD. \
Call get_status for a quick overview (today's usage, the tightest budget and quota window); \
call get_quota before starting a long or expensive task. Numbers reflect the last scan made by \
the TokenLedger desktop app or `tokenledger-cli scan`; this server never scans or writes.";

/// 服务入口：读标准输入直到 EOF，返回进程退出码。
pub fn run_stdio() -> i32 {
    let app = AppContext::new();
    let mut server = Server::new(&app);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("tokenledger-cli mcp: 读取标准输入失败：{error}");
                return 1;
            }
        };
        let Some(reply) = server.handle_line(&line) else {
            continue;
        };
        let text = serde_json::to_string(&reply).unwrap_or_else(|_| "{}".to_string());
        if let Err(error) = writeln!(stdout, "{text}").and_then(|()| stdout.flush()) {
            // 客户端关掉管道就是会话结束。
            if error.kind() == std::io::ErrorKind::BrokenPipe {
                return 0;
            }
            eprintln!("tokenledger-cli mcp: 写入标准输出失败：{error}");
            return 1;
        }
    }
    0
}

/// 一个 stdio 会话。数据来源经 `Sources` 注入，测试可替换掉会联网或探端口的部分。
pub(crate) struct Server<'a> {
    app: &'a AppContext,
    sources: Sources,
}

/// 会访问外部的数据来源：额度（只走设置里已授权的来源）与网关探活（只连 127.0.0.1）。
pub(crate) struct Sources {
    pub quota: fn(&AppContext) -> Value,
    pub probe_gateway: fn(u16) -> bool,
    pub anomalies: fn(&AppContext) -> Result<Value, String>,
}

impl Default for Sources {
    fn default() -> Self {
        Self {
            quota: crate::cli::quota_json,
            probe_gateway: crate::cli::probe_gateway,
            anomalies: anomalies_report,
        }
    }
}

impl<'a> Server<'a> {
    pub(crate) fn new(app: &'a AppContext) -> Self {
        Self::with_sources(app, Sources::default())
    }

    pub(crate) fn with_sources(app: &'a AppContext, sources: Sources) -> Self {
        Self { app, sources }
    }

    /// 处理一行输入；返回要写回的一行（通知与客户端的响应不回）。
    pub(crate) fn handle_line(&mut self, line: &str) -> Option<Value> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                return Some(error_response(
                    Value::Null,
                    PARSE_ERROR,
                    &format!("parse error: {error}"),
                ))
            }
        };
        match message {
            // 2025-03-26 及更早的版本允许批量。
            Value::Array(items) => {
                if items.is_empty() {
                    return Some(error_response(Value::Null, INVALID_REQUEST, "empty batch"));
                }
                let replies: Vec<Value> = items
                    .into_iter()
                    .filter_map(|item| self.handle_message(item))
                    .collect();
                (!replies.is_empty()).then_some(Value::Array(replies))
            }
            other => self.handle_message(other),
        }
    }

    fn handle_message(&mut self, message: Value) -> Option<Value> {
        let Value::Object(message) = message else {
            return Some(error_response(
                Value::Null,
                INVALID_REQUEST,
                "message must be an object",
            ));
        };
        let id = message.get("id").cloned();
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            // 客户端发来的响应（本服务不发请求）直接忽略。
            if message.contains_key("result") || message.contains_key("error") {
                return None;
            }
            return Some(error_response(
                id.unwrap_or(Value::Null),
                INVALID_REQUEST,
                "missing method",
            ));
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        // 没有 id 的是通知：照常处理，不回。
        let id = id?;
        let outcome = match method {
            "initialize" => Ok(initialize_result(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tool_definitions() })),
            "tools/call" => self.call_tool(&params),
            "prompts/list" => Ok(json!({ "prompts": prompt_definitions() })),
            "prompts/get" => self.get_prompt(&params),
            "resources/list" => Ok(json!({ "resources": [] })),
            "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
            _ => Err((METHOD_NOT_FOUND, format!("method not found: {method}"))),
        };
        Some(match outcome {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, text)) => error_response(id, code, &text),
        })
    }

    // ------------------------------------------------------------ tools

    fn call_tool(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params["name"]
            .as_str()
            .ok_or((INVALID_PARAMS, "missing tool name".to_string()))?;
        let empty = Map::new();
        let arguments = match &params["arguments"] {
            Value::Object(map) => map,
            Value::Null => &empty,
            _ => return Err((INVALID_PARAMS, "arguments must be an object".to_string())),
        };
        let outcome = match name {
            "get_status" => self.status(arguments),
            "get_usage" => self.usage(arguments),
            "get_quota" => Ok(quota_view(&(self.sources.quota)(self.app))),
            "get_budget" => crate::cli::budget_json(self.app),
            "get_gateway" => self.gateway(arguments),
            "get_anomalies" => (self.sources.anomalies)(self.app),
            _ => return Err((INVALID_PARAMS, format!("unknown tool: {name}"))),
        };
        // 参数不对与执行失败都作为工具结果返回，Agent 能读到原因并自己改正。
        Ok(match outcome {
            Ok(value) => tool_result(value),
            Err(error) => json!({
                "content": [{ "type": "text", "text": error }],
                "isError": true,
            }),
        })
    }

    fn status(&self, arguments: &Map<String, Value>) -> Result<Value, String> {
        let include_quota = optional_bool(arguments, "includeQuota")?.unwrap_or(true);
        let quota = include_quota.then(|| (self.sources.quota)(self.app));
        crate::cli::status_from(self.app, quota.as_ref())
    }

    fn usage(&self, arguments: &Map<String, Value>) -> Result<Value, String> {
        let range = match (
            optional_str(arguments, "from")?,
            optional_str(arguments, "to")?,
        ) {
            (Some(start), Some(end)) => {
                let start = parse_date(start, "from")?;
                let end = parse_date(end, "to")?;
                if start > end {
                    return Err("`from` must not be after `to`".to_string());
                }
                RangeArg::Custom {
                    start: start.to_string(),
                    end: end.to_string(),
                }
            }
            (None, None) => {
                let range = optional_str(arguments, "range")?.unwrap_or("today");
                if !["today", "week", "month", "year", "all"].contains(&range) {
                    return Err(format!(
                        "invalid range `{range}`: use today, week, month, year or all"
                    ));
                }
                RangeArg::Named(range.to_string())
            }
            _ => return Err("`from` and `to` must be given together".to_string()),
        };
        let by = match optional_str(arguments, "by")? {
            None => None,
            Some("agent") => Some(UsageGroup::Agent),
            Some("model") => Some(UsageGroup::Model),
            Some("account") => Some(UsageGroup::Account),
            Some(other) => {
                return Err(format!("invalid by `{other}`: use agent, model or account"))
            }
        };
        let usage = UsageArgs {
            range,
            by,
            tools: string_list(arguments, "agents")?,
            models: string_list(arguments, "models")?,
        };
        crate::cli::usage_json(self.app, &usage)
    }

    fn gateway(&self, arguments: &Map<String, Value>) -> Result<Value, String> {
        let limit = match arguments.get("limit") {
            None | Some(Value::Null) => GATEWAY_LIMIT_DEFAULT,
            Some(value) => value
                .as_u64()
                .filter(|limit| (1..=GATEWAY_LIMIT_MAX).contains(limit))
                .ok_or_else(|| {
                    format!("`limit` must be an integer from 1 to {GATEWAY_LIMIT_MAX}")
                })?,
        };
        crate::cli::gateway_json(
            self.app,
            &GatewayArgs {
                limit: limit as usize,
            },
            self.sources.probe_gateway,
        )
    }

    // ------------------------------------------------------------ prompts

    fn get_prompt(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params["name"]
            .as_str()
            .ok_or((INVALID_PARAMS, "missing prompt name".to_string()))?;
        if name != "pace_usage" {
            return Err((INVALID_PARAMS, format!("unknown prompt: {name}")));
        }
        let threshold = match &params["arguments"]["threshold"] {
            Value::Null => Some(PACE_THRESHOLD_DEFAULT),
            // 规范里提示词参数都是字符串；数字也收。
            Value::String(text) => text.trim().parse::<f64>().ok(),
            Value::Number(number) => number.as_f64(),
            _ => None,
        }
        .filter(|value| (1.0..=90.0).contains(value))
        .ok_or((
            INVALID_PARAMS,
            "threshold must be a number from 1 to 90".to_string(),
        ))?;
        let quota = (self.sources.quota)(self.app);
        let status =
            crate::cli::status_from(self.app, Some(&quota)).map_err(|error| (-32603, error))?;
        let text = pace_text(&status, &status["quota"], threshold);
        Ok(json!({
            "description": "Usage pacing guidance based on current quota and budget",
            "messages": [{
                "role": "user",
                "content": { "type": "text", "text": text },
            }],
        }))
    }
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

fn initialize_result(params: &Value) -> Value {
    let requested = params["protocolVersion"].as_str().unwrap_or_default();
    let version = PROTOCOL_VERSIONS
        .iter()
        .find(|version| **version == requested)
        .copied()
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": {
            "tools": { "listChanged": false },
            "prompts": { "listChanged": false },
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "title": "TokenLedger",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": INSTRUCTIONS,
    })
}

fn tool_result(value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value,
        "isError": false,
    })
}

fn read_only(open_world: bool) -> Value {
    json!({
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": open_world,
    })
}

fn no_arguments() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

pub(crate) fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "get_status",
            "title": "Usage overview",
            "description": "One-call overview: today's effective tokens and estimated cost, the budget closest to its limit, and the quota window with the least remaining.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "includeQuota": {
                        "type": "boolean",
                        "description": "Also read quota sources (default true). Set false for a faster answer.",
                    },
                },
                "additionalProperties": false,
            },
            "annotations": read_only(true),
        }),
        json!({
            "name": "get_usage",
            "title": "Token usage",
            "description": "Token usage totals for a period (today by default), optionally broken down by agent, model or account. Effective tokens = input + output; cached tokens are separate.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "range": {
                        "type": "string",
                        "enum": ["today", "week", "month", "year", "all"],
                        "description": "Named period in local time. week = this calendar week. Ignored when from/to are set.",
                    },
                    "from": { "type": "string", "format": "date", "description": "Start date YYYY-MM-DD (inclusive); requires `to`." },
                    "to": { "type": "string", "format": "date", "description": "End date YYYY-MM-DD (inclusive); requires `from`." },
                    "by": {
                        "type": "string",
                        "enum": ["agent", "model", "account"],
                        "description": "Break down the totals. account only covers requests through the local gateway and imports.",
                    },
                    "agents": { "type": "array", "items": { "type": "string" }, "description": "Only these agent ids, e.g. codex, claude." },
                    "models": { "type": "array", "items": { "type": "string" }, "description": "Only these model names." },
                },
                "additionalProperties": false,
            },
            "annotations": read_only(false),
        }),
        json!({
            "name": "get_quota",
            "title": "Quota remaining",
            "description": "Remaining subscription and balance quota per window, from the sources the user authorized in TokenLedger settings, plus the tightest window. Call before long or expensive work.",
            "inputSchema": no_arguments(),
            "annotations": read_only(true),
        }),
        json!({
            "name": "get_budget",
            "title": "Budget status",
            "description": "Status of each budget the user set: spent, limit, percent used and level (ok, warn, exceeded).",
            "inputSchema": no_arguments(),
            "annotations": read_only(false),
        }),
        json!({
            "name": "get_gateway",
            "title": "Gateway health and routing",
            "description": "Whether the local TokenLedger gateway is running, provider and routing group counts, and the most recent routing results (provider, model, status, latency, tokens). No request or response content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": GATEWAY_LIMIT_MAX,
                        "description": "How many recent requests to return (default 10).",
                    },
                },
                "additionalProperties": false,
            },
            "annotations": read_only(false),
        }),
        json!({
            "name": "get_anomalies",
            "title": "Usage anomalies",
            "description": "Unusual usage found by the same rules as the desktop app: token or cost spikes, cache hit drops, agent or model surges, expensive sessions and gateway error bursts, plus which checks had enough history to run.",
            "inputSchema": no_arguments(),
            "annotations": read_only(false),
        }),
    ]
}

pub(crate) fn prompt_definitions() -> Vec<Value> {
    vec![json!({
        "name": "pace_usage",
        "title": "Pace usage by quota",
        "description": "Reads the current quota and budget and tells the agent whether to work normally or conserve tokens.",
        "arguments": [{
            "name": "threshold",
            "description": "Remaining quota percent at or below which to conserve (default 20).",
            "required": false,
        }],
    })]
}

// ---------------------------------------------------------------- 参数

fn optional_str<'v>(
    arguments: &'v Map<String, Value>,
    key: &str,
) -> Result<Option<&'v str>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.as_str())),
        Some(_) => Err(format!("`{key}` must be a string")),
    }
}

fn optional_bool(arguments: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(format!("`{key}` must be a boolean")),
    }
}

fn string_list(arguments: &Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("`{key}` must be a list of strings"))
            })
            .collect(),
        Some(_) => Err(format!("`{key}` must be a list of strings")),
    }
}

fn parse_date(text: &str, key: &str) -> Result<chrono::NaiveDate, String> {
    chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .map_err(|_| format!("`{key}` must be a date like 2026-10-01"))
}

// ---------------------------------------------------------------- 额度

/// 额度的对外视图：只留数字、单位、重置时间与状态。
/// 去掉账号标签（可能是邮箱）与动作（可能是命令或链接）；最紧的窗口与状态栏摘要同一算法。
pub(crate) fn quota_view(quota: &Value) -> Value {
    const WINDOW_KEYS: [&str; 11] = [
        "windowId",
        "windowLabel",
        "status",
        "unit",
        "used",
        "limit",
        "remaining",
        "currency",
        "windowMinutes",
        "resetsAt",
        "observedAt",
    ];
    let providers: Vec<Value> = quota["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|provider| {
            let windows: Vec<Value> = provider["windows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|window| {
                    let mut out = Map::new();
                    for key in WINDOW_KEYS {
                        if let Some(value) = window.get(key).filter(|value| !value.is_null()) {
                            out.insert(key.to_string(), value.clone());
                        }
                    }
                    if let Some(percent) = crate::cli::window_remaining_percent(window) {
                        out.insert("remainingPercent".to_string(), json!(percent));
                    }
                    Value::Object(out)
                })
                .collect();
            let mut out = json!({
                "providerId": provider["providerId"],
                "displayName": provider["displayName"],
                "status": provider["status"],
                "windows": windows,
            });
            if let Some(reason) = provider.get("reasonCode").filter(|value| !value.is_null()) {
                out["reasonCode"] = reason.clone();
            }
            out
        })
        .collect();
    json!({
        "schemaVersion": crate::cli::SCHEMA_VERSION,
        "command": "quota",
        "providers": providers,
        "tightest": crate::cli::tightest_quota_window(quota),
    })
}

// ---------------------------------------------------------------- 异常

fn anomalies_report(app: &AppContext) -> Result<Value, String> {
    let report = crate::usage_anomaly::evaluate_local(app, chrono::Local::now())?;
    let value = serde_json::to_value(report).map_err(|error| error.to_string())?;
    Ok(anomalies_view(value))
}

/// 会话类发现的 subject 是原始会话 ID，不对外输出；Agent 仍保留在 `tool`。
pub(crate) fn anomalies_view(mut report: Value) -> Value {
    if let Some(findings) = report["findings"].as_array_mut() {
        for finding in findings {
            if finding["granularity"] == json!("session") {
                if let Some(object) = finding.as_object_mut() {
                    object.remove("subject");
                    object.remove("id");
                }
            }
        }
    }
    report["schemaVersion"] = json!(crate::cli::SCHEMA_VERSION);
    report["command"] = json!("anomalies");
    report
}

// ---------------------------------------------------------------- 节制提示

/// 按最紧的额度窗口与预算给出节制建议。阈值以下为 conserve，两倍阈值以下为 watch。
pub(crate) fn pace_text(status: &Value, tightest_quota: &Value, threshold: f64) -> String {
    let quota_left = tightest_quota["remainingPercent"].as_f64();
    let budget = &status["budget"];
    let budget_level = budget["level"].as_str().unwrap_or("ok");
    let budget_percent = budget["percent"].as_f64();

    let level = if quota_left.is_some_and(|left| left <= threshold) || budget_level == "exceeded" {
        "conserve"
    } else if quota_left.is_some_and(|left| left <= threshold * 2.0) || budget_level == "warn" {
        "watch"
    } else {
        "normal"
    };

    let mut facts = Vec::new();
    if let Some(left) = quota_left {
        let reset = tightest_quota["resetsAt"]
            .as_str()
            .map(|at| format!(", resets at {at}"))
            .unwrap_or_default();
        facts.push(format!(
            "- Tightest quota window: {} {} has {left:.0}% left{reset}.",
            tightest_quota["provider"].as_str().unwrap_or("unknown"),
            tightest_quota["window"].as_str().unwrap_or(""),
        ));
    } else {
        facts.push("- No quota window with a known remaining percent.".to_string());
    }
    if let Some(percent) = budget_percent {
        facts.push(format!(
            "- Tightest budget: {percent:.0}% used (level {budget_level})."
        ));
    } else {
        facts.push("- No budget is set.".to_string());
    }
    if let Some(text) = status["text"].as_str() {
        facts.push(format!("- Summary: {text}"));
    }

    let advice = match level {
        "conserve" => "Quota or budget is tight. Until it resets:\n\
- Tell the user up front that quota is low and confirm before starting large or open-ended work.\n\
- Prefer targeted reads (search, line ranges) over reading whole files or directories.\n\
- Avoid repeating long outputs, regenerating whole files, or speculative exploration.\n\
- Batch related edits, keep answers short, and stop at a good checkpoint rather than mid-change.\n\
- Do not spawn subagents or parallel runs unless the user asks.",
        "watch" => "Quota or budget is getting low. Work normally but economically:\n\
- Keep context small: read only what the task needs.\n\
- Mention remaining quota to the user before a long task, and check get_status again after it.",
        _ => "Quota and budget are healthy. Work normally; call get_status again before a very long task.",
    };

    format!(
        "TokenLedger usage pacing (threshold {threshold:.0}% remaining). Level: {level}.\n{}\n\n{advice}",
        facts.join("\n")
    )
}

#[cfg(test)]
mod tests;
