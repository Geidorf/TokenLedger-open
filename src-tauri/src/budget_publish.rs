//! Budget status relay for the phone (`docs/contracts/budget-snapshot-v1.md`).
//!
//! When "sync budgets to phone" is on and cloud sync is signed in, this
//! computer publishes one small snapshot per device through Supabase: for each
//! enabled budget whose figure is readable, a salted id, the safe scope label,
//! period, metric, period start, whole percent and level. Amounts, limits, rule
//! ids and scope ids never leave the computer. The phone turns new "near" and
//! "over" levels into local notifications. Turning the switch off deletes this
//! computer's row; a marker file carries a pending delete across restarts.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::app_paths::AppContext;
use crate::budget::{BudgetLevel, BudgetMetric, BudgetPeriod, BudgetSettings, BudgetStatus};
use crate::routing_publish::{call_rpc, hex_prefix, stored_user, RpcError};

/// Fallback cadence; budget checks and settings saves wake the loop sooner.
const TICK: Duration = Duration::from_secs(5 * 60);
/// Republish unchanged content this often so the phone sees the desktop is alive.
const HEARTBEAT: Duration = Duration::from_secs(30 * 60);
/// Statuses handed over by the budget check are reused while this fresh.
const FRESH_STATUSES: Duration = Duration::from_secs(6 * 60);
const MIN_BACKOFF: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30 * 60);
const NOT_DEPLOYED_RETRY: Duration = Duration::from_secs(30 * 60);
const MAX_BUDGETS: usize = 32;
const MAX_PERCENT: f64 = 99_999.0;
const CLEAR_MARKER: &str = "budget-publish-clear-pending";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneSyncStatus {
    /// `off`, `signed-out`, `ok`, `not-deployed` or `error`.
    pub state: &'static str,
    pub last_published_at: Option<String>,
    pub error: Option<String>,
}

impl Default for PhoneSyncStatus {
    fn default() -> Self {
        Self {
            state: "off",
            last_published_at: None,
            error: None,
        }
    }
}

static STATUS: Mutex<Option<PhoneSyncStatus>> = Mutex::new(None);
static WAKE: Notify = Notify::const_new();
static LATEST: Mutex<Option<(BudgetSettings, Vec<BudgetStatus>, Instant)>> = Mutex::new(None);

pub fn status() -> PhoneSyncStatus {
    STATUS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_default()
}

fn set_status(update: impl FnOnce(&mut PhoneSyncStatus)) {
    let mut guard = STATUS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    update(guard.get_or_insert_with(PhoneSyncStatus::default));
}

/// Runs the next pass now (settings saved, budgets re-evaluated).
pub fn wake() {
    WAKE.notify_one();
}

/// Called by the budget check with what it just evaluated, so publishing
/// never aggregates the ledger a second time.
pub(crate) fn hand_over(settings: &BudgetSettings, statuses: &[BudgetStatus]) {
    if !settings.sync_to_phone {
        return;
    }
    *LATEST
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some((settings.clone(), statuses.to_vec(), Instant::now()));
    wake();
}

/// Contract §3.1: salted per account, the machine name only leaves hashed.
pub fn device_id(user_id: &str, machine: &str) -> String {
    hex_prefix(
        &format!("tokenledger-budget-device-v1\n{user_id}\n{machine}"),
        32,
    )
}

/// Contract §3.2: stable while the budget keeps its definition; editing the
/// period, metric, scope or limit gives a new id, like a new desktop budget.
fn budget_id(device: &str, rule: &crate::budget::BudgetRule) -> String {
    hex_prefix(
        &format!(
            "tokenledger-budget-rule-v1\n{device}\n{}\n{}",
            rule.id,
            crate::budget::rule_definition(rule)
        ),
        16,
    )
}

fn period_name(period: BudgetPeriod) -> &'static str {
    match period {
        BudgetPeriod::Day => "day",
        BudgetPeriod::Week => "week",
        BudgetPeriod::Month => "month",
    }
}

pub(crate) fn build_snapshot(
    device: &str,
    settings: &BudgetSettings,
    statuses: &[BudgetStatus],
    now: DateTime<Utc>,
) -> Value {
    let budgets: Vec<Value> = statuses
        .iter()
        .filter_map(|status| {
            let level = match status.level {
                BudgetLevel::Ok => "ok",
                BudgetLevel::Warn => "warn",
                BudgetLevel::Over => "over",
                BudgetLevel::Unavailable => return None,
            };
            let rule = settings
                .rules
                .iter()
                .find(|rule| rule.id == status.rule_id && rule.enabled)?;
            let percent = status.percent?.floor().clamp(0.0, MAX_PERCENT) as i64;
            Some(json!({
                "id": budget_id(device, rule),
                "label": crate::budget::scope_label(rule),
                "period": period_name(rule.period),
                "metric": match rule.metric {
                    BudgetMetric::Cost => "cost",
                    BudgetMetric::Tokens => "tokens",
                },
                "periodStart": status.period_start,
                "percent": percent,
                "level": level,
            }))
        })
        .take(MAX_BUDGETS)
        .collect();
    json!({
        "v": 1,
        "generatedAt": now.to_rfc3339_opts(SecondsFormat::Millis, true),
        "budgets": budgets,
    })
}

fn content_key(snapshot: &Value) -> String {
    let mut copy = snapshot.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove("generatedAt");
    }
    copy.to_string()
}

struct Published {
    user: String,
    device: String,
    key: String,
    at: Instant,
}

struct Publisher {
    app: Arc<AppContext>,
    machine: String,
    published: Option<Published>,
    backoff: Duration,
}

impl Publisher {
    fn marker(&self) -> std::path::PathBuf {
        self.app.app_data_dir().join(CLEAR_MARKER)
    }

    /// Asked again right before a request leaves (see `call_rpc`): the saved
    /// switch must still be where this pass found it.
    fn switch_is(&self, on: bool) -> impl Fn() -> bool + Send + Sync {
        let dir = self.app.app_data_dir().to_path_buf();
        move || crate::budget::load_settings(&dir).sync_to_phone == on
    }

    fn back_off(&mut self) -> Duration {
        let delay = self.backoff;
        self.backoff = (self.backoff * 2).min(MAX_BACKOFF);
        delay
    }

    async fn tick(&mut self) -> Duration {
        let settings = crate::budget::load_settings(self.app.app_data_dir());
        if settings.sync_to_phone {
            self.publish(settings).await
        } else {
            self.clear().await
        }
    }

    async fn clear(&mut self) -> Duration {
        let marker = self.marker();
        let published = self.published.take();
        if !marker.exists() {
            set_status(|status| *status = PhoneSyncStatus::default());
            return TICK;
        }
        // Signed out or unreadable: the row is not this session's to delete
        // any more; reads hide it after two days and the purge drops it.
        let user = match stored_user(&self.app) {
            Some(user) if !user.is_empty() => user,
            _ => {
                let _ = std::fs::remove_file(&marker);
                set_status(|status| *status = PhoneSyncStatus::default());
                return TICK;
            }
        };
        let device = published
            .filter(|previous| previous.user == user)
            .map(|previous| previous.device)
            .unwrap_or_else(|| device_id(&user, &self.machine));
        // Turned back on while the session refreshed: publishing overwrites the row anyway.
        let still_off = self.switch_is(false);
        let delay = match call_rpc(
            &self.app,
            &user,
            "clear_budget_snapshot_v1",
            json!({ "p_device": device }),
            &still_off,
        )
        .await
        {
            Ok(_) | Err(RpcError::NotDeployed | RpcError::AccountChanged) => {
                let _ = std::fs::remove_file(&marker);
                self.backoff = MIN_BACKOFF;
                TICK
            }
            Err(RpcError::Cancelled) => Duration::ZERO,
            Err(RpcError::Failed(error)) => {
                log::warn!("budget snapshot clear failed: {error}");
                self.back_off()
            }
        };
        set_status(|status| *status = PhoneSyncStatus::default());
        delay
    }

    async fn statuses(&self, settings: &BudgetSettings) -> Vec<BudgetStatus> {
        let cached = LATEST
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some((seen, statuses, at)) = cached {
            if &seen == settings && at.elapsed() < FRESH_STATUSES {
                return statuses;
            }
        }
        let app = self.app.clone();
        let wanted = settings.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::budget::evaluate_report(&app, &wanted).statuses
        })
        .await
        .unwrap_or_default()
    }

    async fn publish(&mut self, settings: BudgetSettings) -> Duration {
        let marker = self.marker();
        if !marker.exists() {
            let _ = std::fs::write(&marker, b"");
        }
        let user = match stored_user(&self.app) {
            Some(user) if !user.is_empty() => user,
            Some(_) => {
                self.published = None;
                set_status(|status| {
                    *status = PhoneSyncStatus {
                        state: "signed-out",
                        ..Default::default()
                    }
                });
                return TICK;
            }
            None => {
                set_status(|status| {
                    status.state = "error";
                    status.error = Some("读取云端登录信息失败".to_string());
                });
                return self.back_off();
            }
        };
        if self
            .published
            .as_ref()
            .is_some_and(|previous| previous.user != user)
        {
            self.published = None;
        }
        let device = device_id(&user, &self.machine);
        let statuses = self.statuses(&settings).await;
        let snapshot = build_snapshot(&device, &settings, &statuses, Utc::now());
        let key = content_key(&snapshot);
        if self
            .published
            .as_ref()
            .is_some_and(|previous| previous.key == key && previous.at.elapsed() < HEARTBEAT)
        {
            return TICK;
        }
        // Evaluating and refreshing the session both await: the switch may have gone
        // off meanwhile, and nothing may upload after that.
        let still_on = self.switch_is(true);
        match call_rpc(
            &self.app,
            &user,
            "publish_budget_snapshot_v1",
            json!({ "p_device": device, "p_snapshot": snapshot }),
            &still_on,
        )
        .await
        {
            Ok(reply) if reply.get("stored") == Some(&Value::Bool(false)) => {
                set_status(|status| {
                    status.state = "error";
                    status.error =
                        Some("本机时钟早于上次发布的时间，时钟追上后自动恢复".to_string());
                });
                self.back_off()
            }
            Ok(_) => {
                self.published = Some(Published {
                    user,
                    device,
                    key,
                    at: Instant::now(),
                });
                self.backoff = MIN_BACKOFF;
                set_status(|status| {
                    *status = PhoneSyncStatus {
                        state: "ok",
                        last_published_at: Some(
                            Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
                        ),
                        error: None,
                    }
                });
                TICK
            }
            // Switched off before sending: the next pass clears right away.
            Err(RpcError::Cancelled) => Duration::ZERO,
            Err(RpcError::AccountChanged) => {
                self.published = None;
                MIN_BACKOFF
            }
            Err(RpcError::NotDeployed) => {
                set_status(|status| {
                    status.state = "not-deployed";
                    status.error = None;
                });
                NOT_DEPLOYED_RETRY
            }
            Err(RpcError::Failed(error)) => {
                log::warn!("budget snapshot publish failed: {error}");
                set_status(|status| {
                    status.state = "error";
                    status.error = Some(error);
                });
                self.back_off()
            }
        }
    }
}

/// Runs for the life of the process; a pass is a settings read when the switch is off.
pub fn start(app: Arc<AppContext>) {
    tauri::async_runtime::spawn(async move {
        let mut publisher = Publisher {
            machine: crate::commands::local_machine_id(),
            app,
            published: None,
            backoff: MIN_BACKOFF,
        };
        loop {
            let delay = publisher.tick().await;
            let _ = tokio::time::timeout(delay, WAKE.notified()).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::budget::{BudgetRule, BudgetScopeKind};

    fn rule(id: &str, kind: BudgetScopeKind, scope: &str) -> BudgetRule {
        BudgetRule {
            id: id.to_string(),
            enabled: true,
            period: BudgetPeriod::Month,
            metric: BudgetMetric::Cost,
            scope_kind: kind,
            scope_id: scope.to_string(),
            limit: 50.0,
            warn_percent: 80,
        }
    }

    fn status(
        id: &str,
        used: Option<f64>,
        percent: Option<f64>,
        level: BudgetLevel,
    ) -> BudgetStatus {
        BudgetStatus {
            rule_id: id.to_string(),
            period_start: "2026-10-01".to_string(),
            used,
            limit: 50.0,
            percent,
            level,
        }
    }

    fn at() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-24T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn snapshot_carries_labels_and_percents_but_no_amounts_or_ids() {
        let mut disabled = rule("off", BudgetScopeKind::All, "");
        disabled.enabled = false;
        let settings = BudgetSettings {
            notify: false,
            sync_to_phone: true,
            rules: vec![
                rule("codex1", BudgetScopeKind::Tool, "codex"),
                rule("acct", BudgetScopeKind::Provider, "relay@example.com"),
                rule("gone", BudgetScopeKind::Model, "gpt-5"),
                disabled,
            ],
        };
        let statuses = vec![
            status("codex1", Some(42.5), Some(85.4), BudgetLevel::Warn),
            status("acct", Some(60.0), Some(120.0), BudgetLevel::Over),
            status("gone", None, None, BudgetLevel::Unavailable),
            status("off", Some(1.0), Some(2.0), BudgetLevel::Ok),
        ];
        let device = device_id("user-1", "MY-LAPTOP");
        let snapshot = build_snapshot(&device, &settings, &statuses, at());
        assert_eq!(snapshot["v"], 1);
        assert_eq!(snapshot["generatedAt"], "2026-10-24T07:00:00.000Z");
        let budgets = snapshot["budgets"].as_array().unwrap();
        assert_eq!(
            budgets.len(),
            2,
            "unavailable and disabled budgets stay home"
        );
        assert_eq!(budgets[0]["label"], "Codex");
        assert_eq!(budgets[0]["percent"], 85);
        assert_eq!(budgets[0]["level"], "warn");
        assert_eq!(budgets[0]["period"], "month");
        assert_eq!(budgets[0]["metric"], "cost");
        assert_eq!(budgets[0]["periodStart"], "2026-10-01");
        assert_eq!(budgets[1]["label"], "账号", "unsafe scope names fall back");
        assert_eq!(budgets[1]["level"], "over");
        let text = snapshot.to_string();
        for leaked in [
            "42.5",
            "codex1",
            "relay",
            "example",
            "MY-LAPTOP",
            "user-1",
            "limit",
            "used",
        ] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
        for budget in budgets {
            let id = budget["id"].as_str().unwrap();
            assert_eq!(id.len(), 16);
            assert!(id
                .chars()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()));
        }
    }

    #[test]
    fn budget_ids_follow_the_definition_device_and_rule() {
        let base = rule("r1", BudgetScopeKind::Tool, "codex");
        let device = device_id("user-1", "m");
        let id = budget_id(&device, &base);
        assert_eq!(id, budget_id(&device, &base.clone()));
        let mut raised = base.clone();
        raised.limit = 80.0;
        assert_ne!(id, budget_id(&device, &raised));
        assert_ne!(id, budget_id(&device_id("user-2", "m"), &base));
        assert_ne!(
            device_id("user-1", "m"),
            crate::routing_publish::device_id("user-1", "m")
        );
        assert_eq!(device.len(), 32);
    }

    #[test]
    fn percent_is_whole_and_capped_and_key_ignores_the_clock() {
        let settings = BudgetSettings {
            notify: false,
            sync_to_phone: true,
            rules: vec![rule("r1", BudgetScopeKind::All, "")],
        };
        let huge = vec![status("r1", Some(1e9), Some(2e9), BudgetLevel::Over)];
        let snapshot = build_snapshot("d", &settings, &huge, at());
        assert_eq!(snapshot["budgets"][0]["percent"], 99_999);
        assert_eq!(snapshot["budgets"][0]["label"], "全部用量");
        let later = build_snapshot("d", &settings, &huge, at() + chrono::Duration::minutes(5));
        assert_eq!(content_key(&snapshot), content_key(&later));
        assert_ne!(snapshot, later);
    }

    #[test]
    fn the_largest_snapshot_fits_the_server_cap() {
        let rules: Vec<BudgetRule> = (0..40)
            .map(|index| {
                let mut rule = rule(
                    &format!("rule{index:02}{}", "x".repeat(56)),
                    BudgetScopeKind::Model,
                    &"长".repeat(32),
                );
                rule.metric = BudgetMetric::Tokens;
                rule
            })
            .collect();
        let statuses: Vec<BudgetStatus> = rules
            .iter()
            .map(|rule| status(&rule.id, Some(1e9), Some(99_999.0), BudgetLevel::Over))
            .collect();
        let settings = BudgetSettings {
            notify: true,
            sync_to_phone: true,
            rules,
        };
        let snapshot = build_snapshot(&"f".repeat(32), &settings, &statuses, at());
        assert_eq!(snapshot["budgets"].as_array().unwrap().len(), MAX_BUDGETS);
        assert!(crate::routing_publish::server_text_len(&snapshot) <= 8192);
    }
}
