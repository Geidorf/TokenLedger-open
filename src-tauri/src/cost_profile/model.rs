//! 订阅设置的存储模型与校验（T10.188，方案 T10.154 `docs/design/cost-naming-subscription-v1.md`
//! §3.1–§3.3；契约 `docs/contracts/cost-profile-local-v1.md`）。
//!
//! 本文件在 `cost_profile/` 目录里，却声明为 `settings` 的子模块（`settings::cost_model`）：
//! `AppSettings` 的四个 `cost_*` 字段要用这里的类型与宽松反序列化，而
//! `tests/quota_parser.rs` 按路径单独编译 `settings.rs`，那个测试 crate 里没有
//! `crate::cost_profile`。四个命令在 `crate::cost_profile`。
//!
//! 读取宽松、写出严格：设置文件里任何一项不合法，只丢这一项并在日志里记条数，绝不让
//! 整份 `app_settings.json` 解析失败（那会让全部设置回落默认值）；未知的服务商、计费
//! 周期与币种按条目非法丢弃，从不改写成默认值。
//!
//! 隐私：订阅名称、订阅费与覆盖范围属于个人消费信息。日志只记条数，`Debug` 输出不含
//! 名称与金额，校验提示只回给设置页；不进 CSV 导出，跨设备同步只经 C1 的专用云端表。

use std::collections::hash_map::RandomState;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Days, NaiveDate};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::AppSettings;

/// 换算汇率默认值：1 美元 = 7.2 元（方案 §2.7；与价格表人民币标价的折算惯例、
/// Android 的默认值一致）。
pub const DEFAULT_CNY_PER_USD: f64 = 7.2;
const MIN_CNY_PER_USD: f64 = 1.0;
const MAX_CNY_PER_USD: f64 = 20.0;
const CNY_PER_USD_DECIMALS: usize = 4;
/// 最多登记的订阅数（方案 §3.2）。
pub const MAX_PLANS: usize = 12;
const MAX_NAME_CHARS: usize = 40;
const MAX_FEE: f64 = 100_000.0;
/// 订阅费的小数位：美元与人民币的最小单位都是分。
const FEE_DECIMALS: usize = 2;
/// 应用其他设备副本时开始日期上界比本机今天多出的天数：同一时刻各地的本地日期最多相差
/// 两天（UTC−12 与 UTC+14），录入设备的「今天」可能比本机晚。
const REMOTE_COPY_START_SLACK_DAYS: u64 = 2;
const MAX_PLAN_TOOLS: usize = 16;
const MAX_PLAN_MODEL_PREFIXES: usize = 16;
const MAX_PLAN_MACHINES: usize = 16;
const MAX_MODEL_PREFIX_CHARS: usize = 64;
/// 工具与设备 ID 的上限，与 Stats v2 筛选项同为 256 个 UTF-8 字节。
const MAX_IDENTIFIER_BYTES: usize = 256;
/// 付费方式条目上限。方案未规定；工具总数远小于它，只为让输入有界。
const MAX_BILLING_MODES: usize = 64;
const PLAN_ID_PREFIX: &str = "sub-";
const PLAN_ID_HEX_DIGITS: usize = 16;
/// revision 要原样经过前端：超过 JavaScript 能精确表示的整数就无法比对。
pub const MAX_REVISION: u64 = (1 << 53) - 1;
/// 设置页提交的订阅对象只认这些字段；拼错的字段名不能被悄悄当成「留空」。
const PLAN_KEYS: [&str; 12] = [
    "id",
    "name",
    "provider",
    "fee",
    "currency",
    "cycle",
    "anchorDay",
    "startDate",
    "endDate",
    "tools",
    "modelPrefixes",
    "machines",
];
const PROFILE_KEYS: [&str; 3] = ["plans", "toolBillingModes", "cnyPerUsd"];
const INTERNAL_ERROR: &str = "订阅设置校验结果不一致，未保存。";

fn earliest_start_date() -> NaiveDate {
    NaiveDate::from_ymd_opt(2020, 1, 1).expect("2020-01-01 is a valid date")
}

/// 服务商（方案 §3.1、§3.7）：只用于图标与覆盖工具建议，不参与计算。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CostProvider {
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "google")]
    Google,
    #[serde(rename = "moonshot")]
    Moonshot,
    #[serde(rename = "zhipu")]
    Zhipu,
    #[serde(rename = "minimax")]
    MiniMax,
    #[serde(rename = "deepseek")]
    DeepSeek,
    #[serde(rename = "other")]
    Other,
}

/// 订阅费币种。首期只支持美元与人民币（方案 §2.7）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CostCurrency {
    #[serde(rename = "USD")]
    Usd,
    #[serde(rename = "CNY")]
    Cny,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostBillingCycle {
    Monthly,
    Yearly,
}

/// 工具的付费方式。只有「按量付费」一种取值；没出现在映射里的工具即「未设置」，
/// 不默认视为按量（方案 §8-2 用户决定）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostBillingMode {
    Payg,
}

/// 一个订阅方案（方案 §3.1）。日期是本地日历日期，起止都含。
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSubscriptionPlan {
    /// 本机生成的稳定 ID：`sub-` 加 16 位小写十六进制，不随名称或顺序变化。
    pub id: String,
    /// 去首尾空白后 1–40 字，不区分大小写不重名。
    pub name: String,
    pub provider: CostProvider,
    /// 每个计费周期的订阅费：大于 0，不超过 100,000，最多两位小数。
    pub fee: f64,
    pub currency: CostCurrency,
    pub cycle: CostBillingCycle,
    /// 月付计费日 1–31，大于当月天数时按月末；年付忽略，按开始日期的月日计费。
    pub anchor_day: u8,
    pub start_date: NaiveDate,
    /// `None` 表示仍在订阅。
    pub end_date: Option<NaiveDate>,
    /// 覆盖的工具 ID（1–16 个，与账本 `tool` 列逐字匹配）。
    pub tools: Vec<String>,
    /// 空表示这些工具的全部模型；按 ASCII 不区分大小写的前缀匹配。
    pub model_prefixes: Vec<String>,
    /// 空表示全部设备；与账本 `machine_id` 逐字匹配。
    pub machines: Vec<String>,
}

impl fmt::Debug for CostSubscriptionPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // 名称、订阅费与覆盖范围属于个人消费信息，任何 `{:?}` 都不得带出（方案 §3.3）。
        formatter
            .debug_struct("CostSubscriptionPlan")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// 订阅设置本身（不含 revision）。
#[derive(Clone, Debug, PartialEq)]
pub struct CostProfile {
    pub plans: Vec<CostSubscriptionPlan>,
    pub tool_billing_modes: BTreeMap<String, CostBillingMode>,
    /// 1 美元 = x 元。`None` 表示设置文件里的汇率无法识别：人民币换算不可得，
    /// 直到用户保存有效汇率，不拿默认值冒充（GLB-01）。
    pub cny_per_usd: Option<f64>,
}

impl CostProfile {
    /// 「删除全部订阅设置」之后的规范空状态：没有订阅、没有付费方式、汇率回到默认。
    /// 从未登记过的安装也是这个状态；C1 把它映射为云端删除墓碑。
    pub fn cleared() -> Self {
        Self {
            plans: Vec::new(),
            tool_billing_modes: BTreeMap::new(),
            cny_per_usd: Some(DEFAULT_CNY_PER_USD),
        }
    }

    pub fn is_cleared(&self) -> bool {
        *self == Self::cleared()
    }

    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            plans: settings.cost_subscription_plans.clone(),
            tool_billing_modes: settings.cost_tool_billing_modes.clone(),
            cny_per_usd: settings.cost_cny_per_usd,
        }
    }
}

/// 订阅设置写入失败发生在哪一步（`settings::update_cost_profile`）。底层错误原文可能引用
/// 设置文件内容（serde 会带出出错的值），调用方只把它映射成固定句子，从不转述原文。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StoreFailure {
    /// 没拿到设置文件锁（超时或锁文件不可用）：什么都没读、没写。
    Lock,
    /// 设置文件读不出或解析不了：什么都没写。
    Read,
    /// 写盘失败：原子替换没有发生，文件保持原样。
    Write,
    /// 读写之后释放锁失败：若本次要写，文件已经写好。
    Release,
}

/// 一次写入的订阅设置与它的 revision，只经 `settings::update_cost_profile` 写回。
pub(crate) struct StoredCostProfile {
    pub profile: CostProfile,
    pub revision: u64,
}

impl StoredCostProfile {
    /// 只替换四个 `cost_*` 字段；其余设置保持调用方从磁盘读到的值。
    pub(crate) fn store_into(self, settings: &mut AppSettings) {
        settings.cost_subscription_plans = self.profile.plans;
        settings.cost_tool_billing_modes = self.profile.tool_billing_modes;
        settings.cost_cny_per_usd = self.profile.cny_per_usd;
        settings.cost_profile_revision = self.revision;
    }
}

/// 字段级错误码（闭合集合，契约 §5）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CostProfileErrorCode {
    Required,
    Invalid,
    TooLong,
    TooMany,
    Duplicate,
    OutOfRange,
    Precision,
    InFuture,
    BeforeStart,
    Overlap,
}

pub(crate) use CostProfileErrorCode as Code;

/// 错误所在字段（闭合集合，契约 §5）。
pub(crate) mod field {
    pub const PROFILE: &str = "profile";
    pub const PLANS: &str = "plans";
    pub const TOOL_BILLING_MODES: &str = "toolBillingModes";
    pub const CNY_PER_USD: &str = "cnyPerUsd";
    pub const PLAN: &str = "plan";
    pub const ID: &str = "id";
    pub const NAME: &str = "name";
    pub const PROVIDER: &str = "provider";
    pub const FEE: &str = "fee";
    pub const CURRENCY: &str = "currency";
    pub const CYCLE: &str = "cycle";
    pub const ANCHOR_DAY: &str = "anchorDay";
    pub const START_DATE: &str = "startDate";
    pub const END_DATE: &str = "endDate";
    pub const TOOLS: &str = "tools";
    pub const MODEL_PREFIXES: &str = "modelPrefixes";
    pub const MACHINES: &str = "machines";
}

/// 设置页可以就近显示的字段级错误。`message` 可能含订阅名称：只回给设置页，
/// 不得写日志，`Debug` 也不输出它。
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostProfileFieldError {
    /// 所属订阅在提交数组里的下标；整份设置的字段为 `None`。
    pub plan_index: Option<usize>,
    pub field: &'static str,
    /// `tools`、`modelPrefixes`、`machines` 中出错那一项的下标。
    pub item_index: Option<usize>,
    /// `toolBillingModes` 中出错的工具，或无法识别的字段名。
    pub key: Option<String>,
    /// 重名、ID 重复或时段重叠时，与之冲突的较早那个订阅的下标。
    pub related_plan_index: Option<usize>,
    pub code: CostProfileErrorCode,
    pub message: String,
}

impl fmt::Debug for CostProfileFieldError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CostProfileFieldError")
            .field("plan_index", &self.plan_index)
            .field("field", &self.field)
            .field("item_index", &self.item_index)
            .field("key", &self.key)
            .field("related_plan_index", &self.related_plan_index)
            .field("code", &self.code)
            .finish_non_exhaustive()
    }
}

impl CostProfileFieldError {
    fn new(plan_index: Option<usize>, field: &'static str, code: Code) -> Self {
        Self {
            plan_index,
            field,
            item_index: None,
            key: None,
            related_plan_index: None,
            code,
            message: default_message(field, code).to_string(),
        }
    }

    fn item(mut self, index: usize) -> Self {
        self.item_index = Some(index);
        self
    }

    fn key(mut self, key: &str) -> Self {
        self.key = Some(key.to_string());
        self
    }

    fn related(mut self, index: usize) -> Self {
        self.related_plan_index = Some(index);
        self
    }

    fn message(mut self, message: impl Into<String>) -> Self {
        self.message = message.into();
        self
    }
}

fn default_message(field: &'static str, code: Code) -> &'static str {
    match (field, code) {
        (field::PROFILE, Code::Required) => "缺少订阅设置",
        (field::PROFILE, _) => "订阅设置格式无效",
        (field::PLANS, Code::TooMany) => "最多登记 12 个订阅",
        (field::PLANS, _) => "订阅列表格式无效",
        (field::PLAN, _) => "订阅格式无效",
        (field::ID, Code::Duplicate) => "订阅 ID 重复",
        (field::ID, _) => "订阅 ID 无效",
        (field::NAME, Code::Required) => "请填写订阅名称",
        (field::NAME, Code::TooLong) => "订阅名称最多 40 个字",
        (field::NAME, Code::Duplicate) => "已有同名订阅",
        (field::NAME, _) => "订阅名称不能包含控制字符、零宽字符或文字方向控制字符",
        (field::PROVIDER, _) => "请选择服务商",
        (field::FEE, Code::Required) => "请填写订阅费",
        (field::FEE, Code::Precision) => "订阅费最多两位小数",
        (field::FEE, _) => "订阅费需大于 0，且不超过 100,000",
        (field::CURRENCY, _) => "请选择币种（美元或人民币）",
        (field::CYCLE, _) => "请选择计费周期（每月或每年）",
        (field::ANCHOR_DAY, _) => "计费日需是 1 到 31 的整数；大于当月天数时按月末扣费",
        (field::START_DATE, Code::Required) => "请填写开始日期",
        (field::START_DATE, Code::OutOfRange) => "开始日期不能早于 2020-01-01",
        (field::START_DATE, Code::InFuture) => "开始日期不能晚于今天",
        (field::START_DATE, _) => "开始日期应为有效日期（YYYY-MM-DD）",
        (field::END_DATE, Code::BeforeStart) => "结束日期不能早于开始日期",
        (field::END_DATE, _) => "结束日期应为有效日期（YYYY-MM-DD），仍在订阅就留空",
        (field::TOOLS, Code::Required) => "至少选择一个工具",
        (field::TOOLS, Code::TooMany) => "最多选择 16 个工具",
        (field::TOOLS, Code::Duplicate) => "工具重复",
        (field::TOOLS, Code::TooLong) => "工具 ID 过长",
        (field::TOOLS, _) => "工具 ID 无效",
        (field::MODEL_PREFIXES, Code::TooMany) => "最多 16 个模型前缀",
        (field::MODEL_PREFIXES, Code::TooLong) => "模型前缀最多 64 个字符",
        (field::MODEL_PREFIXES, Code::Duplicate) => "模型前缀重复（不区分大小写）",
        (field::MODEL_PREFIXES, _) => "模型前缀只能包含英文字母、数字和英文符号，不能有空格",
        (field::MACHINES, Code::TooMany) => "最多选择 16 台设备",
        (field::MACHINES, Code::Duplicate) => "设备重复",
        (field::MACHINES, Code::TooLong) => "设备 ID 过长",
        (field::MACHINES, _) => "设备 ID 无效",
        (field::TOOL_BILLING_MODES, Code::TooMany) => "付费方式最多 64 项",
        (field::TOOL_BILLING_MODES, Code::Required) => "缺少付费方式",
        (field::TOOL_BILLING_MODES, _) => "付费方式格式无效",
        (field::CNY_PER_USD, Code::Precision) => "汇率最多 4 位小数",
        (field::CNY_PER_USD, _) => "汇率需在 1 到 20 之间",
        _ => "订阅设置格式无效",
    }
}

// ---------------------------------------------------------------------------
// 单项校验：设置页提交与设置文件读取共用同一套规则。
// ---------------------------------------------------------------------------

fn required_or_invalid(value: Option<&Value>) -> Code {
    if matches!(value, None | Some(Value::Null)) {
        Code::Required
    } else {
        Code::Invalid
    }
}

pub(crate) fn valid_plan_id(value: &str) -> bool {
    value.strip_prefix(PLAN_ID_PREFIX).is_some_and(|hex| {
        hex.len() == PLAN_ID_HEX_DIGITS
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// 名称里不允许的字符：控制字符（Cc）、零宽与不可见的格式字符、文字方向控制字符与
/// 行/段分隔符。它们能让两个看上去一样的名称同时存在，或打乱混排显示。
fn forbidden_name_char(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            // 软连字符、阿拉伯字母标记、蒙古文元音分隔符
            '\u{00ad}' | '\u{061c}' | '\u{180e}'
                // 零宽空格、零宽不连字、零宽连字、从左到右与从右到左标记
                | '\u{200b}'..='\u{200f}'
                // 行分隔符、段分隔符与双向嵌入、覆盖
                | '\u{2028}'..='\u{202e}'
                // 词连接符与不可见运算符
                | '\u{2060}'..='\u{2064}'
                // 双向隔离与已弃用的格式控制
                | '\u{2066}'..='\u{206f}'
                // 零宽不换行空格（BOM）
                | '\u{feff}'
        )
}

/// 返回去首尾空白后的名称：先去首尾空白，再对剩下的全部字符判断。
fn check_name(raw: &str) -> Result<String, Code> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(Code::Required);
    }
    if name.chars().any(forbidden_name_char) {
        return Err(Code::Invalid);
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(Code::TooLong);
    }
    Ok(name.to_string())
}

/// 同名判断不区分大小写。
fn fold_name(name: &str) -> String {
    name.to_lowercase()
}

/// 小数位数：按最短往返的十进制写法（`f64` 的 `Display`，不用科学计数法）数，不设容差。
/// 用户输入的 `19.99` 解析后仍写作 `19.99`；`19.999999999` 写作九位小数，直接判为多余。
/// 调用前已确认是有限数且在取值范围内。
fn decimal_places(value: f64) -> usize {
    let text = value.abs().to_string();
    text.split_once('.')
        .map_or(0, |(_, fraction)| fraction.len())
}

fn check_fee(value: f64) -> Result<f64, Code> {
    if !value.is_finite() {
        Err(Code::Invalid)
    } else if value <= 0.0 || value > MAX_FEE {
        Err(Code::OutOfRange)
    } else if decimal_places(value) > FEE_DECIMALS {
        Err(Code::Precision)
    } else {
        Ok(value)
    }
}

fn check_cny_per_usd(value: f64) -> Result<f64, Code> {
    if !value.is_finite() {
        Err(Code::Invalid)
    } else if !(MIN_CNY_PER_USD..=MAX_CNY_PER_USD).contains(&value) {
        Err(Code::OutOfRange)
    } else if decimal_places(value) > CNY_PER_USD_DECIMALS {
        Err(Code::Precision)
    } else {
        Ok(value)
    }
}

/// 只接受 `YYYY-MM-DD` 这一种写法的真实日期（不接受 `2026-9-5`、带符号的年份等）。
fn parse_date(text: &str) -> Option<NaiveDate> {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
    if !shaped {
        return None;
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()
}

/// 工具与设备 ID：非空、无首尾空白与控制字符、不超过 256 字节；不对照账本，
/// 已登记但本机暂未出现的工具与其他设备同步来的设置都保持有效。
fn check_identifier(value: &str) -> Result<(), Code> {
    if value.is_empty() || value.trim() != value || value.chars().any(char::is_control) {
        Err(Code::Invalid)
    } else if value.len() > MAX_IDENTIFIER_BYTES {
        Err(Code::TooLong)
    } else {
        Ok(())
    }
}

fn check_tool(value: &str) -> Result<(), Code> {
    check_identifier(value)
}

fn check_machine(value: &str) -> Result<(), Code> {
    check_identifier(value)?;
    // `all` 与 `all_cloud` 是看板筛选里「全部设备」的哨兵值，不是设备 ID。
    if matches!(value, "all" | "all_cloud") {
        return Err(Code::Invalid);
    }
    Ok(())
}

/// 模型前缀：1–64 个 ASCII 可见字符（0x21–0x7E，不含空格；方案 §3.2 规则栏），例如
/// `claude-3-5-sonnet-v2@20241022`、`claude-sonnet-4[1m]`、`gpt-4o+search`。
fn check_model_prefix(value: &str) -> Result<(), Code> {
    let visible = |byte: u8| (0x21..=0x7e).contains(&byte);
    if value.is_empty() || !value.bytes().all(visible) {
        Err(Code::Invalid)
    } else if value.len() > MAX_MODEL_PREFIX_CHARS {
        Err(Code::TooLong)
    } else {
        Ok(())
    }
}

fn exact(value: &str) -> String {
    value.to_string()
}

fn ascii_folded(value: &str) -> String {
    value.to_ascii_lowercase()
}

struct ListRule {
    field: &'static str,
    max: usize,
    /// 覆盖的工具至少一个；模型前缀与设备可以为空（表示全部）。
    allow_empty: bool,
    check: fn(&str) -> Result<(), Code>,
    /// 判断重复时的比较键：模型前缀不区分 ASCII 大小写，其余逐字比较。
    fold: fn(&str) -> String,
}

const TOOLS_RULE: ListRule = ListRule {
    field: field::TOOLS,
    max: MAX_PLAN_TOOLS,
    allow_empty: false,
    check: check_tool,
    fold: exact,
};

const MODEL_PREFIXES_RULE: ListRule = ListRule {
    field: field::MODEL_PREFIXES,
    max: MAX_PLAN_MODEL_PREFIXES,
    allow_empty: true,
    check: check_model_prefix,
    fold: ascii_folded,
};

const MACHINES_RULE: ListRule = ListRule {
    field: field::MACHINES,
    max: MAX_PLAN_MACHINES,
    allow_empty: true,
    check: check_machine,
    fold: exact,
};

// ---------------------------------------------------------------------------
// 逐字段解析一个订阅对象。设置页提交（Input）与设置文件（Stored）共用：Input 逐项
// 报错、允许新订阅不带 ID、可选字段缺省为空；Stored 只接受保存时会写出的规范形态，
// 任何一项不合规整条丢弃。
// ---------------------------------------------------------------------------

enum Source<'a> {
    Stored,
    Input {
        /// 已保存订阅的开始日期：没改动的开始日期不再按上界重判。
        stored_starts: &'a HashMap<String, NaiveDate>,
        /// 开始日期的上界（含）：设置页录入是本机今天，应用其他设备的副本（C1）是
        /// `remote_copy_latest_start`。
        latest_start: NaiveDate,
    },
}

impl Source<'_> {
    fn is_input(&self) -> bool {
        matches!(self, Self::Input { .. })
    }
}

/// 解析结果：每个字段合规时为 `Some`；`id` 为 `Some(None)` 表示提交里的新订阅。
#[derive(Default)]
struct PlanFields {
    id: Option<Option<String>>,
    name: Option<String>,
    provider: Option<CostProvider>,
    fee: Option<f64>,
    currency: Option<CostCurrency>,
    cycle: Option<CostBillingCycle>,
    anchor_day: Option<u8>,
    start_date: Option<NaiveDate>,
    end_date: Option<Option<NaiveDate>>,
    tools: Option<Vec<String>>,
    model_prefixes: Option<Vec<String>>,
    machines: Option<Vec<String>>,
    errors: Vec<CostProfileFieldError>,
}

/// 判断两个订阅是否重叠只需要这几项。
struct Coverage<'a> {
    start: NaiveDate,
    end: Option<NaiveDate>,
    tools: &'a [String],
    model_prefixes: &'a [String],
    machines: &'a [String],
}

impl PlanFields {
    fn push(&mut self, error: CostProfileFieldError) {
        self.errors.push(error);
    }

    fn coverage(&self) -> Option<Coverage<'_>> {
        Some(Coverage {
            start: self.start_date?,
            end: self.end_date?,
            tools: self.tools.as_deref()?,
            model_prefixes: self.model_prefixes.as_deref()?,
            machines: self.machines.as_deref()?,
        })
    }

    fn build(self, id: String) -> Option<CostSubscriptionPlan> {
        Some(CostSubscriptionPlan {
            id,
            name: self.name?,
            provider: self.provider?,
            fee: self.fee?,
            currency: self.currency?,
            cycle: self.cycle?,
            anchor_day: self.anchor_day?,
            start_date: self.start_date?,
            end_date: self.end_date?,
            tools: self.tools?,
            model_prefixes: self.model_prefixes?,
            machines: self.machines?,
        })
    }
}

impl CostSubscriptionPlan {
    fn coverage(&self) -> Coverage<'_> {
        Coverage {
            start: self.start_date,
            end: self.end_date,
            tools: &self.tools,
            model_prefixes: &self.model_prefixes,
            machines: &self.machines,
        }
    }
}

/// 闭合集合里的取值只接受字符串；未知取值按非法处理，从不回落到默认值。
fn parse_closed<T: DeserializeOwned>(
    value: Option<&Value>,
    plan_index: usize,
    field: &'static str,
    errors: &mut Vec<CostProfileFieldError>,
) -> Option<T> {
    let code = match value {
        Some(text @ Value::String(_)) => match T::deserialize(text) {
            Ok(parsed) => return Some(parsed),
            Err(_) => Code::Invalid,
        },
        other => required_or_invalid(other),
    };
    errors.push(CostProfileFieldError::new(Some(plan_index), field, code));
    None
}

fn parse_list(
    value: Option<&Value>,
    rule: &ListRule,
    plan_index: usize,
    source: &Source<'_>,
    errors: &mut Vec<CostProfileFieldError>,
) -> Option<Vec<String>> {
    let at = Some(plan_index);
    let items = match value {
        Some(Value::Array(items)) => items,
        None | Some(Value::Null) if source.is_input() && rule.allow_empty => {
            return Some(Vec::new())
        }
        other => {
            errors.push(CostProfileFieldError::new(
                at,
                rule.field,
                required_or_invalid(other),
            ));
            return None;
        }
    };
    if items.len() > rule.max {
        errors.push(CostProfileFieldError::new(at, rule.field, Code::TooMany));
        return None;
    }
    if items.is_empty() && !rule.allow_empty {
        errors.push(CostProfileFieldError::new(at, rule.field, Code::Required));
        return None;
    }
    let mut seen = HashSet::new();
    let mut list = Vec::with_capacity(items.len());
    let mut valid = true;
    for (index, item) in items.iter().enumerate() {
        let checked = match item.as_str() {
            Some(text) => (rule.check)(text).map(|()| text),
            None => Err(Code::Invalid),
        };
        match checked {
            Ok(text) if seen.insert((rule.fold)(text)) => list.push(text.to_string()),
            Ok(_) => {
                valid = false;
                errors
                    .push(CostProfileFieldError::new(at, rule.field, Code::Duplicate).item(index));
            }
            Err(code) => {
                valid = false;
                errors.push(CostProfileFieldError::new(at, rule.field, code).item(index));
            }
        }
    }
    valid.then_some(list)
}

fn parse_plan_fields(plan_index: usize, raw: &Value, source: &Source<'_>) -> PlanFields {
    let at = Some(plan_index);
    let mut fields = PlanFields::default();
    let Some(object) = raw.as_object() else {
        fields.push(CostProfileFieldError::new(at, field::PLAN, Code::Invalid));
        return fields;
    };
    if source.is_input() {
        for key in object.keys() {
            if !PLAN_KEYS.contains(&key.as_str()) {
                fields.push(
                    CostProfileFieldError::new(at, field::PLAN, Code::Invalid)
                        .key(key)
                        .message("订阅包含无法识别的字段"),
                );
            }
        }
    }

    fields.id = match object.get("id") {
        None | Some(Value::Null) if source.is_input() => Some(None),
        Some(Value::String(id)) if valid_plan_id(id) => Some(Some(id.clone())),
        other => {
            let code = if source.is_input() {
                Code::Invalid
            } else {
                required_or_invalid(other)
            };
            fields.push(CostProfileFieldError::new(at, field::ID, code));
            None
        }
    };

    fields.name = match object.get("name") {
        Some(Value::String(raw_name)) => match check_name(raw_name) {
            // 设置文件里只认保存时写出的去空白名称。
            Ok(name) if source.is_input() || name == *raw_name => Some(name),
            Ok(_) => {
                fields.push(CostProfileFieldError::new(at, field::NAME, Code::Invalid));
                None
            }
            Err(code) => {
                fields.push(CostProfileFieldError::new(at, field::NAME, code));
                None
            }
        },
        other => {
            fields.push(CostProfileFieldError::new(
                at,
                field::NAME,
                required_or_invalid(other),
            ));
            None
        }
    };

    fields.provider = parse_closed(
        object.get("provider"),
        plan_index,
        field::PROVIDER,
        &mut fields.errors,
    );

    fields.fee = match object.get("fee") {
        Some(Value::Number(number)) => match number.as_f64().map(check_fee) {
            Some(Ok(fee)) => Some(fee),
            Some(Err(code)) => {
                fields.push(CostProfileFieldError::new(at, field::FEE, code));
                None
            }
            None => {
                fields.push(CostProfileFieldError::new(at, field::FEE, Code::Invalid));
                None
            }
        },
        other => {
            fields.push(CostProfileFieldError::new(
                at,
                field::FEE,
                required_or_invalid(other),
            ));
            None
        }
    };

    fields.currency = parse_closed(
        object.get("currency"),
        plan_index,
        field::CURRENCY,
        &mut fields.errors,
    );
    fields.cycle = parse_closed(
        object.get("cycle"),
        plan_index,
        field::CYCLE,
        &mut fields.errors,
    );

    fields.anchor_day = match object.get("anchorDay") {
        Some(Value::Number(number)) => match number.as_i64() {
            Some(day) if (1..=31).contains(&day) => u8::try_from(day).ok(),
            whole => {
                // 整数但越界是 out_of_range；带小数的数不是计费日。
                let code = if whole.is_some() || number.as_u64().is_some() {
                    Code::OutOfRange
                } else {
                    Code::Invalid
                };
                fields.push(CostProfileFieldError::new(at, field::ANCHOR_DAY, code));
                None
            }
        },
        other => {
            fields.push(CostProfileFieldError::new(
                at,
                field::ANCHOR_DAY,
                required_or_invalid(other),
            ));
            None
        }
    };

    fields.start_date = match object.get("startDate") {
        Some(Value::String(text)) => match parse_date(text) {
            None => {
                fields.push(CostProfileFieldError::new(
                    at,
                    field::START_DATE,
                    Code::Invalid,
                ));
                None
            }
            Some(date) if date < earliest_start_date() => {
                fields.push(CostProfileFieldError::new(
                    at,
                    field::START_DATE,
                    Code::OutOfRange,
                ));
                None
            }
            Some(date) => {
                if let Source::Input {
                    stored_starts,
                    latest_start,
                } = source
                {
                    // 「不晚于今天」只检查新订阅与改过开始日期的订阅：已保存的开始日期
                    // 不因本机时钟或时区差异被重新判定（例如从更东时区的设备同步来）。
                    let unchanged = matches!(&fields.id, Some(Some(id)) if stored_starts.get(id) == Some(&date));
                    if !unchanged && date > *latest_start {
                        fields.push(CostProfileFieldError::new(
                            at,
                            field::START_DATE,
                            Code::InFuture,
                        ));
                    }
                }
                Some(date)
            }
        },
        other => {
            fields.push(CostProfileFieldError::new(
                at,
                field::START_DATE,
                required_or_invalid(other),
            ));
            None
        }
    };

    fields.end_date = match object.get("endDate") {
        Some(Value::Null) => Some(None),
        None if source.is_input() => Some(None),
        Some(Value::String(text)) => match parse_date(text) {
            Some(end) if fields.start_date.is_some_and(|start| end < start) => {
                fields.push(CostProfileFieldError::new(
                    at,
                    field::END_DATE,
                    Code::BeforeStart,
                ));
                None
            }
            Some(end) => Some(Some(end)),
            None => {
                fields.push(CostProfileFieldError::new(
                    at,
                    field::END_DATE,
                    Code::Invalid,
                ));
                None
            }
        },
        _ => {
            fields.push(CostProfileFieldError::new(
                at,
                field::END_DATE,
                Code::Invalid,
            ));
            None
        }
    };

    fields.tools = parse_list(
        object.get("tools"),
        &TOOLS_RULE,
        plan_index,
        source,
        &mut fields.errors,
    );
    fields.model_prefixes = parse_list(
        object.get("modelPrefixes"),
        &MODEL_PREFIXES_RULE,
        plan_index,
        source,
        &mut fields.errors,
    );
    fields.machines = parse_list(
        object.get("machines"),
        &MACHINES_RULE,
        plan_index,
        source,
        &mut fields.errors,
    );
    fields
}

/// 设置文件里的一条订阅：只接受保存时会写出的规范形态，否则整条丢弃。
fn parse_stored_plan(raw: &Value) -> Option<CostSubscriptionPlan> {
    let fields = parse_plan_fields(0, raw, &Source::Stored);
    if !fields.errors.is_empty() {
        return None;
    }
    let id = fields.id.clone().flatten()?;
    fields.build(id)
}

// ---------------------------------------------------------------------------
// 订阅之间的规则：不重名、ID 不重复、同一时刻一个工具只属于一个订阅（方案 §2.3、§3.2）。
// ---------------------------------------------------------------------------

fn model_prefixes_intersect(left: &[String], right: &[String]) -> bool {
    left.is_empty()
        || right.is_empty()
        || left.iter().any(|left| {
            let left = left.to_ascii_lowercase();
            right.iter().any(|right| {
                let right = right.to_ascii_lowercase();
                left.starts_with(&right) || right.starts_with(&left)
            })
        })
}

fn machines_intersect(left: &[String], right: &[String]) -> bool {
    left.is_empty() || right.is_empty() || left.iter().any(|machine| right.contains(machine))
}

/// 两个订阅会同时覆盖同一类记录时，返回重叠的起始日期与一个共同的工具。
/// 时段按含首尾的本地日期比较：旧方案 8/31 结束、新方案 9/1 开始不算重叠。
fn overlap<'a>(earlier: &Coverage<'_>, later: &Coverage<'a>) -> Option<(NaiveDate, &'a str)> {
    let starts_before_end =
        |plan: &Coverage<'_>, other: &Coverage<'_>| other.end.is_none_or(|end| plan.start <= end);
    if !starts_before_end(earlier, later) || !starts_before_end(later, earlier) {
        return None;
    }
    if !model_prefixes_intersect(earlier.model_prefixes, later.model_prefixes)
        || !machines_intersect(earlier.machines, later.machines)
    {
        return None;
    }
    let tool = later
        .tools
        .iter()
        .find(|tool| earlier.tools.contains(tool))?;
    Some((earlier.start.max(later.start), tool.as_str()))
}

fn overlap_message(earlier: &str, later: &str, since: NaiveDate, tool: &str) -> String {
    format!(
        "「{earlier}」与「{later}」自 {} 起同时覆盖 {tool}，账本无法区分记录来自哪个订阅。请用模型前缀或设备区分，或合并为一个订阅（订阅费相加）。",
        since.format("%Y-%m-%d")
    )
}

fn plan_label(fields: &PlanFields, index: usize) -> String {
    fields
        .name
        .clone()
        .unwrap_or_else(|| format!("第 {} 个订阅", index + 1))
}

fn cross_plan_errors(plans: &[PlanFields]) -> Vec<CostProfileFieldError> {
    let mut errors = Vec::new();
    for (later_index, later) in plans.iter().enumerate() {
        for (earlier_index, earlier) in plans[..later_index].iter().enumerate() {
            let at = Some(later_index);
            if let (Some(Some(left)), Some(Some(right))) = (&earlier.id, &later.id) {
                if left == right {
                    errors.push(
                        CostProfileFieldError::new(at, field::ID, Code::Duplicate)
                            .related(earlier_index),
                    );
                }
            }
            if let (Some(left), Some(right)) = (&earlier.name, &later.name) {
                if fold_name(left) == fold_name(right) {
                    errors.push(
                        CostProfileFieldError::new(at, field::NAME, Code::Duplicate)
                            .related(earlier_index),
                    );
                }
            }
            if let (Some(left), Some(right)) = (earlier.coverage(), later.coverage()) {
                if let Some((since, tool)) = overlap(&left, &right) {
                    let message = overlap_message(
                        &plan_label(earlier, earlier_index),
                        &plan_label(later, later_index),
                        since,
                        tool,
                    );
                    errors.push(
                        CostProfileFieldError::new(at, field::TOOLS, Code::Overlap)
                            .related(earlier_index)
                            .message(message),
                    );
                }
            }
        }
    }
    errors
}

fn plans_conflict(earlier: &CostSubscriptionPlan, later: &CostSubscriptionPlan) -> bool {
    earlier.id == later.id
        || fold_name(&earlier.name) == fold_name(&later.name)
        || overlap(&earlier.coverage(), &later.coverage()).is_some()
}

// ---------------------------------------------------------------------------
// 设置页提交的整份订阅设置。
// ---------------------------------------------------------------------------

/// 校验通过的提交；新订阅在 `into_profile` 里才拿到 ID。
pub(crate) struct InputProfile {
    plans: Vec<PlanFields>,
    tool_billing_modes: BTreeMap<String, CostBillingMode>,
    cny_per_usd: f64,
}

impl InputProfile {
    /// 新订阅在这里拿到本机生成的 ID；已有订阅保留原 ID。错误是固定句子。
    pub(crate) fn into_profile(self, stored: &CostProfile) -> Result<CostProfile, &'static str> {
        let mut taken: HashSet<String> = stored
            .plans
            .iter()
            .map(|plan| plan.id.clone())
            .chain(
                self.plans
                    .iter()
                    .filter_map(|plan| plan.id.clone().flatten()),
            )
            .collect();
        let mut plans = Vec::with_capacity(self.plans.len());
        for fields in self.plans {
            let id = match fields.id.clone().flatten() {
                Some(id) => id,
                None => {
                    let id = generate_plan_id(&taken);
                    taken.insert(id.clone());
                    id
                }
            };
            plans.push(fields.build(id).ok_or(INTERNAL_ERROR)?);
        }
        Ok(CostProfile {
            plans,
            tool_billing_modes: self.tool_billing_modes,
            cny_per_usd: Some(self.cny_per_usd),
        })
    }
}

fn parse_input_billing_modes(
    value: Option<&Value>,
    errors: &mut Vec<CostProfileFieldError>,
) -> Option<BTreeMap<String, CostBillingMode>> {
    let entries = match value {
        Some(Value::Object(entries)) => entries,
        other => {
            errors.push(CostProfileFieldError::new(
                None,
                field::TOOL_BILLING_MODES,
                required_or_invalid(other),
            ));
            return None;
        }
    };
    if entries.len() > MAX_BILLING_MODES {
        errors.push(CostProfileFieldError::new(
            None,
            field::TOOL_BILLING_MODES,
            Code::TooMany,
        ));
        return None;
    }
    let mut modes = BTreeMap::new();
    let mut valid = true;
    // 按工具名排序报错，与 serde_json 是否保留键序无关。
    let sorted: BTreeMap<&String, &Value> = entries.iter().collect();
    for (tool, mode) in sorted {
        if let Err(code) = check_tool(tool) {
            valid = false;
            errors.push(
                CostProfileFieldError::new(None, field::TOOL_BILLING_MODES, code)
                    .key(tool)
                    .message("工具 ID 无效"),
            );
            continue;
        }
        match mode.as_str().map(|_| CostBillingMode::deserialize(mode)) {
            Some(Ok(parsed)) => {
                modes.insert(tool.clone(), parsed);
            }
            _ => {
                valid = false;
                errors.push(
                    CostProfileFieldError::new(None, field::TOOL_BILLING_MODES, Code::Invalid)
                        .key(tool)
                        .message("付费方式只能是按量付费（payg）"),
                );
            }
        }
    }
    valid.then_some(modes)
}

fn parse_input_cny_per_usd(
    value: Option<&Value>,
    errors: &mut Vec<CostProfileFieldError>,
) -> Option<f64> {
    let code = match value {
        Some(Value::Number(number)) => match number.as_f64().map(check_cny_per_usd) {
            Some(Ok(rate)) => return Some(rate),
            Some(Err(code)) => code,
            None => Code::Invalid,
        },
        other => required_or_invalid(other),
    };
    errors.push(CostProfileFieldError::new(None, field::CNY_PER_USD, code));
    None
}

/// C1 应用其他设备已校验过的副本时的开始日期上界：本机今天 + 2 天（同一时刻各地的本地
/// 日期最多相差两天）。只放宽这一条，其余规则照常。
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "C1 应用云端副本时调用；B1 先落定义与测试")
)]
pub(crate) fn remote_copy_latest_start(today: NaiveDate) -> NaiveDate {
    today
        .checked_add_days(Days::new(REMOTE_COPY_START_SLACK_DAYS))
        .unwrap_or(NaiveDate::MAX)
}

/// 解析并校验提交的整份订阅设置；有任何错误时返回全部字段级错误。`latest_start` 是开始
/// 日期的上界（含）：设置页录入用本机今天，应用其他设备的副本（C1）用
/// `remote_copy_latest_start`。`null` 不是订阅设置（删除全部另有命令），报 `required`。
pub(crate) fn parse_input_profile(
    raw: &Value,
    stored: &CostProfile,
    latest_start: NaiveDate,
) -> Result<InputProfile, Vec<CostProfileFieldError>> {
    let Some(object) = raw.as_object() else {
        return Err(vec![CostProfileFieldError::new(
            None,
            field::PROFILE,
            required_or_invalid(Some(raw)),
        )]);
    };
    let mut errors = Vec::new();
    for key in object.keys() {
        if !PROFILE_KEYS.contains(&key.as_str()) {
            errors.push(
                CostProfileFieldError::new(None, field::PROFILE, Code::Invalid)
                    .key(key)
                    .message("订阅设置包含无法识别的字段"),
            );
        }
    }

    let stored_starts: HashMap<String, NaiveDate> = stored
        .plans
        .iter()
        .map(|plan| (plan.id.clone(), plan.start_date))
        .collect();
    let source = Source::Input {
        stored_starts: &stored_starts,
        latest_start,
    };
    let mut plans = Vec::new();
    match object.get("plans") {
        Some(Value::Array(items)) if items.len() > MAX_PLANS => {
            errors.push(CostProfileFieldError::new(
                None,
                field::PLANS,
                Code::TooMany,
            ));
        }
        Some(Value::Array(items)) => {
            plans = items
                .iter()
                .enumerate()
                .map(|(index, item)| parse_plan_fields(index, item, &source))
                .collect();
        }
        other => errors.push(CostProfileFieldError::new(
            None,
            field::PLANS,
            required_or_invalid(other),
        )),
    }
    for plan in &mut plans {
        errors.append(&mut plan.errors);
    }
    errors.extend(cross_plan_errors(&plans));

    let tool_billing_modes = parse_input_billing_modes(object.get("toolBillingModes"), &mut errors);
    let cny_per_usd = parse_input_cny_per_usd(object.get("cnyPerUsd"), &mut errors);
    match (tool_billing_modes, cny_per_usd) {
        (Some(tool_billing_modes), Some(cny_per_usd)) if errors.is_empty() => Ok(InputProfile {
            plans,
            tool_billing_modes,
            cny_per_usd,
        }),
        _ => Err(errors),
    }
}

// ---------------------------------------------------------------------------
// 设置文件读取：四个字段各自宽松反序列化，任何一项不合法只丢这一项并记条数。
// `AppSettings::sanitized()` 对内存中的值再走一遍同样的规则（对读自文件的值是空操作）。
// ---------------------------------------------------------------------------

#[cfg(test)]
thread_local! {
    /// 测试观测点：本线程报告过的（类别, 条数），不论是否真的写了日志。
    static DROPPED_REPORTS: std::cell::RefCell<Vec<(&'static str, usize)>> =
        const { std::cell::RefCell::new(Vec::new()) };
    /// 测试观测点：本线程真正写进日志的类别。
    static LOGGED_REPORTS: std::cell::RefCell<Vec<&'static str>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// 测试用：取出本线程报告过的丢弃，按类别排序。
#[cfg(test)]
pub(crate) fn take_dropped_reports() -> Vec<(&'static str, usize)> {
    let mut reports = DROPPED_REPORTS.with(|reports| std::mem::take(&mut *reports.borrow_mut()));
    reports.sort_unstable();
    reports
}

/// 测试用：取出本线程真正写进日志的类别。
#[cfg(test)]
pub(crate) fn take_logged_reports() -> Vec<&'static str> {
    LOGGED_REPORTS.with(|reports| std::mem::take(&mut *reports.borrow_mut()))
}

/// 每个类别在一个进程里只告警一次：额度同步等路径会周期性地读设置文件，手改过的文件
/// 在下一次写入前每次读取都会丢弃同样的条目，不能让同一条警告一直重复。
struct WarnOnce(Mutex<BTreeSet<&'static str>>);

impl WarnOnce {
    const fn new() -> Self {
        Self(Mutex::new(BTreeSet::new()))
    }

    /// 这一类别在本进程里第一次出现时为真。
    fn first(&self, what: &'static str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(what)
    }
}

static DROP_WARNINGS: WarnOnce = WarnOnce::new();

/// 只记条数与固定的类别名，从不记名称、金额或原值（方案 §3.3）；同一类别每个进程只记一次。
pub(crate) fn report_dropped(what: &'static str, count: usize) {
    if count == 0 {
        return;
    }
    #[cfg(test)]
    DROPPED_REPORTS.with(|reports| reports.borrow_mut().push((what, count)));
    if DROP_WARNINGS.first(what) {
        log::warn!(
            "cost profile: ignored {count} invalid {what} in app settings; not logged again until restart"
        );
        #[cfg(test)]
        LOGGED_REPORTS.with(|reports| reports.borrow_mut().push(what));
    }
}

/// 逐条校验并按顺序保留：与已保留的订阅重名、ID 重复或时段重叠的后一条丢弃，
/// 超过 12 条的部分丢弃。返回保留的订阅与丢弃条数。
fn sanitize_plans(plans: Vec<CostSubscriptionPlan>) -> (Vec<CostSubscriptionPlan>, usize) {
    let total = plans.len();
    let mut kept: Vec<CostSubscriptionPlan> = Vec::with_capacity(total.min(MAX_PLANS));
    for plan in plans {
        let keep = kept.len() < MAX_PLANS
            && is_canonical_plan(&plan)
            && kept.iter().all(|earlier| !plans_conflict(earlier, &plan));
        if keep {
            kept.push(plan);
        }
    }
    let dropped = total - kept.len();
    (kept, dropped)
}

/// 内存中的订阅与「写出后再按设置文件规则读回」完全一致，才算合规。
fn is_canonical_plan(plan: &CostSubscriptionPlan) -> bool {
    serde_json::to_value(plan)
        .ok()
        .and_then(|value| parse_stored_plan(&value))
        .is_some_and(|parsed| parsed == *plan)
}

fn sanitize_billing_modes(
    modes: BTreeMap<String, CostBillingMode>,
) -> (BTreeMap<String, CostBillingMode>, usize) {
    let total = modes.len();
    let kept: BTreeMap<String, CostBillingMode> = modes
        .into_iter()
        .filter(|(tool, _)| check_tool(tool).is_ok())
        .take(MAX_BILLING_MODES)
        .collect();
    let dropped = total - kept.len();
    (kept, dropped)
}

/// `cost_subscription_plans` 的反序列化：永不失败。
pub(crate) fn deserialize_stored_plans<'de, D>(
    deserializer: D,
) -> Result<Vec<CostSubscriptionPlan>, D::Error>
where
    D: Deserializer<'de>,
{
    let Value::Array(items) = Value::deserialize(deserializer)? else {
        report_dropped("subscription plan list", 1);
        return Ok(Vec::new());
    };
    let total = items.len();
    let parsed = items.iter().filter_map(parse_stored_plan).collect();
    let (kept, _) = sanitize_plans(parsed);
    report_dropped("subscription plan(s)", total - kept.len());
    Ok(kept)
}

/// `cost_tool_billing_modes` 的反序列化：永不失败。
pub(crate) fn deserialize_stored_billing_modes<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<String, CostBillingMode>, D::Error>
where
    D: Deserializer<'de>,
{
    let Value::Object(entries) = Value::deserialize(deserializer)? else {
        report_dropped("billing mode map", 1);
        return Ok(BTreeMap::new());
    };
    let total = entries.len();
    let parsed = entries
        .iter()
        .filter_map(|(tool, mode)| {
            mode.as_str()?;
            CostBillingMode::deserialize(mode)
                .ok()
                .map(|mode| (tool.clone(), mode))
        })
        .collect();
    let (kept, _) = sanitize_billing_modes(parsed);
    report_dropped("billing mode entr(ies)", total - kept.len());
    Ok(kept)
}

/// `cost_cny_per_usd` 缺省时的值。
pub(crate) fn default_cny_per_usd() -> Option<f64> {
    Some(DEFAULT_CNY_PER_USD)
}

/// `cost_cny_per_usd` 的反序列化：永不失败。非法值读成 `None`（不可得），不改写成 7.2；
/// `null` 是之前已判为不可得、尚未修复的状态，不重复记日志。
pub(crate) fn deserialize_stored_cny_per_usd<'de, D>(
    deserializer: D,
) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Value::deserialize(deserializer)?;
    if raw.is_null() {
        return Ok(None);
    }
    let rate = raw.as_f64().and_then(|rate| check_cny_per_usd(rate).ok());
    if rate.is_none() {
        report_dropped("CNY/USD rate", 1);
    }
    Ok(rate)
}

/// `cost_profile_revision` 的反序列化：永不失败。读不出的版本号按 0 处理并记日志，
/// 下次保存从 1 重新计数；C1 会把本机视为较旧的一方，从云端取回。
pub(crate) fn deserialize_stored_revision<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Value::deserialize(deserializer)?;
    match raw.as_u64().filter(|revision| *revision <= MAX_REVISION) {
        Some(revision) => Ok(revision),
        None => {
            report_dropped("profile revision", 1);
            Ok(0)
        }
    }
}

/// `AppSettings::sanitized()` 的订阅设置部分：对内存中的值执行与读取设置文件相同的规则。
pub(crate) fn sanitize_stored(settings: &mut AppSettings) {
    let (plans, dropped) = sanitize_plans(std::mem::take(&mut settings.cost_subscription_plans));
    settings.cost_subscription_plans = plans;
    report_dropped("subscription plan(s)", dropped);

    let (modes, dropped) =
        sanitize_billing_modes(std::mem::take(&mut settings.cost_tool_billing_modes));
    settings.cost_tool_billing_modes = modes;
    report_dropped("billing mode entr(ies)", dropped);

    if let Some(rate) = settings.cost_cny_per_usd {
        if check_cny_per_usd(rate).is_err() {
            settings.cost_cny_per_usd = None;
            report_dropped("CNY/USD rate", 1);
        }
    }
    if settings.cost_profile_revision > MAX_REVISION {
        settings.cost_profile_revision = 0;
        report_dropped("profile revision", 1);
    }
}

/// 新订阅的 ID：`sub-` 加 16 位小写十六进制，与已占用的 ID 不同。
pub(crate) fn generate_plan_id(taken: &HashSet<String>) -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    loop {
        let mut hasher = Sha256::new();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        hasher.update(nanos.to_le_bytes());
        hasher.update(std::process::id().to_le_bytes());
        hasher.update(SEQUENCE.fetch_add(1, Ordering::Relaxed).to_le_bytes());
        hasher.update(RandomState::new().build_hasher().finish().to_le_bytes());
        let digest = hasher.finalize();
        let hex: String = digest[..PLAN_ID_HEX_DIGITS / 2]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let id = format!("{PLAN_ID_PREFIX}{hex}");
        if !taken.contains(&id) {
            return id;
        }
    }
}
