//! Experimental coding-plan usage endpoints (ADR-018 U-109).
//!
//! None of these endpoints has public vendor documentation. URLs and field
//! names were inferred from public client behavior, so every parser accepts
//! only the exact shapes pinned by the anonymized fixture and rejects anything
//! out of range or missing instead of guessing. See
//! `docs/design/quota-source-compliance.md` for the sourcing rules these
//! endpoints are allowed to operate under.

use chrono::{DateTime, Duration, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlanVendor {
    ZhipuGlm,
    Minimax,
    KimiCode,
}

impl PlanVendor {
    pub(crate) const ALL: [PlanVendor; 3] = [Self::ZhipuGlm, Self::Minimax, Self::KimiCode];

    pub(crate) fn provider_id(self) -> &'static str {
        match self {
            Self::ZhipuGlm => "zhipu-glm-plan",
            Self::Minimax => "minimax-plan",
            Self::KimiCode => "kimi-code-plan",
        }
    }

    pub(crate) fn from_provider_id(provider_id: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|vendor| vendor.provider_id() == provider_id)
    }

    pub(crate) fn display_name(self) -> &'static str {
        match self {
            Self::ZhipuGlm => "智谱 GLM 套餐",
            Self::Minimax => "MiniMax 套餐",
            Self::KimiCode => "Kimi Code 套餐",
        }
    }

    pub(crate) fn file_slug(self) -> &'static str {
        match self {
            Self::ZhipuGlm => "zhipu-glm",
            Self::Minimax => "minimax",
            Self::KimiCode => "kimi-code",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PlanEndpoint {
    pub vendor: PlanVendor,
    /// Gateway provider base URLs on this host reuse their `provider:<id>` key.
    pub host: &'static str,
    pub url: &'static str,
}

// Inferred, undocumented: magpie 0.1.810 strings
// `https://open.bigmodel.cn/api/monitor/usage/quota/limit`,
// `https://api.z.ai/api/monitor/usage/quota/limit`, `/v1/token_plan/remains`
// with `api.minimaxi.com` / `api.minimax.io`, and `https://api.kimi.com/coding`
// with `/coding/usages`.
pub(crate) const PLAN_ENDPOINTS: [PlanEndpoint; 5] = [
    PlanEndpoint {
        vendor: PlanVendor::ZhipuGlm,
        host: "open.bigmodel.cn",
        url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    },
    PlanEndpoint {
        vendor: PlanVendor::ZhipuGlm,
        host: "api.z.ai",
        url: "https://api.z.ai/api/monitor/usage/quota/limit",
    },
    PlanEndpoint {
        vendor: PlanVendor::Minimax,
        host: "api.minimaxi.com",
        url: "https://api.minimaxi.com/v1/token_plan/remains",
    },
    PlanEndpoint {
        vendor: PlanVendor::Minimax,
        host: "api.minimax.io",
        url: "https://api.minimax.io/v1/token_plan/remains",
    },
    PlanEndpoint {
        vendor: PlanVendor::KimiCode,
        host: "api.kimi.com",
        url: "https://api.kimi.com/coding/v1/usages",
    },
];

/// Matches a gateway provider's HTTPS base URL to a plan host of `vendor`.
pub(crate) fn plan_endpoint_for_base_url(
    vendor: PlanVendor,
    base_url: &str,
) -> Option<PlanEndpoint> {
    let url = Url::parse(base_url).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if url.port().is_some_and(|port| port != 443) {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    PLAN_ENDPOINTS
        .iter()
        .copied()
        .find(|endpoint| endpoint.vendor == vendor && endpoint.host == host)
}

/// The plan allowlist: exact HTTPS URL equality with a fixed endpoint.
pub(crate) fn plan_url_allowed(url: &Url) -> bool {
    PLAN_ENDPOINTS
        .iter()
        .any(|endpoint| Url::parse(endpoint.url).is_ok_and(|allowed| &allowed == url))
}

const MAX_ENTRIES: usize = 16;
const MAX_WINDOWS: usize = 16;
const MAX_WINDOW_MINUTES: u64 = 31 * 24 * 60;
const MAX_RESET_PAST_SECONDS: i64 = 24 * 60 * 60;
const MAX_RESET_FUTURE_SECONDS: i64 = 32 * 24 * 60 * 60;
const MAX_MODEL_NAME_BYTES: usize = 40;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PlanWindow {
    pub window_id: String,
    pub label: String,
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<DateTime<Utc>>,
}

fn percent(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    (number.is_finite() && (0.0..=100.0).contains(&number)).then_some(number)
}

fn amount(value: &Value) -> Option<f64> {
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    (number.is_finite() && number >= 0.0).then_some(number)
}

fn reset_in_range(at: DateTime<Utc>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    (at >= now - Duration::seconds(MAX_RESET_PAST_SECONDS)
        && at <= now + Duration::seconds(MAX_RESET_FUTURE_SECONDS))
    .then_some(at)
}

/// Optional epoch-millisecond timestamp: absent or 0 means "not given";
/// anything else must be a plausible reset time.
fn optional_epoch_ms(
    value: Option<&Value>,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let millis = value.as_i64().ok_or(())?;
            if millis == 0 {
                return Ok(None);
            }
            let at = DateTime::from_timestamp_millis(millis).ok_or(())?;
            reset_in_range(at, now).map(Some).ok_or(())
        }
    }
}

fn optional_rfc3339(
    value: Option<&Value>,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => {
            let at = DateTime::parse_from_rfc3339(text)
                .map_err(|_| ())?
                .with_timezone(&Utc);
            reset_in_range(at, now).map(Some).ok_or(())
        }
        Some(_) => Err(()),
    }
}

fn valid_minutes(minutes: u64) -> Option<u64> {
    (1..=MAX_WINDOW_MINUTES)
        .contains(&minutes)
        .then_some(minutes)
}

fn minutes_between_ms(start: Option<&Value>, end: Option<&Value>) -> Option<u64> {
    let start = start?.as_i64()?;
    let end = end?.as_i64()?;
    let minutes = end.checked_sub(start)? / 60_000;
    valid_minutes(u64::try_from(minutes).ok()?)
}

/// Same wording as the desktop duration labels, so readers that relabel by
/// `windowMinutes` keep the producer's text instead of doubling it.
fn window_label(minutes: Option<u64>, fallback: &str) -> String {
    match minutes {
        Some(10_080) => "每周额度".to_string(),
        Some(1_440) => "每日额度".to_string(),
        Some(minutes) if minutes % 1_440 == 0 => format!("{} 天额度", minutes / 1_440),
        Some(minutes) if minutes % 60 == 0 => format!("{} 小时额度", minutes / 60),
        Some(minutes) => format!("{minutes} 分钟额度"),
        None => fallback.to_string(),
    }
}

fn push_unique(windows: &mut Vec<PlanWindow>, window: PlanWindow) -> Result<(), ()> {
    if windows.len() >= MAX_WINDOWS || windows.iter().any(|w| w.window_id == window.window_id) {
        return Err(());
    }
    windows.push(window);
    Ok(())
}

pub(crate) fn parse_plan_response(
    vendor: PlanVendor,
    root: &Value,
    now: DateTime<Utc>,
) -> Result<Vec<PlanWindow>, ()> {
    if !root.is_object() {
        return Err(());
    }
    let windows = match vendor {
        PlanVendor::ZhipuGlm => parse_zhipu(root, now)?,
        PlanVendor::Minimax => parse_minimax(root, now)?,
        PlanVendor::KimiCode => parse_kimi(root, now)?,
    };
    if windows.is_empty() {
        return Err(());
    }
    Ok(windows)
}

/// `{success, code, data: {limits: [{type, unit, number, percentage, nextResetTime}]}}`.
/// Only `TOKENS_LIMIT` entries are token-plan windows; other types are skipped.
fn parse_zhipu(root: &Value, now: DateTime<Utc>) -> Result<Vec<PlanWindow>, ()> {
    if root.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(());
    }
    if let Some(code) = root.get("code") {
        if code.as_i64() != Some(200) {
            return Err(());
        }
    }
    let limits = root
        .pointer("/data/limits")
        .and_then(Value::as_array)
        .ok_or(())?;
    if limits.is_empty() || limits.len() > MAX_ENTRIES {
        return Err(());
    }
    let mut windows = Vec::new();
    for limit in limits {
        if limit.get("type").and_then(Value::as_str) != Some("TOKENS_LIMIT") {
            continue;
        }
        let used_percent = limit.get("percentage").and_then(percent).ok_or(())?;
        let unit = limit.get("unit").and_then(Value::as_u64);
        let number = limit.get("number").and_then(Value::as_u64);
        // Inferred unit codes: 1 = day, 3 = hour, 5 = minute. Unknown codes
        // keep the window but leave its length unknown.
        let window_minutes = match (unit, number) {
            (Some(1), Some(n)) => n.checked_mul(1_440).and_then(valid_minutes),
            (Some(3), Some(n)) => n.checked_mul(60).and_then(valid_minutes),
            (Some(5), Some(n)) => valid_minutes(n),
            _ => None,
        };
        let resets_at = optional_epoch_ms(limit.get("nextResetTime"), now)?;
        let window_id = match (unit, number) {
            (Some(unit), Some(number)) if unit < 100 && number < 100_000 => {
                format!("glm:tokens:{unit}-{number}")
            }
            _ => "glm:tokens".to_string(),
        };
        push_unique(
            &mut windows,
            PlanWindow {
                window_id,
                label: window_label(window_minutes, "Token 额度"),
                used_percent,
                window_minutes,
                resets_at,
            },
        )?;
    }
    Ok(windows)
}

fn model_slug(name: &str) -> Option<String> {
    let name = name.trim();
    (!name.is_empty()
        && name.len() <= MAX_MODEL_NAME_BYTES
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)))
    .then(|| name.to_string())
}

/// `{base_resp: {status_code}, model_remains: [{model_name,
/// current_interval_remaining_percent, start_time, end_time,
/// current_weekly_remaining_percent, weekly_start_time, weekly_end_time}]}`.
fn parse_minimax(root: &Value, now: DateTime<Utc>) -> Result<Vec<PlanWindow>, ()> {
    if let Some(base) = root.get("base_resp") {
        if base.get("status_code").and_then(Value::as_i64) != Some(0) {
            return Err(());
        }
    }
    let buckets = root
        .get("model_remains")
        .and_then(Value::as_array)
        .ok_or(())?;
    if buckets.is_empty() || buckets.len() > MAX_ENTRIES {
        return Err(());
    }
    let mut windows = Vec::new();
    for bucket in buckets {
        let model = bucket
            .get("model_name")
            .and_then(Value::as_str)
            .and_then(model_slug)
            .ok_or(())?;
        for (kind, remaining_key, start_key, end_key, total_key, fallback) in [
            (
                "interval",
                "current_interval_remaining_percent",
                "start_time",
                "end_time",
                "current_interval_total_count",
                "当前额度",
            ),
            (
                "weekly",
                "current_weekly_remaining_percent",
                "weekly_start_time",
                "weekly_end_time",
                "current_weekly_total_count",
                "每周额度",
            ),
        ] {
            let Some(remaining) = bucket.get(remaining_key) else {
                continue;
            };
            // A zero total means the plan grants nothing for this model/window.
            if bucket.get(total_key).and_then(Value::as_f64) == Some(0.0) {
                continue;
            }
            let remaining = percent(remaining).ok_or(())?;
            let window_minutes = minutes_between_ms(bucket.get(start_key), bucket.get(end_key));
            let resets_at = optional_epoch_ms(bucket.get(end_key), now)?;
            push_unique(
                &mut windows,
                PlanWindow {
                    window_id: format!("minimax:{model}:{kind}"),
                    label: format!("{model} · {}", window_label(window_minutes, fallback)),
                    used_percent: 100.0 - remaining,
                    window_minutes,
                    resets_at,
                },
            )?;
        }
    }
    Ok(windows)
}

/// `{limit, used | remaining, resetTime | reset_at}` → used percent.
fn kimi_row(row: &Value, now: DateTime<Utc>) -> Result<(f64, Option<DateTime<Utc>>), ()> {
    if !row.is_object() {
        return Err(());
    }
    let limit = row.get("limit").and_then(amount).ok_or(())?;
    if limit <= 0.0 {
        return Err(());
    }
    let used = match (
        row.get("used").and_then(amount),
        row.get("remaining").and_then(amount),
    ) {
        (Some(used), _) => used,
        (None, Some(remaining)) if remaining <= limit => limit - remaining,
        _ => return Err(()),
    };
    if used > limit {
        return Err(());
    }
    let reset = match (row.get("resetTime"), row.get("reset_at")) {
        (Some(value), _) => optional_rfc3339(Some(value), now)?,
        (None, value) => optional_rfc3339(value, now)?,
    };
    Ok((used / limit * 100.0, reset))
}

fn kimi_window_minutes(window: &Value) -> Option<u64> {
    let duration = window.get("duration").and_then(Value::as_u64)?;
    let unit = window.get("timeUnit").and_then(Value::as_str)?;
    let factor = match unit.trim_start_matches("TIME_UNIT_") {
        "MINUTE" => 1,
        "HOUR" => 60,
        "DAY" => 1_440,
        _ => return None,
    };
    duration.checked_mul(factor).and_then(valid_minutes)
}

/// `{usage: row, limits: [{window: {duration, timeUnit}, detail: row}]}`.
fn parse_kimi(root: &Value, now: DateTime<Utc>) -> Result<Vec<PlanWindow>, ()> {
    let mut windows = Vec::new();
    if let Some(usage) = root.get("usage") {
        let (used_percent, resets_at) = kimi_row(usage, now)?;
        push_unique(
            &mut windows,
            PlanWindow {
                window_id: "kimi:usage".to_string(),
                label: "套餐总额度".to_string(),
                used_percent,
                window_minutes: None,
                resets_at,
            },
        )?;
    }
    if let Some(limits) = root.get("limits") {
        let limits = limits.as_array().ok_or(())?;
        if limits.len() > MAX_ENTRIES {
            return Err(());
        }
        for (index, limit) in limits.iter().enumerate() {
            let detail = limit.get("detail").ok_or(())?;
            let (used_percent, resets_at) = kimi_row(detail, now)?;
            let window_minutes = limit.get("window").and_then(kimi_window_minutes);
            let window_id = match window_minutes {
                Some(minutes) => format!("kimi:limit:{minutes}m"),
                None => format!("kimi:limit:{index}"),
            };
            push_unique(
                &mut windows,
                PlanWindow {
                    window_id,
                    label: window_label(window_minutes, "限速额度"),
                    used_percent,
                    window_minutes,
                    resets_at,
                },
            )?;
        }
    }
    Ok(windows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-04T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn ms(rfc3339: &str) -> i64 {
        DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn gateway_base_urls_map_only_to_fixed_plan_hosts() {
        assert_eq!(
            plan_endpoint_for_base_url(
                PlanVendor::ZhipuGlm,
                "https://open.bigmodel.cn/api/coding/paas/v4"
            )
            .map(|e| e.url),
            Some("https://open.bigmodel.cn/api/monitor/usage/quota/limit")
        );
        assert_eq!(
            plan_endpoint_for_base_url(PlanVendor::ZhipuGlm, "https://API.Z.AI/api/anthropic")
                .map(|e| e.host),
            Some("api.z.ai")
        );
        assert_eq!(
            plan_endpoint_for_base_url(PlanVendor::Minimax, "https://api.minimaxi.com/anthropic")
                .map(|e| e.url),
            Some("https://api.minimaxi.com/v1/token_plan/remains")
        );
        assert_eq!(
            plan_endpoint_for_base_url(PlanVendor::KimiCode, "https://api.kimi.com/coding/v1")
                .map(|e| e.url),
            Some("https://api.kimi.com/coding/v1/usages")
        );
        for (vendor, denied) in [
            (PlanVendor::ZhipuGlm, "http://open.bigmodel.cn/api/paas/v4"),
            (
                PlanVendor::ZhipuGlm,
                "https://open.bigmodel.cn:8443/api/paas/v4",
            ),
            (
                PlanVendor::ZhipuGlm,
                "https://open.bigmodel.cn.evil.example/api",
            ),
            (PlanVendor::Minimax, "https://open.bigmodel.cn/api/paas/v4"),
            (PlanVendor::KimiCode, "https://api.moonshot.cn/v1"),
            (
                PlanVendor::KimiCode,
                "https://user:pw@api.kimi.com/coding/v1",
            ),
        ] {
            assert!(
                plan_endpoint_for_base_url(vendor, denied).is_none(),
                "{denied}"
            );
        }
    }

    #[test]
    fn allowlist_is_exact_url_equality() {
        for endpoint in PLAN_ENDPOINTS {
            assert!(plan_url_allowed(&Url::parse(endpoint.url).unwrap()));
        }
        for denied in [
            "https://open.bigmodel.cn/api/monitor/usage/quota/limit?key=x",
            "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            "http://api.kimi.com/coding/v1/usages",
            "https://api.kimi.com.evil.example/coding/v1/usages",
            "https://api.deepseek.com/user/balance",
        ] {
            assert!(!plan_url_allowed(&Url::parse(denied).unwrap()), "{denied}");
        }
    }

    #[test]
    fn zhipu_maps_token_limits_and_skips_other_types() {
        let body = json!({"code": 200, "success": true, "data": {"level": "pro", "limits": [
            {"type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 12.5, "nextResetTime": ms("2026-10-04T15:00:00Z")},
            {"type": "TIME_LIMIT", "unit": 5, "number": 1, "usage": 100, "currentValue": 3, "remaining": 97, "percentage": 3}
        ]}});
        let windows = parse_plan_response(PlanVendor::ZhipuGlm, &body, now()).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].window_id, "glm:tokens:3-5");
        assert_eq!(windows[0].label, "5 小时额度");
        assert_eq!(windows[0].window_minutes, Some(300));
        assert_eq!(windows[0].used_percent, 12.5);
        assert_eq!(
            windows[0].resets_at.map(|at| at.to_rfc3339()),
            Some("2026-10-04T15:00:00+00:00".to_string())
        );
    }

    #[test]
    fn zhipu_fails_closed_on_out_of_range_or_missing_fields() {
        let limit = |entry: Value| json!({"code": 200, "data": {"limits": [entry]}});
        for bad in [
            json!({"code": 200, "data": {}}),
            json!({"code": 401, "data": {"limits": [{"type": "TOKENS_LIMIT", "percentage": 1}]}}),
            json!({"success": false, "data": {"limits": [{"type": "TOKENS_LIMIT", "percentage": 1}]}}),
            limit(json!({"type": "TOKENS_LIMIT"})),
            limit(json!({"type": "TOKENS_LIMIT", "percentage": 101})),
            limit(json!({"type": "TOKENS_LIMIT", "percentage": -1})),
            limit(json!({"type": "TOKENS_LIMIT", "percentage": "12"})),
            limit(
                json!({"type": "TOKENS_LIMIT", "percentage": 1, "nextResetTime": ms("2027-01-01T00:00:00Z")}),
            ),
            limit(json!({"type": "TOKENS_LIMIT", "percentage": 1, "nextResetTime": "soon"})),
            limit(json!({"type": "TIME_LIMIT", "percentage": 1})),
            json!([]),
        ] {
            assert!(
                parse_plan_response(PlanVendor::ZhipuGlm, &bad, now()).is_err(),
                "{bad}"
            );
        }
        let unknown_unit =
            limit(json!({"type": "TOKENS_LIMIT", "unit": 9, "number": 1, "percentage": 1}));
        let windows = parse_plan_response(PlanVendor::ZhipuGlm, &unknown_unit, now()).unwrap();
        assert_eq!(
            (windows[0].window_minutes, windows[0].label.as_str()),
            (None, "Token 额度")
        );
    }

    #[test]
    fn minimax_maps_interval_and_weekly_remaining_to_used() {
        let body = json!({"base_resp": {"status_code": 0, "status_msg": "success"}, "model_remains": [{
            "model_name": "MiniMax-M2",
            "start_time": ms("2026-10-04T10:00:00Z"), "end_time": ms("2026-10-04T15:00:00Z"),
            "current_interval_total_count": 1500, "current_interval_remaining_percent": 80,
            "weekly_start_time": ms("2026-09-28T00:00:00Z"), "weekly_end_time": ms("2026-10-05T00:00:00Z"),
            "current_weekly_total_count": 15000, "current_weekly_remaining_percent": 55.5
        }]});
        let windows = parse_plan_response(PlanVendor::Minimax, &body, now()).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window_id, "minimax:MiniMax-M2:interval");
        assert_eq!(windows[0].label, "MiniMax-M2 · 5 小时额度");
        assert_eq!(windows[0].used_percent, 20.0);
        assert_eq!(windows[0].window_minutes, Some(300));
        assert_eq!(windows[1].window_id, "minimax:MiniMax-M2:weekly");
        assert_eq!(windows[1].window_minutes, Some(10_080));
        assert!((windows[1].used_percent - 44.5).abs() < 1e-9);
    }

    #[test]
    fn minimax_fails_closed_on_errors_and_bad_fields() {
        let bucket = |extra: Value| {
            let mut entry = json!({"model_name": "MiniMax-M2"});
            entry
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            json!({"base_resp": {"status_code": 0}, "model_remains": [entry]})
        };
        for bad in [
            json!({"base_resp": {"status_code": 1004, "status_msg": "auth"}, "model_remains": []}),
            json!({"model_remains": []}),
            json!({"base_resp": {"status_code": 0}}),
            bucket(json!({})),
            bucket(json!({"current_interval_remaining_percent": 120})),
            bucket(
                json!({"current_interval_remaining_percent": 50, "end_time": ms("2020-01-01T00:00:00Z")}),
            ),
            json!({"model_remains": [{"model_name": "bad name/../x", "current_interval_remaining_percent": 5}]}),
            json!({"model_remains": [{"current_interval_remaining_percent": 5}]}),
        ] {
            assert!(
                parse_plan_response(PlanVendor::Minimax, &bad, now()).is_err(),
                "{bad}"
            );
        }
        let zero_total = bucket(
            json!({"current_interval_total_count": 0, "current_interval_remaining_percent": 0}),
        );
        assert!(parse_plan_response(PlanVendor::Minimax, &zero_total, now()).is_err());
    }

    #[test]
    fn kimi_maps_usage_and_rate_limit_windows() {
        let body = json!({
            "usage": {"limit": "100", "used": "25", "remaining": "75", "resetTime": "2026-10-08T00:00:00Z"},
            "limits": [{"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                        "detail": {"limit": "100", "remaining": "90", "resetTime": "2026-10-04T14:00:00Z"}}]
        });
        let windows = parse_plan_response(PlanVendor::KimiCode, &body, now()).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].window_id, "kimi:usage");
        assert_eq!(windows[0].used_percent, 25.0);
        assert_eq!(windows[0].window_minutes, None);
        assert_eq!(windows[1].window_id, "kimi:limit:300m");
        assert_eq!(windows[1].label, "5 小时额度");
        assert_eq!(windows[1].used_percent, 10.0);
    }

    #[test]
    fn kimi_fails_closed_on_out_of_range_or_missing_fields() {
        for bad in [
            json!({}),
            json!({"usage": {"limit": "0", "used": "0"}}),
            json!({"usage": {"limit": "100", "used": "101"}}),
            json!({"usage": {"limit": "100"}}),
            json!({"usage": {"limit": "100", "remaining": "120"}}),
            json!({"usage": {"limit": "100", "used": "-1"}}),
            json!({"usage": {"limit": "100", "used": "1", "resetTime": "2030-01-01T00:00:00Z"}}),
            json!({"usage": {"limit": "100", "used": "1", "resetTime": 12}}),
            json!({"limits": [{"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"}}]}),
            json!({"limits": {"window": {}}}),
            json!({"usage": "75%"}),
        ] {
            assert!(
                parse_plan_response(PlanVendor::KimiCode, &bad, now()).is_err(),
                "{bad}"
            );
        }
    }
}
