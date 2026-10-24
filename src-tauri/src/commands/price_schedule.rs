//! 价格条目的生效日历史与长上下文分档（价格表 schema 2）。
//!
//! 一个条目顶层的四项单价是**现价**。两个可选字段让同一型号在不同记录上取不同单价：
//!
//! - `history`：调价前的旧价，按 `until`（RFC 3339，UTC）升序排列。时间早于某段
//!   `until` 的记录取最早一段覆盖它的旧价，其余记录取现价。段里写了的单价字段覆盖现价，
//!   没写的沿用现价（缺省字段照旧按兜底估算）。调价时把旧价写进 `history`，历史记录的
//!   口径就不会因为新价而改变；更正（原值本来就错）直接改现价，作用于全部历史。
//! - `tiers`：长上下文加价，按 `above_prompt_tokens` 升序排列。一条记录的提示长度
//!   （新鲜输入 + 缓存读 + 缓存写）超过某档阈值时，取阈值最高的那一档，把这条记录的四项
//!   单价分别乘以该档 `multipliers` 里的倍率（没写的项为 × 1）。倍率作用于生效的那一段
//!   单价，所以用户覆盖的单价同样带长上下文加价。分档只对逐请求记账的工具生效
//!   （`PER_REQUEST_TOOLS`）：别的工具一行可能是多次请求的合计，按合计长度判档会高估。
//!
//! 用户覆盖了某型号的单价时，覆盖值对该型号全部时间生效：合并时去掉内置的 `history`
//! （见 `strip_overridden_history`），分档倍率保留。

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use serde_json::{Map, Value};
use std::borrow::Cow;

use super::PRICE_RATE_FIELDS;

/// 每行就是一次模型请求的工具。只有它们的记录按提示长度套用分档。
pub(super) const PER_REQUEST_TOOLS: [&str; 4] = ["claude", "codex", "gemini", "grok"];

/// 分档倍率的上限；超过就当作写错的表，不接受。
const MAX_TIER_MULTIPLIER: f64 = 100.0;
/// 单价上限（美元 / 百万 Token）；超过就当作写错的表，不接受。
pub(super) const MAX_RATE: f64 = 10_000.0;

/// 记录时间：账本存本机时区的 `YYYY-MM-DD HH:MM:SS`，也接受 RFC 3339。解析不了时为
/// `None`，这条记录按现价计。
pub(super) fn record_instant(timestamp: &str) -> Option<DateTime<Utc>> {
    let trimmed = timestamp.trim();
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.with_timezone(&Utc));
    }
    let head = trimmed.get(..19).unwrap_or(trimmed).replace('T', " ");
    let naive = NaiveDateTime::parse_from_str(&head, "%Y-%m-%d %H:%M:%S").ok()?;
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|local| local.with_timezone(&Utc))
}

fn segment_until(segment: &Value) -> Option<DateTime<Utc>> {
    segment
        .get("until")
        .and_then(Value::as_str)
        .and_then(|until| DateTime::parse_from_rfc3339(until).ok())
        .map(|until| until.with_timezone(&Utc))
}

fn history(entry: &Value) -> &[Value] {
    entry
        .get("history")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// 条目有没有可用的旧价段：没有时不必解析记录时间。
pub(super) fn has_history(entry: &Value) -> bool {
    !history(entry).is_empty()
}

/// 记录落在哪一段：0 是现价，`i + 1` 是 `history[i]`。时间未知时取现价。
pub(super) fn segment_index(entry: &Value, at: Option<DateTime<Utc>>) -> usize {
    let Some(at) = at else {
        return 0;
    };
    history(entry)
        .iter()
        .position(|segment| segment_until(segment).is_some_and(|until| at < until))
        .map_or(0, |index| index + 1)
}

/// 第 `segment` 段的分档：段里写了 `tiers` 用段里的，否则用条目的。
fn tiers_of(entry: &Value, segment: usize) -> &[Value] {
    let own = segment
        .checked_sub(1)
        .and_then(|index| history(entry).get(index))
        .and_then(|segment| segment.get("tiers"));
    own.or_else(|| entry.get("tiers"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn tier_threshold(tier: &Value) -> Option<i64> {
    tier.get("above_prompt_tokens").and_then(Value::as_i64)
}

/// 提示长度命中哪一档：0 是标准档，`i + 1` 是 `tiers[i]`。
pub(super) fn tier_index(entry: &Value, segment: usize, prompt_tokens: i64) -> usize {
    tiers_of(entry, segment)
        .iter()
        .enumerate()
        .filter(|(_, tier)| tier_threshold(tier).is_some_and(|above| prompt_tokens > above))
        .max_by_key(|(_, tier)| tier_threshold(tier))
        .map_or(0, |(index, _)| index + 1)
}

/// 这个工具的记录是否按提示长度判档。
pub(super) fn tool_uses_tiers(tool: &str) -> bool {
    PER_REQUEST_TOOLS
        .iter()
        .any(|per_request| per_request.eq_ignore_ascii_case(tool))
}

/// 第 `segment` 段、第 `tier` 档的生效条目：只含四项单价与 `_meta`，供
/// `estimate_cost_with_price` / `PriceRates::from_price` 照常读取。现价标准档原样借用。
pub(super) fn entry_at(entry: &Value, segment: usize, tier: usize) -> Cow<'_, Value> {
    if segment == 0 && tier == 0 {
        return Cow::Borrowed(entry);
    }
    let Some(base) = entry.as_object() else {
        return Cow::Borrowed(entry);
    };
    let mut effective: Map<String, Value> = base
        .iter()
        .filter(|(field, _)| field.as_str() != "history" && field.as_str() != "tiers")
        .map(|(field, value)| (field.clone(), value.clone()))
        .collect();
    if let Some(old) = segment
        .checked_sub(1)
        .and_then(|index| history(entry).get(index))
        .and_then(Value::as_object)
    {
        for field in PRICE_RATE_FIELDS {
            if let Some(value) = old.get(field) {
                effective.insert(field.to_string(), value.clone());
            }
        }
    }
    if let Some(multipliers) = tier
        .checked_sub(1)
        .and_then(|index| tiers_of(entry, segment).get(index))
        .and_then(|tier| tier.get("multipliers"))
        .and_then(Value::as_object)
    {
        // 只乘写了的单价。缺省的缓存单价照旧按（已乘过倍率的）输入价兜底，仍记作兜底估算。
        for field in PRICE_RATE_FIELDS {
            let factor = multipliers.get(field).and_then(Value::as_f64);
            let rate = effective.get(field).and_then(Value::as_f64);
            if let (Some(factor), Some(rate)) = (factor, rate) {
                effective.insert(field.to_string(), Value::from(rate * factor));
            }
        }
    }
    Cow::Owned(Value::Object(effective))
}

/// 一条记录生效的条目：按记录时间选段，逐请求工具再按提示长度选档。
pub(super) fn entry_for_record<'a>(
    entry: &'a Value,
    tool: &str,
    timestamp: &str,
    prompt_tokens: i64,
) -> Cow<'a, Value> {
    let (segment, tier) = record_position(entry, tool, timestamp, prompt_tokens);
    entry_at(entry, segment, tier)
}

/// `entry_for_record` 选中的（段, 档），供按 (工具, 模型, 段, 档) 记忆单价的调用方使用。
pub(super) fn record_position(
    entry: &Value,
    tool: &str,
    timestamp: &str,
    prompt_tokens: i64,
) -> (usize, usize) {
    let segment = if has_history(entry) {
        segment_index(entry, record_instant(timestamp))
    } else {
        0
    };
    let tier = if tool_uses_tiers(tool) {
        tier_index(entry, segment, prompt_tokens)
    } else {
        0
    };
    (segment, tier)
}

/// 合并用户覆盖时：覆盖了任一单价、又没自己写 `history` 的型号，去掉内置旧价段。
pub(super) fn strip_overridden_history(table: &mut Value, overrides: &Map<String, Value>) {
    let Some(table) = table.as_object_mut() else {
        return;
    };
    for (model, entry) in overrides {
        let Some(fields) = entry.as_object() else {
            continue;
        };
        let overrides_rate = PRICE_RATE_FIELDS
            .iter()
            .any(|field| fields.contains_key(*field));
        if overrides_rate && !fields.contains_key("history") {
            if let Some(Value::Object(merged)) = table.get_mut(model) {
                merged.remove("history");
            }
        }
    }
}

fn valid_rate(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|rate| rate.is_finite() && (0.0..=MAX_RATE).contains(&rate))
}

/// 校验一个条目的单价、`history` 与 `tiers`。内置表与在线更新的表都要通过。
pub(super) fn validate_entry(model: &str, entry: &Value) -> Result<(), String> {
    let Some(fields) = entry.as_object() else {
        return Err(format!("{model}: 条目不是对象"));
    };
    for field in PRICE_RATE_FIELDS {
        if let Some(value) = fields.get(field) {
            if !valid_rate(value) {
                return Err(format!(
                    "{model}.{field}: 单价必须是 0 到 {MAX_RATE} 的数字"
                ));
            }
        }
    }
    if let Some(history) = fields.get("history") {
        let Some(segments) = history.as_array() else {
            return Err(format!("{model}.history: 必须是数组"));
        };
        let mut previous: Option<DateTime<Utc>> = None;
        for (index, segment) in segments.iter().enumerate() {
            let Some(until) = segment_until(segment) else {
                return Err(format!(
                    "{model}.history[{index}].until: 必须是 RFC 3339 时间"
                ));
            };
            if previous.is_some_and(|previous| until <= previous) {
                return Err(format!("{model}.history: until 必须严格升序"));
            }
            previous = Some(until);
            for field in PRICE_RATE_FIELDS {
                if let Some(value) = segment.get(field) {
                    if !valid_rate(value) {
                        return Err(format!("{model}.history[{index}].{field}: 单价无效"));
                    }
                }
            }
            if let Some(tiers) = segment.get("tiers") {
                validate_tiers(&format!("{model}.history[{index}]"), tiers)?;
            }
        }
    }
    if let Some(tiers) = fields.get("tiers") {
        validate_tiers(model, tiers)?;
    }
    Ok(())
}

fn validate_tiers(path: &str, tiers: &Value) -> Result<(), String> {
    let Some(tiers) = tiers.as_array() else {
        return Err(format!("{path}.tiers: 必须是数组"));
    };
    let mut previous = 0;
    for (index, tier) in tiers.iter().enumerate() {
        let Some(above) = tier_threshold(tier).filter(|above| *above > previous) else {
            return Err(format!(
                "{path}.tiers[{index}].above_prompt_tokens: 必须是严格升序的正整数"
            ));
        };
        previous = above;
        let Some(multipliers) = tier.get("multipliers").and_then(Value::as_object) else {
            return Err(format!("{path}.tiers[{index}].multipliers: 必须是对象"));
        };
        for (field, factor) in multipliers {
            let known = PRICE_RATE_FIELDS.contains(&field.as_str());
            let valid = factor.as_f64().is_some_and(|factor| {
                factor.is_finite() && factor > 0.0 && factor <= MAX_TIER_MULTIPLIER
            });
            if !known || !valid {
                return Err(format!(
                    "{path}.tiers[{index}].multipliers.{field}: 倍率无效"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn terra() -> Value {
        json!({
            "input": 2.0, "output": 12.0, "cache_input": 0.2, "cache_write": 2.5,
            "history": [
                { "until": "2026-07-30T00:00:00Z", "input": 2.5, "output": 15.0, "cache_input": 0.25, "cache_write": 3.125 }
            ],
            "tiers": [
                { "above_prompt_tokens": 272000, "multipliers": { "input": 2.0, "cache_input": 2.0, "cache_write": 2.0, "output": 1.5 } }
            ]
        })
    }

    fn rate(entry: &Value, field: &str) -> f64 {
        entry.get(field).and_then(Value::as_f64).expect(field)
    }

    #[test]
    fn records_before_a_price_change_keep_the_old_price() {
        let entry = terra();
        let before = entry_for_record(&entry, "codex", "2026-07-20 10:00:00", 1_000);
        assert_eq!(rate(&before, "input"), 2.5);
        assert_eq!(rate(&before, "output"), 15.0);
        let after = entry_for_record(&entry, "codex", "2026-08-05 10:00:00", 1_000);
        assert_eq!(rate(&after, "input"), 2.0);
        assert_eq!(rate(&after, "output"), 12.0);
        assert!(after.get("history").is_some(), "现价标准档原样借用");
        assert!(before.get("history").is_none() && before.get("tiers").is_none());
    }

    #[test]
    fn unparseable_timestamps_use_the_current_price() {
        let entry = terra();
        let unknown = entry_for_record(&entry, "codex", "not a time", 1_000);
        assert_eq!(rate(&unknown, "input"), 2.0);
        assert_eq!(
            record_instant("2026-07-20T01:02:03Z").map(|t| t.to_rfc3339()),
            Some("2026-07-20T01:02:03+00:00".to_string())
        );
    }

    #[test]
    fn long_prompts_take_the_tier_multipliers_of_the_segment_in_effect() {
        let entry = terra();
        let long_new = entry_for_record(&entry, "codex", "2026-08-05 10:00:00", 300_000);
        assert_eq!(rate(&long_new, "input"), 4.0);
        assert_eq!(rate(&long_new, "cache_input"), 0.4);
        assert_eq!(rate(&long_new, "output"), 18.0);
        let long_old = entry_for_record(&entry, "codex", "2026-07-20 10:00:00", 300_000);
        assert_eq!(rate(&long_old, "input"), 5.0);
        assert_eq!(rate(&long_old, "output"), 22.5);
        // 阈值本身不算超过。
        let at_threshold = entry_for_record(&entry, "codex", "2026-08-05 10:00:00", 272_000);
        assert_eq!(rate(&at_threshold, "input"), 2.0);
    }

    #[test]
    fn tiers_apply_only_to_per_request_tools() {
        let entry = terra();
        let aggregated = entry_for_record(&entry, "opencode", "2026-08-05 10:00:00", 900_000);
        assert_eq!(rate(&aggregated, "input"), 2.0);
        assert!(tool_uses_tiers("Codex"));
    }

    #[test]
    fn tier_multipliers_leave_missing_cache_rates_to_the_fallback() {
        let entry = json!({
            "input": 2.0, "output": 6.0, "cache_input": 0.2,
            "tiers": [{ "above_prompt_tokens": 200000, "multipliers": { "input": 2.0, "cache_input": 2.0, "cache_write": 2.0, "output": 2.0 } }]
        });
        let long = entry_for_record(&entry, "grok", "2026-08-05 10:00:00", 250_000);
        assert_eq!(rate(&long, "input"), 4.0);
        assert_eq!(rate(&long, "cache_input"), 0.4);
        assert!(
            long.get("cache_write").is_none(),
            "缺省字段继续缺省，按加价后的输入价兜底"
        );
    }

    #[test]
    fn the_highest_tier_below_the_prompt_wins() {
        let entry = json!({
            "input": 1.0, "output": 1.0,
            "tiers": [
                { "above_prompt_tokens": 100, "multipliers": { "input": 2.0 } },
                { "above_prompt_tokens": 1000, "multipliers": { "input": 3.0 } }
            ]
        });
        assert_eq!(tier_index(&entry, 0, 50), 0);
        assert_eq!(tier_index(&entry, 0, 500), 1);
        assert_eq!(tier_index(&entry, 0, 5000), 2);
    }

    #[test]
    fn overriding_a_rate_drops_the_bundled_history() {
        let mut table = json!({ "gpt-5.6-terra": terra(), "other": terra() });
        let overrides = json!({ "gpt-5.6-terra": { "input": 1.0 } });
        strip_overridden_history(&mut table, overrides.as_object().unwrap());
        assert!(table["gpt-5.6-terra"].get("history").is_none());
        assert!(
            table["gpt-5.6-terra"].get("tiers").is_some(),
            "分档倍率保留"
        );
        assert!(table["other"].get("history").is_some());
    }

    #[test]
    fn validation_rejects_malformed_schedules() {
        assert!(validate_entry("ok", &terra()).is_ok());
        for bad in [
            json!({ "input": -1.0 }),
            json!({ "input": "3" }),
            json!({ "input": 1.0, "history": [{ "until": "yesterday" }] }),
            json!({ "input": 1.0, "history": [
                { "until": "2026-07-30T00:00:00Z" }, { "until": "2026-07-01T00:00:00Z" }
            ] }),
            json!({ "input": 1.0, "tiers": [{ "above_prompt_tokens": 0, "multipliers": {} }] }),
            json!({ "input": 1.0, "tiers": [{ "above_prompt_tokens": 10, "multipliers": { "input": 0.0 } }] }),
            json!({ "input": 1.0, "tiers": [{ "above_prompt_tokens": 10, "multipliers": { "speed": 2.0 } }] }),
        ] {
            assert!(validate_entry("bad", &bad).is_err(), "{bad}");
        }
    }

    /// 内置表接入计价链路：逐行估算、Stats v2 的记忆化与用户覆盖同一规则。
    mod pricing_chain {
        use super::super::super::{
            apply_price_overrides, default_prices, estimate_cost, estimate_cost_at,
            price_memo::PriceMemo, price_rate_snapshot, price_values_equal, StatRow,
        };
        use serde_json::{json, Value};

        fn row(tool: &str, model: &str, timestamp: &str, input: i64, cached: i64) -> StatRow {
            StatRow {
                pricing_timestamp: None,
                id: 1,
                tool: tool.to_string(),
                model: model.to_string(),
                input_tokens: input,
                output_tokens: 1_000_000,
                cached_tokens: cached,
                cache_write_tokens: 0,
                cache_write_known: Some(true),
                usage_provenance: None,
                timestamp: timestamp.to_string(),
                session_id: "s".to_string(),
                cost_usd: None,
                machine_id: "m".to_string(),
            }
        }

        fn at(prices: &Value, row: &StatRow) -> f64 {
            estimate_cost_at(
                prices,
                &row.tool,
                &row.model,
                &row.timestamp,
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens(),
                row.cache_write_tokens,
            )
        }

        #[test]
        fn a_query_timezone_shift_keeps_the_price_of_the_original_instant() {
            let prices = default_prices();
            // 2026-07-29 23:00 UTC：调价（07-30 00:00 UTC）之前；换成上海时间是 07-30 07:00。
            let stored = chrono::DateTime::parse_from_rfc3339("2026-07-29T23:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string();
            let original = row("codex", "gpt-5.6-terra", &stored, 100_000, 0);
            let shifted = super::super::super::rows_in_timezone(
                std::slice::from_ref(&original),
                chrono_tz::Asia::Shanghai,
            )
            .unwrap()
            .remove(0);
            assert!(shifted.timestamp.starts_with("2026-07-30 07:00"));
            let mut memo = PriceMemo::new(&prices);
            assert_eq!(memo.row_price(&shifted).cost, at(&prices, &original));
            assert!((at(&prices, &original) - (0.25 + 15.0)).abs() < 1e-9);
        }

        #[test]
        fn a_price_cut_leaves_earlier_records_at_the_old_price() {
            let prices = default_prices();
            let july = row("codex", "gpt-5.6-terra", "2026-07-15 14:30:00", 100_000, 0);
            let august = row("codex", "gpt-5.6-terra", "2026-08-15 14:30:00", 100_000, 0);
            assert!((at(&prices, &july) - (0.25 + 15.0)).abs() < 1e-9);
            assert!((at(&prices, &august) - (0.2 + 12.0)).abs() < 1e-9);
            assert_eq!(
                estimate_cost(&prices, "codex", "gpt-5.6-terra", 100_000, 1_000_000, 0, 0),
                at(&prices, &august),
                "不带时间的估算取现价"
            );
            let mut memo = PriceMemo::new(&prices);
            assert_eq!(memo.row_price(&july).cost, at(&prices, &july));
            assert_eq!(memo.row_price(&august).cost, at(&prices, &august));
        }

        #[test]
        fn long_codex_prompts_are_priced_at_the_long_context_tier() {
            let prices = default_prices();
            // 20 万新鲜输入 + 10 万缓存读 = 30 万，超过 272K。
            let long = row(
                "codex",
                "gpt-5.6-sol",
                "2026-10-01 10:00:00",
                200_000,
                100_000,
            );
            let short = row(
                "codex",
                "gpt-5.6-sol",
                "2026-10-01 10:00:00",
                100_000,
                100_000,
            );
            let base = |row: &StatRow| {
                estimate_cost(
                    &prices,
                    "codex",
                    "gpt-5.6-sol",
                    row.input_tokens,
                    0,
                    row.cached_tokens,
                    0,
                )
            };
            assert!((at(&prices, &short) - (base(&short) + 20.0)).abs() < 1e-9);
            let long_cost = at(&prices, &long);
            assert!(
                (long_cost - (base(&long) * 2.0 + 30.0)).abs() < 1e-9,
                "{long_cost}"
            );
            let mut memo = PriceMemo::new(&prices);
            assert_eq!(memo.row_price(&long).cost, long_cost);
            // 合计行的工具不判档。
            let aggregated = row(
                "opencode",
                "gpt-5.6-sol",
                "2026-10-01 10:00:00",
                200_000,
                100_000,
            );
            let flat = estimate_cost(
                &prices,
                "opencode",
                "gpt-5.6-sol",
                200_000,
                1_000_000,
                100_000,
                0,
            );
            assert_eq!(at(&prices, &aggregated), flat);
        }

        #[test]
        fn a_user_price_applies_to_every_record_of_the_model() {
            let defaults = default_prices();
            let overrides = json!({ "gpt-5.6-terra": { "input": 1.0 } });
            let prices = apply_price_overrides(&defaults, overrides.as_object().unwrap());
            let july = row("codex", "gpt-5.6-terra", "2026-07-15 14:30:00", 100_000, 0);
            assert!((at(&prices, &july) - (0.1 + 12.0)).abs() < 1e-9);
        }

        #[test]
        fn editing_only_a_schedule_counts_as_a_price_change_for_repricing() {
            let before = default_prices();
            let mut after = before.clone();
            after["gpt-6-sol"]["tiers"][0]["multipliers"]["input"] = json!(3);
            assert!(!price_values_equal(
                &price_rate_snapshot(&before),
                &price_rate_snapshot(&after)
            ));
            let mut history = before.clone();
            history["gpt-5.6-terra"]
                .as_object_mut()
                .unwrap()
                .remove("history");
            assert!(!price_values_equal(
                &price_rate_snapshot(&before),
                &price_rate_snapshot(&history)
            ));
        }
    }
}
