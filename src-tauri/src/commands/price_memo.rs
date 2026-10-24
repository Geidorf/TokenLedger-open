//! 单次统计调用内的价格记忆化（T10.167）。
//!
//! 价格表在一次命令调用内不变，而 `lookup_model_prices` 的最长匹配结果只取决于
//! (工具, 模型)。逐行匹配要把价格表每个键都转成小写字符串再比较（合成 5 万行账本
//! 实测每次约 40 µs），总览/专属看板每行还会重复估价多次。这里每个 (工具, 模型)
//! 只匹配一次，把单价解析成 f64，行内只剩乘加。
//!
//! 回退规则（输入 1.0、输出 3.0、缓存读 0.1× 输入、缓存写 1.25× 输入）与浮点
//! 表达式的运算顺序，和 `estimate_cost` / `estimate_cache_savings_parts` 逐位一致；
//! `stats_perf_tests` 的等价性测试对合成账本逐行断言两者相等，任一侧改公式都会
//! 在常规测试里失败。本模块只服务 Stats v2 总览、明细分页与专属看板，不接管行为
//! 分析（其估价由 T10.151 自行缓存）。
//!
//! 缓存节省（T10.162 方案 §3.1，T10.183）：每行求出缓存读取节省、缓存写入溢价与
//! 单价来自兜底的读写量，按行序相加；缓存净节省只在输出时由两项相减得到，可为负。

use super::{lookup_model_price_with_source, price_schedule, prompt_tokens, PriceSource, StatRow};
use serde_json::{json, Value};
use std::collections::HashMap;

/// 一个价格条目解析出的单价（美元 / 百万 Token）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct PriceRates {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    /// 缓存读单价是列价：按型号命中价格表的显式条目（不是自动发现的待核价条目），
    /// 且条目写了 `input` 与 `cache_input`。否则缓存读取节省按兜底单价估算。
    cache_read_listed: bool,
    /// 缓存写单价是列价：同上，条目写了 `input` 与 `cache_write`。
    cache_write_listed: bool,
}

impl PriceRates {
    /// 与 `estimate_cost`、`estimate_cache_savings_parts` 读取价格条目的方式相同；
    /// `source` 是 `lookup_model_price_with_source` 给出的价格来源。
    pub(super) fn from_price(price: &Value, source: PriceSource) -> Self {
        let listed_input = price.get("input").and_then(|v| v.as_f64());
        let input = listed_input.unwrap_or(1.0);
        let output = price.get("output").and_then(|v| v.as_f64()).unwrap_or(3.0);
        let listed_cache_read = price.get("cache_input").and_then(|v| v.as_f64());
        let listed_cache_write = price.get("cache_write").and_then(|v| v.as_f64());
        let listed_entry = source == PriceSource::Listed && listed_input.is_some();
        Self {
            input,
            output,
            cache_read: listed_cache_read.unwrap_or(input * 0.1),
            cache_write: listed_cache_write.unwrap_or(input * 1.25),
            cache_read_listed: listed_entry && listed_cache_read.is_some(),
            cache_write_listed: listed_entry && listed_cache_write.is_some(),
        }
    }

    /// `estimate_cost` 的同一表达式：输入 + 输出 + （缓存读 + 缓存写），从左到右。
    pub(super) fn cost(&self, input: i64, output: i64, cache_read: i64, cache_write: i64) -> f64 {
        let input_cost = (input as f64 / 1_000_000.0) * self.input;
        let cached_cost = (cache_read as f64 / 1_000_000.0) * self.cache_read
            + (cache_write as f64 / 1_000_000.0) * self.cache_write;

        input_cost + (output as f64 / 1_000_000.0) * self.output + cached_cost
    }

    /// 缓存读取节省（毛值，即 `cacheSavedUsd` 的逐行口径）；没有缓存读时为 0。
    pub(super) fn cache_savings(&self, cache_read: i64) -> f64 {
        if cache_read <= 0 {
            return 0.0;
        }
        ((cache_read as f64) / 1_000_000.0) * (self.input - self.cache_read).max(0.0)
    }

    /// 缓存写入溢价：写入量 ×（缓存写价 − 输入价）；没有缓存写时为 0。写价低于输入价
    /// （用户覆盖出的反常单价）时保守取 0。
    pub(super) fn cache_write_premium(&self, cache_write: i64) -> f64 {
        if cache_write <= 0 {
            return 0.0;
        }
        ((cache_write as f64) / 1_000_000.0) * (self.cache_write - self.input).max(0.0)
    }

    /// 一行（或同一 (工具, 模型) 的一组记录）的缓存节省分量，与
    /// `estimate_cache_savings_parts` 逐位一致。
    pub(super) fn cache_parts(&self, cache_read: i64, cache_write: i64) -> CacheSavingsParts {
        CacheSavingsParts {
            read_saved: self.cache_savings(cache_read),
            write_premium: self.cache_write_premium(cache_write),
            fallback_read_tokens: if cache_read > 0 && !self.cache_read_listed {
                cache_read
            } else {
                0
            },
            fallback_write_tokens: if cache_write > 0 && !self.cache_write_listed {
                cache_write
            } else {
                0
            },
        }
    }
}

/// 缓存节省的分量（契约 dashboard-stats-v2 §2.4）。逐行求出后按行序相加，不做中间舍入。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(super) struct CacheSavingsParts {
    /// 缓存读取节省：读取量 × max(输入价 − 缓存读价, 0)，即 `cacheSavedUsd`。
    pub read_saved: f64,
    /// 缓存写入溢价：写入量 × max(缓存写价 − 输入价, 0)。
    pub write_premium: f64,
    /// 单价来自兜底（缺列价、工具兜底键、`default` 或自动发现的待核价条目）的读取量。
    pub fallback_read_tokens: i64,
    /// 单价来自兜底的写入量；缺写价时写价按输入价 × 1.25 估算。
    pub fallback_write_tokens: i64,
}

impl CacheSavingsParts {
    pub(super) fn add(&mut self, other: CacheSavingsParts) {
        self.read_saved += other.read_saved;
        self.write_premium += other.write_premium;
        self.fallback_read_tokens += other.fallback_read_tokens;
        self.fallback_write_tokens += other.fallback_write_tokens;
    }

    /// 缓存净节省 = 缓存读取节省 − 缓存写入溢价，可为负。
    pub(super) fn net_saved(&self) -> f64 {
        self.read_saved - self.write_premium
    }

    /// `summary.cacheSavings`，按本机当前价格表估算（本机统计与桌面对云端的桥接）。
    /// 只能在缓存读写拆分可证明、输出 `cacheReadTokens/cacheWriteTokens` 的同一分支里调用。
    pub(super) fn local_prices_json(&self) -> Value {
        json!({
            "readSavedUsd": self.read_saved,
            "writePremiumUsd": self.write_premium,
            "netSavedUsd": self.net_saved(),
            "fallbackPricedReadTokens": self.fallback_read_tokens,
            "fallbackPricedWriteTokens": self.fallback_write_tokens,
            "priceBasis": "local-prices"
        })
    }
}

/// 一行记录计入汇总的预估费用与缓存节省。
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct RowPrice {
    /// 已存 `cost_usd` 优先，缺失时按价格表估算（未知模型走工具回退价或 `default`，
    /// 不会变成 0）。已存费用为负或非有限（NaN、±∞）时不可得：不回退价格表估算，
    /// 也不算作 0，值为 `NaN`（R-64；见 `stored_cost_or_unavailable`）。
    pub cost: f64,
    /// 缓存节省分量；来源自带费用的行也按价格表估算（方案 §2.3 第 3 条）。
    pub cache: CacheSavingsParts,
}

/// 一个 (工具, 模型) 匹配到的价格条目，以及它各（生效段, 分档）解析出的单价。
struct MemoEntry<'p> {
    entry: &'p Value,
    source: PriceSource,
    /// 条目有旧价段或分档；没有时每行都取现价标准档，不解析记录时间。
    scheduled: bool,
    rates: HashMap<(usize, usize), PriceRates>,
}

impl MemoEntry<'_> {
    fn rates_at(&mut self, position: (usize, usize)) -> PriceRates {
        let (entry, source) = (self.entry, self.source);
        *self.rates.entry(position).or_insert_with(|| {
            PriceRates::from_price(
                &price_schedule::entry_at(entry, position.0, position.1),
                source,
            )
        })
    }
}

/// 按 (工具, 模型) 缓存价格条目与 `PriceRates`；只在一次调用内存活，价格表变化不会串到下一次。
pub(super) struct PriceMemo<'p> {
    prices: &'p Value,
    entries: HashMap<String, HashMap<String, MemoEntry<'p>>>,
}

impl<'p> PriceMemo<'p> {
    pub(super) fn new(prices: &'p Value) -> Self {
        Self {
            prices,
            entries: HashMap::new(),
        }
    }

    fn entry(&mut self, tool: &str, model: &str) -> &mut MemoEntry<'p> {
        let prices = self.prices;
        self.entries
            .entry(tool.to_string())
            .or_default()
            .entry(model.to_string())
            .or_insert_with(|| {
                let (entry, source) = lookup_model_price_with_source(prices, tool, model);
                MemoEntry {
                    entry,
                    source,
                    scheduled: entry.get("history").is_some() || entry.get("tiers").is_some(),
                    rates: HashMap::new(),
                }
            })
    }

    /// 现价标准档（不看记录时间与提示长度）。逐条记录计价请用 `rates_at` / `rates_for_row`。
    /// 非测试代码暂时没有调用方，留给网关请求日志等在途改动，避免合并后编译失败。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn rates(&mut self, tool: &str, model: &str) -> PriceRates {
        self.entry(tool, model).rates_at((0, 0))
    }

    /// 一条记录生效的单价：按记录时间（账本格式或 RFC 3339）选旧价段，逐请求工具再按
    /// 提示长度（新鲜输入 + 缓存读 + 缓存写）选分档，与 `estimate_cost_at` 同一规则
    /// （`price_schedule`）。不是 `StatRow` 的记录（例如网关请求日志）用这个入口。
    pub(super) fn rates_at(
        &mut self,
        tool: &str,
        model: &str,
        timestamp: &str,
        prompt_tokens: i64,
    ) -> PriceRates {
        let entry = self.entry(tool, model);
        if !entry.scheduled {
            return entry.rates_at((0, 0));
        }
        let position = price_schedule::record_position(entry.entry, tool, timestamp, prompt_tokens);
        entry.rates_at(position)
    }

    /// `rates_at` 用于一行账本记录。
    pub(super) fn rates_for_row(&mut self, row: &StatRow) -> PriceRates {
        self.rates_at(
            &row.tool,
            &row.model,
            row.price_timestamp(),
            prompt_tokens(
                row.input_tokens,
                row.cache_read_tokens(),
                row.cache_write_tokens,
            ),
        )
    }

    /// 等价于逐行 `row.cost_usd.unwrap_or_else(|| estimate_cost(..))` 与
    /// `estimate_cache_savings_parts(.., row.cache_read_tokens(), row.cache_write_tokens)`，
    /// 已存费用为负或非有限时除外（R-64，见 `stored_cost_or_unavailable`）。
    /// 已存成本且没有缓存读写的行不需要价格，也就不做匹配。
    pub(super) fn row_price(&mut self, row: &StatRow) -> RowPrice {
        let cache_read = row.cache_read_tokens();
        let cache_write = row.cache_write_tokens;
        match row.cost_usd {
            Some(cost) if cache_read <= 0 && cache_write <= 0 => RowPrice {
                cost: stored_cost_or_unavailable(cost),
                cache: CacheSavingsParts::default(),
            },
            stored => {
                let rates = self.rates_for_row(row);
                RowPrice {
                    cost: match stored {
                        Some(cost) => stored_cost_or_unavailable(cost),
                        None => {
                            rates.cost(row.input_tokens, row.output_tokens, cache_read, cache_write)
                        }
                    },
                    cache: rates.cache_parts(cache_read, cache_write),
                }
            }
        }
    }
}

/// 账本已存费用为负或非有限（NaN、±∞）时统一判定为不可得（R-64，T10.205；
/// T10.196 评审 O-1）：绝不回退到价格表估算——那样会把「账本这一行本来就有
/// 记录」的坏值悄悄换成一个像样的数字，掩盖了损坏的存储值；也绝不按 0 计入，
/// 0 是一个真实、可能出现的费用。返回 `NaN`：调用方按普通 `f64` 相加的合计会被
/// 传染成不可得（`NaN` 经 `serde_json::json!` 序列化为 `null`），总览 KPI、
/// 明细合计（`SummaryAccumulator::add_row`）与 CSV `estimated_cost_usd` 列
/// （`CsvCostEstimator`，经同一个 `is_finite()` 过滤）都经这一处、自动一致。
/// `-0.0` 规整为 `0.0`（比较、格式化与求和都不必再单独处理负零）。
pub(super) fn stored_cost_or_unavailable(cost: f64) -> f64 {
    if !cost.is_finite() || cost < 0.0 {
        f64::NAN
    } else if cost == 0.0 {
        0.0
    } else {
        cost
    }
}

/// R-64：账本已存费用为负或非有限时不可得，经唯一入口 `PriceMemo::row_price`。
#[cfg(test)]
mod row_price_tests {
    use super::*;

    /// `tool-x`/`model-y` 在价格表里查不到型号，也没有工具兜底键，会落到 `default`。
    fn row(cost_usd: Option<f64>, cache: (i64, i64), tokens: (i64, i64)) -> StatRow {
        StatRow {
            pricing_timestamp: None,
            id: 1,
            tool: "tool-x".to_string(),
            model: "model-y".to_string(),
            input_tokens: tokens.0,
            output_tokens: tokens.1,
            cached_tokens: cache.0,
            cache_write_tokens: cache.1,
            cache_write_known: None,
            usage_provenance: None,
            timestamp: "2026-09-24 10:00:00".to_string(),
            session_id: "session".to_string(),
            cost_usd,
            machine_id: "machine".to_string(),
        }
    }

    fn memo_prices() -> Value {
        json!({ "default": { "input": 2.0, "output": 4.0 } })
    }

    #[test]
    fn row_price_negative_stored_cost_is_unavailable() {
        let prices = memo_prices();
        let mut memo = PriceMemo::new(&prices);
        let price = memo.row_price(&row(Some(-0.01), (0, 0), (1_000_000, 0)));
        assert!(
            price.cost.is_nan(),
            "negative stored cost must be unavailable, got {}",
            price.cost
        );
    }

    #[test]
    fn row_price_negative_zero_stored_cost_counts_as_zero() {
        let prices = memo_prices();
        let mut memo = PriceMemo::new(&prices);
        let price = memo.row_price(&row(Some(-0.0), (0, 0), (1_000_000, 0)));
        assert_eq!(
            price.cost.to_bits(),
            0.0_f64.to_bits(),
            "-0.0 must normalize to +0.0, got {}",
            price.cost
        );
    }

    #[test]
    fn row_price_nan_stored_cost_is_unavailable() {
        let prices = memo_prices();
        let mut memo = PriceMemo::new(&prices);
        let price = memo.row_price(&row(Some(f64::NAN), (0, 0), (1_000_000, 0)));
        assert!(price.cost.is_nan());
    }

    #[test]
    fn row_price_infinite_stored_cost_is_unavailable() {
        let prices = memo_prices();
        let mut memo = PriceMemo::new(&prices);
        assert!(memo
            .row_price(&row(Some(f64::INFINITY), (0, 0), (1_000_000, 0)))
            .cost
            .is_nan());
        assert!(memo
            .row_price(&row(Some(f64::NEG_INFINITY), (0, 0), (1_000_000, 0)))
            .cost
            .is_nan());
    }

    #[test]
    fn row_price_positive_stored_cost_is_kept_as_is() {
        let prices = memo_prices();
        let mut memo = PriceMemo::new(&prices);
        let price = memo.row_price(&row(Some(0.5), (0, 0), (1_000_000, 0)));
        assert_eq!(price.cost, 0.5);
    }

    #[test]
    fn row_price_zero_stored_cost_is_kept_as_a_real_zero() {
        let prices = memo_prices();
        let mut memo = PriceMemo::new(&prices);
        let price = memo.row_price(&row(Some(0.0), (0, 0), (1_000_000, 0)));
        assert_eq!(price.cost.to_bits(), 0.0_f64.to_bits());
    }

    #[test]
    fn row_price_missing_stored_cost_is_estimated_from_the_price_table() {
        let prices = memo_prices();
        let mut memo = PriceMemo::new(&prices);
        let price = memo.row_price(&row(None, (0, 0), (1_000_000, 0)));
        // 1,000,000 输入 token × 2 美元/百万 = 2：确实按价格表估了价，不是巧合的 0。
        assert_eq!(price.cost, 2.0);
    }

    /// 有缓存读写活动时走另一个匹配分支；同一条规则也必须在那里生效，否则会
    /// 重现 O-1——两个分支各自判断一次，容易漏掉其中一个。
    #[test]
    fn row_price_negative_stored_cost_is_unavailable_even_with_cache_activity() {
        let prices = memo_prices();
        let mut memo = PriceMemo::new(&prices);
        let price = memo.row_price(&row(Some(-5.0), (1_000, 200), (0, 0)));
        assert!(price.cost.is_nan());
        // 费用不可得不影响缓存节省估算：那是按价格表算的另一个指标。
        assert!(price.cache.read_saved > 0.0);
    }
}
