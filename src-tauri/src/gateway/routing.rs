//! Routing groups (T10.267, U-91): several `provider/model` members behind one
//! virtual model `group/<id>`. Members are picked by deterministic rules,
//! then session affinity, then the group strategy; no model is asked to
//! classify intent. Groups live in `routing-v1.json`; decisions are kept in a
//! small in-memory ring for the UI.

use std::collections::{HashMap, VecDeque};
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
const MAX_SCAN_DEPTH: usize = 64;
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
    /// `rule` | `affinity` | `failover` | `rotate` | `manual`
    pub reason: &'static str,
    pub detail: String,
    pub chosen: Option<String>,
    pub attempts: Vec<RouteAttempt>,
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
    pub candidates: Vec<String>,
    pub reason: &'static str,
    pub detail: String,
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
    };
    Plan {
        candidates,
        reason,
        detail,
    }
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
        if group.members[..index].contains(member) {
            return Err(format!("成员「{member}」重复。"));
        }
    }
    match (&group.strategy, &group.manual_member) {
        (Strategy::Manual, Some(member)) if group.members.contains(member) => {}
        (Strategy::Manual, _) => return Err("固定分配需要选一个组内成员。".to_string()),
        _ => {}
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
        *groups = self.save(next)?;
        lock(&self.affinity).retain(|(group, _), _| group != id);
        lock(&self.rotation).remove(id);
        Ok(groups.clone())
    }

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
        let rotation = if group.strategy == Strategy::Rotate {
            let mut counters = lock(&self.rotation);
            let counter = counters.entry(group.id.clone()).or_insert(0);
            let current = *counter;
            *counter = counter.wrapping_add(1);
            current
        } else {
            0
        };
        plan_members(group, features, affinity.as_deref(), rotation)
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

        g.session_ttl_secs = 0;
        router.remember(&g, Some("s2"), "c/m3");
        assert_ne!(router.plan(&g, &none, Some("s2")).reason, "affinity");

        router.delete("coding").unwrap();
        assert!(Router::new(&dir).groups().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
