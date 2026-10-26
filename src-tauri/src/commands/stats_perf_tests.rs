//! T10.167：本机统计聚合的合成大账本基准与等价性测试。
//!
//! 只用合成数据：账本写在系统临时目录下一次性的 `AppContext` 里，建库走应用自己的
//! `db::init_db`（含全部迁移与索引），发现模型按扫描器同一规则登记；不读取真实账本、
//! 用户价格覆盖或云端。
//!
//! - 等价性测试（常规 `cargo test` 运行）：`PriceMemo::row_price` 与逐行
//!   `estimate_cost_at` / 按记录时间和长度取价的独立缓存节省公式逐位相等；同一测试
//!   另行覆盖现价标准档 `rates` 与 `estimate_cost` / `estimate_cache_savings` /
//!   `estimate_cache_savings_parts`。总览、明细分页与专属看板的新实现与
//!   `stats_perf_oracle` 在干净、异常两本合成账本上逐字段相等（T10.183 新增的缓存净
//!   节省字段先核对不变量再去掉，见 `strip_t10_183_additions`）。
//! - 基准是 `#[ignore]`，常规 `cargo test` 不会运行，需要显式：
//!
//! ```text
//! cargo test --release --lib stats_perf -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 环境变量（均可选）：`T167_BENCH_ROWS`（默认 `50000,200000`）、`T167_BENCH_RUNS`
//! （默认 5，取中位数）、`T167_BENCH_ONLY`（逗号分隔：
//! `overview,phases,details,entity,behavior`，默认全部）、`T167_BENCH_VERIFY=1`
//! （每个用例计时后再跑一次旧实现并断言输出逐字段相等）、`T167_BENCH_BASELINE=1`
//! （总览、明细与专属看板在同一进程里让旧实现与新实现逐轮交替计时，输出前后对比行，
//! 并断言两边输出逐字段相等；机器负载的漂移因此同等地落在两边）。

use super::*;
use chrono::Timelike;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration as StdDuration, Instant};

#[allow(dead_code)]
#[path = "stats_perf_oracle.rs"]
mod oracle;

static LEDGER_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// 合成账本覆盖的本地日历天数（“全部”比“今年”多出上一年的尾巴）。
const HISTORY_DAYS: f64 = 420.0;

/// 所有区间都相对这个固定时刻计算，保证多次运行、前后对比使用同一窗口。
pub(super) fn fixed_now() -> DateTime<Local> {
    Local
        .with_ymd_and_hms(2026, 9, 24, 15, 30, 0)
        .single()
        .expect("fixed benchmark instant must exist in the host timezone")
}

pub(super) fn host_timezone() -> String {
    iana_time_zone::get_timezone().expect("test host must expose its IANA timezone")
}

/// 可复现的伪随机源（SplitMix64），不引入新依赖。
struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next_u64() % bound.max(1)
    }

    fn percent(&mut self, chance: u64) -> bool {
        self.below(100) < chance
    }

    fn log_uniform(&mut self, low: f64, high: f64) -> i64 {
        (low.ln() + self.unit() * (high.ln() - low.ln()))
            .exp()
            .round() as i64
    }

    fn pick<'a, T>(&mut self, items: &'a [(T, u32)]) -> &'a T {
        let total: u32 = items.iter().map(|(_, weight)| *weight).sum();
        let mut ticket = self.below(u64::from(total)) as u32;
        for (item, weight) in items {
            if ticket < *weight {
                return item;
            }
            ticket -= *weight;
        }
        &items[items.len() - 1].0
    }
}

/// 成本来源：扫描器不写成本（按价格表估算，NULL）或供应商上报成本。
#[derive(Clone, Copy)]
enum CostSource {
    Estimated,
    Vendor,
}

/// 缓存形态：读写双侧可证明、只有合计（写为 0，拆分不可证明）、没有缓存。
#[derive(Clone, Copy)]
enum CacheShape {
    ReadWrite,
    CombinedOnly,
    NoCache,
}

/// 会话标识：真实 ID、扫描器占位 `unknown_session`、空值。
#[derive(Clone, Copy)]
enum SessionShape {
    Real,
    Placeholder,
    Missing,
}

struct ToolProfile {
    tool: &'static str,
    weight: u32,
    models: &'static [(&'static str, u32)],
    cost: CostSource,
    cache: CacheShape,
    session: SessionShape,
}

/// 重度用户的工具/模型组合。成本来源刻意同时覆盖两类：按价格表估算
/// （`CostSource::Estimated`）与来源带金额（`CostSource::Vendor`），后者还会注入
/// 0 与负数等脏数据。模型里故意混入：日期快照后缀、大小写不同、占位名、价格表没有
/// 但可被自动发现的模型、不可发现（含非 ASCII 或尖括号）只能走工具回退价的模型，
/// 以及空模型名。
const TOOL_MIX: &[ToolProfile] = &[
    ToolProfile {
        tool: "claude",
        weight: 340,
        models: &[
            ("claude-opus-4-8", 30),
            ("claude-sonnet-4-6", 35),
            ("claude-haiku-4-5-20251001", 10),
            ("claude-fable-5-1", 8),
            ("claude-sonnet-4-5-20250929", 10),
            ("<synthetic>", 4),
            ("", 3),
        ],
        cost: CostSource::Estimated,
        cache: CacheShape::ReadWrite,
        session: SessionShape::Real,
    },
    ToolProfile {
        tool: "codex",
        weight: 280,
        models: &[
            ("gpt-5.5", 30),
            ("gpt-5.6-sol", 20),
            ("gpt-5.3-codex", 20),
            ("gpt-5.4-mini", 10),
            ("GPT-5.5-2026-01-15", 6),
            ("codex-agent", 4),
            ("gpt-5.7-preview", 10),
        ],
        cost: CostSource::Estimated,
        cache: CacheShape::CombinedOnly,
        session: SessionShape::Real,
    },
    ToolProfile {
        tool: "antigravity",
        weight: 80,
        models: &[
            ("gemini-3.5-flash", 45),
            ("gemini-3.1-pro", 40),
            ("gemini-3.5-flash-agent", 15),
        ],
        cost: CostSource::Estimated,
        cache: CacheShape::CombinedOnly,
        session: SessionShape::Real,
    },
    ToolProfile {
        tool: "opencode",
        weight: 80,
        models: &[
            ("deepseek-v4-flash", 35),
            ("kimi-k2.6", 20),
            ("qwen3.7-max", 20),
            ("claude-3.5-sonnet", 15),
            ("glm-5.1", 10),
        ],
        cost: CostSource::Vendor,
        cache: CacheShape::ReadWrite,
        session: SessionShape::Real,
    },
    ToolProfile {
        tool: "minimax",
        weight: 50,
        models: &[("MiniMax-M3", 70), ("minimax-m2.7", 30)],
        // 合成数据刻意保留 `Vendor`：本文件要同时覆盖「来源带金额」与「按价格表
        // 估算」两条路径，真实扫描器如何落库由各自测试负责，改这里只会平移整条
        // 随机流而让本用例退化成测随机数。
        cost: CostSource::Vendor,
        cache: CacheShape::NoCache,
        session: SessionShape::Placeholder,
    },
    ToolProfile {
        tool: "deepseek",
        weight: 40,
        models: &[("deepseek-chat", 60), ("deepseek-reasoner", 40)],
        cost: CostSource::Estimated,
        cache: CacheShape::CombinedOnly,
        session: SessionShape::Real,
    },
    ToolProfile {
        tool: "kimi",
        weight: 30,
        models: &[("kimi-k2.6", 50), ("kimi-for-coding", 50)],
        cost: CostSource::Estimated,
        cache: CacheShape::CombinedOnly,
        session: SessionShape::Real,
    },
    ToolProfile {
        tool: "pi",
        weight: 30,
        models: &[("claude-sonnet-4-6", 40), ("llama-3.3-70b-local", 60)],
        cost: CostSource::Estimated,
        cache: CacheShape::ReadWrite,
        session: SessionShape::Real,
    },
    ToolProfile {
        tool: "trae",
        weight: 30,
        models: &[("doubao-seed-2.0-code", 60), ("doubao-seed-2.0-pro", 40)],
        cost: CostSource::Estimated,
        cache: CacheShape::NoCache,
        session: SessionShape::Real,
    },
    ToolProfile {
        tool: "marvis",
        weight: 20,
        models: &[("通义千问-Max", 50), ("hunyuan-2.0-thinking", 50)],
        cost: CostSource::Estimated,
        cache: CacheShape::NoCache,
        session: SessionShape::Missing,
    },
    ToolProfile {
        tool: "hermes",
        weight: 20,
        models: &[("hermes-agent", 60), ("mystery-model-x", 40)],
        cost: CostSource::Vendor,
        cache: CacheShape::NoCache,
        session: SessionShape::Real,
    },
];

const MACHINES: &[(&str, u32)] = &[
    ("mac-studio", 45),
    ("win-desktop", 40),
    ("", 10),
    ("laptop", 5),
];

/// 一天中各小时的相对活跃度（夜间少、工作时段多）。
const HOUR_WEIGHTS: &[(u32, u32)] = &[
    (0, 2),
    (1, 1),
    (2, 1),
    (3, 1),
    (4, 1),
    (5, 1),
    (6, 2),
    (7, 3),
    (8, 5),
    (9, 8),
    (10, 9),
    (11, 9),
    (12, 7),
    (13, 8),
    (14, 9),
    (15, 9),
    (16, 8),
    (17, 7),
    (18, 6),
    (19, 6),
    (20, 7),
    (21, 7),
    (22, 5),
    (23, 3),
];

pub(super) struct SyntheticRow {
    pub tool: &'static str,
    pub model: &'static str,
    pub input: i64,
    pub output: i64,
    pub cached: i64,
    pub cache_write: i64,
    pub timestamp: String,
    pub session_id: String,
    pub cost_usd: Option<f64>,
    pub machine_id: &'static str,
}

/// 生成 `count` 行合成记录。`dirty` 额外混入少量异常存储值（负成本、写大于合计的
/// 缓存拆分），只用于等价性测试，基准账本保持“干净”。
pub(super) fn synthetic_rows(
    count: usize,
    seed: u64,
    now: NaiveDateTime,
    dirty: bool,
) -> Vec<SyntheticRow> {
    let mut rng = SplitMix64(seed);
    let tool_weights: Vec<(usize, u32)> = TOOL_MIX
        .iter()
        .enumerate()
        .map(|(index, profile)| (index, profile.weight))
        .collect();
    let seconds_today = u64::from(now.time().num_seconds_from_midnight()).max(1);
    let mut rows = Vec::with_capacity(count);
    for _ in 0..count {
        let profile = &TOOL_MIX[*rng.pick(&tool_weights)];
        let model = *rng.pick(profile.models);
        let machine_id = *rng.pick(MACHINES);

        // 近期更密：约 1.8% 落在今天、6.5% 本周、17% 近 30 天、74% 今年。
        let day_offset = (HISTORY_DAYS * rng.unit().powf(1.5)) as i64;
        let date = now.date() - Duration::days(day_offset);
        let second_of_day = if day_offset == 0 {
            rng.below(seconds_today)
        } else {
            u64::from(*rng.pick(HOUR_WEIGHTS)) * 3600 + rng.below(3600)
        };
        let timestamp = midnight(date) + Duration::seconds(second_of_day as i64);

        let input = rng.log_uniform(40.0, 60_000.0);
        let output = rng.log_uniform(20.0, 16_000.0);
        let (mut cached, mut cache_write) = match profile.cache {
            CacheShape::ReadWrite if rng.percent(90) => {
                let read = rng.log_uniform(500.0, 300_000.0);
                let write = rng.log_uniform(100.0, 30_000.0);
                (read + write, write)
            }
            CacheShape::CombinedOnly if rng.percent(80) => (rng.log_uniform(500.0, 200_000.0), 0),
            _ => (0, 0),
        };
        if dirty && cached > 0 && rng.percent(2) {
            // 写大于合计：拆分不可证明，必须退回 combined 口径。
            cache_write = cached + 10;
        }
        if dirty && cached == 0 && rng.percent(1) {
            // 只有写、没有合计：同样不可证明。
            cache_write = 25;
            cached = 0;
        }

        let cost_usd = match profile.cost {
            CostSource::Estimated => None,
            CostSource::Vendor if rng.percent(3) => Some(0.0),
            CostSource::Vendor if dirty && rng.percent(1) => Some(-0.01),
            CostSource::Vendor => Some(
                (input as f64 * 0.8 + output as f64 * 3.2 + cached as f64 * 0.05) / 1_000_000.0,
            ),
        };
        let session_id = match profile.session {
            SessionShape::Real => format!(
                "{}-{}-{}-{}",
                profile.tool,
                day_offset,
                second_of_day / 10_800,
                rng.below(3)
            ),
            SessionShape::Placeholder => "unknown_session".to_string(),
            SessionShape::Missing => String::new(),
        };

        rows.push(SyntheticRow {
            tool: profile.tool,
            model,
            input,
            output,
            cached,
            cache_write,
            timestamp: storage_timestamp(timestamp),
            session_id,
            cost_usd,
            machine_id,
        });
    }
    rows
}

/// 一次性的合成账本：临时目录 + 应用自身建库/迁移；Drop 时删除。
pub(super) struct SyntheticLedger {
    pub app: AppContext,
    pub root: PathBuf,
    pub rows: usize,
}

impl Drop for SyntheticLedger {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(super) fn build_synthetic_ledger(
    label: &str,
    count: usize,
    seed: u64,
    dirty: bool,
) -> SyntheticLedger {
    let root = std::env::temp_dir().join(format!(
        "tokenledger_t167_{label}_{}_{}",
        std::process::id(),
        LEDGER_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&root);
    let app = AppContext::for_test(root.clone());
    let db_path = db::get_db_path(&app);
    db::init_db(&db_path).expect("initialize synthetic ledger with the app schema");

    let mut rows = synthetic_rows(count, seed, fixed_now().naive_local(), dirty);
    // 扫描器按时间追加写入，真实账本的 id 与时间基本同序；按时间插入，索引回表的
    // 局部性才接近真实账本。
    rows.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    let mut conn = db::get_connection(&db_path).expect("open synthetic ledger");
    // 只影响这个一次性临时库的灌数连接。
    conn.pragma_update(None, "synchronous", "OFF")
        .expect("relax synchronous for the synthetic seed connection");
    let tx = conn.transaction().expect("begin synthetic ledger seed");
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO token_logs
                    (tool, model, input_tokens, output_tokens, cached_tokens,
                     cache_write_tokens, timestamp, session_id, unique_key,
                     cost_usd, machine_id, sync_status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)",
            )
            .expect("prepare synthetic insert");
        for (index, row) in rows.iter().enumerate() {
            insert
                .execute(params![
                    row.tool,
                    row.model,
                    row.input,
                    row.output,
                    row.cached,
                    row.cache_write,
                    row.timestamp,
                    row.session_id,
                    format!("t167-{seed}-{index}"),
                    row.cost_usd,
                    row.machine_id
                ])
                .expect("insert synthetic row");
        }
        // 与扫描器 `record_discovered_models` 同一规则登记发现模型，使价格表与真实
        // 账本一样带上“自动发现 + 工具回退价”的条目。
        let mut discover = tx
            .prepare(
                "INSERT OR IGNORE INTO discovered_models (tool, model_key, model)
                 VALUES (?1, ?2, ?3)",
            )
            .expect("prepare discovered model insert");
        let mut seen = HashSet::new();
        for row in &rows {
            let Some(model_key) = scanner::model_discovery_key(row.model) else {
                continue;
            };
            let tool = row.tool.trim().to_ascii_lowercase();
            if tool.is_empty() || !seen.insert((tool.clone(), model_key.clone())) {
                continue;
            }
            discover
                .execute(params![tool, model_key, row.model.trim()])
                .expect("insert discovered model");
        }
    }
    tx.commit().expect("commit synthetic ledger seed");
    // 灌数后把 WAL 并回主库，读路径与长期运行的真实账本一致。
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .expect("checkpoint synthetic ledger");
    SyntheticLedger {
        app,
        root,
        rows: count,
    }
}

pub(super) const BENCH_RANGES: &[&str] = &["today", "week", "month", "year", "all", "custom"];

#[derive(Clone, Copy, Debug)]
pub(super) enum BenchScope {
    All,
    Tool,
    Machine,
    Search,
}

impl BenchScope {
    fn label(self) -> &'static str {
        match self {
            Self::All => "全部",
            Self::Tool => "tool=codex",
            Self::Machine => "machine=win-desktop",
            Self::Search => "search=sonnet",
        }
    }
}

/// 自定义区间：截至固定“现在”的最近 90 个本地日（同期对比取再往前 90 天）。
fn custom_bounds() -> (String, String) {
    let end = fixed_now().date_naive();
    let start = end - Duration::days(89);
    (
        start.format("%Y-%m-%d").to_string(),
        end.format("%Y-%m-%d").to_string(),
    )
}

pub(super) fn bench_stats_query(range: &str, scope: BenchScope) -> LocalStatsQuery {
    let (start, end) = if range == "custom" {
        let (start, end) = custom_bounds();
        (Some(start), Some(end))
    } else {
        (None, None)
    };
    LocalStatsQuery {
        range: range.to_string(),
        timezone: host_timezone(),
        machines: matches!(scope, BenchScope::Machine).then(|| vec!["win-desktop".to_string()]),
        machine: None,
        tools: matches!(scope, BenchScope::Tool).then(|| vec!["codex".to_string()]),
        tool: None,
        models: None,
        model: None,
        search: matches!(scope, BenchScope::Search).then(|| "sonnet".to_string()),
        token_mode: Some("effective".to_string()),
        start,
        end,
    }
}

pub(super) fn bench_details_query(range: &str, scope: BenchScope) -> UsageDetailsQuery {
    let stats = bench_stats_query(range, scope);
    UsageDetailsQuery {
        scope: Some("local".to_string()),
        range: stats.range,
        timezone: stats.timezone,
        machines: stats.machines,
        machine: None,
        tools: stats.tools,
        tool: None,
        models: None,
        model: None,
        search: stats.search,
        token_mode: stats.token_mode,
        start: stats.start,
        end: stats.end,
        cursor: None,
        limit: Some(50),
        providers: None,
    }
}

pub(super) fn bench_entity_query(range: &str, kind: &str, id: &str) -> EntityDashboardQuery {
    let stats = bench_stats_query(range, BenchScope::All);
    EntityDashboardQuery {
        scope: Some("local".to_string()),
        entity: Some(EntitySelectorInput {
            kind: kind.to_string(),
            id: id.to_string(),
        }),
        range: stats.range,
        timezone: stats.timezone,
        machines: None,
        machine: None,
        tools: None,
        tool: None,
        models: None,
        model: None,
        search: None,
        token_mode: stats.token_mode,
        start: stats.start,
        end: stats.end,
    }
}

fn env_list(name: &str, default: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_else(|_| default.to_string())
        .split(',')
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// 计时 `runs` 次，返回各次耗时与最后一次的输出（供 `T167_BENCH_VERIFY` 比较）。
fn time_runs<T>(runs: usize, mut run: impl FnMut() -> T) -> (Vec<StdDuration>, T) {
    let mut samples = Vec::with_capacity(runs);
    let mut last = None;
    for _ in 0..runs.max(1) {
        let started = Instant::now();
        let output = std::hint::black_box(run());
        samples.push(started.elapsed());
        last = Some(output);
    }
    (samples, last.expect("at least one run"))
}

/// 逐字段比较两份 JSON，返回第一处差异的路径。浮点按位比较（连 0.0 与 -0.0 也区分），
/// 整数与浮点表示不同也算差异。
pub(super) fn first_difference(path: &str, old: &Value, new: &Value) -> Option<String> {
    match (old, new) {
        (Value::Object(old_map), Value::Object(new_map)) => {
            for (key, old_value) in old_map {
                let child = format!("{path}.{key}");
                match new_map.get(key) {
                    Some(new_value) => {
                        if let Some(difference) = first_difference(&child, old_value, new_value) {
                            return Some(difference);
                        }
                    }
                    None => return Some(format!("{child}: only in the old output")),
                }
            }
            new_map
                .keys()
                .find(|key| !old_map.contains_key(*key))
                .map(|key| format!("{path}.{key}: only in the new output"))
        }
        (Value::Array(old_items), Value::Array(new_items)) => {
            if old_items.len() != new_items.len() {
                return Some(format!(
                    "{path}: {} items before, {} after",
                    old_items.len(),
                    new_items.len()
                ));
            }
            old_items
                .iter()
                .zip(new_items)
                .enumerate()
                .find_map(|(index, (old_item, new_item))| {
                    first_difference(&format!("{path}[{index}]"), old_item, new_item)
                })
        }
        (Value::Number(old_number), Value::Number(new_number))
            if old_number.is_f64() && new_number.is_f64() =>
        {
            let old_bits = old_number.as_f64().map(f64::to_bits);
            let new_bits = new_number.as_f64().map(f64::to_bits);
            (old_bits != new_bits).then(|| format!("{path}: {old_number} vs {new_number}"))
        }
        _ => (old != new).then(|| format!("{path}: {old} vs {new}")),
    }
}

pub(super) fn assert_same_output(label: &str, old: &Value, new: &Value) {
    let mut new = strip_t10_183_additions(new).unwrap_or_else(|problem| {
        panic!("{label}: T10.183 cache savings invariant broken at {problem}")
    });
    strip_heatmap_metric_additions("$", &mut new)
        .unwrap_or_else(|problem| panic!("{label}: heatmap metric invariant broken at {problem}"));
    if let Some(difference) = first_difference("$", old, &new) {
        panic!("{label}: optimized output differs from the pre-T10.167 oracle at {difference}");
    }
}

/// 2026-10-23 逐日记录数与费用热力图的有意重设基线：凡带 `heatmap` 的对象多出
/// `heatmapRequests` / `heatmapCost`。先核对两者与 `heatmap` 日期键完全一致、
/// 记录数为正整数、费用为非负有限数，再去掉交给逐字段比较。
fn strip_heatmap_metric_additions(path: &str, value: &mut Value) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            let requests = map.remove("heatmapRequests");
            let cost = map.remove("heatmapCost");
            // 专属看板的 `heatmap` 来自单独的逐日查询，不带这两项，只核对带了的对象。
            let checked = requests.is_some() || cost.is_some();
            if let Some(heatmap) = map
                .get("heatmap")
                .and_then(Value::as_object)
                .filter(|_| checked)
            {
                let keys: std::collections::BTreeSet<&String> = heatmap.keys().collect();
                for (name, extra) in [("heatmapRequests", &requests), ("heatmapCost", &cost)] {
                    let extra = extra
                        .as_ref()
                        .and_then(Value::as_object)
                        .ok_or_else(|| format!("{path}.{name}: missing next to heatmap"))?;
                    if extra.keys().collect::<std::collections::BTreeSet<_>>() != keys {
                        return Err(format!("{path}.{name}: date keys differ from heatmap"));
                    }
                }
                for (date, count) in requests
                    .as_ref()
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                {
                    if count.as_i64().is_none_or(|count| count <= 0) {
                        return Err(format!(
                            "{path}.heatmapRequests.{date}: not a positive count"
                        ));
                    }
                }
                for (date, amount) in cost
                    .as_ref()
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                {
                    if amount
                        .as_f64()
                        .is_none_or(|amount| !amount.is_finite() || amount < 0.0)
                    {
                        return Err(format!(
                            "{path}.heatmapCost.{date}: not a non-negative amount"
                        ));
                    }
                }
            } else if requests.is_some() || cost.is_some() {
                return Err(format!("{path}: heatmap metrics without heatmap"));
            }

            for (key, child) in map.iter_mut() {
                strip_heatmap_metric_additions(&format!("{path}.{key}"), child)?;
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter_mut().enumerate() {
                strip_heatmap_metric_additions(&format!("{path}[{index}]"), child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// T10.183 对 `stats_perf_oracle` 的有意重设基线。
///
/// 旧实现冻结的是 T10.167 之前的输出；T10.183 只在新输出里加了两处：
/// - 凡带 `cacheSavedUsd` 的 summary 多一个 `cacheSavings` 对象（契约 §2.4）；
/// - 本机响应的每个 `capabilities` 对象多一个 `cacheSavings: true`。
///
/// 先逐处核对它们的不变量（对象与 `cacheSavedUsd` 同进同出、`readSavedUsd` 与
/// `cacheSavedUsd` 逐位相同、净值逐位等于读取节省 − 写入溢价、兜底计数不超过对应
/// 读写量、`priceBasis` 为 `local-prices`、能力为 `true`），再把两处去掉交给逐字段
/// 比较；其余字段（含 `cacheSavedUsd` 本身）仍须与旧实现逐位相等。
pub(super) fn strip_t10_183_additions(value: &Value) -> Result<Value, String> {
    let mut stripped = value.clone();
    strip_t10_183_in_place("$", &mut stripped)?;
    Ok(stripped)
}

fn strip_t10_183_in_place(path: &str, value: &mut Value) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            if let Some(capabilities) = map.get_mut("capabilities").and_then(Value::as_object_mut) {
                if capabilities.remove("cacheSavings") != Some(Value::Bool(true)) {
                    return Err(format!(
                        "{path}.capabilities: local responses must declare cacheSavings"
                    ));
                }
            }
            let savings = map.remove("cacheSavings");
            match (map.get("cacheSavedUsd"), savings) {
                (None, None) => {}
                (Some(gross), Some(savings)) => {
                    check_local_cache_savings(path, map, gross, &savings)?
                }
                (Some(_), None) => {
                    return Err(format!("{path}: cacheSavedUsd without cacheSavings"))
                }
                (None, Some(_)) => {
                    return Err(format!("{path}: cacheSavings without cacheSavedUsd"))
                }
            }
            for (key, child) in map.iter_mut() {
                strip_t10_183_in_place(&format!("{path}.{key}"), child)?;
            }
            Ok(())
        }
        Value::Array(items) => items.iter_mut().enumerate().try_for_each(|(index, item)| {
            strip_t10_183_in_place(&format!("{path}[{index}]"), item)
        }),
        _ => Ok(()),
    }
}

fn check_local_cache_savings(
    path: &str,
    summary: &Map<String, Value>,
    gross: &Value,
    savings: &Value,
) -> Result<(), String> {
    let path = format!("{path}.cacheSavings");
    let object = savings
        .as_object()
        .ok_or_else(|| format!("{path}: not an object"))?;
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if keys
        != [
            "fallbackPricedReadTokens",
            "fallbackPricedWriteTokens",
            "netSavedUsd",
            "priceBasis",
            "readSavedUsd",
            "writePremiumUsd",
        ]
    {
        return Err(format!("{path}: unexpected fields {keys:?}"));
    }
    let amount = |name: &str| {
        object[name]
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("{path}.{name}: not a finite number"))
    };
    let read = amount("readSavedUsd")?;
    let premium = amount("writePremiumUsd")?;
    let net = amount("netSavedUsd")?;
    if gross.as_f64().map(f64::to_bits) != Some(read.to_bits()) {
        return Err(format!(
            "{path}.readSavedUsd: {read} is not the gross cacheSavedUsd {gross}"
        ));
    }
    if read < 0.0 || premium < 0.0 {
        return Err(format!("{path}: negative component ({read}, {premium})"));
    }
    if net.to_bits() != (read - premium).to_bits() {
        return Err(format!(
            "{path}.netSavedUsd: {net} is not {read} − {premium}"
        ));
    }
    for (count, split) in [
        ("fallbackPricedReadTokens", "cacheReadTokens"),
        ("fallbackPricedWriteTokens", "cacheWriteTokens"),
    ] {
        let limit = summary
            .get(split)
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("{path}: summary has no {split}"))?;
        let value = object[count]
            .as_i64()
            .ok_or_else(|| format!("{path}.{count}: not an integer"))?;
        if !(0..=limit).contains(&value) {
            return Err(format!("{path}.{count}: {value} outside 0..={limit}"));
        }
    }
    if object["priceBasis"].as_str() != Some("local-prices") {
        return Err(format!("{path}.priceBasis: {}", object["priceBasis"]));
    }
    Ok(())
}

fn ms(value: StdDuration) -> f64 {
    value.as_secs_f64() * 1000.0
}

/// 中位数、最小、最大（毫秒）。
fn summarize(samples: &[StdDuration]) -> (f64, f64, f64) {
    let mut sorted = samples.to_vec();
    sorted.sort();
    let median = if sorted.len() % 2 == 1 {
        ms(sorted[sorted.len() / 2])
    } else {
        (ms(sorted[sorted.len() / 2 - 1]) + ms(sorted[sorted.len() / 2])) / 2.0
    };
    (
        median,
        ms(sorted[0]),
        ms(*sorted.last().expect("at least one sample")),
    )
}

fn report(rows: usize, command: &str, range: &str, scope: &str, samples: &[StdDuration]) {
    let (median, min, max) = summarize(samples);
    eprintln!(
        "| {rows} | {command} | {range} | {scope} | {median:.1} | {min:.1} | {max:.1} | {} |",
        samples.len()
    );
}

fn print_header(paired: bool) {
    if paired {
        eprintln!(
            "| rows | command | range | scope | before median ms | after median ms | speedup | before min–max | after min–max | runs |"
        );
        eprintln!("|---:|---|---|---|---:|---:|---:|---:|---:|---:|");
    } else {
        eprintln!("| rows | command | range | scope | median ms | min ms | max ms | runs |");
        eprintln!("|---:|---|---|---|---:|---:|---:|---:|");
    }
}

/// 旧实现（`oracle`）与新实现逐轮交替计时：偶数轮先跑旧实现、奇数轮先跑新实现，让机器
/// 负载的漂移同等地落在两边。返回两边的耗时与最后一次输出（上一次输出在计时外释放）。
fn time_pair(
    runs: usize,
    old: &mut dyn FnMut() -> Value,
    new: &mut dyn FnMut() -> Value,
) -> (Vec<StdDuration>, Vec<StdDuration>, Value, Value) {
    let mut before = Vec::with_capacity(runs);
    let mut after = Vec::with_capacity(runs);
    let mut old_output = Value::Null;
    let mut new_output = Value::Null;
    for run in 0..runs.max(1) {
        for old_turn in [run % 2 == 0, run % 2 == 1] {
            let started = Instant::now();
            if old_turn {
                let output = std::hint::black_box(old());
                before.push(started.elapsed());
                old_output = output;
            } else {
                let output = std::hint::black_box(new());
                after.push(started.elapsed());
                new_output = output;
            }
        }
    }
    (before, after, old_output, new_output)
}

fn report_pair(
    rows: usize,
    command: &str,
    range: &str,
    scope: &str,
    before: &[StdDuration],
    after: &[StdDuration],
) {
    let (before_median, before_min, before_max) = summarize(before);
    let (after_median, after_min, after_max) = summarize(after);
    eprintln!(
        "| {rows} | {command} | {range} | {scope} | {before_median:.1} | {after_median:.1} | {:.1}× | {before_min:.1}–{before_max:.1} | {after_min:.1}–{after_max:.1} | {} |",
        before_median / after_median.max(0.001),
        after.len()
    );
}

/// 分段计时：按调用顺序记录每一段的耗时。
struct PhaseClock {
    last: Instant,
    laps: Vec<(&'static str, StdDuration)>,
}

impl PhaseClock {
    fn start() -> Self {
        Self {
            last: Instant::now(),
            laps: Vec::new(),
        }
    }

    fn lap(&mut self, name: &'static str) {
        let now = Instant::now();
        self.laps.push((name, now - self.last));
        self.last = now;
    }
}

/// 按 `get_local_stats_v2_snapshot_with_entity_at` 的同一顺序拆段计时，用来给热点排序。
/// 返回快照各段所需的中间结果，供专属看板拆段继续使用。
fn snapshot_phases(
    clock: &mut PhaseClock,
    app: &AppContext,
    query: &NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
    now: DateTime<Local>,
) -> (Value, Vec<StatRow>, QueryBounds, Value, DateTime<Tz>) {
    let zoned_now = now.with_timezone(&query.tz);
    let bounds = query_bounds(query.range, zoned_now).expect("bench bounds");
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).expect("bench init");
    clock.lap("init_db");
    let prices = load_prices(app);
    clock.lap("load_prices");
    let storage_rows = read_local_rows_filtered(
        &db_path,
        query,
        earliest_query_start(&bounds),
        &bounds.current_end,
        entity,
    )
    .expect("bench read rows");
    clock.lap("sql read");
    let rows = rows_in_timezone(&storage_rows, query.tz).expect("bench timezone");
    drop(storage_rows);
    clock.lap("rows_in_timezone");
    let mut stats = aggregate_rows_for_window(
        &rows,
        query.range,
        &prices,
        zoned_now.naive_local(),
        bounds.current_start.as_ref().map(DateTime::naive_local),
        bounds.current_end.naive_local(),
    );
    clock.lap("aggregate_rows_for_window");
    insert_stats_v2_fields(
        &mut stats, &rows, &bounds, query, &prices, zoned_now, entity,
    );
    clock.lap("comparison+meta");
    (stats, rows, bounds, prices, zoned_now)
}

fn overview_phase_laps(
    app: &AppContext,
    raw: LocalStatsQuery,
    now: DateTime<Local>,
) -> Vec<(&'static str, StdDuration)> {
    let mut clock = PhaseClock::start();
    let query = NormalizedStatsQuery::from_query(raw).expect("normalize bench query");
    std::hint::black_box(snapshot_phases(&mut clock, app, &query, None, now));
    clock.laps
}

/// 按 `get_local_entity_dashboard_impl_at` 的同一顺序拆段计时。
fn entity_phase_laps(
    app: &AppContext,
    raw: EntityDashboardQuery,
    now: DateTime<Local>,
) -> Vec<(&'static str, StdDuration)> {
    let mut clock = PhaseClock::start();
    let request = normalize_entity_query(&raw).expect("normalize bench entity");
    let (stats, rows, bounds, prices, zoned_now) =
        snapshot_phases(&mut clock, app, &request.query, Some(&request.entity), now);
    let heatmap = query_local_entity_heatmap(app, &request.query, &request.entity, &zoned_now)
        .expect("bench entity heatmap");
    clock.lap("entity heatmap (year sql + tz)");
    let metrics = build_local_entity_metrics(&rows, &bounds, &request.query, &prices, heatmap);
    clock.lap("entity metrics");
    let details = get_usage_details_normalized_at(
        app,
        request.query.clone(),
        Some(&request.entity),
        None,
        20,
        now,
    )
    .expect("bench entity details");
    clock.lap("details page (5 sql)");
    std::hint::black_box(
        build_local_entity_dashboard(stats, details, &request, metrics)
            .expect("bench entity assemble"),
    );
    clock.lap("assemble");
    clock.laps
}

/// 按 `get_usage_details_normalized_at` 的同一顺序拆段计时（只计 SQL 各段）。
fn details_phase_laps(
    app: &AppContext,
    raw: UsageDetailsQuery,
    now: DateTime<Local>,
) -> Vec<(&'static str, StdDuration)> {
    let mut clock = PhaseClock::start();
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
        token_mode: raw.token_mode,
        start: raw.start,
        end: raw.end,
    })
    .expect("normalize bench details");
    let bounds = query_bounds(query.range, now.with_timezone(&query.tz)).expect("bench bounds");
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).expect("bench init");
    let prices = load_prices(app);
    clock.lap("init_db+load_prices");
    let mut conn = db::get_connection(&db_path).expect("bench connection");
    let transaction = conn.transaction().expect("bench transaction");
    let summary = query_filtered_summary_with_entity(&transaction, &query, &bounds, &prices, None)
        .expect("bench summary");
    clock.lap("filtered summary sql");
    let items = query_detail_items_with_entity(&transaction, &query, &bounds, None, 50, None)
        .expect("bench items");
    clock.lap("page items sql");
    for facet in [DetailFacet::Tool, DetailFacet::Model, DetailFacet::Machine] {
        std::hint::black_box(
            query_detail_facet_with_entity(&transaction, &query, &bounds, facet, None)
                .expect("bench facet"),
        );
    }
    clock.lap("3 facet sql");
    transaction.commit().expect("bench commit");
    std::hint::black_box((summary.requests, items.len()));
    clock.laps
}

/// 多次运行的分段耗时按段名汇总成中位数表。
fn report_laps(
    rows: usize,
    command: &str,
    range: &str,
    runs: usize,
    mut run: impl FnMut() -> Vec<(&'static str, StdDuration)>,
) {
    let mut names: Vec<&'static str> = Vec::new();
    let mut samples: HashMap<&'static str, Vec<StdDuration>> = HashMap::new();
    for _ in 0..runs.max(1) {
        for (name, duration) in run() {
            if !samples.contains_key(name) {
                names.push(name);
            }
            samples.entry(name).or_default().push(duration);
        }
    }
    for name in names {
        report(rows, command, range, name, &samples[name]);
    }
}

#[test]
#[ignore = "opt-in T10.167 synthetic 50k/200k local stats benchmark; run with --release --ignored"]
fn stats_perf_synthetic_ledger_benchmark() {
    let sizes: Vec<usize> = env_list("T167_BENCH_ROWS", "50000,200000")
        .iter()
        .map(|value| value.parse().expect("T167_BENCH_ROWS must be integers"))
        .collect();
    let runs: usize = std::env::var("T167_BENCH_RUNS")
        .ok()
        .map(|value| value.parse().expect("T167_BENCH_RUNS must be an integer"))
        .unwrap_or(5)
        .max(1);
    let only = env_list("T167_BENCH_ONLY", "overview,phases,details,entity,behavior");
    let enabled = |name: &str| only.iter().any(|item| item == name);
    let verify = std::env::var("T167_BENCH_VERIFY").is_ok_and(|value| value == "1");
    let baseline = std::env::var("T167_BENCH_BASELINE").is_ok_and(|value| value == "1");
    let now = fixed_now();
    let scopes = [
        BenchScope::All,
        BenchScope::Tool,
        BenchScope::Machine,
        BenchScope::Search,
    ];

    eprintln!(
        "T10.167 bench: host timezone {}, now {}, runs {runs}, verify {verify}, baseline {baseline}, debug_assertions {}",
        host_timezone(),
        now.to_rfc3339(),
        cfg!(debug_assertions)
    );
    for &size in &sizes {
        let seed_started = Instant::now();
        let ledger = build_synthetic_ledger("bench", size, 0x7167_0000 + size as u64, false);
        eprintln!(
            "rows={} seeded in {:.1} ms at {}",
            ledger.rows,
            ms(seed_started.elapsed()),
            ledger.root.display()
        );
        let app = &ledger.app;
        // 新实现计时；基线模式下与旧实现逐轮交替计时，两种模式都可断言输出逐字段相等。
        let measure = |command: &str,
                       range: &str,
                       scope: &str,
                       old: &mut dyn FnMut() -> Value,
                       new: &mut dyn FnMut() -> Value| {
            let label = format!("{command} {range} {scope}");
            if baseline {
                let (before, after, old_output, new_output) = time_pair(runs, old, new);
                report_pair(size, command, range, scope, &before, &after);
                assert_same_output(&label, &old_output, &new_output);
            } else {
                let (samples, output) = time_runs(runs, new);
                report(size, command, range, scope, &samples);
                if verify {
                    assert_same_output(&label, &old(), &output);
                }
            }
        };

        if enabled("overview") {
            print_header(baseline);
            for range in BENCH_RANGES {
                for scope in scopes {
                    measure(
                        "overview",
                        range,
                        scope.label(),
                        &mut || {
                            oracle::overview(app, bench_stats_query(range, scope), now)
                                .expect("oracle overview")
                        },
                        &mut || {
                            let query =
                                NormalizedStatsQuery::from_query(bench_stats_query(range, scope))
                                    .expect("normalize bench query");
                            get_local_stats_v2_snapshot_at(app, query, now)
                                .expect("overview stats")
                                .stats
                        },
                    );
                }
            }
        }

        if enabled("phases") {
            print_header(false);
            for range in BENCH_RANGES {
                report_laps(size, "overview phase", range, runs, || {
                    overview_phase_laps(app, bench_stats_query(range, BenchScope::All), now)
                });
            }
            for range in BENCH_RANGES {
                report_laps(size, "entity phase tool=claude", range, runs, || {
                    entity_phase_laps(app, bench_entity_query(range, "tool", "claude"), now)
                });
            }
            for range in BENCH_RANGES {
                for scope in [BenchScope::All, BenchScope::Search] {
                    let command = format!("details phase {}", scope.label());
                    report_laps(size, &command, range, runs, || {
                        details_phase_laps(app, bench_details_query(range, scope), now)
                    });
                }
            }
        }

        if enabled("details") {
            print_header(baseline);
            for range in BENCH_RANGES {
                for scope in [BenchScope::All, BenchScope::Tool, BenchScope::Search] {
                    measure(
                        "details p1",
                        range,
                        scope.label(),
                        &mut || {
                            oracle::details(app, bench_details_query(range, scope), now)
                                .expect("oracle details")
                        },
                        &mut || {
                            get_usage_details_impl_at(app, bench_details_query(range, scope), now)
                                .expect("usage details")
                        },
                    );
                }
                let first = get_usage_details_impl_at(
                    app,
                    bench_details_query(range, BenchScope::All),
                    now,
                )
                .expect("usage details first page");
                if let Some(cursor) = first["nextCursor"].as_str() {
                    let page_two = || {
                        let mut query = bench_details_query(range, BenchScope::All);
                        query.cursor = Some(cursor.to_string());
                        query
                    };
                    measure(
                        "details p2",
                        range,
                        BenchScope::All.label(),
                        &mut || oracle::details(app, page_two(), now).expect("oracle page 2"),
                        &mut || {
                            get_usage_details_impl_at(app, page_two(), now)
                                .expect("usage details page 2")
                        },
                    );
                }
            }
        }

        if enabled("entity") {
            print_header(baseline);
            for range in BENCH_RANGES {
                for (kind, id) in [("tool", "claude"), ("model", "claude-sonnet-4-6")] {
                    measure(
                        "entity",
                        range,
                        &format!("{kind}={id}"),
                        &mut || {
                            oracle::entity(app, bench_entity_query(range, kind, id), now)
                                .expect("oracle entity")
                        },
                        &mut || {
                            get_local_entity_dashboard_impl_at(
                                app,
                                bench_entity_query(range, kind, id),
                                now,
                            )
                            .expect("entity dashboard")
                        },
                    );
                }
            }
        }

        if enabled("behavior") {
            print_header(false);
            for range in BENCH_RANGES {
                let (samples, _) = time_runs(runs, || {
                    get_local_behavior_analysis_impl_at(
                        app,
                        bench_stats_query(range, BenchScope::All),
                        now,
                    )
                    .expect("behavior analysis")
                });
                report(size, "behavior", range, BenchScope::All.label(), &samples);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 等价性测试（常规套件）
// ---------------------------------------------------------------------------

/// 与旧实现逐字段比较的账本规模：仍覆盖全部工具、缓存形态与今日到全部各区间。旧实现
/// 逐行匹配价格，在 debug 构建里很慢（1 200 行时三项比较加逐行估价测试共约 43 秒），
/// 常规套件因此只用小账本；5 万 / 20 万行的逐字段相等由基准的 `T167_BENCH_BASELINE=1`
/// 覆盖。
const EQUIVALENCE_ROWS: usize = 600;

/// 口径断言（未知成本不为 0、缓存读写分列、有效 Token = 输入 + 输出）只跑新实现，
/// 代价很小，用更大的账本确保每个被点名的模型都有记录。
const SEMANTICS_ROWS: usize = 1_200;

/// `PriceMemo` 与逐行估价逐位比较的行数（异常形态开启）。
const MEMO_ROWS: usize = 1_500;

fn stat_row(id: i64, row: &SyntheticRow) -> StatRow {
    StatRow {
        pricing_timestamp: None,
        id,
        tool: row.tool.to_string(),
        model: row.model.to_string(),
        input_tokens: row.input,
        output_tokens: row.output,
        cached_tokens: row.cached,
        cache_write_tokens: row.cache_write,
        cache_write_known: None,
        usage_provenance: None,
        timestamp: row.timestamp.clone(),
        session_id: row.session_id.clone(),
        cost_usd: row.cost_usd,
        machine_id: row.machine_id.to_string(),
    }
}

/// 缺字段、非对象条目、缺 `default` 的价格表，用来覆盖每一条回退分支。
fn sparse_price_tables() -> Vec<Value> {
    vec![
        json!({
            "claude-opus-4-8": { "input": 15.0, "output": 75.0 },
            "gpt-5.5": { "input": 1.25, "output": 10.0, "cache_input": 0.125 },
            "gemini-3.1-pro": { "output": 12.0, "cache_write": 4.5 },
            "deepseek": "not-an-object",
            "kimi-k2.6": null,
            "minimax-model": {
                "input": 0.3,
                "output": 1.2,
                "cache_input": 0.03,
                "cache_write": 0.375
            },
            "default": { "input": 0.5, "output": 1.5 }
        }),
        json!({ "gpt-5.5": { "input": 1.25, "output": 10.0 } }),
        json!({}),
        Value::Null,
    ]
}

/// 按记录时间与请求长度选价后的缓存节省参考公式。它独立于 `PriceMemo` /
/// `PriceRates`，并保留列价来源计数与原有的乘法、加法和 `max` 顺序。
#[allow(clippy::too_many_arguments)]
fn estimate_cache_savings_parts_at(
    prices: &Value,
    tool: &str,
    model: &str,
    timestamp: &str,
    input: i64,
    cache_read: i64,
    cache_write: i64,
) -> CacheSavingsParts {
    let (base, source) = lookup_model_price_with_source(prices, tool, model);
    let p = price_schedule::entry_for_record(
        base,
        tool,
        timestamp,
        prompt_tokens(input, cache_read, cache_write),
    );
    let listed_input = p.get("input").and_then(Value::as_f64);
    let p_input = listed_input.unwrap_or(1.0);
    let read_price = p.get("cache_input").and_then(Value::as_f64);
    let write_price = p.get("cache_write").and_then(Value::as_f64);
    let listed_entry = source == PriceSource::Listed && listed_input.is_some();
    let mut parts = CacheSavingsParts::default();
    if cache_read > 0 {
        let effective_read_price = read_price.unwrap_or(p_input * 0.1);
        parts.read_saved =
            ((cache_read as f64) / 1_000_000.0) * (p_input - effective_read_price).max(0.0);
        if !(listed_entry && read_price.is_some()) {
            parts.fallback_read_tokens = cache_read;
        }
    }
    if cache_write > 0 {
        let effective_write_price = write_price.unwrap_or(p_input * 1.25);
        parts.write_premium =
            ((cache_write as f64) / 1_000_000.0) * (effective_write_price - p_input).max(0.0);
        if !(listed_entry && write_price.is_some()) {
            parts.fallback_write_tokens = cache_write;
        }
    }
    parts
}

#[test]
fn price_memo_matches_per_row_estimates_bit_for_bit() {
    let ledger = build_synthetic_ledger("memo_units", 16, 0x7167_0001, false);
    let mut tables = vec![load_prices(&ledger.app), default_prices()];
    tables.extend(sparse_price_tables());
    let rows: Vec<StatRow> =
        synthetic_rows(MEMO_ROWS, 0x7167_0002, fixed_now().naive_local(), true)
            .iter()
            .enumerate()
            .map(|(index, row)| stat_row(index as i64 + 1, row))
            .collect();

    for (table_index, prices) in tables.iter().enumerate() {
        let mut memo = PriceMemo::new(prices);
        for row in &rows {
            // R-64（T10.205）：已存费用为负或非有限时不可得，与 `row_price` 共用
            // 同一判定函数 `price_memo::stored_cost_or_unavailable`，这里不重复实现。
            let expected_cost = match row.cost_usd {
                Some(cost) => price_memo::stored_cost_or_unavailable(cost),
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
            let expected_parts = estimate_cache_savings_parts_at(
                prices,
                &row.tool,
                &row.model,
                row.price_timestamp(),
                row.input_tokens,
                row.cache_read_tokens(),
                row.cache_write_tokens,
            );
            let price = memo.row_price(row);
            assert_eq!(
                price.cost.to_bits(),
                expected_cost.to_bits(),
                "table {table_index}: cost of {}/{} differs ({} vs {expected_cost})",
                row.tool,
                row.model,
                price.cost
            );
            // 读取节省保留原毛值公式，并按同一记录的历史价与分档逐位比较。
            assert_eq!(
                price.cache.read_saved.to_bits(),
                expected_parts.read_saved.to_bits(),
                "table {table_index}: cache savings of {}/{} differ",
                row.tool,
                row.model
            );
            let label = format!("table {table_index}: {}/{}", row.tool, row.model);
            assert_same_parts(&label, price.cache, expected_parts);
            // GLB-01：没有已存成本的行一律按价格表估算（未知模型走工具回退价或
            // `default`，再缺就用内置 1.0/3.0），不能变成 0。
            if row.cost_usd.is_none() {
                assert!(
                    price.cost > 0.0,
                    "table {table_index}: estimated cost of {}/{} collapsed to {}",
                    row.tool,
                    row.model,
                    price.cost
                );
            }

            // 现价标准档仍独立对照旧公式，不能拿历史价 expected_parts 比较 `rates`。
            let standard_saved =
                estimate_cache_savings(prices, &row.tool, &row.model, row.cache_read_tokens());
            let standard_parts = estimate_cache_savings_parts(
                prices,
                &row.tool,
                &row.model,
                row.cache_read_tokens(),
                row.cache_write_tokens,
            );
            let grouped = memo.rates(&row.tool, &row.model).cost(
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens(),
                row.cache_write_tokens,
            );
            let direct = estimate_cost(
                prices,
                &row.tool,
                &row.model,
                row.input_tokens,
                row.output_tokens,
                row.cache_read_tokens(),
                row.cache_write_tokens,
            );
            assert_eq!(grouped.to_bits(), direct.to_bits());
            let grouped_parts = memo
                .rates(&row.tool, &row.model)
                .cache_parts(row.cache_read_tokens(), row.cache_write_tokens);
            assert_eq!(grouped_parts.read_saved.to_bits(), standard_saved.to_bits());
            assert_same_parts(&format!("{label} grouped"), grouped_parts, standard_parts);
        }
    }
}

/// 缓存节省分量逐位相等（`CacheSavingsParts` 的 `==` 会把 0.0 与 -0.0 视为相等）。
#[track_caller]
fn assert_same_parts(label: &str, actual: CacheSavingsParts, expected: CacheSavingsParts) {
    assert_eq!(
        actual.read_saved.to_bits(),
        expected.read_saved.to_bits(),
        "{label}: read savings differ ({} vs {})",
        actual.read_saved,
        expected.read_saved
    );
    assert_eq!(
        actual.write_premium.to_bits(),
        expected.write_premium.to_bits(),
        "{label}: write premium differs ({} vs {})",
        actual.write_premium,
        expected.write_premium
    );
    assert_eq!(
        (actual.fallback_read_tokens, actual.fallback_write_tokens),
        (
            expected.fallback_read_tokens,
            expected.fallback_write_tokens
        ),
        "{label}: fallback counts differ"
    );
}

fn equivalence_ledgers() -> Vec<(&'static str, SyntheticLedger)> {
    vec![
        (
            "clean",
            build_synthetic_ledger("equiv_clean", EQUIVALENCE_ROWS, 0x7167_c1ea, false),
        ),
        (
            "dirty",
            build_synthetic_ledger("equiv_dirty", EQUIVALENCE_ROWS, 0x7167_d127, true),
        ),
    ]
}

#[test]
fn optimized_overview_matches_pre_t10_167_oracle_field_by_field() {
    let now = fixed_now();
    for (label, ledger) in equivalence_ledgers() {
        for range in BENCH_RANGES {
            for scope in [
                BenchScope::All,
                BenchScope::Tool,
                BenchScope::Machine,
                BenchScope::Search,
            ] {
                let old = oracle::overview(&ledger.app, bench_stats_query(range, scope), now)
                    .expect("oracle overview");
                let query = NormalizedStatsQuery::from_query(bench_stats_query(range, scope))
                    .expect("normalize overview query");
                let new = get_local_stats_v2_snapshot_at(&ledger.app, query, now)
                    .expect("optimized overview")
                    .stats;
                assert_same_output(&format!("{label} overview {range} {scope:?}"), &old, &new);
            }
        }
    }
}

#[test]
fn optimized_details_match_pre_t10_167_oracle_field_by_field() {
    let now = fixed_now();
    for (label, ledger) in equivalence_ledgers() {
        for range in BENCH_RANGES {
            for scope in [BenchScope::All, BenchScope::Tool, BenchScope::Search] {
                let mut query = bench_details_query(range, scope);
                // 走完前三页，覆盖游标续页与末页。
                for page in 0..3 {
                    let old =
                        oracle::details(&ledger.app, query.clone(), now).expect("oracle details");
                    let new = get_usage_details_impl_at(&ledger.app, query.clone(), now)
                        .expect("optimized details");
                    assert_same_output(
                        &format!("{label} details {range} {scope:?} page {page}"),
                        &old,
                        &new,
                    );
                    let Some(cursor) = new["nextCursor"].as_str() else {
                        break;
                    };
                    query.cursor = Some(cursor.to_string());
                }
            }
        }
    }
}

#[test]
fn optimized_entity_dashboard_matches_pre_t10_167_oracle_field_by_field() {
    let now = fixed_now();
    for (label, ledger) in equivalence_ledgers() {
        for range in BENCH_RANGES {
            for (kind, id) in [
                ("tool", "claude"),
                ("tool", "marvis"),
                ("model", "claude-sonnet-4-6"),
                ("model", "gpt-5.7-preview"),
            ] {
                let old = oracle::entity(&ledger.app, bench_entity_query(range, kind, id), now)
                    .expect("oracle entity");
                let new = get_local_entity_dashboard_impl_at(
                    &ledger.app,
                    bench_entity_query(range, kind, id),
                    now,
                )
                .expect("optimized entity dashboard");
                assert_same_output(&format!("{label} entity {range} {kind}={id}"), &old, &new);
            }
        }
    }
}

/// 在等价性之外，把本任务必须守住的口径写成显式断言：未知/未定价模型不按 0 计费、
/// 有效 Token 只含输入 + 输出、缓存读写只在可证明时单列。
#[test]
fn optimized_stats_keep_unknown_costs_and_cache_split_semantics() {
    let now = fixed_now();
    let ledger = build_synthetic_ledger("equiv_semantics", SEMANTICS_ROWS, 0x7167_c1ea, false);
    let query = NormalizedStatsQuery::from_query(bench_stats_query("all", BenchScope::All))
        .expect("normalize all-range query");
    let stats = get_local_stats_v2_snapshot_at(&ledger.app, query, now)
        .expect("all-range stats")
        .stats;

    for model in [
        "",
        "<synthetic>",
        "通义千问-Max",
        "llama-3.3-70b-local",
        "deepseek-reasoner",
        "kimi-for-coding",
        "gpt-5.7-preview",
        "claude-sonnet-4-5-20250929",
    ] {
        let entry = &stats["models"][model];
        assert!(
            entry["requests"].as_i64().unwrap_or(0) > 0,
            "synthetic ledger must contain rows for {model:?}"
        );
        assert!(
            entry["cost"].as_f64().is_some_and(|cost| cost > 0.0),
            "unknown/unpriced model {model:?} must be estimated by fallback, not 0: {entry}"
        );
    }

    let summary = &stats["summary"];
    assert_eq!(
        summary["totalTokens"].as_i64(),
        Some(summary["inputTokens"].as_i64().unwrap() + summary["outputTokens"].as_i64().unwrap())
    );
    for (tool, entry) in stats["tools"].as_object().expect("tools object") {
        assert_eq!(
            entry["total"].as_i64(),
            Some(entry["input"].as_i64().unwrap() + entry["output"].as_i64().unwrap()),
            "tool {tool} total must be input + output"
        );
    }
    // Claude 行的读写拆分都可证明：单列读、写，且读 + 写 = 合计。
    let claude = &stats["tools"]["claude"];
    assert_eq!(
        claude["cacheRead"].as_i64().unwrap() + claude["cacheWrite"].as_i64().unwrap(),
        claude["cached"].as_i64().unwrap()
    );
    // Codex 只有合计：不得伪造读写拆分，汇总也因此退回 combined 口径。
    assert!(stats["tools"]["codex"].get("cacheRead").is_none());
    assert!(stats["tools"]["codex"].get("cacheWrite").is_none());
    assert!(summary.get("cacheReadTokens").is_none());
    assert!(summary.get("cacheSavedUsd").is_none());
    // T10.183（用户决定 Q6）：范围里混有无法证明拆分的行，缓存净节省整体不可得，
    // 而不是按可证明的部分算一个偏小的数；本机仍声明能力，缺失即不可得。
    assert!(summary.get("cacheSavings").is_none());
    assert_eq!(stats["meta"]["capabilities"]["cacheSavings"], json!(true));

    let claude_only = NormalizedStatsQuery::from_query(LocalStatsQuery {
        tools: Some(vec!["claude".to_string()]),
        ..bench_stats_query("all", BenchScope::All)
    })
    .expect("normalize claude query");
    let claude_stats = get_local_stats_v2_snapshot_at(&ledger.app, claude_only, now)
        .expect("claude stats")
        .stats;
    let claude_summary = &claude_stats["summary"];
    assert_eq!(
        claude_summary["cacheReadTokens"].as_i64().unwrap()
            + claude_summary["cacheWriteTokens"].as_i64().unwrap(),
        claude_summary["cachedTokens"].as_i64().unwrap()
    );
    assert!(claude_summary["cacheSavedUsd"]
        .as_f64()
        .is_some_and(|saved| saved > 0.0));
    // 缓存净节省 = 读取节省（即 cacheSavedUsd）− 写入溢价；Claude 写价高于输入价，溢价为正。
    let savings = &claude_summary["cacheSavings"];
    let read = savings["readSavedUsd"].as_f64().unwrap();
    let premium = savings["writePremiumUsd"].as_f64().unwrap();
    assert_eq!(
        read.to_bits(),
        claude_summary["cacheSavedUsd"].as_f64().unwrap().to_bits()
    );
    assert!(premium > 0.0, "claude cache writes carry a premium");
    assert_eq!(
        savings["netSavedUsd"].as_f64().unwrap().to_bits(),
        (read - premium).to_bits()
    );
    assert_eq!(savings["priceBasis"], json!("local-prices"));
}

/// T10.183 的重设基线不能是空转的：新增字段的不变量任一处被破坏，比较都要失败；
/// 去掉新增字段后，其余字段原样留给逐字段比较。
#[test]
fn t10_183_rebaseline_checks_the_additions_before_removing_them() {
    let response = json!({
        "summary": {
            "cachedTokens": 30,
            "cacheReadTokens": 20,
            "cacheWriteTokens": 10,
            "cacheSavedUsd": 0.3,
            "cacheSavings": {
                "readSavedUsd": 0.3,
                "writePremiumUsd": 0.1,
                "netSavedUsd": 0.3 - 0.1,
                "fallbackPricedReadTokens": 0,
                "fallbackPricedWriteTokens": 10,
                "priceBasis": "local-prices"
            }
        },
        "meta": { "capabilities": { "comparison": true, "cacheSavings": true } }
    });
    assert_eq!(
        strip_t10_183_additions(&response).expect("valid additions"),
        json!({
            "summary": {
                "cachedTokens": 30,
                "cacheReadTokens": 20,
                "cacheWriteTokens": 10,
                "cacheSavedUsd": 0.3
            },
            "meta": { "capabilities": { "comparison": true } }
        })
    );

    let rejects = |edit: fn(&mut Value)| {
        let mut broken = response.clone();
        edit(&mut broken);
        strip_t10_183_additions(&broken).is_err()
    };
    assert!(rejects(|value| {
        value["summary"]["cacheSavings"]["readSavedUsd"] =
            json!(f64::from_bits(0.3_f64.to_bits() + 1));
    }));
    assert!(rejects(|value| {
        value["summary"]["cacheSavings"]["netSavedUsd"] = json!(0.2);
    }));
    assert!(rejects(|value| {
        value["summary"]["cacheSavings"]["writePremiumUsd"] = json!(-0.1);
    }));
    assert!(rejects(|value| {
        value["summary"]["cacheSavings"]["fallbackPricedWriteTokens"] = json!(11);
    }));
    assert!(rejects(|value| {
        value["summary"]["cacheSavings"]["priceBasis"] = json!("uploaded-prices");
    }));
    assert!(rejects(|value| {
        value["summary"]
            .as_object_mut()
            .unwrap()
            .remove("cacheSavings");
    }));
    assert!(rejects(|value| {
        value["summary"]
            .as_object_mut()
            .unwrap()
            .remove("cacheSavedUsd");
    }));
    assert!(rejects(|value| {
        value["meta"]["capabilities"]
            .as_object_mut()
            .unwrap()
            .remove("cacheSavings");
    }));
}

/// 比较器本身不能是空转的：1 ulp 的浮点差、`0.0` 与 `-0.0`、缺字段、数组顺序、整数与
/// 浮点表示不同，都必须报出差异。
#[test]
fn first_difference_flags_one_ulp_missing_fields_and_representation() {
    let base = json!({ "cost": 0.3, "tools": { "claude": { "cacheRead": 1 } }, "items": [1, 2] });
    assert_eq!(first_difference("$", &base, &base.clone()), None);

    let mut one_ulp = base.clone();
    one_ulp["cost"] = json!(f64::from_bits(0.3_f64.to_bits() + 1));
    assert!(first_difference("$", &base, &one_ulp).is_some_and(|path| path.starts_with("$.cost")));

    let mut positive_zero = base.clone();
    positive_zero["cost"] = json!(0.0);
    let mut negative_zero = base.clone();
    negative_zero["cost"] = json!(-0.0);
    assert!(first_difference("$", &positive_zero, &negative_zero).is_some());

    let mut missing = base.clone();
    missing["tools"]["claude"] = json!({});
    assert!(first_difference("$", &base, &missing).is_some_and(|path| path.contains("cacheRead")));
    assert!(first_difference("$", &missing, &base).is_some_and(|path| path.contains("cacheRead")));

    let mut reordered = base.clone();
    reordered["items"] = json!([2, 1]);
    assert!(first_difference("$", &base, &reordered).is_some());

    let mut float_count = base.clone();
    float_count["tools"]["claude"]["cacheRead"] = json!(1.0);
    assert!(first_difference("$", &base, &float_count).is_some());
}
