use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{Duration, Local};
use serde_json::{json, Value};

use super::args::{parse, Command, GatewayArgs, Invocation, RangeArg, UsageArgs, UsageGroup};
use super::*;
use crate::db;

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn test_app(label: &str) -> (AppContext, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "tokenledger_cli_{label}_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    let app = AppContext::for_test(path.clone());
    db::init_db(&db::get_db_path(&app)).expect("init db");
    (app, path)
}

fn storage_time(offset: Duration) -> String {
    (Local::now() - offset)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

/// 今天两条（两个 Agent）、一年多前一条。
fn seed(app: &AppContext) {
    let conn = db::get_connection(&db::get_db_path(app)).unwrap();
    let now = storage_time(Duration::zero());
    let old = storage_time(Duration::days(400));
    conn.execute_batch(&format!(
        "INSERT INTO token_logs(tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,session_id,unique_key,machine_id,cost_usd) VALUES
        ('codex','gpt-5',1000,200,0,0,'{now}','s1','k1','m',0.5),
        ('claude','claude-sonnet-4',300,100,0,0,'{now}','s2','k2','m',0.25),
        ('codex','gpt-5',7,3,0,0,'{old}','s3','k3','m',0.01);"
    ))
    .unwrap();
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|value| value.to_string()).collect()
}

fn invocation(list: &[&str]) -> Invocation {
    parse(&args(list)).expect("parse")
}

#[test]
fn parses_commands_ranges_and_flags() {
    assert_eq!(invocation(&[]).command, Command::Help);
    let usage = invocation(&["usage", "week", "--by", "model", "--json"]);
    assert!(usage.json);
    assert_eq!(
        usage.command,
        Command::Usage(UsageArgs {
            range: RangeArg::Named("week".into()),
            by: Some(UsageGroup::Model),
            tools: vec![],
            models: vec![],
        })
    );
    let custom = invocation(&[
        "usage",
        "--from=2026-10-01",
        "--to",
        "2026-10-07",
        "--agent",
        "codex",
    ]);
    let Command::Usage(custom) = custom.command else {
        panic!("usage");
    };
    assert_eq!(
        custom.range,
        RangeArg::Custom {
            start: "2026-10-01".into(),
            end: "2026-10-07".into()
        }
    );
    assert_eq!(custom.tools, vec!["codex".to_string()]);
    assert_eq!(
        invocation(&["gateway", "-n", "3"]).command,
        Command::Gateway(GatewayArgs { limit: 3 })
    );
    assert_eq!(
        invocation(&["status", "--no-quota"]).command,
        Command::Status { quota: false }
    );
}

#[test]
fn rejects_bad_arguments() {
    for bad in [
        vec!["nope"],
        vec!["usage", "--by", "planet"],
        vec!["usage", "--from", "2026-10-01"],
        vec![
            "usage",
            "today",
            "--from",
            "2026-10-01",
            "--to",
            "2026-10-02",
        ],
        vec!["usage", "--from", "2026-10-05", "--to", "2026-10-01"],
        vec!["usage", "--from", "10/01/2026", "--to", "2026-10-02"],
        vec!["usage", "today", "week"],
        vec!["gateway", "--limit", "0"],
        vec!["export", "--format", "xml"],
        vec!["quota", "extra"],
    ] {
        assert!(parse(&args(&bad)).is_err(), "{bad:?} should be rejected");
    }
}

#[test]
fn usage_matches_dashboard_stats_and_splits_by_agent() {
    let (app, root) = test_app("usage");
    seed(&app);
    let usage = invocation(&["usage", "today", "--by", "agent", "--json"]);
    let Command::Usage(usage) = &usage.command else {
        panic!("usage");
    };
    let value = usage_json(&app, usage).unwrap();
    let stats = crate::commands::get_stats_impl(&app, "today".into()).unwrap();
    assert_eq!(value["schemaVersion"], json!(SCHEMA_VERSION));
    assert_eq!(value["range"], json!("today"));
    assert_eq!(
        value["summary"]["totalTokens"],
        stats["summary"]["totalTokens"]
    );
    assert_eq!(value["summary"]["totalTokens"], json!(1600));
    assert_eq!(value["summary"]["totalRequests"], json!(2));
    assert_eq!(value["summary"]["totalCost"], stats["summary"]["totalCost"]);
    let rows = value["breakdown"]["rows"].as_array().unwrap();
    assert_eq!(value["breakdown"]["available"], json!(true));
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], json!("codex"));
    assert_eq!(rows[0]["totalTokens"], json!(1200));

    let text = render_usage(&value);
    assert!(text.contains("今日用量"));
    assert!(text.contains("1.60K"));

    // 没有网关账本时账号维度不可用，而不是 0。
    let account = UsageArgs {
        by: Some(UsageGroup::Account),
        ..usage.clone()
    };
    let value = usage_json(&app, &account).unwrap();
    assert_eq!(value["breakdown"]["available"], json!(false));
    assert!(render_usage(&value).contains("不可用"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn usage_filters_by_agent() {
    let (app, root) = test_app("filter");
    seed(&app);
    let usage = UsageArgs {
        range: RangeArg::Named("all".into()),
        by: None,
        tools: vec!["codex".into()],
        models: vec![],
    };
    let value = usage_json(&app, &usage).unwrap();
    assert_eq!(value["summary"]["totalTokens"], json!(1210));
    assert_eq!(value["filters"]["agents"], json!(["codex"]));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn export_csv_and_json_share_columns_and_window() {
    let (app, root) = test_app("export");
    seed(&app);
    let (csv, count) =
        crate::commands::export_ledger_impl(&app, None, LedgerExportFormat::Csv).unwrap();
    assert_eq!(count, 3);
    assert!(csv.starts_with("id,tool,model,input_tokens"));
    assert_eq!(csv.lines().count(), 4);

    let today = stats_query(&RangeArg::Named("today".into()), &[], &[]);
    let (json_text, count) =
        crate::commands::export_ledger_impl(&app, Some(today), LedgerExportFormat::Json).unwrap();
    assert_eq!(count, 2);
    let items: Value = serde_json::from_str(&json_text).unwrap();
    let items = items.as_array().unwrap();
    assert_eq!(items.len(), 2);
    let header: Vec<&str> = csv.lines().next().unwrap().split(',').collect();
    let keys: Vec<&str> = items[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(header, keys);

    let output = root.join("out.csv");
    let export = invocation(&["export", "today", "--output", output.to_str().unwrap()]);
    let text = execute(&app, &export).unwrap();
    assert!(text.contains("已导出 2 条记录"));
    assert_eq!(fs::read_to_string(&output).unwrap().lines().count(), 3);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn budget_reports_rules_with_their_scope() {
    let (app, root) = test_app("budget");
    seed(&app);
    let settings: crate::budget::BudgetSettings = serde_json::from_value(json!({
        "notify": false,
        "rules": [{
            "id": "daily-tokens",
            "period": "day",
            "metric": "tokens",
            "scopeKind": "all",
            "limit": 2000,
            "warnPercent": 70
        }]
    }))
    .unwrap();
    crate::budget::save_settings(app.app_data_dir(), &settings).unwrap();
    let value = budget_json(&app).unwrap();
    let status = &value["statuses"][0];
    assert_eq!(status["ruleId"], json!("daily-tokens"));
    assert_eq!(status["used"], json!(1600.0));
    assert_eq!(status["percent"], json!(80.0));
    assert_eq!(status["level"], json!("warn"));
    assert_eq!(status["scopeKind"], json!("all"));
    assert!(render_budget(&value).contains("接近上限"));

    let status = status_json(&app, false).unwrap();
    assert_eq!(status["text"], json!("今日 1.60K · $0.75 | 预算 80%"));
    assert!(status["quota"].is_null());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn gateway_without_config_reports_stopped_and_empty() {
    let (app, root) = test_app("gateway");
    let value = gateway_json(&app, &GatewayArgs { limit: 5 }, |_| false).unwrap();
    assert_eq!(value["running"], json!(false));
    assert_eq!(value["baseUrl"], Value::Null);
    assert_eq!(value["providerCount"], json!(0));
    assert_eq!(value["recent"], json!([]));
    assert!(render_gateway(&value).contains("最近没有经过网关的请求"));

    let value = gateway_json(&app, &GatewayArgs { limit: 5 }, |_| true).unwrap();
    assert_eq!(value["baseUrl"], json!("http://127.0.0.1:3462/v1"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn gateway_recent_rows_drop_sessions_and_errors() {
    let (app, root) = test_app("gateway_ledger");
    let dir = app.app_data_dir().join("gateway");
    fs::create_dir_all(&dir).unwrap();
    let line = r#"{"ts":"2026-10-24T01:02:03Z","requestId":"r1","agent":"codex","session":"secret-session","endpoint":"responses","provider":"p","requestedModel":"group/fast","upstreamModel":"m","wire":"responses","stream":false,"status":502,"ok":false,"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"latencyMs":5,"error":"upstream said no","group":"fast","member":"p/m"}"#;
    fs::write(dir.join("usage-v1.jsonl"), format!("{line}\n")).unwrap();
    let value = gateway_json(&app, &GatewayArgs { limit: 5 }, |_| false).unwrap();
    let text = value.to_string();
    assert!(!text.contains("secret-session"));
    assert!(!text.contains("upstream said no"));
    let row = &value["recent"][0];
    assert_eq!(row["member"], json!("p/m"));
    assert_eq!(row["ok"], json!(false));
    assert!(render_gateway(&value).contains("✗502"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn table_aligns_wide_characters() {
    let mut table =
        render::Table::new(&[("名称", render::Align::Left), ("值", render::Align::Right)]);
    table.row(vec!["中文".into(), "1".into()]);
    table.row(vec!["abcdef".into(), "22".into()]);
    let text = table.render();
    let widths: Vec<usize> = text.lines().map(render::display_width).collect();
    assert_eq!(widths[0], widths[2]);
    assert_eq!(widths[2], widths[3]);
    assert_eq!(render::fmt_tokens(&json!(1_234_567)), "1.23M");
    assert_eq!(render::fmt_cost(&Value::Null), "—");
}
