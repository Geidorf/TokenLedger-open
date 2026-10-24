//! Request log viewer (docs/design/gateway-request-log-v1.md): groups the
//! diagnostic ledger's attempts into logical requests, joins each with its
//! routing decision, filters and pages them. Metadata only: the gateway never
//! keeps request or response bodies.

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{ContextSize, LedgerRecord, RouteDecision};

pub const DECISION_FILE: &str = "route-decisions-v1.jsonl";
const DECISION_ROTATE_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_PAGE: usize = 200;
/// Search text longer than this is cut; it only ever matches metadata.
const MAX_SEARCH_CHARS: usize = 120;

pub fn append_decision(dir: &Path, decision: &RouteDecision) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let path = dir.join(DECISION_FILE);
    if fs::metadata(&path)
        .map(|meta| meta.len() >= DECISION_ROTATE_BYTES)
        .unwrap_or(false)
    {
        fs::rename(&path, path.with_extension("jsonl.1"))
            .map_err(|error| format!("轮转路由决策日志失败：{error}"))?;
    }
    // Stored without the session id: the ledger line already links the two.
    let mut line =
        serde_json::to_vec(&StoredDecision::from(decision)).map_err(|error| error.to_string())?;
    line.push(b'\n');
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(&line))
        .map_err(|error| format!("写入路由决策日志失败：{error}"))
}

/// A routing decision read back from disk (or copied from memory).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredDecision {
    pub ts: String,
    pub request_id: String,
    pub group: String,
    pub reason: String,
    #[serde(default)]
    pub detail: String,
    pub chosen: Option<String>,
    #[serde(default)]
    pub attempts: Vec<StoredDecisionAttempt>,
    #[serde(default)]
    pub trace: Vec<StoredTrace>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredDecisionAttempt {
    pub member: String,
    pub outcome: String,
    pub status: Option<u16>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredTrace {
    pub member: String,
    pub rank: Option<u8>,
    pub verdict: String,
    #[serde(default)]
    pub reasons: Vec<String>,
    pub detail: Option<String>,
}

impl From<&RouteDecision> for StoredDecision {
    fn from(decision: &RouteDecision) -> Self {
        // Same shape as the on-disk line; a round trip keeps one code path.
        serde_json::to_value(decision)
            .ok()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_else(|| Self {
                ts: decision.ts.clone(),
                request_id: decision.request_id.clone(),
                group: decision.group.clone(),
                reason: decision.reason.to_string(),
                detail: decision.detail.clone(),
                chosen: decision.chosen.clone(),
                attempts: Vec::new(),
                trace: Vec::new(),
            })
    }
}

/// Decisions on disk keyed by request id; later lines win.
pub fn read_decisions(dir: &Path) -> HashMap<String, StoredDecision> {
    let mut decisions = HashMap::new();
    let path = dir.join(DECISION_FILE);
    for path in [path.with_extension("jsonl.1"), path] {
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(decision) = serde_json::from_str::<StoredDecision>(&line) {
                decisions.insert(decision.request_id.clone(), decision);
            }
        }
    }
    decisions
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RequestLogQuery {
    /// RFC 3339; inclusive.
    pub since: Option<String>,
    /// RFC 3339; inclusive.
    pub until: Option<String>,
    pub agent: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// `ok` | `error` | `4xx` | `5xx` | `retried` | an exact code such as `429`.
    pub status: Option<String>,
    pub min_latency_ms: Option<u64>,
    pub max_latency_ms: Option<u64>,
    pub search: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogAttempt {
    pub ts: String,
    pub request_id: String,
    pub provider: String,
    pub upstream_model: String,
    pub member: Option<String>,
    pub status: u16,
    pub ok: bool,
    pub latency_ms: u64,
    pub first_token_ms: Option<u64>,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub error: Option<String>,
    /// Filled by the command layer from the local price table.
    pub cost_usd: Option<f64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogEntry {
    /// The logical request id (stable across failover attempts).
    pub id: String,
    /// When the request reached the gateway (first attempt's start).
    pub started_at: String,
    /// When the last attempt finished.
    pub ts: String,
    pub agent: Option<String>,
    pub session: Option<String>,
    pub endpoint: String,
    pub wire: String,
    pub stream: bool,
    pub requested_model: String,
    pub group: Option<String>,
    /// The attempt that produced the reply the client got (the last one).
    pub provider: String,
    pub upstream_model: String,
    pub status: u16,
    pub ok: bool,
    pub error: Option<String>,
    /// Wall time from the first attempt's start to the last attempt's end.
    pub latency_ms: u64,
    /// First output from the request's start, retries included.
    pub first_token_ms: Option<u64>,
    /// Output tokens per second after the first token (streams), or over the
    /// whole serving attempt otherwise.
    pub output_tps: Option<f64>,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: Option<f64>,
    pub context: Option<ContextSize>,
    pub retries: usize,
    /// More than one provider/model was tried.
    pub switched: bool,
    pub attempts: Vec<RequestLogAttempt>,
    pub decision: Option<StoredDecision>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogFacets {
    pub agents: Vec<String>,
    pub providers: Vec<String>,
    pub models: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogPage {
    pub entries: Vec<RequestLogEntry>,
    /// Requests matching the filters (all pages).
    pub total: usize,
    pub offset: usize,
    /// Requests still on disk (unfiltered).
    pub retained: usize,
    /// Oldest request still on disk; older ones rotated out.
    pub oldest: Option<String>,
    pub facets: RequestLogFacets,
}

fn parse_ts(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|ts| ts.with_timezone(&Utc))
}

fn attempt_of(record: &LedgerRecord) -> RequestLogAttempt {
    RequestLogAttempt {
        ts: record.ts.clone(),
        request_id: record.request_id.clone(),
        provider: record.provider.clone(),
        upstream_model: record.upstream_model.clone(),
        member: record.member.clone(),
        status: record.status,
        ok: record.ok,
        latency_ms: record.latency_ms,
        first_token_ms: record.first_token_ms,
        input: record.input,
        output: record.output,
        cache_read: record.cache_read,
        cache_write: record.cache_write,
        error: record.error.clone(),
        cost_usd: None,
    }
}

/// `records` oldest first, as on disk. Attempts of one logical request are
/// written in the order they ran; the entry takes the last one's outcome.
pub fn group_records(
    records: &[LedgerRecord],
    decisions: &HashMap<String, StoredDecision>,
) -> Vec<RequestLogEntry> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&LedgerRecord>> = HashMap::new();
    for record in records {
        let id = record
            .logical_request_id
            .clone()
            .unwrap_or_else(|| record.request_id.clone());
        groups
            .entry(id.clone())
            .or_insert_with(|| {
                order.push(id.clone());
                Vec::new()
            })
            .push(record);
    }
    let mut entries: Vec<RequestLogEntry> = order
        .into_iter()
        .filter_map(|id| {
            let attempts = groups.remove(&id)?;
            Some(entry_of(id, &attempts, decisions))
        })
        .collect();
    entries.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| b.id.cmp(&a.id)));
    entries
}

fn entry_of(
    id: String,
    attempts: &[&LedgerRecord],
    decisions: &HashMap<String, StoredDecision>,
) -> RequestLogEntry {
    let first = attempts[0];
    let last = attempts[attempts.len() - 1];
    let start = parse_ts(&first.ts).map(|ts| {
        ts - chrono::Duration::milliseconds(first.latency_ms.min(i64::MAX as u64) as i64)
    });
    let end = parse_ts(&last.ts);
    let latency_ms = match (start, end) {
        (Some(start), Some(end)) if end >= start => (end - start).num_milliseconds() as u64,
        _ => attempts.iter().map(|a| a.latency_ms).sum(),
    };
    let last_start_offset = latency_ms.saturating_sub(last.latency_ms);
    let first_token_ms = last.first_token_ms.map(|ms| last_start_offset + ms);
    let output_tps = if last.output == 0 {
        None
    } else {
        let generating = match last.first_token_ms {
            Some(ttft) if last.latency_ms > ttft => last.latency_ms - ttft,
            _ => last.latency_ms,
        };
        (generating > 0).then(|| last.output as f64 * 1000.0 / generating as f64)
    };
    let sum = |field: fn(&LedgerRecord) -> u64| attempts.iter().map(|a| field(a)).sum::<u64>();
    let distinct: BTreeSet<(&str, &str)> = attempts
        .iter()
        .map(|a| (a.provider.as_str(), a.upstream_model.as_str()))
        .collect();
    RequestLogEntry {
        started_at: start.map_or_else(|| first.ts.clone(), |ts| ts.to_rfc3339()),
        ts: last.ts.clone(),
        agent: first.agent.clone(),
        session: first.session.clone(),
        endpoint: first.endpoint.clone(),
        wire: last.wire.clone(),
        stream: first.stream,
        requested_model: first.requested_model.clone(),
        group: first.group.clone(),
        provider: last.provider.clone(),
        upstream_model: last.upstream_model.clone(),
        status: last.status,
        ok: last.ok,
        error: last.error.clone(),
        latency_ms,
        first_token_ms,
        output_tps,
        input: sum(|a| a.input),
        output: sum(|a| a.output),
        cache_read: sum(|a| a.cache_read),
        cache_write: sum(|a| a.cache_write),
        cost_usd: None,
        context: attempts.iter().find_map(|a| a.context),
        retries: attempts.len() - 1,
        switched: distinct.len() > 1,
        attempts: attempts.iter().map(|a| attempt_of(a)).collect(),
        decision: decisions.get(&id).cloned(),
        id,
    }
}

fn status_matches(entry: &RequestLogEntry, wanted: &str) -> bool {
    match wanted {
        "" | "all" => true,
        "ok" => entry.ok,
        "error" => !entry.ok,
        "4xx" => (400..500).contains(&entry.status),
        "5xx" => (500..600).contains(&entry.status),
        "retried" => entry.retries > 0,
        code => code.parse::<u16>().is_ok_and(|code| entry.status == code),
    }
}

fn contains(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(needle)
}

fn search_matches(entry: &RequestLogEntry, needle: &str) -> bool {
    let fields = [
        Some(entry.id.as_str()),
        entry.agent.as_deref(),
        entry.session.as_deref(),
        Some(entry.requested_model.as_str()),
        Some(entry.upstream_model.as_str()),
        Some(entry.provider.as_str()),
        entry.group.as_deref(),
        entry.error.as_deref(),
        Some(entry.endpoint.as_str()),
    ];
    fields
        .into_iter()
        .flatten()
        .any(|value| contains(value, needle))
        || entry.attempts.iter().any(|attempt| {
            contains(&attempt.request_id, needle)
                || contains(&attempt.provider, needle)
                || contains(&attempt.upstream_model, needle)
                || attempt
                    .error
                    .as_deref()
                    .is_some_and(|e| contains(e, needle))
        })
}

fn wanted(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Whether `entry` passes every filter in `query` (paging aside).
pub fn matches(entry: &RequestLogEntry, query: &RequestLogQuery) -> bool {
    let since = wanted(&query.since).and_then(parse_ts);
    let until = wanted(&query.until).and_then(parse_ts);
    let ts = parse_ts(&entry.ts);
    if let (Some(since), Some(ts)) = (since, ts) {
        if ts < since {
            return false;
        }
    }
    if let (Some(until), Some(ts)) = (until, ts) {
        if ts > until {
            return false;
        }
    }
    if let Some(agent) = wanted(&query.agent) {
        if entry.agent.as_deref().unwrap_or("") != agent {
            return false;
        }
    }
    if let Some(provider) = wanted(&query.provider) {
        if !entry.attempts.iter().any(|a| a.provider == provider) {
            return false;
        }
    }
    if let Some(model) = wanted(&query.model) {
        let hit = entry.requested_model == model
            || entry.attempts.iter().any(|a| {
                a.upstream_model == model || format!("{}/{}", a.provider, a.upstream_model) == model
            });
        if !hit {
            return false;
        }
    }
    if let Some(status) = wanted(&query.status) {
        if !status_matches(entry, status) {
            return false;
        }
    }
    if query
        .min_latency_ms
        .is_some_and(|min| entry.latency_ms < min)
        || query
            .max_latency_ms
            .is_some_and(|max| entry.latency_ms > max)
    {
        return false;
    }
    if let Some(search) = wanted(&query.search) {
        let needle: String = search
            .chars()
            .take(MAX_SEARCH_CHARS)
            .collect::<String>()
            .to_lowercase();
        if !search_matches(entry, &needle) {
            return false;
        }
    }
    true
}

pub fn facets(entries: &[RequestLogEntry]) -> RequestLogFacets {
    let mut agents = BTreeSet::new();
    let mut providers = BTreeSet::new();
    let mut models = BTreeSet::new();
    for entry in entries {
        if let Some(agent) = entry.agent.as_deref().filter(|a| !a.is_empty()) {
            agents.insert(agent.to_string());
        }
        for attempt in &entry.attempts {
            providers.insert(attempt.provider.clone());
            models.insert(format!("{}/{}", attempt.provider, attempt.upstream_model));
        }
        if entry.group.is_some() {
            models.insert(entry.requested_model.clone());
        }
    }
    RequestLogFacets {
        agents: agents.into_iter().collect(),
        providers: providers.into_iter().collect(),
        models: models.into_iter().collect(),
    }
}

/// Every entry matching `query`, newest first (for export).
pub fn filter_all(entries: Vec<RequestLogEntry>, query: &RequestLogQuery) -> Vec<RequestLogEntry> {
    entries.into_iter().filter(|e| matches(e, query)).collect()
}

/// One page of `entries` (newest first) after filtering.
pub fn page(entries: Vec<RequestLogEntry>, query: &RequestLogQuery) -> RequestLogPage {
    let retained = entries.len();
    let oldest = entries.last().map(|e| e.started_at.clone());
    let facets = facets(&entries);
    let matching = filter_all(entries, query);
    let total = matching.len();
    let offset = query.offset.unwrap_or(0).min(total);
    let limit = query.limit.unwrap_or(50).clamp(1, MAX_PAGE);
    RequestLogPage {
        entries: matching.into_iter().skip(offset).take(limit).collect(),
        total,
        offset,
        retained,
        oldest,
        facets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, logical: &str, ts: &str, provider: &str, status: u16) -> LedgerRecord {
        LedgerRecord {
            ts: ts.into(),
            request_id: id.into(),
            logical_request_id: Some(logical.into()),
            agent: Some("codex".into()),
            session: Some("s1".into()),
            endpoint: "responses".into(),
            provider: provider.into(),
            requested_model: "group/fast".into(),
            upstream_model: "m".into(),
            wire: "chat".into(),
            stream: true,
            status,
            ok: (200..300).contains(&status),
            input: if status == 200 { 1000 } else { 0 },
            output: if status == 200 { 500 } else { 0 },
            cache_read: 0,
            cache_write: 0,
            latency_ms: 1000,
            error: (status != 200).then(|| "rate limited".into()),
            group: Some("fast".into()),
            member: Some(format!("{provider}/m")),
            context: None,
            first_token_ms: (status == 200).then_some(200),
        }
    }

    fn sample() -> Vec<LedgerRecord> {
        vec![
            record("a1", "L1", "2026-10-24T01:00:01Z", "p1", 429),
            record("a2", "L1", "2026-10-24T01:00:02Z", "p2", 200),
            record("b1", "L2", "2026-10-24T02:00:00Z", "p1", 200),
        ]
    }

    #[test]
    fn groups_attempts_into_one_request_newest_first() {
        let entries = group_records(&sample(), &HashMap::new());
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "L2");
        let l1 = &entries[1];
        assert_eq!(
            (l1.retries, l1.switched, l1.status, l1.ok),
            (1, true, 200, true)
        );
        assert_eq!(l1.provider, "p2");
        // 01:00:00 (first start) → 01:00:02 (last end).
        assert_eq!(l1.latency_ms, 2000);
        // The serving attempt started 1 s in; its first token came 200 ms later.
        assert_eq!(l1.first_token_ms, Some(1200));
        // 500 tokens over the 800 ms after the first token.
        assert_eq!(l1.output_tps, Some(625.0));
        assert_eq!(
            l1.attempts.iter().map(|a| a.status).collect::<Vec<_>>(),
            vec![429, 200]
        );
    }

    #[test]
    fn legacy_rows_without_logical_id_stand_alone() {
        let mut rows = sample();
        rows[0].logical_request_id = None;
        rows[1].logical_request_id = None;
        let entries = group_records(&rows, &HashMap::new());
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn filters_by_status_provider_latency_and_search() {
        let entries = group_records(&sample(), &HashMap::new());
        let q = |f: fn(&mut RequestLogQuery)| {
            let mut query = RequestLogQuery::default();
            f(&mut query);
            filter_all(entries.clone(), &query)
                .into_iter()
                .map(|e| e.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(q(|q| q.status = Some("retried".into())), vec!["L1"]);
        assert_eq!(q(|q| q.status = Some("429".into())), Vec::<String>::new());
        assert_eq!(q(|q| q.provider = Some("p2".into())), vec!["L1"]);
        assert_eq!(q(|q| q.min_latency_ms = Some(1500)), vec!["L1"]);
        assert_eq!(q(|q| q.max_latency_ms = Some(1500)), vec!["L2"]);
        assert_eq!(q(|q| q.search = Some("RATE".into())), vec!["L1"]);
        assert_eq!(q(|q| q.model = Some("p1/m".into())), vec!["L2", "L1"]);
        assert_eq!(
            q(|q| q.since = Some("2026-10-24T01:30:00Z".into())),
            vec!["L2"]
        );
        assert_eq!(
            q(|q| q.agent = Some("opencode".into())),
            Vec::<String>::new()
        );
    }

    #[test]
    fn page_reports_totals_facets_and_clamps_offsets() {
        let entries = group_records(&sample(), &HashMap::new());
        let page = page(
            entries,
            &RequestLogQuery {
                offset: Some(1),
                limit: Some(1),
                ..Default::default()
            },
        );
        assert_eq!((page.total, page.offset, page.retained), (2, 1, 2));
        assert_eq!(page.entries[0].id, "L1");
        assert_eq!(page.facets.providers, vec!["p1", "p2"]);
        assert!(page.facets.models.contains(&"group/fast".to_string()));
        assert_eq!(page.oldest.as_deref(), Some("2026-10-24T01:00:00+00:00"));
    }

    #[test]
    fn decisions_round_trip_through_the_file_and_join_by_request_id() {
        let dir = std::env::temp_dir().join(format!("tl-gw-reqlog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let decision = RouteDecision {
            ts: "2026-10-24T01:00:02Z".into(),
            request_id: "L1".into(),
            group: "fast".into(),
            session: Some("s1".into()),
            reason: "failover",
            detail: "按顺序".into(),
            chosen: Some("p2/m".into()),
            attempts: vec![],
            trace: vec![super::super::routing::MemberTrace {
                member: "p1/m".into(),
                rank: Some(0),
                verdict: "failed",
                reasons: vec!["strategy_first", "rate_limited"],
                detail: Some("429".into()),
            }],
        };
        append_decision(&dir, &decision).unwrap();
        let decisions = read_decisions(&dir);
        let stored = decisions.get("L1").unwrap();
        assert_eq!(stored, &StoredDecision::from(&decision));
        assert_eq!(
            stored.trace[0].reasons,
            vec!["strategy_first", "rate_limited"]
        );
        let line = fs::read_to_string(dir.join(DECISION_FILE)).unwrap();
        assert!(
            !line.contains("\"session\""),
            "session ids stay out of the decision log"
        );
        let entries = group_records(&sample(), &decisions);
        assert_eq!(
            entries[1].decision.as_ref().unwrap().chosen.as_deref(),
            Some("p2/m")
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
