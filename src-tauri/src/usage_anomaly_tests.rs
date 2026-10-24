use super::*;
use chrono::NaiveDate;

fn at(day: u32, hour: u32, minute: u32) -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 10, day)
        .unwrap()
        .and_hms_opt(hour, minute, 0)
        .unwrap()
}

/// 2026-10-24 15:30 local: recent days are 10-18..10-24, the day baseline
/// 10-04..10-17; recent hours start 10-23 16:00.
fn now() -> NaiveDateTime {
    at(24, 15, 30)
}

fn row(at: NaiveDateTime, tokens: i64, cost: Option<f64>) -> UsageRow {
    UsageRow {
        tool: "claude".into(),
        model: "model-a".into(),
        at,
        session_id: None,
        input: tokens / 2,
        output: tokens - tokens / 2,
        cache_read: Some(0),
        cost,
    }
}

/// Two active hours a day (10:00, 14:00) for every day from 10-04 to 10-23,
/// each `tokens` and `cost`.
fn steady(tokens: i64, cost: f64) -> Vec<UsageRow> {
    let mut rows = Vec::new();
    for day in 4..=23 {
        for hour in [10, 14] {
            rows.push(row(at(day, hour, 5), tokens, Some(cost)));
        }
    }
    rows
}

fn kinds(report: &AnomalyReport) -> Vec<(AnomalyKind, Granularity, String)> {
    report
        .findings
        .iter()
        .map(|f| (f.kind, f.granularity, f.bucket.clone()))
        .collect()
}

fn check(report: &AnomalyReport, kind: AnomalyKind) -> CheckState {
    report
        .checks
        .iter()
        .find(|check| check.kind == kind)
        .unwrap()
        .state
}

#[test]
fn empty_history_reports_insufficient_baseline_and_no_gateway() {
    let report = detect(&[], None, now());
    assert!(report.findings.is_empty());
    assert_eq!(report.checks.len(), AnomalyKind::ALL.len());
    assert_eq!(
        check(&report, AnomalyKind::TokenSpike),
        CheckState::InsufficientBaseline
    );
    assert_eq!(
        check(&report, AnomalyKind::CostSpike),
        CheckState::Unavailable
    );
    assert_eq!(
        check(&report, AnomalyKind::GatewayErrors),
        CheckState::Unavailable
    );
}

#[test]
fn steady_usage_has_no_findings() {
    let rows = steady(300_000, 0.5);
    let report = detect(&rows, Some(&[]), now());
    assert!(report.findings.is_empty(), "{:?}", kinds(&report));
    assert_eq!(
        check(&report, AnomalyKind::TokenSpike),
        CheckState::Evaluated
    );
    assert_eq!(
        check(&report, AnomalyKind::CostSpike),
        CheckState::Evaluated
    );
    assert_eq!(
        check(&report, AnomalyKind::GatewayErrors),
        CheckState::Evaluated
    );
}

#[test]
fn hour_spike_is_flagged_with_ratio_and_in_progress_hour_counts() {
    let mut rows = steady(300_000, 0.5);
    // The current hour has already used 8× the usual hour.
    rows.push(row(at(24, 15, 10), 2_400_000, Some(4.0)));
    // 3× is below the 4× hour bar.
    rows.push(row(at(24, 9, 0), 900_000, Some(1.5)));
    let report = detect(&rows, None, now());
    let token = report
        .findings
        .iter()
        .find(|f| f.kind == AnomalyKind::TokenSpike && f.granularity == Granularity::Hour)
        .expect("token hour spike");
    assert_eq!(token.bucket, "2026-10-24 15:00");
    assert_eq!(token.ratio, Some(8.0));
    assert_eq!(token.baseline, 300_000.0);
    assert!(token.in_progress);
    assert_eq!(token.id, "tokenSpike:2026-10-24 15:00:");
    let cost = report
        .findings
        .iter()
        .find(|f| f.kind == AnomalyKind::CostSpike && f.granularity == Granularity::Hour)
        .expect("cost hour spike");
    assert_eq!(cost.unit, AnomalyUnit::Usd);
    assert_eq!(cost.ratio, Some(8.0));
    assert!(!report
        .findings
        .iter()
        .any(|f| f.bucket == "2026-10-24 09:00"));
}

#[test]
fn small_usage_never_crosses_the_floor() {
    let mut rows = steady(1_000, 0.001);
    rows.push(row(at(24, 15, 0), 50_000, Some(0.05)));
    let report = detect(&rows, None, now());
    assert!(report.findings.is_empty(), "{:?}", kinds(&report));
}

#[test]
fn day_spike_uses_the_fourteen_days_before_the_recent_week() {
    let mut rows = steady(500_000, 1.0);
    // Daily baseline is 1M tokens; 10-20 used 3M more across several hours.
    for hour in 0..6 {
        rows.push(row(at(20, hour, 0), 500_000, Some(1.0)));
    }
    let report = detect(&rows, None, now());
    let day = report
        .findings
        .iter()
        .find(|f| f.kind == AnomalyKind::TokenSpike && f.granularity == Granularity::Day)
        .expect("day spike");
    assert_eq!(day.bucket, "2026-10-20");
    assert_eq!(day.ratio, Some(4.0));
    assert!(!day.in_progress);
    // The extra hours are outside the last 24 hours: no hour finding.
    assert!(!report
        .findings
        .iter()
        .any(|f| f.granularity == Granularity::Hour));
}

#[test]
fn unpriced_rows_make_the_bucket_cost_unknown_not_zero() {
    let mut rows = steady(300_000, 0.5);
    rows.push(row(at(24, 15, 0), 2_400_000, Some(40.0)));
    rows.push(row(at(24, 15, 1), 10, None));
    let report = detect(&rows, None, now());
    assert!(report
        .findings
        .iter()
        .any(|f| f.kind == AnomalyKind::TokenSpike && f.granularity == Granularity::Hour));
    assert!(!report
        .findings
        .iter()
        .any(|f| f.kind == AnomalyKind::CostSpike));
}

#[test]
fn cache_hit_drop_compares_points_against_the_median_rate() {
    let mut rows = Vec::new();
    for day in 4..=24 {
        let mut item = row(at(day, 10, 0), 400_000, Some(1.0));
        // 80% hit rate normally, 30% on 10-24.
        item.input = 200_000;
        item.output = 200_000;
        item.cache_read = Some(800_000);
        if day == 24 {
            item.input = 2_000_000;
            item.cache_read = Some(857_143);
        }
        rows.push(item);
    }
    let report = detect(&rows, None, now());
    let drop = report
        .findings
        .iter()
        .find(|f| f.kind == AnomalyKind::CacheHitDrop)
        .expect("cache drop");
    assert_eq!(drop.bucket, "2026-10-24");
    assert_eq!(drop.baseline, 0.8);
    assert!((drop.value - 0.3).abs() < 0.001);
    assert_eq!(drop.ratio, None);
    assert!(drop.in_progress);
}

#[test]
fn cache_hit_drop_ignores_small_days() {
    let mut rows = Vec::new();
    for day in 4..=24 {
        let mut item = row(at(day, 10, 0), 400_000, Some(1.0));
        item.input = 200_000;
        item.cache_read = Some(if day == 24 { 0 } else { 800_000 });
        if day == 24 {
            item.input = 50_000;
        }
        rows.push(item);
    }
    let report = detect(&rows, None, now());
    assert!(!report
        .findings
        .iter()
        .any(|f| f.kind == AnomalyKind::CacheHitDrop));
    assert_eq!(
        check(&report, AnomalyKind::CacheHitDrop),
        CheckState::Evaluated
    );
}

#[test]
fn cache_hit_drop_skips_days_without_a_proven_cache_split() {
    let mut rows = Vec::new();
    for day in 4..=24 {
        let mut item = row(at(day, 10, 0), 400_000, Some(1.0));
        item.input = 200_000;
        item.cache_read = Some(800_000);
        if day == 24 {
            // A source that cannot split reads from writes: no hit rate.
            item.input = 2_000_000;
            item.cache_read = None;
        }
        rows.push(item);
    }
    let report = detect(&rows, None, now());
    assert!(!report
        .findings
        .iter()
        .any(|f| f.kind == AnomalyKind::CacheHitDrop));
    assert!(report
        .findings
        .iter()
        .any(|f| f.kind == AnomalyKind::TokenSpike && f.bucket == "2026-10-24"));
}

#[test]
fn model_surge_uses_its_own_history() {
    let mut rows = steady(2_000_000, 1.0);
    // model-b ran 1M a day on 4 days before, then 5M on 10-22.
    for day in [5, 8, 11, 14] {
        let mut item = row(at(day, 9, 0), 1_000_000, Some(1.0));
        item.model = "model-b".into();
        rows.push(item);
    }
    let mut surge = row(at(22, 9, 0), 5_000_000, Some(5.0));
    surge.model = "model-b".into();
    rows.push(surge);
    // model-c has no history: never a surge.
    let mut fresh = row(at(22, 9, 30), 9_000_000, Some(9.0));
    fresh.model = "model-c".into();
    rows.push(fresh);
    let report = detect(&rows, None, now());
    let models: Vec<_> = report
        .findings
        .iter()
        .filter(|f| f.kind == AnomalyKind::ModelSurge)
        .collect();
    assert_eq!(models.len(), 1, "{:?}", kinds(&report));
    assert_eq!(models[0].subject.as_deref(), Some("model-b"));
    assert_eq!(models[0].ratio, Some(5.0));
    assert_eq!(models[0].bucket, "2026-10-22");
}

#[test]
fn tool_surge_carries_the_tool() {
    let mut rows = steady(2_000_000, 1.0);
    for hour in 0..4 {
        rows.push(row(at(21, hour, 0), 3_000_000, Some(1.0)));
    }
    let report = detect(&rows, None, now());
    let tool = report
        .findings
        .iter()
        .find(|f| f.kind == AnomalyKind::ToolSurge)
        .expect("tool surge");
    assert_eq!(tool.tool.as_deref(), Some("claude"));
    assert_eq!(tool.subject.as_deref(), Some("claude"));
}

fn session_row(at: NaiveDateTime, id: &str, tokens: i64, cost: Option<f64>) -> UsageRow {
    let mut item = row(at, tokens, cost);
    item.session_id = Some(id.into());
    item
}

#[test]
fn expensive_session_compares_with_the_median_session() {
    let mut rows = Vec::new();
    for day in 4..=20 {
        rows.push(session_row(
            at(day, 10, 0),
            &format!("s{day}"),
            400_000,
            Some(0.8),
        ));
    }
    rows.push(session_row(at(22, 10, 0), "big", 3_000_000, Some(3.0)));
    rows.push(session_row(at(22, 11, 0), "big", 3_000_000, Some(3.0)));
    // Expensive but finished before the recent week: not reported.
    rows.push(session_row(at(10, 10, 0), "old", 9_000_000, Some(9.0)));
    let report = detect(&rows, None, now());
    let sessions: Vec<_> = report
        .findings
        .iter()
        .filter(|f| f.kind == AnomalyKind::ExpensiveSession)
        .collect();
    assert_eq!(sessions.len(), 1, "{:?}", kinds(&report));
    let big = sessions[0];
    assert_eq!(big.subject.as_deref(), Some("big"));
    assert_eq!(big.tool.as_deref(), Some("claude"));
    assert_eq!(big.unit, AnomalyUnit::Usd);
    assert_eq!(big.value, 6.0);
    assert_eq!(big.baseline, 0.8);
    assert_eq!(big.ratio, Some(7.5));
    assert_eq!(big.granularity, Granularity::Session);
}

#[test]
fn expensive_session_falls_back_to_tokens_when_unpriced() {
    let mut rows = Vec::new();
    for day in 4..=20 {
        rows.push(session_row(
            at(day, 10, 0),
            &format!("s{day}"),
            400_000,
            None,
        ));
    }
    rows.push(session_row(at(23, 10, 0), "big", 4_000_000, None));
    let report = detect(&rows, None, now());
    let big = report
        .findings
        .iter()
        .find(|f| f.kind == AnomalyKind::ExpensiveSession)
        .expect("token session");
    assert_eq!(big.unit, AnomalyUnit::Tokens);
    assert_eq!(big.ratio, Some(10.0));
}

fn outcomes(hour_at: NaiveDateTime, total: u32, failed: u32) -> Vec<GatewayOutcome> {
    (0..total)
        .map(|index| GatewayOutcome {
            at: hour_at + Duration::seconds(index as i64),
            ok: index >= failed,
        })
        .collect()
}

#[test]
fn gateway_error_rate_needs_volume_rate_and_a_rise() {
    let mut all = Vec::new();
    // Baseline: 5% failed over the prior week.
    for day in 17..=22 {
        all.extend(outcomes(at(day, 10, 0), 40, 2));
    }
    all.extend(outcomes(at(24, 13, 0), 30, 12)); // 40%: flagged
    all.extend(outcomes(at(24, 14, 0), 10, 8)); // too few attempts
    all.extend(outcomes(at(24, 11, 0), 40, 6)); // 15%: under 20%
    let report = detect(&[], Some(&all), now());
    let errors: Vec<_> = report
        .findings
        .iter()
        .filter(|f| f.kind == AnomalyKind::GatewayErrors)
        .collect();
    assert_eq!(errors.len(), 1, "{:?}", kinds(&report));
    assert_eq!(errors[0].bucket, "2026-10-24 13:00");
    assert_eq!(errors[0].value, 0.4);
    assert_eq!(errors[0].baseline, 0.05);
    assert_eq!(errors[0].sample, Some(30));
    assert_eq!(errors[0].ratio, Some(8.0));
}

#[test]
fn gateway_errors_already_common_are_not_a_spike() {
    let mut all = Vec::new();
    for day in 17..=22 {
        all.extend(outcomes(at(day, 10, 0), 40, 12)); // 30% normally
    }
    all.extend(outcomes(at(24, 13, 0), 30, 12)); // 40%: only 10 points up
    let report = detect(&[], Some(&all), now());
    assert!(report.findings.is_empty(), "{:?}", kinds(&report));
}

#[test]
fn findings_sort_newest_first() {
    let mut rows = steady(500_000, 1.0);
    for hour in 0..6 {
        rows.push(row(at(20, hour, 0), 500_000, Some(1.0)));
    }
    rows.push(row(at(24, 15, 0), 4_000_000, Some(8.0)));
    let report = detect(&rows, None, now());
    let dates: Vec<_> = report.findings.iter().map(|f| f.last_at.date()).collect();
    let mut sorted = dates.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(dates, sorted);
    assert_eq!(report.findings[0].bucket.get(..10), Some("2026-10-24"));
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

fn finding(
    kind: AnomalyKind,
    granularity: Granularity,
    bucket: &str,
    last_at: NaiveDateTime,
) -> AnomalyFinding {
    AnomalyFinding {
        id: format!("{}:{bucket}:", kind.key()),
        kind,
        granularity,
        bucket: bucket.into(),
        subject: None,
        tool: None,
        value: 2_400_000.0,
        baseline: 300_000.0,
        ratio: Some(8.04),
        unit: AnomalyUnit::Tokens,
        in_progress: true,
        sample: None,
        last_at,
    }
}

fn utc_now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-10-24T07:30:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

#[test]
fn notifications_are_off_by_default() {
    assert!(!AnomalySettings::default().notify);
    let mut state = AlertState::default();
    let findings = [finding(
        AnomalyKind::TokenSpike,
        Granularity::Hour,
        "2026-10-24 15:00",
        at(24, 15, 10),
    )];
    let planned = plan_alerts(
        &AnomalySettings::default(),
        &mut state,
        &findings,
        now(),
        utc_now(),
    );
    assert!(planned.is_empty());
    assert!(state.fired.is_empty());
}

#[test]
fn each_recent_finding_notifies_once() {
    let settings = AnomalySettings { notify: true };
    let mut state = AlertState::default();
    let findings = [
        finding(
            AnomalyKind::TokenSpike,
            Granularity::Hour,
            "2026-10-24 15:00",
            at(24, 15, 10),
        ),
        // Older than three hours: stays on the overview only.
        finding(
            AnomalyKind::TokenSpike,
            Granularity::Hour,
            "2026-10-24 09:00",
            at(24, 9, 40),
        ),
        // Yesterday's day spike: not notified.
        finding(
            AnomalyKind::TokenSpike,
            Granularity::Day,
            "2026-10-23",
            at(23, 23, 0),
        ),
    ];
    let planned = plan_alerts(&settings, &mut state, &findings, now(), utc_now());
    assert_eq!(planned.len(), 1);
    assert_eq!(planned[0].title, "用量异常：Token 突增");
    assert_eq!(planned[0].body, "今天 15:00 的有效 Token 是平时的 8.0 倍");
    let again = plan_alerts(
        &settings,
        &mut state,
        &findings,
        now(),
        utc_now() + Duration::minutes(5),
    );
    assert!(again.is_empty());
}

#[test]
fn notifications_are_capped_per_hour_and_resume_later() {
    let settings = AnomalySettings { notify: true };
    let mut state = AlertState::default();
    let findings: Vec<_> = (0..5)
        .map(|minute| {
            let mut item = finding(
                AnomalyKind::ModelSurge,
                Granularity::Day,
                "2026-10-24",
                at(24, 15, minute),
            );
            item.id = format!("modelSurge:2026-10-24:m{minute}");
            item.subject = Some(format!("m{minute}"));
            item
        })
        .collect();
    assert_eq!(
        plan_alerts(&settings, &mut state, &findings, now(), utc_now()).len(),
        3
    );
    let later = utc_now() + Duration::minutes(61);
    assert_eq!(
        plan_alerts(&settings, &mut state, &findings, now(), later).len(),
        2
    );
}

#[test]
fn notification_text_never_carries_amounts_or_session_ids() {
    let mut session = finding(
        AnomalyKind::ExpensiveSession,
        Granularity::Session,
        "2026-10-24",
        at(24, 15, 0),
    );
    session.subject = Some("8c1f-secret-session".into());
    session.tool = Some("claude".into());
    session.unit = AnomalyUnit::Usd;
    session.value = 42.5;
    let (title, body) = notification_text(&session, now().date());
    let text = format!("{title} {body}");
    assert!(!text.contains("8c1f"));
    assert!(!text.contains("42"));
    assert!(text.contains("预估费用"));

    let mut model = finding(
        AnomalyKind::ModelSurge,
        Granularity::Day,
        "2026-10-24",
        at(24, 15, 0),
    );
    model.subject = Some("https://internal.example/model".into());
    let (title, _) = notification_text(&model, now().date());
    assert_eq!(title, "用量异常：某个模型 放量");

    let mut errors = finding(
        AnomalyKind::GatewayErrors,
        Granularity::Hour,
        "2026-10-24 13:00",
        at(24, 13, 59),
    );
    errors.value = 0.4;
    errors.unit = AnomalyUnit::Rate;
    let (_, body) = notification_text(&errors, now().date());
    assert_eq!(body, "今天 13:00 有 40% 的网关请求失败");
}

#[test]
fn settings_round_trip_and_tolerate_garbage() {
    let dir = std::env::temp_dir().join(format!(
        "tl-usage-anomaly-{}-{}",
        std::process::id(),
        utc_now().timestamp_nanos_opt().unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(load_settings(&dir), AnomalySettings::default());
    save_settings(&dir, &AnomalySettings { notify: true }).unwrap();
    assert!(load_settings(&dir).notify);
    std::fs::write(dir.join(SETTINGS_FILE), b"not json").unwrap();
    assert!(!load_settings(&dir).notify);
    let _ = std::fs::remove_dir_all(&dir);
}
