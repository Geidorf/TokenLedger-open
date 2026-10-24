#[allow(dead_code)]
#[path = "../src/app_paths.rs"]
mod app_paths;
#[allow(dead_code)]
#[path = "../src/gateway/codex_config.rs"]
mod gateway_codex_config;
// The Codex writer now shares crash recovery and preview projection with the
// Agent writer. Keep this standalone parser suite on the production modules.
use gateway_codex_config as codex_config;
#[allow(dead_code)]
#[path = "../src/gateway/agent_config.rs"]
mod agent_config;
#[allow(dead_code)]
#[path = "../src/gateway/agents/yaml.rs"]
pub(crate) mod gateway_yaml;
mod agents {
    pub(crate) use crate::gateway_yaml as yaml;
}
#[allow(dead_code)]
#[path = "../src/gateway/store.rs"]
mod gateway_store;
#[allow(dead_code)]
#[path = "../src/quota/mod.rs"]
mod quota;
#[allow(dead_code)]
#[path = "../src/redact.rs"]
mod redact;
#[allow(dead_code)]
#[path = "../src/settings.rs"]
mod settings;
mod gateway {
    pub(crate) use crate::gateway_codex_config::{atomic_write, line_diff, version};
    pub(crate) use crate::gateway_store::{load_providers_readonly, read_provider_key};
    pub use crate::gateway_store::{KeyringSecrets, ProviderRecord};
}

use chrono::{DateTime, Utc};
use quota::{
    codex_envelope_from_root_at_for_test, codex_envelope_from_root_for_test,
    codex_envelope_with_scan_limits_for_test, disabled_provider_envelopes_for_test,
    QuotaActionKind, QuotaStatus, QuotaUnit, QuotaWindowStatus,
};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "tokenledger-quota-{label}-{}-{nonce}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create quota test directory");
        Self { path }
    }

    fn codex_home(&self) -> PathBuf {
        let root = self.path.join("codex-home");
        fs::create_dir_all(root.join("sessions/2026/07/15"))
            .expect("create synthetic Codex sessions directory");
        root
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("valid test timestamp")
        .with_timezone(&Utc)
}

fn window(used_percent: Value, minutes: Value, resets_at: Value) -> Value {
    json!({
        "used_percent": used_percent,
        "window_minutes": minutes,
        "resets_at": resets_at,
    })
}

fn event_line(observed_at: &str, plan_type: Value, primary: Value, secondary: Value) -> String {
    json!({
        "timestamp": observed_at,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "plan_type": plan_type,
            "rate_limits": {
                "primary": primary,
                "secondary": secondary,
                "unknown_future_field": { "ignored": true }
            },
            "prompt": "SENSITIVE_PROMPT_SHOULD_NOT_LEAK",
            "response": "SENSITIVE_RESPONSE_SHOULD_NOT_LEAK",
            "access_token": "SECRET_TOKEN_SHOULD_NOT_LEAK"
        }
    })
    .to_string()
}

fn write_session(root: &Path, name: &str, lines: &[String]) {
    let path = root.join("sessions/2026/07/15").join(name);
    fs::write(path, format!("{}\n", lines.join("\n"))).expect("write synthetic session");
}

fn primary_used(envelope: &quota::QuotaProviderEnvelope) -> f64 {
    envelope
        .windows
        .iter()
        .find(|window| window.window_id == "primary")
        .and_then(|window| window.used)
        .expect("primary used percent")
}

#[test]
fn serializes_two_normalized_windows_in_camel_case() {
    let directory = TestDirectory::new("two-windows");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-two.jsonl",
        &[event_line(
            "2026-07-15T00:20:00Z",
            json!("test-plan"),
            window(json!(25.5), json!(300), json!(1_784_076_000_i64)),
            window(json!(60.0), json!(10_080), json!("2026-07-20T00:00:00Z")),
        )],
    );

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:25:00Z"));
    assert_eq!(envelope.status, QuotaStatus::Ok);
    assert_eq!(envelope.windows.len(), 2);
    assert_eq!(envelope.windows[0].unit, QuotaUnit::Percent);
    assert_eq!(envelope.windows[0].limit, Some(100.0));
    assert_eq!(envelope.windows[0].remaining, Some(74.5));
    assert_eq!(envelope.windows[0].window_minutes, Some(300));
    assert_eq!(
        envelope.windows[0].account_label.as_deref(),
        Some("test-plan")
    );

    let serialized = serde_json::to_value(&envelope).expect("serialize quota envelope");
    assert_eq!(serialized["schemaVersion"], 1);
    assert!(serialized.get("schema_version").is_none());
    assert_eq!(serialized["windows"][0]["windowId"], "primary");
    assert_eq!(serialized["windows"][0]["staleAfterSeconds"], 900);
}

#[test]
fn keeps_only_primary_when_secondary_is_null() {
    let directory = TestDirectory::new("primary-only");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-primary.jsonl",
        &[event_line(
            "2026-07-15T00:20:00Z",
            json!("test-plan"),
            window(json!(12.0), json!(300), Value::Null),
            Value::Null,
        )],
    );

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:25:00Z"));
    assert_eq!(envelope.status, QuotaStatus::Ok);
    assert_eq!(envelope.windows.len(), 1);
    assert_eq!(envelope.windows[0].window_id, "primary");
    assert_eq!(envelope.windows[0].resets_at, None);
}

#[test]
fn old_observation_stays_stale_even_after_reset_time() {
    let directory = TestDirectory::new("stale");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-stale.jsonl",
        &[event_line(
            "2026-07-15T00:00:00Z",
            json!("test-plan"),
            window(json!(80.0), json!(300), json!("2026-07-15T00:05:00Z")),
            Value::Null,
        )],
    );

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:30:01Z"));
    assert_eq!(envelope.status, QuotaStatus::Stale);
    assert_eq!(envelope.windows[0].status, QuotaWindowStatus::Stale);
    assert_eq!(envelope.windows[0].used, Some(80.0));
    assert_eq!(envelope.windows[0].remaining, Some(20.0));
    assert_eq!(envelope.reason_code.as_deref(), Some("observation_stale"));
}

#[test]
fn skips_malformed_huge_and_unknown_content_without_leaking_source_text() {
    let directory = TestDirectory::new("PRIVATE_PATH_SHOULD_NOT_LEAK");
    let root = directory.codex_home();
    let huge_line = format!(
        "{{\"rate_limits\":{{}},\"prompt\":\"SENSITIVE_HUGE_LINE_SHOULD_NOT_LEAK{}\"}}",
        "x".repeat(70_000)
    );
    write_session(
        &root,
        "rollout-sensitive.jsonl",
        &[
            "{\"rate_limits\":".to_string(),
            huge_line,
            event_line(
                "2026-07-15T00:20:00Z",
                json!("test-plan"),
                window(json!(33.0), json!("unknown-shape"), json!({ "bad": true })),
                Value::Null,
            ),
        ],
    );

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:25:00Z"));
    assert_eq!(envelope.status, QuotaStatus::Ok);
    assert_eq!(envelope.windows[0].used, Some(33.0));
    assert_eq!(envelope.windows[0].window_minutes, None);
    assert_eq!(envelope.windows[0].resets_at, None);

    let output = format!(
        "{}\n{envelope:?}",
        serde_json::to_string(&envelope).expect("serialize sanitized envelope")
    );
    for secret in [
        "SENSITIVE_PROMPT_SHOULD_NOT_LEAK",
        "SENSITIVE_RESPONSE_SHOULD_NOT_LEAK",
        "SECRET_TOKEN_SHOULD_NOT_LEAK",
        "SENSITIVE_HUGE_LINE_SHOULD_NOT_LEAK",
        "PRIVATE_PATH_SHOULD_NOT_LEAK",
        "rollout-sensitive.jsonl",
    ] {
        assert!(
            !output.contains(secret),
            "normalized output leaked source text"
        );
    }
}

#[test]
fn does_not_scan_past_the_bounded_file_tail() {
    let directory = TestDirectory::new("bounded-tail");
    let root = directory.codex_home();
    let old_event = event_line(
        "2026-07-15T00:20:00Z",
        json!("test-plan"),
        window(json!(71.0), json!(300), Value::Null),
        Value::Null,
    );
    let filler = "ordinary-session-metadata\n".repeat(16_000);
    let path = root
        .join("sessions/2026/07/15")
        .join("rollout-bounded-tail.jsonl");
    fs::write(path, format!("{old_event}\n{filler}")).expect("write oversized synthetic session");

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:25:00Z"));
    assert_eq!(envelope.status, QuotaStatus::Error);
    assert!(envelope.windows.is_empty());
    assert_eq!(envelope.reason_code.as_deref(), Some("source_not_found"));
}

#[test]
fn rejects_out_of_range_percent_and_selects_latest_legal_event() {
    let directory = TestDirectory::new("percent-bounds");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-bounds.jsonl",
        &[
            event_line(
                "2026-07-15T00:10:00Z",
                json!("test-plan"),
                window(json!(42.0), json!(300), Value::Null),
                Value::Null,
            ),
            event_line(
                "2026-07-15T00:20:00Z",
                json!("test-plan"),
                window(json!(101.0), json!(300), Value::Null),
                Value::Null,
            ),
        ],
    );

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:25:00Z"));
    assert_eq!(primary_used(&envelope), 42.0);
    assert_eq!(envelope.windows[0].observed_at, "2026-07-15T00:10:00.000Z");
}

#[test]
fn newest_valid_event_wins_across_files() {
    let directory = TestDirectory::new("newest-event");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-first.jsonl",
        &[event_line(
            "2026-07-15T00:22:00Z",
            json!("new-plan"),
            window(json!(55.0), json!(300), Value::Null),
            Value::Null,
        )],
    );
    write_session(
        &root,
        "rollout-second.jsonl",
        &[event_line(
            "2026-07-15T00:18:00Z",
            json!("old-plan"),
            window(json!(10.0), json!(300), Value::Null),
            Value::Null,
        )],
    );

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:25:00Z"));
    assert_eq!(primary_used(&envelope), 55.0);
    assert_eq!(
        envelope.windows[0].account_label.as_deref(),
        Some("new-plan")
    );
}

#[test]
fn rejects_far_future_events_and_uses_completion_time_for_fetched_at() {
    let directory = TestDirectory::new("future-clock-skew");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-clock.jsonl",
        &[
            event_line(
                "2026-07-15T00:20:00Z",
                json!("legal-plan"),
                window(json!(46.0), json!(300), Value::Null),
                Value::Null,
            ),
            event_line(
                "2026-07-15T00:40:00Z",
                json!("future-plan"),
                window(json!(97.0), json!(300), Value::Null),
                Value::Null,
            ),
        ],
    );

    let envelope = codex_envelope_from_root_at_for_test(
        &root,
        timestamp("2026-07-15T00:25:00Z"),
        timestamp("2026-07-15T00:25:02Z"),
    );
    assert_eq!(envelope.status, QuotaStatus::Ok);
    assert_eq!(primary_used(&envelope), 46.0);
    assert_eq!(envelope.windows[0].observed_at, "2026-07-15T00:20:00.000Z");
    assert_eq!(envelope.windows[0].fetched_at, "2026-07-15T00:25:02.000Z");
    assert_eq!(
        envelope.windows[0].account_label.as_deref(),
        Some("legal-plan")
    );
}

#[test]
fn accepts_an_event_within_the_small_future_clock_skew() {
    let directory = TestDirectory::new("allowed-clock-skew");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-clock-skew.jsonl",
        &[event_line(
            "2026-07-15T00:29:00Z",
            json!("skew-plan"),
            window(json!(38.0), json!(300), Value::Null),
            Value::Null,
        )],
    );

    let envelope = codex_envelope_from_root_at_for_test(
        &root,
        timestamp("2026-07-15T00:25:00Z"),
        timestamp("2026-07-15T00:25:01Z"),
    );
    assert_eq!(envelope.status, QuotaStatus::Ok);
    assert_eq!(primary_used(&envelope), 38.0);
}

#[test]
fn file_limit_selects_the_newest_complete_candidate_set() {
    let directory = TestDirectory::new("file-limit-newest-selection");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-old.jsonl",
        &[event_line(
            "2026-07-15T00:20:00Z",
            json!("old-plan"),
            window(json!(36.0), json!(300), Value::Null),
            Value::Null,
        )],
    );
    std::thread::sleep(std::time::Duration::from_millis(25));
    write_session(
        &root,
        "rollout-new.jsonl",
        &[event_line(
            "2026-07-15T00:21:00Z",
            json!("new-plan"),
            window(json!(62.0), json!(300), Value::Null),
            Value::Null,
        )],
    );

    let envelope = codex_envelope_with_scan_limits_for_test(
        &root,
        timestamp("2026-07-15T00:25:00Z"),
        1,
        4_096,
        64 * 256 * 1024,
    );
    assert_eq!(envelope.status, QuotaStatus::Ok);
    assert_eq!(primary_used(&envelope), 62.0);
    assert_eq!(
        envelope.windows[0].account_label.as_deref(),
        Some("new-plan")
    );
}

#[test]
fn reports_truncated_when_directory_or_total_read_limits_prevent_completeness() {
    let directory = TestDirectory::new("scan-limit-truncation");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-limits.jsonl",
        &[event_line(
            "2026-07-15T00:20:00Z",
            json!("test-plan"),
            window(json!(44.0), json!(300), Value::Null),
            Value::Null,
        )],
    );
    let scan_started_at = timestamp("2026-07-15T00:25:00Z");

    let directory_limited =
        codex_envelope_with_scan_limits_for_test(&root, scan_started_at, 64, 1, 16 * 1024 * 1024);
    assert_eq!(directory_limited.status, QuotaStatus::Error);
    assert_eq!(
        directory_limited.reason_code.as_deref(),
        Some("source_scan_truncated")
    );

    let byte_limited =
        codex_envelope_with_scan_limits_for_test(&root, scan_started_at, 64, 4_096, 1);
    assert_eq!(byte_limited.status, QuotaStatus::Error);
    assert_eq!(
        byte_limited.reason_code.as_deref(),
        Some("source_scan_truncated")
    );
}

#[test]
fn null_windows_degrade_to_schema_error_without_zero_values() {
    let directory = TestDirectory::new("null-windows");
    let root = directory.codex_home();
    write_session(
        &root,
        "rollout-null.jsonl",
        &[event_line(
            "2026-07-15T00:20:00Z",
            json!("test-plan"),
            Value::Null,
            Value::Null,
        )],
    );

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:25:00Z"));
    assert_eq!(envelope.status, QuotaStatus::Error);
    assert!(envelope.windows.is_empty());
    assert_eq!(
        envelope.reason_code.as_deref(),
        Some("source_schema_unsupported")
    );
}

#[test]
fn missing_root_returns_sanitized_source_not_found() {
    let directory = TestDirectory::new("missing-root");
    let missing = directory.path.join("PRIVATE_MISSING_ROOT");
    let envelope = codex_envelope_from_root_for_test(&missing, timestamp("2026-07-15T00:25:00Z"));

    assert_eq!(envelope.status, QuotaStatus::Error);
    assert!(envelope.windows.is_empty());
    assert_eq!(envelope.reason_code.as_deref(), Some("source_not_found"));
    let serialized = serde_json::to_string(&envelope).expect("serialize missing source envelope");
    assert!(!serialized.contains("PRIVATE_MISSING_ROOT"));
}

#[cfg(unix)]
#[test]
fn rejects_sessions_symlink_that_escapes_codex_home() {
    use std::os::unix::fs::symlink;

    let directory = TestDirectory::new("sessions-escape");
    let root = directory.path.join("codex-home");
    let outside = directory.path.join("PRIVATE_OUTSIDE_SESSIONS");
    fs::create_dir_all(&root).expect("create Codex root");
    fs::create_dir_all(&outside).expect("create outside directory");
    fs::write(
        outside.join("rollout-outside.jsonl"),
        event_line(
            "2026-07-15T00:20:00Z",
            json!("test-plan"),
            window(json!(99.0), json!(300), Value::Null),
            Value::Null,
        ),
    )
    .expect("write outside fixture");
    symlink(&outside, root.join("sessions")).expect("create sessions symlink");

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:25:00Z"));
    assert_eq!(envelope.status, QuotaStatus::Error);
    assert!(envelope.windows.is_empty());
    assert_eq!(envelope.reason_code.as_deref(), Some("source_not_found"));
    let serialized = serde_json::to_string(&envelope).expect("serialize rejected source envelope");
    assert!(!serialized.contains("PRIVATE_OUTSIDE_SESSIONS"));
}

#[cfg(unix)]
#[test]
fn ignores_symlinked_session_files() {
    use std::os::unix::fs::symlink;

    let directory = TestDirectory::new("session-file-symlink");
    let root = directory.codex_home();
    let outside = directory.path.join("PRIVATE_OUTSIDE_EVENT.jsonl");
    fs::write(
        &outside,
        event_line(
            "2026-07-15T00:24:00Z",
            json!("outside-plan"),
            window(json!(99.0), json!(300), Value::Null),
            Value::Null,
        ),
    )
    .expect("write outside fixture");
    symlink(
        &outside,
        root.join("sessions/2026/07/15/rollout-symlink.jsonl"),
    )
    .expect("create session file symlink");
    write_session(
        &root,
        "rollout-regular.jsonl",
        &[event_line(
            "2026-07-15T00:20:00Z",
            json!("inside-plan"),
            window(json!(27.0), json!(300), Value::Null),
            Value::Null,
        )],
    );

    let envelope = codex_envelope_from_root_for_test(&root, timestamp("2026-07-15T00:25:00Z"));
    assert_eq!(envelope.status, QuotaStatus::Ok);
    assert_eq!(primary_used(&envelope), 27.0);
    assert_eq!(
        envelope.windows[0].account_label.as_deref(),
        Some("inside-plan")
    );
    let serialized = serde_json::to_string(&envelope).expect("serialize safe session result");
    assert!(!serialized.contains("PRIVATE_OUTSIDE_EVENT"));
    assert!(!serialized.contains("outside-plan"));
}

#[test]
fn disabled_providers_return_honest_actions_without_windows() {
    let providers = disabled_provider_envelopes_for_test();

    assert_eq!(providers.len(), 3);
    let codex = &providers[0];
    assert_eq!(codex.status, QuotaStatus::AuthRequired);
    assert!(codex.windows.is_empty());
    assert_eq!(
        codex.action.as_ref().map(|action| action.kind),
        Some(QuotaActionKind::OpenSettings)
    );

    let claude = &providers[1];
    assert_eq!(claude.status, QuotaStatus::Unsupported);
    assert!(claude.windows.is_empty());
    assert_eq!(
        claude.action.as_ref().map(|action| action.kind),
        Some(QuotaActionKind::ShowCommand)
    );
    assert_eq!(
        claude.action.as_ref().map(|action| action.value.as_str()),
        Some("/usage")
    );

    let antigravity = &providers[2];
    assert_eq!(antigravity.status, QuotaStatus::AuthRequired);
    assert!(antigravity.windows.is_empty());
    assert_eq!(
        antigravity.action.as_ref().map(|action| action.kind),
        Some(QuotaActionKind::OpenSettings)
    );
    assert_eq!(
        antigravity
            .action
            .as_ref()
            .map(|action| action.value.as_str()),
        Some("antigravity-local")
    );
}

#[test]
fn legacy_settings_default_local_quota_authorization_to_false() {
    let mut serialized =
        serde_json::to_value(settings::AppSettings::default()).expect("serialize settings");
    serialized
        .as_object_mut()
        .expect("settings object")
        .remove("quota_codex_local_enabled");

    let restored: settings::AppSettings =
        serde_json::from_value(serialized).expect("deserialize legacy settings");
    assert!(!restored.quota_codex_local_enabled);

    let enabled = settings::AppSettings {
        quota_codex_local_enabled: true,
        ..settings::AppSettings::default()
    };
    let round_trip: settings::AppSettings =
        serde_json::from_value(serde_json::to_value(enabled).expect("serialize enabled settings"))
            .expect("deserialize enabled settings");
    assert!(round_trip.quota_codex_local_enabled);
}
