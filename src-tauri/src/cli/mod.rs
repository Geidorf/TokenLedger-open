//! `tokenledger-cli`：给终端、脚本与状态栏插件用的命令行入口。
//!
//! 只做参数解析与排版，数字一律取自桌面端同一套实现：用量来自本机 Stats v2
//! （`get_local_stats_v2_impl`，与看板、托盘、预算同口径），额度来自本机额度来源
//! （与看板冷启动同一路径，只走用户在设置里已授权的来源），预算复用预算页的评估，
//! 网关读本机网关的配置与账本，扫描复用同一个扫描器，导出复用「导出 CSV」的列与估价。
//! 不读任何订阅凭据，不调用未公开接口，也不往云端推送。
//!
//! 每个命令都支持 `--json`，输出带 `schemaVersion`，字段说明见 docs/cli.md。

mod args;
mod render;

use std::io::Write;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::app_paths::AppContext;
use crate::commands::{LedgerExportFormat, LocalStatsQuery};
use args::{Command, ExportArgs, GatewayArgs, Invocation, RangeArg, UsageArgs, UsageGroup};
use render::{fmt_cost, fmt_percent, fmt_tokens, Align, Table};

/// 命令行 JSON 输出的版本。只做向后兼容的新增；改名或删字段要升版本。
pub const SCHEMA_VERSION: u32 = 1;

const EXIT_OK: i32 = 0;
const EXIT_FAILURE: i32 = 1;
const EXIT_USAGE: i32 = 2;

/// 命令行入口：解析 `args`（不含程序名），把结果写到标准输出，返回进程退出码。
pub fn run_cli(args: Vec<String>) -> i32 {
    let invocation = match args::parse(&args) {
        Ok(invocation) => invocation,
        Err(error) => {
            eprintln!("tokenledger-cli: {error}");
            eprintln!("运行 `tokenledger-cli help` 查看用法。");
            return EXIT_USAGE;
        }
    };
    let json_mode = invocation.json;
    match invocation.command {
        Command::Help => {
            print!("{}", args::HELP);
            return EXIT_OK;
        }
        Command::Version => {
            println!("tokenledger-cli {}", env!("CARGO_PKG_VERSION"));
            return EXIT_OK;
        }
        _ => {}
    }
    let app = AppContext::new();
    match execute(&app, &invocation) {
        Ok(output) => {
            let mut stdout = std::io::stdout().lock();
            match stdout
                .write_all(output.as_bytes())
                .and_then(|()| stdout.flush())
            {
                Ok(()) => EXIT_OK,
                // 管道被下游提前关掉（例如 `| head`）不算失败。
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => EXIT_OK,
                // 磁盘满等写入失败要报出来，脚本才分得清导出是否完整。
                Err(error) => {
                    eprintln!("tokenledger-cli: 写入标准输出失败：{error}");
                    EXIT_FAILURE
                }
            }
        }
        Err(error) => {
            if json_mode {
                println!(
                    "{}",
                    json!({ "schemaVersion": SCHEMA_VERSION, "error": error })
                );
            }
            eprintln!("tokenledger-cli: {error}");
            EXIT_FAILURE
        }
    }
}

/// 执行一条命令，返回要写到标准输出的全部文本（测试直接调用这里）。
pub(crate) fn execute(app: &AppContext, invocation: &Invocation) -> Result<String, String> {
    let json_mode = invocation.json;
    match &invocation.command {
        Command::Usage(usage) => {
            let value = usage_json(app, usage)?;
            Ok(if json_mode {
                to_json_text(&value)
            } else {
                render_usage(&value)
            })
        }
        Command::Quota => {
            let value = quota_json(app);
            Ok(if json_mode {
                to_json_text(&value)
            } else {
                render_quota(&value)
            })
        }
        Command::Budget => {
            let value = budget_json(app)?;
            Ok(if json_mode {
                to_json_text(&value)
            } else {
                render_budget(&value)
            })
        }
        Command::Gateway(gateway) => {
            let value = gateway_json(app, gateway, probe_gateway)?;
            Ok(if json_mode {
                to_json_text(&value)
            } else {
                render_gateway(&value)
            })
        }
        Command::Scan => {
            let value = scan_json(app)?;
            Ok(if json_mode {
                to_json_text(&value)
            } else {
                render_scan(&value)
            })
        }
        Command::Export(export) => run_export(app, export, json_mode),
        Command::Status { quota } => {
            let value = status_json(app, *quota)?;
            Ok(if json_mode {
                to_json_text(&value)
            } else {
                format!("{}\n", value["text"].as_str().unwrap_or_default())
            })
        }
        Command::Help | Command::Version => Ok(String::new()),
    }
}

fn to_json_text(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text
}

fn stats_query(range: &RangeArg, tools: &[String], models: &[String]) -> LocalStatsQuery {
    let (range, start, end) = match range {
        RangeArg::Named(name) => (name.clone(), None, None),
        RangeArg::Custom { start, end } => {
            ("custom".to_string(), Some(start.clone()), Some(end.clone()))
        }
    };
    let list = |values: &[String]| (!values.is_empty()).then(|| values.to_vec());
    LocalStatsQuery {
        range,
        timezone: "local".to_string(),
        machines: None,
        machine: None,
        tools: list(tools),
        tool: None,
        models: list(models),
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
        start,
        end,
    }
}

fn local_stats(app: &AppContext, query: LocalStatsQuery) -> Result<Value, String> {
    crate::commands::get_local_stats_v2_impl(app, query)
}

// ---------------------------------------------------------------- usage

fn summary_json(stats: &Value) -> Value {
    let summary = &stats["summary"];
    let pick = |key: &str| summary.get(key).cloned().unwrap_or(Value::Null);
    let mut out = json!({
        "totalTokens": pick("totalTokens"),
        "inputTokens": pick("inputTokens"),
        "outputTokens": pick("outputTokens"),
        "cachedTokens": pick("cachedTokens"),
        "totalCost": pick("totalCost"),
        "totalRequests": pick("totalRequests"),
    });
    // 读写缓存拆分只在来源能证明时才有（契约 §2），缺失就不输出，不补 0。
    for key in ["cacheReadTokens", "cacheWriteTokens"] {
        if let Some(value) = summary.get(key) {
            out[key] = value.clone();
        }
    }
    out
}

fn group_rows(stats: &Value, group: UsageGroup) -> Option<Vec<Value>> {
    let object = stats.get(group.stats_key())?.as_object()?;
    let mut rows: Vec<Value> = object
        .iter()
        .map(|(id, row)| {
            let name = match group {
                UsageGroup::Agent => crate::wallpaper::tool_display_name(id),
                _ => id.clone(),
            };
            json!({
                "id": id,
                "name": name,
                "totalTokens": row.get("total").cloned().unwrap_or(Value::Null),
                "inputTokens": row.get("input").cloned().unwrap_or(Value::Null),
                "outputTokens": row.get("output").cloned().unwrap_or(Value::Null),
                "cachedTokens": row.get("cached").cloned().unwrap_or(Value::Null),
                "cost": row.get("cost").cloned().unwrap_or(Value::Null),
                "requests": row.get("requests").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        let total = |row: &Value| row["totalTokens"].as_f64().unwrap_or(0.0);
        total(b)
            .partial_cmp(&total(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    Some(rows)
}

pub(crate) fn usage_json(app: &AppContext, usage: &UsageArgs) -> Result<Value, String> {
    let stats = local_stats(app, stats_query(&usage.range, &usage.tools, &usage.models))?;
    let meta = &stats["meta"];
    let mut out = json!({
        "schemaVersion": SCHEMA_VERSION,
        "command": "usage",
        "range": meta.get("range").cloned().unwrap_or(Value::Null),
        "timezone": meta.get("timezone").cloned().unwrap_or(Value::Null),
        "generatedAt": meta.get("generatedAt").cloned().unwrap_or(Value::Null),
        "summary": summary_json(&stats),
    });
    if let RangeArg::Custom { start, end } = &usage.range {
        out["start"] = json!(start);
        out["end"] = json!(end);
    }
    if !usage.tools.is_empty() || !usage.models.is_empty() {
        out["filters"] = json!({ "agents": usage.tools, "models": usage.models });
    }
    if let Some(group) = usage.by {
        let rows = group_rows(&stats, group);
        out["breakdown"] = json!({
            "by": group.as_str(),
            // 账号维度只在本机网关账本存在时才有；缺失表示不可用，不是 0。
            "available": rows.is_some(),
            "rows": rows.unwrap_or_default(),
        });
    }
    Ok(out)
}

fn range_label(value: &Value) -> String {
    match value["range"].as_str().unwrap_or_default() {
        "today" => "今日".to_string(),
        "week" => "本周".to_string(),
        "month" => "本月".to_string(),
        "year" => "今年".to_string(),
        "all" => "全部".to_string(),
        "custom" => format!(
            "{} 至 {}",
            value["start"].as_str().unwrap_or("?"),
            value["end"].as_str().unwrap_or("?")
        ),
        other => other.to_string(),
    }
}

fn render_usage(value: &Value) -> String {
    let summary = &value["summary"];
    let mut out = String::new();
    out.push_str(&format!(
        "{}用量（{}）\n",
        range_label(value),
        value["timezone"].as_str().unwrap_or("local")
    ));
    let mut table = Table::new(&[("指标", Align::Left), ("数值", Align::Right)]);
    table.row(vec!["Token".into(), fmt_tokens(&summary["totalTokens"])]);
    table.row(vec!["  输入".into(), fmt_tokens(&summary["inputTokens"])]);
    table.row(vec!["  输出".into(), fmt_tokens(&summary["outputTokens"])]);
    table.row(vec!["缓存".into(), fmt_tokens(&summary["cachedTokens"])]);
    if summary.get("cacheReadTokens").is_some() {
        table.row(vec![
            "  读缓存".into(),
            fmt_tokens(&summary["cacheReadTokens"]),
        ]);
        table.row(vec![
            "  写缓存".into(),
            fmt_tokens(&summary["cacheWriteTokens"]),
        ]);
    }
    table.row(vec!["预估费用".into(), fmt_cost(&summary["totalCost"])]);
    table.row(vec!["请求数".into(), fmt_tokens(&summary["totalRequests"])]);
    out.push_str(&table.render());

    if let Some(breakdown) = value.get("breakdown") {
        let label = match breakdown["by"].as_str() {
            Some("agent") => "Agent",
            Some("model") => "模型",
            _ => "账号",
        };
        out.push('\n');
        if breakdown["available"] != json!(true) {
            out.push_str(&format!(
                "按{label}拆分不可用：账号来自本机网关账本，没有网关记录时无法拆分。\n"
            ));
            return out;
        }
        let rows = breakdown["rows"].as_array().cloned().unwrap_or_default();
        if rows.is_empty() {
            out.push_str(&format!("按{label}拆分：这段时间没有记录。\n"));
            return out;
        }
        let mut table = Table::new(&[
            (label, Align::Left),
            ("Token", Align::Right),
            ("输入", Align::Right),
            ("输出", Align::Right),
            ("缓存", Align::Right),
            ("费用", Align::Right),
            ("请求", Align::Right),
        ]);
        for row in &rows {
            table.row(vec![
                row["name"].as_str().unwrap_or_default().to_string(),
                fmt_tokens(&row["totalTokens"]),
                fmt_tokens(&row["inputTokens"]),
                fmt_tokens(&row["outputTokens"]),
                fmt_tokens(&row["cachedTokens"]),
                fmt_cost(&row["cost"]),
                fmt_tokens(&row["requests"]),
            ]);
        }
        out.push_str(&table.render());
        if breakdown["by"] == json!("account") {
            out.push_str("注：只统计经本机网关与导入的记录，扫描记录没有账号，合计可小于总量。\n");
        }
    }
    out
}

// ---------------------------------------------------------------- quota

fn quota_json(app: &AppContext) -> Value {
    let providers =
        tauri::async_runtime::block_on(crate::quota::get_local_quota_providers_impl(app));
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "command": "quota",
        "providers": providers,
    })
}

/// 百分比窗口的剩余百分比；其他单位返回 `None`。
fn window_remaining_percent(window: &Value) -> Option<f64> {
    if window["unit"] != json!("percent") {
        return None;
    }
    if let Some(remaining) = window["remaining"].as_f64() {
        return Some(remaining);
    }
    window["used"].as_f64().map(|used| (100.0 - used).max(0.0))
}

fn window_remaining_text(window: &Value) -> String {
    if let Some(percent) = window_remaining_percent(window) {
        return format!("{} 剩余", fmt_percent(percent));
    }
    if window["reasonCode"] == json!("credits_unlimited") {
        return "无限".to_string();
    }
    let unit = match window["unit"].as_str().unwrap_or_default() {
        "usd" => "USD".to_string(),
        "currency" => window["currency"].as_str().unwrap_or_default().to_string(),
        "credits" => "Credits".to_string(),
        "requests" => "次".to_string(),
        "tokens" => "Token".to_string(),
        other => other.to_string(),
    };
    match (window["remaining"].as_f64(), window["limit"].as_f64()) {
        (Some(remaining), Some(limit)) => {
            format!("{} / {} {unit}", trim_number(remaining), trim_number(limit))
        }
        (Some(remaining), None) => format!("{} {unit}", trim_number(remaining)),
        _ => "—".to_string(),
    }
}

fn trim_number(value: f64) -> String {
    if value.fract().abs() < 1e-9 {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}

fn status_label(status: &str) -> &str {
    match status {
        "ok" => "正常",
        "stale" => "过期",
        "auth-required" => "未授权",
        "unsupported" => "不支持",
        "error" => "出错",
        other => other,
    }
}

fn render_quota(value: &Value) -> String {
    let providers = value["providers"].as_array().cloned().unwrap_or_default();
    if providers.is_empty() {
        return "没有可用的额度来源。可在桌面端「设置 · 订阅额度」里开启。\n".to_string();
    }
    let mut table = Table::new(&[
        ("来源", Align::Left),
        ("窗口", Align::Left),
        ("剩余", Align::Right),
        ("重置时间", Align::Left),
        ("状态", Align::Left),
    ]);
    for provider in &providers {
        let name = provider["displayName"].as_str().unwrap_or_default();
        let windows = provider["windows"].as_array().cloned().unwrap_or_default();
        if windows.is_empty() {
            table.row(vec![
                name.to_string(),
                "—".into(),
                "—".into(),
                "—".into(),
                status_label(provider["status"].as_str().unwrap_or_default()).to_string(),
            ]);
            continue;
        }
        for window in &windows {
            let label = match window["accountLabel"].as_str() {
                Some(account) => format!(
                    "{} · {account}",
                    window["windowLabel"].as_str().unwrap_or_default()
                ),
                None => window["windowLabel"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            };
            table.row(vec![
                name.to_string(),
                label,
                window_remaining_text(window),
                render::fmt_local_time(window["resetsAt"].as_str()),
                status_label(window["status"].as_str().unwrap_or_default()).to_string(),
            ]);
        }
    }
    table.render()
}

// ---------------------------------------------------------------- budget

fn budget_json(app: &AppContext) -> Result<Value, String> {
    let settings = crate::budget::load_settings(app.app_data_dir());
    let report = crate::budget::evaluate_report(app, &settings);
    let rules: Map<String, Value> = settings
        .rules
        .iter()
        .map(|rule| {
            (
                rule.id.clone(),
                serde_json::to_value(rule).unwrap_or(Value::Null),
            )
        })
        .collect();
    let statuses: Vec<Value> = report
        .statuses
        .iter()
        .map(|status| {
            let mut value = serde_json::to_value(status).unwrap_or(Value::Null);
            if let Some(rule) = rules.get(&status.rule_id) {
                for key in ["period", "metric", "scopeKind", "scopeId", "warnPercent"] {
                    value[key] = rule[key].clone();
                }
            }
            value
        })
        .collect();
    Ok(json!({
        "schemaVersion": SCHEMA_VERSION,
        "command": "budget",
        "generatedAt": report.generated_at,
        "statuses": statuses,
    }))
}

fn budget_scope_label(status: &Value) -> String {
    let id = status["scopeId"].as_str().unwrap_or_default();
    match status["scopeKind"].as_str().unwrap_or_default() {
        "all" => "全部用量".to_string(),
        "tool" => format!("Agent · {}", crate::wallpaper::tool_display_name(id)),
        "model" => format!("模型 · {id}"),
        "provider" => format!("账号 · {id}"),
        other => other.to_string(),
    }
}

fn level_label(level: &str) -> &str {
    match level {
        "ok" => "正常",
        "warn" => "接近上限",
        "over" => "已超出",
        "unavailable" => "不可用",
        other => other,
    }
}

fn render_budget(value: &Value) -> String {
    let statuses = value["statuses"].as_array().cloned().unwrap_or_default();
    if statuses.is_empty() {
        return "还没有启用的预算。可在桌面端「设置 · 预算」里添加。\n".to_string();
    }
    let mut table = Table::new(&[
        ("预算", Align::Left),
        ("周期", Align::Left),
        ("已用", Align::Right),
        ("上限", Align::Right),
        ("比例", Align::Right),
        ("状态", Align::Left),
    ]);
    for status in &statuses {
        let period = match status["period"].as_str().unwrap_or_default() {
            "day" => "今日",
            "week" => "本周",
            "month" => "本月",
            other => other,
        };
        let is_cost = status["metric"] == json!("cost");
        let amount = |value: &Value| {
            if value.is_null() {
                "—".to_string()
            } else if is_cost {
                fmt_cost(value)
            } else {
                fmt_tokens(value)
            }
        };
        table.row(vec![
            budget_scope_label(status),
            period.to_string(),
            amount(&status["used"]),
            amount(&status["limit"]),
            status["percent"]
                .as_f64()
                .map(fmt_percent)
                .unwrap_or_else(|| "—".to_string()),
            level_label(status["level"].as_str().unwrap_or_default()).to_string(),
        ]);
    }
    table.render()
}

// ---------------------------------------------------------------- gateway

/// 网关的密钥只给转发用；命令行只读配置与账本，从不读系统安全存储。
struct NoSecrets;

impl crate::gateway::SecretStore for NoSecrets {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    fn set(&self, _account: &str, _value: &str) -> Result<(), String> {
        Err("命令行不修改网关密钥".to_string())
    }
    fn delete(&self, _account: &str) -> Result<(), String> {
        Err("命令行不修改网关密钥".to_string())
    }
}

/// 探测本机网关是否在监听：只请求不需要 token 的 `/health`。
fn probe_gateway(port: u16) -> bool {
    use std::io::Read;
    use std::net::{SocketAddr, TcpStream};

    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::new();
    let _ = stream.take(4096).read_to_end(&mut response);
    let text = String::from_utf8_lossy(&response);
    text.starts_with("HTTP/1.1 200") && text.contains("tokenledger-gateway")
}

pub(crate) fn gateway_json(
    app: &AppContext,
    args: &GatewayArgs,
    probe: impl Fn(u16) -> bool,
) -> Result<Value, String> {
    let dir = app.app_data_dir().join("gateway");
    let port = crate::gateway::DEFAULT_PORT;
    let gateway = crate::gateway::Gateway::new(&dir, std::sync::Arc::new(NoSecrets), port);
    let status = gateway.status();
    let running = probe(port);
    let settings = crate::settings::load_settings(app);
    let groups = gateway.list_routing_groups();
    let recent: Vec<Value> = gateway
        .recent_requests(args.limit)?
        .into_iter()
        .map(|record| {
            // 只给路由结果：不输出会话、错误正文与上游地址。
            json!({
                "ts": record.ts,
                "agent": record.agent,
                "provider": record.provider,
                "model": record.requested_model,
                "upstreamModel": record.upstream_model,
                "group": record.group,
                "member": record.member,
                "status": record.status,
                "ok": record.ok,
                "latencyMs": record.latency_ms,
                "inputTokens": record.input,
                "outputTokens": record.output,
                "cacheReadTokens": record.cache_read,
                "cacheWriteTokens": record.cache_write,
            })
        })
        .collect();
    Ok(json!({
        "schemaVersion": SCHEMA_VERSION,
        "command": "gateway",
        "modelAccessEnabled": settings.model_access_enabled,
        "running": running,
        "port": port,
        "baseUrl": running.then(|| format!("http://127.0.0.1:{port}/v1")),
        "providerCount": status.provider_count,
        "enabledProviderCount": status.enabled_count,
        "routingGroupCount": groups.len(),
        "configError": status.error,
        "recent": recent,
    }))
}

fn render_gateway(value: &Value) -> String {
    let mut out = String::new();
    let state = if value["running"] == json!(true) {
        format!("运行中 {}", value["baseUrl"].as_str().unwrap_or_default())
    } else if value["modelAccessEnabled"] == json!(false) {
        "未开启（桌面端「模型接入」开关已关）".to_string()
    } else {
        "未运行（桌面端没有打开，或还没有启用的供应商）".to_string()
    };
    out.push_str(&format!("网关：{state}\n"));
    out.push_str(&format!(
        "供应商：{} 个（启用 {}） · 路由组：{} 个\n",
        value["providerCount"], value["enabledProviderCount"], value["routingGroupCount"]
    ));
    if let Some(error) = value["configError"].as_str() {
        out.push_str(&format!("配置读取出错：{error}\n"));
    }
    let recent = value["recent"].as_array().cloned().unwrap_or_default();
    out.push('\n');
    if recent.is_empty() {
        out.push_str("最近没有经过网关的请求。\n");
        return out;
    }
    let mut table = Table::new(&[
        ("时间", Align::Left),
        ("Agent", Align::Left),
        ("请求模型", Align::Left),
        ("实际路由", Align::Left),
        ("状态", Align::Right),
        ("耗时", Align::Right),
        ("Token", Align::Right),
    ]);
    for record in &recent {
        let route = match (record["member"].as_str(), record["group"].as_str()) {
            (Some(member), _) => member.to_string(),
            (None, _) => format!(
                "{}/{}",
                record["provider"].as_str().unwrap_or_default(),
                record["upstreamModel"].as_str().unwrap_or_default()
            ),
        };
        let tokens = record["inputTokens"].as_u64().unwrap_or(0)
            + record["outputTokens"].as_u64().unwrap_or(0);
        let status = if record["ok"] == json!(true) {
            record["status"].to_string()
        } else {
            format!("✗{}", record["status"])
        };
        table.row(vec![
            render::fmt_local_time(record["ts"].as_str()),
            record["agent"]
                .as_str()
                .map(crate::wallpaper::tool_display_name)
                .unwrap_or_else(|| "—".to_string()),
            record["model"].as_str().unwrap_or_default().to_string(),
            route,
            status,
            format!("{} ms", record["latencyMs"]),
            fmt_tokens(&json!(tokens)),
        ]);
    }
    out.push_str(&table.render());
    out
}

// ---------------------------------------------------------------- scan

fn scan_json(app: &AppContext) -> Result<Value, String> {
    let result = crate::commands::refresh_scan_with(app, false)?;
    let pick = |key: &str| result.get(key).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "schemaVersion": SCHEMA_VERSION,
        "command": "scan",
        "inserted": pick("inserted"),
        "message": pick("message"),
        "codexRebuildDeferred": pick("codexRebuildDeferred"),
        "discoveredPriceModels": pick("discoveredPriceModels"),
    }))
}

fn render_scan(value: &Value) -> String {
    let mut out = format!("扫描完成，新增 {} 条记录。\n", value["inserted"]);
    if value["codexRebuildDeferred"] == json!(true) {
        out.push_str(&format!(
            "{}\n",
            value["message"].as_str().unwrap_or_default()
        ));
    }
    if let Some(models) = value["discoveredPriceModels"].as_array() {
        if !models.is_empty() {
            out.push_str(&format!(
                "发现 {} 个价格表里没有的模型，已按兜底价估算，可在桌面端「设置 · 价格」核对。\n",
                models.len()
            ));
        }
    }
    out
}

// ---------------------------------------------------------------- export

fn run_export(app: &AppContext, export: &ExportArgs, json_mode: bool) -> Result<String, String> {
    let range = export
        .range
        .as_ref()
        .map(|range| stats_query(range, &[], &[]));
    let (body, count) = crate::commands::export_ledger_impl(app, range, export.format)?;
    let Some(path) = &export.output else {
        return Ok(
            if export.format == LedgerExportFormat::Json && !body.ends_with('\n') {
                format!("{body}\n")
            } else {
                body
            },
        );
    };
    std::fs::write(path, body.as_bytes()).map_err(|error| format!("写入 {path} 失败：{error}"))?;
    Ok(if json_mode {
        to_json_text(&json!({
            "schemaVersion": SCHEMA_VERSION,
            "command": "export",
            "path": path,
            "records": count,
        }))
    } else {
        format!("已导出 {count} 条记录到 {path}\n")
    })
}

// ---------------------------------------------------------------- status

/// 一行摘要，给状态栏插件：今日 Token 与费用、最紧的预算、最紧的额度窗口。
pub(crate) fn status_json(app: &AppContext, with_quota: bool) -> Result<Value, String> {
    let today = local_stats(app, stats_query(&RangeArg::Named("today".into()), &[], &[]))?;
    let summary = summary_json(&today);
    let budget = budget_json(app)?;
    let tightest_budget = budget["statuses"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|status| status["percent"].is_number())
        .max_by(|a, b| {
            a["percent"]
                .as_f64()
                .partial_cmp(&b["percent"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .cloned();

    let tightest_quota = if with_quota {
        let quota = quota_json(app);
        quota["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|provider| {
                let name = provider["displayName"].clone();
                provider["windows"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|window| window["status"] == json!("ok"))
                    .filter_map(move |window| {
                        window_remaining_percent(&window).map(|remaining| {
                            json!({
                                "provider": name.clone(),
                                "window": window["windowLabel"].clone(),
                                "remainingPercent": remaining,
                                "resetsAt": window.get("resetsAt").cloned().unwrap_or(Value::Null),
                            })
                        })
                    })
            })
            .min_by(|a, b| {
                a["remainingPercent"]
                    .as_f64()
                    .partial_cmp(&b["remainingPercent"].as_f64())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    } else {
        None
    };

    let mut parts = vec![format!(
        "今日 {} · {}",
        fmt_tokens(&summary["totalTokens"]),
        fmt_cost(&summary["totalCost"])
    )];
    if let Some(status) = &tightest_budget {
        parts.push(format!(
            "预算 {}",
            fmt_percent(status["percent"].as_f64().unwrap_or(0.0))
        ));
    }
    if let Some(window) = &tightest_quota {
        parts.push(format!(
            "{} {} 余 {}",
            window["provider"].as_str().unwrap_or_default(),
            window["window"].as_str().unwrap_or_default(),
            fmt_percent(window["remainingPercent"].as_f64().unwrap_or(0.0))
        ));
    }
    Ok(json!({
        "schemaVersion": SCHEMA_VERSION,
        "command": "status",
        "text": parts.join(" | "),
        "today": summary,
        "budget": tightest_budget,
        "quota": tightest_quota,
    }))
}

#[cfg(test)]
mod tests;
