//! Local quota alerts (REQ-QUOTA-07, U-110).
//!
//! Every time quota envelopes are produced (local read or local + cloud merge)
//! the fresh percent windows are compared with the user's thresholds. A
//! notification fires once per `providerId + scope + windowId + resetsAt +
//! tier`, at most once per source every 15 minutes and at most four times per
//! hour overall. Settings and dedup state live only in the app data directory.
//! Notification text carries the source name, window name, remaining percent
//! and reset time — never an account, amount or path.

use super::{
    QuotaProviderEnvelope, QuotaStatus, QuotaUnit, QuotaWindowSnapshot, QuotaWindowStatus,
};
use chrono::{DateTime, Duration, Local, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

const SETTINGS_FILE: &str = "quota_alert_settings.json";
const STATE_FILE: &str = "quota_alert_state.json";
const MAX_SETTINGS_BYTES: usize = 4 * 1024;
const MAX_STATE_BYTES: usize = 256 * 1024;
pub(crate) const DEFAULT_THRESHOLD: u8 = 20;
pub(crate) const ALLOWED_THRESHOLDS: [u8; 3] = [50, 20, 5];
const PER_SOURCE_INTERVAL_SECONDS: i64 = 15 * 60;
const GLOBAL_WINDOW_SECONDS: i64 = 60 * 60;
const GLOBAL_LIMIT: usize = 4;
const MAX_FUTURE_CLOCK_SKEW_SECONDS: i64 = 5 * 60;
/// Sources such as Codex derive `resetsAt` from "seconds until reset", so the
/// same cycle can drift by a few seconds between observations.
const RESET_JITTER_SECONDS: i64 = 10 * 60;
const FIRED_WITHOUT_RESET_RETENTION_DAYS: i64 = 30;
const MAX_FIRED_ENTRIES: usize = 512;
const MAX_LABEL_CHARS: usize = 32;

static EVALUATION_LOCK: Mutex<()> = Mutex::new(());
static NOTIFIER: OnceLock<Box<dyn AlertNotifier>> = OnceLock::new();

/// Delivery seam: production uses the Tauri notification plugin, tests record.
pub(crate) trait AlertNotifier: Send + Sync {
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
}

pub(crate) struct TauriNotifier(pub tauri::AppHandle);

impl AlertNotifier for TauriNotifier {
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        use tauri_plugin_notification::NotificationExt;
        // No sound: alerts stay silent and defer to the system's Do Not Disturb.
        self.0
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

pub(crate) fn install_notifier(notifier: Box<dyn AlertNotifier>) {
    let _ = NOTIFIER.set(notifier);
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaAlertSettings {
    pub enabled: bool,
    pub thresholds: Vec<u8>,
}

impl Default for QuotaAlertSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            thresholds: vec![DEFAULT_THRESHOLD],
        }
    }
}

impl QuotaAlertSettings {
    fn sanitized(mut self) -> Self {
        self.thresholds
            .retain(|value| ALLOWED_THRESHOLDS.contains(value));
        self.thresholds.sort_unstable_by(|a, b| b.cmp(a));
        self.thresholds.dedup();
        if self.thresholds.is_empty() {
            self.thresholds.push(DEFAULT_THRESHOLD);
        }
        self
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlertState {
    #[serde(default)]
    fired: Vec<FiredEntry>,
    #[serde(default)]
    sent: Vec<SentEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FiredEntry {
    provider_id: String,
    scope: String,
    window_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resets_at: Option<DateTime<Utc>>,
    threshold: u8,
    fired_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SentEntry {
    provider_id: String,
    sent_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlannedAlert {
    pub provider_id: String,
    pub title: String,
    pub body: String,
}

struct Candidate<'a> {
    provider: &'a QuotaProviderEnvelope,
    window: &'a QuotaWindowSnapshot,
    scope: String,
    resets_at: Option<DateTime<Utc>>,
    remaining: u8,
    crossed: Vec<u8>,
}

#[tauri::command]
pub fn get_quota_alert_settings(
    app_state: tauri::State<'_, std::sync::Arc<crate::app_paths::AppContext>>,
) -> Result<QuotaAlertSettings, String> {
    Ok(load_settings(app_state.inner().app_data_dir()))
}

#[tauri::command]
pub fn set_quota_alert_settings(
    app_state: tauri::State<'_, std::sync::Arc<crate::app_paths::AppContext>>,
    settings: QuotaAlertSettings,
) -> Result<QuotaAlertSettings, String> {
    let settings = settings.sanitized();
    let bytes = serde_json::to_vec(&settings).map_err(|error| error.to_string())?;
    super::write_private_app_data_file(app_state.inner().app_data_dir(), SETTINGS_FILE, &bytes)?;
    Ok(settings)
}

pub(crate) fn load_settings(app_data_dir: &Path) -> QuotaAlertSettings {
    super::read_private_app_data_file(app_data_dir, SETTINGS_FILE, MAX_SETTINGS_BYTES)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<QuotaAlertSettings>(&bytes).ok())
        .map(QuotaAlertSettings::sanitized)
        .unwrap_or_default()
}

fn load_state(app_data_dir: &Path) -> AlertState {
    super::read_private_app_data_file(app_data_dir, STATE_FILE, MAX_STATE_BYTES)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<AlertState>(&bytes).ok())
        .unwrap_or_default()
}

fn save_state(app_data_dir: &Path, state: &AlertState) {
    match serde_json::to_vec(state) {
        Ok(bytes) => {
            if let Err(error) = super::write_private_app_data_file(app_data_dir, STATE_FILE, &bytes)
            {
                log::warn!("quota alert state not saved: {error}");
            }
        }
        Err(error) => log::warn!("quota alert state not serialized: {error}"),
    }
}

/// Hook called after every envelope production. No-op until a notifier is
/// installed by the running app, so unit tests of other modules stay silent.
pub(crate) fn check_quota_alerts(
    app: &crate::app_paths::AppContext,
    providers: &[QuotaProviderEnvelope],
) {
    let Some(notifier) = NOTIFIER.get() else {
        return;
    };
    run_alerts(app.app_data_dir(), providers, Utc::now(), notifier.as_ref());
}

pub(crate) fn run_alerts(
    app_data_dir: &Path,
    providers: &[QuotaProviderEnvelope],
    now: DateTime<Utc>,
    notifier: &dyn AlertNotifier,
) -> Vec<PlannedAlert> {
    let settings = load_settings(app_data_dir);
    if !settings.enabled {
        return Vec::new();
    }
    let _guard = EVALUATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = load_state(app_data_dir);
    let before = state.clone();
    let planned = plan_alerts(&settings, &mut state, providers, now);
    if state != before {
        save_state(app_data_dir, &state);
    }
    for alert in &planned {
        if let Err(error) = notifier.notify(&alert.title, &alert.body) {
            log::warn!("quota alert notification failed: {error}");
        }
    }
    planned
}

pub(crate) fn plan_alerts(
    settings: &QuotaAlertSettings,
    state: &mut AlertState,
    providers: &[QuotaProviderEnvelope],
    now: DateTime<Utc>,
) -> Vec<PlannedAlert> {
    if !settings.enabled {
        return Vec::new();
    }
    prune(state, now);

    let mut candidates = Vec::new();
    for provider in providers {
        if provider.status != QuotaStatus::Ok {
            continue;
        }
        for window in &provider.windows {
            let Some(reading) = fresh_percent_reading(window, now) else {
                continue;
            };
            let scope = scope_key(window);
            // A window back above a tier re-arms it when the source gives no
            // reset time; windows with a reset time re-arm on the next cycle.
            if reading.1.is_none() {
                state.fired.retain(|entry| {
                    !(entry.resets_at.is_none()
                        && entry.provider_id == window.provider_id
                        && entry.scope == scope
                        && entry.window_id == window.window_id
                        && reading.0 >= entry.threshold)
                });
            }
            let crossed: Vec<u8> = settings
                .thresholds
                .iter()
                .copied()
                .filter(|threshold| reading.0 < *threshold)
                .collect();
            if crossed.is_empty() {
                continue;
            }
            candidates.push(Candidate {
                provider,
                window,
                scope,
                resets_at: reading.1,
                remaining: reading.0,
                crossed,
            });
        }
    }
    candidates.sort_by(|a, b| {
        a.remaining
            .cmp(&b.remaining)
            .then_with(|| a.window.provider_id.cmp(&b.window.provider_id))
            .then_with(|| a.window.window_id.cmp(&b.window.window_id))
    });

    let mut planned = Vec::new();
    for candidate in candidates {
        let unfired: Vec<u8> = candidate
            .crossed
            .iter()
            .copied()
            .filter(|threshold| !already_fired(state, &candidate, *threshold))
            .collect();
        if unfired.is_empty() {
            continue;
        }
        let provider_id = &candidate.window.provider_id;
        let source_recent = state.sent.iter().any(|sent| {
            &sent.provider_id == provider_id
                && (now - sent.sent_at).num_seconds() < PER_SOURCE_INTERVAL_SECONDS
        });
        let global_recent = state
            .sent
            .iter()
            .filter(|sent| (now - sent.sent_at).num_seconds() < GLOBAL_WINDOW_SECONDS)
            .count();
        // Rate-limited alerts stay unfired so a later fresh read can deliver them.
        if source_recent || global_recent >= GLOBAL_LIMIT {
            continue;
        }
        for threshold in unfired {
            state.fired.push(FiredEntry {
                provider_id: provider_id.clone(),
                scope: candidate.scope.clone(),
                window_id: candidate.window.window_id.clone(),
                resets_at: candidate.resets_at,
                threshold,
                fired_at: now,
            });
        }
        state.sent.push(SentEntry {
            provider_id: provider_id.clone(),
            sent_at: now,
        });
        let (title, body) = notification_text(
            candidate.provider,
            candidate.window,
            candidate.remaining,
            candidate.resets_at,
        );
        planned.push(PlannedAlert {
            provider_id: provider_id.clone(),
            title,
            body,
        });
    }
    if state.fired.len() > MAX_FIRED_ENTRIES {
        state.fired.sort_by_key(|entry| entry.fired_at);
        let excess = state.fired.len() - MAX_FIRED_ENTRIES;
        state.fired.drain(..excess);
    }
    planned
}

fn prune(state: &mut AlertState, now: DateTime<Utc>) {
    state.sent.retain(|sent| {
        let age = (now - sent.sent_at).num_seconds();
        (0..GLOBAL_WINDOW_SECONDS).contains(&age)
    });
    state.fired.retain(|entry| match entry.resets_at {
        Some(resets_at) => resets_at + Duration::seconds(RESET_JITTER_SECONDS) > now,
        None => now - entry.fired_at < Duration::days(FIRED_WITHOUT_RESET_RETENTION_DAYS),
    });
}

fn already_fired(state: &AlertState, candidate: &Candidate<'_>, threshold: u8) -> bool {
    state.fired.iter().any(|entry| {
        entry.threshold == threshold
            && entry.provider_id == candidate.window.provider_id
            && entry.scope == candidate.scope
            && entry.window_id == candidate.window.window_id
            && match (entry.resets_at, candidate.resets_at) {
                (Some(previous), Some(current)) => {
                    (previous - current).num_seconds().abs() <= RESET_JITTER_SECONDS
                }
                (None, None) => true,
                _ => false,
            }
    })
}

fn scope_key(window: &QuotaWindowSnapshot) -> String {
    serde_json::to_value(window.scope)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Same reading as the desktop panel (`readQuotaWindow`): only fresh percent
/// windows count; remaining is `100 - round(used)`. Stale by status, age or a
/// passed reset never alerts.
fn fresh_percent_reading(
    window: &QuotaWindowSnapshot,
    now: DateTime<Utc>,
) -> Option<(u8, Option<DateTime<Utc>>)> {
    if window.status != QuotaWindowStatus::Ok || window.unit != QuotaUnit::Percent {
        return None;
    }
    let used = window.used?;
    if !used.is_finite() || !(0.0..=100.0).contains(&used) {
        return None;
    }
    if window.limit.is_some_and(|limit| limit != 100.0) {
        return None;
    }
    let observed_at = DateTime::parse_from_rfc3339(&window.observed_at)
        .ok()?
        .with_timezone(&Utc);
    let age = (now - observed_at).num_seconds();
    if age < -MAX_FUTURE_CLOCK_SKEW_SECONDS
        || age >= i64::try_from(window.stale_after_seconds).unwrap_or(i64::MAX)
    {
        return None;
    }
    let resets_at = match window.resets_at.as_deref() {
        Some(value) => {
            let parsed = DateTime::parse_from_rfc3339(value)
                .ok()?
                .with_timezone(&Utc);
            if parsed <= now {
                return None;
            }
            Some(parsed)
        }
        None => None,
    };
    let remaining = (100.0 - used.round()).clamp(0.0, 100.0) as u8;
    Some((remaining, resets_at))
}

fn notification_text(
    provider: &QuotaProviderEnvelope,
    window: &QuotaWindowSnapshot,
    remaining: u8,
    resets_at: Option<DateTime<Utc>>,
) -> (String, String) {
    let source = source_name(provider);
    let title = format!("{source} 额度剩余 {remaining}%");
    let window_name = window_name(window);
    let body = match resets_at {
        Some(resets_at) => format!("{window_name} · {} 重置", reset_text(resets_at)),
        None => window_name,
    };
    (title, body)
}

fn source_name(provider: &QuotaProviderEnvelope) -> String {
    match provider.provider_id.as_str() {
        super::CODEX_PROVIDER_ID => "Codex".to_string(),
        super::CLAUDE_PROVIDER_ID => "Claude".to_string(),
        super::ANTIGRAVITY_PROVIDER_ID => "Antigravity".to_string(),
        _ => safe_label(&provider.display_name).unwrap_or_else(|| "额度来源".to_string()),
    }
}

fn window_name(window: &QuotaWindowSnapshot) -> String {
    match window.window_minutes {
        Some(300) => return "5 小时额度".to_string(),
        Some(1_440) => return "每日额度".to_string(),
        Some(10_080) => return "每周额度".to_string(),
        Some(minutes) if minutes > 0 && minutes % 1_440 == 0 => {
            return format!("{} 天额度", minutes / 1_440)
        }
        Some(minutes) if minutes > 0 && minutes % 60 == 0 => {
            return format!("{} 小时额度", minutes / 60)
        }
        _ => {}
    }
    safe_label(&window.window_label).unwrap_or_else(|| "额度窗口".to_string())
}

/// Free-form labels come from user configuration or upstream sources; reject
/// anything that could carry a path, URL, account or amount.
fn safe_label(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_LABEL_CHARS
        || trimmed.chars().any(|ch| {
            ch.is_control() || matches!(ch, '/' | '\\' | '@' | ':' | '$' | '¥' | '€' | '£' | '~')
        })
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn reset_text(resets_at: DateTime<Utc>) -> String {
    let local = resets_at.with_timezone(&Local);
    let today = Local::now().date_naive();
    if local.date_naive() == today {
        format!("今天 {}", local.format("%H:%M"))
    } else {
        local.format("%-m月%-d日 %H:%M").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::super::{QuotaCapability, QuotaMode, QuotaScope, QuotaSource};
    use super::*;
    use chrono::SecondsFormat;
    use std::sync::Mutex as StdMutex;

    fn rfc3339(value: DateTime<Utc>) -> String {
        value.to_rfc3339_opts(SecondsFormat::Secs, true)
    }

    #[derive(Default)]
    struct RecordingNotifier(StdMutex<Vec<(String, String)>>);

    impl AlertNotifier for RecordingNotifier {
        fn notify(&self, title: &str, body: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .push((title.to_string(), body.to_string()));
            Ok(())
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-04T04:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn window(provider_id: &str, window_id: &str, used: f64) -> QuotaWindowSnapshot {
        QuotaWindowSnapshot {
            provider_id: provider_id.to_string(),
            window_id: window_id.to_string(),
            window_label: "5h".to_string(),
            account_label: Some("someone@example.com".to_string()),
            scope: QuotaScope::ConsumerSubscription,
            source: QuotaSource::LocalAuthorized,
            status: QuotaWindowStatus::Ok,
            used: Some(used),
            limit: Some(100.0),
            remaining: Some(100.0 - used),
            unit: QuotaUnit::Percent,
            currency: None,
            window_minutes: Some(300),
            resets_at: Some(rfc3339(now() + Duration::hours(3))),
            observed_at: rfc3339(now() - Duration::minutes(1)),
            fetched_at: rfc3339(now() - Duration::minutes(1)),
            stale_after_seconds: 900,
            reason_code: None,
        }
    }

    fn provider(provider_id: &str, windows: Vec<QuotaWindowSnapshot>) -> QuotaProviderEnvelope {
        QuotaProviderEnvelope {
            schema_version: 1,
            provider_id: provider_id.to_string(),
            display_name: "Codex local usage".to_string(),
            scope: QuotaScope::ConsumerSubscription,
            mode: QuotaMode::Automatic,
            capability: QuotaCapability::Stable,
            status: QuotaStatus::Ok,
            windows,
            reason_code: None,
            action: None,
        }
    }

    fn enabled(thresholds: &[u8]) -> QuotaAlertSettings {
        QuotaAlertSettings {
            enabled: true,
            thresholds: thresholds.to_vec(),
        }
        .sanitized()
    }

    const CODEX: &str = super::super::CODEX_PROVIDER_ID;
    const CLAUDE: &str = super::super::CLAUDE_PROVIDER_ID;

    #[test]
    fn disabled_by_default_and_thresholds_are_closed_set() {
        let defaults = QuotaAlertSettings::default();
        assert!(!defaults.enabled);
        assert_eq!(defaults.thresholds, vec![20]);
        let mut state = AlertState::default();
        let providers = vec![provider(CODEX, vec![window(CODEX, "primary", 99.0)])];
        assert!(plan_alerts(&defaults, &mut state, &providers, now()).is_empty());
        assert_eq!(enabled(&[5, 7, 50, 20, 5]).thresholds, vec![50, 20, 5]);
        assert_eq!(enabled(&[1, 99]).thresholds, vec![20]);
    }

    #[test]
    fn fires_below_threshold_only() {
        let settings = enabled(&[20]);
        let mut state = AlertState::default();
        let at_threshold = vec![provider(CODEX, vec![window(CODEX, "primary", 80.0)])];
        assert!(plan_alerts(&settings, &mut state, &at_threshold, now()).is_empty());
        let below = vec![provider(CODEX, vec![window(CODEX, "primary", 81.0)])];
        let planned = plan_alerts(&settings, &mut state, &below, now());
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].title, "Codex 额度剩余 19%");
        assert!(planned[0].body.starts_with("5 小时额度 · "));
        assert!(planned[0].body.ends_with(" 重置"));
    }

    #[test]
    fn crossing_several_tiers_sends_most_severe_once_and_marks_all() {
        let settings = enabled(&[50, 20, 5]);
        let mut state = AlertState::default();
        let providers = vec![provider(CODEX, vec![window(CODEX, "primary", 97.0)])];
        let planned = plan_alerts(&settings, &mut state, &providers, now());
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].title, "Codex 额度剩余 3%");
        assert_eq!(state.fired.len(), 3);
        let later = now() + Duration::hours(2);
        let mut fresh = window(CODEX, "primary", 98.0);
        fresh.observed_at = rfc3339(later);
        let providers = vec![provider(CODEX, vec![fresh])];
        assert!(plan_alerts(&settings, &mut state, &providers, later).is_empty());
    }

    #[test]
    fn dedup_per_window_tier_and_reset_cycle() {
        let settings = enabled(&[50, 20]);
        let mut state = AlertState::default();
        let first = vec![provider(CODEX, vec![window(CODEX, "primary", 60.0)])];
        assert_eq!(plan_alerts(&settings, &mut state, &first, now()).len(), 1);

        // Same cycle with a few seconds of reset drift: no repeat for 50%.
        let t1 = now() + Duration::minutes(20);
        let mut drift = window(CODEX, "primary", 70.0);
        drift.observed_at = rfc3339(t1);
        drift.resets_at = Some(rfc3339(now() + Duration::hours(3) + Duration::seconds(4)));
        assert!(plan_alerts(&settings, &mut state, &[provider(CODEX, vec![drift])], t1).is_empty());

        // Same cycle, next tier: one more.
        let t2 = now() + Duration::minutes(40);
        let mut deeper = window(CODEX, "primary", 85.0);
        deeper.observed_at = rfc3339(t2);
        let planned = plan_alerts(&settings, &mut state, &[provider(CODEX, vec![deeper])], t2);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].title, "Codex 额度剩余 15%");

        // New reset cycle re-arms the same tiers.
        let t3 = now() + Duration::hours(4);
        let mut next_cycle = window(CODEX, "primary", 85.0);
        next_cycle.observed_at = rfc3339(t3);
        next_cycle.resets_at = Some(rfc3339(t3 + Duration::hours(5)));
        assert_eq!(
            plan_alerts(
                &settings,
                &mut state,
                &[provider(CODEX, vec![next_cycle])],
                t3
            )
            .len(),
            1
        );

        // A different window of the same source is a separate key.
        let t4 = t3 + Duration::minutes(16);
        let mut weekly = window(CODEX, "secondary", 85.0);
        weekly.window_minutes = Some(10_080);
        weekly.observed_at = rfc3339(t4);
        weekly.resets_at = Some(rfc3339(t4 + Duration::days(3)));
        let planned = plan_alerts(&settings, &mut state, &[provider(CODEX, vec![weekly])], t4);
        assert_eq!(planned.len(), 1);
        assert!(planned[0].body.starts_with("每周额度"));
    }

    #[test]
    fn window_without_reset_rearms_after_recovery() {
        let settings = enabled(&[20]);
        let mut state = AlertState::default();
        let mut low = window(CODEX, "primary", 90.0);
        low.resets_at = None;
        assert_eq!(
            plan_alerts(
                &settings,
                &mut state,
                &[provider(CODEX, vec![low.clone()])],
                now()
            )
            .len(),
            1
        );
        let t1 = now() + Duration::minutes(20);
        low.observed_at = rfc3339(t1);
        assert!(plan_alerts(
            &settings,
            &mut state,
            &[provider(CODEX, vec![low.clone()])],
            t1
        )
        .is_empty());
        let t2 = now() + Duration::minutes(40);
        let mut recovered = low.clone();
        recovered.used = Some(10.0);
        recovered.observed_at = rfc3339(t2);
        assert!(plan_alerts(
            &settings,
            &mut state,
            &[provider(CODEX, vec![recovered])],
            t2
        )
        .is_empty());
        let t3 = now() + Duration::minutes(60);
        low.observed_at = rfc3339(t3);
        let planned = plan_alerts(&settings, &mut state, &[provider(CODEX, vec![low])], t3);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].body, "5 小时额度");
    }

    #[test]
    fn one_alert_per_source_every_fifteen_minutes() {
        let settings = enabled(&[20]);
        let mut state = AlertState::default();
        let providers = vec![provider(
            CODEX,
            vec![
                window(CODEX, "primary", 90.0),
                window(CODEX, "secondary", 85.0),
            ],
        )];
        let planned = plan_alerts(&settings, &mut state, &providers, now());
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].title, "Codex 额度剩余 10%");

        let t1 = now() + Duration::minutes(14);
        let mut retry = providers.clone();
        for item in &mut retry[0].windows {
            item.observed_at = rfc3339(t1);
        }
        assert!(plan_alerts(&settings, &mut state, &retry, t1).is_empty());

        let t2 = now() + Duration::minutes(15);
        for item in &mut retry[0].windows {
            item.observed_at = rfc3339(t2);
        }
        let planned = plan_alerts(&settings, &mut state, &retry, t2);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].title, "Codex 额度剩余 15%");
    }

    #[test]
    fn at_most_four_alerts_per_hour_globally() {
        let settings = enabled(&[20]);
        let mut state = AlertState::default();
        let ids: Vec<String> = (0..6)
            .map(|index| format!("custom-source-{index}"))
            .collect();
        let providers: Vec<_> = ids
            .iter()
            .map(|id| provider(id, vec![window(id, "primary", 90.0)]))
            .collect();
        assert_eq!(
            plan_alerts(&settings, &mut state, &providers, now()).len(),
            4
        );

        let t1 = now() + Duration::minutes(59);
        let mut refreshed = providers.clone();
        for item in &mut refreshed {
            item.windows[0].observed_at = rfc3339(t1);
        }
        assert!(plan_alerts(&settings, &mut state, &refreshed, t1).is_empty());

        let t2 = now() + Duration::minutes(61);
        for item in &mut refreshed {
            item.windows[0].observed_at = rfc3339(t2);
        }
        assert_eq!(plan_alerts(&settings, &mut state, &refreshed, t2).len(), 2);
    }

    #[test]
    fn stale_snapshots_never_alert() {
        let settings = enabled(&[50, 20, 5]);
        let mut state = AlertState::default();

        let mut by_status = window(CODEX, "a", 99.0);
        by_status.status = QuotaWindowStatus::Stale;
        let mut by_age = window(CODEX, "b", 99.0);
        by_age.observed_at = rfc3339(now() - Duration::minutes(15));
        let mut by_reset = window(CODEX, "c", 99.0);
        by_reset.resets_at = Some(rfc3339(now() - Duration::minutes(1)));
        let mut future = window(CODEX, "d", 99.0);
        future.observed_at = rfc3339(now() + Duration::minutes(6));
        let mut stale_provider = provider(CLAUDE, vec![window(CLAUDE, "e", 99.0)]);
        stale_provider.status = QuotaStatus::Stale;
        let mut balance = window(CODEX, "f", 99.0);
        balance.unit = QuotaUnit::Currency;

        let providers = vec![
            provider(CODEX, vec![by_status, by_age, by_reset, future, balance]),
            stale_provider,
        ];
        assert!(plan_alerts(&settings, &mut state, &providers, now()).is_empty());
        assert!(state.fired.is_empty());
    }

    #[test]
    fn notification_text_has_no_account_amount_or_path() {
        let settings = enabled(&[20]);
        let mut state = AlertState::default();
        let mut custom = provider("custom-1", vec![]);
        custom.display_name = "/Users/me/.config/relay@corp $12".to_string();
        let mut item = window("custom-1", "w", 95.0);
        item.window_minutes = None;
        item.window_label = "acct someone@example.com".to_string();
        custom.windows = vec![item];
        let mut claude = provider(CLAUDE, vec![window(CLAUDE, "five-hour", 92.0)]);
        claude.display_name = "Claude consumer usage".to_string();
        let planned = plan_alerts(&settings, &mut state, &[custom, claude], now());
        assert_eq!(planned.len(), 2);
        assert_eq!(planned[0].title, "额度来源 额度剩余 5%");
        assert!(planned[0].body.starts_with("额度窗口 · "));
        assert_eq!(planned[1].title, "Claude 额度剩余 8%");
        for alert in &planned {
            let text = format!("{} {}", alert.title, alert.body);
            for forbidden in ["@", "/", "\\", "$", "¥", "someone", "Users", "example.com"] {
                assert!(!text.contains(forbidden), "{forbidden} leaked into {text}");
            }
        }
    }

    #[test]
    fn run_alerts_persists_dedup_and_uses_injected_notifier() {
        let root = std::env::temp_dir().join(format!(
            "tokenledger-alerts-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Cleanup(root);
        let dir = &dir.0;
        let notifier = RecordingNotifier::default();
        let providers = vec![provider(CODEX, vec![window(CODEX, "primary", 90.0)])];

        // Disabled: nothing is read, written or sent.
        assert!(run_alerts(dir, &providers, now(), &notifier).is_empty());
        assert!(!dir.join(STATE_FILE).exists());

        let bytes = serde_json::to_vec(&enabled(&[20])).unwrap();
        super::super::write_private_app_data_file(dir, SETTINGS_FILE, &bytes).unwrap();
        assert_eq!(run_alerts(dir, &providers, now(), &notifier).len(), 1);
        assert_eq!(notifier.0.lock().unwrap().len(), 1);

        // A new process instance reads the persisted dedup state.
        let t1 = now() + Duration::hours(1);
        let mut refreshed = providers.clone();
        refreshed[0].windows[0].observed_at = rfc3339(t1);
        assert!(run_alerts(dir, &refreshed, t1, &notifier).is_empty());
        assert_eq!(notifier.0.lock().unwrap().len(), 1);
        let state = std::fs::read_to_string(dir.join(STATE_FILE)).unwrap();
        assert!(!state.contains("someone"));
    }
}
