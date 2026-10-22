//! T10.183：缓存净节省本机生产（T10.162 方案 §3.1、§3.4、§4.2、§4.7；契约
//! dashboard-stats-v2 §2.4）。
//!
//! - 方案 §3.4 的例算在公式层逐行复现：参考实现 `estimate_cache_savings_parts` 与按
//!   (工具, 模型) 缓存的 `PriceRates::cache_parts` 都算一遍并逐位对照（T10.167 评审 F2）。
//! - 两份共享 fixture 的 `rows` + `prices` 经本机汇总器复算，与 fixture 的 summary、
//!   expected 对账：桌面、Android 与云端用的是同一份数。
//! - 总览、同期、明细与专属看板四处 summary 带同一个对象，本机响应声明能力；拆分不可
//!   证明时对象与读写拆分一起缺失（用户决定 Q6）。
//! - 桌面对云端的桥接：旧云端按本机价格桥接；RPC 声明能力后直接采用 RPC 的结果。

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const VALID_FIXTURE: &str =
    include_str!("../../../fixtures/dashboard-stats-v2/cache-savings-v2.json");
const INVALID_FIXTURE: &str =
    include_str!("../../../fixtures/dashboard-stats-v2/cache-savings-invalid-v2.json");

static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn fixture(raw: &str) -> Value {
    serde_json::from_str(raw).expect("shared cache savings fixture must be valid JSON")
}

/// 方案 §3.4 例算用的单价（USD/百万 Token），即 fixture 的 `prices`。
fn example_prices() -> Value {
    fixture(VALID_FIXTURE)["prices"].clone()
}

#[track_caller]
fn assert_close(actual: f64, expected: f64, label: &str) {
    assert!(
        (actual - expected).abs() <= 1e-9,
        "{label}: expected {expected}, got {actual}"
    );
}

/// 两处实现都算一遍并逐位对照，返回参考实现的结果。
#[track_caller]
fn both_parts(prices: &Value, tool: &str, model: &str, read: i64, write: i64) -> CacheSavingsParts {
    let reference = estimate_cache_savings_parts(prices, tool, model, read, write);
    let memoized = PriceMemo::new(prices)
        .rates(tool, model)
        .cache_parts(read, write);
    assert_eq!(
        reference.read_saved.to_bits(),
        memoized.read_saved.to_bits(),
        "{tool}/{model}: read savings differ between the two implementations"
    );
    assert_eq!(
        reference.write_premium.to_bits(),
        memoized.write_premium.to_bits(),
        "{tool}/{model}: write premium differs between the two implementations"
    );
    assert_eq!(
        (
            reference.fallback_read_tokens,
            reference.fallback_write_tokens
        ),
        (
            memoized.fallback_read_tokens,
            memoized.fallback_write_tokens
        ),
        "{tool}/{model}: fallback counts differ between the two implementations"
    );
    reference
}

fn stat_row(
    id: i64,
    tool: &str,
    model: &str,
    tokens: (i64, i64),
    cache: (i64, i64),
    cost_usd: Option<f64>,
) -> StatRow {
    StatRow {
        id,
        tool: tool.to_string(),
        model: model.to_string(),
        input_tokens: tokens.0,
        output_tokens: tokens.1,
        cached_tokens: cache.0,
        cache_write_tokens: cache.1,
        cache_write_known: None,
        usage_provenance: None,
        timestamp: "2026-07-15 09:00:00".to_string(),
        session_id: format!("cache-savings-{id}"),
        cost_usd,
        machine_id: "fixture-device".to_string(),
    }
}

/// fixture 用例的 `rows`：存储口径，`cachedTokens` 是读写合计。
fn fixture_rows(case: &Value) -> Vec<StatRow> {
    case["rows"]
        .as_array()
        .expect("fixture case rows")
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let field = |name: &str| {
                row[name]
                    .as_i64()
                    .unwrap_or_else(|| panic!("fixture row field {name}"))
            };
            stat_row(
                index as i64 + 1,
                row["tool"].as_str().expect("fixture row tool"),
                row["model"].as_str().expect("fixture row model"),
                (field("inputTokens"), field("outputTokens")),
                (field("cachedTokens"), field("cacheWriteTokens")),
                None,
            )
        })
        .collect()
}

/// 本机总览汇总器对这些行给出的 `summary`（2026-07-15 09:30 的「本月」）。
fn local_summary(rows: &[StatRow], prices: &Value) -> Value {
    let now = NaiveDate::from_ymd_opt(2026, 7, 15)
        .unwrap()
        .and_hms_opt(9, 30, 0)
        .unwrap();
    aggregate_rows_for_window(rows, StatsRange::Month, prices, now, None, now)["summary"].clone()
}

/// 一个 summary 里的 `cacheSavings` 满足契约 §2.4 的生产端不变量。
#[track_caller]
fn assert_local_object_invariants(label: &str, summary: &Value) {
    let savings = &summary["cacheSavings"];
    let mut keys: Vec<&str> = savings
        .as_object()
        .unwrap_or_else(|| panic!("{label}: cacheSavings must be an object"))
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "fallbackPricedReadTokens",
            "fallbackPricedWriteTokens",
            "netSavedUsd",
            "priceBasis",
            "readSavedUsd",
            "writePremiumUsd"
        ],
        "{label}: exactly the six contract fields"
    );
    let read = savings["readSavedUsd"].as_f64().unwrap();
    let premium = savings["writePremiumUsd"].as_f64().unwrap();
    let net = savings["netSavedUsd"].as_f64().unwrap();
    assert!(read.is_finite() && read >= 0.0, "{label}: read savings");
    assert!(
        premium.is_finite() && premium >= 0.0,
        "{label}: write premium"
    );
    assert_eq!(
        net.to_bits(),
        (read - premium).to_bits(),
        "{label}: net is read − premium, not rounded"
    );
    assert_eq!(
        read.to_bits(),
        summary["cacheSavedUsd"].as_f64().unwrap().to_bits(),
        "{label}: readSavedUsd is the unchanged gross cacheSavedUsd"
    );
    let read_tokens = summary["cacheReadTokens"].as_i64().unwrap();
    let write_tokens = summary["cacheWriteTokens"].as_i64().unwrap();
    assert!((0..=read_tokens).contains(&savings["fallbackPricedReadTokens"].as_i64().unwrap()));
    assert!((0..=write_tokens).contains(&savings["fallbackPricedWriteTokens"].as_i64().unwrap()));
    assert_eq!(savings["priceBasis"], json!("local-prices"));
}

#[track_caller]
fn assert_object_matches(label: &str, produced: &Value, expected: &Value) {
    for field in ["readSavedUsd", "writePremiumUsd", "netSavedUsd"] {
        assert_close(
            produced[field].as_f64().unwrap_or(f64::NAN),
            expected[field].as_f64().unwrap(),
            &format!("{label} {field}"),
        );
    }
    for field in [
        "fallbackPricedReadTokens",
        "fallbackPricedWriteTokens",
        "priceBasis",
    ] {
        assert_eq!(produced[field], expected[field], "{label} {field}");
    }
}

#[test]
fn worked_examples_of_spec_section_3_4_reproduce_at_full_precision() {
    let prices = example_prices();
    // ((工具, 模型), (读取量, 写入量), (读取节省, 写入溢价, 净节省), (兜底读取量, 兜底写入量))
    let sonnet = ("claude", "claude-sonnet-4-6");
    let examples = [
        // 第 1 行：全部列价。
        (sonnet, (8_000_000, 1_000_000), (21.6, 0.75, 20.85), (0, 0)),
        // 第 2 行：净值为负，带符号照实给出。
        (sonnet, (200_000, 1_000_000), (0.54, 0.75, -0.21), (0, 0)),
        // 第 3 行。
        (
            ("claude", "claude-fable-5"),
            (1_000_000, 1_000_000),
            (9.0, 2.5, 6.5),
            (0, 0),
        ),
        // 第 4 行：kimi-k2.6 缺写价，按 0.9 × 1.25 = 1.125 兜底，兜底写入量 2M。
        (
            ("kimi", "kimi-k2.6"),
            (4_000_000, 2_000_000),
            (3.0, 0.45, 2.55),
            (0, 2_000_000),
        ),
        // 第 5 行：既无折扣也无溢价，三项都是已知的 0。
        (
            ("codex", "gpt-5.5-pro"),
            (1_000_000, 1_000_000),
            (0.0, 0.0, 0.0),
            (0, 0),
        ),
        // 第 7 行：微小值全精度，不做中间舍入。
        (sonnet, (3_000, 0), (0.0081, 0.0, 0.0081), (0, 0)),
        // 第 8 行：只写不读，净值为负的微小值。
        (sonnet, (0, 10_000), (0.0, 0.0075, -0.0075), (0, 0)),
    ];
    for ((tool, model), (read, write), (saved, premium, net), (fallback_read, fallback_write)) in
        examples
    {
        let label = format!("{model} {read}/{write}");
        let parts = both_parts(&prices, tool, model, read, write);
        assert_close(parts.read_saved, saved, &format!("{label} read savings"));
        assert_close(parts.write_premium, premium, &format!("{label} premium"));
        assert_close(parts.net_saved(), net, &format!("{label} net"));
        assert_eq!(
            (parts.fallback_read_tokens, parts.fallback_write_tokens),
            (fallback_read, fallback_write),
            "{label} fallback counts"
        );
        // 读取节省就是旧的毛值口径，逐位不变。
        assert_eq!(
            parts.read_saved.to_bits(),
            estimate_cache_savings(&prices, tool, model, read).to_bits(),
            "{label}: gross read savings changed"
        );
    }

    // 第 6 行：Codex 只上报读取，写入量缺失，拆分不可证明 → 整个范围不可得。
    let summary = local_summary(
        &[stat_row(
            1,
            "codex",
            "gpt-5.6-sol",
            (100_000, 20_000),
            (800_000, 0),
            None,
        )],
        &prices,
    );
    for field in [
        "cacheReadTokens",
        "cacheWriteTokens",
        "cacheSavedUsd",
        "cacheSavings",
    ] {
        assert!(summary.get(field).is_none(), "row 6 must leave {field} out");
    }
    assert_eq!(summary["cachedTokens"], json!(800_000));
}

#[test]
fn shared_valid_fixture_is_reproduced_by_the_local_aggregator() {
    let fixture = fixture(VALID_FIXTURE);
    let prices = &fixture["prices"];
    let mut reproduced = 0;
    for case in fixture["cases"].as_array().expect("fixture cases") {
        let name = case["name"].as_str().expect("case name");
        let expected = &case["expected"];
        let stated = &case["summary"];
        assert!(expected.is_object(), "{name}: valid cases expect an object");
        if case.get("rows").is_none() {
            // 云端形状（uploaded-prices）只给消费端用。
            assert_eq!(expected["priceBasis"], json!("uploaded-prices"), "{name}");
            continue;
        }
        let produced = local_summary(&fixture_rows(case), prices);
        for field in [
            "totalTokens",
            "inputTokens",
            "outputTokens",
            "cachedTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "totalRequests",
            "avgTokensPerReq",
        ] {
            assert_eq!(produced[field], stated[field], "{name} {field}");
        }
        assert_close(
            produced["totalCost"].as_f64().unwrap(),
            stated["totalCost"].as_f64().unwrap(),
            &format!("{name} totalCost"),
        );
        assert_close(
            produced["cacheSavedUsd"].as_f64().unwrap(),
            stated["cacheSavedUsd"].as_f64().unwrap(),
            &format!("{name} cacheSavedUsd"),
        );
        assert_local_object_invariants(name, &produced);
        assert_object_matches(name, &produced["cacheSavings"], expected);
        // fixture 写的对象与 expected 相同（未知附加键只出现在云端形状里）。
        assert_eq!(&stated["cacheSavings"], expected, "{name}: stated object");
        reproduced += 1;
    }
    assert_eq!(reproduced, 8, "every local-prices case is reproduced");
}

#[test]
fn shared_invalid_fixture_expects_absence_and_the_unproven_case_is_reproduced() {
    let fixture = fixture(INVALID_FIXTURE);
    let cases = fixture["cases"].as_array().expect("fixture cases");
    assert!(cases.len() >= 10, "the invalid fixture covers every rule");
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        assert!(
            case["expected"].is_null(),
            "{name}: invalid cases expect null"
        );
        let summary = &case["summary"];
        for field in [
            "totalTokens",
            "inputTokens",
            "outputTokens",
            "cachedTokens",
            "totalCost",
            "totalRequests",
            "avgTokensPerReq",
        ] {
            assert!(
                summary[field].as_f64().is_some_and(f64::is_finite),
                "{name}: the old core field {field} stays valid"
            );
        }
    }

    let unproven = &cases[0];
    assert_eq!(unproven["name"], json!("split-unproven-object-absent"));
    let produced = local_summary(&fixture_rows(unproven), &fixture["prices"]);
    let stated = &unproven["summary"];
    for field in [
        "totalTokens",
        "inputTokens",
        "outputTokens",
        "cachedTokens",
        "totalRequests",
        "avgTokensPerReq",
    ] {
        assert_eq!(produced[field], stated[field], "unproven {field}");
    }
    assert_close(
        produced["totalCost"].as_f64().unwrap(),
        stated["totalCost"].as_f64().unwrap(),
        "unproven totalCost",
    );
    for field in [
        "cacheReadTokens",
        "cacheWriteTokens",
        "cacheSavedUsd",
        "cacheSavings",
    ] {
        assert!(
            produced.get(field).is_none(),
            "unproven range leaves {field} out"
        );
        assert!(stated.get(field).is_none(), "fixture leaves {field} out");
    }
}

#[test]
fn fallback_counts_follow_the_price_source() {
    let prices = json!({
        "listed": { "input": 2.0, "output": 8.0, "cache_input": 0.2, "cache_write": 2.5 },
        "no-write": { "input": 2.0, "output": 8.0, "cache_input": 0.2 },
        "no-read": { "input": 2.0, "output": 8.0, "cache_write": 2.5 },
        "no-input": { "output": 8.0, "cache_input": 0.2, "cache_write": 2.5 },
        "pending": {
            "input": 2.0, "output": 8.0, "cache_input": 0.2, "cache_write": 2.0,
            "_meta": { "status": "auto_discovered", "fallback_key": "minimax-model" }
        },
        "edited": {
            "input": 2.0, "output": 8.0, "cache_input": 0.2, "cache_write": 2.5,
            "_meta": { "status": "user_edited", "price_source": "user_override" }
        },
        "claude-unknown": { "input": 3.0, "output": 15.0, "cache_input": 0.3, "cache_write": 3.75 },
        "default": { "input": 1.0, "output": 3.0 }
    });
    let (read, write) = (1_000_000, 100_000);

    // 列价：读写单价都写在该模型的显式条目里，不计兜底。
    let listed = both_parts(&prices, "other", "listed", read, write);
    assert_eq!(
        (listed.fallback_read_tokens, listed.fallback_write_tokens),
        (0, 0)
    );
    assert_close(listed.read_saved, 1.8, "listed read");
    assert_close(listed.write_premium, 0.05, "listed premium");

    // 缺写价：写价按输入价 × 1.25 兜底（与预估费用同一兜底），只计兜底写入量。
    let no_write = both_parts(&prices, "other", "no-write", read, write);
    assert_eq!(
        (
            no_write.fallback_read_tokens,
            no_write.fallback_write_tokens
        ),
        (0, write)
    );
    assert_close(no_write.write_premium, 0.05, "fallback write premium");

    // 缺读价：读价按输入价 × 0.1 兜底，只计兜底读取量。
    let no_read = both_parts(&prices, "other", "no-read", read, write);
    assert_eq!(
        (no_read.fallback_read_tokens, no_read.fallback_write_tokens),
        (read, 0)
    );
    assert_close(no_read.read_saved, 1.8, "fallback read savings");

    // 缺输入价：两项都依赖内置输入价 1.0，都算兜底。
    let no_input = both_parts(&prices, "other", "no-input", read, write);
    assert_eq!(
        (
            no_input.fallback_read_tokens,
            no_input.fallback_write_tokens
        ),
        (read, write)
    );
    assert_close(no_input.read_saved, 0.8, "no-input read savings");
    assert_close(no_input.write_premium, 0.15, "no-input premium");

    // 自动发现的「待核价」条目：字段齐全也算兜底。
    let pending = both_parts(&prices, "opencode", "pending", read, write);
    assert_eq!(
        (pending.fallback_read_tokens, pending.fallback_write_tokens),
        (read, write)
    );
    // 用户改过的自动发现项按用户覆盖算作列价。
    let edited = both_parts(&prices, "opencode", "edited", read, write);
    assert_eq!(
        (edited.fallback_read_tokens, edited.fallback_write_tokens),
        (0, 0)
    );

    // 型号未命中，按工具兜底键计价：兜底键写全了读写价也算兜底。
    let tool_fallback = both_parts(&prices, "claude", "claude-opus-9", read, write);
    assert_eq!(
        (
            tool_fallback.fallback_read_tokens,
            tool_fallback.fallback_write_tokens
        ),
        (read, write)
    );
    assert_close(tool_fallback.read_saved, 2.7, "tool fallback read");
    assert_close(tool_fallback.write_premium, 0.075, "tool fallback premium");

    // `default`，以及价格表连 `default` 都没有时的内置缺省。
    for table in [prices.clone(), json!({}), Value::Null] {
        let parts = both_parts(&table, "pi", "mystery-model", read, write);
        assert_eq!(
            (parts.fallback_read_tokens, parts.fallback_write_tokens),
            (read, write)
        );
        assert_close(parts.read_saved, 0.9, "default read savings");
        assert_close(parts.write_premium, 0.025, "default premium");
    }

    // 没有读写量的行不计兜底，三项都是 0。
    assert_eq!(
        both_parts(&prices, "pi", "mystery-model", 0, 0),
        CacheSavingsParts::default()
    );
}

#[test]
fn auto_discovered_entries_count_as_fallback_and_pin_the_d7_write_multiplier() {
    // 方案 §1.8 D7：自动发现条目的写价，兜底键是 Claude 系时按输入 × 1.25，其余按
    // 输入 × 1.0，与预估费用缺写价时的 1.25 不一致。统一成哪一个另行决定；这里只固定
    // 现状，并确认这类条目一律计入兜底（方案 §4.2）。
    let discovered = |tool: &str, model: &str| DiscoveredModelPrice {
        tool: tool.to_string(),
        model_key: model.to_ascii_lowercase(),
        model: model.to_string(),
        tools: vec![tool.to_string()],
        first_seen_at: "2026-07-10 10:00:00".to_string(),
        last_seen_at: "2026-07-10 11:00:00".to_string(),
    };
    let prices = merge_discovered_prices(
        json!({
            "claude-unknown": { "input": 3.0, "output": 15.0, "cache_input": 0.3 },
            "minimax-model": { "input": 0.4, "output": 1.2 },
            "default": { "input": 1.0, "output": 3.0 }
        }),
        &[
            discovered("claude", "claude-future-9"),
            discovered("opencode", "vendor-future-1"),
        ],
    );
    assert_eq!(
        prices["claude-future-9"]["_meta"]["status"],
        json!("auto_discovered")
    );

    let claude = both_parts(&prices, "claude", "claude-future-9", 1_000_000, 1_000_000);
    assert_eq!(
        (claude.fallback_read_tokens, claude.fallback_write_tokens),
        (1_000_000, 1_000_000)
    );
    assert_close(claude.read_saved, 2.7, "discovered claude read");
    // 3.0 × 1.25 − 3.0 = 0.75。
    assert_close(claude.write_premium, 0.75, "discovered claude premium");

    let vendor = both_parts(&prices, "opencode", "vendor-future-1", 1_000_000, 1_000_000);
    assert_eq!(
        (vendor.fallback_read_tokens, vendor.fallback_write_tokens),
        (1_000_000, 1_000_000)
    );
    // 写价抄作输入价（1.0×），写入溢价为 0；预估费用若缺写价会按 1.25× 计（D7）。
    assert_eq!(vendor.write_premium, 0.0);
    assert_close(vendor.read_saved, 0.36, "discovered vendor read");
}

#[test]
fn anomalous_overrides_clamp_each_component_at_zero() {
    // 方案 §4.7 T11：用户覆盖出读价高于输入价、写价低于输入价时，各分量保守取 0。
    let prices = json!({
        "odd-model": { "input": 1.0, "output": 2.0, "cache_input": 2.0, "cache_write": 0.5 }
    });
    let parts = both_parts(&prices, "other", "odd-model", 1_000_000, 1_000_000);
    assert_eq!(parts.read_saved, 0.0);
    assert_eq!(parts.write_premium, 0.0);
    assert_eq!(parts.net_saved(), 0.0);
    assert_eq!(
        (parts.fallback_read_tokens, parts.fallback_write_tokens),
        (0, 0)
    );
}

#[test]
fn stored_vendor_costs_keep_the_bill_while_cache_savings_use_the_price_table() {
    // 方案 §4.7 T14：来源自带费用的行（opencode 等），预估费用用来源值，缓存节省仍按
    // 价格表估算。只有写入、没有读取的已存成本行以前不查价，现在要算写入溢价。
    let prices = example_prices();
    let rows = [
        stat_row(
            1,
            "opencode",
            "claude-sonnet-4-6",
            (1_000, 100),
            (9_000_000, 1_000_000),
            Some(0.42),
        ),
        stat_row(
            2,
            "opencode",
            "claude-sonnet-4-6",
            (1_000, 100),
            (10_000, 10_000),
            Some(0.05),
        ),
    ];
    let summary = local_summary(&rows, &prices);
    assert_close(
        summary["totalCost"].as_f64().unwrap(),
        0.47,
        "stored vendor costs are not repriced",
    );
    assert_local_object_invariants("vendor", &summary);
    let savings = &summary["cacheSavings"];
    assert_close(
        savings["readSavedUsd"].as_f64().unwrap(),
        21.6,
        "vendor read",
    );
    assert_close(
        savings["writePremiumUsd"].as_f64().unwrap(),
        0.7575,
        "vendor premium includes the write-only row",
    );
}

#[test]
fn effective_tokens_cost_and_cache_split_are_unchanged_by_the_new_object() {
    // 方案 §4.7 T15：有效 Token 仍是输入 + 输出，预估费用与缓存读写照旧。
    let prices = example_prices();
    let rows = [
        stat_row(
            1,
            "claude",
            "claude-sonnet-4-6",
            (100_000, 20_000),
            (9_000_000, 1_000_000),
            None,
        ),
        stat_row(
            2,
            "kimi",
            "kimi-k2.6",
            (80_000, 20_000),
            (6_000_000, 2_000_000),
            None,
        ),
    ];
    let summary = local_summary(&rows, &prices);
    assert_eq!(summary["totalTokens"], json!(220_000));
    assert_eq!(summary["cachedTokens"], json!(15_000_000));
    assert_eq!(summary["cacheReadTokens"], json!(12_000_000));
    assert_eq!(summary["cacheWriteTokens"], json!(3_000_000));
    let expected_cost = rows
        .iter()
        .map(|row| {
            estimate_cost(
                &prices,
                &row.tool,
                &row.model,
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens(),
                row.cache_write_tokens,
            )
        })
        .fold(0.0, |total, cost| total + cost);
    assert_eq!(
        summary["totalCost"].as_f64().unwrap().to_bits(),
        expected_cost.to_bits()
    );
    let expected_gross = rows
        .iter()
        .map(|row| estimate_cache_savings(&prices, &row.tool, &row.model, row.cache_read_tokens()))
        .fold(0.0, |total, saved| total + saved);
    assert_eq!(
        summary["cacheSavedUsd"].as_f64().unwrap().to_bits(),
        expected_gross.to_bits()
    );
    assert_local_object_invariants("unchanged", &summary);
}

fn ledger_app(label: &str) -> (AppContext, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "tokenledger_t183_{label}_{}_{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&root);
    let app = AppContext::for_test(root.clone());
    db::init_db(&db::get_db_path(&app)).expect("initialize cache savings ledger");
    // 用户价格覆盖固定为方案 §3.4 的 Sonnet 单价，内置价格表以后改价也不影响本测试。
    fs::write(
        root.join("prices.json"),
        json!({ "claude-sonnet-4-6": example_prices()["claude-sonnet-4-6"].clone() }).to_string(),
    )
    .expect("write price override");
    (app, root)
}

/// 插入一条待估价（`cost_usd` 为空）的记录；`cache` 是（读写合计, 写入量）。
fn insert_ledger_row(
    app: &AppContext,
    key: &str,
    (tool, model): (&str, &str),
    timestamp: &str,
    cache: (i64, i64),
) {
    let conn = db::get_connection(&db::get_db_path(app)).expect("open ledger");
    conn.execute(
        "INSERT INTO token_logs
            (tool, model, input_tokens, output_tokens, cached_tokens,
             cache_write_tokens, timestamp, session_id, unique_key,
             cost_usd, machine_id, sync_status)
         VALUES (?1, ?2, 100000, 20000, ?3, ?4, ?5, ?6, ?6, NULL, 'mac', 0)",
        params![tool, model, cache.0, cache.1, timestamp, key],
    )
    .expect("insert ledger row");
}

const SONNET: (&str, &str) = ("claude", "claude-sonnet-4-6");

fn host_timezone() -> String {
    iana_time_zone::get_timezone().expect("test host must expose its IANA timezone")
}

fn ledger_now() -> DateTime<Local> {
    Local
        .with_ymd_and_hms(2026, 7, 15, 12, 0, 0)
        .single()
        .expect("test wall-clock time must exist in the host timezone")
}

fn today_query() -> LocalStatsQuery {
    serde_json::from_value(json!({ "range": "today", "timezone": host_timezone() }))
        .expect("today stats query")
}

fn today_details() -> UsageDetailsQuery {
    serde_json::from_value(json!({
        "scope": "local",
        "range": "today",
        "timezone": host_timezone()
    }))
    .expect("today details query")
}

fn today_entity(tool: &str) -> EntityDashboardQuery {
    serde_json::from_value(json!({
        "scope": "local",
        "entity": { "kind": "tool", "id": tool },
        "range": "today",
        "timezone": host_timezone()
    }))
    .expect("today entity query")
}

#[test]
fn every_local_summary_surface_carries_the_object_and_the_capability() {
    let (app, root) = ledger_app("surfaces");
    // 今天：方案 §3.4 第 1 行；昨天同一时刻之前：第 2 行（净值为负）。
    insert_ledger_row(
        &app,
        "today",
        SONNET,
        "2026-07-15 09:00:00",
        (9_000_000, 1_000_000),
    );
    insert_ledger_row(
        &app,
        "yesterday",
        SONNET,
        "2026-07-14 09:00:00",
        (1_200_000, 1_000_000),
    );
    let now = ledger_now();

    let stats = get_local_stats_v2_impl_at(&app, today_query(), now).expect("local stats");
    let details = get_usage_details_impl_at(&app, today_details(), now).expect("local details");
    let entity =
        get_local_entity_dashboard_impl_at(&app, today_entity("claude"), now).expect("entity");

    let positive = (21.6, 0.75, 20.85);
    let negative = (0.54, 0.75, -0.21);
    let surfaces = [
        ("summary", &stats["summary"], positive),
        (
            "comparison.current",
            &stats["comparison"]["current"]["summary"],
            positive,
        ),
        (
            "comparison.previous",
            &stats["comparison"]["previous"]["summary"],
            negative,
        ),
        (
            "details.filteredSummary",
            &details["filteredSummary"],
            positive,
        ),
        ("entity.summary", &entity["summary"], positive),
        (
            "entity.comparison.previous",
            &entity["comparison"]["previous"]["summary"],
            negative,
        ),
        (
            "entity.historyPage.filteredSummary",
            &entity["historyPage"]["filteredSummary"],
            positive,
        ),
    ];
    for (label, summary, (read, premium, net)) in surfaces {
        assert_local_object_invariants(label, summary);
        let savings = &summary["cacheSavings"];
        assert_close(savings["readSavedUsd"].as_f64().unwrap(), read, label);
        assert_close(savings["writePremiumUsd"].as_f64().unwrap(), premium, label);
        assert_close(savings["netSavedUsd"].as_f64().unwrap(), net, label);
    }
    for (label, response) in [
        ("stats", &stats),
        ("details", &details),
        ("entity", &entity),
        ("entity.historyPage", &entity["historyPage"]),
    ] {
        assert_eq!(
            response["meta"]["capabilities"]["cacheSavings"],
            json!(true),
            "{label} declares the capability"
        );
    }

    // 用户决定 Q6：混入一条只上报读取的 Codex 记录，今天整个范围不可得；昨天（上期）
    // 与只含 Claude 的专属看板不受影响。
    insert_ledger_row(
        &app,
        "codex",
        ("codex", "gpt-5.6-sol"),
        "2026-07-15 10:00:00",
        (800_000, 0),
    );
    let stats = get_local_stats_v2_impl_at(&app, today_query(), now).expect("mixed stats");
    let details = get_usage_details_impl_at(&app, today_details(), now).expect("mixed details");
    let claude =
        get_local_entity_dashboard_impl_at(&app, today_entity("claude"), now).expect("claude");
    let codex =
        get_local_entity_dashboard_impl_at(&app, today_entity("codex"), now).expect("codex");
    for (label, summary) in [
        ("summary", &stats["summary"]),
        (
            "comparison.current",
            &stats["comparison"]["current"]["summary"],
        ),
        ("details.filteredSummary", &details["filteredSummary"]),
        ("codex entity", &codex["summary"]),
    ] {
        for field in ["cacheReadTokens", "cacheSavedUsd", "cacheSavings"] {
            assert!(summary.get(field).is_none(), "{label} leaves {field} out");
        }
    }
    assert_local_object_invariants(
        "comparison.previous",
        &stats["comparison"]["previous"]["summary"],
    );
    assert_local_object_invariants("claude entity", &claude["summary"]);
    assert_eq!(
        stats["meta"]["capabilities"]["cacheSavings"],
        json!(true),
        "capability true + object missing means this range is unavailable"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn cloud_bridge_adopts_an_rpc_that_declares_the_capability() {
    let root = std::env::temp_dir().join(format!(
        "tokenledger_t183_cloud_{}_{}",
        std::process::id(),
        TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&root);
    let app = AppContext::for_test(root.clone());
    let uploaded = json!({
        "readSavedUsd": 0.2,
        "writePremiumUsd": 0.01,
        "netSavedUsd": 0.19,
        "fallbackPricedReadTokens": 0,
        "fallbackPricedWriteTokens": 20,
        "priceBasis": "uploaded-prices"
    });
    let rpc = |summary: Value| {
        json!({
            "summary": summary,
            "models": {
                "gpt-test": { "cached": 100, "cacheRead": 80, "cacheWrite": 20, "tool": "codex" }
            },
            "meta": { "capabilities": { "cacheSavings": true } }
        })
    };

    // RPC 给了对象：原样采用，不再混入本机价格表算出的毛值。
    let adopted = post_process_cloud_stats(
        &app,
        rpc(json!({
            "cachedTokens": 100,
            "cacheReadTokens": 80,
            "cacheWriteTokens": 20,
            "cacheSavings": uploaded.clone()
        })),
    );
    assert_eq!(adopted["summary"]["cacheSavings"], uploaded);
    assert!(adopted["summary"].get("cacheSavedUsd").is_none());

    // 方案 §4.7 T10：新云端但范围里有未升级设备的空列，RPC 不给对象 → 不可得，不桥接。
    let unavailable = post_process_cloud_stats(
        &app,
        rpc(json!({ "cachedTokens": 100, "cacheReadTokens": 80, "cacheWriteTokens": 20 })),
    );
    assert!(unavailable["summary"].get("cacheSavings").is_none());
    assert!(unavailable["summary"].get("cacheSavedUsd").is_none());
    assert_eq!(unavailable["summary"]["cacheReadTokens"], json!(80));

    // 声明了能力但汇总与模型的拆分对不上：读写拆分与节省字段一起剥离。
    let inconsistent = post_process_cloud_stats(
        &app,
        rpc(json!({
            "cachedTokens": 100,
            "cacheReadTokens": 90,
            "cacheWriteTokens": 10,
            "cacheSavings": uploaded.clone()
        })),
    );
    for field in ["cacheReadTokens", "cacheWriteTokens", "cacheSavings"] {
        assert!(inconsistent["summary"].get(field).is_none(), "{field}");
    }

    // 桥接后的 meta 原样转告 RPC 的能力；旧云端不补这一位。
    let query = NormalizedStatsQuery::from_query(
        serde_json::from_value(json!({ "range": "month", "timezone": "UTC" })).unwrap(),
    )
    .unwrap();
    let merged = merge_cloud_dashboard(adopted, None, true, true, true, &query).unwrap();
    assert_eq!(merged["meta"]["capabilities"]["cacheSavings"], json!(true));
    let legacy = merge_cloud_dashboard(
        json!({ "summary": {}, "meta": {} }),
        None,
        false,
        false,
        false,
        &query,
    )
    .unwrap();
    assert!(legacy["meta"]["capabilities"].get("cacheSavings").is_none());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn antigravity_explicit_unknown_zero_poison_cache_split_and_net_savings() {
    let mut unknown = StatRow {
        id: 1,
        tool: "antigravity".into(),
        model: "antigravity-unknown".into(),
        input_tokens: 1,
        output_tokens: 1,
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_write_known: Some(false),
        usage_provenance: None,
        timestamp: "2026-10-08 00:00:00".into(),
        session_id: "fixture".into(),
        cost_usd: None,
        machine_id: "fixture".into(),
    };
    assert!(!unknown.cache_split_is_proven());
    let mut accumulator = SummaryAccumulator::default();
    let prices = json!({"default":{"input":2,"output":4,"cache_input":0.2,"cache_write":2.5}});
    let mut memo = PriceMemo::new(&prices);
    accumulator.add_row(&unknown, memo.row_price(&unknown));
    unknown.cached_tokens = 20;
    unknown.cache_write_tokens = 5;
    unknown.cache_write_known = Some(true);
    accumulator.add_row(&unknown, memo.row_price(&unknown));
    assert!(!accumulator.cache_split_proven);
    unknown.cached_tokens = 0;
    unknown.cache_write_tokens = 0;
    assert!(unknown.cache_split_is_proven());
    unknown.cache_write_known = None;
    assert!(unknown.cache_split_is_proven());
}
