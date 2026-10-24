use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::Local;
use serde_json::{json, Value};

use super::*;
use crate::db;

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn test_app(label: &str) -> AppContext {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_mcp_{label}_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    let app = AppContext::for_test(path);
    db::init_db(&db::get_db_path(&app)).expect("init db");
    app
}

fn seed_today(app: &AppContext) {
    let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let conn = db::get_connection(&db::get_db_path(app)).unwrap();
    conn.execute_batch(&format!(
        "INSERT INTO token_logs(tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,session_id,unique_key,machine_id,cost_usd) VALUES
        ('codex','gpt-5',1000,200,50,0,'{now}','secret-session-1','k1','m',0.5),
        ('claude','claude-sonnet-4',300,100,0,0,'{now}','secret-session-2','k2','m',0.25);"
    ))
    .unwrap();
}

/// 额度：一个百分比窗口带账号标签和动作，用来确认脱敏。
fn fake_quota(_app: &AppContext) -> Value {
    json!({
        "providers": [{
            "providerId": "codex",
            "displayName": "Codex",
            "status": "ok",
            "action": { "kind": "show-command", "labelKey": "x", "value": "codex login" },
            "windows": [
                {
                    "providerId": "codex", "windowId": "5h", "windowLabel": "5 小时",
                    "accountLabel": "someone@example.com", "status": "ok", "unit": "percent",
                    "used": 85.0, "remaining": 15.0, "resetsAt": "2026-10-24T10:00:00Z",
                    "observedAt": "2026-10-24T05:00:00Z", "fetchedAt": "x", "staleAfterSeconds": 60,
                    "scope": "consumer-subscription", "source": "local-authorized"
                },
                {
                    "providerId": "codex", "windowId": "credits", "windowLabel": "Credits",
                    "status": "ok", "unit": "credits", "reasonCode": "credits_unlimited",
                    "observedAt": "2026-10-24T05:00:00Z"
                },
                {
                    "providerId": "codex", "windowId": "7d", "windowLabel": "7 天",
                    "status": "ok", "unit": "percent", "used": 40.0, "remaining": 60.0,
                    "observedAt": "2026-10-24T05:00:00Z"
                }
            ]
        }]
    })
}

fn no_gateway(_port: u16) -> bool {
    false
}

fn fake_anomalies(_app: &AppContext) -> Result<Value, String> {
    Ok(anomalies_view(json!({
        "findings": [
            { "id": "expensiveSession:2026-10-24:abc", "kind": "expensiveSession", "granularity": "session",
              "subject": "abc-session-id", "tool": "codex", "value": 9.0, "baseline": 1.0 },
            { "id": "toolSurge:2026-10-24:codex", "kind": "toolSurge", "granularity": "day",
              "subject": "codex", "value": 5000.0, "baseline": 1000.0 }
        ],
        "checks": []
    })))
}

fn server(app: &AppContext) -> Server<'_> {
    Server::with_sources(
        app,
        Sources {
            quota: fake_quota,
            probe_gateway: no_gateway,
            anomalies: fake_anomalies,
        },
    )
}

fn request(server: &mut Server<'_>, id: u64, method: &str, params: Value) -> Value {
    let line =
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
    server.handle_line(&line).expect("reply")
}

fn call(server: &mut Server<'_>, name: &str, arguments: Value) -> Value {
    let reply = request(
        server,
        9,
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
    );
    reply["result"].clone()
}

#[test]
fn initialize_negotiates_version_and_lists_capabilities() {
    let app = test_app("init");
    let mut server = server(&app);
    let reply = request(
        &mut server,
        1,
        "initialize",
        json!({ "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } }),
    );
    assert_eq!(reply["id"], json!(1));
    assert_eq!(reply["result"]["protocolVersion"], json!("2025-03-26"));
    assert!(reply["result"]["capabilities"]["tools"].is_object());
    assert!(reply["result"]["capabilities"]["prompts"].is_object());
    assert_eq!(reply["result"]["serverInfo"]["name"], json!("tokenledger"));

    let unknown = request(
        &mut server,
        2,
        "initialize",
        json!({ "protocolVersion": "1999-01-01" }),
    );
    assert_eq!(
        unknown["result"]["protocolVersion"],
        json!(PROTOCOL_VERSIONS[0])
    );

    // 通知不回。
    assert!(server
        .handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
        .is_none());
    assert_eq!(
        request(&mut server, 3, "ping", json!({}))["result"],
        json!({})
    );
}

#[test]
fn protocol_errors_use_json_rpc_codes() {
    let app = test_app("errors");
    let mut server = server(&app);
    assert_eq!(
        server.handle_line("{not json").unwrap()["error"]["code"],
        json!(PARSE_ERROR)
    );
    assert_eq!(
        request(&mut server, 1, "sampling/createMessage", json!({}))["error"]["code"],
        json!(METHOD_NOT_FOUND)
    );
    assert_eq!(
        request(&mut server, 2, "tools/call", json!({ "name": "scan" }))["error"]["code"],
        json!(INVALID_PARAMS)
    );
    assert!(server.handle_line("   ").is_none());
    // 客户端的响应忽略。
    assert!(server
        .handle_line(r#"{"jsonrpc":"2.0","id":5,"result":{}}"#)
        .is_none());
    let batch = server
        .handle_line(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]"#)
        .unwrap();
    assert_eq!(batch.as_array().map(Vec::len), Some(1));
}

#[test]
fn every_tool_is_read_only_and_has_an_object_schema() {
    let tools = tool_definitions();
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(
        names,
        [
            "get_status",
            "get_usage",
            "get_quota",
            "get_budget",
            "get_gateway",
            "get_anomalies"
        ]
    );
    for tool in &tools {
        assert_eq!(tool["annotations"]["readOnlyHint"], json!(true), "{tool}");
        assert_eq!(
            tool["annotations"]["destructiveHint"],
            json!(false),
            "{tool}"
        );
        assert_eq!(tool["inputSchema"]["type"], json!("object"), "{tool}");
    }
}

#[test]
fn usage_matches_cli_numbers_and_breakdown() {
    let app = test_app("usage");
    seed_today(&app);
    let mut server = server(&app);
    let result = call(
        &mut server,
        "get_usage",
        json!({ "range": "today", "by": "agent" }),
    );
    assert_eq!(result["isError"], json!(false));
    let usage = &result["structuredContent"];
    // 有效 Token = 输入 + 输出，缓存不并入。
    assert_eq!(usage["summary"]["totalTokens"], json!(1600));
    assert_eq!(usage["summary"]["cachedTokens"], json!(50));
    let rows = usage["breakdown"]["rows"].as_array().unwrap();
    assert_eq!(rows[0]["id"], json!("codex"));
    assert_eq!(rows[0]["totalTokens"], json!(1200));

    let cli = crate::cli::usage_json(
        &app,
        &UsageArgs {
            range: RangeArg::Named("today".into()),
            by: Some(UsageGroup::Agent),
            tools: vec![],
            models: vec![],
        },
    )
    .unwrap();
    assert_eq!(usage["summary"], cli["summary"]);
    assert_eq!(usage["breakdown"], cli["breakdown"]);

    // 文本内容就是同一份 JSON。
    let text = result["content"][0]["text"].as_str().unwrap();
    let parsed: Value = serde_json::from_str(text).unwrap();
    assert_eq!(&parsed, usage);
}

#[test]
fn usage_argument_errors_are_tool_errors() {
    let app = test_app("usage_args");
    let mut server = server(&app);
    for arguments in [
        json!({ "range": "decade" }),
        json!({ "from": "2026-10-01" }),
        json!({ "from": "2026-10-09", "to": "2026-10-01" }),
        json!({ "from": "10/01/2026", "to": "2026-10-02" }),
        json!({ "by": "machine" }),
        json!({ "agents": "codex" }),
    ] {
        let result = call(&mut server, "get_usage", arguments.clone());
        assert_eq!(result["isError"], json!(true), "{arguments}");
    }
    let custom = call(
        &mut server,
        "get_usage",
        json!({ "from": "2026-10-01", "to": "2026-10-07" }),
    );
    assert_eq!(custom["isError"], json!(false));
    assert_eq!(custom["structuredContent"]["start"], json!("2026-10-01"));
}

#[test]
fn quota_drops_account_labels_and_actions() {
    let app = test_app("quota");
    let mut server = server(&app);
    let result = call(&mut server, "get_quota", json!({}));
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(!text.contains("someone@example.com"));
    assert!(!text.contains("codex login"));
    assert!(!text.contains("accountLabel"));
    let quota = &result["structuredContent"];
    assert_eq!(
        quota["providers"][0]["windows"][0]["remainingPercent"],
        json!(15.0)
    );
    assert_eq!(quota["tightest"]["window"], json!("5 小时"));
    // 无限额度没有数字，只靠 reasonCode 表明，不能被去掉。
    assert_eq!(
        quota["providers"][0]["windows"][1]["reasonCode"],
        json!("credits_unlimited")
    );
    assert_eq!(quota["tightest"]["remainingPercent"], json!(15.0));
}

#[test]
fn status_and_gateway_never_expose_sessions() {
    let app = test_app("status");
    seed_today(&app);
    let mut server = server(&app);
    let status = call(&mut server, "get_status", json!({}));
    assert_eq!(
        status["structuredContent"]["today"]["totalTokens"],
        json!(1600)
    );
    assert_eq!(
        status["structuredContent"]["quota"]["remainingPercent"],
        json!(15.0)
    );
    let without = call(&mut server, "get_status", json!({ "includeQuota": false }));
    assert!(without["structuredContent"]["quota"].is_null());

    let gateway = call(&mut server, "get_gateway", json!({ "limit": 5 }));
    assert_eq!(gateway["isError"], json!(false));
    assert_eq!(gateway["structuredContent"]["running"], json!(false));
    assert_eq!(
        call(&mut server, "get_gateway", json!({ "limit": 0 }))["isError"],
        json!(true)
    );
    assert_eq!(
        call(&mut server, "get_gateway", json!({ "limit": 500 }))["isError"],
        json!(true)
    );

    for result in [&status, &gateway] {
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains("secret-session"), "{text}");
    }
}

#[test]
fn anomalies_hide_session_ids() {
    let app = test_app("anomalies");
    let mut server = server(&app);
    let result = call(&mut server, "get_anomalies", json!({}));
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(!text.contains("abc-session-id"));
    assert!(!text.contains("expensiveSession:2026-10-24:abc"));
    let findings = result["structuredContent"]["findings"].as_array().unwrap();
    assert_eq!(findings[0]["tool"], json!("codex"));
    assert_eq!(findings[1]["subject"], json!("codex"));
}

#[test]
fn real_anomaly_report_runs_on_an_empty_ledger() {
    let app = test_app("anomalies_real");
    let report = anomalies_report(&app).expect("report");
    assert!(report["findings"].as_array().is_some_and(Vec::is_empty));
    assert!(report["checks"].is_array());
}

#[test]
fn pace_prompt_levels_follow_threshold() {
    let app = test_app("pace");
    let mut server = server(&app);
    let listed = request(&mut server, 1, "prompts/list", json!({}));
    assert_eq!(listed["result"]["prompts"][0]["name"], json!("pace_usage"));

    let tight = request(
        &mut server,
        2,
        "prompts/get",
        json!({ "name": "pace_usage" }),
    );
    let text = tight["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(text.contains("Level: conserve"), "{text}");
    assert!(text.contains("15% left"), "{text}");

    let loose = request(
        &mut server,
        3,
        "prompts/get",
        json!({ "name": "pace_usage", "arguments": { "threshold": "5" } }),
    );
    let text = loose["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(text.contains("Level: normal"), "{text}");

    let watch = pace_text(&json!({}), &json!({ "remainingPercent": 30.0 }), 20.0);
    assert!(watch.contains("Level: watch"));
    // 用真实的序列化值，别和预算模块的枚举对不上。
    let over = serde_json::to_value(crate::budget::BudgetLevel::Over).unwrap();
    let budget = pace_text(
        &json!({ "budget": { "level": over, "percent": 120.0 } }),
        &Value::Null,
        20.0,
    );
    assert!(budget.contains("Level: conserve"));

    let bad = request(
        &mut server,
        4,
        "prompts/get",
        json!({ "name": "pace_usage", "arguments": { "threshold": "abc" } }),
    );
    assert_eq!(bad["error"]["code"], json!(INVALID_PARAMS));
}

#[test]
fn pacing_uses_the_most_severe_budget_not_the_fullest() {
    // 79% 但提醒线 80%，与 60% 但提醒线 50%：后者已到提醒线。
    let budget = json!({ "statuses": [
        { "ruleId": "a", "level": "ok", "percent": 79.0 },
        { "ruleId": "b", "level": "warn", "percent": 60.0 },
        { "ruleId": "c", "level": "unavailable" },
    ]});
    let pressing = most_pressing_budget(&budget);
    assert_eq!(pressing["ruleId"], json!("b"));
    let text = pace_text(&json!({ "budget": pressing }), &Value::Null, 20.0);
    assert!(text.contains("Level: watch"), "{text}");
    assert!(most_pressing_budget(&json!({ "statuses": [] })).is_null());
}
