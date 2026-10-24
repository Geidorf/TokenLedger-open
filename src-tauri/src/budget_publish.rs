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
/// Contract §2.1: the server refuses `p_snapshot::text` above this.
const MAX_SNAPSHOT_BYTES: usize = 8192;
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
    // Over first, then the fullest, so the cap and the byte trim below only ever
    // drop the budgets that matter least.
    let mut ordered: Vec<&BudgetStatus> = statuses.iter().collect();
    ordered.sort_by(|a, b| {
        (b.level == BudgetLevel::Over)
            .cmp(&(a.level == BudgetLevel::Over))
            .then_with(|| (b.level == BudgetLevel::Warn).cmp(&(a.level == BudgetLevel::Warn)))
            .then_with(|| {
                b.percent
                    .unwrap_or(0.0)
                    .partial_cmp(&a.percent.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let mut budgets: Vec<Value> = ordered
        .into_iter()
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
    // Labels are capped in characters, not bytes: 32 budgets of four-byte labels
    // can pass the server's byte limit, which would refuse every publish.
    loop {
        let snapshot = json!({
            "v": 1,
            "generatedAt": now.to_rfc3339_opts(SecondsFormat::Millis, true),
            "budgets": budgets,
        });
        if budgets.is_empty()
            || crate::routing_publish::server_text_len(&snapshot) <= MAX_SNAPSHOT_BYTES
        {
            return snapshot;
        }
        budgets.pop();
    }
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

/// Everything a pass touches outside its own state, so the pass order can be
/// tested without a cloud session or an app data directory.
trait PublishIo {
    fn settings(&self) -> BudgetSettings;
    fn marker_exists(&self) -> bool;
    fn write_marker(&self);
    fn remove_marker(&self);
    /// `None` when the store could not be read, `Some("")` when signed out.
    fn stored_user(&self) -> Option<String>;
    async fn statuses(&self, settings: &BudgetSettings) -> Vec<BudgetStatus>;
    /// Sends one RPC; `Cancelled` when the saved switch is no longer `switch_on`
    /// right before the request leaves.
    async fn rpc(
        &self,
        user: &str,
        function: &str,
        body: Value,
        switch_on: bool,
    ) -> Result<Value, RpcError>;
    fn set_status(&self, update: impl FnOnce(&mut PhoneSyncStatus));
}

struct AppIo {
    app: Arc<AppContext>,
}

impl PublishIo for AppIo {
    fn settings(&self) -> BudgetSettings {
        crate::budget::load_settings(self.app.app_data_dir())
    }

    fn marker_exists(&self) -> bool {
        self.app.app_data_dir().join(CLEAR_MARKER).exists()
    }

    fn write_marker(&self) {
        let _ = std::fs::write(self.app.app_data_dir().join(CLEAR_MARKER), b"");
    }

    fn remove_marker(&self) {
        let _ = std::fs::remove_file(self.app.app_data_dir().join(CLEAR_MARKER));
    }

    fn stored_user(&self) -> Option<String> {
        stored_user(&self.app)
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

    async fn rpc(
        &self,
        user: &str,
        function: &str,
        body: Value,
        switch_on: bool,
    ) -> Result<Value, RpcError> {
        // Asked again right before the request leaves (see `call_rpc`): the saved
        // switch must still be where this pass found it.
        let dir = self.app.app_data_dir().to_path_buf();
        let still = move || crate::budget::load_settings(&dir).sync_to_phone == switch_on;
        call_rpc(&self.app, user, function, body, &still).await
    }

    fn set_status(&self, update: impl FnOnce(&mut PhoneSyncStatus)) {
        set_status(update);
    }
}

struct Publisher<I: PublishIo> {
    io: I,
    machine: String,
    published: Option<Published>,
    backoff: Duration,
    /// The last pass is waiting out a retry delay; budget-check wakeups must
    /// not cut it short, only a flipped switch may.
    hold: bool,
    acted_on: bool,
}

impl<I: PublishIo> Publisher<I> {
    fn new(io: I, machine: String) -> Self {
        Self {
            io,
            machine,
            published: None,
            backoff: MIN_BACKOFF,
            hold: false,
            acted_on: false,
        }
    }

    fn back_off(&mut self) -> Duration {
        self.hold = true;
        let delay = self.backoff;
        self.backoff = (self.backoff * 2).min(MAX_BACKOFF);
        delay
    }

    /// Whether a wakeup should end the current wait: always, unless the pass is
    /// holding a retry delay and the switch has not moved.
    fn wakeup_ends_wait(&self) -> bool {
        !self.hold || self.io.settings().sync_to_phone != self.acted_on
    }

    async fn tick(&mut self) -> Duration {
        let settings = self.io.settings();
        self.hold = false;
        self.acted_on = settings.sync_to_phone;
        if settings.sync_to_phone {
            self.publish(settings).await
        } else {
            self.clear().await
        }
    }

    async fn clear(&mut self) -> Duration {
        let published = self.published.take();
        if !self.io.marker_exists() {
            self.io
                .set_status(|status| *status = PhoneSyncStatus::default());
            return TICK;
        }
        let user = match self.io.stored_user() {
            Some(user) if !user.is_empty() => user,
            // Signed out: the row is not this session's to delete any more;
            // reads hide it after two days and the purge drops it.
            Some(_) => {
                self.io.remove_marker();
                self.io
                    .set_status(|status| *status = PhoneSyncStatus::default());
                return TICK;
            }
            // The store could not be read: keep the marker and try again.
            None => {
                self.io
                    .set_status(|status| *status = PhoneSyncStatus::default());
                return self.back_off();
            }
        };
        let device = published
            .filter(|previous| previous.user == user)
            .map(|previous| previous.device)
            .unwrap_or_else(|| device_id(&user, &self.machine));
        // Turned back on while the session refreshed: publishing overwrites the row anyway.
        let delay = match self
            .io
            .rpc(
                &user,
                "clear_budget_snapshot_v1",
                json!({ "p_device": device }),
                false,
            )
            .await
        {
            Ok(_) | Err(RpcError::NotDeployed | RpcError::AccountChanged) => {
                self.io.remove_marker();
                self.backoff = MIN_BACKOFF;
                TICK
            }
            Err(RpcError::Cancelled) => Duration::ZERO,
            Err(RpcError::Failed(error)) => {
                log::warn!("budget snapshot clear failed: {error}");
                self.back_off()
            }
        };
        self.io
            .set_status(|status| *status = PhoneSyncStatus::default());
        delay
    }

    async fn publish(&mut self, settings: BudgetSettings) -> Duration {
        if !self.io.marker_exists() {
            self.io.write_marker();
        }
        let user = match self.io.stored_user() {
            Some(user) if !user.is_empty() => user,
            Some(_) => {
                self.published = None;
                self.io.set_status(|status| {
                    *status = PhoneSyncStatus {
                        state: "signed-out",
                        ..Default::default()
                    }
                });
                return TICK;
            }
            None => {
                self.io.set_status(|status| {
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
        let statuses = self.io.statuses(&settings).await;
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
        match self
            .io
            .rpc(
                &user,
                "publish_budget_snapshot_v1",
                json!({ "p_device": device, "p_snapshot": snapshot }),
                true,
            )
            .await
        {
            Ok(reply) if reply.get("stored") == Some(&Value::Bool(false)) => {
                self.io.set_status(|status| {
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
                self.io.set_status(|status| {
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
                self.io.set_status(|status| {
                    status.state = "not-deployed";
                    status.error = None;
                });
                self.hold = true;
                NOT_DEPLOYED_RETRY
            }
            Err(RpcError::Failed(error)) => {
                log::warn!("budget snapshot publish failed: {error}");
                self.io.set_status(|status| {
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
        let machine = crate::commands::local_machine_id(&app);
        let mut publisher = Publisher::new(AppIo { app }, machine);
        loop {
            let deadline = Instant::now() + publisher.tick().await;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() || tokio::time::timeout(left, WAKE.notified()).await.is_err() {
                    break;
                }
                if publisher.wakeup_ends_wait() {
                    break;
                }
            }
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
        assert_eq!(budgets[0]["label"], "账号", "unsafe scope names fall back");
        assert_eq!(budgets[0]["level"], "over");
        assert_eq!(budgets[1]["label"], "Codex");
        assert_eq!(budgets[1]["percent"], 85);
        assert_eq!(budgets[1]["level"], "warn");
        assert_eq!(budgets[1]["period"], "month");
        assert_eq!(budgets[1]["metric"], "cost");
        assert_eq!(budgets[1]["periodStart"], "2026-10-01");
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
                    &"𝄞".repeat(32),
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
        let kept = snapshot["budgets"].as_array().unwrap().len();
        assert!(kept > 0 && kept < MAX_BUDGETS, "kept {kept}");
        assert!(crate::routing_publish::server_text_len(&snapshot) <= MAX_SNAPSHOT_BYTES);

        // Three-byte labels at the same counts fit whole (contract §2.1).
        let mut cjk = settings.clone();
        for rule in &mut cjk.rules {
            rule.scope_id = "长".repeat(32);
        }
        let whole = build_snapshot(&"f".repeat(32), &cjk, &statuses, at());
        assert_eq!(whole["budgets"].as_array().unwrap().len(), MAX_BUDGETS);
    }

    #[test]
    fn over_and_fuller_budgets_come_first() {
        let settings = BudgetSettings {
            notify: false,
            sync_to_phone: true,
            rules: vec![
                rule("a", BudgetScopeKind::All, ""),
                rule("b", BudgetScopeKind::Tool, "codex"),
                rule("c", BudgetScopeKind::Model, "gpt-5"),
            ],
        };
        let statuses = vec![
            status("a", Some(1.0), Some(2.0), BudgetLevel::Ok),
            status("b", Some(45.0), Some(90.0), BudgetLevel::Warn),
            status("c", Some(60.0), Some(120.0), BudgetLevel::Over),
        ];
        let snapshot = build_snapshot("d", &settings, &statuses, at());
        let levels: Vec<&str> = snapshot["budgets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|budget| budget["level"].as_str().unwrap())
            .collect();
        assert_eq!(levels, ["over", "warn", "ok"]);
    }

    mod pass {
        use super::*;
        use std::cell::{Cell, RefCell};
        use std::collections::VecDeque;

        struct FakeIo {
            switch: Cell<bool>,
            marker: Cell<bool>,
            user: RefCell<Option<String>>,
            replies: RefCell<VecDeque<Result<Value, RpcError>>>,
            /// Flips the saved switch while the next request is being prepared.
            flip_before_send: Cell<bool>,
            calls: RefCell<Vec<(String, String, bool)>>,
            status: RefCell<PhoneSyncStatus>,
        }

        impl FakeIo {
            fn new(switch: bool) -> Self {
                Self {
                    switch: Cell::new(switch),
                    marker: Cell::new(false),
                    user: RefCell::new(Some("user-1".to_string())),
                    replies: RefCell::new(VecDeque::new()),
                    flip_before_send: Cell::new(false),
                    calls: RefCell::new(Vec::new()),
                    status: RefCell::new(PhoneSyncStatus::default()),
                }
            }

            fn reply(&self, reply: Result<Value, RpcError>) {
                self.replies.borrow_mut().push_back(reply);
            }

            fn functions(&self) -> Vec<String> {
                self.calls
                    .borrow()
                    .iter()
                    .map(|call| call.0.clone())
                    .collect()
            }

            fn state(&self) -> &'static str {
                self.status.borrow().state
            }
        }

        impl PublishIo for FakeIo {
            fn settings(&self) -> BudgetSettings {
                BudgetSettings {
                    rules: vec![rule("all", BudgetScopeKind::All, "")],
                    sync_to_phone: self.switch.get(),
                    ..Default::default()
                }
            }

            fn marker_exists(&self) -> bool {
                self.marker.get()
            }

            fn write_marker(&self) {
                self.marker.set(true);
            }

            fn remove_marker(&self) {
                self.marker.set(false);
            }

            fn stored_user(&self) -> Option<String> {
                self.user.borrow().clone()
            }

            async fn statuses(&self, _settings: &BudgetSettings) -> Vec<BudgetStatus> {
                vec![status("all", Some(10.0), Some(20.0), BudgetLevel::Ok)]
            }

            async fn rpc(
                &self,
                _user: &str,
                function: &str,
                body: Value,
                switch_on: bool,
            ) -> Result<Value, RpcError> {
                if self.flip_before_send.replace(false) {
                    self.switch.set(!self.switch.get());
                }
                if self.switch.get() != switch_on {
                    return Err(RpcError::Cancelled);
                }
                let device = body["p_device"].as_str().unwrap_or_default().to_string();
                self.calls
                    .borrow_mut()
                    .push((function.to_string(), device, switch_on));
                self.replies
                    .borrow_mut()
                    .pop_front()
                    .unwrap_or_else(|| Ok(json!({ "stored": true })))
            }

            fn set_status(&self, update: impl FnOnce(&mut PhoneSyncStatus)) {
                update(&mut self.status.borrow_mut());
            }
        }

        fn run<T>(future: impl std::future::Future<Output = T>) -> T {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(future)
        }

        fn publisher(io: FakeIo) -> Publisher<FakeIo> {
            Publisher::new(io, "machine-1".to_string())
        }

        #[test]
        fn off_without_a_pending_delete_sends_nothing() {
            let mut publisher = publisher(FakeIo::new(false));
            assert_eq!(run(publisher.tick()), TICK);
            assert!(publisher.io.functions().is_empty());
            assert_eq!(publisher.io.state(), "off");
        }

        #[test]
        fn publishes_once_then_skips_unchanged_content() {
            let mut publisher = publisher(FakeIo::new(true));
            assert_eq!(run(publisher.tick()), TICK);
            assert!(publisher.io.marker.get(), "a pending delete is armed first");
            assert_eq!(publisher.io.state(), "ok");
            assert_eq!(run(publisher.tick()), TICK);
            assert_eq!(publisher.io.functions(), ["publish_budget_snapshot_v1"]);
            let device = &publisher.io.calls.borrow()[0].1;
            assert_eq!(device, &device_id("user-1", "machine-1"));
        }

        #[test]
        fn switching_off_before_send_cancels_then_clears_the_same_row() {
            let mut publisher = publisher(FakeIo::new(true));
            run(publisher.tick());
            publisher.io.flip_before_send.set(true);
            // Content changes so the pass does send.
            publisher.published.as_mut().unwrap().key = "stale".to_string();
            assert_eq!(run(publisher.tick()), Duration::ZERO);
            assert_eq!(publisher.io.functions(), ["publish_budget_snapshot_v1"]);
            assert_eq!(run(publisher.tick()), TICK);
            let calls = publisher.io.calls.borrow();
            assert_eq!(calls[1].0, "clear_budget_snapshot_v1");
            assert_eq!(calls[1].1, calls[0].1);
            assert!(!calls[1].2, "the clear only leaves while the switch is off");
            assert!(!publisher.io.marker.get());
            assert_eq!(publisher.io.state(), "off");
        }

        #[test]
        fn switching_on_before_a_clear_leaves_cancels_it_and_keeps_the_marker() {
            let io = FakeIo::new(false);
            io.marker.set(true);
            io.flip_before_send.set(true);
            let mut publisher = publisher(io);
            assert_eq!(run(publisher.tick()), Duration::ZERO);
            assert!(publisher.io.functions().is_empty());
            assert!(publisher.io.marker.get());
        }

        #[test]
        fn failures_double_the_delay_and_hold_off_budget_wakeups() {
            let io = FakeIo::new(true);
            for _ in 0..7 {
                io.reply(Err(RpcError::Failed("boom".to_string())));
            }
            let mut publisher = publisher(io);
            let delays: Vec<u64> = (0..7).map(|_| run(publisher.tick()).as_secs()).collect();
            assert_eq!(delays, [60, 120, 240, 480, 960, 1800, 1800]);
            assert_eq!(publisher.io.state(), "error");
            assert!(
                !publisher.wakeup_ends_wait(),
                "a budget check must not cut the wait"
            );
            publisher.io.switch.set(false);
            assert!(publisher.wakeup_ends_wait(), "a flipped switch does");
            publisher.io.switch.set(true);
            assert_eq!(run(publisher.tick()), TICK);
            assert_eq!(publisher.backoff, MIN_BACKOFF, "success resets the delay");
            assert!(publisher.wakeup_ends_wait());
        }

        #[test]
        fn not_deployed_waits_long_and_holds() {
            let io = FakeIo::new(true);
            io.reply(Err(RpcError::NotDeployed));
            let mut publisher = publisher(io);
            assert_eq!(run(publisher.tick()), NOT_DEPLOYED_RETRY);
            assert_eq!(publisher.io.state(), "not-deployed");
            assert!(!publisher.wakeup_ends_wait());
        }

        #[test]
        fn a_clock_behind_the_stored_row_backs_off_with_an_error() {
            let io = FakeIo::new(true);
            io.reply(Ok(json!({ "stored": false })));
            let mut publisher = publisher(io);
            assert_eq!(run(publisher.tick()), MIN_BACKOFF);
            assert_eq!(publisher.io.state(), "error");
            assert!(publisher.published.is_none());
        }

        #[test]
        fn account_change_forgets_the_last_publish() {
            let io = FakeIo::new(true);
            let mut publisher = publisher(io);
            run(publisher.tick());
            publisher.published.as_mut().unwrap().key = "stale".to_string();
            publisher.io.reply(Err(RpcError::AccountChanged));
            assert_eq!(run(publisher.tick()), MIN_BACKOFF);
            assert!(publisher.published.is_none());
        }

        #[test]
        fn unreadable_login_keeps_the_pending_delete_and_backs_off() {
            let io = FakeIo::new(false);
            io.marker.set(true);
            *io.user.borrow_mut() = None;
            let mut publisher = publisher(io);
            assert_eq!(run(publisher.tick()), MIN_BACKOFF);
            assert!(publisher.io.marker.get());
            *publisher.io.user.borrow_mut() = Some(String::new());
            assert_eq!(run(publisher.tick()), TICK);
            assert!(
                !publisher.io.marker.get(),
                "signed out: nothing left to delete"
            );
            assert!(publisher.io.functions().is_empty());
        }

        #[test]
        fn signed_out_while_on_reports_it_without_sending() {
            let io = FakeIo::new(true);
            *io.user.borrow_mut() = Some(String::new());
            let mut publisher = publisher(io);
            assert_eq!(run(publisher.tick()), TICK);
            assert_eq!(publisher.io.state(), "signed-out");
            assert!(publisher.io.functions().is_empty());
        }
    }
}
