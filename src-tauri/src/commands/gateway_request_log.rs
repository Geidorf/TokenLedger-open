//! 网关请求日志查看器的两个只读命令（docs/design/gateway-request-log-v1.md）：
//! 按筛选分页读取、按同一筛选导出 CSV。只读网关诊断日志与路由决策日志的元数据，
//! 费用按本机生效价格表估算，与用量页同一口径。

use std::fs;
use std::sync::Arc;

use serde_json::{json, Value};

use super::gateway_overlay::{model_name_for, tool_for_agent};
use super::price_memo::PriceMemo;
use super::{csv_field, load_prices};
use crate::app_paths::AppContext;
use crate::gateway::request_log::{self, RequestLogEntry, RequestLogPage, RequestLogQuery};
use crate::gateway::Gateway;

const EXPORT_FILE: &str = "tokenledger_gateway_requests.csv";
/// 导出条数上限：诊断日志最多约 32 MB，远低于这个数，只用来挡住异常。
const EXPORT_MAX_ROWS: usize = 200_000;

fn ensure_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("网关请求日志只允许主窗口调用。".to_string())
    }
}

/// 给每次尝试和整条请求填上预估费用（美元）。未知模型走工具兜底价或 `default`，
/// 与用量页一致，不会变成 0。
fn price_entries(entries: &mut [RequestLogEntry], prices: &Value) {
    let mut memo = PriceMemo::new(prices);
    for entry in entries {
        let tool = tool_for_agent(entry.agent.as_deref());
        let mut total = 0.0;
        for attempt in &mut entry.attempts {
            let tokens = [
                attempt.input,
                attempt.output,
                attempt.cache_read,
                attempt.cache_write,
            ];
            if tokens.iter().all(|value| *value == 0) {
                attempt.cost_usd = Some(0.0);
                continue;
            }
            let model = model_name_for(&attempt.upstream_model, &entry.requested_model);
            let to_i64 = |value: u64| i64::try_from(value).unwrap_or(i64::MAX);
            let cost = memo.rates(&tool, &model).cost(
                to_i64(attempt.input),
                to_i64(attempt.output),
                to_i64(attempt.cache_read),
                to_i64(attempt.cache_write),
            );
            attempt.cost_usd = cost.is_finite().then_some(cost);
            total += cost;
        }
        entry.cost_usd = total.is_finite().then_some(total);
    }
}

pub(crate) fn request_log_page(
    gateway: &Gateway,
    prices: &Value,
    query: &RequestLogQuery,
) -> Result<RequestLogPage, String> {
    let mut page = request_log::page(gateway.request_log_entries()?, query);
    price_entries(&mut page.entries, prices);
    Ok(page)
}

fn opt(value: Option<impl ToString>) -> String {
    value.map(|v| v.to_string()).unwrap_or_default()
}

/// 每条逻辑请求一行；尝试顺序与解释链压成一列，便于表格里筛。
pub(crate) fn request_log_csv(entries: &[RequestLogEntry]) -> String {
    let mut out = String::from(
        "started_at,finished_at,request_id,agent,session,endpoint,requested_model,group,provider,upstream_model,status,ok,latency_ms,first_token_ms,output_tokens_per_sec,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_cost_usd,retries,switched,attempts,route_reason,route_trace,error\n",
    );
    for entry in entries {
        let attempts = entry
            .attempts
            .iter()
            .map(|a| format!("{}/{}:{}", a.provider, a.upstream_model, a.status))
            .collect::<Vec<_>>()
            .join(" > ");
        let (reason, trace) = entry.decision.as_ref().map_or_else(
            || (String::new(), String::new()),
            |decision| {
                let trace = decision
                    .trace
                    .iter()
                    .map(|t| format!("{}={}[{}]", t.member, t.verdict, t.reasons.join("+")))
                    .collect::<Vec<_>>()
                    .join("; ");
                (decision.reason.clone(), trace)
            },
        );
        let fields = [
            entry.started_at.clone(),
            entry.ts.clone(),
            entry.id.clone(),
            opt(entry.agent.as_deref()),
            opt(entry.session.as_deref()),
            entry.endpoint.clone(),
            entry.requested_model.clone(),
            opt(entry.group.as_deref()),
            entry.provider.clone(),
            entry.upstream_model.clone(),
            entry.status.to_string(),
            entry.ok.to_string(),
            entry.latency_ms.to_string(),
            opt(entry.first_token_ms),
            opt(entry.output_tps.map(|tps| format!("{tps:.1}"))),
            entry.input.to_string(),
            entry.output.to_string(),
            entry.cache_read.to_string(),
            entry.cache_write.to_string(),
            opt(entry.cost_usd.map(|cost| format!("{cost:.6}"))),
            entry.retries.to_string(),
            entry.switched.to_string(),
            attempts,
            reason,
            trace,
            opt(entry.error.as_deref()),
        ];
        let line = fields
            .iter()
            .map(|field| csv_field(field))
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&line);
        out.push('\n');
    }
    out
}

pub(crate) fn export_request_log(
    app: &AppContext,
    gateway: &Gateway,
    query: &RequestLogQuery,
) -> Result<Value, String> {
    let mut entries = request_log::filter_all(gateway.request_log_entries()?, query);
    if entries.len() > EXPORT_MAX_ROWS {
        return Err("导出条数过多，请缩小时间范围或加筛选后再导出".to_string());
    }
    price_entries(&mut entries, &load_prices(app));
    let path = app.app_data_dir().join(EXPORT_FILE);
    // 加 BOM，Excel 直接打开时中文不乱码。
    let body = format!("\u{feff}{}", request_log_csv(&entries));
    fs::write(&path, body).map_err(|error| error.to_string())?;
    Ok(json!({
        "message": format!("已导出 {} 条请求", entries.len()),
        "path": path.to_string_lossy().to_string(),
    }))
}

/// 请求日志一页：筛选、搜索、分页，带每条的路由解释链与预估费用。仅主窗口。
#[tauri::command]
pub async fn gateway_request_log(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
    query: Option<RequestLogQuery>,
) -> Result<RequestLogPage, String> {
    ensure_main(&window)?;
    let app = state.inner().clone();
    let gateway = gateway.inner().clone();
    let query = query.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        request_log_page(&gateway, &load_prices(&app), &query)
    })
    .await
    .map_err(|error| format!("gateway_request_log task panicked: {error}"))?
}

/// 按当前筛选导出全部匹配请求到应用数据目录下的固定文件名。仅主窗口。
#[tauri::command]
pub async fn gateway_request_log_export(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppContext>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
    query: Option<RequestLogQuery>,
) -> Result<Value, String> {
    ensure_main(&window)?;
    let app = state.inner().clone();
    let gateway = gateway.inner().clone();
    let query = query.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || export_request_log(&app, &gateway, &query))
        .await
        .map_err(|error| format!("gateway_request_log_export task panicked: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::request_log::{RequestLogAttempt, StoredDecision, StoredTrace};

    fn entry() -> RequestLogEntry {
        let attempt = |provider: &str, status: u16, output: u64| RequestLogAttempt {
            ts: "2026-10-24T01:00:02Z".into(),
            request_id: format!("{provider}-a"),
            provider: provider.into(),
            upstream_model: "unknown-model-x".into(),
            member: None,
            status,
            ok: status == 200,
            latency_ms: 1000,
            first_token_ms: None,
            input: if output > 0 { 1_000_000 } else { 0 },
            output,
            cache_read: 0,
            cache_write: 0,
            error: None,
            cost_usd: None,
        };
        RequestLogEntry {
            id: "L1".into(),
            started_at: "2026-10-24T01:00:00+00:00".into(),
            ts: "2026-10-24T01:00:02Z".into(),
            agent: Some("codex".into()),
            session: Some("=cmd|' /C calc'!A0".into()),
            endpoint: "responses".into(),
            wire: "chat".into(),
            stream: true,
            requested_model: "group/fast".into(),
            group: Some("fast".into()),
            provider: "p2".into(),
            upstream_model: "unknown-model-x".into(),
            status: 200,
            ok: true,
            error: None,
            latency_ms: 2000,
            first_token_ms: Some(1200),
            output_tps: Some(625.0),
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 0,
            cache_write: 0,
            cost_usd: None,
            context: None,
            retries: 1,
            switched: true,
            attempts: vec![attempt("p1", 429, 0), attempt("p2", 200, 1_000_000)],
            decision: Some(StoredDecision {
                ts: "2026-10-24T01:00:02Z".into(),
                request_id: "L1".into(),
                group: "fast".into(),
                reason: "failover".into(),
                detail: String::new(),
                chosen: Some("p2/unknown-model-x".into()),
                attempts: vec![],
                trace: vec![StoredTrace {
                    member: "p1/unknown-model-x".into(),
                    rank: Some(0),
                    verdict: "failed".into(),
                    reasons: vec!["strategy_first".into(), "rate_limited".into()],
                    detail: None,
                }],
            }),
        }
    }

    #[test]
    fn unknown_models_are_priced_by_the_fallback_not_zero() {
        let mut entries = vec![entry()];
        price_entries(&mut entries, &json!({}));
        let entry = &entries[0];
        assert_eq!(entry.attempts[0].cost_usd, Some(0.0));
        // Fallback rates: 1 M input at 1.0 + 1 M output at 3.0.
        assert_eq!(entry.attempts[1].cost_usd, Some(4.0));
        assert_eq!(entry.cost_usd, Some(4.0));
    }

    #[test]
    fn csv_has_one_row_per_request_and_neutralizes_formulas() {
        let csv = request_log_csv(&[entry()]);
        let lines: Vec<_> = csv.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("started_at,finished_at,request_id"));
        assert!(lines[1].contains("p1/unknown-model-x:429 > p2/unknown-model-x:200"));
        assert!(lines[1].contains("p1/unknown-model-x=failed[strategy_first+rate_limited]"));
        assert!(lines[1].contains("\"'=cmd|"), "{}", lines[1]);
    }

    #[test]
    fn skipped_members_reach_the_export() {
        use crate::gateway::request_log::{group_records, StoredDecisionAttempt};
        use crate::gateway::LedgerRecord;
        let record: LedgerRecord = serde_json::from_value(json!({
            "ts": "2026-10-24T01:00:01Z", "requestId": "a1", "logicalRequestId": "L1",
            "agent": "codex", "session": null, "endpoint": "responses", "provider": "p1",
            "requestedModel": "group/fast", "upstreamModel": "m", "wire": "chat", "stream": true,
            "status": 503, "ok": false, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
            "latencyMs": 500, "error": "upstream", "group": "fast", "member": "p1/m"
        }))
        .unwrap();
        let mut decision = entry().decision.unwrap();
        decision.attempts = vec![
            StoredDecisionAttempt {
                member: "p1/m".into(),
                outcome: "failed".into(),
                status: Some(503),
                error: None,
            },
            StoredDecisionAttempt {
                member: "gone/m".into(),
                outcome: "skipped".into(),
                status: None,
                error: Some("gone".into()),
            },
        ];
        let mut entries = group_records(
            &[record],
            &std::collections::HashMap::from([("L1".to_string(), decision)]),
        );
        price_entries(&mut entries, &json!({}));
        let csv = request_log_csv(&entries);
        let row = csv.lines().nth(1).unwrap();
        assert!(row.contains("p1/m:503 > gone/m:404"), "{row}");
        assert!(row.contains(",gone,m,404,false,"), "{row}");
    }
}
