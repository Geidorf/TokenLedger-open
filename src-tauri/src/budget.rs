//! Usage budgets and overspend alerts.
//!
//! A budget caps estimated cost or effective tokens (input + output) for one
//! calendar period (today, this week from Monday, this month) over everything,
//! one Agent (`tools`), one model or one gateway account (`providers`, contract
//! §2.7). Usage is read from the same local Stats v2 snapshot the dashboard
//! shows, so a budget never drifts from the numbers on screen. Nothing is
//! extrapolated: a rule only reacts to usage that already happened.
//!
//! Each rule notifies once per period when it reaches its warning percent and
//! once more when it goes over, at most four times per hour overall. Settings
//! and dedup state live only in the app data directory; the notification text
//! carries the rule label, period and percent — never an amount or path.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use crate::app_paths::AppContext;
use crate::quota::alerts::AlertNotifier;

const SETTINGS_FILE: &str = "budget_settings.json";
const STATE_FILE: &str = "budget_alert_state.json";
const MAX_SETTINGS_BYTES: usize = 32 * 1024;
/// Room for `MAX_FIRED_ENTRIES` entries at the longest id and scope id, so a
/// full state written here is never rejected on the next read.
const MAX_STATE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_RULES: usize = 32;
const MAX_ID_CHARS: usize = 64;
const MAX_SCOPE_ID_CHARS: usize = 128;
const MAX_LABEL_CHARS: usize = 32;
pub(crate) const DEFAULT_WARN_PERCENT: u8 = 80;
const MIN_WARN_PERCENT: u8 = 50;
const MAX_WARN_PERCENT: u8 = 99;
const GLOBAL_WINDOW_SECONDS: i64 = 60 * 60;
const GLOBAL_LIMIT: usize = 4;
const FIRED_RETENTION_DAYS: i64 = 40;
const MAX_FIRED_ENTRIES: usize = 256;

static EVALUATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetPeriod {
    Day,
    Week,
    Month,
}

impl BudgetPeriod {
    fn stats_range(self) -> &'static str {
        match self {
            Self::Day => "today",
            Self::Week => "week",
            Self::Month => "month",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Day => "今日",
            Self::Week => "本周",
            Self::Month => "本月",
        }
    }

    /// First local calendar day of the period containing `today`; weeks start
    /// on Monday like the dashboard's `week` range.
    fn start(self, today: NaiveDate) -> NaiveDate {
        match self {
            Self::Day => today,
            Self::Week => today - Duration::days(today.weekday().num_days_from_monday() as i64),
            Self::Month => today.with_day(1).unwrap_or(today),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetMetric {
    /// Estimated USD, same figure as the dashboard's cost.
    Cost,
    /// Effective tokens (input + output); cache is never added back.
    Tokens,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetScopeKind {
    All,
    Tool,
    Model,
    Provider,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetRule {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub period: BudgetPeriod,
    pub metric: BudgetMetric,
    pub scope_kind: BudgetScopeKind,
    #[serde(default)]
    pub scope_id: String,
    pub limit: f64,
    #[serde(default = "default_warn_percent")]
    pub warn_percent: u8,
}

fn default_true() -> bool {
    true
}

fn default_warn_percent() -> u8 {
    DEFAULT_WARN_PERCENT
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSettings {
    /// System notifications on/off. Rules are still evaluated for the
    /// settings page and the tray tooltip when this is off.
    #[serde(default)]
    pub notify: bool,
    /// Publish a redacted status snapshot for the phone (budget-snapshot-v1).
    /// Off by default; turning it off deletes this computer's snapshot.
    #[serde(default)]
    pub sync_to_phone: bool,
    #[serde(default)]
    pub rules: Vec<BudgetRule>,
}

impl BudgetSettings {
    /// Drops malformed rules instead of rejecting the whole file, so one bad
    /// row written by an older build never hides the rest.
    pub(crate) fn sanitized(mut self) -> Self {
        let mut seen = std::collections::HashSet::new();
        self.rules.retain_mut(|rule| {
            rule.id = rule.id.trim().to_string();
            rule.scope_id = rule.scope_id.trim().to_string();
            if rule.scope_kind == BudgetScopeKind::All {
                rule.scope_id.clear();
            }
            rule.warn_percent = rule.warn_percent.clamp(MIN_WARN_PERCENT, MAX_WARN_PERCENT);
            let id_ok = !rule.id.is_empty()
                && rule.id.chars().count() <= MAX_ID_CHARS
                && rule
                    .id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'));
            let scope_ok = (rule.scope_kind == BudgetScopeKind::All || !rule.scope_id.is_empty())
                && rule.scope_id.chars().count() <= MAX_SCOPE_ID_CHARS
                && !rule.scope_id.chars().any(char::is_control);
            let limit_ok = rule.limit.is_finite()
                && rule.limit > 0.0
                && (rule.metric == BudgetMetric::Cost || rule.limit >= 1.0);
            if rule.metric == BudgetMetric::Tokens {
                rule.limit = rule.limit.round();
            }
            id_ok && scope_ok && limit_ok && seen.insert(rule.id.clone())
        });
        self.rules.truncate(MAX_RULES);
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetLevel {
    Ok,
    Warn,
    Over,
    /// The usage figure cannot be read (cost unpriced, account dimension
    /// missing, stats failed). Never treated as zero.
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub rule_id: String,
    pub period_start: String,
    pub used: Option<f64>,
    pub limit: f64,
    /// `used / limit * 100`, rounded to one decimal; absent when unavailable.
    pub percent: Option<f64>,
    pub level: BudgetLevel,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatusReport {
    pub generated_at: String,
    pub statuses: Vec<BudgetStatus>,
    /// Scope ids seen this month, offered as suggestions on the settings page.
    pub choices: BudgetChoices,
    pub phone_sync: crate::budget_publish::PhoneSyncStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetChoices {
    pub tools: Vec<String>,
    pub models: Vec<String>,
    /// Empty when the account dimension is unavailable (no gateway ledger).
    pub providers: Vec<String>,
    pub providers_available: bool,
}

fn choices_from(stats: Option<&Value>) -> BudgetChoices {
    let keys = |group: &str| -> Option<Vec<String>> {
        let mut keys: Vec<String> = stats?
            .get(group)?
            .as_object()?
            .keys()
            .filter(|key| !key.trim().is_empty())
            .cloned()
            .collect();
        keys.sort();
        Some(keys)
    };
    let providers = keys("providers");
    BudgetChoices {
        tools: keys("tools").unwrap_or_default(),
        models: keys("models").unwrap_or_default(),
        providers_available: providers.is_some(),
        providers: providers.unwrap_or_default(),
    }
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
    rule_id: String,
    period_start: String,
    level: BudgetLevel,
    /// What the rule measured when it fired. Editing the scope, metric,
    /// period or limit makes a new budget that re-arms both tiers.
    definition: String,
    fired_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PlannedAlert {
    pub rule_id: String,
    pub title: String,
    pub body: String,
}

#[tauri::command]
pub fn get_budget_settings(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
) -> Result<BudgetSettings, String> {
    Ok(load_settings(app_state.inner().app_data_dir()))
}

// Stats aggregation reads the whole period from the ledger, so both commands
// run off the UI thread (async + spawn_blocking, like `save_prices`).
#[tauri::command]
pub async fn set_budget_settings(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
    app_handle: tauri::AppHandle,
    settings: BudgetSettings,
) -> Result<BudgetSettings, String> {
    let settings = settings.sanitized();
    save_settings(app_state.inner().app_data_dir(), &settings)?;
    // Apply right away: a lowered limit should show on the tray without
    // waiting for the next scan. The saved settings do not wait for it.
    let app = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || crate::refresh_tray_status(&app, &app_handle));
    crate::budget_publish::wake();
    Ok(settings)
}

#[tauri::command]
pub async fn get_budget_status(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
) -> Result<BudgetStatusReport, String> {
    let app = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app.app_data_dir());
        evaluate_report(&app, &settings)
    })
    .await
    .map_err(|error| format!("get_budget_status task panicked: {error}"))
}

pub(crate) fn load_settings(app_data_dir: &Path) -> BudgetSettings {
    crate::quota::read_private_app_data_file(app_data_dir, SETTINGS_FILE, MAX_SETTINGS_BYTES)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|value| settings_from_value(&value))
        .unwrap_or_default()
}

/// Each rule is parsed on its own: one row an older or newer build cannot
/// read is dropped without hiding the other rules or the notify choice.
fn settings_from_value(value: &Value) -> BudgetSettings {
    let rules = value
        .get("rules")
        .and_then(Value::as_array)
        .map(|rules| {
            rules
                .iter()
                .filter_map(|rule| serde_json::from_value::<BudgetRule>(rule.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    BudgetSettings {
        notify: value
            .get("notify")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        sync_to_phone: value
            .get("syncToPhone")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        rules,
    }
    .sanitized()
}

pub(crate) fn save_settings(app_data_dir: &Path, settings: &BudgetSettings) -> Result<(), String> {
    let bytes = serde_json::to_vec(settings).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("budget settings are too large".to_string());
    }
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
                log::warn!("budget alert state not saved: {error}");
            }
        }
        Err(error) => log::warn!("budget alert state not serialized: {error}"),
    }
}

pub(crate) fn evaluate_report(app: &AppContext, settings: &BudgetSettings) -> BudgetStatusReport {
    let now = Local::now();
    let fetch = |period: BudgetPeriod| {
        crate::commands::get_stats_impl(app, period.stats_range().to_string())
    };
    let month = fetch(BudgetPeriod::Month).ok();
    let statuses = evaluate(settings, now.date_naive(), |period| {
        match (period, &month) {
            (BudgetPeriod::Month, Some(stats)) => Ok(stats.clone()),
            _ => fetch(period),
        }
    });
    BudgetStatusReport {
        generated_at: now.with_timezone(&Utc).to_rfc3339(),
        statuses,
        choices: choices_from(month.as_ref()),
        phone_sync: crate::budget_publish::status(),
    }
}

/// Evaluates every enabled rule. Stats are fetched once per period in use.
pub(crate) fn evaluate(
    settings: &BudgetSettings,
    today: NaiveDate,
    mut fetch: impl FnMut(BudgetPeriod) -> Result<Value, String>,
) -> Vec<BudgetStatus> {
    let mut snapshots: BTreeMap<BudgetPeriod, Option<Value>> = BTreeMap::new();
    settings
        .rules
        .iter()
        .filter(|rule| rule.enabled)
        .map(|rule| {
            let stats = snapshots.entry(rule.period).or_insert_with(|| {
                fetch(rule.period)
                    .map_err(|error| log::debug!("budget stats unavailable: {error}"))
                    .ok()
            });
            let used = stats.as_ref().and_then(|stats| used_for(rule, stats));
            status_for(rule, used, rule.period.start(today))
        })
        .collect()
}

fn status_for(rule: &BudgetRule, used: Option<f64>, period_start: NaiveDate) -> BudgetStatus {
    let percent = used.map(|used| (used / rule.limit * 1000.0).round() / 10.0);
    let level = match used {
        None => BudgetLevel::Unavailable,
        Some(used) if used >= rule.limit => BudgetLevel::Over,
        Some(used) if used * 100.0 >= rule.limit * f64::from(rule.warn_percent) => {
            BudgetLevel::Warn
        }
        Some(_) => BudgetLevel::Ok,
    };
    BudgetStatus {
        rule_id: rule.id.clone(),
        period_start: period_start.format("%Y-%m-%d").to_string(),
        used,
        limit: rule.limit,
        percent,
        level,
    }
}

/// Reads the rule's figure from a local Stats v2 snapshot. A scope that has
/// no row in the period simply has no usage (0); a missing account dimension
/// or an unpriced cost is unavailable instead.
pub(crate) fn used_for(rule: &BudgetRule, stats: &Value) -> Option<f64> {
    let (row, tokens_key, cost_key) = match rule.scope_kind {
        BudgetScopeKind::All => (stats.get("summary")?, "totalTokens", "totalCost"),
        kind => {
            let group = match kind {
                BudgetScopeKind::Tool => "tools",
                BudgetScopeKind::Model => "models",
                _ => "providers",
            };
            let group = stats.get(group)?.as_object()?;
            match group.get(&rule.scope_id) {
                Some(row) => (row, "total", "cost"),
                None => return Some(0.0),
            }
        }
    };
    let value = match rule.metric {
        BudgetMetric::Tokens => row.get(tokens_key)?.as_f64(),
        BudgetMetric::Cost => row.get(cost_key)?.as_f64(),
    }?;
    (value.is_finite() && value >= 0.0).then_some(value.abs())
}

/// Hook called whenever local stats may have changed (scan, manual refresh,
/// day change, settings saved). Returns the statuses for the tray tooltip.
pub(crate) fn check_budget_alerts(app: &AppContext) -> Vec<BudgetStatus> {
    let settings = load_settings(app.app_data_dir());
    if settings.rules.is_empty() {
        return Vec::new();
    }
    let statuses = evaluate_report(app, &settings).statuses;
    crate::budget_publish::hand_over(&settings, &statuses);
    if settings.notify {
        if let Some(notifier) = crate::quota::alerts::notifier() {
            run_alerts(
                app.app_data_dir(),
                &settings,
                &statuses,
                Utc::now(),
                notifier,
            );
        }
    }
    statuses
}

pub(crate) fn run_alerts(
    app_data_dir: &Path,
    settings: &BudgetSettings,
    statuses: &[BudgetStatus],
    now: DateTime<Utc>,
    notifier: &dyn AlertNotifier,
) -> Vec<PlannedAlert> {
    let _guard = EVALUATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = load_state(app_data_dir);
    let before = state.clone();
    let planned = plan_alerts(settings, &mut state, statuses, now);
    if state != before {
        save_state(app_data_dir, &state);
    }
    for alert in &planned {
        if let Err(error) = notifier.notify(&alert.title, &alert.body) {
            log::warn!("budget alert notification failed: {error}");
        }
    }
    planned
}

pub(crate) fn plan_alerts(
    settings: &BudgetSettings,
    state: &mut AlertState,
    statuses: &[BudgetStatus],
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
    // An entry expires once its rule is deleted or its evaluated period has
    // moved on, so a month's entries never get evicted by daily churn. A
    // disabled rule is not evaluated and keeps its entries (age-bounded), so
    // re-enabling it within the same period stays quiet.
    state.fired.retain(|entry| {
        settings.rules.iter().any(|rule| rule.id == entry.rule_id)
            && statuses
                .iter()
                .filter(|status| status.rule_id == entry.rule_id)
                .all(|status| status.period_start == entry.period_start)
    });

    // Over first, then the fullest budgets, so a capped hour reports the
    // budgets that matter most.
    let mut candidates: Vec<(&BudgetRule, &BudgetStatus)> = statuses
        .iter()
        .filter(|status| matches!(status.level, BudgetLevel::Warn | BudgetLevel::Over))
        .filter_map(|status| {
            settings
                .rules
                .iter()
                .find(|rule| rule.id == status.rule_id && rule.enabled)
                .map(|rule| (rule, status))
        })
        .collect();
    candidates.sort_by(|(_, a), (_, b)| {
        (b.level == BudgetLevel::Over)
            .cmp(&(a.level == BudgetLevel::Over))
            .then_with(|| {
                b.percent
                    .unwrap_or(0.0)
                    .partial_cmp(&a.percent.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.rule_id.cmp(&b.rule_id))
    });

    let mut planned = Vec::new();
    for (rule, status) in candidates {
        let definition = rule_definition(rule);
        let fired = |level: BudgetLevel| {
            state.fired.iter().any(|entry| {
                entry.rule_id == rule.id
                    && entry.period_start == status.period_start
                    && entry.level == level
                    && entry.definition == definition
            })
        };
        if fired(status.level) {
            continue;
        }
        if state.sent.len() >= GLOBAL_LIMIT {
            // Rate-limited alerts stay unfired so a later check delivers them.
            continue;
        }
        // Passing straight to over also settles the warning tier.
        let mut levels = vec![status.level];
        if status.level == BudgetLevel::Over && !fired(BudgetLevel::Warn) {
            levels.push(BudgetLevel::Warn);
        }
        for level in levels {
            state.fired.push(FiredEntry {
                rule_id: rule.id.clone(),
                period_start: status.period_start.clone(),
                level,
                definition: definition.clone(),
                fired_at: now,
            });
        }
        state.sent.push(now);
        let (title, body) = notification_text(rule, status);
        planned.push(PlannedAlert {
            rule_id: rule.id.clone(),
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

pub(crate) fn rule_definition(rule: &BudgetRule) -> String {
    serde_json::to_string(&(
        rule.period,
        rule.metric,
        rule.scope_kind,
        &rule.scope_id,
        rule.limit,
    ))
    .unwrap_or_default()
}

fn notification_text(rule: &BudgetRule, status: &BudgetStatus) -> (String, String) {
    let scope = scope_label(rule);
    let percent = status.percent.unwrap_or(0.0).floor() as i64;
    let title = match status.level {
        BudgetLevel::Over => format!("{scope} 已超出预算"),
        _ => format!("{scope} 预算已用 {percent}%"),
    };
    let metric = match rule.metric {
        BudgetMetric::Cost => "费用",
        BudgetMetric::Tokens => "Token",
    };
    let body = format!("{}{metric}预算已用 {percent}%", rule.period.label());
    (title, body)
}

pub(crate) fn scope_label(rule: &BudgetRule) -> String {
    let fallback = match rule.scope_kind {
        BudgetScopeKind::All => return "全部用量".to_string(),
        BudgetScopeKind::Tool => "Agent",
        BudgetScopeKind::Model => "模型",
        BudgetScopeKind::Provider => "账号",
    };
    let label = match rule.scope_kind {
        BudgetScopeKind::Tool => crate::wallpaper::tool_display_name(&rule.scope_id),
        _ => rule.scope_id.clone(),
    };
    safe_label(&label).unwrap_or_else(|| fallback.to_string())
}

/// Scope ids are model names or gateway account names typed by the user;
/// reject anything that could carry a path, URL, account or amount.
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

/// One extra tooltip line when any budget is near or over, e.g.
/// `预算：1 项超出 · 2 项接近`. `None` keeps the tooltip unchanged.
pub(crate) fn tray_summary(statuses: &[BudgetStatus]) -> Option<String> {
    let over = statuses
        .iter()
        .filter(|status| status.level == BudgetLevel::Over)
        .count();
    let warn = statuses
        .iter()
        .filter(|status| status.level == BudgetLevel::Warn)
        .count();
    match (over, warn) {
        (0, 0) => None,
        (over, 0) => Some(format!("预算：{over} 项超出")),
        (0, warn) => Some(format!("预算：{warn} 项接近上限")),
        (over, warn) => Some(format!("预算：{over} 项超出 · {warn} 项接近上限")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    fn rule(id: &str, period: BudgetPeriod, metric: BudgetMetric, limit: f64) -> BudgetRule {
        BudgetRule {
            id: id.to_string(),
            enabled: true,
            period,
            metric,
            scope_kind: BudgetScopeKind::All,
            scope_id: String::new(),
            limit,
            warn_percent: DEFAULT_WARN_PERCENT,
        }
    }

    fn scoped(mut rule: BudgetRule, kind: BudgetScopeKind, id: &str) -> BudgetRule {
        rule.scope_kind = kind;
        rule.scope_id = id.to_string();
        rule
    }

    fn stats(total_tokens: i64, total_cost: Value) -> Value {
        json!({
            "summary": { "totalTokens": total_tokens, "totalCost": total_cost },
            "tools": { "codex": { "total": 600, "cost": 3.0 } },
            "models": { "gpt-5": { "total": 400, "cost": 2.5 } },
        })
    }

    fn day(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
    }

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn reads_summary_scopes_and_treats_missing_rows_as_zero() {
        let snapshot = stats(1_000, json!(4.0));
        let all = rule("a", BudgetPeriod::Day, BudgetMetric::Tokens, 10.0);
        assert_eq!(used_for(&all, &snapshot), Some(1_000.0));
        let cost = rule("b", BudgetPeriod::Day, BudgetMetric::Cost, 10.0);
        assert_eq!(used_for(&cost, &snapshot), Some(4.0));
        let tool = scoped(cost.clone(), BudgetScopeKind::Tool, "codex");
        assert_eq!(used_for(&tool, &snapshot), Some(3.0));
        let model = scoped(all.clone(), BudgetScopeKind::Model, "gpt-5");
        assert_eq!(used_for(&model, &snapshot), Some(400.0));
        let idle = scoped(all.clone(), BudgetScopeKind::Tool, "claude");
        assert_eq!(used_for(&idle, &snapshot), Some(0.0));
    }

    #[test]
    fn unpriced_cost_and_missing_account_dimension_are_unavailable_not_zero() {
        let cost = rule("b", BudgetPeriod::Day, BudgetMetric::Cost, 10.0);
        assert_eq!(used_for(&cost, &stats(5, Value::Null)), None);
        assert_eq!(used_for(&cost, &stats(5, json!(-1.0))), None);
        let account = scoped(cost, BudgetScopeKind::Provider, "relay-a");
        assert_eq!(used_for(&account, &stats(5, json!(1.0))), None);
        let mut with_accounts = stats(5, json!(1.0));
        with_accounts["providers"] = json!({ "relay-a": { "total": 9, "cost": 0.75 } });
        assert_eq!(used_for(&account, &with_accounts), Some(0.75));
    }

    #[test]
    fn levels_follow_warn_percent_and_limit() {
        let mut budget = rule("a", BudgetPeriod::Week, BudgetMetric::Cost, 10.0);
        budget.warn_percent = 90;
        let start = day("2026-10-19");
        assert_eq!(
            status_for(&budget, Some(8.99), start).level,
            BudgetLevel::Ok
        );
        assert_eq!(
            status_for(&budget, Some(9.0), start).level,
            BudgetLevel::Warn
        );
        let over = status_for(&budget, Some(10.0), start);
        assert_eq!(over.level, BudgetLevel::Over);
        assert_eq!(over.percent, Some(100.0));
        assert_eq!(
            status_for(&budget, None, start).level,
            BudgetLevel::Unavailable
        );
    }

    #[test]
    fn period_starts_match_dashboard_calendar_ranges() {
        // 2026-10-24 is a Saturday.
        let today = day("2026-10-24");
        assert_eq!(BudgetPeriod::Day.start(today), today);
        assert_eq!(BudgetPeriod::Week.start(today), day("2026-10-19"));
        assert_eq!(
            BudgetPeriod::Week.start(day("2026-10-19")),
            day("2026-10-19")
        );
        assert_eq!(BudgetPeriod::Month.start(today), day("2026-10-01"));
    }

    #[test]
    fn evaluate_fetches_each_period_once_and_skips_disabled_rules() {
        let mut disabled = rule("c", BudgetPeriod::Month, BudgetMetric::Cost, 1.0);
        disabled.enabled = false;
        let settings = BudgetSettings {
            notify: true,
            sync_to_phone: false,
            rules: vec![
                rule("a", BudgetPeriod::Day, BudgetMetric::Tokens, 2_000.0),
                rule("b", BudgetPeriod::Day, BudgetMetric::Cost, 4.0),
                disabled,
                rule("d", BudgetPeriod::Week, BudgetMetric::Cost, 4.0),
            ],
        };
        let mut calls = Vec::new();
        let statuses = evaluate(&settings, day("2026-10-24"), |period| {
            calls.push(period);
            match period {
                BudgetPeriod::Week => Err("boom".to_string()),
                _ => Ok(stats(1_000, json!(4.0))),
            }
        });
        assert_eq!(calls, vec![BudgetPeriod::Day, BudgetPeriod::Week]);
        let levels: Vec<_> = statuses
            .iter()
            .map(|s| (s.rule_id.as_str(), s.level))
            .collect();
        assert_eq!(
            levels,
            vec![
                ("a", BudgetLevel::Ok),
                ("b", BudgetLevel::Over),
                ("d", BudgetLevel::Unavailable),
            ]
        );
        assert_eq!(statuses[2].period_start, "2026-10-19");
    }

    #[test]
    fn sanitize_drops_bad_rules_and_clamps_warn_percent() {
        let mut low = rule("ok-1", BudgetPeriod::Day, BudgetMetric::Tokens, 1_500.4);
        low.warn_percent = 10;
        let mut all_with_id = rule("ok-2", BudgetPeriod::Day, BudgetMetric::Cost, 1.0);
        all_with_id.scope_id = "ignored".to_string();
        let settings = BudgetSettings {
            notify: true,
            sync_to_phone: false,
            rules: vec![
                low,
                all_with_id,
                rule("ok-1", BudgetPeriod::Day, BudgetMetric::Cost, 1.0),
                rule("bad id", BudgetPeriod::Day, BudgetMetric::Cost, 1.0),
                rule("zero", BudgetPeriod::Day, BudgetMetric::Cost, 0.0),
                rule("nan", BudgetPeriod::Day, BudgetMetric::Cost, f64::NAN),
                rule("tiny", BudgetPeriod::Day, BudgetMetric::Tokens, 0.5),
                scoped(
                    rule("noscope", BudgetPeriod::Day, BudgetMetric::Cost, 1.0),
                    BudgetScopeKind::Tool,
                    "  ",
                ),
            ],
        }
        .sanitized();
        let ids: Vec<_> = settings.rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["ok-1", "ok-2"]);
        assert_eq!(settings.rules[0].warn_percent, MIN_WARN_PERCENT);
        assert_eq!(settings.rules[0].limit, 1_500.0);
        assert_eq!(settings.rules[1].scope_id, "");

        let many = BudgetSettings {
            notify: false,
            sync_to_phone: false,
            rules: (0..40)
                .map(|i| rule(&format!("r{i}"), BudgetPeriod::Day, BudgetMetric::Cost, 1.0))
                .collect(),
        }
        .sanitized();
        assert_eq!(many.rules.len(), MAX_RULES);
    }

    #[test]
    fn settings_round_trip_with_camel_case_and_defaults() {
        let parsed: BudgetSettings = serde_json::from_value(json!({
            "notify": true,
            "rules": [{
                "id": "m1", "period": "month", "metric": "cost",
                "scopeKind": "provider", "scopeId": "relay-a", "limit": 50
            }]
        }))
        .unwrap();
        assert!(parsed.rules[0].enabled);
        assert_eq!(parsed.rules[0].warn_percent, DEFAULT_WARN_PERCENT);
        let value = serde_json::to_value(&parsed).unwrap();
        assert_eq!(value["rules"][0]["scopeKind"], "provider");
        assert_eq!(value["rules"][0]["warnPercent"], 80);
    }

    fn statuses_for(rules: &[BudgetRule], used: &[f64], start: &str) -> Vec<BudgetStatus> {
        rules
            .iter()
            .zip(used)
            .map(|(rule, used)| status_for(rule, Some(*used), day(start)))
            .collect()
    }

    #[test]
    fn alerts_fire_once_per_level_per_period_and_rearm_next_period() {
        let budget = rule("a", BudgetPeriod::Day, BudgetMetric::Cost, 10.0);
        let settings = BudgetSettings {
            notify: true,
            sync_to_phone: false,
            rules: vec![budget.clone()],
        };
        let mut state = AlertState::default();
        let now = at("2026-10-24T08:00:00Z");

        let warn = statuses_for(std::slice::from_ref(&budget), &[8.5], "2026-10-24");
        let first = plan_alerts(&settings, &mut state, &warn, now);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].title, "全部用量 预算已用 85%");
        assert_eq!(first[0].body, "今日费用预算已用 85%");
        assert!(plan_alerts(&settings, &mut state, &warn, now).is_empty());

        let over = statuses_for(std::slice::from_ref(&budget), &[12.0], "2026-10-24");
        let second = plan_alerts(&settings, &mut state, &over, now + Duration::minutes(1));
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].title, "全部用量 已超出预算");
        assert!(plan_alerts(&settings, &mut state, &over, now + Duration::minutes(2)).is_empty());

        let next_day = statuses_for(&[budget], &[12.0], "2026-10-25");
        let third = plan_alerts(&settings, &mut state, &next_day, now + Duration::hours(16));
        assert_eq!(third.len(), 1, "a new period re-arms the rule");
    }

    #[test]
    fn jumping_straight_over_skips_the_warning_and_raised_limit_rearms() {
        let budget = rule("a", BudgetPeriod::Month, BudgetMetric::Tokens, 1_000.0);
        let mut settings = BudgetSettings {
            notify: true,
            sync_to_phone: false,
            rules: vec![budget.clone()],
        };
        let mut state = AlertState::default();
        let now = at("2026-10-24T08:00:00Z");
        let over = statuses_for(std::slice::from_ref(&budget), &[1_500.0], "2026-10-01");
        assert_eq!(plan_alerts(&settings, &mut state, &over, now).len(), 1);
        // Dropping back to a warning in the same period stays quiet.
        let warn = statuses_for(std::slice::from_ref(&budget), &[900.0], "2026-10-01");
        assert!(plan_alerts(&settings, &mut state, &warn, now).is_empty());

        let mut raised = budget;
        raised.limit = 1_800.0;
        settings.rules = vec![raised.clone()];
        let warn_again = statuses_for(std::slice::from_ref(&raised), &[1_500.0], "2026-10-01");
        assert_eq!(
            plan_alerts(&settings, &mut state, &warn_again, now).len(),
            1
        );
    }

    #[test]
    fn editing_the_scope_with_the_same_limit_rearms_the_rule() {
        let budget = scoped(
            rule("a", BudgetPeriod::Month, BudgetMetric::Cost, 10.0),
            BudgetScopeKind::Provider,
            "relay-a",
        );
        let mut settings = BudgetSettings {
            notify: true,
            sync_to_phone: false,
            rules: vec![budget.clone()],
        };
        let mut state = AlertState::default();
        let now = at("2026-10-24T08:00:00Z");
        let over = statuses_for(std::slice::from_ref(&budget), &[12.0], "2026-10-01");
        assert_eq!(plan_alerts(&settings, &mut state, &over, now).len(), 1);
        let moved = scoped(budget, BudgetScopeKind::Provider, "relay-b");
        settings.rules = vec![moved.clone()];
        let over = statuses_for(std::slice::from_ref(&moved), &[12.0], "2026-10-01");
        assert_eq!(plan_alerts(&settings, &mut state, &over, now).len(), 1);
    }

    #[test]
    fn one_unreadable_rule_keeps_the_others_and_the_notify_choice() {
        let settings = settings_from_value(&json!({
            "notify": true,
            "rules": [
                { "id": "bad", "period": "year", "metric": "cost", "scopeKind": "all", "limit": 1 },
                { "id": "nolimit", "period": "day", "metric": "cost", "scopeKind": "all" },
                { "id": "ok", "period": "day", "metric": "cost", "scopeKind": "all", "limit": 2 },
            ]
        }));
        assert!(settings.notify);
        let ids: Vec<_> = settings.rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["ok"]);
        assert_eq!(settings_from_value(&json!([])), BudgetSettings::default());
    }

    #[test]
    fn daily_churn_never_evicts_a_monthly_entry_still_in_its_period() {
        let monthly = rule("month", BudgetPeriod::Month, BudgetMetric::Cost, 10.0);
        let dailies: Vec<_> = (0..8)
            .map(|i| rule(&format!("d{i}"), BudgetPeriod::Day, BudgetMetric::Cost, 1.0))
            .collect();
        let mut rules = vec![monthly.clone()];
        rules.extend(dailies.iter().cloned());
        let settings = BudgetSettings {
            notify: true,
            sync_to_phone: false,
            rules: rules.clone(),
        };
        let mut state = AlertState::default();
        let start = at("2026-10-01T08:00:00Z");
        let mut monthly_alerts = 0;
        for day in 1..=30u32 {
            let date = format!("2026-10-{day:02}");
            let mut statuses = vec![status_for(&monthly, Some(12.0), day_of("2026-10-01"))];
            statuses.extend(
                dailies
                    .iter()
                    .map(|rule| status_for(rule, Some(2.0), day_of(&date))),
            );
            // Several checks a day, spread past the hourly cap.
            for hour in 0..4 {
                let now = start + Duration::days(i64::from(day) - 1) + Duration::hours(hour * 2);
                let sent = plan_alerts(&settings, &mut state, &statuses, now);
                monthly_alerts += sent.iter().filter(|alert| alert.rule_id == "month").count();
            }
            assert!(state.fired.len() <= rules.len() * 2);
        }
        assert_eq!(
            monthly_alerts, 1,
            "the monthly budget alerts once per month"
        );
    }

    #[test]
    fn disabling_and_re_enabling_within_the_period_stays_quiet() {
        let budget = rule("a", BudgetPeriod::Month, BudgetMetric::Cost, 10.0);
        let mut settings = BudgetSettings {
            notify: true,
            sync_to_phone: false,
            rules: vec![budget.clone()],
        };
        let mut state = AlertState::default();
        let now = at("2026-10-24T08:00:00Z");
        let over = statuses_for(std::slice::from_ref(&budget), &[12.0], "2026-10-01");
        assert_eq!(plan_alerts(&settings, &mut state, &over, now).len(), 1);
        // Disabled: not evaluated, so no status for it.
        settings.rules[0].enabled = false;
        assert!(plan_alerts(&settings, &mut state, &[], now).is_empty());
        settings.rules[0].enabled = true;
        assert!(plan_alerts(&settings, &mut state, &over, now + Duration::hours(2)).is_empty());
        // Deleting the rule drops its entries.
        settings.rules.clear();
        plan_alerts(&settings, &mut state, &[], now);
        assert!(state.fired.is_empty());
    }

    fn day_of(value: &str) -> NaiveDate {
        day(value)
    }

    #[test]
    fn a_full_alert_state_fits_the_read_limit() {
        let now = at("2026-10-24T08:00:00Z");
        let long_id = "x".repeat(MAX_ID_CHARS);
        let long_scope = "账".repeat(MAX_SCOPE_ID_CHARS);
        let mut budget = scoped(
            rule(
                &long_id,
                BudgetPeriod::Month,
                BudgetMetric::Cost,
                123_456.789_012,
            ),
            BudgetScopeKind::Provider,
            &long_scope,
        );
        budget.limit = f64::MAX;
        let state = AlertState {
            fired: (0..MAX_FIRED_ENTRIES)
                .map(|_| FiredEntry {
                    rule_id: long_id.clone(),
                    period_start: "2026-10-01".to_string(),
                    level: BudgetLevel::Unavailable,
                    definition: rule_definition(&budget),
                    fired_at: now,
                })
                .collect(),
            sent: vec![now; GLOBAL_LIMIT],
        };
        let bytes = serde_json::to_vec(&state).unwrap();
        assert!(bytes.len() < MAX_STATE_BYTES, "{} bytes", bytes.len());
    }

    #[test]
    fn global_rate_limit_defers_and_disabled_notify_stays_silent() {
        let rules: Vec<_> = (0..6)
            .map(|i| {
                rule(
                    &format!("r{i}"),
                    BudgetPeriod::Day,
                    BudgetMetric::Cost,
                    10.0,
                )
            })
            .collect();
        let settings = BudgetSettings {
            notify: true,
            sync_to_phone: false,
            rules: rules.clone(),
        };
        let used = [11.0, 9.0, 12.0, 8.0, 15.0, 9.5];
        let statuses = statuses_for(&rules, &used, "2026-10-24");
        let mut state = AlertState::default();
        let now = at("2026-10-24T08:00:00Z");
        let first = plan_alerts(&settings, &mut state, &statuses, now);
        let ids: Vec<_> = first.iter().map(|a| a.rule_id.as_str()).collect();
        // Over budgets first (fullest first), then the fullest warning.
        assert_eq!(ids, vec!["r4", "r2", "r0", "r5"]);
        assert!(
            plan_alerts(&settings, &mut state, &statuses, now + Duration::minutes(5)).is_empty()
        );
        let later = plan_alerts(
            &settings,
            &mut state,
            &statuses,
            now + Duration::minutes(61),
        );
        assert_eq!(later.len(), 2, "deferred alerts arrive after the hour");

        let quiet = BudgetSettings {
            notify: false,
            sync_to_phone: false,
            rules,
        };
        assert!(plan_alerts(&quiet, &mut AlertState::default(), &statuses, now).is_empty());
    }

    #[test]
    fn notification_text_uses_safe_labels_and_no_amounts() {
        let codex = scoped(
            rule("a", BudgetPeriod::Week, BudgetMetric::Tokens, 100.0),
            BudgetScopeKind::Tool,
            "codex",
        );
        let status = status_for(&codex, Some(93.0), day("2026-10-19"));
        assert_eq!(
            notification_text(&codex, &status),
            (
                "Codex 预算已用 93%".to_string(),
                "本周Token预算已用 93%".to_string()
            )
        );
        let account = scoped(
            rule("b", BudgetPeriod::Month, BudgetMetric::Cost, 5.0),
            BudgetScopeKind::Provider,
            "me@example.com",
        );
        let status = status_for(&account, Some(7.5), day("2026-10-01"));
        let (title, body) = notification_text(&account, &status);
        assert_eq!(title, "账号 已超出预算");
        assert!(!body.contains('$') && !body.contains("7.5"));
    }

    #[test]
    fn tray_summary_counts_near_and_over() {
        let budget = rule("a", BudgetPeriod::Day, BudgetMetric::Cost, 10.0);
        let rules = vec![budget.clone(), budget.clone(), budget];
        assert_eq!(
            tray_summary(&statuses_for(&rules, &[1.0, 2.0, 3.0], "2026-10-24")),
            None
        );
        assert_eq!(
            tray_summary(&statuses_for(&rules, &[11.0, 8.0, 3.0], "2026-10-24")).as_deref(),
            Some("预算：1 项超出 · 1 项接近上限")
        );
        assert_eq!(
            tray_summary(&statuses_for(&rules, &[11.0, 12.0, 3.0], "2026-10-24")).as_deref(),
            Some("预算：2 项超出")
        );
    }

    #[test]
    fn choices_list_scope_ids_and_flag_missing_accounts() {
        let snapshot = stats(1, json!(1.0));
        let choices = choices_from(Some(&snapshot));
        assert_eq!(choices.tools, vec!["codex"]);
        assert_eq!(choices.models, vec!["gpt-5"]);
        assert!(!choices.providers_available);
        let mut with_accounts = snapshot;
        with_accounts["providers"] = json!({ "b": {}, "a": {}, " ": {} });
        let choices = choices_from(Some(&with_accounts));
        assert_eq!(choices.providers, vec!["a", "b"]);
        assert!(choices.providers_available);
        assert_eq!(choices_from(None), BudgetChoices::default());
    }

    struct Recorder(StdMutex<Vec<(String, String)>>);

    impl AlertNotifier for Recorder {
        fn notify(&self, title: &str, body: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .push((title.to_string(), body.to_string()));
            Ok(())
        }
    }

    #[test]
    fn run_alerts_persists_dedup_state_across_calls() {
        let dir =
            std::env::temp_dir().join(format!("tokenledger_budget_alerts_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let budget = rule("a", BudgetPeriod::Day, BudgetMetric::Cost, 10.0);
        let settings = BudgetSettings {
            notify: true,
            sync_to_phone: false,
            rules: vec![budget.clone()],
        };
        save_settings(&dir, &settings).unwrap();
        assert_eq!(load_settings(&dir), settings);
        let statuses = statuses_for(&[budget], &[10.5], "2026-10-24");
        let recorder = Recorder(StdMutex::new(Vec::new()));
        let now = at("2026-10-24T08:00:00Z");
        assert_eq!(
            run_alerts(&dir, &settings, &statuses, now, &recorder).len(),
            1
        );
        assert!(run_alerts(&dir, &settings, &statuses, now, &recorder).is_empty());
        assert_eq!(recorder.0.lock().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
