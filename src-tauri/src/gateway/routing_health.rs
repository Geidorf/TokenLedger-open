//! Bounded, in-process routing health (task #130).
//!
//! Ledger observations are reduced to counters and timestamps only. The state
//! starts empty on every process start: configuration epochs are not persisted,
//! so replaying old rows could reintroduce a failure from a replaced key or
//! endpoint. Probes are read-only inputs to [`RoutingHealth::snapshot`].

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};

use super::health::{row_code, DOWN_STREAK};
use super::ledger::LedgerRecord;
use super::probe::ProbeResult;

const MAX_MEMBERS: usize = 1024;
const MAX_ID_BYTES: usize = 512;
const OBSERVATION_TTL_MINUTES: i64 = 5;
const BLOCK_BASE_SECS: u64 = 60;
const BLOCK_MAX_SECS: u64 = 300;
const PROBE_TTL_SECS: i64 = 60;

/// Identifies one request observation. A configuration change bumps `epoch`;
/// `sequence` keeps observations for the same member ordered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ObservationTicket {
    epoch: u64,
    sequence: u64,
}

/// Immutable view used while planning one request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct HealthSnapshot {
    pub(super) members: HashSet<String>,
    pub(super) providers: HashSet<String>,
}

impl HealthSnapshot {
    pub(super) fn is_unhealthy(&self, member: &str) -> bool {
        if self.members.contains(member) {
            return true;
        }
        let provider = member
            .split_once('/')
            .map_or(member, |(provider, _)| provider);
        self.providers.contains(provider)
    }

    #[cfg(test)]
    pub(super) fn for_test(members: &[&str], providers: &[&str]) -> Self {
        Self {
            members: members.iter().map(|member| (*member).to_string()).collect(),
            providers: providers
                .iter()
                .map(|provider| (*provider).to_string())
                .collect(),
        }
    }
}

#[derive(Clone, Debug)]
struct MemberHealth {
    failures: u32,
    block_level: u8,
    blocked_until: Option<DateTime<Utc>>,
    last_seen: DateTime<Utc>,
    last_sequence: u64,
    last_success: Option<DateTime<Utc>>,
}

impl MemberHealth {
    fn new(at: DateTime<Utc>, sequence: u64) -> Self {
        Self {
            failures: 0,
            block_level: 0,
            blocked_until: None,
            last_seen: at,
            last_sequence: sequence,
            last_success: None,
        }
    }

    fn record(&mut self, code: &str, at: DateTime<Utc>, sequence: u64, now: DateTime<Utc>) {
        self.last_seen = self.last_seen.max(at);
        self.last_sequence = sequence;
        if code == "answered" {
            self.failures = 0;
            self.block_level = 0;
            self.blocked_until = None;
            self.last_success = Some(self.last_success.map_or(at, |previous| previous.max(at)));
            return;
        }
        self.failures = self.failures.saturating_add(1);
        if self.failures >= DOWN_STREAK {
            let secs = BLOCK_BASE_SECS
                .saturating_mul(1_u64 << self.block_level.min(3))
                .min(BLOCK_MAX_SECS);
            self.blocked_until = Some(now + Duration::seconds(secs as i64));
            self.block_level = self.block_level.saturating_add(1).min(3);
        }
    }
}

#[derive(Default)]
struct RoutingState {
    epoch: u64,
    sequence: u64,
    members: HashMap<String, MemberHealth>,
}

/// In-memory routing health. Every method takes `&self`; the mutex is an
/// implementation detail so the gateway can share one instance without I/O.
#[derive(Default)]
pub(super) struct RoutingHealth {
    state: Mutex<RoutingState>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn parse_ts(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn expired(last_seen: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    last_seen > now || now - last_seen > Duration::minutes(OBSERVATION_TTL_MINUTES)
}

fn member_id(record: &LedgerRecord) -> Option<String> {
    if record.provider.is_empty()
        || record.upstream_model.is_empty()
        || record
            .provider
            .len()
            .saturating_add(record.upstream_model.len())
            .saturating_add(1)
            > MAX_ID_BYTES
    {
        return None;
    }
    Some(format!("{}/{}", record.provider, record.upstream_model))
}

impl RoutingHealth {
    pub(super) fn begin(&self) -> ObservationTicket {
        let mut state = lock(&self.state);
        state.sequence = state.sequence.saturating_add(1);
        ObservationTicket {
            epoch: state.epoch,
            sequence: state.sequence,
        }
    }

    pub(super) fn observe(
        &self,
        ticket: ObservationTicket,
        record: &LedgerRecord,
        now: DateTime<Utc>,
    ) {
        let Some(code) = row_code(record) else {
            return;
        };
        let Some(id) = member_id(record) else {
            return;
        };
        let Some(at) = parse_ts(&record.ts)
            .filter(|at| *at <= now && now - *at <= Duration::minutes(OBSERVATION_TTL_MINUTES))
        else {
            return;
        };

        let mut state = lock(&self.state);
        if ticket.epoch != state.epoch || ticket.sequence > state.sequence {
            return;
        }

        let reset = state
            .members
            .get(&id)
            .is_none_or(|member| expired(member.last_seen, now));
        if let Some(member) = state.members.get_mut(&id) {
            if ticket.sequence <= member.last_sequence {
                return;
            }
            if reset {
                *member = MemberHealth::new(at, ticket.sequence);
            }
            member.record(code, at, ticket.sequence, now);
            return;
        }

        if state.members.len() >= MAX_MEMBERS {
            state
                .members
                .retain(|_, member| !expired(member.last_seen, now));
        }
        if state.members.len() >= MAX_MEMBERS {
            if let Some(oldest) = state
                .members
                .iter()
                .min_by_key(|(id, member)| (member.last_sequence, id.as_str()))
                .map(|(id, _)| id.clone())
            {
                state.members.remove(&oldest);
            }
        }
        let mut member = MemberHealth::new(at, ticket.sequence.saturating_sub(1));
        member.record(code, at, ticket.sequence, now);
        state.members.insert(id, member);
    }

    /// A provider's key, endpoint or protocol changed. Outstanding tickets
    /// become invalid, and the changed provider's state is dropped so a
    /// repaired configuration starts clean.
    pub(super) fn invalidate_provider(&self, provider: &str) {
        let mut state = lock(&self.state);
        state.epoch = state.epoch.saturating_add(1);
        let prefix = format!("{provider}/");
        state.members.retain(|id, _| !id.starts_with(&prefix));
    }

    pub(super) fn snapshot(
        &self,
        probes: &HashMap<String, Vec<ProbeResult>>,
        now: DateTime<Utc>,
    ) -> HealthSnapshot {
        let mut state = lock(&self.state);
        state
            .members
            .retain(|_, member| !expired(member.last_seen, now));

        let mut members = HashSet::new();
        let mut latest_success: HashMap<String, DateTime<Utc>> = HashMap::new();
        for (id, member) in &state.members {
            if member.failures >= DOWN_STREAK
                && member
                    .blocked_until
                    .is_some_and(|blocked_until| blocked_until > now)
            {
                members.insert(id.clone());
            }
            if let (Some(success), Some((provider, _))) = (member.last_success, id.split_once('/'))
            {
                latest_success
                    .entry(provider.to_string())
                    .and_modify(|latest| *latest = (*latest).max(success))
                    .or_insert(success);
            }
        }

        let mut providers = HashSet::new();
        for (provider, results) in probes {
            let latest = results
                .iter()
                .filter_map(|result| {
                    parse_ts(&result.ts)
                        .filter(|at| *at <= now && now - *at <= Duration::seconds(PROBE_TTL_SECS))
                        .map(|at| (at, result))
                })
                .max_by_key(|(at, _)| *at);
            let Some((probe_at, probe)) = latest else {
                continue;
            };
            if !probe.failed() {
                continue;
            }
            if latest_success
                .get(provider)
                .is_some_and(|success| *success >= probe_at)
            {
                continue;
            }
            providers.insert(provider.clone());
        }

        HealthSnapshot { members, providers }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-25T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn record(at: DateTime<Utc>, provider: &str, model: &str, answered: bool) -> LedgerRecord {
        LedgerRecord {
            ts: at.to_rfc3339(),
            request_id: "r".into(),
            logical_request_id: None,
            agent: Some("codex".into()),
            session: None,
            endpoint: "responses".into(),
            provider: provider.into(),
            requested_model: format!("{provider}/{model}"),
            upstream_model: model.into(),
            wire: "responses".into(),
            stream: false,
            status: if answered { 200 } else { 502 },
            ok: answered,
            input: 1,
            output: 1,
            cache_read: 0,
            cache_write: 0,
            latency_ms: 1,
            error: (!answered).then(|| "上游返回 502".to_string()),
            group: None,
            member: None,
            context: None,
            first_token_ms: None,
        }
    }

    fn observe(health: &RoutingHealth, record: &LedgerRecord, at: DateTime<Utc>) {
        let ticket = health.begin();
        health.observe(ticket, record, at);
    }

    fn fail(health: &RoutingHealth, provider: &str, model: &str, at: DateTime<Utc>) {
        observe(health, &record(at, provider, model, false), at);
    }

    fn probe(ts: DateTime<Utc>, ok: bool, code: &'static str) -> ProbeResult {
        ProbeResult {
            ts: ts.to_rfc3339(),
            ok,
            status: Some(if ok { 200 } else { 503 }),
            latency_ms: 1,
            code,
            error: None,
        }
    }

    fn probes(provider: &str, result: ProbeResult) -> HashMap<String, Vec<ProbeResult>> {
        HashMap::from([(provider.to_string(), vec![result])])
    }

    #[test]
    fn threshold_and_member_isolation() {
        let health = RoutingHealth::default();
        let at = now();
        fail(&health, "a", "m1", at);
        fail(&health, "a", "m1", at);
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
        fail(&health, "a", "m1", at);
        let snapshot = health.snapshot(&HashMap::new(), at);
        assert!(snapshot.is_unhealthy("a/m1"));
        assert!(!snapshot.is_unhealthy("a/m2"));
        assert!(!snapshot.is_unhealthy("b/m1"));
    }

    #[test]
    fn backoff_doubles_caps_and_expires() {
        let health = RoutingHealth::default();
        let base = now();
        for _ in 0..3 {
            fail(&health, "a", "m1", base);
        }
        assert!(health
            .snapshot(&HashMap::new(), base + Duration::seconds(59))
            .is_unhealthy("a/m1"));
        assert!(!health
            .snapshot(&HashMap::new(), base + Duration::seconds(60))
            .is_unhealthy("a/m1"));

        let second = base + Duration::seconds(61);
        fail(&health, "a", "m1", second);
        assert!(health
            .snapshot(&HashMap::new(), second + Duration::seconds(119))
            .is_unhealthy("a/m1"));
        assert!(!health
            .snapshot(&HashMap::new(), second + Duration::seconds(120))
            .is_unhealthy("a/m1"));

        let third = base + Duration::seconds(182);
        fail(&health, "a", "m1", third);
        assert!(health
            .snapshot(&HashMap::new(), third + Duration::seconds(239))
            .is_unhealthy("a/m1"));
        assert!(!health
            .snapshot(&HashMap::new(), third + Duration::seconds(240))
            .is_unhealthy("a/m1"));

        let capped = base + Duration::seconds(423);
        fail(&health, "a", "m1", capped);
        assert!(health
            .snapshot(&HashMap::new(), capped + Duration::seconds(299))
            .is_unhealthy("a/m1"));
        assert!(!health
            .snapshot(&HashMap::new(), capped + Duration::seconds(300))
            .is_unhealthy("a/m1"));

        let stale = RoutingHealth::default();
        fail(&stale, "b", "m2", base);
        fail(&stale, "b", "m2", base);
        fail(
            &stale,
            "b",
            "m2",
            base + Duration::minutes(5) + Duration::seconds(1),
        );
        assert!(!stale
            .snapshot(&HashMap::new(), base + Duration::minutes(5))
            .is_unhealthy("b/m2"));
    }

    #[test]
    fn answered_recovers_and_resets_backoff() {
        let health = RoutingHealth::default();
        let at = now();
        for _ in 0..3 {
            fail(&health, "a", "m1", at);
        }
        assert!(health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
        observe(&health, &record(at, "a", "m1", true), at);
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
        fail(&health, "a", "m1", at);
        fail(&health, "a", "m1", at);
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
    }

    #[test]
    fn late_old_ticket_cannot_overwrite_new_success() {
        let health = RoutingHealth::default();
        let at = now();
        let old = health.begin();
        let newer = health.begin();
        health.observe(newer, &record(at, "a", "m1", true), at);
        health.observe(old, &record(at, "a", "m1", false), at);
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
    }

    #[test]
    fn repeated_ticket_is_counted_once() {
        let health = RoutingHealth::default();
        let at = now();
        let ticket = health.begin();
        let failure = record(at, "a", "m1", false);
        health.observe(ticket, &failure, at);
        health.observe(ticket, &failure, at);
        health.observe(ticket, &failure, at);
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
    }

    #[test]
    fn invalidation_drops_old_tickets_and_provider_state() {
        let health = RoutingHealth::default();
        let at = now();
        for _ in 0..3 {
            fail(&health, "a", "m1", at);
        }
        let old = health.begin();
        health.invalidate_provider("a");
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
        health.observe(old, &record(at, "a", "m1", false), at);
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));

        fail(&health, "a", "m1", at);
        fail(&health, "a", "m1", at);
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
    }

    #[test]
    fn invalid_future_and_stale_timestamps_are_ignored() {
        let health = RoutingHealth::default();
        let at = now();
        let mut invalid = record(at, "a", "m1", false);
        invalid.ts = "not a time".into();
        observe(&health, &invalid, at);
        observe(
            &health,
            &record(at + Duration::seconds(1), "a", "m1", false),
            at,
        );
        observe(
            &health,
            &record(
                at - Duration::minutes(5) - Duration::seconds(1),
                "a",
                "m1",
                false,
            ),
            at,
        );
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
    }

    #[test]
    fn snapshot_discards_future_state_after_clock_rollback() {
        let health = RoutingHealth::default();
        let at = now();
        for _ in 0..3 {
            fail(&health, "a", "m1", at + Duration::seconds(1));
        }
        assert!(health
            .snapshot(&HashMap::new(), at + Duration::seconds(1))
            .is_unhealthy("a/m1"));
        assert!(!health.snapshot(&HashMap::new(), at).is_unhealthy("a/m1"));
        assert!(lock(&health.state).members.is_empty());
    }

    #[test]
    fn probes_use_latest_verdict_and_respect_real_success() {
        let health = RoutingHealth::default();
        let at = now();
        let failed = probe(at, false, "upstream_failed");
        assert!(health
            .snapshot(&probes("a", failed.clone()), at)
            .is_unhealthy("a/m1"));

        let success = probe(at + Duration::seconds(1), true, "answered");
        assert!(!health
            .snapshot(&probes("a", success.clone()), at + Duration::seconds(1))
            .is_unhealthy("a/m1"));

        let mixed = HashMap::from([("a".to_string(), vec![success.clone(), failed.clone()])]);
        assert!(!health
            .snapshot(&mixed, at + Duration::seconds(1))
            .is_unhealthy("a/m1"));

        let unsupported = probe(at + Duration::seconds(2), false, "probe_unsupported");
        let mixed = HashMap::from([("a".to_string(), vec![unsupported, failed.clone()])]);
        assert!(!health
            .snapshot(&mixed, at + Duration::seconds(2))
            .is_unhealthy("a/m1"));

        assert!(!health
            .snapshot(&probes("a", failed.clone()), at + Duration::seconds(61))
            .is_unhealthy("a/m1"));

        observe(
            &health,
            &record(at + Duration::seconds(2), "a", "m1", true),
            at + Duration::seconds(2),
        );
        assert!(!health
            .snapshot(&probes("a", failed), at + Duration::seconds(2))
            .is_unhealthy("a/m1"));
    }

    #[test]
    fn successful_probe_does_not_clear_member_failures() {
        let health = RoutingHealth::default();
        let at = now();
        for _ in 0..3 {
            fail(&health, "a", "m1", at);
        }
        let success = probe(at, true, "answered");
        assert!(health
            .snapshot(&probes("a", success), at)
            .is_unhealthy("a/m1"));
    }

    #[test]
    fn state_is_bounded_and_long_ids_are_ignored() {
        let health = RoutingHealth::default();
        let at = now();
        for index in 0..=MAX_MEMBERS {
            fail(&health, &format!("p{index}"), "m", at);
        }
        assert!(lock(&health.state).members.len() <= MAX_MEMBERS);

        let long = RoutingHealth::default();
        let provider = "p".repeat(MAX_ID_BYTES);
        fail(&long, &provider, "m", at);
        fail(&long, &provider, "m", at);
        fail(&long, &provider, "m", at);
        assert!(lock(&long.state).members.is_empty());
    }
}
