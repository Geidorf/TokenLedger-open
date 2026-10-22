//! 订阅设置命令（T10.188，方案 T10.154 `docs/design/cost-naming-subscription-v1.md`
//! §3 的 B1；契约 `docs/contracts/cost-profile-local-v1.md`）。
//!
//! 订阅设置存放在 `AppSettings` 的四个 `cost_*` 字段里（模型与校验见 `model.rs`，声明为
//! `settings::cost_model`），只经本模块的四个命令读写：`get_cost_profile`、
//! `validate_cost_profile(profile)`、`save_cost_profile(profile, expectedRevision)` 与
//! `clear_cost_profile(expectedRevision)`。通用 `save_settings` 不合并这四个字段，陈旧的
//! 设置页状态因此覆盖不了订阅设置；保存与删除都按 revision 条件写入，冲突时什么都不改。
//! `clear_cost_profile` 就是「删除全部订阅设置」：回到规范空状态并把 revision 加一，跨设备
//! 同步（C1）据此写云端删除墓碑。`save_cost_profile` 收到 `null` 报校验错误，不会清空。

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "计费周期由 B2（get_cost_breakdown_local）调用；B1 先落定义与测试"
    )
)]
pub(crate) mod cycle;
#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use chrono::NaiveDate;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

use crate::app_paths::AppContext;
use crate::settings::cost_model::*;
use crate::settings::{self, AppSettings};

/// 命令错误都是固定的中文句子（契约 §1），从不转述底层错误原文：serde 的错误会引用设置
/// 文件里出错的值，锁与写盘错误是英文。
const READ_ERROR: &str = "读取订阅设置失败：设置文件无法读取或解析。";
const SAVE_LOCK_ERROR: &str = "订阅设置未保存：暂时无法取得设置文件锁，请稍后重试。";
const SAVE_READ_ERROR: &str = "订阅设置未保存：设置文件无法读取或解析。";
const SAVE_WRITE_ERROR: &str = "订阅设置未保存：设置文件无法写入。";
const SAVE_RELEASE_ERROR: &str =
    "订阅设置的保存结果未知：设置文件锁未能正常释放，请重新读取订阅设置。";
const STATE_LOCK_ERROR: &str = "订阅设置未保存：设置状态异常，请重启应用后重试。";
const REVISION_LIMIT_ERROR: &str = "订阅设置未保存：版本号已达上限。";
const TASK_ERROR: &str = "订阅设置的后台任务异常退出，保存结果未知，请重新读取订阅设置。";

/// 保存或删除成功后发出的既有事件与载荷。
const SETTINGS_UPDATED_EVENT: &str = "settings-updated";
const SETTINGS_UPDATED_SOURCE: &str = "cost-profile";

/// `get_cost_profile` 的返回，也是保存成功后回给设置页的状态。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostProfileView {
    pub revision: u64,
    pub plans: Vec<CostSubscriptionPlan>,
    pub tool_billing_modes: BTreeMap<String, CostBillingMode>,
    pub cny_per_usd: Option<f64>,
}

impl CostProfileView {
    fn new(revision: u64, profile: &CostProfile) -> Self {
        Self {
            revision,
            plans: profile.plans.clone(),
            tool_billing_modes: profile.tool_billing_modes.clone(),
            cny_per_usd: profile.cny_per_usd,
        }
    }

    fn from_settings(settings: &AppSettings) -> Self {
        Self::new(
            settings.cost_profile_revision,
            &CostProfile::from_settings(settings),
        )
    }
}

/// `validate_cost_profile` 的返回。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CostProfileValidation {
    pub valid: bool,
    pub errors: Vec<CostProfileFieldError>,
}

/// `save_cost_profile` 与 `clear_cost_profile` 的返回（删除全部不会是 `Invalid`）。
/// 系统错误（锁、读写）另以命令错误返回。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CostProfileSaveOutcome {
    /// 已保存；`cleared` 表示保存后是规范空状态（删除全部，或手动删到空）。
    Saved {
        profile: CostProfileView,
        cleared: bool,
    },
    /// 磁盘上的 revision 与 `expectedRevision` 不同：什么都没改。
    Conflict {
        #[serde(rename = "currentRevision")]
        current_revision: u64,
    },
    /// 校验未通过：什么都没改。
    Invalid { errors: Vec<CostProfileFieldError> },
}

/// 写锁内对磁盘上的订阅设置做出的决定。
enum Decision {
    Write(CostProfile),
    Reject(Vec<CostProfileFieldError>),
}

fn next_revision(current: u64) -> Result<u64, &'static str> {
    current
        .checked_add(1)
        .filter(|revision| *revision <= MAX_REVISION)
        .ok_or(REVISION_LIMIT_ERROR)
}

fn store_failure_message(failure: StoreFailure) -> &'static str {
    match failure {
        StoreFailure::Lock => SAVE_LOCK_ERROR,
        StoreFailure::Read => SAVE_READ_ERROR,
        StoreFailure::Write => SAVE_WRITE_ERROR,
        StoreFailure::Release => SAVE_RELEASE_ERROR,
    }
}

fn local_today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

pub(crate) fn get_cost_profile_impl(app: &AppContext) -> Result<CostProfileView, String> {
    let settings = settings::load_settings_result(app).map_err(|_| READ_ERROR.to_string())?;
    Ok(CostProfileView::from_settings(&settings))
}

/// 只校验、不写入。`latest_start` 是开始日期的上界（含），设置页用本机今天。
pub(crate) fn validate_cost_profile_impl(
    app: &AppContext,
    raw: &Value,
    latest_start: NaiveDate,
) -> Result<CostProfileValidation, String> {
    let settings = settings::load_settings_result(app).map_err(|_| READ_ERROR.to_string())?;
    let stored = CostProfile::from_settings(&settings);
    let errors = parse_input_profile(raw, &stored, latest_start)
        .err()
        .unwrap_or_default();
    Ok(CostProfileValidation {
        valid: errors.is_empty(),
        errors,
    })
}

/// 按 revision 条件写入：revision 比对、`decide` 与写入都在设置写锁内完成。磁盘上的
/// revision 与 `expected_revision` 不同就返回冲突、什么都不改；`decide` 拒绝时返回字段级
/// 错误、什么都不改。成功后同步更新内存中的设置副本。
fn store_conditionally(
    app: &AppContext,
    settings_state: &Mutex<AppSettings>,
    expected_revision: u64,
    decide: impl FnOnce(&CostProfile) -> Result<Decision, &'static str>,
) -> Result<CostProfileSaveOutcome, String> {
    // 锁顺序与通用保存一致：先内存设置副本，再设置文件锁。
    let mut guard = settings_state
        .lock()
        .map_err(|_| STATE_LOCK_ERROR.to_string())?;
    let (outcome, written) = settings::update_cost_profile(app, |current| {
        let current_revision = current.cost_profile_revision;
        if current_revision != expected_revision {
            return (
                Ok(CostProfileSaveOutcome::Conflict { current_revision }),
                None,
            );
        }
        let stored = CostProfile::from_settings(current);
        let profile = match decide(&stored) {
            Ok(Decision::Write(profile)) => profile,
            Ok(Decision::Reject(errors)) => {
                return (Ok(CostProfileSaveOutcome::Invalid { errors }), None)
            }
            Err(message) => return (Err(message), None),
        };
        let revision = match next_revision(current_revision) {
            Ok(revision) => revision,
            Err(message) => return (Err(message), None),
        };
        let outcome = CostProfileSaveOutcome::Saved {
            profile: CostProfileView::new(revision, &profile),
            cleared: profile.is_cleared(),
        };
        (Ok(outcome), Some(StoredCostProfile { profile, revision }))
    })
    .map_err(|failure| store_failure_message(failure).to_string())?;
    if let Some(settings) = written {
        *guard = settings;
    }
    outcome.map_err(str::to_string)
}

/// 按 revision 条件保存整份订阅设置。`latest_start` 是开始日期的上界（含）：设置页用本机
/// 今天（`save_for_settings_page`），C1 应用其他设备的副本用 `remote_copy_latest_start`。
pub(crate) fn save_cost_profile_impl(
    app: &AppContext,
    settings_state: &Mutex<AppSettings>,
    raw: &Value,
    expected_revision: u64,
    latest_start: NaiveDate,
) -> Result<CostProfileSaveOutcome, String> {
    store_conditionally(
        app,
        settings_state,
        expected_revision,
        |stored| match parse_input_profile(raw, stored, latest_start) {
            Ok(input) => input.into_profile(stored).map(Decision::Write),
            Err(errors) => Ok(Decision::Reject(errors)),
        },
    )
}

/// 「删除全部订阅设置」：按 revision 条件写成规范空状态，revision 加一。
pub(crate) fn clear_cost_profile_impl(
    app: &AppContext,
    settings_state: &Mutex<AppSettings>,
    expected_revision: u64,
) -> Result<CostProfileSaveOutcome, String> {
    store_conditionally(app, settings_state, expected_revision, |_| {
        Ok(Decision::Write(CostProfile::cleared()))
    })
}

/// 保存或删除成功时要随 `settings-updated` 发出的载荷；冲突与校验失败不发。
fn announced(outcome: CostProfileSaveOutcome) -> (CostProfileSaveOutcome, Option<Value>) {
    let event = matches!(outcome, CostProfileSaveOutcome::Saved { .. })
        .then(|| json!({ "source": SETTINGS_UPDATED_SOURCE }));
    (outcome, event)
}

/// `validate_cost_profile` 命令的全部逻辑：设置页录入以本机今天为开始日期上界。
pub(crate) fn validate_for_settings_page(
    app: &AppContext,
    raw: &Value,
) -> Result<CostProfileValidation, String> {
    validate_cost_profile_impl(app, raw, local_today())
}

/// `save_cost_profile` 命令除发事件以外的全部逻辑（便于不依赖 `AppHandle` 测试）：
/// 设置页录入以本机今天为开始日期上界；第二项是成功时要发出的事件载荷。
pub(crate) fn save_for_settings_page(
    app: &AppContext,
    settings_state: &Mutex<AppSettings>,
    raw: &Value,
    expected_revision: u64,
) -> Result<(CostProfileSaveOutcome, Option<Value>), String> {
    save_cost_profile_impl(app, settings_state, raw, expected_revision, local_today())
        .map(announced)
}

/// `clear_cost_profile` 命令除发事件以外的全部逻辑；第二项是成功时要发出的事件载荷。
pub(crate) fn clear_for_settings_page(
    app: &AppContext,
    settings_state: &Mutex<AppSettings>,
    expected_revision: u64,
) -> Result<(CostProfileSaveOutcome, Option<Value>), String> {
    clear_cost_profile_impl(app, settings_state, expected_revision).map(announced)
}

#[tauri::command]
pub fn get_cost_profile(
    app_state: tauri::State<'_, Arc<AppContext>>,
) -> Result<CostProfileView, String> {
    get_cost_profile_impl(app_state.inner())
}

#[tauri::command]
pub fn validate_cost_profile(
    app_state: tauri::State<'_, Arc<AppContext>>,
    profile: Value,
) -> Result<CostProfileValidation, String> {
    validate_for_settings_page(app_state.inner(), &profile)
}

/// 保存成功后发出既有的 `settings-updated`，各窗口据此重读设置。
#[tauri::command]
pub async fn save_cost_profile(
    app_handle: tauri::AppHandle,
    app_state: tauri::State<'_, Arc<AppContext>>,
    settings_state: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    profile: Value,
    expected_revision: u64,
) -> Result<CostProfileSaveOutcome, String> {
    let app = app_state.inner().clone();
    let settings_state = settings_state.inner().clone();
    let (outcome, event) = tauri::async_runtime::spawn_blocking(move || {
        save_for_settings_page(&app, &settings_state, &profile, expected_revision)
    })
    .await
    .map_err(|_| TASK_ERROR.to_string())??;
    if let Some(payload) = event {
        let _ = app_handle.emit(SETTINGS_UPDATED_EVENT, payload);
    }
    Ok(outcome)
}

/// 「删除全部订阅设置」；成功后同样发出 `settings-updated`。
#[tauri::command]
pub async fn clear_cost_profile(
    app_handle: tauri::AppHandle,
    app_state: tauri::State<'_, Arc<AppContext>>,
    settings_state: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    expected_revision: u64,
) -> Result<CostProfileSaveOutcome, String> {
    let app = app_state.inner().clone();
    let settings_state = settings_state.inner().clone();
    let (outcome, event) = tauri::async_runtime::spawn_blocking(move || {
        clear_for_settings_page(&app, &settings_state, expected_revision)
    })
    .await
    .map_err(|_| TASK_ERROR.to_string())??;
    if let Some(payload) = event {
        let _ = app_handle.emit(SETTINGS_UPDATED_EVENT, payload);
    }
    Ok(outcome)
}
