//! Weekly and monthly usage reports: the scheduled reminder.
//!
//! The report itself is built in the app from the same local Stats v2 snapshot
//! the dashboard reads (`range = "custom"` over the period and the period
//! before it). This module only decides when a finished period is due — the
//! previous calendar week from Monday 09:00, the previous calendar month from
//! the 1st at 09:00 — posts one system notification for it and tells an open
//! window through the `period-report-ready` event.
//!
//! Each period is announced at most once; the dedup state and the two switches
//! live only in the app data directory. The notification names the period and
//! the token change in percent, never an amount, account or path.

use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

use crate::app_paths::AppContext;
use crate::quota::alerts::AlertNotifier;

const SETTINGS_FILE: &str = "period_report_settings.json";
const STATE_FILE: &str = "period_report_state.json";
const MAX_FILE_BYTES: usize = 4 * 1024;
/// Local hour from which the previous period counts as due on its first day.
const DUE_HOUR: u32 = 9;
pub(crate) const READY_EVENT: &str = "period-report-ready";

static CHECK_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReportKind {
    Week,
    Month,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodReportSettings {
    /// Remind every Monday about last week's report.
    #[serde(default)]
    pub weekly: bool,
    /// Remind on the 1st about last month's report.
    #[serde(default)]
    pub monthly: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportState {
    /// Start day of the last announced week / month.
    #[serde(default)]
    weekly: Option<NaiveDate>,
    #[serde(default)]
    monthly: Option<NaiveDate>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DuePeriod {
    pub kind: ReportKind,
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub previous_start: NaiveDate,
    pub previous_end: NaiveDate,
}

fn week_start(day: NaiveDate) -> NaiveDate {
    day - Duration::days(day.weekday().num_days_from_monday() as i64)
}

fn month_start(day: NaiveDate) -> NaiveDate {
    day.with_day(1).unwrap_or(day)
}

fn previous_month_start(first: NaiveDate) -> NaiveDate {
    month_start(first - Duration::days(1))
}

/// The last finished period of `kind` as seen at `now`, and whether it is due
/// yet (on the first day of the new period only from `DUE_HOUR`).
fn last_finished(kind: ReportKind, now: NaiveDateTime) -> (DuePeriod, bool) {
    let today = now.date();
    let (current_start, start) = match kind {
        ReportKind::Week => {
            let current = week_start(today);
            (current, current - Duration::days(7))
        }
        ReportKind::Month => {
            let current = month_start(today);
            (current, previous_month_start(current))
        }
    };
    let end = current_start - Duration::days(1);
    let previous_start = match kind {
        ReportKind::Week => start - Duration::days(7),
        ReportKind::Month => previous_month_start(start),
    };
    let period = DuePeriod {
        kind,
        start,
        end,
        previous_start,
        previous_end: start - Duration::days(1),
    };
    let due = today > current_start || now.hour() >= DUE_HOUR;
    (period, due)
}

/// Periods to announce now. Pure, so the schedule is testable without a clock.
pub(crate) fn plan_due(
    settings: &PeriodReportSettings,
    state: &ReportState,
    now: NaiveDateTime,
) -> Vec<DuePeriod> {
    let mut due = Vec::new();
    for (enabled, kind, announced) in [
        (settings.weekly, ReportKind::Week, state.weekly),
        (settings.monthly, ReportKind::Month, state.monthly),
    ] {
        if !enabled {
            continue;
        }
        let (period, ready) = last_finished(kind, now);
        if ready && announced != Some(period.start) {
            due.push(period);
        }
    }
    due
}

fn mark(state: &mut ReportState, period: &DuePeriod) {
    match period.kind {
        ReportKind::Week => state.weekly = Some(period.start),
        ReportKind::Month => state.monthly = Some(period.start),
    }
}

/// Turning a switch on must not announce a period that finished before it was
/// on: the period already due is marked as announced, so the first reminder is
/// the next one. Before the due hour nothing is marked and today's still comes.
pub(crate) fn seed_on_enable(
    before: &PeriodReportSettings,
    after: &PeriodReportSettings,
    state: &mut ReportState,
    now: NaiveDateTime,
) {
    for (was, is, kind) in [
        (before.weekly, after.weekly, ReportKind::Week),
        (before.monthly, after.monthly, ReportKind::Month),
    ] {
        if !was && is {
            let (period, ready) = last_finished(kind, now);
            if ready {
                mark(state, &period);
            }
        }
    }
}

fn zh_day(day: NaiveDate) -> String {
    format!("{}月{}日", day.month(), day.day())
}

pub(crate) fn notification_text(
    period: &DuePeriod,
    change_percent: Option<f64>,
) -> (String, String) {
    let (title, span, previous) = match period.kind {
        ReportKind::Week => (
            "上周用量周报已生成".to_string(),
            format!("{}—{}", zh_day(period.start), zh_day(period.end)),
            "前一周",
        ),
        ReportKind::Month => (
            "上月用量月报已生成".to_string(),
            format!("{}年{}月", period.start.year(), period.start.month()),
            "前一个月",
        ),
    };
    let change = match change_percent {
        Some(percent) if percent.is_finite() && percent.abs() >= 0.5 => format!(
            "，有效 Token 比{previous}{} {:.0}%",
            if percent > 0.0 { "多" } else { "少" },
            percent.abs()
        ),
        Some(percent) if percent.is_finite() => format!("，有效 Token 与{previous}持平"),
        _ => String::new(),
    };
    (
        title,
        format!("{span}{change}。在「用量 › 报告」查看并导出。"),
    )
}

/// Effective tokens (input + output) of a local Stats v2 snapshot.
fn effective_tokens(stats: &Value) -> Option<f64> {
    let summary = stats.get("summary")?;
    let input = summary.get("inputTokens")?.as_f64()?;
    let output = summary.get("outputTokens")?.as_f64()?;
    Some(input + output)
}

fn change_percent(current: Option<f64>, previous: Option<f64>) -> Option<f64> {
    match (current, previous) {
        (Some(current), Some(previous)) if previous > 0.0 => {
            Some((current - previous) / previous * 100.0)
        }
        _ => None,
    }
}

fn local_tokens(app: &AppContext, start: NaiveDate, end: NaiveDate) -> Option<f64> {
    let query = crate::commands::LocalStatsQuery {
        range: "custom".to_string(),
        start: Some(start.format("%Y-%m-%d").to_string()),
        end: Some(end.format("%Y-%m-%d").to_string()),
        timezone: "local".to_string(),
        machines: None,
        machine: None,
        tools: None,
        tool: None,
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
    };
    crate::commands::get_local_stats_v2_impl(app, query)
        .map_err(|error| log::debug!("period report stats unavailable: {error}"))
        .ok()
        .as_ref()
        .and_then(effective_tokens)
}

pub(crate) fn load_settings(app_data_dir: &Path) -> PeriodReportSettings {
    read_json(app_data_dir, SETTINGS_FILE).unwrap_or_default()
}

fn load_state(app_data_dir: &Path) -> ReportState {
    read_json(app_data_dir, STATE_FILE).unwrap_or_default()
}

fn read_json<T: for<'de> Deserialize<'de>>(app_data_dir: &Path, file: &str) -> Option<T> {
    crate::quota::read_private_app_data_file(app_data_dir, file, MAX_FILE_BYTES)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn write_json<T: Serialize>(app_data_dir: &Path, file: &str, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    crate::quota::write_private_app_data_file(app_data_dir, file, &bytes)
}

/// Announces every due period once. `tokens` reads a period's effective
/// tokens; `notify` is skipped (state still advances) when no notifier exists.
/// `forward` runs after the state write, independently of notification success.
pub(crate) fn run_due(
    app_data_dir: &Path,
    now: NaiveDateTime,
    notifier: Option<&dyn AlertNotifier>,
    mut tokens: impl FnMut(NaiveDate, NaiveDate) -> Option<f64>,
    mut forward: impl FnMut(&str, &str),
) -> Vec<DuePeriod> {
    let _guard = CHECK_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let settings = load_settings(app_data_dir);
    let mut state = load_state(app_data_dir);
    let due = plan_due(&settings, &state, now);
    if due.is_empty() {
        return due;
    }
    for period in &due {
        mark(&mut state, period);
    }
    // Save first: a failed write must not turn into a reminder every 5 minutes.
    if let Err(error) = write_json(app_data_dir, STATE_FILE, &state) {
        log::warn!("period report state not saved: {error}");
        return Vec::new();
    }
    for period in &due {
        let change = change_percent(
            tokens(period.start, period.end),
            tokens(period.previous_start, period.previous_end),
        );
        let (title, body) = notification_text(period, change);
        if let Some(notifier) = notifier {
            if let Err(error) = notifier.notify(&title, &body) {
                log::warn!("period report notification failed: {error}");
            }
        }
        forward(&title, &body);
    }
    due
}

/// Scheduler hook (every five minutes, like budget checks).
pub(crate) fn check_due(app: &AppContext, app_handle: &tauri::AppHandle) {
    use tauri::Emitter;
    let settings = load_settings(app.app_data_dir());
    if !settings.weekly && !settings.monthly {
        return;
    }
    let app_data_dir = app.app_data_dir();
    let due = run_due(
        app_data_dir,
        Local::now().naive_local(),
        crate::quota::alerts::notifier(),
        |start, end| local_tokens(app, start, end),
        |title, body| {
            crate::alert_webhook::forward(
                app_data_dir,
                crate::alert_webhook::AlertKind::PeriodReport,
                title,
                body,
                None,
            );
        },
    );
    for period in due {
        let _ = app_handle.emit(READY_EVENT, &period);
    }
}

#[tauri::command]
pub fn get_period_report_settings(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
) -> Result<PeriodReportSettings, String> {
    Ok(load_settings(app_state.inner().app_data_dir()))
}

#[tauri::command]
pub fn set_period_report_settings(
    app_state: tauri::State<'_, std::sync::Arc<AppContext>>,
    settings: PeriodReportSettings,
) -> Result<PeriodReportSettings, String> {
    let dir = app_state.inner().app_data_dir();
    let _guard = CHECK_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let before = load_settings(dir);
    let mut state = load_state(dir);
    let seeded = state.clone();
    seed_on_enable(&before, &settings, &mut state, Local::now().naive_local());
    if state != seeded {
        write_json(dir, STATE_FILE, &state)?;
    }
    write_json(dir, SETTINGS_FILE, &settings)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn at(value: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M").unwrap()
    }

    fn day(value: &str) -> NaiveDate {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").unwrap()
    }

    const BOTH: PeriodReportSettings = PeriodReportSettings {
        weekly: true,
        monthly: true,
    };

    #[test]
    fn last_week_is_due_from_monday_nine() {
        // 2026-10-19 is a Monday.
        let state = ReportState::default();
        let weekly = PeriodReportSettings {
            weekly: true,
            monthly: false,
        };
        assert!(plan_due(&weekly, &state, at("2026-10-19 08:59")).is_empty());
        let due = plan_due(&weekly, &state, at("2026-10-19 09:00"));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].start, day("2026-10-12"));
        assert_eq!(due[0].end, day("2026-10-18"));
        assert_eq!(due[0].previous_start, day("2026-10-05"));
        assert_eq!(due[0].previous_end, day("2026-10-11"));
        // A machine that was off on Monday still gets it later in the week.
        assert_eq!(
            plan_due(&weekly, &state, at("2026-10-22 07:00"))[0].start,
            day("2026-10-12")
        );
    }

    #[test]
    fn last_month_is_due_from_the_first_and_spans_the_whole_month() {
        let monthly = PeriodReportSettings {
            weekly: false,
            monthly: true,
        };
        let state = ReportState::default();
        assert!(plan_due(&monthly, &state, at("2026-11-01 06:00")).is_empty());
        let due = plan_due(&monthly, &state, at("2026-11-01 10:00"));
        assert_eq!(due[0].start, day("2026-10-01"));
        assert_eq!(due[0].end, day("2026-10-31"));
        assert_eq!(due[0].previous_start, day("2026-09-01"));
        assert_eq!(due[0].previous_end, day("2026-09-30"));
        let january = plan_due(&monthly, &state, at("2027-01-03 10:00"));
        assert_eq!(january[0].start, day("2026-12-01"));
        assert_eq!(january[0].previous_start, day("2026-11-01"));
    }

    #[test]
    fn each_period_is_announced_once() {
        let dir =
            std::env::temp_dir().join(format!("tokenledger_period_report_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_json(&dir, SETTINGS_FILE, &BOTH).unwrap();
        let recorder = Recorder(StdMutex::new(Vec::new()));
        let now = at("2026-11-02 09:30");
        let tokens = |start: NaiveDate, _end: NaiveDate| {
            Some(
                if start == day("2026-10-26") || start == day("2026-10-01") {
                    1500.0
                } else {
                    1000.0
                },
            )
        };
        let forwarded = StdMutex::new(Vec::new());
        let mut forward = |title: &str, body: &str| {
            forwarded
                .lock()
                .unwrap()
                .push((title.to_string(), body.to_string()));
        };
        let first = run_due(&dir, now, Some(&recorder), tokens, &mut forward);
        assert_eq!(first.len(), 2);
        assert!(run_due(&dir, now, Some(&recorder), tokens, &mut forward).is_empty());
        let sent = recorder.0.lock().unwrap().clone();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].0, "上周用量周报已生成");
        assert!(sent[0]
            .1
            .starts_with("10月26日—11月1日，有效 Token 比前一周多 50%"));
        assert_eq!(sent[1].0, "上月用量月报已生成");
        {
            let forwarded = forwarded.lock().unwrap();
            assert_eq!(forwarded.len(), 2);
            assert_eq!(
                (forwarded[0].0.as_str(), forwarded[0].1.as_str()),
                (sent[0].0.as_str(), sent[0].1.as_str())
            );
            assert_eq!(
                (forwarded[1].0.as_str(), forwarded[1].1.as_str()),
                (sent[1].0.as_str(), sent[1].1.as_str())
            );
        }
        // The next week is announced the Monday after.
        assert_eq!(
            run_due(
                &dir,
                at("2026-11-09 09:00"),
                Some(&recorder),
                tokens,
                &mut forward,
            )
            .len(),
            1
        );
        assert_eq!(forwarded.lock().unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forwarding_survives_missing_or_failed_notification() {
        let now = at("2026-10-19 09:00");
        let settings = PeriodReportSettings {
            weekly: true,
            monthly: false,
        };

        let failing = FailingNotifier;
        let cases: [(&str, Option<&dyn AlertNotifier>); 2] =
            [("missing", None), ("failed", Some(&failing))];
        for (name, notifier) in cases {
            let dir = std::env::temp_dir().join(format!(
                "tokenledger_period_report_{name}_{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            write_json(&dir, SETTINGS_FILE, &settings).unwrap();
            let forwarded = StdMutex::new(Vec::new());
            let due = run_due(
                &dir,
                now,
                notifier,
                |_, _| Some(10.0),
                |title, body| {
                    forwarded
                        .lock()
                        .unwrap()
                        .push((title.to_string(), body.to_string()));
                },
            );
            assert_eq!(due.len(), 1, "{name}");
            assert_eq!(forwarded.lock().unwrap().len(), 1, "{name}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn state_write_failure_forwards_nothing() {
        let dir = std::env::temp_dir().join(format!(
            "tokenledger_period_report_write_failure_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_json(&dir, SETTINGS_FILE, &BOTH).unwrap();
        std::fs::create_dir(dir.join(STATE_FILE)).unwrap();
        let forwarded = StdMutex::new(Vec::new());
        let due = run_due(
            &dir,
            at("2026-10-19 09:00"),
            None,
            |_, _| Some(10.0),
            |title, body| {
                forwarded
                    .lock()
                    .unwrap()
                    .push((title.to_string(), body.to_string()));
            },
        );
        assert!(due.is_empty());
        assert!(forwarded.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enabling_skips_the_period_already_due_but_not_one_still_to_come() {
        let off = PeriodReportSettings::default();
        let mut state = ReportState::default();
        seed_on_enable(&off, &BOTH, &mut state, at("2026-10-21 12:00"));
        assert!(plan_due(&BOTH, &state, at("2026-10-21 12:05")).is_empty());
        assert_eq!(
            plan_due(&BOTH, &state, at("2026-10-26 09:00"))[0].start,
            day("2026-10-19")
        );
        let mut early = ReportState::default();
        let weekly = PeriodReportSettings {
            weekly: true,
            monthly: false,
        };
        seed_on_enable(&off, &weekly, &mut early, at("2026-10-19 08:00"));
        assert_eq!(early, ReportState::default());
        assert_eq!(plan_due(&weekly, &early, at("2026-10-19 09:00")).len(), 1);
    }

    #[test]
    fn notification_text_names_the_period_and_never_an_amount() {
        let (title, body) = notification_text(
            &last_finished(ReportKind::Week, at("2026-10-19 10:00")).0,
            Some(-12.4),
        );
        assert_eq!(title, "上周用量周报已生成");
        assert_eq!(
            body,
            "10月12日—10月18日，有效 Token 比前一周少 12%。在「用量 › 报告」查看并导出。"
        );
        let (_, flat) = notification_text(
            &last_finished(ReportKind::Month, at("2026-11-01 10:00")).0,
            Some(0.2),
        );
        assert_eq!(
            flat,
            "2026年10月，有效 Token 与前一个月持平。在「用量 › 报告」查看并导出。"
        );
        let (_, unknown) = notification_text(
            &last_finished(ReportKind::Month, at("2026-11-01 10:00")).0,
            None,
        );
        assert!(!unknown.contains('$'));
        assert_eq!(unknown, "2026年10月。在「用量 › 报告」查看并导出。");
    }

    #[test]
    fn change_needs_a_positive_baseline() {
        assert_eq!(change_percent(Some(10.0), Some(0.0)), None);
        assert_eq!(change_percent(None, Some(5.0)), None);
        assert_eq!(change_percent(Some(15.0), Some(10.0)), Some(50.0));
        let stats = serde_json::json!({ "summary": { "inputTokens": 3, "outputTokens": 4, "cachedTokens": 100 } });
        assert_eq!(effective_tokens(&stats), Some(7.0));
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

    struct FailingNotifier;

    impl AlertNotifier for FailingNotifier {
        fn notify(&self, _title: &str, _body: &str) -> Result<(), String> {
            Err("notification failed".to_string())
        }
    }
}
