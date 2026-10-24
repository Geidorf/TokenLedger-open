//! Routing groups (T10.267, U-91): several `provider/model` members behind one
//! virtual model `group/<id>`. Members are picked by deterministic rules,
//! then session affinity, then the group strategy; no model is asked to
//! classify intent. Groups live in `routing-v1.json`; decisions are kept in a
//! small in-memory ring for the UI.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::store::{valid_id, write_json_atomic};

pub const GROUP_PREFIX: &str = "group/";
const STORE_FILE: &str = "routing-v1.json";
const STORE_SCHEMA_VERSION: u8 = 1;
const MAX_GROUPS: usize = 64;
const MAX_MEMBERS: usize = 16;
const MAX_RULES: usize = 32;
const MAX_TTL_SECS: u64 = 7 * 24 * 3600;
const MAX_AFFINITY_ENTRIES: usize = 10_000;
const MAX_DECISIONS: usize = 200;
/// A member that failed (connect error, 5xx, 429) moves behind the others
/// for 30 s, doubling per consecutive failure up to 5 min.
const COOLDOWN_BASE_SECS: u64 = 30;
const COOLDOWN_MAX_SECS: u64 = 300;
const MAX_SCAN_DEPTH: usize = 64;
const MAX_WEIGHT: u32 = 100;
/// Group levels below the requested one: group → subgroup → sub-subgroup.
const MAX_NEST_DEPTH: usize = 2;
/// Codex's local compaction prompt; seen in codex-cli 0.160.
const COMPACT_MARKERS: &[&str] = &["CONTEXT CHECKPOINT COMPACTION"];
const IMAGE_TYPES: &[&str] = &["input_image", "image_url", "image"];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    /// Members in order; the next one on failure.
    Failover,
    /// Round-robin start, then the following members on failure.
    Rotate,
    /// Always `manualMember`, no failover.
    Manual,
    /// Smooth weighted round-robin start by `weights`, then the remaining
    /// members by weight on failure.
    Weighted,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RuleCondition {
    HasImage,
    InputCharsOver {
        chars: u64,
    },
    ReasoningEffort {
        efforts: Vec<String>,
    },
    Agent {
        agents: Vec<String>,
    },
    /// Local time `HH:MM`, start inclusive, end exclusive; wraps midnight.
    TimeWindow {
        start: String,
        end: String,
    },
    Compact,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutingRule {
    pub condition: RuleCondition,
    pub member: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoutingGroup {
    pub id: String,
    pub name: String,
    pub strategy: Strategy,
    pub members: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manual_member: Option<String>,
    #[serde(default)]
    pub rules: Vec<RoutingRule>,
    /// Member → weight 1–100 for `weighted`; a missing member weighs 1.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub weights: BTreeMap<String, u32>,
    /// 0 turns session affinity off.
    #[serde(default = "default_ttl")]
    pub session_ttl_secs: u64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_ttl() -> u64 {
    3600
}

fn default_enabled() -> bool {
    true
}

impl RoutingGroup {
    pub fn model_name(&self) -> String {
        format!("{GROUP_PREFIX}{}", self.id)
    }

    fn weight(&self, member: &str) -> u32 {
        self.weights.get(member).copied().unwrap_or(1)
    }
}

/// The member index for `turn` in a smooth weighted round-robin over
/// `weights`: each cycle of `sum(weights)` turns gives every member exactly
/// its weight, spread out instead of in bursts.
pub fn weighted_index(weights: &[u32], turn: usize) -> usize {
    let total: i64 = weights.iter().map(|w| i64::from(*w)).sum();
    if total == 0 {
        return 0;
    }
    let mut current = vec![0i64; weights.len()];
    let mut picked = 0;
    for _ in 0..=(turn % total as usize) {
        for (slot, weight) in current.iter_mut().zip(weights) {
            *slot += i64::from(*weight);
        }
        picked = (0..current.len())
            .max_by_key(|&index| (current[index], std::cmp::Reverse(index)))
            .unwrap_or(0);
        current[picked] -= total;
    }
    picked
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouteAttempt {
    pub member: String,
    /// `ok` | `rejected` (non-retryable upstream error) | `failed`
    /// (connect error, 5xx, 429) | `skipped` (member unusable).
    pub outcome: &'static str,
    pub status: Option<u16>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecision {
    pub ts: String,
    pub request_id: String,
    pub group: String,
    pub session: Option<String>,
    /// `rule` | `affinity` | `failover` | `rotate` | `manual` | `weighted`
    pub reason: &'static str,
    pub detail: String,
    pub chosen: Option<String>,
    pub attempts: Vec<RouteAttempt>,
    /// Why each group member was chosen, tried, passed over or left out:
    /// candidates in plan order, then members outside the plan.
    pub trace: Vec<MemberTrace>,
}

/// One group member's part in a decision. `verdict` is `chosen` | `failed`
/// | `rejected` | `skipped` | `not_reached` | `excluded`; `reasons` are
/// machine codes (see `docs/design/routing-decision-trace-v1.md`), `detail` a
/// short human note.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemberTrace {
    pub member: String,
    /// Position among the candidates; `None` when left out of the plan.
    pub rank: Option<u8>,
    pub verdict: &'static str,
    pub reasons: Vec<&'static str>,
    pub detail: Option<String>,
}

/// A member the plan left out before any try (e.g. cooling down or out of
/// quota), with a reason code from the trace table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Exclusion {
    pub member: String,
    pub reason: &'static str,
    pub detail: Option<String>,
}

/// A member that recently failed and is tried after the others for now.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoolingMember {
    pub member: String,
    pub remaining_secs: u64,
    /// Consecutive failures behind the current cooldown.
    pub failures: u32,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Features {
    pub has_image: bool,
    pub input_chars: u64,
    pub reasoning_effort: Option<String>,
    pub agent: Option<String>,
    pub local_minutes: u32,
    pub compact: bool,
}

fn scan(value: &Value, depth: usize, out: &mut Features) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    match value {
        Value::String(text) => {
            if text.starts_with("data:") {
                return;
            }
            out.input_chars += text.chars().count() as u64;
            if !out.compact && COMPACT_MARKERS.iter().any(|marker| text.contains(marker)) {
                out.compact = true;
            }
        }
        Value::Array(items) => items.iter().for_each(|item| scan(item, depth + 1, out)),
        Value::Object(map) => {
            if map.contains_key("image_url")
                || map
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| IMAGE_TYPES.contains(&kind))
            {
                out.has_image = true;
            }
            for (key, item) in map {
                if !matches!(
                    key.as_str(),
                    "image_url" | "type" | "id" | "call_id" | "role" | "status"
                ) {
                    scan(item, depth + 1, out);
                }
            }
        }
        _ => {}
    }
}

impl Features {
    /// Works on Responses (`input`, `instructions`, `reasoning.effort`) and
    /// Chat (`messages`, `reasoning_effort`) bodies alike.
    pub fn extract(payload: &Value, agent: Option<&str>, local_minutes: u32) -> Self {
        let mut features = Self {
            agent: agent.map(str::to_string),
            local_minutes,
            reasoning_effort: payload
                .pointer("/reasoning/effort")
                .or_else(|| payload.get("reasoning_effort"))
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase),
            ..Self::default()
        };
        for key in ["instructions", "input", "messages"] {
            if let Some(value) = payload.get(key) {
                scan(value, 0, &mut features);
            }
        }
        features
    }
}

/// A conversation key from the body, for clients that send no session
/// header: Responses `prompt_cache_key`, or the session inside Anthropic
/// `metadata.user_id` (a JSON object with `session_id`, or a legacy
/// `…_session_<id>` string). Only used to pin routing, never recorded.
pub fn body_session(payload: &Value) -> Option<String> {
    let clip = |text: &str| -> Option<String> {
        let text = text.trim();
        (!text.is_empty()).then(|| text.chars().take(128).collect())
    };
    if let Some(key) = payload.get("prompt_cache_key").and_then(Value::as_str) {
        return clip(key);
    }
    let user = payload
        .pointer("/metadata/user_id")
        .and_then(Value::as_str)?;
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(user) {
        return map.get("session_id").and_then(Value::as_str).and_then(clip);
    }
    user.rsplit_once("_session_").and_then(|(_, id)| clip(id))
}

fn parse_minutes(text: &str) -> Option<u32> {
    let (hour, minute) = text.split_once(':')?;
    if hour.len() != 2 || minute.len() != 2 {
        return None;
    }
    let (hour, minute): (u32, u32) = (hour.parse().ok()?, minute.parse().ok()?);
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

impl RuleCondition {
    fn matches(&self, features: &Features) -> bool {
        match self {
            Self::HasImage => features.has_image,
            Self::InputCharsOver { chars } => features.input_chars > *chars,
            Self::ReasoningEffort { efforts } => features
                .reasoning_effort
                .as_ref()
                .is_some_and(|effort| efforts.iter().any(|item| item == effort)),
            Self::Agent { agents } => features
                .agent
                .as_ref()
                .is_some_and(|agent| agents.iter().any(|item| item == agent)),
            Self::TimeWindow { start, end } => {
                let (Some(start), Some(end)) = (parse_minutes(start), parse_minutes(end)) else {
                    return false;
                };
                let now = features.local_minutes;
                if start < end {
                    (start..end).contains(&now)
                } else {
                    now >= start || now < end
                }
            }
            Self::Compact => features.compact,
        }
    }

    fn describe(&self) -> String {
        match self {
            Self::HasImage => "含图片输入".to_string(),
            Self::InputCharsOver { chars } => format!("输入超过 {chars} 字符"),
            Self::ReasoningEffort { efforts } => format!("推理强度 {}", efforts.join("/")),
            Self::Agent { agents } => format!("Agent {}", agents.join("/")),
            Self::TimeWindow { start, end } => format!("时间段 {start}–{end}"),
            Self::Compact => "compact 请求".to_string(),
        }
    }

    fn validate(&self) -> Result<(), String> {
        let short_list = |items: &[String], what: &str| {
            if items.is_empty()
                || items.len() > 16
                || items.iter().any(|item| {
                    item.is_empty()
                        || item.len() > 32
                        || item
                            .chars()
                            .any(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
                })
            {
                Err(format!("{what}需要 1–16 个小写标识。"))
            } else {
                Ok(())
            }
        };
        match self {
            Self::HasImage | Self::Compact => Ok(()),
            Self::InputCharsOver { chars } if *chars == 0 => {
                Err("输入长度阈值需要大于 0。".to_string())
            }
            Self::InputCharsOver { .. } => Ok(()),
            Self::ReasoningEffort { efforts } => short_list(efforts, "推理强度"),
            Self::Agent { agents } => short_list(agents, "Agent "),
            Self::TimeWindow { start, end } => match (parse_minutes(start), parse_minutes(end)) {
                (Some(start), Some(end)) if start != end => Ok(()),
                _ => Err("时间段需要写成不同的 HH:MM。".to_string()),
            },
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    /// `provider/model` leaves once [`Router::plan`] has expanded subgroups.
    pub candidates: Vec<String>,
    /// Per candidate, the innermost subgroup it came from (`None` = direct).
    pub via: Vec<Option<String>>,
    pub reason: &'static str,
    pub detail: String,
    /// Members dropped before any try; the trace explains each one.
    pub excluded: Vec<Exclusion>,
}

impl Plan {
    pub fn is_rule(&self) -> bool {
        self.reason == "rule"
    }
}

/// Pure selection: first matching rule, else a live affinity, else the
/// strategy. Failover and rotate append the remaining members as fallbacks.
pub fn plan_members(
    group: &RoutingGroup,
    features: &Features,
    affinity: Option<&str>,
    rotation: usize,
) -> Plan {
    let members = &group.members;
    let (primary, reason, detail) = if let Some(rule) = group
        .rules
        .iter()
        .find(|rule| members.contains(&rule.member) && rule.condition.matches(features))
    {
        (rule.member.clone(), "rule", rule.condition.describe())
    } else if let Some(member) = affinity.filter(|member| members.iter().any(|m| m == member)) {
        (
            member.to_string(),
            "affinity",
            "同一会话沿用上次成员".to_string(),
        )
    } else {
        match group.strategy {
            Strategy::Failover => (members[0].clone(), "failover", "按顺序".to_string()),
            Strategy::Rotate => (
                members[rotation % members.len()].clone(),
                "rotate",
                "轮询".to_string(),
            ),
            Strategy::Manual => (
                group
                    .manual_member
                    .clone()
                    .unwrap_or_else(|| members[0].clone()),
                "manual",
                "固定成员".to_string(),
            ),
            Strategy::Weighted => {
                let weights: Vec<u32> = members.iter().map(|m| group.weight(m)).collect();
                let index = weighted_index(&weights, rotation);
                let total: u32 = weights.iter().sum();
                (
                    members[index].clone(),
                    "weighted",
                    format!("加权 {}/{total}", weights[index]),
                )
            }
        }
    };
    let start = members.iter().position(|m| *m == primary).unwrap_or(0);
    let candidates = match group.strategy {
        Strategy::Manual => vec![primary],
        Strategy::Failover => std::iter::once(primary.clone())
            .chain(members.iter().filter(|m| **m != primary).cloned())
            .collect(),
        Strategy::Rotate => (0..members.len())
            .map(|offset| members[(start + offset) % members.len()].clone())
            .collect(),
        Strategy::Weighted => {
            let mut rest: Vec<&String> = members.iter().filter(|m| **m != primary).collect();
            rest.sort_by_key(|m| std::cmp::Reverse(group.weight(m)));
            std::iter::once(primary.clone())
                .chain(rest.into_iter().cloned())
                .collect()
        }
    };
    Plan {
        via: vec![None; candidates.len()],
        candidates,
        reason,
        detail,
        excluded: Vec::new(),
    }
}

const DETAIL_CHARS: usize = 200;

fn primary_code(reason: &str) -> &'static str {
    match reason {
        "rule" => "rule_match",
        "affinity" => "affinity",
        "failover" => "strategy_first",
        "rotate" => "rotate_turn",
        "weighted" => "weighted_pick",
        "manual" => "manual_pick",
        _ => "strategy_first",
    }
}

pub(super) fn mentions_quota(error: Option<&str>) -> bool {
    error.is_some_and(|text| {
        let text = text.to_ascii_lowercase();
        ["quota", "billing", "credit", "余额", "额度"]
            .iter()
            .any(|word| text.contains(word))
    })
}

/// Reason codes for a member's own try, read from its outcome and status.
fn attempt_code(attempt: &RouteAttempt) -> &'static str {
    let error = attempt.error.as_deref();
    match (attempt.outcome, attempt.status) {
        ("ok", _) => "answered",
        ("failed", Some(429)) if mentions_quota(error) => "quota_exhausted",
        ("rejected", Some(402)) => "quota_exhausted",
        ("failed", Some(429)) => "rate_limited",
        ("failed", None) => "connect_failed",
        ("failed", _) => "upstream_failed",
        ("rejected", Some(401 | 403)) => "auth_failed",
        ("rejected", _) => "upstream_rejected",
        ("skipped", None) => "provider_missing",
        ("skipped", Some(401)) => "key_missing",
        ("skipped", Some(400)) => "protocol_unsupported",
        ("skipped", _) => "credential_unavailable",
        _ => "unknown",
    }
}

fn clip(text: &str) -> String {
    text.chars().take(DETAIL_CHARS).collect()
}

/// Pure: explains every group member for one decision. Candidates come
/// first in plan order (why it was ranked there, then how its try went),
/// then members the plan left out.
pub fn build_trace(
    group: &RoutingGroup,
    plan: &Plan,
    attempts: &[RouteAttempt],
) -> Vec<MemberTrace> {
    let mut trace: Vec<MemberTrace> = plan
        .candidates
        .iter()
        .enumerate()
        .map(|(index, member)| {
            let mut reasons = vec![if index == 0 {
                primary_code(plan.reason)
            } else {
                "fallback"
            }];
            if plan.via.get(index).is_some_and(Option::is_some) {
                reasons.push("nested");
            }
            let attempt = attempts.iter().find(|attempt| attempt.member == *member);
            let (verdict, detail) = match attempt {
                Some(attempt) => {
                    reasons.push(attempt_code(attempt));
                    let verdict = if attempt.outcome == "ok" {
                        "chosen"
                    } else {
                        attempt.outcome
                    };
                    let detail = match (&attempt.error, index) {
                        (Some(error), _) => Some(clip(error)),
                        (None, 0) => Some(clip(&plan.detail)),
                        (None, _) => None,
                    };
                    (verdict, detail)
                }
                None => {
                    reasons.push("not_reached");
                    ("not_reached", (index == 0).then(|| clip(&plan.detail)))
                }
            };
            MemberTrace {
                member: member.clone(),
                rank: u8::try_from(index).ok(),
                verdict,
                reasons,
                detail,
            }
        })
        .collect();
    for member in &group.members {
        let excluded = plan.excluded.iter().any(|item| item.member == *member);
        // An expanded subgroup shows up as its leaves above.
        if plan.candidates.contains(member) || (subgroup_id(member).is_some() && !excluded) {
            continue;
        }
        let (reason, detail) = match plan.excluded.iter().find(|item| item.member == *member) {
            Some(item) => (item.reason, item.detail.as_deref().map(clip)),
            None if group.strategy == Strategy::Manual => {
                ("manual_only", Some("固定分配只用一个成员".to_string()))
            }
            None => ("not_planned", None),
        };
        trace.push(MemberTrace {
            member: member.clone(),
            rank: None,
            verdict: "excluded",
            reasons: vec![reason],
            detail,
        });
    }
    // Exclusions from inside subgroups, which are not members here.
    for item in &plan.excluded {
        if !trace.iter().any(|row| row.member == item.member) {
            trace.push(MemberTrace {
                member: item.member.clone(),
                rank: None,
                verdict: "excluded",
                reasons: vec![item.reason],
                detail: item.detail.as_deref().map(clip),
            });
        }
    }
    trace
}

fn subgroup_id(member: &str) -> Option<&str> {
    member.strip_prefix(GROUP_PREFIX)
}

/// Checks the nesting across a whole set of groups: every `group/<id>`
/// member exists, there is no cycle, and no chain is deeper than
/// [`MAX_NEST_DEPTH`].
pub fn validate_nesting(groups: &[RoutingGroup]) -> Result<(), String> {
    fn depth<'a>(
        groups: &'a [RoutingGroup],
        group: &'a RoutingGroup,
        path: &mut Vec<&'a str>,
    ) -> Result<usize, String> {
        if path.contains(&group.id.as_str()) {
            path.push(&group.id);
            return Err(format!("路由组嵌套成环：{}。", path.join(" → ")));
        }
        path.push(&group.id);
        let mut deepest = 0;
        for id in group.members.iter().filter_map(|m| subgroup_id(m)) {
            let Some(sub) = groups.iter().find(|g| g.id == id) else {
                return Err(format!("成员「group/{id}」指向的路由组不存在。"));
            };
            deepest = deepest.max(1 + depth(groups, sub, path)?);
        }
        path.pop();
        Ok(deepest)
    }
    for group in groups {
        if depth(groups, group, &mut Vec::new())? > MAX_NEST_DEPTH {
            return Err(format!(
                "路由组「{}」嵌套超过 {MAX_NEST_DEPTH} 层。",
                group.name
            ));
        }
    }
    Ok(())
}

pub fn validate_group(group: &RoutingGroup, provider_ids: &[String]) -> Result<(), String> {
    if !valid_id(&group.id) {
        return Err("路由组 ID 只能用 1–32 个小写字母、数字或连字符。".to_string());
    }
    let name = group.name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("路由组名称需要 1–64 个字符。".to_string());
    }
    if group.members.is_empty() || group.members.len() > MAX_MEMBERS {
        return Err(format!("路由组需要 1–{MAX_MEMBERS} 个成员。"));
    }
    for (index, member) in group.members.iter().enumerate() {
        if group.members[..index].contains(member) {
            return Err(format!("成员「{member}」重复。"));
        }
        if let Some(id) = subgroup_id(member) {
            if !valid_id(id) {
                return Err(format!("成员「{member}」不是有效的路由组。"));
            }
            if id == group.id {
                return Err("路由组不能包含自己。".to_string());
            }
            continue;
        }
        let Some((provider, model)) = member.split_once('/') else {
            return Err(format!("成员「{member}」需要写成 供应商ID/模型。"));
        };
        if model.is_empty()
            || member.len() > 160
            || member.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(format!("成员「{member}」无效。"));
        }
        if !provider_ids.iter().any(|id| id == provider) {
            return Err(format!("成员「{member}」的供应商不存在。"));
        }
    }
    match (&group.strategy, &group.manual_member) {
        (Strategy::Manual, Some(member)) if group.members.contains(member) => {}
        (Strategy::Manual, _) => return Err("固定分配需要选一个组内成员。".to_string()),
        _ => {}
    }
    for (member, weight) in &group.weights {
        if !group.members.contains(member) {
            return Err(format!("权重指向的成员「{member}」不在组内。"));
        }
        if !(1..=MAX_WEIGHT).contains(weight) {
            return Err(format!(
                "成员「{member}」的权重需要在 1–{MAX_WEIGHT} 之间。"
            ));
        }
    }
    if group.rules.len() > MAX_RULES {
        return Err(format!("每个路由组最多 {MAX_RULES} 条规则。"));
    }
    for rule in &group.rules {
        if !group.members.contains(&rule.member) {
            return Err(format!("规则指向的成员「{}」不在组内。", rule.member));
        }
        rule.condition.validate()?;
    }
    if group.session_ttl_secs > MAX_TTL_SECS {
        return Err("会话保持时长最多 7 天。".to_string());
    }
    Ok(())
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    schema_version: u8,
    groups: Vec<RoutingGroup>,
}

pub struct Router {
    path: PathBuf,
    groups: RwLock<Vec<RoutingGroup>>,
    affinity: Mutex<HashMap<(String, String), (String, Instant)>>,
    rotation: Mutex<HashMap<String, usize>>,
    /// Member → (cooling until, consecutive failures).
    cooldown: Mutex<HashMap<String, (Instant, u32)>>,
    decisions: Mutex<VecDeque<RouteDecision>>,
    pub load_error: Option<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Router {
    pub fn new(dir: &Path) -> Self {
        let path = dir.join(STORE_FILE);
        let (groups, load_error) = match load(&path) {
            Ok(groups) => (groups, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        Self {
            path,
            groups: RwLock::new(groups),
            affinity: Mutex::new(HashMap::new()),
            rotation: Mutex::new(HashMap::new()),
            cooldown: Mutex::new(HashMap::new()),
            decisions: Mutex::new(VecDeque::new()),
            load_error,
        }
    }

    pub fn groups(&self) -> Vec<RoutingGroup> {
        self.groups
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn enabled_group(&self, id: &str) -> Option<RoutingGroup> {
        self.groups()
            .into_iter()
            .find(|group| group.id == id && group.enabled)
    }

    fn save(&self, next: Vec<RoutingGroup>) -> Result<Vec<RoutingGroup>, String> {
        let body = serde_json::to_vec_pretty(&StoreFile {
            schema_version: STORE_SCHEMA_VERSION,
            groups: next.clone(),
        })
        .map_err(|error| error.to_string())?;
        write_json_atomic(&self.path, &body).map_err(|error| format!("写入路由组失败：{error}"))?;
        Ok(next)
    }

    pub fn upsert(
        &self,
        group: RoutingGroup,
        provider_ids: &[String],
    ) -> Result<Vec<RoutingGroup>, String> {
        validate_group(&group, provider_ids)?;
        let mut groups = self
            .groups
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut next = groups.clone();
        if let Some(existing) = next.iter_mut().find(|item| item.id == group.id) {
            *existing = group;
        } else if next.len() >= MAX_GROUPS {
            return Err(format!("最多添加 {MAX_GROUPS} 个路由组。"));
        } else {
            next.push(group);
        }
        validate_nesting(&next)?;
        *groups = self.save(next)?;
        Ok(groups.clone())
    }

    pub fn delete(&self, id: &str) -> Result<Vec<RoutingGroup>, String> {
        let mut groups = self
            .groups
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let next: Vec<RoutingGroup> = groups.iter().filter(|g| g.id != id).cloned().collect();
        if next.len() == groups.len() {
            return Err("找不到这个路由组。".to_string());
        }
        if let Some(parent) = next
            .iter()
            .find(|g| g.members.iter().any(|m| subgroup_id(m) == Some(id)))
        {
            return Err(format!(
                "路由组「{}」还把它当成员，先从那里移除。",
                parent.name
            ));
        }
        *groups = self.save(next)?;
        lock(&self.affinity).retain(|(group, _), _| group != id);
        lock(&self.rotation).remove(id);
        Ok(groups.clone())
    }

    /// Picks for `group` and expands `group/<id>` members into their own
    /// plans in place. The session pins a leaf: it beats the strategy at any
    /// level, but never a rule of the requested group.
    pub fn plan(&self, group: &RoutingGroup, features: &Features, session: Option<&str>) -> Plan {
        let affinity = session
            .filter(|_| group.session_ttl_secs > 0)
            .and_then(|session| {
                let mut map = lock(&self.affinity);
                let key = (group.id.clone(), session.to_string());
                match map.get(&key) {
                    Some((member, expires)) if *expires > Instant::now() => Some(member.clone()),
                    Some(_) => {
                        map.remove(&key);
                        None
                    }
                    None => None,
                }
            });
        // A dry run first: when the session pin decides, no rotation or
        // weighted turn is spent at any level, so pinned sessions do not
        // skew the shares of new ones.
        let mut plan = self.plan_level(
            group,
            features,
            affinity.as_deref(),
            &mut vec![group.id.clone()],
            false,
        );
        let pinned = affinity.clone().filter(|leaf| {
            !plan.is_rule()
                && (plan.reason == "affinity" || plan.candidates.iter().any(|m| m == leaf))
        });
        let Some(leaf) = pinned else {
            let mut plan = self.plan_level(
                group,
                features,
                affinity.as_deref(),
                &mut vec![group.id.clone()],
                true,
            );
            self.demote_cooling(&mut plan);
            return plan;
        };
        if plan.reason != "affinity" {
            if let Some(index) = plan.candidates.iter().position(|m| *m == leaf) {
                let member = plan.candidates.remove(index);
                let via = plan.via.remove(index);
                plan.detail = match &via {
                    Some(sub) => format!("同一会话沿用上次成员（经 group/{sub}）"),
                    None => "同一会话沿用上次成员".to_string(),
                };
                plan.candidates.insert(0, member);
                plan.via.insert(0, via);
                plan.reason = "affinity";
            }
        }
        self.demote_cooling(&mut plan);
        plan
    }

    /// Moves cooling members behind the rest, keeping both orders; they stay
    /// as a last resort rather than being dropped.
    fn demote_cooling(&self, plan: &mut Plan) {
        let now = Instant::now();
        let cooling: Vec<bool> = {
            let map = lock(&self.cooldown);
            plan.candidates
                .iter()
                .map(|m| map.get(m).is_some_and(|(until, _)| *until > now))
                .collect()
        };
        if !cooling.contains(&true) || !cooling.contains(&false) {
            return;
        }
        let first_cooling = cooling[0].then(|| plan.candidates[0].clone());
        let (mut candidates, mut via, mut tail, mut tail_via) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for ((member, from), cool) in plan
            .candidates
            .drain(..)
            .zip(plan.via.drain(..))
            .zip(cooling)
        {
            if cool {
                tail.push(member);
                tail_via.push(from);
            } else {
                candidates.push(member);
                via.push(from);
            }
        }
        candidates.extend(tail);
        via.extend(tail_via);
        plan.candidates = candidates;
        plan.via = via;
        if let Some(member) = first_cooling {
            plan.detail = format!("{}；{member} 冷却中，已后移", plan.detail);
        }
    }

    /// Called after a retryable failure of `member`.
    pub fn cool(&self, member: &str) {
        let mut map = lock(&self.cooldown);
        if map.len() >= MAX_AFFINITY_ENTRIES {
            map.clear();
        }
        let strikes = map.get(member).map_or(0, |(_, strikes)| *strikes) + 1;
        let secs = COOLDOWN_BASE_SECS
            .saturating_mul(1 << (strikes - 1).min(16))
            .min(COOLDOWN_MAX_SECS);
        map.insert(
            member.to_string(),
            (Instant::now() + Duration::from_secs(secs), strikes),
        );
    }

    /// Called after `member` answered; ends its cooldown.
    pub fn recover(&self, member: &str) {
        lock(&self.cooldown).remove(member);
    }

    #[cfg(test)]
    fn cooldown_secs(&self, member: &str) -> Option<u64> {
        lock(&self.cooldown)
            .get(member)
            .map(|(until, _)| until.saturating_duration_since(Instant::now()).as_secs() + 1)
    }

    fn plan_level(
        &self,
        group: &RoutingGroup,
        features: &Features,
        affinity: Option<&str>,
        path: &mut Vec<String>,
        advance: bool,
    ) -> Plan {
        // A turn is spent only when the strategy picked the primary, so
        // pinned sessions and rule hits do not skew rotation or weights.
        let plan = {
            let mut counters = lock(&self.rotation);
            let counter = counters.entry(group.id.clone()).or_insert(0);
            let plan = plan_members(group, features, affinity, *counter);
            if advance && matches!(plan.reason, "rotate" | "weighted") {
                *counter = counter.wrapping_add(1);
            }
            plan
        };
        if !plan.candidates.iter().any(|m| subgroup_id(m).is_some()) {
            return plan;
        }
        let mut expanded = Plan {
            candidates: Vec::new(),
            via: Vec::new(),
            reason: plan.reason,
            detail: plan.detail,
            excluded: plan.excluded,
        };
        for (index, member) in plan.candidates.into_iter().enumerate() {
            let Some(id) = subgroup_id(&member) else {
                if !expanded.candidates.contains(&member) {
                    expanded.candidates.push(member);
                    expanded.via.push(None);
                }
                continue;
            };
            // Disabled, missing, cyclic or too deep subgroups are skipped.
            let Some(sub) = self
                .enabled_group(id)
                .filter(|_| path.len() <= MAX_NEST_DEPTH && !path.iter().any(|p| p == id))
            else {
                expanded.excluded.push(Exclusion {
                    member: member.clone(),
                    reason: "disabled",
                    detail: Some("子路由组未启用或嵌套过深".to_string()),
                });
                continue;
            };
            path.push(sub.id.clone());
            // Only the primary subgroup spends a turn; fallbacks that are
            // listed but may never be reached keep their rotation.
            let inner = self.plan_level(&sub, features, None, path, advance && index == 0);
            path.pop();
            if index == 0 && inner.is_rule() && !expanded.is_rule() {
                expanded.reason = "rule";
                expanded.detail = format!("{}：{}", sub.name, inner.detail);
            }
            if inner.candidates.is_empty() {
                let gone: Vec<&str> = inner
                    .excluded
                    .iter()
                    .map(|item| item.member.as_str())
                    .collect();
                expanded.excluded.push(Exclusion {
                    member: member.clone(),
                    reason: "nested",
                    detail: Some(format!("子路由组没有可用成员（{}）", gone.join("、"))),
                });
            }
            expanded.excluded.extend(inner.excluded);
            for (leaf, via) in inner.candidates.into_iter().zip(inner.via) {
                if !expanded.candidates.contains(&leaf) {
                    expanded.candidates.push(leaf);
                    expanded.via.push(via.or_else(|| Some(sub.id.clone())));
                }
            }
        }
        expanded
    }

    /// Pins the session to the member that actually answered.
    pub fn remember(&self, group: &RoutingGroup, session: Option<&str>, member: &str) {
        let Some(session) = session.filter(|_| group.session_ttl_secs > 0) else {
            return;
        };
        let now = Instant::now();
        let mut map = lock(&self.affinity);
        if map.len() >= MAX_AFFINITY_ENTRIES {
            map.retain(|_, (_, expires)| *expires > now);
            if map.len() >= MAX_AFFINITY_ENTRIES {
                map.clear();
            }
        }
        map.insert(
            (group.id.clone(), session.to_string()),
            (
                member.to_string(),
                now + Duration::from_secs(group.session_ttl_secs),
            ),
        );
    }

    pub fn record(&self, decision: RouteDecision) {
        let mut decisions = lock(&self.decisions);
        if decisions.len() >= MAX_DECISIONS {
            decisions.pop_front();
        }
        decisions.push_back(decision);
    }

    /// Members cooling down right now, longest remaining first.
    pub fn cooling(&self) -> Vec<CoolingMember> {
        let now = Instant::now();
        let mut members: Vec<CoolingMember> = lock(&self.cooldown)
            .iter()
            .filter(|(_, (until, _))| *until > now)
            .map(|(member, (until, strikes))| CoolingMember {
                member: member.clone(),
                remaining_secs: until.saturating_duration_since(now).as_secs() + 1,
                failures: *strikes,
            })
            .collect();
        members.sort_by(|a, b| {
            b.remaining_secs
                .cmp(&a.remaining_secs)
                .then_with(|| a.member.cmp(&b.member))
        });
        members
    }

    pub fn recent(&self, limit: usize) -> Vec<RouteDecision> {
        lock(&self.decisions)
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }
}

fn load(path: &Path) -> Result<Vec<RoutingGroup>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取路由组失败：{error}")),
    };
    let file: StoreFile =
        serde_json::from_str(&text).map_err(|error| format!("路由组文件已损坏：{error}"))?;
    if file.schema_version != STORE_SCHEMA_VERSION {
        return Err(format!("路由组文件版本 {} 不受支持。", file.schema_version));
    }
    Ok(file.groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn group(strategy: Strategy, rules: Vec<RoutingRule>) -> RoutingGroup {
        RoutingGroup {
            id: "coding".into(),
            name: "Coding".into(),
            strategy,
            members: vec!["a/m1".into(), "b/m2".into(), "c/m3".into()],
            manual_member: (strategy == Strategy::Manual).then(|| "b/m2".into()),
            rules,
            weights: BTreeMap::new(),
            session_ttl_secs: 60,
            enabled: true,
        }
    }

    fn rule(condition: RuleCondition, member: &str) -> RoutingRule {
        RoutingRule {
            condition,
            member: member.into(),
        }
    }

    #[test]
    fn strategies_order_candidates() {
        let none = Features::default();
        let failover = plan_members(&group(Strategy::Failover, vec![]), &none, None, 0);
        assert_eq!(failover.candidates, ["a/m1", "b/m2", "c/m3"]);
        assert_eq!(failover.reason, "failover");
        let rotate = plan_members(&group(Strategy::Rotate, vec![]), &none, None, 4);
        assert_eq!(rotate.candidates, ["b/m2", "c/m3", "a/m1"]);
        let manual = plan_members(&group(Strategy::Manual, vec![]), &none, None, 0);
        assert_eq!(manual.candidates, ["b/m2"]);
        let pinned = plan_members(&group(Strategy::Failover, vec![]), &none, Some("c/m3"), 0);
        assert_eq!(pinned.candidates, ["c/m3", "a/m1", "b/m2"]);
        assert_eq!(pinned.reason, "affinity");
        let stale = plan_members(&group(Strategy::Failover, vec![]), &none, Some("gone/x"), 0);
        assert_eq!(stale.reason, "failover");
    }

    fn tried(
        member: &str,
        outcome: &'static str,
        status: Option<u16>,
        error: Option<&str>,
    ) -> RouteAttempt {
        RouteAttempt {
            member: member.into(),
            outcome,
            status,
            error: error.map(str::to_string),
        }
    }

    fn row(trace: &[MemberTrace], member: &str) -> (Option<u8>, &'static str, Vec<&'static str>) {
        let item = trace.iter().find(|item| item.member == member).unwrap();
        (item.rank, item.verdict, item.reasons.clone())
    }

    #[test]
    fn trace_explains_every_member_of_a_failover() {
        let g = group(Strategy::Failover, vec![]);
        let plan = plan_members(&g, &Features::default(), None, 0);
        let attempts = [
            tried("a/m1", "failed", Some(429), Some("上游返回 429：slow down")),
            tried("b/m2", "ok", Some(200), None),
        ];
        let trace = build_trace(&g, &plan, &attempts);
        assert_eq!(trace.len(), 3);
        assert_eq!(
            row(&trace, "a/m1"),
            (Some(0), "failed", vec!["strategy_first", "rate_limited"])
        );
        assert_eq!(
            row(&trace, "b/m2"),
            (Some(1), "chosen", vec!["fallback", "answered"])
        );
        assert_eq!(
            row(&trace, "c/m3"),
            (Some(2), "not_reached", vec!["fallback", "not_reached"])
        );
        assert_eq!(trace[0].detail.as_deref(), Some("上游返回 429：slow down"));
    }

    #[test]
    fn trace_names_rule_affinity_quota_and_left_out_members() {
        let g = group(
            Strategy::Failover,
            vec![rule(RuleCondition::HasImage, "c/m3")],
        );
        let image = Features {
            has_image: true,
            ..Features::default()
        };
        let plan = plan_members(&g, &image, None, 0);
        let trace = build_trace(
            &g,
            &plan,
            &[tried(
                "c/m3",
                "failed",
                Some(429),
                Some("insufficient_quota"),
            )],
        );
        assert_eq!(row(&trace, "c/m3").2, ["rule_match", "quota_exhausted"]);
        assert_eq!(trace[0].detail.as_deref(), Some("insufficient_quota"));

        let plan = plan_members(&g, &Features::default(), Some("b/m2"), 0);
        let trace = build_trace(&g, &plan, &[]);
        assert_eq!(
            row(&trace, "b/m2"),
            (Some(0), "not_reached", vec!["affinity", "not_reached"])
        );
        assert_eq!(trace[0].detail.as_deref(), Some("同一会话沿用上次成员"));

        let manual = group(Strategy::Manual, vec![]);
        let plan = plan_members(&manual, &Features::default(), None, 0);
        let trace = build_trace(
            &manual,
            &plan,
            &[tried("b/m2", "skipped", Some(401), Some("没有 key"))],
        );
        assert_eq!(
            row(&trace, "b/m2"),
            (Some(0), "skipped", vec!["manual_pick", "key_missing"])
        );
        assert_eq!(row(&trace, "a/m1"), (None, "excluded", vec!["manual_only"]));

        let mut plan = plan_members(&g, &Features::default(), None, 0);
        plan.candidates.retain(|member| member != "b/m2");
        plan.excluded.push(Exclusion {
            member: "b/m2".into(),
            reason: "cooling_down",
            detail: Some("冷却中".into()),
        });
        let trace = build_trace(&g, &plan, &[tried("a/m1", "rejected", Some(402), None)]);
        assert_eq!(row(&trace, "a/m1").2, ["strategy_first", "quota_exhausted"]);
        assert_eq!(trace.last().unwrap().member, "b/m2");
        assert_eq!(
            row(&trace, "b/m2"),
            (None, "excluded", vec!["cooling_down"])
        );
    }

    #[test]
    fn weighted_round_robin_is_smooth_and_proportional() {
        let picks: Vec<usize> = (0..7)
            .map(|turn| weighted_index(&[5, 1, 1], turn))
            .collect();
        assert_eq!(picks, [0, 0, 1, 0, 2, 0, 0]);
        assert_eq!(weighted_index(&[5, 1, 1], 7), picks[0], "cycle repeats");
        let counts = (0..300).fold([0; 3], |mut acc, turn| {
            acc[weighted_index(&[3, 2, 1], turn)] += 1;
            acc
        });
        assert_eq!(counts, [150, 100, 50]);
        assert_eq!(weighted_index(&[1, 1], 1), 1);
    }

    #[test]
    fn weighted_strategy_falls_back_by_weight() {
        let mut g = group(Strategy::Weighted, vec![]);
        g.weights = BTreeMap::from([("a/m1".into(), 1), ("b/m2".into(), 2), ("c/m3".into(), 5)]);
        let none = Features::default();
        let plan = plan_members(&g, &none, None, 0);
        assert_eq!(plan.candidates, ["c/m3", "b/m2", "a/m1"]);
        assert_eq!(
            (plan.reason, plan.detail.as_str()),
            ("weighted", "加权 5/8")
        );
        let hits = (0..8)
            .filter(|turn| plan_members(&g, &none, None, *turn).candidates[0] == "b/m2")
            .count();
        assert_eq!(hits, 2);
        let pinned = plan_members(&g, &none, Some("a/m1"), 0);
        assert_eq!(pinned.candidates, ["a/m1", "c/m3", "b/m2"]);
        assert_eq!(pinned.reason, "affinity");
    }

    #[test]
    fn body_session_reads_cache_key_and_metadata() {
        assert_eq!(
            body_session(
                &json!({"prompt_cache_key": "conv-1", "metadata": {"user_id": "x_session_y"}})
            ),
            Some("conv-1".into())
        );
        assert_eq!(
            body_session(&json!({"metadata": {"user_id": "user_ab_account_cd_session_5e6f"}})),
            Some("5e6f".into())
        );
        assert_eq!(
            body_session(
                &json!({"metadata": {"user_id": "{\"device_id\":\"d\",\"session_id\":\"s-9\"}"}})
            ),
            Some("s-9".into())
        );
        assert_eq!(
            body_session(&json!({"metadata": {"user_id": "user_only"}})),
            None
        );
        assert_eq!(
            body_session(&json!({"metadata": {"user_id": "{\"device_id\":\"d\"}"}})),
            None
        );
        assert_eq!(body_session(&json!({"prompt_cache_key": "  "})), None);
        assert_eq!(body_session(&json!({"input": "hi"})), None);
        let long = "k".repeat(300);
        assert_eq!(
            body_session(&json!({"prompt_cache_key": long}))
                .unwrap()
                .len(),
            128
        );
    }

    #[test]
    fn features_read_responses_and_chat_bodies() {
        let responses = json!({
            "instructions": "be brief",
            "reasoning": {"effort": "HIGH"},
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": "look"},
                {"type": "input_image", "image_url": "data:image/png;base64,AAAA"}
            ]}]
        });
        let features = Features::extract(&responses, Some("codex"), 600);
        assert!(features.has_image && !features.compact);
        assert_eq!(features.input_chars, "be brief".len() as u64 + 4);
        assert_eq!(features.reasoning_effort.as_deref(), Some("high"));

        let chat = json!({"reasoning_effort": "low", "messages": [
            {"role": "user", "content": "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary"}
        ]});
        let features = Features::extract(&chat, None, 0);
        assert!(features.compact && !features.has_image);
        assert_eq!(features.reasoning_effort.as_deref(), Some("low"));
    }

    #[test]
    fn each_rule_kind_routes_to_its_member() {
        let cases = [
            (
                RuleCondition::HasImage,
                Features {
                    has_image: true,
                    ..Features::default()
                },
            ),
            (
                RuleCondition::InputCharsOver { chars: 100 },
                Features {
                    input_chars: 101,
                    ..Features::default()
                },
            ),
            (
                RuleCondition::ReasoningEffort {
                    efforts: vec!["high".into(), "xhigh".into()],
                },
                Features {
                    reasoning_effort: Some("xhigh".into()),
                    ..Features::default()
                },
            ),
            (
                RuleCondition::Agent {
                    agents: vec!["claude-code".into()],
                },
                Features {
                    agent: Some("claude-code".into()),
                    ..Features::default()
                },
            ),
            (
                RuleCondition::TimeWindow {
                    start: "22:00".into(),
                    end: "06:00".into(),
                },
                Features {
                    local_minutes: 23 * 60,
                    ..Features::default()
                },
            ),
            (
                RuleCondition::Compact,
                Features {
                    compact: true,
                    ..Features::default()
                },
            ),
        ];
        for (condition, hit) in cases {
            let g = group(Strategy::Failover, vec![rule(condition.clone(), "c/m3")]);
            let plan = plan_members(&g, &hit, Some("a/m1"), 0);
            assert_eq!(plan.candidates[0], "c/m3", "{condition:?}");
            assert!(plan.is_rule());
            let noon = Features {
                local_minutes: 12 * 60,
                ..Features::default()
            };
            let miss = plan_members(&g, &noon, None, 0);
            assert_eq!(miss.candidates[0], "a/m1", "{condition:?} must not match");
        }
        let window = RuleCondition::TimeWindow {
            start: "09:00".into(),
            end: "18:00".into(),
        };
        let at = |minutes| Features {
            local_minutes: minutes,
            ..Features::default()
        };
        assert!(window.matches(&at(9 * 60)) && !window.matches(&at(18 * 60)));
    }

    #[test]
    fn validation_rejects_bad_groups() {
        let providers = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert!(validate_group(&group(Strategy::Failover, vec![]), &providers).is_ok());
        let mut bad = group(Strategy::Manual, vec![]);
        bad.manual_member = None;
        assert!(validate_group(&bad, &providers).is_err());
        let mut bad = group(Strategy::Failover, vec![]);
        bad.members.push("a/m1".into());
        assert!(validate_group(&bad, &providers).is_err());
        let mut bad = group(Strategy::Failover, vec![]);
        bad.members[0] = "nobody/m".into();
        assert!(validate_group(&bad, &providers).is_err());
        let bad = group(
            Strategy::Failover,
            vec![rule(RuleCondition::HasImage, "z/outside")],
        );
        assert!(validate_group(&bad, &providers).is_err());
        let bad = group(
            Strategy::Failover,
            vec![rule(
                RuleCondition::TimeWindow {
                    start: "25:00".into(),
                    end: "01:00".into(),
                },
                "a/m1",
            )],
        );
        assert!(validate_group(&bad, &providers).is_err());
        let mut bad = group(Strategy::Weighted, vec![]);
        bad.weights.insert("a/m1".into(), 0);
        assert!(validate_group(&bad, &providers).is_err());
        bad.weights = BTreeMap::from([("z/outside".into(), 3)]);
        assert!(validate_group(&bad, &providers).is_err());
        bad.weights = BTreeMap::from([("a/m1".into(), 100)]);
        assert!(validate_group(&bad, &providers).is_ok());
    }

    fn nested(id: &str, strategy: Strategy, members: &[&str]) -> RoutingGroup {
        RoutingGroup {
            id: id.into(),
            name: id.into(),
            members: members.iter().map(|m| m.to_string()).collect(),
            manual_member: None,
            ..group(strategy, vec![])
        }
    }

    #[test]
    fn fallback_subgroups_keep_their_turn_and_nested_exclusions_surface() {
        let dir = std::env::temp_dir().join(format!("tl-gw-fallback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let providers = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let router = Router::new(&dir);
        let left = nested("left", Strategy::Rotate, &["a/m1", "a/m2"]);
        let right = nested("right", Strategy::Rotate, &["b/m1", "b/m2"]);
        let top = nested("top", Strategy::Rotate, &["group/left", "group/right"]);
        for g in [&left, &right, &top] {
            router.upsert(g.clone(), &providers).unwrap();
        }
        let none = Features::default();
        let firsts: Vec<String> = (0..4)
            .map(|_| router.plan(&top, &none, None).candidates[0].clone())
            .collect();
        assert_eq!(
            firsts,
            ["a/m1", "b/m1", "a/m2", "b/m2"],
            "every leaf gets primary turns"
        );

        let low = nested("low", Strategy::Failover, &["c/m3"]);
        let mid = nested("mid", Strategy::Failover, &["group/low"]);
        let chain = nested("chain", Strategy::Failover, &["group/mid"]);
        for g in [&low, &mid, &chain] {
            router.upsert(g.clone(), &providers).unwrap();
        }
        let mut off = low.clone();
        off.enabled = false;
        router.upsert(off, &providers).unwrap();
        let plan = router.plan(&chain, &none, None);
        assert!(plan.candidates.is_empty());
        let trace = build_trace(&chain, &plan, &[]);
        let row = |member: &str| trace.iter().find(|row| row.member == member).unwrap();
        assert_eq!(row("group/mid").reasons, ["nested"]);
        assert!(row("group/mid")
            .detail
            .as_deref()
            .unwrap()
            .contains("group/low"));
        assert_eq!(row("group/low").reasons, ["disabled"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nesting_validation_rejects_missing_cycles_and_depth() {
        let leaf = |id: &str| nested(id, Strategy::Failover, &["a/m1"]);
        let ok = [
            nested("top", Strategy::Failover, &["group/mid", "b/m2"]),
            nested("mid", Strategy::Rotate, &["group/low"]),
            leaf("low"),
        ];
        assert!(validate_nesting(&ok).is_ok());
        let missing = [nested("top", Strategy::Failover, &["group/none"])];
        assert!(validate_nesting(&missing).unwrap_err().contains("不存在"));
        let cycle = [
            nested("x", Strategy::Failover, &["group/y"]),
            nested("y", Strategy::Failover, &["group/x"]),
        ];
        assert!(validate_nesting(&cycle).unwrap_err().contains("x → y → x"));
        let deep = [
            nested("l0", Strategy::Failover, &["group/l1"]),
            nested("l1", Strategy::Failover, &["group/l2"]),
            nested("l2", Strategy::Failover, &["group/l3"]),
            leaf("l3"),
        ];
        assert!(validate_nesting(&deep).unwrap_err().contains("嵌套超过"));
        let providers = vec!["a".to_string(), "b".to_string()];
        let own = nested("top", Strategy::Failover, &["group/top"]);
        assert!(validate_group(&own, &providers).is_err());
        assert!(validate_group(&ok[0], &providers).is_ok());
    }

    #[test]
    fn router_expands_subgroups_and_pins_nested_leaves() {
        let dir = std::env::temp_dir().join(format!("tl-gw-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let providers = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let router = Router::new(&dir);
        let pool = nested("pool", Strategy::Rotate, &["b/m2", "c/m3"]);
        let top = nested("top", Strategy::Failover, &["group/pool", "a/m1", "c/m3"]);
        assert!(
            router.upsert(top.clone(), &providers).is_err(),
            "pool missing"
        );
        router.upsert(pool.clone(), &providers).unwrap();
        router.upsert(top.clone(), &providers).unwrap();
        assert!(router.delete("pool").unwrap_err().contains("top"));

        let none = Features::default();
        let first = router.plan(&top, &none, Some("s1"));
        assert_eq!(first.candidates, ["b/m2", "c/m3", "a/m1"], "deduped leaves");
        let trace = build_trace(&top, &first, &[]);
        assert_eq!(trace.len(), 3, "the subgroup shows as its leaves");
        assert_eq!(
            trace[0].reasons,
            ["strategy_first", "nested", "not_reached"]
        );
        assert_eq!(
            first.via,
            [Some("pool".to_string()), Some("pool".to_string()), None]
        );
        assert_eq!(first.reason, "failover");
        let second = router.plan(&top, &none, None);
        assert_eq!(second.candidates[0], "c/m3", "subgroup keeps rotating");

        router.remember(&top, Some("s1"), "b/m2");
        for _ in 0..3 {
            let plan = router.plan(&top, &none, Some("s1"));
            assert_eq!(plan.candidates[0], "b/m2");
            assert_eq!(plan.reason, "affinity");
            assert!(plan.detail.contains("group/pool"));
        }
        assert_eq!(
            router.plan(&top, &none, None).candidates[0],
            "b/m2",
            "pinned turns leave the subgroup's rotation alone"
        );

        let mut ruled = pool.clone();
        ruled.rules = vec![rule(RuleCondition::HasImage, "c/m3")];
        router.upsert(ruled, &providers).unwrap();
        let image = Features {
            has_image: true,
            ..Features::default()
        };
        let plan = router.plan(&top, &image, None);
        assert_eq!((plan.candidates[0].as_str(), plan.reason), ("c/m3", "rule"));

        let mut off = pool.clone();
        off.enabled = false;
        router.upsert(off, &providers).unwrap();
        let skipped = router.plan(&top, &none, None);
        assert_eq!(skipped.candidates, ["a/m1", "c/m3"]);
        let trace = build_trace(&top, &skipped, &[]);
        let pool_row = trace.iter().find(|row| row.member == "group/pool").unwrap();
        assert_eq!(
            (pool_row.verdict, pool_row.reasons.as_slice()),
            ("excluded", ["disabled"].as_slice())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_members_cool_down_behind_the_rest() {
        let dir = std::env::temp_dir().join(format!("tl-gw-cool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let router = Router::new(&dir);
        let g = group(Strategy::Failover, vec![]);
        let none = Features::default();
        router.cool("a/m1");
        let plan = router.plan(&g, &none, None);
        assert_eq!(plan.candidates, ["b/m2", "c/m3", "a/m1"]);
        assert!(plan.detail.contains("a/m1 冷却中"));
        assert_eq!(router.cooldown_secs("a/m1"), Some(30));
        router.cool("a/m1");
        assert_eq!(router.cooldown_secs("a/m1"), Some(60));
        for _ in 0..10 {
            router.cool("a/m1");
        }
        assert_eq!(router.cooldown_secs("a/m1"), Some(300));

        router.cool("c/m3");
        assert_eq!(
            router.plan(&g, &none, None).candidates,
            ["b/m2", "a/m1", "c/m3"]
        );
        router.cool("b/m2");
        let all = router.plan(&g, &none, None);
        assert_eq!(
            all.candidates,
            ["a/m1", "b/m2", "c/m3"],
            "all cooling: order kept"
        );
        let cooling = router.cooling();
        assert_eq!(
            cooling
                .iter()
                .map(|c| c.member.as_str())
                .collect::<Vec<_>>(),
            ["a/m1", "b/m2", "c/m3"]
        );
        assert_eq!((cooling[0].remaining_secs, cooling[0].failures), (300, 12));
        router.recover("a/m1");
        router.recover("c/m3");
        assert_eq!(router.cooling().len(), 1);
        assert_eq!(
            router.plan(&g, &none, None).candidates,
            ["a/m1", "c/m3", "b/m2"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn router_persists_and_keeps_affinity_with_ttl() {
        let dir = std::env::temp_dir().join(format!("tl-gw-routing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let providers = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let router = Router::new(&dir);
        let mut g = group(Strategy::Rotate, vec![]);
        router.upsert(g.clone(), &providers).unwrap();
        assert_eq!(Router::new(&dir).groups(), vec![g.clone()]);

        let none = Features::default();
        let first = router.plan(&g, &none, Some("s1")).candidates[0].clone();
        router.remember(&g, Some("s1"), &first);
        for _ in 0..3 {
            let plan = router.plan(&g, &none, Some("s1"));
            assert_eq!(
                (plan.candidates[0].as_str(), plan.reason),
                (first.as_str(), "affinity")
            );
        }
        let a = router.plan(&g, &none, None).candidates[0].clone();
        let b = router.plan(&g, &none, None).candidates[0].clone();
        assert_ne!(a, b, "rotation without a session");

        let mut weighted = g.clone();
        weighted.id = "split".into();
        weighted.strategy = Strategy::Weighted;
        weighted.weights = BTreeMap::from([("a/m1".into(), 2)]);
        let mut firsts = Vec::new();
        for session in 0..4 {
            let session = format!("w{session}");
            let first = router.plan(&weighted, &none, Some(&session)).candidates[0].clone();
            router.remember(&weighted, Some(&session), &first);
            for _ in 0..2 {
                assert_eq!(
                    router.plan(&weighted, &none, Some(&session)).reason,
                    "affinity"
                );
            }
            firsts.push(first);
        }
        assert_eq!(
            firsts,
            ["a/m1", "b/m2", "c/m3", "a/m1"],
            "pinned turns do not consume weighted slots"
        );

        g.session_ttl_secs = 0;
        router.remember(&g, Some("s2"), "c/m3");
        assert_ne!(router.plan(&g, &none, Some("s2")).reason, "affinity");

        router.delete("coding").unwrap();
        assert!(Router::new(&dir).groups().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
