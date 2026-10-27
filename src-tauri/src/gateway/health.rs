//! Provider health (T10.301): success rate, latency P50/P95, rate limits,
//! error-code mix and recent failures per provider and upstream model,
//! summarised from the gateway's own diagnostic ledger. Purely passive: it
//! reads rows the gateway already wrote and never contacts an upstream.
//! Failure codes reuse the routing trace table
//! (`docs/design/routing-decision-trace-v1.md`).

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, Utc};
use serde::Serialize;

use super::ledger::LedgerRecord;
use super::probe::{ProbeResult, ProbeSettings};
use super::routing::{mentions_quota, CoolingMember};

/// Hours covered by a report and by its trend buckets.
pub const WINDOW_HOURS: i64 = 24;
const MAX_FAILURES: usize = 5;
const ERROR_CHARS: usize = 160;
/// Fewer requests than this never make a provider `degraded` by rate alone.
const MIN_SAMPLES: u64 = 5;
const DEGRADED_BELOW: f64 = 0.9;
/// Consecutive failed upstream calls, newest first, that mean `down`.
pub(super) const DOWN_STREAK: u32 = 3;

/// Error prefixes the gateway writes (`server.rs` builds its messages from
/// these), which tell upstream replies from transport and local failures.
pub(super) const UPSTREAM_REPLY: &str = "上游返回";
pub(super) const CONNECT_FAILED: &str = "连接上游失败";
pub(super) const HEADERS_TIMEOUT: &str = "等待上游响应头";
pub(super) const GATEWAY_STOPPED: &str = "未连接上游";
/// The Agent stopped reading or hung up mid-stream; not the provider's fault.
pub(super) const CLIENT_GONE: &str = "客户端";

/// Codes for local skips: the gateway never reached the upstream, so they
/// are listed but left out of the success rate and latency.
const LOCAL_CODES: &[&str] = &[
    "key_missing",
    "protocol_unsupported",
    "credential_unavailable",
];

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthStats {
    /// Calls that reached (or tried to reach) the upstream.
    pub requests: u64,
    pub ok: u64,
    /// `ok / requests`; `None` without upstream calls.
    pub success_rate: Option<f64>,
    /// Over successful calls only; streams count until the last event.
    pub p50_ms: Option<u64>,
    pub p95_ms: Option<u64>,
    /// 429s that were not quota messages.
    pub rate_limited: u64,
    /// Local skips (no key, protocol mismatch, keychain busy).
    pub skipped: u64,
    /// Trace reason code → count, most frequent first; excludes `answered`.
    pub codes: Vec<CodeCount>,
    /// Non-2xx HTTP status → count, most frequent first.
    pub statuses: Vec<StatusCount>,
    pub last_ok_at: Option<String>,
    pub last_failure_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct CodeCount {
    pub code: &'static str,
    pub count: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct StatusCount {
    pub status: u16,
    pub count: u64,
}

/// One hour of a provider's trend line, oldest bucket first.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HealthBucket {
    pub start: String,
    pub requests: u64,
    pub failed: u64,
    pub p95_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailureSample {
    pub ts: String,
    pub model: String,
    pub status: u16,
    pub code: &'static str,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelHealth {
    pub model: String,
    pub status: &'static str,
    pub stats: HealthStats,
}

/// `status` is `healthy` | `degraded` | `down` | `idle`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub provider: String,
    pub status: &'static str,
    /// Why the status is not `healthy`, as trace reason codes.
    pub reasons: Vec<&'static str>,
    pub stats: HealthStats,
    pub models: Vec<ModelHealth>,
    pub buckets: Vec<HealthBucket>,
    pub recent_failures: Vec<FailureSample>,
    /// Members of this provider cooling down in routing groups right now.
    pub cooling: Vec<CoolingMember>,
    /// Active probes when enabled, newest first; empty otherwise.
    pub probes: Vec<ProbeResult>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub generated_at: String,
    pub window_hours: i64,
    pub probe: ProbeSettings,
    pub providers: Vec<ProviderHealth>,
}

/// Trace reason code for one ledger row. Upstream replies are recorded as
/// `上游返回 <status>：…` and transport errors as `连接上游失败…`; anything else
/// that is not a 2xx and not 502 was decided locally before any upstream call.
pub fn row_code(record: &LedgerRecord) -> Option<&'static str> {
    if record.ok {
        return Some("answered");
    }
    let error = record.error.as_deref().unwrap_or("");
    if error.contains(GATEWAY_STOPPED) || error.starts_with(CLIENT_GONE) {
        // The gateway was stopping or the Agent hung up; says nothing about
        // the provider.
        return None;
    }
    if error.starts_with(CONNECT_FAILED) || error.starts_with(HEADERS_TIMEOUT) {
        return Some("connect_failed");
    }
    let from_upstream = error.starts_with(UPSTREAM_REPLY);
    Some(match record.status {
        429 if mentions_quota(Some(error)) => "quota_exhausted",
        402 => "quota_exhausted",
        429 => "rate_limited",
        401 | 403 if from_upstream => "auth_failed",
        401 => "key_missing",
        400 if !from_upstream => "protocol_unsupported",
        200 | 502 => "upstream_failed",
        500..=599 if from_upstream => "upstream_failed",
        _ if from_upstream => "upstream_rejected",
        _ => "credential_unavailable",
    })
}

/// Rejected by the gateway before any upstream call.
pub(super) fn is_local(code: &str) -> bool {
    LOCAL_CODES.contains(&code)
}

/// Nearest-rank percentile of an ascending slice.
fn percentile(sorted: &[u64], pct: u64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (sorted.len() as u64 * pct).div_ceil(100).max(1) as usize;
    Some(sorted[rank.min(sorted.len()) - 1])
}

fn by_count<K: Ord + Copy>(map: BTreeMap<K, u64>) -> Vec<(K, u64)> {
    let mut items: Vec<(K, u64)> = map.into_iter().collect();
    items.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    items
}

/// Rows must be oldest first.
fn stats(rows: &[(&LedgerRecord, &'static str)]) -> HealthStats {
    let mut out = HealthStats::default();
    let mut latencies = Vec::new();
    let mut codes = BTreeMap::new();
    let mut statuses = BTreeMap::new();
    for (record, code) in rows {
        if *code != "answered" {
            *codes.entry(*code).or_insert(0) += 1;
            if !(200..300).contains(&record.status) {
                *statuses.entry(record.status).or_insert(0) += 1;
            }
        }
        if is_local(code) {
            out.skipped += 1;
            continue;
        }
        out.requests += 1;
        if *code == "answered" {
            out.ok += 1;
            latencies.push(record.latency_ms);
            out.last_ok_at = Some(record.ts.clone());
        } else {
            out.last_failure_at = Some(record.ts.clone());
        }
        if *code == "rate_limited" {
            out.rate_limited += 1;
        }
    }
    latencies.sort_unstable();
    out.p50_ms = percentile(&latencies, 50);
    out.p95_ms = percentile(&latencies, 95);
    out.success_rate = (out.requests > 0).then(|| out.ok as f64 / out.requests as f64);
    out.codes = by_count(codes)
        .into_iter()
        .map(|(code, count)| CodeCount { code, count })
        .collect();
    out.statuses = by_count(statuses)
        .into_iter()
        .map(|(status, count)| StatusCount { status, count })
        .collect();
    out
}

/// Consecutive failed upstream calls at the newest end.
fn failure_streak(rows: &[(&LedgerRecord, &'static str)]) -> u32 {
    rows.iter()
        .rev()
        .filter(|(_, code)| !is_local(code))
        .take_while(|(_, code)| *code != "answered")
        .count() as u32
}

/// Status plus the codes that explain it.
fn level(
    stats: &HealthStats,
    streak: u32,
    cooling: &[CoolingMember],
) -> (&'static str, Vec<&'static str>) {
    let mut reasons = Vec::new();
    let worst = stats.codes.first().map(|item| item.code);
    if !cooling.is_empty() {
        reasons.push("cooling_down");
    }
    let down = streak >= DOWN_STREAK || cooling.iter().any(|m| m.failures >= DOWN_STREAK);
    let low_rate = stats.requests >= MIN_SAMPLES
        && stats.success_rate.is_some_and(|rate| rate < DEGRADED_BELOW);
    if down || low_rate || streak > 0 {
        // Codes are most frequent first; name the leading upstream one.
        if let Some(item) = stats.codes.iter().find(|item| !is_local(item.code)) {
            reasons.push(item.code);
        }
    }
    if stats.requests == 0 && cooling.is_empty() {
        if stats.skipped > 0 {
            reasons.extend(worst);
            return ("down", reasons);
        }
        return ("idle", reasons);
    }
    if down {
        ("down", reasons)
    } else if low_rate || streak > 0 || !cooling.is_empty() {
        ("degraded", reasons)
    } else {
        ("healthy", reasons)
    }
}

/// Folds the newest active probe into a passive verdict: a failed probe
/// newer than the last good call degrades (or, with no upstream calls,
/// takes down) the provider; a good probe makes an idle one healthy.
fn with_probe(
    status: &'static str,
    mut reasons: Vec<&'static str>,
    stats: &HealthStats,
    latest: Option<&ProbeResult>,
) -> (&'static str, Vec<&'static str>) {
    let Some(latest) = latest else {
        return (status, reasons);
    };
    if latest.ok {
        let status = if status == "idle" { "healthy" } else { status };
        return (status, reasons);
    }
    if !latest.failed() {
        return (status, reasons);
    }
    let newer = match (
        parse_ts(&latest.ts),
        stats.last_ok_at.as_deref().and_then(parse_ts),
    ) {
        (Some(probe), Some(ok)) => probe > ok,
        _ => true,
    };
    if !newer {
        return (status, reasons);
    }
    if !reasons.contains(&latest.code) {
        reasons.push(latest.code);
    }
    let status = match status {
        "down" => "down",
        _ if stats.requests == 0 => "down",
        _ => "degraded",
    };
    (status, reasons)
}

fn parse_ts(ts: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(ts)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn buckets(rows: &[(&LedgerRecord, &'static str)], now: DateTime<Utc>) -> Vec<HealthBucket> {
    // Rolling hours ending now, so the buckets cover exactly the report window.
    let first = now - Duration::hours(WINDOW_HOURS);
    let mut latencies: Vec<Vec<u64>> = vec![Vec::new(); WINDOW_HOURS as usize];
    let mut out: Vec<HealthBucket> = (0..WINDOW_HOURS)
        .map(|hour| HealthBucket {
            start: (first + Duration::hours(hour)).to_rfc3339(),
            ..HealthBucket::default()
        })
        .collect();
    for (record, code) in rows {
        let Some(at) = parse_ts(&record.ts) else {
            continue;
        };
        // A row stamped exactly `now` belongs to the last bucket.
        let index = (at - first).num_hours().min(WINDOW_HOURS - 1);
        if at <= first || index < 0 || is_local(code) {
            continue;
        }
        let bucket = &mut out[index as usize];
        bucket.requests += 1;
        if *code == "answered" {
            latencies[index as usize].push(record.latency_ms);
        } else {
            bucket.failed += 1;
        }
    }
    for (bucket, mut values) in out.iter_mut().zip(latencies) {
        values.sort_unstable();
        bucket.p95_ms = percentile(&values, 95);
    }
    out
}

/// Masks API-key-looking fragments an upstream may echo back: `sk-…`
/// tokens and whatever follows `Bearer`.
fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut after_bearer = false;
    for word in text.split_inclusive(char::is_whitespace) {
        let body = word.trim_end();
        let tail = &word[body.len()..];
        if after_bearer && !body.is_empty() {
            out.push_str("***");
            out.push_str(tail);
            after_bearer = false;
            continue;
        }
        after_bearer = body.eq_ignore_ascii_case("bearer");
        let key_at = body.match_indices("sk-").map(|(at, _)| at).find(|at| {
            !body[..*at]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric())
        });
        match key_at {
            Some(at) => {
                let rest = &body[at + 3..];
                let end = rest
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                    .unwrap_or(rest.len());
                out.push_str(&body[..at]);
                out.push_str(if end >= 4 {
                    "sk-***"
                } else {
                    &body[at..at + 3 + end]
                });
                out.push_str(&rest[end..]);
                out.push_str(tail);
            }
            None => out.push_str(word),
        }
    }
    out
}

fn clip(text: &str) -> String {
    redact(text).chars().take(ERROR_CHARS).collect()
}

/// Pure: summarises ledger rows (any order) from the last
/// [`WINDOW_HOURS`] into one entry per provider, worst status first.
/// `known` providers with no traffic still appear as `idle`.
pub fn summarize(
    records: &[LedgerRecord],
    known: &[String],
    cooling: &[CoolingMember],
    probes: &HashMap<String, Vec<ProbeResult>>,
    probe: ProbeSettings,
    now: DateTime<Utc>,
) -> HealthReport {
    let since = now - Duration::hours(WINDOW_HOURS);
    let mut rows: Vec<(DateTime<Utc>, &LedgerRecord, &'static str)> = records
        .iter()
        .filter_map(|record| {
            let at = parse_ts(&record.ts).filter(|at| *at > since && *at <= now)?;
            Some((at, record, row_code(record)?))
        })
        .collect();
    rows.sort_by_key(|(at, ..)| *at);

    let mut by_provider: BTreeMap<&str, Vec<(&LedgerRecord, &'static str)>> =
        known.iter().map(|id| (id.as_str(), Vec::new())).collect();
    for (_, record, code) in &rows {
        by_provider
            .entry(record.provider.as_str())
            .or_default()
            .push((*record, *code));
    }

    let mut providers: Vec<ProviderHealth> = by_provider
        .into_iter()
        .map(|(provider, rows)| {
            let prefix = format!("{provider}/");
            let mine: Vec<CoolingMember> = cooling
                .iter()
                .filter(|m| m.member.starts_with(&prefix))
                .cloned()
                .collect();
            let mut per_model: BTreeMap<&str, Vec<(&LedgerRecord, &'static str)>> = BTreeMap::new();
            for row in &rows {
                per_model
                    .entry(row.0.upstream_model.as_str())
                    .or_default()
                    .push(*row);
            }
            let models = per_model
                .into_iter()
                .map(|(model, rows)| {
                    let member = format!("{provider}/{model}");
                    let cool: Vec<CoolingMember> = mine
                        .iter()
                        .filter(|m| m.member == member)
                        .cloned()
                        .collect();
                    let stats = stats(&rows);
                    let (status, _) = level(&stats, failure_streak(&rows), &cool);
                    ModelHealth {
                        model: model.to_string(),
                        status,
                        stats,
                    }
                })
                .collect();
            let recent_failures = rows
                .iter()
                .rev()
                .filter(|(_, code)| *code != "answered")
                .take(MAX_FAILURES)
                .map(|(record, code)| FailureSample {
                    ts: record.ts.clone(),
                    model: record.upstream_model.clone(),
                    status: record.status,
                    code,
                    error: record.error.as_deref().map(clip),
                })
                .collect();
            let stats = stats(&rows);
            let (status, reasons) = level(&stats, failure_streak(&rows), &mine);
            let probes = probes.get(provider).cloned().unwrap_or_default();
            let (status, reasons) = with_probe(status, reasons, &stats, probes.first());
            ProviderHealth {
                provider: provider.to_string(),
                status,
                reasons,
                stats,
                models,
                buckets: buckets(&rows, now),
                recent_failures,
                cooling: mine,
                probes,
            }
        })
        .collect();
    let rank = |status: &str| match status {
        "down" => 0,
        "degraded" => 1,
        "healthy" => 2,
        _ => 3,
    };
    providers.sort_by(|a, b| {
        rank(a.status)
            .cmp(&rank(b.status))
            .then_with(|| a.provider.cmp(&b.provider))
    });
    HealthReport {
        generated_at: now.to_rfc3339(),
        window_hours: WINDOW_HOURS,
        probe,
        providers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-24T12:30:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn row(
        minutes_ago: i64,
        provider: &str,
        model: &str,
        status: u16,
        latency: u64,
        error: Option<&str>,
    ) -> LedgerRecord {
        LedgerRecord {
            ts: (now() - Duration::minutes(minutes_ago)).to_rfc3339(),
            request_id: format!("r{minutes_ago}"),
            logical_request_id: None,
            agent: Some("codex".into()),
            session: None,
            endpoint: "responses".into(),
            provider: provider.into(),
            requested_model: format!("{provider}/{model}"),
            upstream_model: model.into(),
            wire: "responses".into(),
            stream: false,
            status,
            ok: status == 200 && error.is_none(),
            input: 1,
            output: 1,
            cache_read: 0,
            cache_write: 0,
            latency_ms: latency,
            error: error.map(str::to_string),
            group: None,
            member: None,
            context: None,
            first_token_ms: None,
        }
    }

    fn ok(minutes_ago: i64, provider: &str, latency: u64) -> LedgerRecord {
        row(minutes_ago, provider, "m1", 200, latency, None)
    }

    #[test]
    fn codes_follow_the_trace_table() {
        let code = |status, error: Option<&str>| row_code(&row(0, "a", "m", status, 1, error));
        assert_eq!(code(200, None), Some("answered"));
        assert_eq!(
            code(429, Some("上游返回 429：slow down")),
            Some("rate_limited")
        );
        assert_eq!(
            code(429, Some("上游返回 429：insufficient quota")),
            Some("quota_exhausted")
        );
        assert_eq!(
            code(401, Some("上游返回 401：bad key")),
            Some("auth_failed")
        );
        assert_eq!(
            code(401, Some("供应商「A」还没有设置 API key。")),
            Some("key_missing")
        );
        assert_eq!(
            code(400, Some("这个供应商只提供 Responses 接口")),
            Some("protocol_unsupported")
        );
        assert_eq!(
            code(400, Some("上游返回 400：bad model")),
            Some("upstream_rejected")
        );
        assert_eq!(
            code(503, Some("上游返回 503：busy")),
            Some("upstream_failed")
        );
        assert_eq!(
            code(502, Some("连接上游失败：timeout")),
            Some("connect_failed")
        );
        assert_eq!(
            code(502, Some("等待上游响应头超过 60 秒。")),
            Some("connect_failed")
        );
        assert_eq!(
            code(502, Some("上游返回的不是有效 JSON。")),
            Some("upstream_failed")
        );
        assert_eq!(
            code(200, Some("上游返回流式错误。")),
            Some("upstream_failed")
        );
        assert_eq!(
            code(503, Some("凭据读取繁忙，请稍后重试。")),
            Some("credential_unavailable")
        );
        assert_eq!(code(502, Some("网关已停止，未连接上游。")), None);
        assert_eq!(code(200, Some("客户端提前断开。")), None);
        assert_eq!(code(200, Some("客户端连续 30 秒未读取响应。")), None);
    }

    #[test]
    fn redacts_key_fragments() {
        assert_eq!(
            redact("上游返回 401：Incorrect API key provided: sk-proj-abc123XYZ. Use Bearer tok_9f2 here"),
            "上游返回 401：Incorrect API key provided: sk-***. Use Bearer *** here"
        );
        assert_eq!(redact("task-sk-1 ok"), "task-sk-1 ok");
        assert_eq!(redact("plain 错误"), "plain 错误");
    }

    #[test]
    fn prefixes_match_what_the_server_writes() {
        // server.rs formats its messages from these constants; pin the text so
        // a reworded constant cannot silently reclassify old ledger rows.
        assert_eq!(
            (
                UPSTREAM_REPLY,
                CONNECT_FAILED,
                HEADERS_TIMEOUT,
                GATEWAY_STOPPED,
                CLIENT_GONE
            ),
            (
                "上游返回",
                "连接上游失败",
                "等待上游响应头",
                "未连接上游",
                "客户端"
            )
        );
        let server = include_str!("server.rs");
        for used in [
            "{UPSTREAM_REPLY} {status}",
            "{CONNECT_FAILED}：",
            "{HEADERS_TIMEOUT}超过",
            "{GATEWAY_STOPPED}。",
            "{CLIENT_GONE}提前断开",
            "{CLIENT_GONE}连续",
        ] {
            assert!(server.contains(used), "server.rs no longer writes {used}");
        }
    }

    #[test]
    fn percentiles_use_nearest_rank() {
        let values: Vec<u64> = (1..=20).map(|n| n * 10).collect();
        assert_eq!(percentile(&values, 50), Some(100));
        assert_eq!(percentile(&values, 95), Some(190));
        assert_eq!(percentile(&[7], 95), Some(7));
        assert_eq!(percentile(&[], 50), None);
    }

    #[test]
    fn summarises_rates_latency_codes_and_failures() {
        let mut records: Vec<LedgerRecord> =
            (1..=18).map(|n| ok(n * 3, "a", n as u64 * 100)).collect();
        records.push(row(70, "a", "m2", 429, 5, Some("上游返回 429：slow down")));
        records.push(row(80, "a", "m2", 503, 5, Some("上游返回 503：busy")));
        records.push(row(
            90,
            "a",
            "m2",
            401,
            0,
            Some("供应商「A」还没有设置 API key。"),
        ));
        // Outside the window and from the future: ignored.
        records.push(row(60 * 25, "a", "m1", 500, 5, Some("上游返回 500：x")));
        records.push(row(-5, "a", "m1", 500, 5, Some("上游返回 500：x")));
        let report = summarize(
            &records,
            &["a".into(), "idle".into()],
            &[],
            &HashMap::new(),
            ProbeSettings::default(),
            now(),
        );
        assert_eq!(report.window_hours, 24);
        let a = &report.providers[0];
        assert_eq!(a.provider, "a");
        assert_eq!((a.stats.requests, a.stats.ok, a.stats.skipped), (20, 18, 1));
        assert_eq!(a.stats.success_rate, Some(0.9));
        assert_eq!((a.stats.p50_ms, a.stats.p95_ms), (Some(900), Some(1800)));
        assert_eq!(a.stats.rate_limited, 1);
        assert_eq!(
            a.stats
                .codes
                .iter()
                .map(|c| (c.code, c.count))
                .collect::<Vec<_>>(),
            vec![
                ("key_missing", 1),
                ("rate_limited", 1),
                ("upstream_failed", 1)
            ]
        );
        assert_eq!(
            a.stats
                .statuses
                .iter()
                .map(|s| (s.status, s.count))
                .collect::<Vec<_>>(),
            vec![(401, 1), (429, 1), (503, 1)]
        );
        // Newest calls succeeded and the rate is not below 90%.
        assert_eq!((a.status, a.reasons.clone()), ("healthy", vec![]));
        assert_eq!(
            a.recent_failures
                .iter()
                .map(|f| (f.status, f.code))
                .collect::<Vec<_>>(),
            vec![
                (429, "rate_limited"),
                (503, "upstream_failed"),
                (401, "key_missing")
            ]
        );
        let models: Vec<_> = a
            .models
            .iter()
            .map(|m| (m.model.as_str(), m.status, m.stats.requests))
            .collect();
        assert_eq!(models, vec![("m1", "healthy", 18), ("m2", "degraded", 2)]);
        assert_eq!(a.buckets.len(), 24);
        assert!(a.buckets[0].start.starts_with("2026-10-23T12:30:00"));
        assert!(a.buckets[23].start.starts_with("2026-10-24T11:30:00"));
        assert_eq!((a.buckets[23].requests, a.buckets[23].failed), (18, 0));
        assert_eq!((a.buckets[22].requests, a.buckets[22].failed), (2, 2));
        assert_eq!(a.buckets[23].p95_ms, Some(1800));
        let in_buckets: u64 = a.buckets.iter().map(|b| b.requests).sum();
        assert_eq!(
            in_buckets, a.stats.requests,
            "the trend covers the whole window"
        );
        let idle = &report.providers[1];
        assert_eq!((idle.provider.as_str(), idle.status), ("idle", "idle"));
        assert!(idle.buckets.iter().all(|b| b.requests == 0));
    }

    #[test]
    fn streaks_and_cooldowns_degrade_and_take_down() {
        let mut records = vec![ok(30, "b", 100), ok(30, "c", 100)];
        for minute in [3, 2, 1] {
            records.push(row(
                minute,
                "b",
                "m1",
                502,
                5,
                Some("连接上游失败：refused"),
            ));
        }
        records.push(row(1, "c", "m1", 429, 5, Some("上游返回 429：slow")));
        let cooling = vec![CoolingMember {
            member: "c/m1".into(),
            remaining_secs: 20,
            failures: 1,
        }];
        let report = summarize(
            &records,
            &[],
            &cooling,
            &HashMap::new(),
            ProbeSettings::default(),
            now(),
        );
        let status: Vec<_> = report
            .providers
            .iter()
            .map(|p| (p.provider.as_str(), p.status, p.reasons.clone()))
            .collect();
        assert_eq!(
            status,
            vec![
                ("b", "down", vec!["connect_failed"]),
                ("c", "degraded", vec!["cooling_down", "rate_limited"]),
            ]
        );
        assert_eq!(report.providers[1].cooling.len(), 1);
        assert_eq!(report.providers[1].models[0].status, "degraded");
    }

    #[test]
    fn upstream_reason_wins_over_more_frequent_local_skips() {
        let mut records: Vec<LedgerRecord> = (10..14)
            .map(|m| {
                row(
                    m,
                    "a",
                    "m1",
                    401,
                    0,
                    Some("供应商「A」还没有设置 API key。"),
                )
            })
            .collect();
        for m in [3, 2, 1] {
            records.push(row(m, "a", "m1", 503, 5, Some("上游返回 503：busy")));
        }
        let report = summarize(
            &records,
            &[],
            &[],
            &HashMap::new(),
            ProbeSettings::default(),
            now(),
        );
        let a = &report.providers[0];
        assert_eq!(a.stats.codes[0].code, "key_missing");
        assert_eq!(
            (a.status, a.reasons.clone()),
            ("down", vec!["upstream_failed"])
        );
    }

    #[test]
    fn probes_fill_in_for_missing_traffic() {
        let probe = |minutes_ago: i64, ok: bool, code: &'static str| ProbeResult {
            ts: (now() - Duration::minutes(minutes_ago)).to_rfc3339(),
            ok,
            status: Some(if ok { 200 } else { 401 }),
            latency_ms: 300,
            code,
            error: None,
        };
        let probes = HashMap::from([
            ("idle-ok".to_string(), vec![probe(1, true, "answered")]),
            ("idle-bad".to_string(), vec![probe(1, false, "auth_failed")]),
            ("busy".to_string(), vec![probe(1, false, "connect_failed")]),
            (
                "stale".to_string(),
                vec![probe(30, false, "connect_failed")],
            ),
            (
                "no-list".to_string(),
                vec![probe(1, false, "probe_unsupported")],
            ),
        ]);
        let records = vec![ok(10, "busy", 100), ok(10, "stale", 100)];
        let known: Vec<String> = ["idle-ok", "idle-bad", "no-list"]
            .map(String::from)
            .to_vec();
        let settings = ProbeSettings {
            enabled: true,
            interval_mins: 15,
        };
        let report = summarize(&records, &known, &[], &probes, settings, now());
        assert_eq!(report.probe, settings);
        let status = |id: &str| {
            let item = report.providers.iter().find(|p| p.provider == id).unwrap();
            (item.status, item.reasons.clone())
        };
        assert_eq!(status("idle-ok"), ("healthy", vec![]));
        assert_eq!(status("idle-bad"), ("down", vec!["auth_failed"]));
        assert_eq!(status("busy"), ("degraded", vec!["connect_failed"]));
        // The last real call is newer than the failed probe.
        assert_eq!(status("stale"), ("healthy", vec![]));
        assert_eq!(status("no-list"), ("idle", vec![]));
        assert_eq!(
            report
                .providers
                .iter()
                .find(|p| p.provider == "busy")
                .unwrap()
                .probes
                .len(),
            1
        );
    }

    #[test]
    fn only_local_skips_mean_unusable_not_idle() {
        let records = vec![row(
            5,
            "k",
            "m1",
            401,
            0,
            Some("供应商「K」还没有设置 API key。"),
        )];
        let report = summarize(
            &records,
            &[],
            &[],
            &HashMap::new(),
            ProbeSettings::default(),
            now(),
        );
        let k = &report.providers[0];
        assert_eq!((k.status, k.reasons.clone()), ("down", vec!["key_missing"]));
        assert_eq!((k.stats.requests, k.stats.success_rate), (0, None));
    }

    #[test]
    fn hour_edges_land_in_one_bucket_and_the_window_start_is_open() {
        // 60 min ago opens the newest bucket; 61 min falls in the one before;
        // exactly 24 h ago is outside the window, 24 h minus a minute is in.
        let records = vec![
            ok(0, "h", 100),
            ok(60, "h", 100),
            ok(61, "h", 100),
            ok(24 * 60 - 1, "h", 100),
            ok(24 * 60, "h", 100),
        ];
        let report = summarize(
            &records,
            &[],
            &[],
            &HashMap::new(),
            ProbeSettings::default(),
            now(),
        );
        let h = &report.providers[0];
        assert_eq!(h.stats.requests, 4);
        let counts: Vec<u64> = h.buckets.iter().map(|b| b.requests).collect();
        assert_eq!((counts[0], counts[22], counts[23]), (1, 1, 2));
        assert_eq!(counts.iter().sum::<u64>(), 4);
    }
}
