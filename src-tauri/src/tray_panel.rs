//! 菜单栏 / 托盘增强：托盘数字用的「最紧额度」缓存，以及托盘面板的状态与三个快捷开关。
//!
//! - 最紧额度：每次本机额度读完（`quota::get_local_quota_providers_impl_*` 的末尾）记一份，
//!   托盘刷新时按当前时间重新挑，过期或已过重置时间的窗口不算（与额度提醒同一套读数）。
//! - 托盘面板：网关（模型接入总开关，面板里只能打开；关闭要去主窗口检查 Agent）、后台同步、后台扫描三个开关。挂件窗口只拿到这两条命令，
//!   拿不到通用 `save_settings`，也读不到任何密钥、地址或账号。

use std::sync::{Arc, Mutex, OnceLock};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::app_paths::AppContext;
use crate::gateway::Gateway;
use crate::quota::alerts::{fresh_percent_reading, source_name, window_name};
use crate::quota::{QuotaProviderEnvelope, QuotaStatus};
use crate::settings::{self, AppSettings, BackgroundPause};

/// 公司额度来源只看「今日」「本月」两条，与看板和挂件同一组（Key 日额度不在桌面展示）。
const COMPANY_PROVIDER_PREFIX: &str = "company-openapi-";
const COMPANY_WINDOWS: [&str; 2] = ["user-daily", "user-monthly"];
/// 面板不直接关网关：关之前要在主窗口检查仍指向网关的 Agent。
pub const GATEWAY_CLOSE_IN_MAIN: &str = "关闭网关请在主窗口「模型接入」完成";

fn quota_cache() -> &'static Mutex<Vec<QuotaProviderEnvelope>> {
    static CACHE: OnceLock<Mutex<Vec<QuotaProviderEnvelope>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

fn tray_app() -> &'static OnceLock<tauri::AppHandle> {
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    &APP
}

/// 应用启动时登记一次：之后任何一处读完额度（主窗口、挂件、后台），最紧额度一变就立即刷新托盘。
pub(crate) fn install_tray_refresher(app: tauri::AppHandle) {
    let _ = tray_app().set(app);
}

/// 记下最近一次本机额度读取的结果（整份替换：被关掉的来源随之消失）。
/// 单元测试里额度读取不经过这里（见 `quota::get_local_quota_providers_impl_with_retry_flag`）。
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn record_local_quota(providers: &[QuotaProviderEnvelope]) {
    let now = Utc::now();
    let changed = {
        let mut guard = quota_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = tightest_quota(&guard, now);
        *guard = providers.to_vec();
        before != tightest_quota(&guard, now)
    };
    if !changed {
        return;
    }
    if let Some(app) = tray_app().get() {
        if let Some(ctx) = app.try_state::<Arc<AppContext>>() {
            crate::refresh_tray_status(ctx.inner(), app);
        }
    }
}

/// 最紧的一条额度窗口：可用百分比、来源名与窗口名。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TightestQuota {
    pub remaining: u8,
    pub source: String,
    pub window: String,
}

/// 按「可用比例升序、同比例重置更早者优先」挑第一条，与 `collectQuotaHighlights` 同一排序。
pub fn tightest_quota(
    providers: &[QuotaProviderEnvelope],
    now: DateTime<Utc>,
) -> Option<TightestQuota> {
    let mut best: Option<(u8, Option<DateTime<Utc>>, String, TightestQuota)> = None;
    for provider in providers {
        if provider.status != QuotaStatus::Ok {
            continue;
        }
        let company = provider.provider_id.starts_with(COMPANY_PROVIDER_PREFIX);
        for window in &provider.windows {
            if company && !COMPANY_WINDOWS.contains(&window.window_id.as_str()) {
                continue;
            }
            let Some((remaining, resets_at)) = fresh_percent_reading(window, now) else {
                continue;
            };
            let key = format!("{}:{}", provider.provider_id, window.window_id);
            let better = match &best {
                None => true,
                Some((best_remaining, best_reset, best_key, _)) => {
                    (
                        remaining,
                        resets_at.unwrap_or(DateTime::<Utc>::MAX_UTC),
                        &key,
                    ) < (
                        *best_remaining,
                        best_reset.unwrap_or(DateTime::<Utc>::MAX_UTC),
                        best_key,
                    )
                }
            };
            if better {
                let reading = TightestQuota {
                    remaining,
                    source: source_name(provider),
                    window: window_name(window),
                };
                best = Some((remaining, resets_at, key, reading));
            }
        }
    }
    best.map(|(_, _, _, reading)| reading)
}

pub(crate) fn current_tightest_quota() -> Option<TightestQuota> {
    let guard = quota_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    tightest_quota(&guard, Utc::now())
}

/// 托盘面板顶部开关区要的状态。只有开关与运行状态，不带地址、令牌或错误原文。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrayPanelStatus {
    /// 模型接入总开关（网关监听随它启停）。
    pub gateway_enabled: bool,
    pub gateway_running: bool,
    pub gateway_port: u16,
    /// 网关开着却没在监听（端口被占等）：面板只说「未运行」，原因去主窗口看。
    pub gateway_failed: bool,
    /// 网关开着但没有启用的供应商：不会启动，也没有错误。面板提示去主窗口添加，而不是一直写「正在启动」。
    pub gateway_no_provider: bool,
    pub sync_paused: bool,
    pub scan_paused: bool,
    pub scan_interval_secs: u64,
}

/// 网关「开着却没在跑」时的两种原因：有错误（端口被占等）记为失败；没有错误且没有启用的供应商
/// 记为未配置。两者都不是时才是真的正在启动。返回 (failed, no_provider)。
fn gateway_idle_reason(
    enabled: bool,
    running: bool,
    has_error: bool,
    has_provider: bool,
) -> (bool, bool) {
    let idle = enabled && !running;
    (idle && has_error, idle && !has_error && !has_provider)
}

fn panel_status(settings: &AppSettings, gateway: &Gateway) -> TrayPanelStatus {
    let status = gateway.status();
    let (gateway_failed, gateway_no_provider) = gateway_idle_reason(
        settings.model_access_enabled,
        status.running,
        status.error.is_some(),
        gateway.has_enabled_provider(),
    );
    TrayPanelStatus {
        gateway_enabled: settings.model_access_enabled,
        gateway_running: status.running,
        gateway_port: status.port,
        gateway_failed,
        gateway_no_provider,
        sync_paused: settings.background_sync_paused,
        scan_paused: settings.background_scan_paused,
        scan_interval_secs: settings.scan_interval_secs,
    }
}

/// 快捷开关的目标。字符串取值是闭合集合，未知值直接拒绝。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanelToggle {
    Gateway,
    Sync,
    Scan,
}

impl PanelToggle {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "gateway" => Ok(PanelToggle::Gateway),
            "sync" => Ok(PanelToggle::Sync),
            "scan" => Ok(PanelToggle::Scan),
            _ => Err("未知的快捷开关".to_string()),
        }
    }
}

fn store_settings(state: &Mutex<AppSettings>, saved: &AppSettings) {
    let mut guard = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.model_access_enabled = saved.model_access_enabled;
    guard.background_scan_paused = saved.background_scan_paused;
    guard.background_sync_paused = saved.background_sync_paused;
}

#[tauri::command]
pub fn tray_panel_status(
    settings_state: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<TrayPanelStatus, String> {
    let settings = settings_state
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    Ok(panel_status(&settings, &gateway))
}

/// 托盘面板的快捷开关。每一项都只改自己那个字段（专用读改写），改完广播
/// `settings-updated`，主窗口与另一块挂件随之刷新。
#[tauri::command]
pub fn tray_panel_toggle(
    app_handle: tauri::AppHandle,
    app: tauri::State<'_, Arc<AppContext>>,
    settings_state: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    gateway: tauri::State<'_, Arc<Gateway>>,
    target: String,
    enabled: bool,
) -> Result<TrayPanelStatus, String> {
    let target = PanelToggle::parse(&target)?;
    let saved = match target {
        // 关网关要先检查哪些 Agent 还指向网关并提供恢复（主窗口「模型接入」卡片），面板只负责打开；
        // 这里拒绝关闭，避免绕过那一步让 Agent 的请求无声失败。
        PanelToggle::Gateway if !enabled => return Err(GATEWAY_CLOSE_IN_MAIN.to_string()),
        PanelToggle::Gateway => {
            let saved = settings::update_model_access_enabled(&app, enabled)?;
            gateway.set_enabled(saved.model_access_enabled);
            saved
        }
        // 开关文案是「后台同步 / 后台扫描」开着，存的是「暂停」，所以取反。
        PanelToggle::Sync => {
            settings::update_background_pause(&app, BackgroundPause::Sync, !enabled)?
        }
        PanelToggle::Scan => {
            settings::update_background_pause(&app, BackgroundPause::Scan, !enabled)?
        }
    };
    store_settings(&settings_state, &saved);
    let _ = app_handle.emit(
        "settings-updated",
        serde_json::json!({ "source": "tray-panel" }),
    );
    if let Some(state) = app_handle.try_state::<Arc<Mutex<AppSettings>>>() {
        if let Ok(guard) = state.lock() {
            return Ok(panel_status(&guard, &gateway));
        }
    }
    Ok(panel_status(&saved, &gateway))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::{
        QuotaCapability, QuotaMode, QuotaScope, QuotaSource, QuotaUnit, QuotaWindowSnapshot,
        QuotaWindowStatus,
    };

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-24T03:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn window(
        provider_id: &str,
        window_id: &str,
        used: f64,
        resets_in_minutes: i64,
    ) -> QuotaWindowSnapshot {
        let observed = (now() - chrono::Duration::minutes(1)).to_rfc3339();
        QuotaWindowSnapshot {
            provider_id: provider_id.to_string(),
            window_id: window_id.to_string(),
            window_label: window_id.to_string(),
            account_label: None,
            scope: QuotaScope::ConsumerSubscription,
            source: QuotaSource::LocalAuthorized,
            status: QuotaWindowStatus::Ok,
            used: Some(used),
            limit: Some(100.0),
            remaining: Some(100.0 - used),
            unit: QuotaUnit::Percent,
            currency: None,
            window_minutes: Some(300),
            resets_at: Some((now() + chrono::Duration::minutes(resets_in_minutes)).to_rfc3339()),
            observed_at: observed.clone(),
            fetched_at: observed,
            stale_after_seconds: 900,
            reason_code: None,
        }
    }

    fn provider(provider_id: &str, windows: Vec<QuotaWindowSnapshot>) -> QuotaProviderEnvelope {
        QuotaProviderEnvelope {
            schema_version: 1,
            provider_id: provider_id.to_string(),
            display_name: provider_id.to_string(),
            scope: QuotaScope::ConsumerSubscription,
            mode: QuotaMode::Automatic,
            capability: QuotaCapability::Stable,
            status: QuotaStatus::Ok,
            windows,
            reason_code: None,
            action: None,
        }
    }

    #[test]
    fn tightest_quota_picks_the_lowest_remaining_then_the_earliest_reset() {
        let providers = vec![
            provider(
                "openai-codex-local",
                vec![window("openai-codex-local", "primary", 40.0, 90)],
            ),
            provider(
                "anthropic-claude-consumer",
                vec![
                    window("anthropic-claude-consumer", "five-hour", 63.0, 120),
                    window("anthropic-claude-consumer", "weekly", 63.0, 30),
                ],
            ),
        ];
        let tightest = tightest_quota(&providers, now()).expect("readable windows");
        assert_eq!(tightest.remaining, 37);
        assert_eq!(tightest.source, "Claude");
    }

    #[test]
    fn stale_or_passed_windows_do_not_count() {
        let mut stale = window("openai-codex-local", "primary", 90.0, 60);
        stale.observed_at = (now() - chrono::Duration::hours(2)).to_rfc3339();
        let passed = window("anthropic-claude-consumer", "five-hour", 95.0, -5);
        let providers = vec![
            provider("openai-codex-local", vec![stale]),
            provider("anthropic-claude-consumer", vec![passed]),
        ];
        assert_eq!(tightest_quota(&providers, now()), None);
    }

    #[test]
    fn company_sources_only_offer_the_daily_and_monthly_windows() {
        let id = "company-openapi-abcdefgh12";
        let providers = vec![provider(
            id,
            vec![
                window(id, "key-daily", 99.0, 60),
                window(id, "user-monthly", 30.0, 600),
            ],
        )];
        assert_eq!(
            tightest_quota(&providers, now()).map(|item| item.remaining),
            Some(70)
        );
    }

    #[test]
    fn gateway_close_message_points_to_the_main_window() {
        assert!(GATEWAY_CLOSE_IN_MAIN.contains("主窗口"));
    }

    #[test]
    fn an_enabled_gateway_without_providers_is_not_reported_as_starting() {
        assert_eq!(
            gateway_idle_reason(true, false, false, false),
            (false, true)
        );
        assert_eq!(gateway_idle_reason(true, false, true, false), (true, false));
        assert_eq!(
            gateway_idle_reason(true, false, false, true),
            (false, false)
        );
        assert_eq!(gateway_idle_reason(true, true, false, true), (false, false));
        assert_eq!(
            gateway_idle_reason(false, false, false, false),
            (false, false)
        );
    }

    #[test]
    fn unknown_toggle_targets_are_rejected() {
        assert_eq!(PanelToggle::parse("gateway"), Ok(PanelToggle::Gateway));
        assert_eq!(PanelToggle::parse("sync"), Ok(PanelToggle::Sync));
        assert_eq!(PanelToggle::parse("scan"), Ok(PanelToggle::Scan));
        assert!(PanelToggle::parse("save_settings").is_err());
    }
}
