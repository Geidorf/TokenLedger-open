//! Usage anomaly detection.
//!
//! Looks only at usage that already happened on this computer (the same
//! merged local ledger the overview shows) and flags a handful of simple,
//! explainable patterns. Each rule compares a recent bucket with a median of
//! the period right before it:
//!
//! | Rule | Recent bucket | Baseline | Fires when |
//! |---|---|---|---|
//! | Token / cost spike (hour) | each hour of the last 24 | active hours of the 14 days before | ≥ 4× median and above a floor |
//! | Token / cost spike (day) | each day of the last 7 | active days of the 14 days before | ≥ 2.5× median and above a floor |
//! | Cache hit drop (day) | each day of the last 7 | daily hit rates of the 14 days before | ≥ 20 points below the median |
//! | Agent / model surge (day) | each entity-day of the last 7 | that entity's active days before | ≥ 3× median and above a floor |
//! | Expensive session | sessions active in the last 7 days | every session in the 21-day window | ≥ 5× median and above a floor |
//! | Gateway errors (hour) | each hour of the last 24 | attempts of the 7 days before | ≥ 20% failed and 15 points above baseline |
//!
//! Effective tokens are input + output (cache never added back). A bucket
//! whose cost has any unpriced row has no cost; it is skipped, never 0.
//! Nothing is extrapolated: an in-progress hour or day is judged on what it
//! already used, which can only grow.
//!
//! Notifications (off by default) reuse the quota/budget notifier, fire once
//! per finding, only for findings from the last few hours or today, and at
//! most three per hour. Their text carries a rule, a time and a ratio, never
//! an amount, path or session id.

use chrono::{DateTime, Duration, Local, NaiveDate, NaiveDateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Mutex;

use crate::app_paths::AppContext;
use crate::quota::alerts::AlertNotifier;

const SETTINGS_FILE: &str = "usage_anomaly_settings.json";
const STATE_FILE: &str = "usage_anomaly_alert_state.json";
const MAX_SETTINGS_BYTES: usize = 4 * 1024;
const MAX_STATE_BYTES: usize = 128 * 1024;

pub(crate) const BASELINE_DAYS: i64 = 14;
pub(crate) const RECENT_DAYS: i64 = 7;
pub(crate) const RECENT_HOURS: i64 = 24;
const GATEWAY_BASELINE_DAYS: i64 = 7;

const HOUR_RATIO: f64 = 4.0;
const DAY_RATIO: f64 = 2.5;
const ENTITY_RATIO: f64 = 3.0;
const SESSION_RATIO: f64 = 5.0;
const MIN_ACTIVE_HOURS: usize = 12;
const MIN_ACTIVE_DAYS: usize = 5;
const MIN_ENTITY_DAYS: usize = 3;
const MIN_SESSIONS: usize = 8;

const HOUR_TOKEN_FLOOR: f64 = 500_000.0;
const HOUR_COST_FLOOR: f64 = 2.0;
const DAY_TOKEN_FLOOR: f64 = 2_000_000.0;
const DAY_COST_FLOOR: f64 = 5.0;
const ENTITY_TOKEN_FLOOR: f64 = 2_000_000.0;
const SESSION_TOKEN_FLOOR: f64 = 3_000_000.0;
const SESSION_COST_FLOOR: f64 = 3.0;

/// Prompt tokens (input + cache read) a day needs before its hit rate counts.
const CACHE_DAY_FLOOR: f64 = 1_000_000.0;
const CACHE_BASELINE_DAY_FLOOR: f64 = 100_000.0;
const CACHE_DROP_POINTS: f64 = 0.20;

const GATEWAY_MIN_ATTEMPTS: u64 = 20;
const GATEWAY_BASELINE_MIN_ATTEMPTS: u64 = 50;
const GATEWAY_MIN_RATE: f64 = 0.20;
const GATEWAY_RISE_POINTS: f64 = 0.15;

const MAX_FINDINGS: usize = 24;
const MAX_SESSION_FINDINGS: usize = 3;
const MAX_ENTITY_FINDINGS: usize = 6;

const NOTIFY_RECENT_HOURS: i64 = 3;
const GLOBAL_WINDOW_SECONDS: i64 = 60 * 60;
const GLOBAL_LIMIT: usize = 3;
const FIRED_RETENTION_DAYS: i64 = 8;
const MAX_FIRED_ENTRIES: usize = 256;
const MAX_LABEL_CHARS: usize = 32;
/// The scheduler and every scan refresh call in; one evaluation per window.
const CHECK_INTERVAL_SECONDS: i64 = 5 * 60;

static EVALUATION_LOCK: Mutex<()> = Mutex::new(());
static LAST_CHECK: Mutex<Option<DateTime<Utc>>> = Mutex::new(None);

/// One deduplicated local ledger row, timestamp in local wall time.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct UsageRow {
    pub tool: String,
    pub model: String,
    pub at: NaiveDateTime,
    /// Real session id; `None` for rows without one or with a synthetic id.
    pub session_id: Option<String>,
    pub input: i64,
    pub output: i64,
    /// Cache reads; `None` when the source cannot tell reads from writes.
    pub cache_read: Option<i64>,
    /// Estimated USD; `None` when the row cannot be priced.
    pub cost: Option<f64>,
}

impl UsageRow {
    fn tokens(&self) -> f64 {
        (self.input + self.output) as f64
    }
}

/// One gateway attempt on this computer, local wall time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GatewayOutcome {
    pub at: NaiveDateTime,
    pub ok: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnomalyKind {
    TokenSpike,
    CostSpike,
    CacheHitDrop,
    ToolSurge,
    ModelSurge,
    ExpensiveSession,
    GatewayErrors,
}

impl AnomalyKind {
    const ALL: [Self; 7] = [
        Self::TokenSpike,
        Self::CostSpike,
        Self::CacheHitDrop,
        Self::ToolSurge,
        Self::ModelSurge,
        Self::ExpensiveSession,
        Self::GatewayErrors,
    ];

    fn key(self) -> &'static str {
        match self {
            Self::TokenSpike => "tokenSpike",
            Self::CostSpike => "costSpike",
            Self::CacheHitDrop => "cacheHitDrop",
            Self::ToolSurge => "toolSurge",
            Self::ModelSurge => "modelSurge",
            Self::ExpensiveSession => "expensiveSession",
            Self::GatewayErrors => "gatewayErrors",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Granularity {
    Hour,
    Day,
    Session,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AnomalyUnit {
    /// Effective tokens (input + output).
    Tokens,
    /// Estimated USD.
    Usd,
    /// A share between 0 and 1.
    Rate,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnomalyFinding {
    /// Stable across evaluations: kind, bucket and subject.
    pub id: String,
    pub kind: AnomalyKind,
    pub granularity: Granularity,
    /// `YYYY-MM-DD HH:00` for hours, `YYYY-MM-DD` for days, the session's
    /// last active day for sessions.
    pub bucket: String,
    /// Agent id, model name or session id; absent for overall rules.
    pub subject: Option<String>,
    /// The session's Agent.
    pub tool: Option<String>,
    pub value: f64,
    pub baseline: f64,
    /// `value / baseline`; absent for the cache hit drop.
    pub ratio: Option<f64>,
    pub unit: AnomalyUnit,
    /// The bucket is still accumulating (current hour, today, live session).
    pub in_progress: bool,
    /// Gateway attempts in the hour.
    pub sample: Option<u64>,
    /// Local time of the bucket's last usage; drives notification recency.
    #[serde(skip)]
    pub last_at: NaiveDateTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Evaluated,
    /// Too little history before the recent window for a stable median.
    InsufficientBaseline,
    /// The source does not exist here (no gateway ledger, no priced rows).
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnomalyCheck {
    pub kind: AnomalyKind,
    pub state: CheckState,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnomalyReport {
    pub generated_at: String,
    pub baseline_days: i64,
    pub recent_days: i64,
    pub recent_hours: i64,
    pub findings: Vec<AnomalyFinding>,
    pub checks: Vec<AnomalyCheck>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnomalySettings {
    #[serde(default)]
    pub notify: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlertState {
    #[serde(default)]
    fired: Vec<FiredEntry>,
    #[serde(default)]
    sent: Vec<DateTime<Utc>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FiredEntry {
    id: String,
    fired_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlannedAlert {
    pub id: String,
    pub title: String,
    pub body: String,
    /// Cost figures for webhooks that opted in; never in the notification.
    pub cost: Option<String>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_usage_anomalies(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
) -> Result<AnomalyReport, String> {
    let app = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || evaluate_local(&app, Local::now()))
        .await
        .map_err(|error| format!("get_usage_anomalies task panicked: {error}"))?
}

#[tauri::command]
pub fn get_usage_anomaly_settings(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
) -> Result<AnomalySettings, String> {
    Ok(load_settings(app_state.inner().app_data_dir()))
}

#[tauri::command]
pub async fn set_usage_anomaly_settings(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
    settings: AnomalySettings,
) -> Result<AnomalySettings, String> {
    let app = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let was_on = load_settings(app.app_data_dir()).notify;
        if settings.notify && !was_on {
            // Turning it on must not replay findings already on screen as a
            // burst of notifications. They are marked delivered before the
            // setting is saved, so a background check cannot see the new
            // setting first.
            match evaluate_local(&app, Local::now()) {
                Ok(report) => mark_delivered(app.app_data_dir(), &report.findings, Utc::now()),
                Err(error) => log::debug!("usage anomaly seed skipped: {error}"),
            }
        }
        save_settings(app.app_data_dir(), &settings)?;
        Ok(settings)
    })
    .await
    .map_err(|error| format!("set_usage_anomaly_settings task panicked: {error}"))?
}

pub(crate) fn load_settings(app_data_dir: &Path) -> AnomalySettings {
    crate::quota::read_private_app_data_file(app_data_dir, SETTINGS_FILE, MAX_SETTINGS_BYTES)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<AnomalySettings>(&bytes).ok())
        .unwrap_or_default()
}

fn save_settings(app_data_dir: &Path, settings: &AnomalySettings) -> Result<(), String> {
    let bytes = serde_json::to_vec(settings).map_err(|error| error.to_string())?;
    crate::quota::write_private_app_data_file(app_data_dir, SETTINGS_FILE, &bytes)
}

fn load_state(app_data_dir: &Path) -> AlertState {
    crate::quota::read_private_app_data_file(app_data_dir, STATE_FILE, MAX_STATE_BYTES)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<AlertState>(&bytes).ok())
        .unwrap_or_default()
}

fn save_state(app_data_dir: &Path, state: &AlertState) {
    match serde_json::to_vec(state) {
        Ok(bytes) => {
            if let Err(error) =
                crate::quota::write_private_app_data_file(app_data_dir, STATE_FILE, &bytes)
            {
                log::warn!("usage anomaly alert state not saved: {error}");
            }
        }
        Err(error) => log::warn!("usage anomaly alert state not serialized: {error}"),
    }
}

/// Start of the read window: the recent days plus their baseline.
fn window_start(today: NaiveDate) -> NaiveDate {
    today - Duration::days(RECENT_DAYS + BASELINE_DAYS - 1)
}

fn evaluate_local(app: &AppContext, now: DateTime<Local>) -> Result<AnomalyReport, String> {
    let today = now.date_naive();
    let rows = crate::commands::anomaly_rows::local_usage_rows(app, window_start(today), now)?;
    let gateway_since = hour_floor(now.naive_local())
        - Duration::hours(RECENT_HOURS - 1)
        - Duration::days(GATEWAY_BASELINE_DAYS);
    // A broken gateway ledger only disables its own check.
    let outcomes = crate::commands::anomaly_rows::local_gateway_outcomes(app, gateway_since)
        .unwrap_or_else(|error| {
            log::debug!("usage anomaly gateway outcomes unavailable: {error}");
            None
        });
    let mut report = detect(&rows, outcomes.as_deref(), now.naive_local());
    report.generated_at = now.with_timezone(&Utc).to_rfc3339();
    Ok(report)
}

/// Hook called from the tray refresh. Cheap when notifications are off;
/// otherwise evaluates at most once per `CHECK_INTERVAL_SECONDS`.
pub(crate) fn check_anomaly_alerts(app: &AppContext) {
    let settings = load_settings(app.app_data_dir());
    if !settings.notify {
        return;
    }
    let now = Utc::now();
    {
        let mut last = LAST_CHECK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|last| (now - last).num_seconds() < CHECK_INTERVAL_SECONDS) {
            return;
        }
        *last = Some(now);
    }
    let Some(notifier) = crate::quota::alerts::notifier() else {
        return;
    };
    match evaluate_local(app, Local::now()) {
        Ok(report) => {
            run_alerts(
                app.app_data_dir(),
                &settings,
                &report.findings,
                Local::now().naive_local(),
                now,
                notifier,
            );
        }
        Err(error) => log::debug!("usage anomaly check skipped: {error}"),
    }
}

pub(crate) fn run_alerts(
    app_data_dir: &Path,
    settings: &AnomalySettings,
    findings: &[AnomalyFinding],
    local_now: NaiveDateTime,
    now: DateTime<Utc>,
    notifier: &dyn AlertNotifier,
) -> Vec<PlannedAlert> {
    let _guard = EVALUATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = load_state(app_data_dir);
    let before = state.clone();
    let planned = plan_alerts(settings, &mut state, findings, local_now, now);
    if state != before {
        save_state(app_data_dir, &state);
    }
    for alert in &planned {
        if let Err(error) = notifier.notify(&alert.title, &alert.body) {
            log::warn!("usage anomaly notification failed: {error}");
        }
        crate::alert_webhook::forward(
            app_data_dir,
            crate::alert_webhook::AlertKind::Anomaly,
            &alert.title,
            &alert.body,
            alert.cost.as_deref(),
        );
    }
    planned
}

fn mark_delivered(app_data_dir: &Path, findings: &[AnomalyFinding], now: DateTime<Utc>) {
    let _guard = EVALUATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = load_state(app_data_dir);
    for finding in findings {
        if !state.fired.iter().any(|entry| entry.id == finding.id) {
            state.fired.push(FiredEntry {
                id: finding.id.clone(),
                fired_at: now,
            });
        }
    }
    trim_fired(&mut state);
    save_state(app_data_dir, &state);
}

fn trim_fired(state: &mut AlertState) {
    if state.fired.len() > MAX_FIRED_ENTRIES {
        state.fired.sort_by_key(|entry| entry.fired_at);
        let excess = state.fired.len() - MAX_FIRED_ENTRIES;
        state.fired.drain(..excess);
    }
}

/// Picks the findings to notify about now and records them as fired.
pub(crate) fn plan_alerts(
    settings: &AnomalySettings,
    state: &mut AlertState,
    findings: &[AnomalyFinding],
    local_now: NaiveDateTime,
    now: DateTime<Utc>,
) -> Vec<PlannedAlert> {
    state
        .sent
        .retain(|sent| (0..GLOBAL_WINDOW_SECONDS).contains(&(now - *sent).num_seconds()));
    state
        .fired
        .retain(|entry| now - entry.fired_at < Duration::days(FIRED_RETENTION_DAYS));
    if !settings.notify {
        return Vec::new();
    }
    let mut planned = Vec::new();
    for finding in findings
        .iter()
        .filter(|finding| is_recent(finding, local_now))
    {
        if state.fired.iter().any(|entry| entry.id == finding.id) {
            continue;
        }
        if state.sent.len() >= GLOBAL_LIMIT {
            // Left unfired so a later check delivers it while still recent.
            break;
        }
        state.fired.push(FiredEntry {
            id: finding.id.clone(),
            fired_at: now,
        });
        state.sent.push(now);
        let (title, body) = notification_text(finding, local_now.date());
        planned.push(PlannedAlert {
            id: finding.id.clone(),
            title,
            body,
            cost: cost_text(finding),
        });
    }
    trim_fired(state);
    planned
}

/// Only fresh findings notify: hours and sessions used in the last few
/// hours, days that are today. Older ones stay on the overview.
fn is_recent(finding: &AnomalyFinding, local_now: NaiveDateTime) -> bool {
    match finding.granularity {
        Granularity::Day => finding.last_at.date() == local_now.date(),
        Granularity::Hour | Granularity::Session => {
            local_now - finding.last_at <= Duration::hours(NOTIFY_RECENT_HOURS)
        }
    }
}

fn notification_text(finding: &AnomalyFinding, today: NaiveDate) -> (String, String) {
    let ratio = finding
        .ratio
        .map(|ratio| format!("{:.1}", (ratio * 10.0).floor() / 10.0));
    let when = match finding.granularity {
        Granularity::Hour => {
            let day = if finding.last_at.date() == today {
                "今天"
            } else {
                "昨天"
            };
            format!("{day} {}", finding.bucket.get(11..16).unwrap_or(""))
        }
        _ => "今天".to_string(),
    };
    let subject = |fallback: &str| -> String {
        let raw = match finding.kind {
            AnomalyKind::ToolSurge | AnomalyKind::ExpensiveSession => finding
                .tool
                .as_deref()
                .or(finding.subject.as_deref())
                .map(crate::wallpaper::tool_display_name)
                .unwrap_or_default(),
            _ => finding.subject.clone().unwrap_or_default(),
        };
        safe_label(&raw).unwrap_or_else(|| fallback.to_string())
    };
    let ratio = ratio.unwrap_or_default();
    match finding.kind {
        AnomalyKind::TokenSpike => (
            "用量异常：Token 突增".to_string(),
            format!("{when} 的有效 Token 是平时的 {ratio} 倍"),
        ),
        AnomalyKind::CostSpike => (
            "用量异常：费用突增".to_string(),
            format!("{when} 的预估费用是平时的 {ratio} 倍"),
        ),
        AnomalyKind::CacheHitDrop => (
            "用量异常：缓存命中率骤降".to_string(),
            format!(
                "今天缓存命中率比平时低 {:.0} 个百分点",
                ((finding.baseline - finding.value) * 100.0).floor()
            ),
        ),
        AnomalyKind::ToolSurge => (
            format!("用量异常：{} 放量", subject("Agent")),
            format!("今天的有效 Token 是它平时的 {ratio} 倍"),
        ),
        AnomalyKind::ModelSurge => (
            format!("用量异常：{} 放量", subject("某个模型")),
            format!("今天的有效 Token 是它平时的 {ratio} 倍"),
        ),
        AnomalyKind::ExpensiveSession => {
            let metric = match finding.unit {
                AnomalyUnit::Usd => "预估费用",
                _ => "有效 Token",
            };
            (
                "用量异常：会话异常昂贵".to_string(),
                format!(
                    "{} 有一个会话的{metric}是常见会话的 {ratio} 倍",
                    subject("Agent")
                ),
            )
        }
        AnomalyKind::GatewayErrors => (
            "用量异常：网关错误率突增".to_string(),
            format!(
                "{when} 有 {:.0}% 的网关请求失败",
                (finding.value * 100.0).floor()
            ),
        ),
    }
}

/// Cost figures for opted-in webhooks: only findings measured in dollars.
fn cost_text(finding: &AnomalyFinding) -> Option<String> {
    if finding.unit != AnomalyUnit::Usd {
        return None;
    }
    let (value, baseline) = (finding.value, finding.baseline);
    match finding.kind {
        AnomalyKind::ExpensiveSession => Some(format!(
            "这个会话预估费用 ${value:.2}，常见会话约 ${baseline:.2}"
        )),
        _ => Some(format!("预估费用 ${value:.2}，平时约 ${baseline:.2}")),
    }
}

/// Model names come from logs; reject anything that could carry a path,
/// URL, account or amount, like the budget notifications do.
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

// ---------------------------------------------------------------------------
// Detection (pure)
// ---------------------------------------------------------------------------

fn hour_floor(at: NaiveDateTime) -> NaiveDateTime {
    at.date().and_hms_opt(at.hour(), 0, 0).unwrap_or(at)
}

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    Some(if values.len().is_multiple_of(2) {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    })
}

fn round(value: f64, places: i32) -> f64 {
    let scale = 10f64.powi(places);
    (value * scale).round() / scale
}

#[derive(Clone)]
struct Bucket {
    tokens: f64,
    /// `None` once any row in the bucket is unpriced.
    cost: Option<f64>,
    input: f64,
    /// `None` once any row cannot split cache reads from writes, so the
    /// bucket has no hit rate (its tokens and cost still count).
    cache_read: Option<f64>,
    last_at: Option<NaiveDateTime>,
}

impl Default for Bucket {
    fn default() -> Self {
        Self {
            tokens: 0.0,
            cost: Some(0.0),
            input: 0.0,
            cache_read: Some(0.0),
            last_at: None,
        }
    }
}

impl Bucket {
    fn add(&mut self, row: &UsageRow) {
        self.tokens += row.tokens();
        self.cost = match (self.cost, row.cost) {
            (Some(sum), Some(cost)) => Some(sum + cost).filter(|sum| sum.is_finite()),
            _ => None,
        };
        self.input += row.input as f64;
        self.cache_read = match (self.cache_read, row.cache_read) {
            (Some(sum), Some(read)) => Some(sum + read as f64),
            _ => None,
        };
        self.last_at = Some(self.last_at.map_or(row.at, |last| last.max(row.at)));
    }
}

struct SpikeRule {
    kind: AnomalyKind,
    granularity: Granularity,
    ratio: f64,
    floor: f64,
    min_points: usize,
    unit: AnomalyUnit,
}

/// Flags recent buckets at or above `ratio` × the median of the active
/// baseline buckets and at or above `floor`. Returns whether a baseline
/// existed.
fn spike_findings<K: Ord + Clone>(
    rule: &SpikeRule,
    baseline: &[f64],
    recent: &[(K, String, f64, NaiveDateTime, bool)],
    subject: Option<&str>,
    out: &mut Vec<AnomalyFinding>,
) -> bool {
    let mut active: Vec<f64> = baseline.iter().copied().filter(|v| *v > 0.0).collect();
    if active.len() < rule.min_points {
        return false;
    }
    let Some(median) = median(&mut active).filter(|median| *median > 0.0) else {
        return false;
    };
    for (_, bucket, value, last_at, in_progress) in recent {
        if *value < rule.floor || *value < median * rule.ratio {
            continue;
        }
        out.push(AnomalyFinding {
            id: format!("{}:{}:{}", rule.kind.key(), bucket, subject.unwrap_or("")),
            kind: rule.kind,
            granularity: rule.granularity,
            bucket: bucket.clone(),
            subject: subject.map(str::to_string),
            tool: None,
            value: round(*value, if rule.unit == AnomalyUnit::Usd { 4 } else { 0 }),
            baseline: round(median, if rule.unit == AnomalyUnit::Usd { 4 } else { 0 }),
            ratio: Some(round(value / median, 1)),
            unit: rule.unit,
            in_progress: *in_progress,
            sample: None,
            last_at: *last_at,
        });
    }
    true
}

/// Runs every rule over rows already limited to the read window.
pub(crate) fn detect(
    rows: &[UsageRow],
    outcomes: Option<&[GatewayOutcome]>,
    now: NaiveDateTime,
) -> AnomalyReport {
    let today = now.date();
    let current_hour = hour_floor(now);
    let recent_hour_start = current_hour - Duration::hours(RECENT_HOURS - 1);
    let hour_baseline_start = recent_hour_start - Duration::days(BASELINE_DAYS);
    let recent_day_start = today - Duration::days(RECENT_DAYS - 1);
    let day_baseline_start = recent_day_start - Duration::days(BASELINE_DAYS);
    let rows: Vec<&UsageRow> = rows
        .iter()
        .filter(|row| row.at <= now && row.at.date() >= day_baseline_start)
        .collect();

    let mut hours: BTreeMap<NaiveDateTime, Bucket> = BTreeMap::new();
    let mut days: BTreeMap<NaiveDate, Bucket> = BTreeMap::new();
    let mut tools: HashMap<&str, BTreeMap<NaiveDate, Bucket>> = HashMap::new();
    let mut models: HashMap<&str, BTreeMap<NaiveDate, Bucket>> = HashMap::new();
    for row in &rows {
        let hour = hour_floor(row.at);
        if hour >= hour_baseline_start {
            hours.entry(hour).or_default().add(row);
        }
        days.entry(row.at.date()).or_default().add(row);
        tools
            .entry(row.tool.as_str())
            .or_default()
            .entry(row.at.date())
            .or_default()
            .add(row);
        models
            .entry(row.model.as_str())
            .or_default()
            .entry(row.at.date())
            .or_default()
            .add(row);
    }

    let mut findings = Vec::new();
    let mut checks: BTreeMap<AnomalyKind, CheckState> = BTreeMap::new();
    let mark = |kind: AnomalyKind, evaluated: bool, checks: &mut BTreeMap<_, _>| {
        let state = if evaluated {
            CheckState::Evaluated
        } else {
            CheckState::InsufficientBaseline
        };
        let entry = checks.entry(kind).or_insert(state);
        if evaluated {
            *entry = CheckState::Evaluated;
        }
    };

    // Hour and day spikes, tokens then cost.
    let hour_recent = |pick: &dyn Fn(&Bucket) -> Option<f64>| {
        hours
            .range(recent_hour_start..)
            .filter_map(|(hour, bucket)| {
                Some((
                    *hour,
                    hour.format("%Y-%m-%d %H:00").to_string(),
                    pick(bucket)?,
                    bucket.last_at.unwrap_or(*hour),
                    *hour == current_hour,
                ))
            })
            .collect::<Vec<_>>()
    };
    let hour_baseline = |pick: &dyn Fn(&Bucket) -> Option<f64>| {
        hours
            .range(..recent_hour_start)
            .filter_map(|(_, bucket)| pick(bucket))
            .collect::<Vec<_>>()
    };
    let day_recent = |series: &BTreeMap<NaiveDate, Bucket>,
                      pick: &dyn Fn(&Bucket) -> Option<f64>| {
        series
            .range(recent_day_start..)
            .filter_map(|(day, bucket)| {
                Some((
                    *day,
                    day.format("%Y-%m-%d").to_string(),
                    pick(bucket)?,
                    bucket
                        .last_at
                        .unwrap_or_else(|| day.and_hms_opt(0, 0, 0).unwrap_or(now)),
                    *day == today,
                ))
            })
            .collect::<Vec<_>>()
    };
    let day_baseline = |series: &BTreeMap<NaiveDate, Bucket>,
                        pick: &dyn Fn(&Bucket) -> Option<f64>| {
        series
            .range(..recent_day_start)
            .filter_map(|(_, bucket)| pick(bucket))
            .collect::<Vec<_>>()
    };
    let tokens = |bucket: &Bucket| Some(bucket.tokens);
    let cost = |bucket: &Bucket| bucket.cost;

    for (kind, pick, hour_floor_value, day_floor_value, unit) in [
        (
            AnomalyKind::TokenSpike,
            &tokens as &dyn Fn(&Bucket) -> Option<f64>,
            HOUR_TOKEN_FLOOR,
            DAY_TOKEN_FLOOR,
            AnomalyUnit::Tokens,
        ),
        (
            AnomalyKind::CostSpike,
            &cost as &dyn Fn(&Bucket) -> Option<f64>,
            HOUR_COST_FLOOR,
            DAY_COST_FLOOR,
            AnomalyUnit::Usd,
        ),
    ] {
        let hour_rule = SpikeRule {
            kind,
            granularity: Granularity::Hour,
            ratio: HOUR_RATIO,
            floor: hour_floor_value,
            min_points: MIN_ACTIVE_HOURS,
            unit,
        };
        let evaluated_hours = spike_findings(
            &hour_rule,
            &hour_baseline(pick),
            &hour_recent(pick),
            None,
            &mut findings,
        );
        let day_rule = SpikeRule {
            kind,
            granularity: Granularity::Day,
            ratio: DAY_RATIO,
            floor: day_floor_value,
            min_points: MIN_ACTIVE_DAYS,
            unit,
        };
        let evaluated_days = spike_findings(
            &day_rule,
            &day_baseline(&days, pick),
            &day_recent(&days, pick),
            None,
            &mut findings,
        );
        mark(kind, evaluated_hours || evaluated_days, &mut checks);
    }
    // A day that is already flagged per hour is still worth its own card:
    // the day view tells whether the spike was a blip or a whole day.

    // Cost spikes need priced history; unpriced history is "unavailable".
    if !rows.iter().any(|row| row.cost.is_some()) {
        checks.insert(AnomalyKind::CostSpike, CheckState::Unavailable);
    }

    // Cache hit rate drop (daily).
    {
        let rate = |bucket: &Bucket, floor: f64| {
            let cache_read = bucket.cache_read?;
            let prompt = bucket.input + cache_read;
            (prompt >= floor).then(|| cache_read / prompt)
        };
        let mut baseline: Vec<f64> = days
            .range(..recent_day_start)
            .filter_map(|(_, bucket)| rate(bucket, CACHE_BASELINE_DAY_FLOOR))
            .collect();
        let evaluated = baseline.len() >= MIN_ACTIVE_DAYS;
        if let Some(median) = median(&mut baseline).filter(|_| evaluated) {
            for (day, bucket) in days.range(recent_day_start..) {
                let Some(value) = rate(bucket, CACHE_DAY_FLOOR) else {
                    continue;
                };
                if median - value < CACHE_DROP_POINTS {
                    continue;
                }
                let bucket_key = day.format("%Y-%m-%d").to_string();
                findings.push(AnomalyFinding {
                    id: format!("{}:{bucket_key}:", AnomalyKind::CacheHitDrop.key()),
                    kind: AnomalyKind::CacheHitDrop,
                    granularity: Granularity::Day,
                    bucket: bucket_key,
                    subject: None,
                    tool: None,
                    value: round(value, 4),
                    baseline: round(median, 4),
                    ratio: None,
                    unit: AnomalyUnit::Rate,
                    in_progress: *day == today,
                    sample: None,
                    last_at: bucket.last_at.unwrap_or(now),
                });
            }
        }
        mark(AnomalyKind::CacheHitDrop, evaluated, &mut checks);
    }

    // Agent and model surges (daily, per entity's own baseline).
    for (kind, series) in [
        (AnomalyKind::ToolSurge, &tools),
        (AnomalyKind::ModelSurge, &models),
    ] {
        let mut entity_findings = Vec::new();
        let mut evaluated = false;
        let mut names: Vec<&&str> = series.keys().collect();
        names.sort();
        for name in names {
            let days = &series[*name];
            let rule = SpikeRule {
                kind,
                granularity: Granularity::Day,
                ratio: ENTITY_RATIO,
                floor: ENTITY_TOKEN_FLOOR,
                min_points: MIN_ENTITY_DAYS,
                unit: AnomalyUnit::Tokens,
            };
            evaluated |= spike_findings(
                &rule,
                &day_baseline(days, &tokens),
                &day_recent(days, &tokens),
                Some(name),
                &mut entity_findings,
            );
        }
        if kind == AnomalyKind::ToolSurge {
            for finding in &mut entity_findings {
                finding.tool = finding.subject.clone();
            }
        }
        sort_findings(&mut entity_findings);
        entity_findings.truncate(MAX_ENTITY_FINDINGS);
        findings.extend(entity_findings);
        mark(kind, evaluated, &mut checks);
    }

    // Expensive sessions: the whole window's sessions form the baseline.
    {
        let mut sessions: HashMap<(&str, &str), Bucket> = HashMap::new();
        for row in &rows {
            if let Some(id) = row.session_id.as_deref() {
                sessions
                    .entry((row.tool.as_str(), id))
                    .or_default()
                    .add(row);
            }
        }
        let mut costs: Vec<f64> = sessions.values().filter_map(|s| s.cost).collect();
        let mut token_values: Vec<f64> = sessions.values().map(|s| s.tokens).collect();
        let cost_median = (costs.len() >= MIN_SESSIONS)
            .then(|| median(&mut costs))
            .flatten()
            .filter(|median| *median > 0.0);
        let token_median = (token_values.len() >= MIN_SESSIONS)
            .then(|| median(&mut token_values))
            .flatten()
            .filter(|median| *median > 0.0);
        let mut session_findings = Vec::new();
        for ((tool, id), session) in &sessions {
            let Some(last_at) = session.last_at else {
                continue;
            };
            if last_at.date() < recent_day_start {
                continue;
            }
            let (value, baseline, unit, floor) = match (session.cost, cost_median) {
                (Some(cost), Some(median)) => (cost, median, AnomalyUnit::Usd, SESSION_COST_FLOOR),
                _ => match token_median {
                    Some(median) => (
                        session.tokens,
                        median,
                        AnomalyUnit::Tokens,
                        SESSION_TOKEN_FLOOR,
                    ),
                    None => continue,
                },
            };
            if value < floor || value < baseline * SESSION_RATIO {
                continue;
            }
            let places = if unit == AnomalyUnit::Usd { 4 } else { 0 };
            session_findings.push(AnomalyFinding {
                id: format!("{}:{tool}:{id}", AnomalyKind::ExpensiveSession.key()),
                kind: AnomalyKind::ExpensiveSession,
                granularity: Granularity::Session,
                bucket: last_at.format("%Y-%m-%d").to_string(),
                subject: Some((*id).to_string()),
                tool: Some((*tool).to_string()),
                value: round(value, places),
                baseline: round(baseline, places),
                ratio: Some(round(value / baseline, 1)),
                unit,
                in_progress: now - last_at <= Duration::hours(1),
                sample: None,
                last_at,
            });
        }
        sort_findings(&mut session_findings);
        session_findings.truncate(MAX_SESSION_FINDINGS);
        findings.extend(session_findings);
        mark(
            AnomalyKind::ExpensiveSession,
            cost_median.is_some() || token_median.is_some(),
            &mut checks,
        );
    }

    // Gateway error rate (hourly).
    match outcomes {
        None => {
            checks.insert(AnomalyKind::GatewayErrors, CheckState::Unavailable);
        }
        Some(outcomes) => {
            let baseline_start = recent_hour_start - Duration::days(GATEWAY_BASELINE_DAYS);
            let (mut base_total, mut base_failed) = (0u64, 0u64);
            let mut recent: BTreeMap<NaiveDateTime, (u64, u64, NaiveDateTime)> = BTreeMap::new();
            for outcome in outcomes
                .iter()
                .filter(|o| o.at <= now && o.at >= baseline_start)
            {
                if outcome.at < recent_hour_start {
                    base_total += 1;
                    base_failed += u64::from(!outcome.ok);
                } else {
                    let entry = recent
                        .entry(hour_floor(outcome.at))
                        .or_insert((0, 0, outcome.at));
                    entry.0 += 1;
                    entry.1 += u64::from(!outcome.ok);
                    entry.2 = entry.2.max(outcome.at);
                }
            }
            // Without enough history the absolute 20% bar still applies.
            let base_rate = if base_total >= GATEWAY_BASELINE_MIN_ATTEMPTS {
                base_failed as f64 / base_total as f64
            } else {
                0.0
            };
            for (hour, (total, failed, last_at)) in recent {
                if total < GATEWAY_MIN_ATTEMPTS {
                    continue;
                }
                let rate = failed as f64 / total as f64;
                if rate < GATEWAY_MIN_RATE || rate - base_rate < GATEWAY_RISE_POINTS {
                    continue;
                }
                let bucket = hour.format("%Y-%m-%d %H:00").to_string();
                findings.push(AnomalyFinding {
                    id: format!("{}:{bucket}:", AnomalyKind::GatewayErrors.key()),
                    kind: AnomalyKind::GatewayErrors,
                    granularity: Granularity::Hour,
                    bucket,
                    subject: None,
                    tool: None,
                    value: round(rate, 4),
                    baseline: round(base_rate, 4),
                    ratio: (base_rate > 0.0).then(|| round(rate / base_rate, 1)),
                    unit: AnomalyUnit::Rate,
                    in_progress: hour == current_hour,
                    sample: Some(total),
                    last_at,
                });
            }
            checks.insert(AnomalyKind::GatewayErrors, CheckState::Evaluated);
        }
    }

    sort_findings(&mut findings);
    findings.truncate(MAX_FINDINGS);
    AnomalyReport {
        generated_at: String::new(),
        baseline_days: BASELINE_DAYS,
        recent_days: RECENT_DAYS,
        recent_hours: RECENT_HOURS,
        findings,
        checks: AnomalyKind::ALL
            .iter()
            .map(|kind| AnomalyCheck {
                kind: *kind,
                state: checks
                    .get(kind)
                    .copied()
                    .unwrap_or(CheckState::InsufficientBaseline),
            })
            .collect(),
    }
}

/// Newest first, then the strongest deviation, then a stable id order.
fn sort_findings(findings: &mut [AnomalyFinding]) {
    let strength = |finding: &AnomalyFinding| match finding.ratio {
        Some(ratio) => ratio,
        // Rate findings: points of change scaled into the same rough range.
        None => 1.0 + (finding.baseline - finding.value).abs() * 10.0,
    };
    findings.sort_by(|a, b| {
        b.last_at
            .date()
            .cmp(&a.last_at.date())
            .then_with(|| {
                strength(b)
                    .partial_cmp(&strength(a))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.id.cmp(&b.id))
    });
}

#[cfg(test)]
#[path = "usage_anomaly_tests.rs"]
mod tests;
