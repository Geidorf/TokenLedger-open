//! 订阅设置模型、校验、按 revision 条件保存与删除、系统错误文案与设置文件清洗的测试
//! （T10.188）。

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{Days, NaiveDate};
use serde_json::{json, Value};

use super::cycle::BillingCycle;
use super::*;
use crate::app_paths::AppContext;
use crate::settings::{self, AppSettings};

/// 设置文件清洗在本线程记下的（类别, 条数），代替断言日志输出。
fn take_dropped() -> Vec<(&'static str, usize)> {
    take_dropped_reports()
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/// 与 `settings.rs` 的私有常量同名：测试要直接写入手改过的设置文件。
const SETTINGS_FILE: &str = "app_settings.json";
/// 与 `settings.rs` 的私有常量同名：测试要从另一个连接持有设置文件的跨进程锁。
const SETTINGS_LOCK_FILE: &str = "app_settings.lock.sqlite3";
/// 放进设置文件的哨兵值：任何命令错误都不得带出它。
const SENTINEL: &str = "SECRET-PROBE-VALUE";

fn test_app(label: &str) -> AppContext {
    let directory = std::env::temp_dir().join(format!(
        "tokenledger-cost-profile-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos()
    ));
    AppContext::for_test(directory)
}

fn settings_path(app: &AppContext) -> PathBuf {
    app.app_data_dir().join(SETTINGS_FILE)
}

fn write_raw_settings(app: &AppContext, value: &Value) {
    fs::write(
        settings_path(app),
        serde_json::to_vec_pretty(value).expect("serialize raw settings"),
    )
    .expect("write raw settings");
}

fn read_raw_settings(app: &AppContext) -> Value {
    serde_json::from_slice(&fs::read(settings_path(app)).expect("read settings"))
        .expect("parse settings")
}

fn cleanup(app: &AppContext) {
    let _ = fs::remove_dir_all(app.app_data_dir());
}

fn date(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").expect("test date")
}

fn days_after(day: NaiveDate, days: u64) -> NaiveDate {
    day.checked_add_days(Days::new(days))
        .expect("date in range")
}

/// 测试里的「今天」。
fn today() -> NaiveDate {
    date("2026-09-25")
}

/// 一个合规的新订阅（还没有 ID）。
fn plan(name: &str) -> Value {
    json!({
        "id": null,
        "name": name,
        "provider": "anthropic",
        "fee": 200,
        "currency": "USD",
        "cycle": "monthly",
        "anchorDay": 15,
        "startDate": "2026-03-15",
        "endDate": null,
        "tools": ["claude"],
        "modelPrefixes": ["claude-"],
        "machines": []
    })
}

fn with(mut value: Value, patch: Value) -> Value {
    for (key, field) in patch.as_object().expect("patch object") {
        value[key.as_str()] = field.clone();
    }
    value
}

fn profile(plans: Vec<Value>) -> Value {
    json!({ "plans": plans, "toolBillingModes": {}, "cnyPerUsd": 7.2 })
}

/// 按设置页的规则（开始日期不晚于测试里的今天）校验。
fn errors_of(raw: &Value, stored: &CostProfile) -> Vec<CostProfileFieldError> {
    parse_input_profile(raw, stored, today())
        .err()
        .unwrap_or_default()
}

fn codes(errors: &[CostProfileFieldError]) -> Vec<(Option<usize>, &'static str, Code)> {
    errors
        .iter()
        .map(|error| (error.plan_index, error.field, error.code))
        .collect()
}

fn state_for(app: &AppContext) -> Mutex<AppSettings> {
    Mutex::new(settings::load_settings(app))
}

fn save(
    app: &AppContext,
    state: &Mutex<AppSettings>,
    raw: &Value,
    expected_revision: u64,
) -> CostProfileSaveOutcome {
    save_cost_profile_impl(app, state, raw, expected_revision, today()).expect("save cost profile")
}

fn clear(
    app: &AppContext,
    state: &Mutex<AppSettings>,
    expected_revision: u64,
) -> CostProfileSaveOutcome {
    clear_cost_profile_impl(app, state, expected_revision).expect("clear cost profile")
}

fn saved_view(outcome: CostProfileSaveOutcome) -> CostProfileView {
    match outcome {
        CostProfileSaveOutcome::Saved { profile, .. } => profile,
        other => panic!("expected a saved profile, got {other:?}"),
    }
}

fn stored_plan(id: &str, name: &str) -> CostSubscriptionPlan {
    CostSubscriptionPlan {
        id: id.to_string(),
        name: name.to_string(),
        provider: CostProvider::Anthropic,
        fee: 200.0,
        currency: CostCurrency::Usd,
        cycle: CostBillingCycle::Monthly,
        anchor_day: 15,
        start_date: date("2026-03-15"),
        end_date: None,
        tools: vec!["claude".to_string()],
        model_prefixes: vec!["claude-".to_string()],
        machines: Vec::new(),
    }
}

fn cycle(start: &str, end: &str) -> BillingCycle {
    BillingCycle {
        start: date(start),
        end: date(end),
    }
}

/// 系统错误只能是约定的那一句固定中文：不含英文字母（底层错误原文都是英文），也不含
/// 设置文件里的哨兵值。
fn assert_fixed_sentence(error: &str, expected: &str) {
    assert_eq!(error, expected);
    assert!(!error.contains(SENTINEL), "{error}");
    assert!(
        !error
            .chars()
            .any(|character| character.is_ascii_alphabetic()),
        "{error}"
    );
}

// ---------------------------------------------------------------------------
// 计费日与计费周期
// ---------------------------------------------------------------------------

#[test]
fn monthly_billing_day_31_moves_to_month_end_across_february() {
    let app = test_app("billing-day-31");
    let state = state_for(&app);
    let input = profile(vec![with(
        plan("Claude Max"),
        json!({ "anchorDay": 31, "startDate": "2026-01-31" }),
    )]);
    let view = saved_view(save(&app, &state, &input, 0));
    // 计费日 31 原样保存：2 月短不是改写或拒绝它的理由。
    assert_eq!(view.plans[0].anchor_day, 31);
    let loaded = settings::load_settings(&app);
    let saved = &loaded.cost_subscription_plans[0];
    assert_eq!(saved.anchor_day, 31);

    let containing = |day: &str| saved.billing_cycle_containing(date(day)).expect("cycle");
    // 平年 2 月的计费日落在 28 日。
    assert_eq!(containing("2026-02-10"), cycle("2026-01-31", "2026-02-28"));
    assert_eq!(containing("2026-02-10").days(), 28);
    assert_eq!(containing("2026-02-28"), cycle("2026-02-28", "2026-03-31"));
    assert_eq!(containing("2026-03-30").days(), 31);
    assert_eq!(containing("2026-03-31"), cycle("2026-03-31", "2026-04-30"));
    // 30 天的月份落在 30 日，下一个月回到 31 日。
    assert_eq!(containing("2026-05-01"), cycle("2026-04-30", "2026-05-31"));
    // 闰年 2 月的计费日落在 29 日。
    assert_eq!(containing("2028-02-28"), cycle("2028-01-31", "2028-02-29"));
    assert_eq!(containing("2028-02-29"), cycle("2028-02-29", "2028-03-31"));

    // 开始日期是 2 月末、计费日仍填 31 同样合法：计费日可以与开始日期的日不同。
    let february_start = profile(vec![with(
        plan("Claude Max"),
        json!({ "anchorDay": 31, "startDate": "2026-02-28" }),
    )]);
    assert!(errors_of(&february_start, &CostProfile::cleared()).is_empty());
    cleanup(&app);
}

#[test]
fn monthly_cycles_follow_the_anchor_day_across_year_ends() {
    let mut monthly = stored_plan("sub-0123456789abcdef", "Claude Max");
    monthly.anchor_day = 20;
    let containing = |day: &str| monthly.billing_cycle_containing(date(day)).expect("cycle");
    assert_eq!(containing("2026-01-05"), cycle("2025-12-20", "2026-01-20"));
    assert_eq!(containing("2026-12-20"), cycle("2026-12-20", "2027-01-20"));
    assert_eq!(containing("2026-12-19").days(), 30);
    monthly.anchor_day = 1;
    assert_eq!(
        monthly.billing_cycle_containing(date("2026-09-25")),
        Some(cycle("2026-09-01", "2026-10-01"))
    );
}

#[test]
fn yearly_plan_started_on_leap_day_bills_on_february_28_in_common_years() {
    let app = test_app("leap-yearly");
    let state = state_for(&app);
    let input = profile(vec![with(
        plan("Gemini 年付"),
        json!({
            "provider": "google",
            "cycle": "yearly",
            "anchorDay": 29,
            "startDate": "2024-02-29",
            "tools": ["gemini", "antigravity"],
            "modelPrefixes": []
        }),
    )]);
    let view = saved_view(save(&app, &state, &input, 0));
    assert_eq!(view.plans[0].start_date, date("2024-02-29"));
    let loaded = settings::load_settings(&app);
    let saved = &loaded.cost_subscription_plans[0];
    assert_eq!(saved.start_date, date("2024-02-29"));

    let containing = |day: &str| saved.billing_cycle_containing(date(day)).expect("cycle");
    assert_eq!(containing("2024-03-01"), cycle("2024-02-29", "2025-02-28"));
    assert_eq!(containing("2025-02-27").days(), 365);
    assert_eq!(containing("2025-02-28"), cycle("2025-02-28", "2026-02-28"));
    assert_eq!(containing("2028-02-28"), cycle("2027-02-28", "2028-02-29"));
    assert_eq!(containing("2028-02-28").days(), 366);
    assert_eq!(containing("2028-02-29"), cycle("2028-02-29", "2029-02-28"));

    // 年付按开始日期的月日计费，不看 anchorDay。
    let mut ordinary = saved.clone();
    ordinary.start_date = date("2025-09-15");
    ordinary.anchor_day = 3;
    assert_eq!(
        ordinary.billing_cycle_containing(date("2026-01-01")),
        Some(cycle("2025-09-15", "2026-09-15"))
    );

    // 平年没有 2 月 29 日：这样的开始日期是非法日期，不会被悄悄改成 2 月 28 日。
    let common_year = profile(vec![with(
        plan("Gemini 年付"),
        json!({ "cycle": "yearly", "startDate": "2026-02-29" }),
    )]);
    assert_eq!(
        codes(&errors_of(&common_year, &CostProfile::cleared())),
        vec![(Some(0), field::START_DATE, Code::Invalid)]
    );
    cleanup(&app);
}

// ---------------------------------------------------------------------------
// 重叠
// ---------------------------------------------------------------------------

#[test]
fn adjacent_plan_switch_is_not_an_overlap() {
    let app = test_app("adjacent-switch");
    let state = state_for(&app);
    // 换方案：旧方案 8/31 结束、新方案 9/1 开始，同一工具不算重叠。
    let input = profile(vec![
        with(
            plan("Claude Pro"),
            json!({ "fee": 20, "anchorDay": 1, "startDate": "2026-01-01", "endDate": "2026-08-31" }),
        ),
        with(
            plan("Claude Max"),
            json!({ "anchorDay": 1, "startDate": "2026-09-01" }),
        ),
    ]);
    let view = saved_view(save(&app, &state, &input, 0));
    let names: Vec<_> = view.plans.iter().map(|plan| plan.name.as_str()).collect();
    assert_eq!(names, ["Claude Pro", "Claude Max"]);

    // 年付换月付的相邻交接同理。
    let yearly_then_monthly = profile(vec![
        with(
            plan("Claude 年付"),
            json!({ "cycle": "yearly", "startDate": "2024-02-29", "endDate": "2025-02-27" }),
        ),
        with(plan("Claude 月付"), json!({ "startDate": "2025-02-28" })),
    ]);
    assert!(errors_of(&yearly_then_monthly, &CostProfile::cleared()).is_empty());
    cleanup(&app);
}

#[test]
fn overlapping_plans_are_rejected_and_nothing_is_saved() {
    let app = test_app("overlap");
    let state = state_for(&app);
    let existing = saved_view(save(&app, &state, &profile(vec![plan("Claude Max")]), 0));
    let bytes_before = fs::read(settings_path(&app)).expect("settings before");

    // 同一天交接也算重叠：两段都含这一天。
    let input = profile(vec![
        with(
            plan("Claude Pro"),
            json!({ "startDate": "2026-01-01", "endDate": "2026-09-01" }),
        ),
        with(plan("Claude Max"), json!({ "startDate": "2026-09-01" })),
    ]);
    let CostProfileSaveOutcome::Invalid { errors } = save(&app, &state, &input, 1) else {
        panic!("overlapping plans must be rejected");
    };
    assert_eq!(codes(&errors), vec![(Some(1), field::TOOLS, Code::Overlap)]);
    assert_eq!(errors[0].related_plan_index, Some(0));
    assert_eq!(
        errors[0].message,
        "「Claude Pro」与「Claude Max」自 2026-09-01 起同时覆盖 claude，账本无法区分记录来自哪个订阅。请用模型前缀或设备区分，或合并为一个订阅（订阅费相加）。"
    );
    // 什么都没改：文件逐字节相同，revision 不变。
    assert_eq!(
        fs::read(settings_path(&app)).expect("settings after"),
        bytes_before
    );
    assert_eq!(get_cost_profile_impl(&app).expect("read back"), existing);
    cleanup(&app);
}

#[test]
fn model_prefixes_and_machines_decide_whether_plans_overlap() {
    let cases = [
        // Claude Code 里 `claude-*` 属于 Claude 订阅、`glm-*` 属于另一个编程套餐。
        (
            json!({ "modelPrefixes": ["claude-"] }),
            json!({ "modelPrefixes": ["glm-"] }),
            false,
        ),
        // 一方前缀是另一方前缀的前缀（不区分 ASCII 大小写）。
        (
            json!({ "modelPrefixes": ["claude-"] }),
            json!({ "modelPrefixes": ["CLAUDE-3"] }),
            true,
        ),
        // 空前缀表示全部模型。
        (
            json!({ "modelPrefixes": [] }),
            json!({ "modelPrefixes": ["glm-"] }),
            true,
        ),
        // 另一台电脑上用另一个账号。
        (
            json!({ "machines": ["Studio-PC"] }),
            json!({ "machines": ["Travel-Laptop"] }),
            false,
        ),
        (
            json!({ "machines": ["Studio-PC"] }),
            json!({ "machines": ["Studio-PC", "Travel-Laptop"] }),
            true,
        ),
        // 空设备表示全部设备。
        (
            json!({ "machines": ["Studio-PC"] }),
            json!({ "machines": [] }),
            true,
        ),
        (
            json!({ "tools": ["claude"] }),
            json!({ "tools": ["codex", "pi"] }),
            false,
        ),
        (
            json!({ "tools": ["claude", "pi"] }),
            json!({ "tools": ["pi"] }),
            true,
        ),
        (
            json!({ "endDate": "2026-05-31" }),
            json!({ "startDate": "2026-06-01" }),
            false,
        ),
        (
            json!({ "endDate": "2026-06-01" }),
            json!({ "startDate": "2026-06-01" }),
            true,
        ),
    ];
    for (index, (left, right, expected)) in cases.into_iter().enumerate() {
        let input = profile(vec![with(plan("A"), left), with(plan("B"), right)]);
        let errors = errors_of(&input, &CostProfile::cleared());
        let overlaps = errors.iter().any(|error| error.code == Code::Overlap);
        assert_eq!(overlaps, expected, "case {index}: {errors:?}");
        if !expected {
            assert!(errors.is_empty(), "case {index}: {errors:?}");
        }
    }
}

// ---------------------------------------------------------------------------
// 非法值
// ---------------------------------------------------------------------------

#[test]
fn invalid_plan_values_are_reported_next_to_their_field() {
    let seventeen_tools: Vec<String> = (0..17).map(|index| format!("tool{index}")).collect();
    let cases = vec![
        (json!({ "name": "   " }), field::NAME, Code::Required),
        (
            json!({ "name": "订".repeat(41) }),
            field::NAME,
            Code::TooLong,
        ),
        (
            json!({ "name": "Claude\u{0007}Max" }),
            field::NAME,
            Code::Invalid,
        ),
        (
            json!({ "name": "Claude\u{202e}Max" }),
            field::NAME,
            Code::Invalid,
        ),
        (json!({ "name": 42 }), field::NAME, Code::Invalid),
        (json!({ "provider": "xai" }), field::PROVIDER, Code::Invalid),
        (
            json!({ "provider": "Anthropic" }),
            field::PROVIDER,
            Code::Invalid,
        ),
        (json!({ "provider": null }), field::PROVIDER, Code::Required),
        (json!({ "fee": 0 }), field::FEE, Code::OutOfRange),
        (json!({ "fee": -5 }), field::FEE, Code::OutOfRange),
        (json!({ "fee": 100_000.01 }), field::FEE, Code::OutOfRange),
        (json!({ "fee": 19.999 }), field::FEE, Code::Precision),
        (json!({ "fee": "200" }), field::FEE, Code::Invalid),
        (json!({ "fee": null }), field::FEE, Code::Required),
        (json!({ "currency": "EUR" }), field::CURRENCY, Code::Invalid),
        (json!({ "currency": "usd" }), field::CURRENCY, Code::Invalid),
        (json!({ "cycle": "quarterly" }), field::CYCLE, Code::Invalid),
        (
            json!({ "anchorDay": 0 }),
            field::ANCHOR_DAY,
            Code::OutOfRange,
        ),
        (
            json!({ "anchorDay": 32 }),
            field::ANCHOR_DAY,
            Code::OutOfRange,
        ),
        (
            json!({ "anchorDay": 15.5 }),
            field::ANCHOR_DAY,
            Code::Invalid,
        ),
        (
            json!({ "anchorDay": "15" }),
            field::ANCHOR_DAY,
            Code::Invalid,
        ),
        (
            json!({ "startDate": "2026-9-5" }),
            field::START_DATE,
            Code::Invalid,
        ),
        (
            json!({ "startDate": "2026-02-30" }),
            field::START_DATE,
            Code::Invalid,
        ),
        (
            json!({ "startDate": "2019-12-31" }),
            field::START_DATE,
            Code::OutOfRange,
        ),
        (
            json!({ "startDate": "2026-09-26" }),
            field::START_DATE,
            Code::InFuture,
        ),
        (
            json!({ "startDate": null }),
            field::START_DATE,
            Code::Required,
        ),
        (
            json!({ "endDate": "2026-03-14" }),
            field::END_DATE,
            Code::BeforeStart,
        ),
        (
            json!({ "endDate": "someday" }),
            field::END_DATE,
            Code::Invalid,
        ),
        (json!({ "tools": [] }), field::TOOLS, Code::Required),
        (
            json!({ "tools": ["claude", "claude"] }),
            field::TOOLS,
            Code::Duplicate,
        ),
        (json!({ "tools": [" claude"] }), field::TOOLS, Code::Invalid),
        (json!({ "tools": [7] }), field::TOOLS, Code::Invalid),
        (
            json!({ "tools": seventeen_tools }),
            field::TOOLS,
            Code::TooMany,
        ),
        (
            json!({ "modelPrefixes": ["claude sonnet"] }),
            field::MODEL_PREFIXES,
            Code::Invalid,
        ),
        (
            json!({ "modelPrefixes": ["混元-"] }),
            field::MODEL_PREFIXES,
            Code::Invalid,
        ),
        (
            json!({ "modelPrefixes": ["claude-", "CLAUDE-"] }),
            field::MODEL_PREFIXES,
            Code::Duplicate,
        ),
        (
            json!({ "modelPrefixes": ["a".repeat(65)] }),
            field::MODEL_PREFIXES,
            Code::TooLong,
        ),
        (
            json!({ "machines": ["all_cloud"] }),
            field::MACHINES,
            Code::Invalid,
        ),
        (
            json!({ "machines": ["Studio-PC", "Studio-PC"] }),
            field::MACHINES,
            Code::Duplicate,
        ),
        (json!({ "id": "sub-XYZ" }), field::ID, Code::Invalid),
        (
            json!({ "id": "sub-0123456789ABCDEF" }),
            field::ID,
            Code::Invalid,
        ),
        (json!({ "nickname": "x" }), field::PLAN, Code::Invalid),
    ];
    for (patch, field, code) in cases {
        let input = profile(vec![with(plan("Claude Max"), patch.clone())]);
        let errors = errors_of(&input, &CostProfile::cleared());
        assert_eq!(
            codes(&errors),
            vec![(Some(0), field, code)],
            "patch {patch}"
        );
    }

    // 列表项错误指出是哪一项。
    let errors = errors_of(
        &profile(vec![with(
            plan("Claude Max"),
            json!({ "modelPrefixes": ["claude-", "bad prefix"] }),
        )]),
        &CostProfile::cleared(),
    );
    assert_eq!(errors[0].item_index, Some(1));
    assert_eq!(
        errors[0].message,
        "模型前缀只能包含英文字母、数字和英文符号，不能有空格"
    );
    // 可选字段省略时按空处理，其余字段仍逐项检查。
    let mut minimal = plan("Claude Max");
    for optional in ["id", "endDate", "modelPrefixes", "machines"] {
        minimal.as_object_mut().expect("plan").remove(optional);
    }
    assert!(errors_of(&profile(vec![minimal]), &CostProfile::cleared()).is_empty());
}

#[test]
fn names_reject_invisible_and_direction_control_characters() {
    let cleared = CostProfile::cleared();
    let name_codes = |name: &str| {
        codes(&errors_of(
            &profile(vec![with(plan("x"), json!({ "name": name }))]),
            &cleared,
        ))
    };
    let invalid = vec![(Some(0), field::NAME, Code::Invalid)];
    for name in [
        // 零宽空格：与「ClaudeMax」看上去一样。
        "Claude\u{200b}Max",
        // 从左到右、从右到左标记与阿拉伯字母标记。
        "\u{200e}Claude Max",
        "Claude Max\u{200f}",
        "Claude\u{061c}Max",
        // BOM 不是 Unicode 空白，去首尾空白后仍在。
        "\u{feff}Claude Max",
        // 零宽不连字、零宽连字、词连接符与软连字符。
        "Claude\u{200c}Max",
        "Claude\u{200d}Max",
        "Claude\u{2060}Max",
        "Claude\u{00ad}Max",
        // 双向嵌入与双向隔离。
        "Claude\u{202a}Max\u{202c}",
        "\u{2066}Claude Max\u{2069}",
        // 先去首尾空白再判断：空白里侧的零宽字符照样拦下。
        "Claude Max\u{200b}  ",
        "  \u{200b}  ",
    ] {
        assert_eq!(name_codes(name), invalid, "{name:?}");
    }
    for name in ["智谱 编程套餐", "Claude Max \u{1f680}", "Kimi（会员）"] {
        assert_eq!(name_codes(name), Vec::new(), "{name:?}");
    }
    // 首尾的全角空格是 Unicode 空白：去掉后保存。
    let app = test_app("name-trim");
    let state = state_for(&app);
    let view = saved_view(save(
        &app,
        &state,
        &profile(vec![with(
            plan("x"),
            json!({ "name": "\u{3000}Claude Max\u{3000}" }),
        )]),
        0,
    ));
    assert_eq!(view.plans[0].name, "Claude Max");
    cleanup(&app);
}

#[test]
fn model_prefixes_accept_visible_ascii_without_spaces() {
    let cleared = CostProfile::cleared();
    let prefix_errors = |prefix: &str| {
        errors_of(
            &profile(vec![with(
                plan("Claude Max"),
                json!({ "modelPrefixes": [prefix] }),
            )]),
            &cleared,
        )
    };
    // 方案 §3.2 规则栏：ASCII 可见字符（0x21–0x7E），不含空白。
    for prefix in [
        "claude-3-5-sonnet-v2@20241022",
        "claude-sonnet-4[1m]",
        "gpt-4o+search",
        "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
        "qwen2.5-coder:7b",
        "anthropic/claude",
        "!",
        "~",
    ] {
        assert_eq!(codes(&prefix_errors(prefix)), Vec::new(), "{prefix}");
    }
    for prefix in [
        "claude sonnet",
        "claude\tsonnet",
        "混元-",
        "claude\u{7f}",
        "claude\u{a0}",
        "",
    ] {
        let errors = prefix_errors(prefix);
        assert_eq!(
            codes(&errors),
            vec![(Some(0), field::MODEL_PREFIXES, Code::Invalid)],
            "{prefix:?}"
        );
        assert_eq!(
            errors[0].message,
            "模型前缀只能包含英文字母、数字和英文符号，不能有空格"
        );
    }
}

#[test]
fn amounts_allow_exactly_the_decimals_of_their_unit() {
    let cleared = CostProfile::cleared();
    let fee_codes = |fee: &Value| {
        codes(&errors_of(
            &profile(vec![with(plan("Claude Max"), json!({ "fee": fee }))]),
            &cleared,
        ))
    };
    // 订阅费最多两位小数（美元与人民币的最小单位都是分），多一位就是 precision，不设容差。
    for fee in [
        json!(19.999999999),
        json!(19.999),
        json!(0.001),
        json!(1e-9),
        json!(99_999.991),
    ] {
        assert_eq!(
            fee_codes(&fee),
            vec![(Some(0), field::FEE, Code::Precision)],
            "fee {fee}"
        );
    }
    for fee in [
        json!(19.99),
        json!(0.07),
        json!(0.01),
        json!(99_999.99),
        json!(100_000),
        json!(200),
    ] {
        assert_eq!(fee_codes(&fee), Vec::new(), "fee {fee}");
    }
    // 汇率最多 4 位小数。
    let rate_codes = |rate: &Value| {
        codes(&errors_of(
            &json!({ "plans": [], "toolBillingModes": {}, "cnyPerUsd": rate }),
            &cleared,
        ))
    };
    for rate in [json!(7.20000000001), json!(7.23456), json!(1.00001)] {
        assert_eq!(
            rate_codes(&rate),
            vec![(None, field::CNY_PER_USD, Code::Precision)],
            "rate {rate}"
        );
    }
    for rate in [json!(7.2345), json!(7.2), json!(1), json!(19.9999)] {
        assert_eq!(rate_codes(&rate), Vec::new(), "rate {rate}");
    }

    // 设置文件里位数多出的值同样不合规：那条订阅整条丢弃，汇率读成不可得，存储形态唯一。
    let app = test_app("stored-decimals");
    let state = state_for(&app);
    saved_view(save(&app, &state, &profile(vec![plan("Claude Max")]), 0));
    let mut raw = read_raw_settings(&app);
    raw["cost_subscription_plans"][0]["fee"] = json!(19.999999999);
    raw["cost_cny_per_usd"] = json!(7.20000000001);
    write_raw_settings(&app, &raw);
    let loaded = settings::load_settings_result(&app).expect("hand-edited amounts stay readable");
    assert!(loaded.cost_subscription_plans.is_empty());
    assert_eq!(loaded.cost_cny_per_usd, None);
    cleanup(&app);
}

#[test]
fn invalid_profile_values_and_cross_plan_conflicts_are_reported() {
    let cleared = CostProfile::cleared();
    let with_rate = |rate: Value| json!({ "plans": [], "toolBillingModes": {}, "cnyPerUsd": rate });
    assert_eq!(
        codes(&errors_of(&with_rate(json!(0.5)), &cleared)),
        vec![(None, field::CNY_PER_USD, Code::OutOfRange)]
    );
    assert_eq!(
        codes(&errors_of(&with_rate(json!(20.5)), &cleared)),
        vec![(None, field::CNY_PER_USD, Code::OutOfRange)]
    );
    assert_eq!(
        codes(&errors_of(&with_rate(json!(7.23456)), &cleared)),
        vec![(None, field::CNY_PER_USD, Code::Precision)]
    );
    assert_eq!(
        codes(&errors_of(&with_rate(json!("7.2")), &cleared)),
        vec![(None, field::CNY_PER_USD, Code::Invalid)]
    );
    assert_eq!(
        codes(&errors_of(&with_rate(Value::Null), &cleared)),
        vec![(None, field::CNY_PER_USD, Code::Required)]
    );
    assert!(errors_of(&with_rate(json!(7.2345)), &cleared).is_empty());
    assert!(errors_of(&with_rate(json!(1)), &cleared).is_empty());
    assert!(errors_of(&with_rate(json!(20)), &cleared).is_empty());

    let modes = json!({
        "plans": [],
        "toolBillingModes": { "opencode": "payg", "kilo": "subscription", " spaced": "payg" },
        "cnyPerUsd": 7.2
    });
    let errors = errors_of(&modes, &cleared);
    assert_eq!(
        codes(&errors),
        vec![
            (None, field::TOOL_BILLING_MODES, Code::Invalid),
            (None, field::TOOL_BILLING_MODES, Code::Invalid),
        ]
    );
    let keys: Vec<_> = errors.iter().map(|error| error.key.as_deref()).collect();
    assert_eq!(keys, [Some(" spaced"), Some("kilo")]);

    let thirteen: Vec<Value> = (0..13)
        .map(|index| {
            with(
                plan(&format!("plan {index}")),
                json!({ "tools": [format!("tool{index}")] }),
            )
        })
        .collect();
    assert_eq!(
        codes(&errors_of(&profile(thirteen), &cleared)),
        vec![(None, field::PLANS, Code::TooMany)]
    );
    assert_eq!(
        codes(&errors_of(
            &json!({ "toolBillingModes": {}, "cnyPerUsd": 7.2 }),
            &cleared
        )),
        vec![(None, field::PLANS, Code::Required)]
    );
    // revision 另走 expectedRevision，写进订阅设置里是拼错了地方，不悄悄忽略。
    let with_revision =
        json!({ "plans": [], "toolBillingModes": {}, "cnyPerUsd": 7.2, "revision": 3 });
    let errors = errors_of(&with_revision, &cleared);
    assert_eq!(codes(&errors), vec![(None, field::PROFILE, Code::Invalid)]);
    assert_eq!(errors[0].key.as_deref(), Some("revision"));
    assert_eq!(
        codes(&errors_of(&json!([]), &cleared)),
        vec![(None, field::PROFILE, Code::Invalid)]
    );

    // 同名（不区分大小写）与重复 ID 指向较早的那个订阅。
    let duplicate = profile(vec![
        with(plan("Claude Max"), json!({ "id": "sub-0123456789abcdef" })),
        with(
            plan("claude max"),
            json!({ "id": "sub-0123456789abcdef", "tools": ["codex"] }),
        ),
    ]);
    let errors = errors_of(&duplicate, &cleared);
    assert_eq!(
        codes(&errors),
        vec![
            (Some(1), field::ID, Code::Duplicate),
            (Some(1), field::NAME, Code::Duplicate),
        ]
    );
    assert!(errors
        .iter()
        .all(|error| error.related_plan_index == Some(0)));
}

#[test]
fn field_errors_and_outcomes_serialize_with_a_stable_shape() {
    let errors = errors_of(
        &profile(vec![
            plan("Claude Max"),
            with(plan("claude max"), json!({ "tools": ["codex"] })),
        ]),
        &CostProfile::cleared(),
    );
    assert_eq!(
        serde_json::to_value(&errors).expect("errors json"),
        json!([{
            "planIndex": 1,
            "field": "name",
            "itemIndex": null,
            "key": null,
            "relatedPlanIndex": 0,
            "code": "duplicate",
            "message": "已有同名订阅"
        }])
    );
    assert_eq!(
        serde_json::to_value(CostProfileSaveOutcome::Conflict {
            current_revision: 3
        })
        .expect("conflict json"),
        json!({ "status": "conflict", "currentRevision": 3 })
    );
    assert_eq!(
        serde_json::to_value(CostProfileSaveOutcome::Invalid { errors: Vec::new() })
            .expect("invalid json"),
        json!({ "status": "invalid", "errors": [] })
    );
    let saved = CostProfileSaveOutcome::Saved {
        profile: CostProfileView::new(4, &CostProfile::cleared()),
        cleared: true,
    };
    assert_eq!(
        serde_json::to_value(saved).expect("saved json"),
        json!({
            "status": "saved",
            "profile": { "revision": 4, "plans": [], "toolBillingModes": {}, "cnyPerUsd": 7.2 },
            "cleared": true
        })
    );
}

#[test]
fn start_date_after_today_is_only_checked_when_it_is_entered() {
    // 已保存的开始日期不因本机时钟或时区差异被重新判定（例如从更东时区的设备同步来）。
    let mut tomorrow = stored_plan("sub-0123456789abcdef", "Claude Max");
    tomorrow.start_date = date("2026-09-26");
    let stored = CostProfile {
        plans: vec![tomorrow],
        ..CostProfile::cleared()
    };
    let resubmitted = |start: &str| {
        profile(vec![with(
            plan("Claude Max"),
            json!({ "id": "sub-0123456789abcdef", "startDate": start }),
        )])
    };
    assert!(errors_of(&resubmitted("2026-09-26"), &stored).is_empty());
    assert_eq!(
        codes(&errors_of(&resubmitted("2026-09-27"), &stored)),
        vec![(Some(0), field::START_DATE, Code::InFuture)]
    );
    // 今天本身可以。
    assert!(errors_of(&resubmitted("2026-09-25"), &stored).is_empty());
    // 新订阅（没有 ID）总要检查。
    assert_eq!(
        codes(&errors_of(
            &profile(vec![with(
                plan("Claude Max"),
                json!({ "startDate": "2026-09-26" })
            )]),
            &CostProfile::cleared()
        )),
        vec![(Some(0), field::START_DATE, Code::InFuture)]
    );
}

#[test]
fn applying_another_devices_copy_allows_two_days_of_clock_skew_and_keeps_its_ids() {
    // C1 应用云端副本：那台设备在更东的时区，它的「今天」最多比本机晚两天；ID 由它生成。
    let app = test_app("remote-copy");
    let state = state_for(&app);
    let latest_start = remote_copy_latest_start(today());
    assert_eq!(latest_start, date("2026-09-27"));
    let remote = |start: &str| {
        profile(vec![with(
            plan("Claude Max"),
            json!({ "id": "sub-00000000000000aa", "startDate": start }),
        )])
    };
    let in_future = vec![(Some(0), field::START_DATE, Code::InFuture)];
    // 设置页路径：本机的明天就算「晚于今天」。
    let CostProfileSaveOutcome::Invalid { errors } = save(&app, &state, &remote("2026-09-26"), 0)
    else {
        panic!("the settings page path keeps checking today");
    };
    assert_eq!(codes(&errors), in_future);
    // 应用副本：上界是本机今天 + 2 天，不是整条关闭；再晚一天或远在将来的日期照样拒绝。
    for start in ["2026-09-28", "9999-12-31"] {
        let CostProfileSaveOutcome::Invalid { errors } =
            save_cost_profile_impl(&app, &state, &remote(start), 0, latest_start)
                .expect("apply remote copy")
        else {
            panic!("{start} is later than the remote copy bound");
        };
        assert_eq!(codes(&errors), in_future, "{start}");
    }
    let CostProfileSaveOutcome::Saved { profile: view, .. } =
        save_cost_profile_impl(&app, &state, &remote("2026-09-27"), 0, latest_start)
            .expect("apply remote copy")
    else {
        panic!("a copy validated on another device must apply");
    };
    assert_eq!(view.revision, 1);
    assert_eq!(view.plans[0].id, "sub-00000000000000aa");
    assert_eq!(view.plans[0].start_date, date("2026-09-27"));
    // 其余规则照常：重叠的副本同样被拒。
    let overlapping = profile(vec![
        with(plan("A"), json!({ "id": "sub-00000000000000ab" })),
        with(plan("B"), json!({ "id": "sub-00000000000000ac" })),
    ]);
    assert!(matches!(
        save_cost_profile_impl(&app, &state, &overlapping, 1, latest_start),
        Ok(CostProfileSaveOutcome::Invalid { .. })
    ));
    // 上界在日期上限处不溢出。
    assert_eq!(remote_copy_latest_start(NaiveDate::MAX), NaiveDate::MAX);
    cleanup(&app);
}

// ---------------------------------------------------------------------------
// 保存、revision 与删除
// ---------------------------------------------------------------------------

#[test]
fn saving_assigns_stable_ids_and_keeps_every_other_setting() {
    let app = test_app("save-shape");
    let authoritative = AppSettings {
        scan_interval_secs: 1234,
        quota_codex_local_enabled: true,
        ..AppSettings::default()
    };
    settings::save_settings_file(&app, &authoritative).expect("save authoritative settings");
    let state = state_for(&app);
    let input = json!({
        "plans": [
            plan("Claude Max"),
            with(plan("Kimi 会员"), json!({
                "provider": "moonshot",
                "fee": 199,
                "currency": "CNY",
                "tools": ["kimi", "kimidesktop"],
                "modelPrefixes": []
            }))
        ],
        "toolBillingModes": { "opencode": "payg" },
        "cnyPerUsd": 7.25
    });
    let CostProfileSaveOutcome::Saved {
        profile: view,
        cleared,
    } = save(&app, &state, &input, 0)
    else {
        panic!("valid profile must be saved");
    };
    assert!(!cleared);
    assert_eq!(view.revision, 1);
    assert!(view.plans.iter().all(|plan| valid_plan_id(&plan.id)));
    assert_ne!(view.plans[0].id, view.plans[1].id);
    assert_eq!(view.plans[1].currency, CostCurrency::Cny);
    assert_eq!(view.cny_per_usd, Some(7.25));

    // 其他设置原样保留；内存中的设置副本同步更新。
    let loaded = settings::load_settings(&app);
    assert_eq!(loaded.scan_interval_secs, 1234);
    assert!(loaded.quota_codex_local_enabled);
    assert_eq!(CostProfileView::from_settings(&loaded), view);
    assert_eq!(
        CostProfileView::from_settings(&state.lock().expect("state")),
        view
    );
    assert_eq!(get_cost_profile_impl(&app).expect("get"), view);

    // 再次保存时沿用原 ID：ID 不随名称或顺序变化。
    let mut resubmit = serde_json::to_value(&view).expect("view json");
    resubmit
        .as_object_mut()
        .expect("view object")
        .remove("revision");
    let plans = resubmit["plans"].as_array_mut().expect("plans");
    plans.reverse();
    plans[0]["name"] = json!("Kimi 会员（年付改月付）");
    let again = saved_view(save(&app, &state, &resubmit, 1));
    assert_eq!(again.revision, 2);
    assert_eq!(again.plans[0].id, view.plans[1].id);
    assert_eq!(again.plans[1].id, view.plans[0].id);

    // 设置文件里的形态：设置字段蛇形、订阅字段驼峰，日期是 YYYY-MM-DD 字符串。
    let raw = read_raw_settings(&app);
    assert_eq!(raw["cost_profile_revision"], json!(2));
    assert_eq!(raw["cost_cny_per_usd"], json!(7.25));
    assert_eq!(
        raw["cost_tool_billing_modes"],
        json!({ "opencode": "payg" })
    );
    let stored = &raw["cost_subscription_plans"][1];
    assert_eq!(stored["startDate"], json!("2026-03-15"));
    assert_eq!(stored["endDate"], Value::Null);
    assert_eq!(stored["anchorDay"], json!(15));
    assert_eq!(stored["modelPrefixes"], json!(["claude-"]));
    assert_eq!(raw["scan_interval_secs"], json!(1234));
    cleanup(&app);
}

#[test]
fn stale_revision_conflicts_and_changes_nothing() {
    let app = test_app("revision-conflict");
    let state = state_for(&app);
    let first = saved_view(save(&app, &state, &profile(vec![plan("Claude Max")]), 0));
    assert_eq!(first.revision, 1);
    let bytes_before = fs::read(settings_path(&app)).expect("settings before");

    // 另一扇窗口还拿着 revision 0。
    let stale = profile(vec![with(
        plan("ChatGPT Plus"),
        json!({ "provider": "openai", "fee": 20, "tools": ["codex"], "modelPrefixes": [] }),
    )]);
    assert_eq!(
        save(&app, &state, &stale, 0),
        CostProfileSaveOutcome::Conflict {
            current_revision: 1
        }
    );
    // 「删除全部」同样受 revision 保护。
    assert_eq!(
        clear(&app, &state, 0),
        CostProfileSaveOutcome::Conflict {
            current_revision: 1
        }
    );
    assert_eq!(
        fs::read(settings_path(&app)).expect("settings after"),
        bytes_before
    );
    assert_eq!(
        CostProfileView::from_settings(&state.lock().expect("state")),
        first
    );

    // 按当前 revision 重试才会保存。
    let second = saved_view(save(&app, &state, &stale, 1));
    assert_eq!(second.revision, 2);
    assert_eq!(second.plans[0].name, "ChatGPT Plus");
    cleanup(&app);
}

#[test]
fn delete_all_clears_every_cost_setting_and_bumps_the_revision() {
    let app = test_app("delete-all");
    let state = state_for(&app);
    let input = json!({
        "plans": [plan("Claude Max")],
        "toolBillingModes": { "opencode": "payg" },
        "cnyPerUsd": 7.3
    });
    assert_eq!(saved_view(save(&app, &state, &input, 0)).revision, 1);

    let CostProfileSaveOutcome::Saved {
        profile: view,
        cleared,
    } = clear(&app, &state, 1)
    else {
        panic!("delete all must save");
    };
    assert!(cleared);
    assert_eq!(
        view,
        CostProfileView {
            revision: 2,
            plans: Vec::new(),
            tool_billing_modes: BTreeMap::new(),
            cny_per_usd: Some(DEFAULT_CNY_PER_USD),
        }
    );
    assert_eq!(get_cost_profile_impl(&app).expect("get"), view);
    assert_eq!(
        CostProfileView::from_settings(&state.lock().expect("state")),
        view
    );
    // 丢掉内存副本、从文件重读仍是规范空状态：C1 重启后据此重新判定墓碑。
    assert!(CostProfile::from_settings(&settings::load_settings(&app)).is_cleared());
    // revision 不回退：还拿着 revision 1 的设置页写不回已删除的订阅（C1 的云端墓碑沿用这一点）。
    assert_eq!(
        save(&app, &state, &input, 1),
        CostProfileSaveOutcome::Conflict {
            current_revision: 2
        }
    );
    // 已是空状态时再删一次同样照常加一。
    assert_eq!(saved_view(clear(&app, &state, 2)).revision, 3);
    // 手动删到空、汇率保持默认，同样是规范空状态。
    let CostProfileSaveOutcome::Saved {
        cleared,
        profile: emptied,
    } = save(&app, &state, &profile(Vec::new()), 3)
    else {
        panic!("empty profile must save");
    };
    assert!(cleared);
    assert_eq!(emptied.revision, 4);
    cleanup(&app);
}

#[test]
fn null_is_not_a_cost_profile_and_never_clears_anything() {
    let app = test_app("null-profile");
    let state = state_for(&app);
    let existing = saved_view(save(&app, &state, &profile(vec![plan("Claude Max")]), 0));
    let bytes_before = fs::read(settings_path(&app)).expect("settings before");

    // 设置页误把尚未加载完的 null 连同正确的 revision 提交：报错，不清空。
    let required = vec![(None, field::PROFILE, Code::Required)];
    let CostProfileSaveOutcome::Invalid { errors } = save(&app, &state, &Value::Null, 1) else {
        panic!("null must not clear the cost profile");
    };
    assert_eq!(codes(&errors), required);
    assert_eq!(errors[0].message, "缺少订阅设置");
    let validation =
        validate_cost_profile_impl(&app, &Value::Null, today()).expect("validate null");
    assert!(!validation.valid);
    assert_eq!(codes(&validation.errors), required);
    // 其他不是对象的提交同样不是订阅设置。
    for raw in [json!([]), json!("plans"), json!(0), json!(false)] {
        assert_eq!(
            codes(&errors_of(&raw, &CostProfile::cleared())),
            vec![(None, field::PROFILE, Code::Invalid)],
            "{raw}"
        );
    }
    assert_eq!(
        fs::read(settings_path(&app)).expect("settings after"),
        bytes_before
    );
    assert_eq!(get_cost_profile_impl(&app).expect("get"), existing);
    cleanup(&app);
}

#[test]
fn validation_never_writes() {
    let app = test_app("validate-read-only");
    let state = state_for(&app);
    saved_view(save(&app, &state, &profile(vec![plan("Claude Max")]), 0));
    let bytes_before = fs::read(settings_path(&app)).expect("settings before");

    let overlapping = profile(vec![plan("A"), plan("B")]);
    let result = validate_cost_profile_impl(&app, &overlapping, today()).expect("validate");
    assert!(!result.valid);
    assert_eq!(
        codes(&result.errors),
        vec![(Some(1), field::TOOLS, Code::Overlap)]
    );
    let result =
        validate_cost_profile_impl(&app, &profile(vec![plan("A")]), today()).expect("validate");
    assert_eq!(
        result,
        CostProfileValidation {
            valid: true,
            errors: Vec::new()
        }
    );
    assert_eq!(
        fs::read(settings_path(&app)).expect("settings after"),
        bytes_before
    );
    cleanup(&app);
}

#[test]
fn revision_never_passes_the_javascript_safe_integer() {
    let app = test_app("revision-cap");
    let at_limit = AppSettings {
        cost_profile_revision: MAX_REVISION,
        ..AppSettings::default()
    };
    settings::save_settings_file(&app, &at_limit).expect("save settings at the limit");
    let state = state_for(&app);
    assert_eq!(
        save_cost_profile_impl(&app, &state, &profile(Vec::new()), MAX_REVISION, today()),
        Err(REVISION_LIMIT_ERROR.to_string())
    );
    assert_eq!(
        clear_cost_profile_impl(&app, &state, MAX_REVISION),
        Err(REVISION_LIMIT_ERROR.to_string())
    );
    assert_eq!(
        settings::load_settings(&app).cost_profile_revision,
        MAX_REVISION
    );
    cleanup(&app);
}

#[test]
fn generated_plan_ids_are_well_formed_and_unique() {
    let mut taken = HashSet::new();
    for _ in 0..500 {
        let id = generate_plan_id(&taken);
        assert!(valid_plan_id(&id), "{id}");
        assert!(taken.insert(id));
    }
}

// ---------------------------------------------------------------------------
// 命令包装层：设置页用本机今天作上界，只在保存或删除成功时发 settings-updated
// ---------------------------------------------------------------------------

#[test]
fn settings_page_commands_use_the_local_today_and_announce_only_changes() {
    let app = test_app("settings-page");
    let state = state_for(&app);
    let starting = |start: NaiveDate| {
        profile(vec![with(
            plan("Claude Max"),
            json!({ "startDate": start.format("%Y-%m-%d").to_string() }),
        )])
    };
    // 设置页录入以本机今天为开始日期上界：明天报 in_future，不写入、不发事件。
    let before = local_today();
    let tomorrow = days_after(before, 1);
    let validation = validate_for_settings_page(&app, &starting(tomorrow)).expect("validate");
    let rejected = save_for_settings_page(&app, &state, &starting(tomorrow), 0).expect("save");
    if local_today() != before {
        // 恰好跨过本地午夜：「明天」已经是今天，这一轮不作判定。
        cleanup(&app);
        return;
    }
    let in_future = vec![(Some(0), field::START_DATE, Code::InFuture)];
    assert!(!validation.valid);
    assert_eq!(codes(&validation.errors), in_future);
    let errors = match rejected {
        (CostProfileSaveOutcome::Invalid { errors }, None) => errors,
        other => panic!("the settings page must reject a start date after today: {other:?}"),
    };
    assert_eq!(codes(&errors), in_future);

    // 保存成功才发事件，载荷与既有监听方的约定一致。
    let announced = Some(json!({ "source": "cost-profile" }));
    let (outcome, event) =
        save_for_settings_page(&app, &state, &starting(before), 0).expect("save today");
    assert_eq!(saved_view(outcome).revision, 1);
    assert_eq!(event, announced);
    // 冲突与校验失败都不发。
    let (outcome, event) =
        save_for_settings_page(&app, &state, &starting(before), 0).expect("stale save");
    assert_eq!(
        outcome,
        CostProfileSaveOutcome::Conflict {
            current_revision: 1
        }
    );
    assert_eq!(event, None);
    let (outcome, event) =
        save_for_settings_page(&app, &state, &profile(vec![plan("A"), plan("B")]), 1)
            .expect("overlapping save");
    assert!(
        matches!(outcome, CostProfileSaveOutcome::Invalid { .. }),
        "{outcome:?}"
    );
    assert_eq!(event, None);
    // 删除全部同理：冲突不发，成功才发。
    let (outcome, event) = clear_for_settings_page(&app, &state, 0).expect("stale clear");
    assert_eq!(
        outcome,
        CostProfileSaveOutcome::Conflict {
            current_revision: 1
        }
    );
    assert_eq!(event, None);
    let (outcome, event) = clear_for_settings_page(&app, &state, 1).expect("clear");
    assert!(
        matches!(outcome, CostProfileSaveOutcome::Saved { cleared: true, .. }),
        "{outcome:?}"
    );
    assert_eq!(event, announced);
    cleanup(&app);
}

// ---------------------------------------------------------------------------
// 系统错误：固定的中文句子，不回显设置文件内容（契约 §1）
// ---------------------------------------------------------------------------

#[test]
fn unreadable_settings_file_errors_never_echo_its_content() {
    let app = test_app("sentinel");
    fs::create_dir_all(app.app_data_dir()).expect("app data dir");
    // 通用字段的类型不对：serde 的错误原文会引用出错的值。
    let content = format!("{{ \"scan_interval_secs\": \"{SENTINEL}\" }}");
    fs::write(settings_path(&app), &content).expect("write settings");
    let raw_error = settings::load_settings_result(&app).expect_err("the file must not parse");
    assert!(
        raw_error.contains(SENTINEL),
        "the probe must reach the parser error: {raw_error}"
    );
    // 不经 load_settings 建内存副本：它会把读不出的文件改写成默认值。
    let state = Mutex::new(AppSettings::default());

    let error =
        save_cost_profile_impl(&app, &state, &profile(vec![plan("Claude Max")]), 0, today())
            .expect_err("save must fail");
    assert_fixed_sentence(&error, SAVE_READ_ERROR);
    let error = clear_cost_profile_impl(&app, &state, 0).expect_err("clear must fail");
    assert_fixed_sentence(&error, SAVE_READ_ERROR);
    let error = save_for_settings_page(&app, &state, &profile(Vec::new()), 0)
        .expect_err("settings page save must fail");
    assert_fixed_sentence(&error, SAVE_READ_ERROR);
    let error =
        clear_for_settings_page(&app, &state, 0).expect_err("settings page clear must fail");
    assert_fixed_sentence(&error, SAVE_READ_ERROR);
    let error = get_cost_profile_impl(&app).expect_err("get must fail");
    assert_fixed_sentence(&error, READ_ERROR);
    let error =
        validate_for_settings_page(&app, &profile(Vec::new())).expect_err("validate must fail");
    assert_fixed_sentence(&error, READ_ERROR);
    // 什么都没写。
    assert_eq!(
        fs::read_to_string(settings_path(&app)).expect("settings after"),
        content
    );
    assert_eq!(state.lock().expect("state").cost_profile_revision, 0);
    cleanup(&app);
}

#[test]
fn held_settings_lock_is_reported_as_a_fixed_sentence() {
    let app = test_app("held-lock");
    let state = state_for(&app);
    let view = saved_view(save(&app, &state, &profile(vec![plan("Claude Max")]), 0));
    let bytes_before = fs::read(settings_path(&app)).expect("settings before");
    // 另一个连接（相当于另一个进程）持有设置文件的跨进程锁，超时约 2 秒。
    let holder = rusqlite::Connection::open(app.app_data_dir().join(SETTINGS_LOCK_FILE))
        .expect("open settings lock");
    holder
        .execute_batch("BEGIN EXCLUSIVE;")
        .expect("hold settings lock");

    let error = save_cost_profile_impl(
        &app,
        &state,
        &profile(vec![plan("Claude Team")]),
        1,
        today(),
    )
    .expect_err("save must fail while the lock is held");
    assert_fixed_sentence(&error, SAVE_LOCK_ERROR);
    let error = clear_cost_profile_impl(&app, &state, 1)
        .expect_err("clear must fail while the lock is held");
    assert_fixed_sentence(&error, SAVE_LOCK_ERROR);

    holder.execute_batch("ROLLBACK;").expect("release lock");
    drop(holder);
    assert_eq!(
        fs::read(settings_path(&app)).expect("settings after"),
        bytes_before
    );
    assert_eq!(
        CostProfileView::from_settings(&state.lock().expect("state")),
        view
    );
    // 锁释放后照常保存。
    assert_eq!(
        saved_view(save(&app, &state, &profile(vec![plan("Claude Team")]), 1)).revision,
        2
    );
    cleanup(&app);
}

#[cfg(windows)]
#[test]
fn failed_settings_write_is_reported_as_a_fixed_sentence_and_keeps_the_file() {
    use std::os::windows::fs::OpenOptionsExt;
    // 只允许别人读：原子替换需要删除旧文件，因此失败（杀毒或索引程序占用时同样如此）。
    const FILE_SHARE_READ: u32 = 0x1;

    let app = test_app("write-failure");
    let state = state_for(&app);
    let view = saved_view(save(&app, &state, &profile(vec![plan("Claude Max")]), 0));
    let bytes_before = fs::read(settings_path(&app)).expect("settings before");
    let holder = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(settings_path(&app))
        .expect("hold settings file");

    let error = save_cost_profile_impl(
        &app,
        &state,
        &profile(vec![plan("Claude Team")]),
        1,
        today(),
    )
    .expect_err("save must fail while the file cannot be replaced");
    assert_fixed_sentence(&error, SAVE_WRITE_ERROR);
    let error = clear_cost_profile_impl(&app, &state, 1)
        .expect_err("clear must fail while the file cannot be replaced");
    assert_fixed_sentence(&error, SAVE_WRITE_ERROR);

    drop(holder);
    // 原子替换没有发生：文件逐字节不变，内存副本不变，也没有留下临时文件。
    assert_eq!(
        fs::read(settings_path(&app)).expect("settings after"),
        bytes_before
    );
    assert_eq!(
        CostProfileView::from_settings(&state.lock().expect("state")),
        view
    );
    let leftovers: Vec<String> = fs::read_dir(app.app_data_dir())
        .expect("list app data")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".tmp."))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    cleanup(&app);
}

// ---------------------------------------------------------------------------
// 通用设置保存与手改的设置文件
// ---------------------------------------------------------------------------

#[test]
fn stale_generic_settings_save_cannot_overwrite_the_cost_profile() {
    let app = test_app("stale-general-save");
    let state = state_for(&app);
    // 设置页打开时拿到的还是没有订阅的设置。
    let stale_page = settings::load_settings(&app);
    let view = saved_view(save(&app, &state, &profile(vec![plan("Claude Max")]), 0));

    // 旧页面只改了扫描间隔，却把手里过时（甚至被改过）的 cost_* 字段一并提交。
    let mut incoming = stale_page.clone();
    incoming.scan_interval_secs = 600;
    incoming.cost_profile_revision = 99;
    incoming.cost_cny_per_usd = Some(9.9);
    incoming
        .cost_tool_billing_modes
        .insert("claude".to_string(), CostBillingMode::Payg);
    let persisted =
        settings::save_general_settings_preserving_quota_sync(&app, &stale_page, incoming)
            .expect("general save");
    assert_eq!(persisted.scan_interval_secs, 600);
    assert_eq!(CostProfileView::from_settings(&persisted), view);

    // 经 IPC 提交的是整份 AppSettings JSON：前端回传的旧 cost_* 字段同样被忽略。
    let mut webview_json = serde_json::to_value(&stale_page).expect("settings json");
    webview_json["desktop_interval_secs"] = json!(90);
    webview_json["cost_subscription_plans"] = json!([]);
    webview_json["cost_profile_revision"] = json!(0);
    let from_webview: AppSettings = serde_json::from_value(webview_json).expect("webview settings");
    let persisted =
        settings::save_general_settings_preserving_quota_sync(&app, &stale_page, from_webview)
            .expect("general save from webview");
    assert_eq!(persisted.desktop_interval_secs, 90);
    assert_eq!(CostProfileView::from_settings(&persisted), view);
    assert_eq!(
        CostProfileView::from_settings(&settings::load_settings(&app)),
        view
    );
    cleanup(&app);
}

#[test]
fn hand_edited_settings_file_is_sanitized_entry_by_entry() {
    let app = test_app("hand-edited");
    let valid = json!({
        "id": "sub-0123456789abcdef",
        "name": "Claude Max",
        "provider": "anthropic",
        "fee": 200,
        "currency": "USD",
        "cycle": "monthly",
        "anchorDay": 15,
        "startDate": "2026-03-15",
        "endDate": null,
        "tools": ["claude"],
        "modelPrefixes": ["claude-"],
        "machines": []
    });
    let variant = |id: &str, patch: Value| with(with(valid.clone(), json!({ "id": id })), patch);
    write_raw_settings(
        &app,
        &json!({
            "scan_interval_secs": 1800,
            "scan_policy_version": 1,
            "desktop_interval_secs": 60,
            "lockscreen_interval_secs": 300,
            "wallpaper_desktop_enabled": false,
            "wallpaper_lockscreen_enabled": false,
            "wallpaper_consent_version": 1,
            "autostart_enabled": false,
            "start_minimized": true,
            "wallpaper_use_cloud": false,
            "quota_codex_local_enabled": true,
            "cost_subscription_plans": [
                valid,
                // 未知服务商、币种与计费周期：整条丢弃，不改写成 other / USD / monthly。
                variant("sub-1111111111111111", json!({ "name": "Grok", "provider": "xai", "tools": ["grok"] })),
                variant("sub-2222222222222222", json!({ "name": "Kimi", "currency": "EUR", "tools": ["kimi"] })),
                variant("sub-3333333333333333", json!({ "name": "Gemini", "cycle": "quarterly", "tools": ["gemini"] })),
                variant("sub-4444444444444444", json!({ "name": "Codex", "fee": "20", "tools": ["codex"] })),
                // 与已保留的订阅 ID 重复、重名、时段重叠：保留先出现的那条。
                variant("sub-0123456789abcdef", json!({ "name": "Copy", "tools": ["pi"] })),
                variant("sub-5555555555555555", json!({ "name": "claude max", "tools": ["pi"] })),
                variant("sub-6666666666666666", json!({ "name": "Claude Team", "startDate": "2026-06-01" })),
                // 设置文件里只认保存时写出的规范形态。
                variant("sub-7777777777777777", json!({ "name": " Padded ", "tools": ["pi"] })),
                variant("sub-9999999999999999", json!({ "name": "No machines", "tools": ["pi"], "machines": null })),
                "not a plan",
                variant("sub-8888888888888888", json!({
                    "name": "DeepSeek",
                    "provider": "deepseek",
                    "fee": 50,
                    "currency": "CNY",
                    "tools": ["deepseek"],
                    "modelPrefixes": []
                }))
            ],
            "cost_tool_billing_modes": { "opencode": "payg", "kilo": "subscription", " spaced": "payg", "grok": 1 },
            "cost_cny_per_usd": 72,
            "cost_profile_revision": "seven",
            "a_field_from_a_newer_build": true
        }),
    );
    take_dropped();
    let loaded = settings::load_settings_result(&app).expect("hand-edited settings stay readable");
    // 其他设置照常读出，不因订阅设置里的坏条目整体回落默认值。
    assert_eq!(loaded.scan_interval_secs, 1800);
    assert!(loaded.start_minimized);
    assert!(loaded.quota_codex_local_enabled);
    let ids: Vec<_> = loaded
        .cost_subscription_plans
        .iter()
        .map(|plan| plan.id.as_str())
        .collect();
    assert_eq!(ids, ["sub-0123456789abcdef", "sub-8888888888888888"]);
    assert_eq!(
        loaded.cost_subscription_plans[1].currency,
        CostCurrency::Cny
    );
    assert_eq!(
        loaded.cost_tool_billing_modes,
        BTreeMap::from([("opencode".to_string(), CostBillingMode::Payg)])
    );
    // 汇率 72 越界：不可得，不冒充默认的 7.2。
    assert_eq!(loaded.cost_cny_per_usd, None);
    assert_eq!(loaded.cost_profile_revision, 0);
    // 日志只记类别与条数。
    let dropped = vec![
        ("CNY/USD rate", 1),
        ("billing mode entr(ies)", 3),
        ("profile revision", 1),
        ("subscription plan(s)", 10),
    ];
    assert_eq!(take_dropped(), dropped);

    // 同一类别每个进程只告警一次：同一份手改文件再读一遍，照样丢弃，但不再写日志。
    take_logged_reports();
    let again = settings::load_settings_result(&app).expect("reread hand-edited settings");
    assert_eq!(again.cost_subscription_plans.len(), 2);
    assert_eq!(take_dropped(), dropped);
    assert_eq!(take_logged_reports(), Vec::<&str>::new());

    // 下一次任何设置写入只写出清洗后的订阅设置，其他字段不变。
    settings::update_desktop_widget_position(&app, Some((10, 20))).expect("unrelated write");
    let raw = read_raw_settings(&app);
    assert_eq!(
        raw["cost_subscription_plans"]
            .as_array()
            .expect("plans")
            .len(),
        2
    );
    assert_eq!(raw["cost_cny_per_usd"], Value::Null);
    assert_eq!(raw["scan_interval_secs"], json!(1800));
    // 「汇率不可得」读回来仍不可得，也不再重复记日志。
    take_dropped();
    let reread = settings::load_settings_result(&app).expect("reread");
    assert_eq!(reread.cost_cny_per_usd, None);
    assert_eq!(reread.cost_subscription_plans.len(), 2);
    assert_eq!(take_dropped(), Vec::new());
    cleanup(&app);
}

#[test]
fn each_kind_of_dropped_entry_is_logged_once_per_process() {
    // 只在本测试里用的类别：不受其他测试先记过的类别影响。
    const PROBE: &str = "warn-once probe entr(ies)";
    take_dropped();
    take_logged_reports();
    report_dropped(PROBE, 3);
    report_dropped(PROBE, 2);
    report_dropped(PROBE, 0);
    // 每次丢弃都照常发生并计数，日志只在第一次写。
    assert_eq!(take_dropped(), vec![(PROBE, 2), (PROBE, 3)]);
    assert_eq!(take_logged_reports(), vec![PROBE]);
}

#[test]
fn unreadable_cost_fields_never_reset_the_rest_of_the_settings() {
    let app = test_app("unreadable-fields");
    let cases = [
        (json!("oops"), json!([1, 2]), json!("7.2"), json!(-3)),
        (json!({ "a": 1 }), Value::Null, json!(true), json!(1.5)),
        (
            Value::Null,
            json!("payg"),
            json!({}),
            json!(9_007_199_254_740_992_u64),
        ),
    ];
    for (index, (plans, modes, rate, revision)) in cases.into_iter().enumerate() {
        write_raw_settings(
            &app,
            &json!({
                "scan_interval_secs": 777,
                "desktop_interval_secs": 60,
                "lockscreen_interval_secs": 300,
                "wallpaper_desktop_enabled": false,
                "wallpaper_lockscreen_enabled": false,
                "autostart_enabled": false,
                "start_minimized": false,
                "wallpaper_use_cloud": false,
                "cost_subscription_plans": plans,
                "cost_tool_billing_modes": modes,
                "cost_cny_per_usd": rate,
                "cost_profile_revision": revision
            }),
        );
        let loaded = settings::load_settings_result(&app)
            .unwrap_or_else(|error| panic!("case {index} must stay readable: {error}"));
        assert_eq!(loaded.scan_interval_secs, 777, "case {index}");
        assert!(loaded.cost_subscription_plans.is_empty(), "case {index}");
        assert!(loaded.cost_tool_billing_modes.is_empty(), "case {index}");
        assert_eq!(loaded.cost_cny_per_usd, None, "case {index}");
        assert_eq!(loaded.cost_profile_revision, 0, "case {index}");
        assert_eq!(settings::load_settings(&app).scan_interval_secs, 777);
    }
    // 设置文件整个解析不了时，读取给出固定的错误，不回显文件内容。
    fs::write(
        settings_path(&app),
        b"{ \"cost_subscription_plans\": [ secret",
    )
    .expect("write");
    assert_eq!(get_cost_profile_impl(&app), Err(READ_ERROR.to_string()));
    assert_eq!(
        validate_cost_profile_impl(&app, &profile(Vec::new()), today()),
        Err(READ_ERROR.to_string())
    );
    cleanup(&app);
}

#[test]
fn sanitizing_in_memory_settings_keeps_the_first_of_conflicting_plans() {
    let first = stored_plan("sub-0123456789abcdef", "Claude Max");
    let mut overlapping = stored_plan("sub-1111111111111111", "Claude Team");
    overlapping.start_date = date("2026-06-01");
    let mut negative_fee = stored_plan("sub-2222222222222222", "Broken");
    negative_fee.tools = vec!["pi".to_string()];
    negative_fee.fee = -1.0;
    let mut unpadded = stored_plan("sub-3333333333333333", " Padded");
    unpadded.tools = vec!["codex".to_string()];
    take_dropped();
    let sanitized = AppSettings {
        cost_subscription_plans: vec![first.clone(), overlapping, negative_fee, unpadded],
        cost_tool_billing_modes: BTreeMap::from([
            ("opencode".to_string(), CostBillingMode::Payg),
            ("bad\ntool".to_string(), CostBillingMode::Payg),
        ]),
        cost_cny_per_usd: Some(0.5),
        cost_profile_revision: MAX_REVISION + 1,
        ..AppSettings::default()
    }
    .sanitized();
    assert_eq!(sanitized.cost_subscription_plans, vec![first]);
    assert_eq!(
        sanitized.cost_tool_billing_modes.keys().collect::<Vec<_>>(),
        ["opencode"]
    );
    assert_eq!(sanitized.cost_cny_per_usd, None);
    assert_eq!(sanitized.cost_profile_revision, 0);
    assert_eq!(
        take_dropped(),
        vec![
            ("CNY/USD rate", 1),
            ("billing mode entr(ies)", 1),
            ("profile revision", 1),
            ("subscription plan(s)", 3),
        ]
    );

    // 超过 12 个订阅时只保留前 12 个。
    let many: Vec<CostSubscriptionPlan> = (0..13)
        .map(|index| {
            let mut plan = stored_plan(&format!("sub-{index:016x}"), &format!("plan {index}"));
            plan.tools = vec![format!("tool{index}")];
            plan
        })
        .collect();
    let sanitized = AppSettings {
        cost_subscription_plans: many.clone(),
        ..AppSettings::default()
    }
    .sanitized();
    assert_eq!(
        sanitized.cost_subscription_plans,
        many[..MAX_PLANS].to_vec()
    );
    // 合规的值原样保留，清洗是空操作，不记日志。
    take_dropped();
    let clean = sanitized.clone().sanitized();
    assert_eq!(
        clean.cost_subscription_plans,
        sanitized.cost_subscription_plans
    );
    assert_eq!(clean.cost_cny_per_usd, Some(DEFAULT_CNY_PER_USD));
    assert_eq!(take_dropped(), Vec::new());
}

#[test]
fn debug_output_never_contains_names_amounts_or_coverage() {
    let app = test_app("debug-redaction");
    let state = state_for(&app);
    saved_view(save(
        &app,
        &state,
        &profile(vec![with(
            plan("Secret Plan 名称"),
            json!({ "fee": 4321.98, "machines": ["Private-Laptop"], "modelPrefixes": ["hidden-prefix"] }),
        )]),
        0,
    ));
    let loaded = settings::load_settings(&app);
    let debug = format!("{loaded:?} {:?}", CostProfile::from_settings(&loaded));
    for secret in [
        "Secret Plan",
        "名称",
        "4321.98",
        "Private-Laptop",
        "hidden-prefix",
    ] {
        assert!(!debug.contains(secret), "{secret} leaked into Debug output");
    }
    assert!(debug.contains("CostSubscriptionPlan"));
    // 校验错误的 Debug 不输出提示文案（其中可能有订阅名称）。
    let errors = errors_of(
        &profile(vec![plan("Secret Plan"), plan("secret plan")]),
        &CostProfile::cleared(),
    );
    assert!(!errors.is_empty());
    assert!(!format!("{errors:?}").contains("ecret"));
    cleanup(&app);
}
