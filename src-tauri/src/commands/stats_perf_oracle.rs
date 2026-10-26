//! T10.167 等价性测试的“旧实现”基准（oracle），只在测试中编译。
//!
//! 下方分隔线之间是 `945cc718:src-tauri/src/commands/mod.rs` 中被 T10.167 改动或
//! 依赖其改动的函数（同名、同实现，局部定义遮蔽 `super::super::*` 的同名新实现；
//! `SummaryAccumulator`、`LocalStatsSnapshot`、`LocalEntityMetrics` 也是旧定义的本地
//! 副本）。聚合结构保持旧实现，估价参考路径除外：价格表 schema 2 要求逐行按记录
//! 时间与请求长度取价，详见下方说明。其余未改动辅助函数直接复用生产实现，因此这里
//! 仍只比较 T10.167 有意锁定的聚合行为。
//!
//! 用途只有一个：`stats_perf_tests` 在合成账本上把旧、新两条路径的完整 JSON 输出
//! 逐字段比较。若以后有意改变 Stats v2 / 明细 / 专属看板的输出，请同步改这里或
//! 连同对应等价测试一起删除——它们只锁定 T10.167 这次“结果不变”的重构。
//!
//! T10.183 有意改变了输出：凡带 `cacheSavedUsd` 的 summary 多了 `cacheSavings` 对象，
//! 本机响应的 `capabilities` 多了 `cacheSavings: true`。这些新增字段不并入旧聚合结构；
//! `stats_perf_tests::strip_t10_183_additions` 先逐处核对这两处的不变量（读取节省与
//! `cacheSavedUsd` 逐位相同、净值逐位等于读取节省 − 写入溢价等）再把它们去掉，其余
//! 字段（含 `cacheSavedUsd`）仍与本文件的旧输出逐位比较。
//!
//! 价格表 schema 2 之后，逐行成本必须先按记录时间选历史价，并按请求长度选长上下文
//! 分档。本 oracle 的聚合结构仍是旧实现，但估价参考路径有意改用 `estimate_cost_at`
//! 与按记录时间取价的独立缓存节省公式；这不属于 T10.167 的“结果不变”重构。

use super::super::*;
use super::estimate_cache_savings_parts_at;

/// 旧实现的总览统计（Stats v2 快照里的 `stats`）。
pub(super) fn overview(
    app: &AppContext,
    query: LocalStatsQuery,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let query = NormalizedStatsQuery::from_query(query)?;
    Ok(get_local_stats_v2_snapshot_at(app, query, now)?.stats)
}

/// 旧实现的明细分页。
pub(super) fn details(
    app: &AppContext,
    query: UsageDetailsQuery,
    now: DateTime<Local>,
) -> Result<Value, String> {
    get_usage_details_impl_at(app, query, now)
}

/// 旧实现的专属看板。
pub(super) fn entity(
    app: &AppContext,
    query: EntityDashboardQuery,
    now: DateTime<Local>,
) -> Result<Value, String> {
    get_local_entity_dashboard_impl_at(app, query, now)
}

/// `price_memo::stored_cost_or_unavailable` 的独立副本（R-64，T10.205）：本文件
/// 冻结的是 T10.167 之前的输出，本来不该依赖新实现；但 R-64 是有意改变的产品口径
/// （不是 T10.167 那次重构的副作用），所以下面几处“旧实现”的费用公式也要同步改，
/// 否则会在“写大于合计”和负数已存费用这两类合成账本行上，把一次无关的产品口径
/// 变化误判成 T10.167 引入的差异。已存费用为负或非有限时返回 `NaN`（不可得，
/// 不回退价格表估算、不算作 0）；`-0.0` 规整为 `0.0`。
fn stored_cost_or_unavailable(cost: f64) -> f64 {
    if !cost.is_finite() || cost < 0.0 {
        f64::NAN
    } else if cost == 0.0 {
        0.0
    } else {
        cost
    }
}

// ---- 以下逐字复制自 945cc718（勿改；需要改时请整体替换或删除本文件） ----
// R-64 例外：`stored_cost_or_unavailable` 生效的几处逐行费用公式已同步改写，
// 在各自的函数上方注了理由，其余部分仍逐字不动。

fn rows_in_timezone(rows: &[StatRow], timezone: Tz) -> Result<Vec<StatRow>, String> {
    rows.iter()
        .map(|row| {
            let mut row = row.clone();
            let shifted =
                storage_timestamp(timestamp_in_timezone(&row.timestamp, timezone)?.naive_local());
            if row.pricing_timestamp.is_none() {
                row.pricing_timestamp = Some(std::mem::replace(&mut row.timestamp, shifted));
            } else {
                row.timestamp = shifted;
            }
            Ok(row)
        })
        .collect()
}

fn aggregate_rows_for_window(
    rows: &[StatRow],
    range: StatsRange,
    prices: &Value,
    now: NaiveDateTime,
    filter_start: Option<NaiveDateTime>,
    filter_end: NaiveDateTime,
) -> Value {
    let filter_start = filter_start.map(storage_timestamp);
    let filter_end = storage_timestamp(filter_end);
    let mut trends_map = initial_trends_at(range, now);

    let mut summary_input = 0;
    let mut summary_output = 0;
    let mut summary_cached = 0;
    let mut summary_cache_read = 0;
    let mut summary_cache_write = 0;
    let mut summary_cache_saved = 0.0;
    let mut summary_cache_split_proven = true;
    let mut summary_cost = 0.0;
    let mut summary_requests = 0;
    let mut summary_tokens = 0;

    let mut tools_stats: HashMap<String, Value> = HashMap::new();
    let mut tool_cache_split_proven = HashMap::<String, bool>::new();
    let mut model_cache_split_proven = HashMap::<String, bool>::new();
    let mut models_stats: HashMap<String, Value> = HashMap::new();
    let mut heatmap_map: HashMap<String, i64> = HashMap::new();
    let mut history_list = Vec::new();
    let mut active_tools = HashSet::new();
    let mut machines = HashSet::new();
    let mut machine_stats = HashMap::<String, SummaryAccumulator>::new();

    for row in rows {
        let row_total = effective_tokens(row.input_tokens, row.output_tokens);
        // R-64（T10.205）：已存费用为负或非有限时不可得，见文件顶部注记。
        let row_cost = match row.cost_usd {
            Some(cost) => stored_cost_or_unavailable(cost),
            None => estimate_cost_at(
                prices,
                &row.tool,
                &row.model,
                row.price_timestamp(),
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens(),
                row.cache_write_tokens,
            ),
        };
        let clean_date = row
            .timestamp
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();

        let passed_filter = filter_start
            .as_ref()
            .map(|start| row.timestamp >= *start)
            .unwrap_or(true)
            && row.timestamp <= filter_end;

        if !passed_filter {
            continue;
        }
        let row_cache_split_proven = row.cache_split_is_proven();

        active_tools.insert(row.tool.clone());
        if !row.machine_id.is_empty() {
            machines.insert(row.machine_id.clone());
            machine_stats
                .entry(row.machine_id.clone())
                .or_default()
                .add_row(row, prices);
        }

        if clean_date.len() == 10 {
            *heatmap_map.entry(clean_date.clone()).or_insert(0) += row_total;
        }

        tools_stats.entry(row.tool.clone()).or_insert_with(|| {
            json!({
                "name": row.tool,
                "input": 0,
                "output": 0,
                "cached": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "total": 0,
                "cost": 0.0,
                "requests": 0,
                "heatmap": {},
                "models": {}
            })
        });

        if clean_date.len() == 10 {
            let tool_obj = tools_stats.get_mut(&row.tool).unwrap();
            let tool_hm = tool_obj
                .get_mut("heatmap")
                .unwrap()
                .as_object_mut()
                .unwrap();
            let current = tool_hm
                .get(&clean_date)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            tool_hm.insert(clean_date.clone(), json!(current + row_total));
        }

        {
            // Keep the model distribution in the same period as the tool's
            // input/output/total values. Previously this ran before the range
            // filter and silently mixed all-time models into period cards.
            let tool_obj = tools_stats.get_mut(&row.tool).unwrap();
            let tool_models = tool_obj.get_mut("models").unwrap().as_object_mut().unwrap();
            let current = tool_models
                .get(&row.model)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            tool_models.insert(row.model.clone(), json!(current + row_total));
        }

        summary_input += row.input_tokens;
        summary_output += row.output_tokens;
        summary_cached += row.cached_tokens;
        summary_cache_read += row.cache_read_tokens();
        summary_cache_write += row.cache_write_tokens;
        summary_cache_saved += estimate_cache_savings_parts_at(
            prices,
            &row.tool,
            &row.model,
            row.price_timestamp(),
            row.input_tokens,
            row.cache_read_tokens(),
            row.cache_write_tokens,
        )
        .read_saved;
        summary_cache_split_proven &= row_cache_split_proven;
        tool_cache_split_proven
            .entry(row.tool.clone())
            .and_modify(|proven| *proven &= row_cache_split_proven)
            .or_insert(row_cache_split_proven);
        model_cache_split_proven
            .entry(row.model.clone())
            .and_modify(|proven| *proven &= row_cache_split_proven)
            .or_insert(row_cache_split_proven);
        summary_cost += row_cost;
        summary_requests += 1;
        summary_tokens += row_total;

        let tool_obj = tools_stats.get_mut(&row.tool).unwrap();
        let t_input = tool_obj.get("input").unwrap().as_i64().unwrap() + row.input_tokens;
        let t_output = tool_obj.get("output").unwrap().as_i64().unwrap() + row.output_tokens;
        let t_cached = tool_obj.get("cached").unwrap().as_i64().unwrap() + row.cached_tokens;
        let t_cache_read = tool_obj
            .get("cacheRead")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            + row.cache_read_tokens();
        let t_cache_write = tool_obj
            .get("cacheWrite")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            + row.cache_write_tokens;
        let t_total = tool_obj.get("total").unwrap().as_i64().unwrap() + row_total;
        let t_cost = tool_obj.get("cost").unwrap().as_f64().unwrap() + row_cost;
        let t_requests = tool_obj.get("requests").unwrap().as_i64().unwrap() + 1;
        let tool_map = tool_obj.as_object_mut().unwrap();
        tool_map.insert("input".to_string(), json!(t_input));
        tool_map.insert("output".to_string(), json!(t_output));
        tool_map.insert("cached".to_string(), json!(t_cached));
        tool_map.insert("cacheRead".to_string(), json!(t_cache_read));
        tool_map.insert("cacheWrite".to_string(), json!(t_cache_write));
        tool_map.insert("total".to_string(), json!(t_total));
        tool_map.insert("cost".to_string(), json!(t_cost));
        tool_map.insert("requests".to_string(), json!(t_requests));

        models_stats.entry(row.model.clone()).or_insert_with(|| {
            json!({
                "name": row.model,
                "total": 0,
                "requests": 0,
                "input": 0,
                "output": 0,
                "cached": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "cost": 0.0,
                "heatmap": {}
            })
        });
        let model_obj = models_stats
            .get_mut(&row.model)
            .unwrap()
            .as_object_mut()
            .unwrap();
        let model_total = model_obj.get("total").unwrap().as_i64().unwrap() + row_total;
        let model_requests = model_obj.get("requests").unwrap().as_i64().unwrap() + 1;
        let model_input = model_obj.get("input").unwrap().as_i64().unwrap() + row.input_tokens;
        let model_output = model_obj.get("output").unwrap().as_i64().unwrap() + row.output_tokens;
        let model_cached = model_obj.get("cached").unwrap().as_i64().unwrap() + row.cached_tokens;
        let model_cost = model_obj
            .get("cost")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            + row_cost;
        let model_cache_read = model_obj
            .get("cacheRead")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            + row.cache_read_tokens();
        let model_cache_write = model_obj
            .get("cacheWrite")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            + row.cache_write_tokens;
        model_obj.insert("total".to_string(), json!(model_total));
        model_obj.insert("requests".to_string(), json!(model_requests));
        model_obj.insert("input".to_string(), json!(model_input));
        model_obj.insert("output".to_string(), json!(model_output));
        model_obj.insert("cached".to_string(), json!(model_cached));
        model_obj.insert("cacheRead".to_string(), json!(model_cache_read));
        model_obj.insert("cacheWrite".to_string(), json!(model_cache_write));
        model_obj.insert("cost".to_string(), json!(model_cost));

        if clean_date.len() == 10 {
            let model_hm = model_obj
                .get_mut("heatmap")
                .unwrap()
                .as_object_mut()
                .unwrap();
            let current = model_hm
                .get(&clean_date)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            model_hm.insert(clean_date.clone(), json!(current + row_total));
        }

        let key = trend_key(range, &row.timestamp, &clean_date);
        if let Some(trend_val) = trends_map.get_mut(&key) {
            let trend_obj = trend_val.as_object_mut().unwrap();
            let current = trend_obj
                .get(&row.tool)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            trend_obj.insert(row.tool.clone(), json!(current + row_total));
        }

        if history_list.len() < 200 {
            let mut history_item = json!({
                "id": row.id,
                "tool": row.tool,
                "model": row.model,
                "inputTokens": row.input_tokens,
                "outputTokens": row.output_tokens,
                "cachedTokens": row.cached_tokens,
                "cost": row_cost,
                "timestamp": row.timestamp,
                "sessionId": row.session_id,
                "machineId": row.machine_id
            });
            if row_cache_split_proven {
                let item = history_item
                    .as_object_mut()
                    .expect("local history item is an object");
                item.insert(
                    "cacheReadTokens".to_string(),
                    json!(row.cache_read_tokens()),
                );
                item.insert(
                    "cacheWriteTokens".to_string(),
                    json!(row.cache_write_tokens),
                );
            }
            history_list.push(history_item);
        }
    }

    for (tool, value) in &mut tools_stats {
        if !tool_cache_split_proven.get(tool).copied().unwrap_or(true) {
            let object = value
                .as_object_mut()
                .expect("local tool aggregate is an object");
            object.remove("cacheRead");
            object.remove("cacheWrite");
        }
    }
    for (model, value) in &mut models_stats {
        if !model_cache_split_proven.get(model).copied().unwrap_or(true) {
            let object = value
                .as_object_mut()
                .expect("local model aggregate is an object");
            object.remove("cacheRead");
            object.remove("cacheWrite");
        }
    }

    let mut trends_list = Vec::new();
    let mut sorted_keys: Vec<String> = trends_map.keys().cloned().collect();
    sorted_keys.sort();
    for key in sorted_keys {
        let mut trend_val = trends_map.remove(&key).unwrap();
        let trend_obj = trend_val.as_object_mut().unwrap();
        for tool in &active_tools {
            if !trend_obj.contains_key(tool) {
                trend_obj.insert(tool.clone(), json!(0));
            }
        }
        trends_list.push(trend_val);
    }

    let avg_tokens = if summary_requests > 0 {
        (summary_tokens as f64 / summary_requests as f64).round() as i64
    } else {
        0
    };

    let mut machine_list: Vec<String> = machines.into_iter().collect();
    machine_list.sort();

    let mut summary = json!({
        // totalTokens is the effective volume (input + output); cache remains
        // combined unless every cached row proves the read/write split.
        "totalTokens": summary_tokens,
        "inputTokens": summary_input,
        "outputTokens": summary_output,
        "cachedTokens": summary_cached,
        "totalCost": summary_cost,
        "totalRequests": summary_requests,
        "avgTokensPerReq": avg_tokens
    });
    if summary_cache_split_proven {
        let object = summary.as_object_mut().expect("local summary is an object");
        object.insert("cacheReadTokens".to_string(), json!(summary_cache_read));
        object.insert("cacheWriteTokens".to_string(), json!(summary_cache_write));
        object.insert("cacheSavedUsd".to_string(), json!(summary_cache_saved));
    }

    json!({
        "summary": summary,
        "tools": tools_stats,
        "models": models_stats,
        "trends": trends_list,
        "heatmap": heatmap_map,
        "history": history_list,
        "machines": machine_list,
        "machineDistribution": local_machine_distribution(machine_stats)
    })
}

#[derive(Debug, Clone)]
struct SummaryAccumulator {
    input: i64,
    output: i64,
    cached: i64,
    cache_read: i64,
    cache_write: i64,
    cache_saved: f64,
    cost: f64,
    requests: i64,
    cache_split_proven: bool,
}

impl Default for SummaryAccumulator {
    fn default() -> Self {
        Self {
            input: 0,
            output: 0,
            cached: 0,
            cache_read: 0,
            cache_write: 0,
            cache_saved: 0.0,
            cost: 0.0,
            requests: 0,
            cache_split_proven: true,
        }
    }
}

impl SummaryAccumulator {
    fn add_row(&mut self, row: &StatRow, prices: &Value) {
        self.input += row.input_tokens;
        self.output += row.output_tokens;
        self.cached += row.cached_tokens;
        self.cache_read += row.cache_read_tokens();
        self.cache_write += row.cache_write_tokens;
        self.cache_saved += estimate_cache_savings_parts_at(
            prices,
            &row.tool,
            &row.model,
            row.price_timestamp(),
            row.input_tokens,
            row.cache_read_tokens(),
            row.cache_write_tokens,
        )
        .read_saved;
        self.cache_split_proven &= row.cache_split_is_proven();
        // R-64（T10.205）：已存费用为负或非有限时不可得，见文件顶部注记。
        self.cost += match row.cost_usd {
            Some(cost) => stored_cost_or_unavailable(cost),
            None => estimate_cost_at(
                prices,
                &row.tool,
                &row.model,
                row.price_timestamp(),
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens(),
                row.cache_write_tokens,
            ),
        };
        self.requests += 1;
    }

    fn effective_tokens(&self) -> i64 {
        effective_tokens(self.input, self.output)
    }

    fn as_json(&self) -> Value {
        let effective = self.effective_tokens();
        let average = if self.requests > 0 {
            (effective as f64 / self.requests as f64).round() as i64
        } else {
            0
        };
        let mut summary = json!({
            "totalTokens": effective,
            "inputTokens": self.input,
            "outputTokens": self.output,
            "cachedTokens": self.cached,
            "totalCost": self.cost,
            "totalRequests": self.requests,
            "avgTokensPerReq": average
        });
        if self.cache_split_proven {
            let object = summary
                .as_object_mut()
                .expect("summary accumulator JSON is an object");
            object.insert("cacheReadTokens".to_string(), json!(self.cache_read));
            object.insert("cacheWriteTokens".to_string(), json!(self.cache_write));
            object.insert("cacheSavedUsd".to_string(), json!(self.cache_saved));
        }
        summary
    }
}

fn row_in_window(row: &StatRow, start: NaiveDateTime, end: NaiveDateTime) -> bool {
    let start = storage_timestamp(start);
    let end = storage_timestamp(end);
    row.timestamp >= start && row.timestamp <= end
}

fn comparison_period(
    rows: &[StatRow],
    start: NaiveDateTime,
    end: NaiveDateTime,
    bucket: ComparisonBucket,
    slot_count: usize,
    prices: &Value,
) -> (SummaryAccumulator, Vec<Value>) {
    let mut slots = vec![SummaryAccumulator::default(); slot_count];
    let mut summary = SummaryAccumulator::default();

    for row in rows {
        if !row_in_window(row, start, end) {
            continue;
        }
        let Ok(timestamp) = NaiveDateTime::parse_from_str(&row.timestamp, "%Y-%m-%d %H:%M:%S")
        else {
            continue;
        };
        let index = match bucket {
            ComparisonBucket::Hour => (timestamp - start).num_hours(),
            ComparisonBucket::Day => (timestamp.date() - start.date()).num_days(),
        };
        if index < 0 || index as usize >= slots.len() {
            continue;
        }
        summary.add_row(row, prices);
        slots[index as usize].add_row(row, prices);
    }

    let series = slots
        .into_iter()
        .enumerate()
        .map(|(index, slot)| {
            let bucket_label = match bucket {
                ComparisonBucket::Hour => (start + Duration::hours(index as i64))
                    .format("%H:00")
                    .to_string(),
                ComparisonBucket::Day => (start + Duration::days(index as i64))
                    .format("%Y-%m-%d")
                    .to_string(),
            };
            json!({
                "bucket": bucket_label,
                "tokens": slot.effective_tokens(),
                "requests": slot.requests,
                "cost": slot.cost
            })
        })
        .collect();

    (summary, series)
}

fn build_comparison(
    rows: &[StatRow],
    window: &ComparisonWindow,
    query: &NormalizedStatsQuery,
    prices: &Value,
) -> Value {
    // Resolved DateTimes remain the SQL envelope and response boundaries.
    // Bucket aggregation uses the originally requested wall-clock progress so
    // a spring gap resolving to 03:00 does not add a fourth bucket to only one
    // period. A fall fold likewise remains one shared wall-clock hour bucket.
    let current_start = window.current_start.naive_local();
    let current_end = window
        .current_end
        .date_naive()
        .and_time(window.aligned_time);
    let previous_start = window.previous_start.naive_local();
    let previous_end = window
        .previous_end
        .date_naive()
        .and_time(window.aligned_time);
    let slot_count = comparison_slot_count(current_start, current_end, window.bucket);
    let (current, current_series) = comparison_period(
        rows,
        current_start,
        current_end,
        window.bucket,
        slot_count,
        prices,
    );
    let (previous, previous_series) = comparison_period(
        rows,
        previous_start,
        previous_end,
        window.bucket,
        slot_count,
        prices,
    );
    let current_tokens = current.effective_tokens();
    let previous_tokens = previous.effective_tokens();

    json!({
        "window": {
            "kind": window.kind,
            "timezone": query.timezone,
            "bucket": window.bucket.as_str(),
            "currentStart": window.current_start.to_rfc3339(),
            "currentEnd": window.current_end.to_rfc3339(),
            "previousStart": window.previous_start.to_rfc3339(),
            "previousEnd": window.previous_end.to_rfc3339(),
            "alignedThrough": current_end.format("%Y-%m-%d %H:%M").to_string()
        },
        "current": {
            "summary": current.as_json(),
            "series": current_series
        },
        "previous": {
            "summary": previous.as_json(),
            "series": previous_series
        },
        "delta": {
            "tokens": delta_value(current_tokens as f64, previous_tokens as f64, true),
            "requests": delta_value(current.requests as f64, previous.requests as f64, true),
            "cost": delta_value(current.cost, previous.cost, false)
        }
    })
}

fn insert_stats_v2_fields(
    stats: &mut Value,
    rows: &[StatRow],
    bounds: &QueryBounds,
    query: &NormalizedStatsQuery,
    prices: &Value,
    now: DateTime<Tz>,
    entity: Option<&NormalizedEntitySelector>,
) {
    let Some(root) = stats.as_object_mut() else {
        return;
    };
    if let Some(window) = &bounds.comparison {
        root.insert(
            "comparison".to_string(),
            build_comparison(rows, window, query, prices),
        );
    }
    let mut meta = json!({
        "contractVersion": 2,
        "generatedAt": now.to_rfc3339(),
        "lastRefreshedAt": Value::Null,
        "timezone": query.timezone,
        "range": query.range.as_str(),
        "stale": false,
        "query": query.echo_json(),
        "capabilities": {
            "comparison": bounds.comparison.is_some(),
            "detailPagination": true,
            "entityDashboard": true,
            "multiFilterSearch": true,
            "quotaSnapshots": false
        }
    });
    let meta_object = meta.as_object_mut().expect("local stats meta is an object");
    if let Some(machine) = singular_compat_value(&query.machines) {
        meta_object.insert("machine".to_string(), machine);
    }
    if let Some(entity) = entity {
        meta_object.insert("entity".to_string(), entity_json(entity));
    }
    root.insert("meta".to_string(), meta);
}

struct LocalStatsSnapshot {
    stats: Value,
    rows: Vec<StatRow>,
    bounds: QueryBounds,
    query: NormalizedStatsQuery,
    prices: Value,
    zoned_now: DateTime<Tz>,
}

fn get_local_stats_v2_snapshot_at(
    app: &AppContext,
    query: NormalizedStatsQuery,
    now: DateTime<Local>,
) -> Result<LocalStatsSnapshot, String> {
    get_local_stats_v2_snapshot_with_entity_at(app, query, None, now)
}

fn get_local_stats_v2_snapshot_with_entity_at(
    app: &AppContext,
    query: NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
    now: DateTime<Local>,
) -> Result<LocalStatsSnapshot, String> {
    let zoned_now = now.with_timezone(&query.tz);
    let bounds = query_bounds(query.range, zoned_now)?;
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let prices = load_prices(app);
    let storage_rows = read_local_rows_filtered(
        &db_path,
        &query,
        earliest_query_start(&bounds),
        &bounds.current_end,
        entity,
    )?;
    let rows = rows_in_timezone(&storage_rows, query.tz)?;
    let mut stats = aggregate_rows_for_window(
        &rows,
        query.range,
        &prices,
        zoned_now.naive_local(),
        bounds.current_start.as_ref().map(DateTime::naive_local),
        bounds.current_end.naive_local(),
    );
    insert_stats_v2_fields(
        &mut stats, &rows, &bounds, &query, &prices, zoned_now, entity,
    );
    Ok(LocalStatsSnapshot {
        stats,
        rows,
        bounds,
        query,
        prices,
        zoned_now,
    })
}

// R-64（T10.205，修正 T10.196 评审 O-2）：新实现把这个函数从按 (工具, 模型) 分组
// 估价改成了逐行估价（分组里若混有缓存写入大于合计的行，组内先求和再取
// max(读−写, 0) 与逐行各自取 max 后相加不是一回事）。这不是 T10.167 的重构范围，
// 是有意改变的口径，所以旧实现也同步改成逐行，否则本文件会在这条“旧实现”上把
// 一次无关的口径变化误判成 T10.167 引入的差异。
fn query_filtered_summary_with_entity(
    conn: &Connection,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    prices: &Value,
    entity: Option<&NormalizedEntitySelector>,
) -> Result<SummaryAccumulator, String> {
    let mut sql = "SELECT id, tool, model, input_tokens, output_tokens, cached_tokens, \
                   cache_write_tokens, timestamp, session_id, cost_usd, machine_id, cache_write_known, usage_provenance \
                   FROM token_logs WHERE 1 = 1"
        .to_string();
    let mut values = Vec::new();
    append_stats_filters_with_entity(
        &mut sql,
        &mut values,
        bounds.current_start.as_ref(),
        &bounds.current_end,
        query,
        entity,
    );
    sql.push_str(" ORDER BY timestamp DESC, id DESC");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), map_stat_row)
        .map_err(|e| e.to_string())?;
    let mut summary = SummaryAccumulator::default();
    for row in rows {
        let row = row.map_err(|e| e.to_string())?;
        summary.add_row(&row, prices);
    }
    Ok(summary)
}

fn get_usage_details_impl_at(
    app: &AppContext,
    raw: UsageDetailsQuery,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let query = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: raw.range,
        timezone: raw.timezone,
        machines: raw.machines,
        machine: raw.machine,
        tools: raw.tools,
        tool: raw.tool,
        models: raw.models,
        model: raw.model,
        search: raw.search,
        token_mode: raw.token_mode.or_else(|| Some("effective".to_string())),
        start: raw.start,
        end: raw.end,
    })?;
    get_usage_details_normalized_at(
        app,
        query,
        None,
        raw.cursor.as_deref(),
        raw.limit.unwrap_or(50),
        now,
    )
}

fn get_usage_details_normalized_at(
    app: &AppContext,
    query: NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
    raw_cursor: Option<&str>,
    requested_limit: usize,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let limit = requested_limit.clamp(1, 100);
    let cursor = raw_cursor
        .map(ascii_trim)
        .filter(|value| !value.is_empty())
        .map(|value| decode_detail_cursor(value, &query, entity))
        .transpose()?;
    let zoned_now = now.with_timezone(&query.tz);
    let bounds = query_bounds(query.range, zoned_now)?;
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let prices = load_prices(app);

    let mut conn = db::get_connection(&db_path).map_err(|e| e.to_string())?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let summary =
        query_filtered_summary_with_entity(&transaction, &query, &bounds, &prices, entity)?;
    let mut rows = query_detail_items_with_entity(
        &transaction,
        &query,
        &bounds,
        cursor.as_ref(),
        limit,
        entity,
    )?;
    let available_tools =
        query_detail_facet_with_entity(&transaction, &query, &bounds, DetailFacet::Tool, entity)?;
    let available_models =
        query_detail_facet_with_entity(&transaction, &query, &bounds, DetailFacet::Model, entity)?;
    let available_machines = query_detail_facet_with_entity(
        &transaction,
        &query,
        &bounds,
        DetailFacet::Machine,
        entity,
    )?;
    transaction.commit().map_err(|e| e.to_string())?;

    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            rows.last()
                .map(|row| encode_detail_cursor(row, &query, entity))
        })
        .flatten();
    let items: Vec<Value> = rows
        .iter()
        .map(|row| -> Result<Value, String> {
            // R-64（T10.205）：已存费用为负或非有限时不可得，见文件顶部注记。
            let cost = match row.cost_usd {
                Some(cost) => stored_cost_or_unavailable(cost),
                None => estimate_cost_at(
                    &prices,
                    &row.tool,
                    &row.model,
                    row.price_timestamp(),
                    row.input_tokens,
                    row.output_tokens,
                    row.cache_read_tokens(),
                    row.cache_write_tokens,
                ),
            };
            let mut item = json!({
                "id": row.id,
                "tool": row.tool,
                "model": row.model,
                "inputTokens": row.input_tokens,
                "outputTokens": row.output_tokens,
                "cachedTokens": row.cached_tokens,
                "cost": cost,
                "timestamp": timestamp_in_timezone(&row.timestamp, query.tz)?.to_rfc3339(),
                "sessionId": row.session_id,
                "machineId": row.machine_id,
                "granularity": "request"
            });
            if row.cache_split_is_proven() {
                let object = item
                    .as_object_mut()
                    .expect("local detail item is an object");
                object.insert(
                    "cacheReadTokens".to_string(),
                    json!(row.cache_read_tokens()),
                );
                object.insert(
                    "cacheWriteTokens".to_string(),
                    json!(row.cache_write_tokens),
                );
            }
            Ok(item)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut meta = json!({
        "contractVersion": 2,
        "scope": StatsScope::Local.as_str(),
        "generatedAt": zoned_now.to_rfc3339(),
        "timezone": query.timezone,
        "range": query.range.as_str(),
        "query": query.echo_json(),
        "capabilities": {
            "comparison": bounds.comparison.is_some(),
            "detailPagination": true,
            "entityDashboard": true,
            "multiFilterSearch": true,
            "quotaSnapshots": false
        }
    });
    let meta_object = meta
        .as_object_mut()
        .expect("local detail meta is an object");
    if let Some(machine) = singular_compat_value(&query.machines) {
        meta_object.insert("machine".to_string(), machine);
    }
    if let Some(entity) = entity {
        meta_object.insert("entity".to_string(), entity_json(entity));
    }

    Ok(json!({
        "items": items,
        "nextCursor": next_cursor,
        "hasMore": has_more,
        "totalCount": summary.requests,
        "filteredSummary": summary.as_json(),
        "availableFilters": {
            "tools": available_tools,
            "models": available_models,
            "machines": available_machines
        },
        "granularity": "request",
        "meta": meta
    }))
}

struct LocalEntityMetrics {
    composition: Value,
    heatmap: Value,
    peak: Value,
    activity: Value,
}

fn sort_entity_distribution(items: &mut [Value]) {
    items.sort_by(|left, right| {
        let left_tokens = left.get("tokens").and_then(Value::as_i64).unwrap_or(0);
        let right_tokens = right.get("tokens").and_then(Value::as_i64).unwrap_or(0);
        right_tokens.cmp(&left_tokens).then_with(|| {
            left.get("value")
                .and_then(Value::as_str)
                .cmp(&right.get("value").and_then(Value::as_str))
        })
    });
}

fn local_token_distribution(source: HashMap<String, SummaryAccumulator>) -> Vec<Value> {
    let mut items = source
        .into_iter()
        .map(|(value, summary)| {
            let mut item = json!({
                "value": value,
                "tokens": summary.effective_tokens(),
                "inputTokens": summary.input,
                "outputTokens": summary.output,
                "cachedTokens": summary.cached,
                "requests": summary.requests,
                "cost": summary.cost
            });
            if summary.cache_split_proven {
                item.as_object_mut()
                    .expect("local token distribution item is an object")
                    .insert("cacheWriteTokens".to_string(), json!(summary.cache_write));
            }
            item
        })
        .collect::<Vec<_>>();
    sort_entity_distribution(&mut items);
    items
}

fn local_machine_distribution(source: HashMap<String, SummaryAccumulator>) -> Vec<Value> {
    let mut items = source
        .into_iter()
        .map(|(value, summary)| {
            let mut item = json!({
                "value": value,
                "tokens": summary.effective_tokens(),
                "inputTokens": summary.input,
                "outputTokens": summary.output,
                "cachedTokens": summary.cached,
                "requests": summary.requests,
                "cost": summary.cost
            });
            if summary.cache_split_proven {
                item.as_object_mut()
                    .expect("local machine distribution item is an object")
                    .insert("cacheWriteTokens".to_string(), json!(summary.cache_write));
            }
            item
        })
        .collect::<Vec<_>>();
    sort_entity_distribution(&mut items);
    items
}

fn query_local_entity_heatmap(
    app: &AppContext,
    query: &NormalizedStatsQuery,
    entity: &NormalizedEntitySelector,
    now: &DateTime<Tz>,
) -> Result<Value, String> {
    let year_start = resolve_wall_time(
        query.tz,
        midnight(NaiveDate::from_ymd_opt(now.year(), 1, 1).expect("year start is a valid date")),
        BoundarySide::Start,
    )?;
    let db_path = db::get_db_path(app);
    let conn = db::get_connection(&db_path).map_err(|error| error.to_string())?;
    let mut sql = "SELECT timestamp, input_tokens, output_tokens \
                   FROM token_logs WHERE 1 = 1"
        .to_string();
    let mut values = Vec::new();
    append_stats_filters_with_entity(
        &mut sql,
        &mut values,
        Some(&year_start),
        now,
        query,
        Some(entity),
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let mut rows = stmt
        .query(params_from_iter(values.iter()))
        .map_err(|error| error.to_string())?;
    let mut heatmap = Map::new();
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let timestamp: String = row.get(0).map_err(|error| error.to_string())?;
        let input: i64 = row.get(1).map_err(|error| error.to_string())?;
        let output: i64 = row.get(2).map_err(|error| error.to_string())?;
        let date = timestamp_in_timezone(&timestamp, query.tz)?
            .date_naive()
            .to_string();
        let total = heatmap.get(&date).and_then(Value::as_i64).unwrap_or(0)
            + effective_tokens(input, output);
        heatmap.insert(date, json!(total));
    }
    Ok(Value::Object(heatmap))
}

fn build_local_entity_metrics(
    rows: &[StatRow],
    bounds: &QueryBounds,
    query: &NormalizedStatsQuery,
    prices: &Value,
    heatmap: Value,
) -> LocalEntityMetrics {
    let current_start = bounds
        .current_start
        .as_ref()
        .map(|value| storage_timestamp(value.naive_local()));
    let current_end = storage_timestamp(bounds.current_end.naive_local());
    let mut tools = HashMap::<String, SummaryAccumulator>::new();
    let mut models = HashMap::<String, SummaryAccumulator>::new();
    let mut machines = HashMap::<String, SummaryAccumulator>::new();
    let mut peaks = HashMap::<String, SummaryAccumulator>::new();
    let mut active_days = HashSet::new();
    let mut first_seen_at: Option<String> = None;
    let mut last_seen_at: Option<String> = None;

    for row in rows {
        if current_start
            .as_ref()
            .is_some_and(|start| row.timestamp < *start)
            || row.timestamp > current_end
        {
            continue;
        }
        let date = row.timestamp.get(..10).unwrap_or_default().to_string();
        if date.len() != 10 {
            continue;
        }
        tools
            .entry(row.tool.clone())
            .or_default()
            .add_row(row, prices);
        models
            .entry(row.model.clone())
            .or_default()
            .add_row(row, prices);
        if !row.machine_id.trim().is_empty() {
            machines
                .entry(row.machine_id.clone())
                .or_default()
                .add_row(row, prices);
        }
        let bucket = if query.range.uses_hour_buckets() {
            row.timestamp
                .get(11..13)
                .map(|hour| format!("{hour}:00"))
                .unwrap_or_default()
        } else {
            date.clone()
        };
        if !bucket.is_empty() {
            peaks.entry(bucket).or_default().add_row(row, prices);
        }
        active_days.insert(date);
        if first_seen_at
            .as_ref()
            .is_none_or(|first| row.timestamp < *first)
        {
            first_seen_at = Some(row.timestamp.clone());
        }
        if last_seen_at
            .as_ref()
            .is_none_or(|last| row.timestamp > *last)
        {
            last_seen_at = Some(row.timestamp.clone());
        }
    }

    let peak = peaks
        .into_iter()
        .max_by(|(left_bucket, left), (right_bucket, right)| {
            left.effective_tokens()
                .cmp(&right.effective_tokens())
                .then_with(|| right_bucket.cmp(left_bucket))
        })
        .map(|(bucket, summary)| {
            json!({
                "bucket": bucket,
                "tokens": summary.effective_tokens(),
                "requests": summary.requests,
                "cost": summary.cost
            })
        })
        .unwrap_or_else(|| json!({}));

    LocalEntityMetrics {
        composition: json!({
            "tools": local_token_distribution(tools),
            "models": local_token_distribution(models),
            "machines": local_machine_distribution(machines)
        }),
        heatmap,
        peak,
        activity: json!({
            "activeDays": active_days.len(),
            "firstSeenAt": first_seen_at,
            "lastSeenAt": last_seen_at
        }),
    }
}

fn build_local_entity_dashboard(
    stats: Value,
    details: Value,
    request: &NormalizedEntityRequest,
    metrics: LocalEntityMetrics,
) -> Result<Value, String> {
    let summary = stats
        .get("summary")
        .cloned()
        .ok_or_else(|| "local entity stats response is missing summary".to_string())?;
    let comparison = stats.get("comparison").cloned().unwrap_or(Value::Null);
    let mut meta = stats.get("meta").cloned().unwrap_or_else(|| json!({}));
    let meta_object = meta
        .as_object_mut()
        .ok_or_else(|| "local entity stats meta is invalid".to_string())?;
    meta_object.insert("scope".to_string(), json!(StatsScope::Local.as_str()));
    meta_object.insert(
        "capabilities".to_string(),
        json!({
            "comparison": !comparison.is_null(),
            "detailPagination": true,
            "entityDashboard": true,
            "multiFilterSearch": true,
            "quotaSnapshots": false
        }),
    );

    let compatibility_tool = match request.entity.kind {
        EntityKind::Tool => Some(request.entity.id.as_str()),
        EntityKind::Model => request.query.single_tool(),
    };
    let compatibility_model =
        (request.entity.kind == EntityKind::Model).then_some(request.entity.id.as_str());

    Ok(json!({
        "entity": {
            "kind": request.entity.kind.as_str(),
            "id": request.entity.id,
            "tool": compatibility_tool,
            "model": compatibility_model
        },
        "summary": summary,
        "comparison": comparison,
        "composition": metrics.composition,
        "heatmap": metrics.heatmap,
        "peak": metrics.peak,
        "activity": metrics.activity,
        "historyPage": details,
        "granularity": "request",
        "meta": meta
    }))
}

fn get_local_entity_dashboard_impl_at(
    app: &AppContext,
    query: EntityDashboardQuery,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let request = normalize_entity_query(&query)?;
    let snapshot = get_local_stats_v2_snapshot_with_entity_at(
        app,
        request.query.clone(),
        Some(&request.entity),
        now,
    )?;
    let heatmap =
        query_local_entity_heatmap(app, &snapshot.query, &request.entity, &snapshot.zoned_now)?;
    let metrics = build_local_entity_metrics(
        &snapshot.rows,
        &snapshot.bounds,
        &snapshot.query,
        &snapshot.prices,
        heatmap,
    );
    let details = get_usage_details_normalized_at(
        app,
        snapshot.query.clone(),
        Some(&request.entity),
        None,
        20,
        now,
    )?;
    build_local_entity_dashboard(snapshot.stats, details, &request, metrics)
}
