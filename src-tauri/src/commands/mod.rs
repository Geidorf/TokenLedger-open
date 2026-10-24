use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use chrono::{
    DateTime, Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, NaiveTime,
    TimeZone, Utc,
};
use chrono_tz::Tz;
use reqwest::Url;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::Emitter;

use crate::app_paths::AppContext;
use crate::cache;
use crate::db;
use crate::scanner;
use crate::stats_query::{
    ascii_trim, fingerprint_json, normalize_filters, EntityKind, EntitySelectorInput,
    NormalizedEntitySelector, MAX_CURSOR_BYTES,
};
use crate::wallpaper;

mod auth_http;

const WALLPAPER_HISTORY_LIMIT: usize = 5;
static WALLPAPER_UPDATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[cfg(target_os = "windows")]
static EVENT_LOCKSCREEN_REFRESH_PENDING: AtomicBool = AtomicBool::new(false);

fn emit_app_event(app_handle: &tauri::AppHandle, event: &str) {
    let _ = app_handle.emit(event, json!({ "source": "backend" }));
}

fn is_missing_rpc_signature(status: reqwest::StatusCode, body: &str, function_name: &str) -> bool {
    status == reqwest::StatusCode::NOT_FOUND
        && body
            .to_ascii_lowercase()
            .contains(&function_name.to_ascii_lowercase())
        && (body.contains("PGRST202")
            || body
                .to_ascii_lowercase()
                .contains("could not find the function")
            || body.to_ascii_lowercase().contains("schema cache"))
}

/// T10.185: a Stats v2 RPC signature can exist while the specific database has
/// not yet run migration `20260905162953_android_custom_date_ranges.sql`. On
/// such a project every v2 RPC still shares `private.tokenledger_normalize_query_v2`,
/// whose pre-custom form raises this exact, stable diagnostic for any `range`
/// it does not recognise — `custom` included: HTTP 400, SQLSTATE `22023`, and
/// the literal message `query-v2: invalid range custom`.
///
/// T10.185 review P3-2: matches Android's
/// `SupabaseHttpException.isLegacyCustomRangeRejection` (`SupabaseGateway.kt`)
/// field-for-field rather than "22023 and the words somewhere in the body" —
/// a parsed `code` of exactly `22023` (not merely present as a substring),
/// plus the `message` field containing both the `query-v2:` prefix and the
/// contiguous `invalid range custom` phrase. This matters because a
/// different, equally real `22023` — e.g. `query-v2: custom range exceeds
/// 731 days` — must not be misread as the migration-not-run signal; Android
/// has an explicit test for exactly that (`SupabaseGatewayTest.kt`).
fn is_custom_range_rejected_by_schema(status: reqwest::StatusCode, body: &str) -> bool {
    if status != reqwest::StatusCode::BAD_REQUEST {
        return false;
    }
    let Ok(parsed) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    if parsed.get("code").and_then(Value::as_str) != Some("22023") {
        return false;
    }
    let message = parsed
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    message.contains("query-v2:") && message.contains("invalid range custom")
}

fn supabase_api_error(status: reqwest::StatusCode, _body: String) -> String {
    format!("Supabase API request failed (HTTP {}).", status.as_u16())
}

// =============================================================================
// Bounded retry for cloud HTTP sends
// =============================================================================
// T10.18: a transient connect/timeout blip (e.g. proxy egress jitter) used to
// bubble straight up as a one-shot `error sending request` failure. These
// helpers classify reqwest send errors and retry only the network-layer kinds
// that are safe to retry — never an HTTP response, and never a request body
// error. Each attempt rebuilds the `RequestBuilder` via the supplied closure,
// because a consumed builder cannot be re-sent.

/// How many times a network-layer send error is retried (so total attempts =
/// 1 + this value).
const CLOUD_HTTP_MAX_RETRIES: usize = 3;
/// Base backoff; attempt `n` waits `base * 2^n` plus a small deterministic
/// jitter derived from the attempt index (no `rand` dependency needed).
const CLOUD_HTTP_RETRY_BASE_MILLIS: u64 = 200;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CloudSendErrorKind {
    Connect,
    Timeout,
    /// Network-level failure that is neither connect nor timeout (e.g.
    /// connection reset mid-request). Still safe to retry.
    Network,
    /// Not retryable: request construction, redirect policy, body, or a
    /// decoded/HTTP-layer error.
    Other,
}

fn classify_reqwest_send_error(error: &reqwest::Error) -> CloudSendErrorKind {
    if error.is_timeout() {
        CloudSendErrorKind::Timeout
    } else if error.is_connect() {
        CloudSendErrorKind::Connect
    } else if error.is_request() || error.is_body() || error.is_decode() || error.is_redirect() {
        CloudSendErrorKind::Other
    } else {
        // reqwest exposes no finer variant for mid-stream connection resets;
        // those surface here and are safe to retry.
        CloudSendErrorKind::Network
    }
}

impl CloudSendErrorKind {
    fn label(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Timeout => "timeout",
            Self::Network => "network",
            Self::Other => "other",
        }
    }

    fn is_retryable(self) -> bool {
        !matches!(self, Self::Other)
    }
}

fn cloud_http_retry_backoff(attempt: usize) -> std::time::Duration {
    let shift = attempt.min(10) as u32;
    let base = CLOUD_HTTP_RETRY_BASE_MILLIS.saturating_mul(1u64 << shift);
    // Deterministic jitter (0..=base/2) without a RNG dependency.
    let jitter = if attempt == 0 {
        0
    } else {
        (base / 2) / (attempt as u64).saturating_add(1)
    };
    std::time::Duration::from_millis(base.saturating_add(jitter))
}

/// Send a cloud request with bounded exponential backoff, retrying only
/// retryable network-layer errors. `build` must return a fresh
/// `RequestBuilder` on every call. `context` labels the operation in logs and
/// the final error message.
async fn send_cloud_request_with_retry<F>(
    context: &str,
    build: F,
) -> Result<reqwest::Response, String>
where
    F: Fn() -> reqwest::RequestBuilder,
{
    let mut attempt = 0usize;
    loop {
        let result = build().send().await;
        match result {
            Ok(response) => return Ok(response),
            Err(error) => {
                let kind = classify_reqwest_send_error(&error);
                if !kind.is_retryable() || attempt >= CLOUD_HTTP_MAX_RETRIES {
                    return Err(format!("{context} failed [{}]: {error}", kind.label()));
                }
                let backoff = cloud_http_retry_backoff(attempt);
                eprintln!(
                    "{context} send failed [{}] (attempt {}/{}), retrying in {}ms: {error}",
                    kind.label(),
                    attempt + 1,
                    CLOUD_HTTP_MAX_RETRIES + 1,
                    backoff.as_millis()
                );
                tokio::time::sleep(backoff).await;
                attempt += 1;
            }
        }
    }
}

// =============================================================================
// Tauri command wrappers
// =============================================================================
// The original `pub fn xxx(app: &AppContext, ...)` signatures are kept as
// the canonical internal API (used by the background scheduler and the
// eframe path during transition). Each command that the React frontend
// invokes has a sibling `#[tauri::command] xxx_cmd` wrapper that resolves
// the AppContext from `tauri::State<Arc<AppContext>>` and forwards to the
// internal version. This keeps the surface to the Tauri runtime tiny
// while preserving the existing call sites.

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn quote_statusline_executable(path: &Path) -> String {
    #[cfg(windows)]
    {
        format!("\"{}\"", path.to_string_lossy().replace('%', "%%"))
    }
    #[cfg(not(windows))]
    {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\"'\"'"))
    }
}

fn statusline_settings_command(path: &Path) -> Result<String, String> {
    let shell_command = format!("{} --claude-statusline", quote_statusline_executable(path));
    let json_value = serde_json::to_string(&shell_command)
        .map_err(|_| "Unable to encode the Claude status-line command.".to_string())?;
    Ok(format!("\"command\": {json_value}"))
}

/// 完整可粘贴的 `statusLine` 对象。
///
/// 此前设置页只给 `"command": …` 这一行**片段**，既没有外层 `statusLine` 对象也
/// 没有 `"type"`，用户复制过去无法直接使用——这是「两个开关都开了却一直读不到
/// 额度」的直接原因之一。
fn statusline_settings_block(path: &Path) -> Result<String, String> {
    let shell_command = format!("{} --claude-statusline", quote_statusline_executable(path));
    let block = serde_json::json!({
        "statusLine": { "type": "command", "command": shell_command }
    });
    serde_json::to_string_pretty(&block)
        .map_err(|_| "Unable to encode the Claude status-line settings block.".to_string())
}

/// Claude Code 全局设置文件路径。两个平台都是 `~/.claude/settings.json`，但要把
/// 真实展开后的绝对路径显示给用户，而不是让他自己猜 `~` 在哪。设置了
/// `CLAUDE_CONFIG_DIR` 时以它为准（GUI 进程只能看到自己继承到的环境变量）。
fn claude_settings_file_path() -> Option<PathBuf> {
    claude_settings_path_from(std::env::var_os("CLAUDE_CONFIG_DIR"), dirs::home_dir())
}

fn claude_settings_path_from(
    config_dir: Option<std::ffi::OsString>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(dir) = config_dir.filter(|dir| !dir.is_empty()) {
        let text = dir.to_string_lossy();
        let expanded = match (text.strip_prefix("~/"), home.as_ref()) {
            (Some(rest), Some(home)) => Some(home.join(rest)),
            _ => Some(PathBuf::from(&dir)).filter(|path| path.is_absolute()),
        };
        if let Some(dir) = expanded {
            return Some(dir.join("settings.json"));
        }
    }
    home.map(|home| home.join(".claude").join("settings.json"))
}

fn claude_helper_command() -> Result<String, String> {
    let executable =
        std::env::current_exe().map_err(|_| "无法确定 TokenLedger 可执行文件路径。".to_string())?;
    Ok(format!(
        "{} --claude-statusline",
        quote_statusline_executable(&executable)
    ))
}

fn required_claude_settings_path() -> Result<PathBuf, String> {
    claude_settings_file_path()
        .ok_or_else(|| "找不到用户主目录，无法定位 Claude Code 配置。".to_string())
}

/// 读取 Claude Code 设置，判断 statusLine 是否已经指向本应用。
///
/// 只解析出一个布尔值，不保留、不回传文件里的任何其他内容。
fn statusline_is_wired(path: &Path) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    value
        .get("statusLine")
        .and_then(|status_line| status_line.get("command"))
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains("--claude-statusline"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeQuotaSetup {
    /// 完整的 `statusLine` 对象，可直接合并进设置文件。
    settings_block: String,
    /// 兼容旧界面的单行 `"command": …` 片段。
    command_property: String,
    /// Claude Code 设置文件的绝对路径；解析不出主目录时为空。
    settings_path: String,
    /// statusLine 是否已经指向本应用——没接上时界面要直说，而不是干等。
    status_line_wired: bool,
    /// TokenLedger 是否已经收到过至少一次快照。
    snapshot_present: bool,
    /// 内置 `/usage` 探针实际会依次尝试的 CLI。为空即本机找不到 Claude CLI。
    cli_candidates: Vec<String>,
    /// 一键接入留下的备份；为空即没有可恢复的写入。
    backup: Option<crate::quota::claude_setup::ClaudeStatuslineBackup>,
    /// 是否有原 status line 由 helper 继续执行。
    chain_present: bool,
}

#[tauri::command]
pub fn get_claude_quota_setup(
    app_state: tauri::State<'_, Arc<AppContext>>,
) -> Result<ClaudeQuotaSetup, String> {
    let executable =
        std::env::current_exe().map_err(|_| "Unable to resolve the TokenLedger executable.")?;
    let settings_path = claude_settings_file_path();
    let app_data_dir = app_state.inner().app_data_dir();
    Ok(ClaudeQuotaSetup {
        settings_block: statusline_settings_block(&executable)?,
        command_property: statusline_settings_command(&executable)?,
        status_line_wired: settings_path.as_deref().is_some_and(statusline_is_wired),
        backup: settings_path
            .as_deref()
            .and_then(|path| crate::quota::claude_setup::backup(path, app_data_dir)),
        chain_present: crate::quota::claude_setup::chain_present(app_data_dir),
        settings_path: settings_path
            .map(|path: PathBuf| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        snapshot_present: app_state
            .inner()
            .app_data_dir()
            .join("claude_statusline_quota.json")
            .is_file(),
        cli_candidates: crate::quota::claude_cli_candidate_paths(),
    })
}

/// 设置页打开时的本机来源检测：只看路径元数据，不启动进程、不读凭据。
#[tauri::command]
pub fn detect_quota_sources() -> Vec<crate::quota::detect::QuotaSourceDetection> {
    let claude_config_dir = claude_settings_file_path()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf));
    crate::quota::detect::detect_local_quota_sources(claude_config_dir.as_deref())
}

/// 「供应商」页里的每个供应商能否读官方余额、是否已开启；只读元数据，不读钥匙串。
#[tauri::command]
pub fn list_quota_balance_sources(
    app_state: tauri::State<'_, Arc<AppContext>>,
) -> Result<Vec<crate::quota::balance::BalanceSourceView>, String> {
    crate::quota::balance::list_quota_balance_sources_impl(app_state.inner().as_ref())
}

/// 逐个开启或关闭供应商余额；中转站需带同源余额地址、取值路径与币种。
#[tauri::command]
pub fn set_quota_balance_source(
    app_state: tauri::State<'_, Arc<AppContext>>,
    input: crate::quota::balance::SetBalanceSourceInput,
) -> Result<Vec<crate::quota::balance::BalanceSourceView>, String> {
    crate::quota::balance::set_quota_balance_source_impl(app_state.inner().as_ref(), input)
}

/// 实验性套餐用量来源（智谱 GLM、MiniMax、Kimi Code）的开关与风险确认状态；只读元数据，不读钥匙串。
#[tauri::command]
pub fn list_quota_experimental_plans(
    app_state: tauri::State<'_, Arc<AppContext>>,
) -> Result<Vec<crate::quota::balance::experimental::ExperimentalPlanView>, String> {
    crate::quota::balance::experimental::list_quota_experimental_plans_impl(
        app_state.inner().as_ref(),
    )
}

/// 开启实验来源前必须带上当前风险提示版本完成确认；关闭会清理该来源的本机旧值。
#[tauri::command]
pub fn set_quota_experimental_plan(
    app_state: tauri::State<'_, Arc<AppContext>>,
    input: crate::quota::balance::experimental::SetExperimentalPlanInput,
) -> Result<Vec<crate::quota::balance::experimental::ExperimentalPlanView>, String> {
    crate::quota::balance::experimental::set_quota_experimental_plan_impl(
        app_state.inner().as_ref(),
        input,
    )
}

#[tauri::command]
pub fn get_claude_statusline_command() -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|_| "Unable to resolve the TokenLedger executable.".to_string())?;
    statusline_settings_command(&executable)
}

/// 预览一键接入要对 Claude Code `settings.json` 做的改动（只含 `statusLine`）。
#[tauri::command]
pub fn preview_claude_statusline_setup(
) -> Result<crate::quota::claude_setup::ClaudeStatuslinePreview, String> {
    crate::quota::claude_setup::preview(
        &required_claude_settings_path()?,
        &claude_helper_command()?,
        dirs::home_dir().as_deref(),
    )
}

/// 按预览时的版本写入；预览之后文件被外部改过就拒绝。
#[tauri::command]
pub fn apply_claude_statusline_setup(
    app_state: tauri::State<'_, Arc<AppContext>>,
    expected_version: String,
) -> Result<crate::quota::claude_setup::ClaudeStatuslineApplyResult, String> {
    let app = app_state.inner();
    if !settings::load_settings(app).quota_claude_statusline_enabled {
        return Err("请先打开「读取 Claude 额度」，再一键接入。".to_string());
    }
    crate::quota::claude_setup::apply(
        &required_claude_settings_path()?,
        app.app_data_dir(),
        &claude_helper_command()?,
        &expected_version,
    )
}

/// 写回接入前的 `settings.json`；接入后文件被改过时需要 `force`。
#[tauri::command]
pub fn restore_claude_statusline_setup(
    app_state: tauri::State<'_, Arc<AppContext>>,
    force: bool,
) -> Result<crate::quota::claude_setup::ClaudeStatuslineRestoreResult, String> {
    crate::quota::claude_setup::restore(
        &required_claude_settings_path()?,
        app_state.inner().app_data_dir(),
        force,
    )
}

#[cfg(test)]
mod quota_setup_command_tests {
    use super::*;

    #[test]
    fn claude_settings_path_honours_claude_config_dir() {
        let home = PathBuf::from(if cfg!(windows) {
            r"C:\Users\demo"
        } else {
            "/home/demo"
        });
        let custom = if cfg!(windows) {
            r"D:\claude-alt"
        } else {
            "/opt/claude-alt"
        };
        assert_eq!(
            claude_settings_path_from(Some(custom.into()), Some(home.clone())),
            Some(PathBuf::from(custom).join("settings.json"))
        );
        assert_eq!(
            claude_settings_path_from(Some("~/alt".into()), Some(home.clone())),
            Some(home.join("alt").join("settings.json"))
        );
        for ignored in ["", "relative/dir"] {
            assert_eq!(
                claude_settings_path_from(Some(ignored.into()), Some(home.clone())),
                Some(home.join(".claude").join("settings.json"))
            );
        }
        assert_eq!(
            claude_settings_path_from(None, Some(home.clone())),
            Some(home.join(".claude").join("settings.json"))
        );
    }

    #[test]
    fn statusline_command_quotes_the_complete_executable_path() {
        let path = if cfg!(windows) {
            Path::new(r"C:\Program Files\TokenLedger\tokenledger.exe")
        } else {
            Path::new("/Applications/Token Ledger's.app/tokenledger")
        };
        let property = statusline_settings_command(path).expect("encode command property");
        let object: Value = serde_json::from_str(&format!("{{{property}}}"))
            .expect("command property is valid JSON");
        let command = object["command"].as_str().expect("string command");
        assert!(command.contains("--claude-statusline"));
        if cfg!(windows) {
            assert!(command.contains("TokenLedger"));
        } else {
            assert!(command.contains("Token Ledger"));
        }
    }
}

#[tauri::command]
pub fn get_settings(
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<crate::settings::AppSettings, String> {
    get_settings_impl(state.inner())
}

/// 设置页据此决定显示「开机自动启动」开关还是「应用内暂不支持」。
#[tauri::command]
pub fn autostart_supported() -> bool {
    crate::autostart::supported()
}

#[tauri::command]
pub async fn save_settings(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
    settings_state: tauri::State<'_, Arc<Mutex<crate::settings::AppSettings>>>,
    settings: crate::settings::AppSettings,
) -> Result<Value, String> {
    let (previous, settings) =
        persist_general_settings_change(state.inner(), settings_state.inner(), settings)?;
    crate::quota::clear_disabled_provider_data(
        state.app_data_dir(),
        settings.quota_codex_local_enabled,
        settings.quota_claude_statusline_enabled,
        settings.quota_claude_codexbar_enabled,
        settings.quota_antigravity_local_enabled,
        settings.quota_antigravity_codexbar_enabled,
    );

    let (quota_sync_warning, quota_cleanup_pending) =
        crate::quota_sync::handle_provider_authorization_change(
            state.inner(),
            settings_state.inner(),
            &previous,
            &settings,
        )
        .await;
    let settings = settings::load_settings(state.inner());
    let autostart_warning = if previous.autostart_enabled != settings.autostart_enabled {
        crate::autostart::apply(settings.autostart_enabled)
            .err()
            .map(|error| format!("设置已保存，但开机自动启动没有生效：{error}"))
    } else {
        None
    };
    // 桌面小组件随设置页开关即时创建/移除（T10.110）。
    crate::widget_window::sync_desktop_widget_from_settings(&app_handle, &settings);
    // 切换 macOS 菜单栏标题开关要立即生效，不等下一次后台扫描周期（R-52）。
    if previous.tray_text_enabled != settings.tray_text_enabled
        || previous.tray_text_metric != settings.tray_text_metric
    {
        crate::refresh_tray_status(state.inner(), &app_handle);
    }

    #[cfg(target_os = "macos")]
    let wallpaper_changed = wallpaper_settings_changed(&previous, &settings);
    #[cfg(target_os = "macos")]
    let wallpaper_warning = if wallpaper_changed {
        let app_ctx = state.inner().clone();
        let app_handle_for_wallpaper = app_handle.clone();
        let settings_for_wallpaper = settings.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            if should_show_dynamic_wallpaper(&settings_for_wallpaper) {
                crate::macos_wallpaper_window::show_wallpaper_window(&app_handle_for_wallpaper)
            } else {
                crate::macos_wallpaper_window::hide_wallpaper_window(&app_handle_for_wallpaper)?;
                if settings_for_wallpaper.wallpaper_automation_authorized()
                    && settings_for_wallpaper.wallpaper_desktop_enabled
                {
                    update_wallpaper_impl(&app_ctx, "desktop".to_string())?;
                }
                Ok(())
            }
        })
        .await
        {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(format!("壁纸设置已保存，但应用失败：{error}")),
            Err(error) => Some(format!("壁纸设置已保存，但后台任务失败：{error}")),
        }
    } else {
        None
    };

    #[cfg(not(target_os = "macos"))]
    let wallpaper_warning: Option<String> = None;
    #[cfg(target_os = "macos")]
    if wallpaper_changed {
        emit_app_event(&app_handle, "settings-updated");
    }

    Ok(json!({
        "message": quota_sync_warning.unwrap_or_else(|| "保存设置成功".to_string()),
        "settings": settings,
        "quotaCleanupPending": quota_cleanup_pending,
        "wallpaperWarning": wallpaper_warning,
        "autostartWarning": autostart_warning
    }))
}

#[cfg(any(target_os = "macos", test))]
fn should_show_dynamic_wallpaper(settings: &AppSettings) -> bool {
    settings.wallpaper_automation_authorized()
        && settings.wallpaper_desktop_enabled
        && settings.wallpaper_dynamic_bg_enabled
}

#[cfg(any(target_os = "macos", test))]
fn wallpaper_settings_changed(previous: &AppSettings, current: &AppSettings) -> bool {
    previous.wallpaper_consent_version != current.wallpaper_consent_version
        || previous.wallpaper_desktop_enabled != current.wallpaper_desktop_enabled
        || previous.wallpaper_dynamic_bg_enabled != current.wallpaper_dynamic_bg_enabled
        || previous.wallpaper_use_cloud != current.wallpaper_use_cloud
        || previous.wallpaper_device_filter != current.wallpaper_device_filter
}

fn persist_general_settings_change(
    app: &AppContext,
    settings_state: &Arc<Mutex<crate::settings::AppSettings>>,
    incoming: crate::settings::AppSettings,
) -> Result<(crate::settings::AppSettings, crate::settings::AppSettings), String> {
    let mut guard = settings_state
        .lock()
        .map_err(|_| "settings state lock poisoned".to_string())?;
    let previous = guard.clone();
    let candidate = incoming.sanitized();
    // Provider authorization only controls this device's producer. Removing
    // it must not delete another device's durable cloud snapshot.
    crate::quota_sync::prepare_provider_authorization_change(app, &previous, &candidate)?;
    // The settings module serializes this whole-file RMW with the dedicated
    // quota-sync toggle, preserving the latest authoritative opt-in.
    let next = settings::save_general_settings_preserving_quota_sync(app, &previous, candidate)?;
    *guard = next.clone();
    Ok((previous, next))
}

#[tauri::command]
pub fn get_prices(state: tauri::State<'_, Arc<AppContext>>) -> Result<Value, String> {
    get_prices_impl(state.inner())
}

// 以下几个命令会做整表 UPDATE / 全表导出 / COUNT(*)：同步 #[tauri::command]
// 在 Tauri 2 里跑在主线程，UI 冻结随表规模线性增长，因此统一改为
// async + spawn_blocking（与 refresh_scan 同一范式）。
#[tauri::command]
pub async fn save_prices(
    state: tauri::State<'_, Arc<AppContext>>,
    prices: Value,
    price_table_revision: Option<u64>,
) -> Result<Value, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        save_prices_for_editor(&app, prices, price_table_revision)
    })
    .await
    .map_err(|error| format!("save_prices task panicked: {error}"))?
}

#[tauri::command]
pub fn reset_prices(state: tauri::State<'_, Arc<AppContext>>) -> Result<Value, String> {
    reset_prices_impl(state.inner())
}

/// The settings page's one-time notice about the last migration of the price
/// override file (T10.189, U-5 and U-6); `null` when there is none to show.
#[tauri::command]
pub fn get_price_migration_notice(
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<Option<PriceMigrationNoticeView>, String> {
    get_price_migration_notice_impl(state.inner())
}

/// Where the default prices come from (bundled or updated online), their
/// revision and dates, and the auto-update setting (`price_feed`).
#[tauri::command]
pub fn get_price_table_status(
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<price_feed::PriceTableStatus, String> {
    Ok(price_feed::status(state.inner().app_data_dir()))
}

/// Checks the online price table now, whatever the schedule says.
#[tauri::command]
pub async fn check_price_table_update(
    state: tauri::State<'_, Arc<AppContext>>,
    app_handle: tauri::AppHandle,
) -> Result<price_feed::PriceTableStatus, String> {
    let (status, updated) = price_feed::check_for_update(state.inner(), true).await;
    if updated {
        emit_app_event(&app_handle, "prices-updated");
    }
    Ok(status)
}

#[tauri::command]
pub fn set_price_table_auto_update(
    state: tauri::State<'_, Arc<AppContext>>,
    enabled: bool,
) -> Result<price_feed::PriceTableStatus, String> {
    price_feed::set_auto_update(state.inner().app_data_dir(), enabled)
}

/// Starts the daily online price table check (`price_feed`).
pub fn start_price_table_updates(app: Arc<AppContext>, handle: tauri::AppHandle) {
    price_feed::start_scheduler(app, handle);
}

#[tauri::command]
pub fn dismiss_price_migration_notice(
    state: tauri::State<'_, Arc<AppContext>>,
    id: String,
) -> Result<(), String> {
    dismiss_price_migration_notice_impl(state.inner(), &id)
}

#[tauri::command]
pub async fn get_db_info(state: tauri::State<'_, Arc<AppContext>>) -> Result<Value, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_db_info_impl(&app))
        .await
        .map_err(|error| format!("get_db_info task panicked: {error}"))?
}

#[tauri::command]
pub async fn export_db_csv(state: tauri::State<'_, Arc<AppContext>>) -> Result<Value, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || export_db_csv_impl(&app))
        .await
        .map_err(|error| format!("export_db_csv task panicked: {error}"))?
}

/// 用量 · 请求的「导出 CSV」：正文由前端按当前筛选逐页取完后生成（本地与云端同一条路径），
/// 这里只负责写到应用数据目录下的固定文件名，前端给不了路径。
#[tauri::command]
pub async fn export_usage_csv(
    state: tauri::State<'_, Arc<AppContext>>,
    content: String,
) -> Result<Value, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || export_usage_csv_impl(&app, &content))
        .await
        .map_err(|error| format!("export_usage_csv task panicked: {error}"))?
}

#[tauri::command]
pub async fn cleanup_db(
    state: tauri::State<'_, Arc<AppContext>>,
    before_date: String,
) -> Result<Value, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cleanup_db_impl(&app, before_date))
        .await
        .map_err(|error| format!("cleanup_db task panicked: {error}"))?
}

#[tauri::command]
pub async fn reclaim_db_space(state: tauri::State<'_, Arc<AppContext>>) -> Result<Value, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reclaim_db_space_impl(&app))
        .await
        .map_err(|error| format!("reclaim_db_space task panicked: {error}"))?
}

#[tauri::command]
pub fn cleanup_wallpaper(state: tauri::State<'_, Arc<AppContext>>) -> Result<Value, String> {
    let app_dir = state.app_data_dir();
    let wp_dir = app_dir.join("wallpapers");
    let ls_dir = app_dir.join("lockscreens");

    // Keep the stable current files because the operating system may still
    // reference them. Only TokenLedger-owned rollback history is removable.
    let wallpaper_removed = cleanup_history_files_strict(&wp_dir, "wallpaper_")?;
    let lockscreen_removed = cleanup_history_files_strict(&ls_dir, "lockscreen_")?;

    Ok(json!({
        "message": "历史壁纸已清理，当前壁纸与设置保持不变",
        "wallpaperRemoved": wallpaper_removed,
        "lockscreenRemoved": lockscreen_removed
    }))
}

#[tauri::command]
pub async fn reset_local_sync(state: tauri::State<'_, Arc<AppContext>>) -> Result<Value, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reset_local_sync_impl(&app))
        .await
        .map_err(|error| format!("reset_local_sync task panicked: {error}"))?
}

#[tauri::command]
pub async fn refresh_scan(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<Value, String> {
    let app = state.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || refresh_scan_impl(&app))
        .await
        .map_err(|error| format!("scan task panicked: {error}"))?;
    if let Ok(payload) = &result {
        // A follower wakes as soon as the scan result is available, before
        // the scheduler leader has necessarily invalidated cache and emitted
        // its final update. Let the leader own those side effects.
        if payload.get("shared").and_then(Value::as_bool) != Some(true) {
            emit_app_event(&app_handle, "stats-updated");
            // 挂件里手动刷新也要立即跟上托盘文字，不等下一次后台扫描周期（R-52）。
            crate::refresh_tray_status(state.inner(), &app_handle);
            if payload
                .get("inserted")
                .and_then(Value::as_u64)
                .is_some_and(|inserted| inserted > 0)
            {
                request_windows_lockscreen_refresh(state.inner().clone(), app_handle.clone());
            }
            if payload
                .get("discoveredPriceModels")
                .and_then(Value::as_array)
                .is_some_and(|models| !models.is_empty())
            {
                emit_app_event(&app_handle, "prices-updated");
            }
        }
    }
    result
}

#[cfg(target_os = "windows")]
fn request_windows_lockscreen_refresh(app: Arc<AppContext>, app_handle: tauri::AppHandle) {
    if !settings::load_settings(&app).wallpaper_lockscreen_enabled
        || EVENT_LOCKSCREEN_REFRESH_PENDING.swap(true, Ordering::AcqRel)
    {
        return;
    }

    tauri::async_runtime::spawn_blocking(move || {
        match perform_wallpaper_update(&app, "lockscreen") {
            Ok((_, true, _)) => emit_app_event(&app_handle, "wallpaper-updated"),
            Ok(_) => {
                log::error!("post-scan lock-screen refresh returned without applying an image")
            }
            Err(error) => log::error!("post-scan lock-screen refresh failed: {error}"),
        }
        EVENT_LOCKSCREEN_REFRESH_PENDING.store(false, Ordering::Release);
    });
}

#[cfg(not(target_os = "windows"))]
fn request_windows_lockscreen_refresh(_app: Arc<AppContext>, _app_handle: tauri::AppHandle) {}

#[tauri::command]
pub async fn get_usage_details(
    state: tauri::State<'_, Arc<AppContext>>,
    query: UsageDetailsQuery,
) -> Result<Value, String> {
    let app = state.inner().clone();
    get_usage_details_for_scope(app, query).await
}

/// T10.185 review P2-1/FI-1: the scope dispatch used to live inline in the
/// `#[tauri::command]` function, which cannot be called directly from a unit
/// test (there is no ergonomic way to construct a `tauri::State` outside a
/// running app). Extracted so a regression — re-adding a client-side
/// `custom` rejection ahead of the cloud dispatch — is caught by a test that
/// calls this function directly.
async fn get_usage_details_for_scope(
    app: Arc<AppContext>,
    query: UsageDetailsQuery,
) -> Result<Value, String> {
    match StatsScope::parse(query.scope.as_deref())? {
        StatsScope::Local => {
            tauri::async_runtime::spawn_blocking(move || get_usage_details_impl(&app, query))
                .await
                .map_err(|error| format!("local usage details task panicked: {error}"))?
        }
        StatsScope::Cloud => get_cloud_usage_details_impl(&app, query).await,
    }
}

/// `projects` 是行为契约 v1.2 新增的可选顶层参数（项目筛选）；只发 `query` 的旧客户端
/// 照旧得到完整区间聚合。
#[tauri::command]
pub async fn get_local_behavior_analysis(
    state: tauri::State<'_, Arc<AppContext>>,
    query: LocalStatsQuery,
    projects: Option<Vec<String>>,
) -> Result<Value, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_local_behavior_analysis_impl(&app, query, projects.as_deref())
    })
    .await
    .map_err(|error| format!("local behavior analysis task panicked: {error}"))?
}

#[tauri::command]
pub async fn get_entity_dashboard(
    state: tauri::State<'_, Arc<AppContext>>,
    query: EntityDashboardQuery,
) -> Result<Value, String> {
    let app = state.inner().clone();
    get_entity_dashboard_for_scope(app, query).await
}

/// T10.185 review P2-1/FI-1: see `get_usage_details_for_scope` — same reason
/// for the extraction (testability of the scope dispatch without a
/// `tauri::State`).
async fn get_entity_dashboard_for_scope(
    app: Arc<AppContext>,
    query: EntityDashboardQuery,
) -> Result<Value, String> {
    match StatsScope::parse(query.scope.as_deref())? {
        StatsScope::Local => tauri::async_runtime::spawn_blocking(move || {
            get_local_entity_dashboard_impl(&app, query)
        })
        .await
        .map_err(|error| format!("local entity dashboard task panicked: {error}"))?,
        StatsScope::Cloud => get_cloud_entity_dashboard_impl(&app, query).await,
    }
}

#[tauri::command]
pub async fn update_wallpaper(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
    target: String,
) -> Result<Value, String> {
    let app = state.inner().clone();
    let target_for_task = target.clone();
    // perform_wallpaper_update is sync; wrap in spawn_blocking to keep
    // the Tauri command await-friendly and not stall the IPC dispatcher.
    let result = tauri::async_runtime::spawn_blocking(move || {
        commands_update_wallpaper(&app, &target_for_task)
    })
    .await
    .map_err(|e| format!("wallpaper task panicked: {e}"))?;
    if result.is_ok() {
        #[cfg(target_os = "macos")]
        {
            if target == "desktop" || target == "both" {
                let settings = settings::load_settings(state.inner());
                let app_handle_for_wallpaper = app_handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if should_show_dynamic_wallpaper(&settings) {
                        crate::macos_wallpaper_window::show_wallpaper_window(
                            &app_handle_for_wallpaper,
                        )
                    } else {
                        crate::macos_wallpaper_window::hide_wallpaper_window(
                            &app_handle_for_wallpaper,
                        )
                    }
                })
                .await
                .map_err(|error| format!("wallpaper window task panicked: {error}"))??;
            }
        }
        emit_app_event(&app_handle, "wallpaper-updated");
    }
    result
}

fn commands_update_wallpaper(app: &AppContext, target: &str) -> Result<Value, String> {
    let (desktop, lockscreen, path) = perform_wallpaper_update(app, target)?;
    let applied = match target {
        "desktop" => desktop,
        "lockscreen" => lockscreen,
        "both" => desktop && lockscreen,
        _ => false,
    };
    if !applied {
        return Err(format!("Wallpaper target was not applied: {target}"));
    }
    Ok(json!({
        "message": "壁纸已更新",
        "desktop": desktop,
        "lockscreen": lockscreen,
        "path": path,
    }))
}

/// This computer's device id, so device pickers can mark which one is here.
#[tauri::command]
pub fn get_device_id(state: tauri::State<'_, Arc<AppContext>>) -> String {
    local_machine_id(state.inner())
}

#[tauri::command]
pub fn get_cloud_config(state: tauri::State<'_, Arc<AppContext>>) -> Result<Value, String> {
    get_cloud_config_impl(state.inner())
}

#[tauri::command]
pub fn save_cloud_config(
    state: tauri::State<'_, Arc<AppContext>>,
    config: CloudConfig,
) -> Result<Value, String> {
    save_cloud_config_impl(state.inner(), config)
}

#[tauri::command]
pub async fn get_cloud_status(state: tauri::State<'_, Arc<AppContext>>) -> Result<Value, String> {
    let app = state.inner().clone();
    get_cloud_status_impl(&app).await
}

#[tauri::command]
pub async fn supabase_sign_in(
    state: tauri::State<'_, Arc<AppContext>>,
    credentials: AuthRequest,
) -> Result<Value, String> {
    let app = state.inner().clone();
    supabase_sign_in_impl(&app, credentials).await
}

#[tauri::command]
pub async fn supabase_sign_up(
    state: tauri::State<'_, Arc<AppContext>>,
    credentials: AuthRequest,
) -> Result<Value, String> {
    let app = state.inner().clone();
    supabase_sign_up_impl(&app, credentials).await
}

#[tauri::command]
pub async fn supabase_sign_out(
    state: tauri::State<'_, Arc<AppContext>>,
    settings_state: tauri::State<'_, Arc<Mutex<crate::settings::AppSettings>>>,
) -> Result<Value, String> {
    let app = state.inner().clone();
    let session_coordinator = cloud_session_coordinator();
    let sign_out_attempt = match session_coordinator.begin_sign_out(&app) {
        Ok(attempt) => attempt,
        Err(error) => {
            // Do not start quota cleanup, remote logout, or keyring mutation
            // unless the crash-safe tombstone was durably installed and this
            // caller owns the process-wide sign-out flight.
            return Ok(merge_supabase_sign_out_result(None, false, Err(error)));
        }
    };
    cache::invalidate_all(&db::get_db_path(&app));
    let captured_config = load_cloud_config_file_for_sign_out(&app).ok();
    let drained = session_coordinator.wait_for_session_uses_to_drain().await;
    // Stop this device's quota producer before discarding the authenticated
    // session. Logout never deletes durable cloud quota history.
    let (warning, quota_cleanup_pending) = crate::quota_sync::prepare_for_sign_out_with_config(
        &app,
        settings_state.inner(),
        drained.then_some(()).and(captured_config.as_ref()),
    )
    .await;
    // Keep the durable cross-process gate blocked until the old Supabase
    // refresh session has been revoked. Opening the gate first would let a
    // second process commit a new session before the captured old session is
    // revoked. This network call is bounded and does not hold the SQLite lock.
    best_effort_remote_logout(captured_config.as_ref()).await;
    let local_result = if drained {
        session_coordinator.complete_sign_out(&app, sign_out_attempt)
    } else {
        session_coordinator.fail_sign_out_after_drain_timeout(&app, sign_out_attempt)
    };
    let local_success = local_result.is_ok();
    let finish_result =
        session_coordinator.finish_sign_out_attempt(sign_out_attempt, local_success);
    let local_result = local_result.and(finish_result).map(|_| {
        json!({
            "success": true,
            "signedOut": true,
            "message": "Signed out from Supabase."
        })
    });
    Ok(merge_supabase_sign_out_result(
        warning,
        quota_cleanup_pending,
        local_result,
    ))
}

async fn best_effort_remote_logout(config: Option<&CloudConfig>) {
    let Some(config) = config else {
        return;
    };
    let Some(session) = config.session.as_ref() else {
        return;
    };
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    else {
        return;
    };
    let Some(url) = supabase_local_logout_url(&config.supabase_url) else {
        return;
    };
    let _ = client
        .post(url)
        .header("apikey", &config.supabase_key)
        .header("Authorization", format!("Bearer {}", session.access_token))
        .send()
        .await;
}

fn supabase_local_logout_url(origin: &str) -> Option<reqwest::Url> {
    let mut url =
        reqwest::Url::parse(&format!("{}/auth/v1/logout", origin.trim_end_matches('/'))).ok()?;
    // Supabase defaults to global logout. Explicit local scope revokes only
    // the captured old session, so a delayed process cannot revoke a newer
    // session created after an expired durable-gate takeover.
    url.query_pairs_mut().append_pair("scope", "local");
    Some(url)
}

fn merge_supabase_sign_out_result(
    quota_warning: Option<String>,
    quota_cleanup_pending: bool,
    local_result: Result<Value, String>,
) -> Value {
    match local_result {
        Ok(mut result) => {
            if let Some(object) = result.as_object_mut() {
                object.insert("signedOut".to_string(), Value::Bool(true));
                object.insert(
                    "quotaCleanupPending".to_string(),
                    Value::Bool(quota_cleanup_pending),
                );
                if let Some(warning) = quota_warning {
                    object.insert("message".to_string(), Value::String(warning));
                }
            }
            result
        }
        Err(_) => json!({
            "success": false,
            "signedOut": false,
            "localSignOutError": true,
            "quotaCleanupPending": quota_cleanup_pending,
            "message": if quota_cleanup_pending || quota_warning.is_some() {
                "退出未完成：本机安全存储或额度同步停止状态未能安全保存，请修复本地存储后重试。"
            } else {
                "退出未完成：本机安全存储或配置清理失败，请重试。"
            }
        }),
    }
}

#[tauri::command]
pub async fn sync_to_supabase(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<Value, String> {
    let app = state.inner().clone();
    let result = sync_to_supabase_impl(&app).await;
    if result.is_ok() {
        emit_app_event(&app_handle, "stats-updated");
    }
    result
}

// Tauri deserializes these positional command arguments from the established
// frontend invoke contract, so bundling them would be a breaking RPC change.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn get_cached_stats(
    state: tauri::State<'_, Arc<AppContext>>,
    scope: String,
    range: String,
    device_filter: Option<String>,
    timezone: String,
    machines: Option<Vec<String>>,
    tools: Option<Vec<String>>,
    models: Option<Vec<String>>,
    search: Option<String>,
    token_mode: Option<String>,
    start: Option<String>,
    end: Option<String>,
) -> Result<Value, String> {
    let app = state.inner().clone();
    get_cached_stats_query_impl(
        &app,
        scope,
        LocalStatsQuery {
            range,
            timezone,
            machines,
            machine: device_filter,
            tools,
            tool: None,
            models,
            model: None,
            search,
            token_mode,
            start,
            end,
        },
    )
    .await
}

use crate::settings::{self, AppSettings};

const DEFAULT_PRICES_JSON: &str = include_str!("../../prices.json");
const DEFAULT_CLOUD_CONFIG_JSON: &str = include_str!("../../cloud.defaults.json");
const CLOUD_CONFIG_FILE: &str = "cloud_config.json";
const KEYRING_SERVICE: &str = "com.jeidorf.tokenledger";
const KEYRING_SESSION_USER: &str = "supabase_session";
const SYNC_BATCH_SIZE: usize = 500;
// Automatically migrate installs that still point at the retired cloud project.
const LEGACY_SUPABASE_REFS: [&str; 1] = ["legacyretiredprojectref"];
const SESSION_OPERATION_SUPERSEDED: &str = "Supabase session operation was superseded.";
const CLOUD_SESSION_GATE_FILE: &str = "cloud_session_gate.json";
const CLOUD_SESSION_GATE_LOCK_FILE: &str = "cloud_session_gate.lock.sqlite3";
const CLOUD_SESSION_KEYRING_FAILURE_FILE: &str = "cloud_session_keyring_failure.json";
const CLOUD_SESSION_GATE_SCHEMA_VERSION: u8 = 1;
const CLOUD_SESSION_KEYRING_FAILURE_SCHEMA_VERSION: u8 = 1;
const MAX_CLOUD_SESSION_GATE_BYTES: usize = 512;
const MAX_CLOUD_SESSION_KEYRING_FAILURE_BYTES: usize = 256;
const CLOUD_SESSION_GATE_LEASE_MILLIS: i64 = 60_000;
const CLOUD_SESSION_GATE_LOCK_TIMEOUT_MILLIS: u64 = 2_000;
const SESSION_DRAIN_TIMEOUT_SECS: u64 = 15;
const SIGN_OUT_ALREADY_IN_PROGRESS: &str = "A Supabase sign-out is already in progress.";
const REFRESH_FLIGHT_INTERRUPTED: &str = "Supabase session refresh was interrupted.";
const CACHED_KEYRING_READ_FAILURE: &str =
    "system keyring read is blocked until an explicit status retry.";
// 用户可见文案：清除失败必须说清「重试为什么没生效」和「下一步做什么」，
// 否则界面表现就是「点了重试，什么都没发生」。
const KEYRING_GATE_CLEAR_FAILED: &str =
    "系统安全存储的重试标记清除失败，本次重试未生效；请关闭其他 TokenLedger 窗口后重试，或重启应用";
static CLOUD_SESSION_GATE_NONCE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct CloudSessionCoordinator {
    generation: AtomicU64,
    commit: Mutex<()>,
    session_cache: Mutex<Option<CachedCloudSession>>,
    // A denied/failed Keychain read must not turn every background command
    // into another interactive macOS authorization prompt.
    keyring_read_failure: Mutex<Option<CachedKeyringReadFailure>>,
    active_uses: AtomicU64,
    sign_out_in_progress: AtomicBool,
    sign_out_attempt: AtomicU64,
    next_sign_out_attempt: AtomicU64,
    session_blocked: AtomicBool,
    refresh_state: Mutex<RefreshState>,
}

#[derive(Clone)]
struct CachedCloudSession {
    generation: u64,
    gate_epoch: u64,
    session: Option<CloudSession>,
}

#[derive(Clone)]
struct CachedKeyringReadFailure {
    gate_epoch: u64,
    error: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudSessionKeyringFailureRecord {
    schema_version: u8,
    gate_epoch: u64,
}

enum KeyringReadOutcome {
    Loaded(Result<Option<CloudSession>, String>),
    CachedFailure,
    Superseded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SignOutAttempt {
    id: u64,
    owner_nonce: u128,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AuthChangeClaim {
    generation: u64,
    gate_epoch: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CloudSessionGateStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudSessionGateRecord {
    schema_version: u8,
    #[serde(default)]
    epoch: u64,
    status: CloudSessionGateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_nonce: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blocked_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lease_expires_at: Option<i64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CloudSessionGateState {
    Ready {
        epoch: u64,
    },
    Blocked {
        epoch: u64,
        owner_nonce: Option<u128>,
        blocked_at: Option<i64>,
        lease_expires_at: Option<i64>,
    },
}

impl CloudSessionGateState {
    #[cfg(test)]
    fn is_blocked(self) -> bool {
        matches!(self, Self::Blocked { .. })
    }

    fn epoch(self) -> u64 {
        match self {
            Self::Ready { epoch } | Self::Blocked { epoch, .. } => epoch,
        }
    }

    fn next_epoch(self) -> Result<u64, String> {
        self.epoch()
            .checked_add(1)
            .ok_or_else(|| "Cloud session safety epoch is exhausted.".to_string())
    }

    fn has_active_lease(self, now: i64) -> bool {
        matches!(
            self,
            Self::Blocked {
                lease_expires_at: Some(expires_at),
                ..
            } if expires_at > now
        )
    }

    fn is_owned_by(self, owner_nonce: u128) -> bool {
        matches!(
            self,
            Self::Blocked {
                owner_nonce: Some(current),
                ..
            } if current == owner_nonce
        )
    }
}

#[derive(Default)]
struct RefreshState {
    next_id: u64,
    flights: HashMap<u64, RefreshFlight>,
}

struct RefreshFlight {
    id: u64,
    participants: usize,
    result: Option<Result<CloudConfig, String>>,
}

impl CloudSessionCoordinator {
    fn current(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn ensure_current(&self, expected: u64) -> Result<(), String> {
        if self.current() == expected {
            Ok(())
        } else {
            Err(SESSION_OPERATION_SUPERSEDED.to_string())
        }
    }

    fn load_session_for_ready_epoch(
        &self,
        app: &AppContext,
        load_secure_session: &mut dyn FnMut() -> Result<Option<CloudSession>, String>,
        retry_keyring_read: bool,
    ) -> Result<Option<CloudSession>, String> {
        let generation = self.current();
        let gate_epoch = self.ready_gate_epoch(app)?;
        // Fail-closed load handling advances generation to fence in-flight
        // cloud work. The durable gate epoch is the stable account boundary
        // for this read failure, so it intentionally outlives that fence.
        {
            let mut failure = self
                .keyring_read_failure
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if retry_keyring_read
                || failure
                    .as_ref()
                    .is_some_and(|cached| cached.gate_epoch != gate_epoch)
            {
                *failure = None;
            } else if let Some(cached) = failure
                .as_ref()
                .filter(|cached| cached.gate_epoch == gate_epoch)
            {
                return Err(cached.error.clone());
            }
        }
        {
            let cache = self
                .session_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(cached) = cache
                .as_ref()
                .filter(|cached| cached.generation == generation && cached.gate_epoch == gate_epoch)
            {
                return Ok(cached.session.clone());
            }
        }

        // macOS may require interactive approval for a Keychain read. The
        // durable app-data marker and the cross-process SQLite lock together
        // keep that boundary to one read per account epoch, even after the
        // app restarts or a second Tauri process starts. Explicit status
        // checking is the only path that clears the marker and retries.
        let outcome = with_cloud_session_gate_lock(app, || {
            let current_gate = load_cloud_session_gate_state(app)?;
            if current_gate.epoch() != gate_epoch {
                return Ok(KeyringReadOutcome::Superseded);
            }
            let persisted_epoch = load_keyring_failure_epoch(app)?;
            if retry_keyring_read || persisted_epoch != Some(gate_epoch) {
                if persisted_epoch.is_some() {
                    // Deleting this marker is the *only* way out of the
                    // "stop asking for the Keychain" state. If the removal
                    // fails (file locked, permissions), silently continuing
                    // would leave the user pressing a retry button that can
                    // never work. Surface it instead.
                    crate::quota::remove_private_app_data_file_checked(
                        app.app_data_dir(),
                        CLOUD_SESSION_KEYRING_FAILURE_FILE,
                    )
                    .map_err(|error| format!("{KEYRING_GATE_CLEAR_FAILED}（{error}）"))?;
                }
            } else {
                return Ok(KeyringReadOutcome::CachedFailure);
            }

            let session = load_secure_session();
            match &session {
                Ok(_) => {
                    crate::quota::remove_private_app_data_file_checked(
                        app.app_data_dir(),
                        CLOUD_SESSION_KEYRING_FAILURE_FILE,
                    )
                    .map_err(|error| format!("{KEYRING_GATE_CLEAR_FAILED}（{error}）"))?;
                }
                Err(_) => {
                    persist_keyring_failure_epoch(app, gate_epoch)?;
                }
            }
            Ok(KeyringReadOutcome::Loaded(session))
        })?;

        let session = match outcome {
            KeyringReadOutcome::Loaded(Ok(session)) => session,
            KeyringReadOutcome::Loaded(Err(error)) => {
                *self
                    .keyring_read_failure
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    Some(CachedKeyringReadFailure {
                        gate_epoch,
                        error: error.clone(),
                    });
                return Err(error);
            }
            KeyringReadOutcome::CachedFailure => {
                let error = CACHED_KEYRING_READ_FAILURE.to_string();
                *self
                    .keyring_read_failure
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    Some(CachedKeyringReadFailure {
                        gate_epoch,
                        error: error.clone(),
                    });
                return Err(error);
            }
            KeyringReadOutcome::Superseded => return Err(SESSION_OPERATION_SUPERSEDED.to_string()),
        };
        self.ensure_current(generation)?;
        if self.ready_gate_epoch(app)? != gate_epoch {
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        let mut cache = self
            .session_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *cache = Some(CachedCloudSession {
            generation,
            gate_epoch,
            session: session.clone(),
        });
        Ok(session)
    }

    fn invalidate_claims(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    fn begin_auth_change(&self, app: &AppContext) -> Result<AuthChangeClaim, String> {
        // Match session commits: commit lock first, then the durable gate lock.
        // Every explicit auth attempt replaces earlier attempts before HTTP starts.
        let _guard = self
            .commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.sign_out_in_progress.load(Ordering::SeqCst) {
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        let gate = with_cloud_session_gate_lock(app, || load_cloud_session_gate_state(app))?;
        if gate.has_active_lease(cloud_session_gate_now()) {
            self.session_blocked.store(true, Ordering::SeqCst);
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        if self.sign_out_in_progress.load(Ordering::SeqCst) {
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        let previous_generation = self.generation.fetch_add(1, Ordering::SeqCst);
        let generation = previous_generation.wrapping_add(1);
        // Auth entry does not change the account or durable epoch. Reuse an
        // already-read session without prompting the keyring again.
        if let Some(cached) = self
            .session_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_mut()
            .filter(|cached| {
                cached.generation == previous_generation && cached.gate_epoch == gate.epoch()
            })
        {
            cached.generation = generation;
        }
        let claim = AuthChangeClaim {
            generation,
            gate_epoch: gate.epoch(),
        };
        self.ensure_auth_claim_current(app, claim)?;
        Ok(claim)
    }

    fn ensure_auth_claim_current(
        &self,
        app: &AppContext,
        claim: AuthChangeClaim,
    ) -> Result<(), String> {
        self.ensure_current(claim.generation)?;
        let gate = load_cloud_session_gate_state(app)?;
        if gate.epoch() == claim.gate_epoch
            && !gate.has_active_lease(cloud_session_gate_now())
            && !self.sign_out_in_progress.load(Ordering::SeqCst)
        {
            Ok(())
        } else {
            Err(SESSION_OPERATION_SUPERSEDED.to_string())
        }
    }

    fn ready_gate_epoch(&self, app: &AppContext) -> Result<u64, String> {
        if self.sign_out_in_progress.load(Ordering::SeqCst) {
            self.session_blocked.store(true, Ordering::SeqCst);
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        match load_cloud_session_gate_state(app) {
            Ok(CloudSessionGateState::Ready { epoch }) => {
                self.session_blocked.store(false, Ordering::SeqCst);
                Ok(epoch)
            }
            Ok(CloudSessionGateState::Blocked { .. }) | Err(_) => {
                self.session_blocked.store(true, Ordering::SeqCst);
                Err(SESSION_OPERATION_SUPERSEDED.to_string())
            }
        }
    }

    fn ensure_gate_epoch(&self, app: &AppContext, expected_epoch: u64) -> Result<(), String> {
        if self.ready_gate_epoch(app)? == expected_epoch {
            Ok(())
        } else {
            self.session_blocked.store(true, Ordering::SeqCst);
            Err(SESSION_OPERATION_SUPERSEDED.to_string())
        }
    }

    fn is_session_blocked(&self, app: &AppContext) -> bool {
        match load_cloud_session_gate_state(app) {
            Ok(CloudSessionGateState::Ready { .. }) => {
                let locally_blocked = self.sign_out_in_progress.load(Ordering::SeqCst);
                self.session_blocked
                    .store(locally_blocked, Ordering::SeqCst);
                locally_blocked
            }
            Ok(state @ CloudSessionGateState::Blocked { .. }) => {
                // A Blocked record is normally reserved for an explicit
                // sign-in/sign-out takeover (see the marker comment in
                // `load_cloud_session_gate_state`). But a crash or an
                // interrupted sync can leave a stale Blocked record whose
                // lease has already expired; treating that as permanently
                // blocked forces a needless re-login after every reinstall.
                // Once the lease has expired there is no live owner, so it is
                // safe to self-heal back to Ready instead of staying stuck.
                let now = cloud_session_gate_now();
                if state.has_active_lease(now) {
                    self.session_blocked.store(true, Ordering::SeqCst);
                    return true;
                }
                // A legacy ownerless marker has no lease to expire and stays
                // recoverable only through an explicit sign-in/sign-out
                // takeover; normal session reads remain blocked (fail-closed).
                if matches!(
                    state,
                    CloudSessionGateState::Blocked {
                        owner_nonce: None,
                        ..
                    }
                ) {
                    self.session_blocked.store(true, Ordering::SeqCst);
                    return true;
                }
                let recovered = CloudSessionGateState::Ready {
                    epoch: state.epoch(),
                };
                if let Err(error) = save_cloud_session_gate_state(app, recovered) {
                    // Persisting the recovery failed; stay fail-closed rather
                    // than risk two processes both treating the gate as Ready.
                    eprintln!("cloud session gate self-heal failed to persist: {error}");
                    self.session_blocked.store(true, Ordering::SeqCst);
                    return true;
                }
                let locally_blocked = self.sign_out_in_progress.load(Ordering::SeqCst);
                self.session_blocked
                    .store(locally_blocked, Ordering::SeqCst);
                locally_blocked
            }
            Err(_) => {
                self.session_blocked.store(true, Ordering::SeqCst);
                true
            }
        }
    }

    fn ensure_session_gate_open(&self, app: &AppContext) -> Result<(), String> {
        if self.sign_out_in_progress.load(Ordering::SeqCst) || self.is_session_blocked(app) {
            Err(SESSION_OPERATION_SUPERSEDED.to_string())
        } else {
            Ok(())
        }
    }

    fn begin_session_use(&'static self, app: &AppContext) -> Result<CloudSessionUseLease, String> {
        let gate_epoch = self.ready_gate_epoch(app).map_err(|_| {
            "Supabase session use is blocked until sign-out cleanup completes.".to_string()
        })?;
        let generation = self.current();
        self.active_uses.fetch_add(1, Ordering::SeqCst);
        if self.sign_out_in_progress.load(Ordering::SeqCst)
            || self.ensure_gate_epoch(app, gate_epoch).is_err()
            || self.current() != generation
        {
            self.active_uses.fetch_sub(1, Ordering::SeqCst);
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        Ok(CloudSessionUseLease {
            coordinator: self,
            generation,
            gate_epoch,
        })
    }

    fn begin_sign_out(&self, app: &AppContext) -> Result<SignOutAttempt, String> {
        self.begin_sign_out_with_gate(|attempt| {
            with_cloud_session_gate_lock(app, || {
                let gate = load_cloud_session_gate_state(app)?;
                if gate.has_active_lease(cloud_session_gate_now()) {
                    return Err(SIGN_OUT_ALREADY_IN_PROGRESS.to_string());
                }
                let blocked_epoch = gate.next_epoch()?;
                let now = cloud_session_gate_now();
                save_cloud_session_gate_state(
                    app,
                    CloudSessionGateState::Blocked {
                        epoch: blocked_epoch,
                        owner_nonce: Some(attempt.owner_nonce),
                        blocked_at: Some(now),
                        lease_expires_at: Some(now + CLOUD_SESSION_GATE_LEASE_MILLIS),
                    },
                )
            })
        })
    }

    fn begin_sign_out_with_gate(
        &self,
        persist_blocked_gate: impl FnOnce(SignOutAttempt) -> Result<(), String>,
    ) -> Result<SignOutAttempt, String> {
        self.sign_out_in_progress
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| SIGN_OUT_ALREADY_IN_PROGRESS.to_string())?;
        let attempt_id = loop {
            let id = self
                .next_sign_out_attempt
                .fetch_add(1, Ordering::SeqCst)
                .wrapping_add(1);
            if id != 0 {
                break id;
            }
        };
        let attempt = SignOutAttempt {
            id: attempt_id,
            owner_nonce: new_cloud_session_gate_nonce(),
        };
        self.sign_out_attempt.store(attempt_id, Ordering::SeqCst);
        self.session_blocked.store(true, Ordering::SeqCst);
        self.invalidate_claims();
        let _guard = self
            .commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = persist_blocked_gate(attempt);
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Err(error) = result {
            // The operation must stop before any remote or keyring cleanup if
            // its crash tombstone could not be made durable. Keep the in-memory
            // session blocked (fail closed), but release the single-flight so a
            // deliberate retry or explicit sign-in recovery remains possible.
            let _ = self.sign_out_attempt.compare_exchange(
                attempt_id,
                0,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            self.sign_out_in_progress.store(false, Ordering::SeqCst);
            return Err(error);
        }
        Ok(attempt)
    }

    async fn wait_for_session_uses_to_drain(&self) -> bool {
        let deadline = tokio::time::Instant::now()
            + std::time::Duration::from_secs(SESSION_DRAIN_TIMEOUT_SECS);
        loop {
            if self.active_uses.load(Ordering::SeqCst) == 0 {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    fn complete_sign_out(&self, app: &AppContext, attempt: SignOutAttempt) -> Result<(), String> {
        self.complete_sign_out_with_clear(app, attempt, clear_session_from_keyring)
    }

    fn complete_sign_out_with_clear(
        &self,
        app: &AppContext,
        attempt: SignOutAttempt,
        clear_secure_session: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let result = self.mutate_sign_out_attempt(attempt, || {
            with_cloud_session_gate_lock(app, || {
                let gate = load_cloud_session_gate_state(app)?;
                if !gate.is_owned_by(attempt.owner_nonce) {
                    return Err(SESSION_OPERATION_SUPERSEDED.to_string());
                }
                clear_secure_session()?;
                save_cloud_session_gate_state(
                    app,
                    CloudSessionGateState::Ready {
                        epoch: gate.next_epoch()?,
                    },
                )
            })
        });
        if result.is_err() {
            self.session_blocked.store(true, Ordering::SeqCst);
        }
        result
    }

    fn fail_sign_out_after_drain_timeout(
        &self,
        app: &AppContext,
        attempt: SignOutAttempt,
    ) -> Result<(), String> {
        let _ = self.mutate_sign_out_attempt(attempt, || {
            with_cloud_session_gate_lock(app, || {
                let gate = load_cloud_session_gate_state(app)?;
                if !gate.is_owned_by(attempt.owner_nonce) {
                    return Err(SESSION_OPERATION_SUPERSEDED.to_string());
                }
                clear_session_from_keyring()
            })
        });
        self.session_blocked.store(true, Ordering::SeqCst);
        Err(
            "Supabase sign-out is still stopping an earlier cloud operation; please retry."
                .to_string(),
        )
    }

    fn commit_new_session_with_keyring_ops(
        &self,
        app: &AppContext,
        claim: AuthChangeClaim,
        clear_secure_session: impl FnOnce() -> Result<(), String>,
        save_secure_session: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.replace_if_current(claim.generation, || {
            with_cloud_session_gate_lock(app, || {
                let gate = load_cloud_session_gate_state(app)?;
                if gate.epoch() != claim.gate_epoch
                    || gate.has_active_lease(cloud_session_gate_now())
                {
                    return Err(SESSION_OPERATION_SUPERSEDED.to_string());
                }

                // Claim the short commit window durably before touching the
                // keyring. A crash therefore leaves a bounded blocked lease,
                // never a ready gate pointing at a half-written session.
                let now = cloud_session_gate_now();
                let blocked_epoch = gate.next_epoch()?;
                save_cloud_session_gate_state(
                    app,
                    CloudSessionGateState::Blocked {
                        epoch: blocked_epoch,
                        owner_nonce: Some(new_cloud_session_gate_nonce()),
                        blocked_at: Some(now),
                        lease_expires_at: Some(now + CLOUD_SESSION_GATE_LEASE_MILLIS),
                    },
                )?;
                clear_secure_session()?;
                save_secure_session()?;
                save_cloud_session_gate_state(
                    app,
                    CloudSessionGateState::Ready {
                        epoch: blocked_epoch.checked_add(1).ok_or_else(|| {
                            "Cloud session safety epoch is exhausted.".to_string()
                        })?,
                    },
                )
            })
        })?;
        self.session_blocked.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn commit_cloud_identity_change_with_ops<T>(
        &self,
        app: &AppContext,
        clear_secure_session: impl FnOnce() -> Result<(), String>,
        persist_new_identity: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let result = self.invalidate(|| {
            with_cloud_session_gate_lock(app, || {
                let gate = load_cloud_session_gate_state(app)?;
                if gate.has_active_lease(cloud_session_gate_now()) {
                    return Err(SESSION_OPERATION_SUPERSEDED.to_string());
                }

                let now = cloud_session_gate_now();
                let blocked_epoch = gate.next_epoch()?;
                save_cloud_session_gate_state(
                    app,
                    CloudSessionGateState::Blocked {
                        epoch: blocked_epoch,
                        owner_nonce: Some(new_cloud_session_gate_nonce()),
                        blocked_at: Some(now),
                        lease_expires_at: Some(now + CLOUD_SESSION_GATE_LEASE_MILLIS),
                    },
                )?;
                clear_secure_session()?;
                let value = persist_new_identity()?;
                save_cloud_session_gate_state(
                    app,
                    CloudSessionGateState::Ready {
                        epoch: blocked_epoch.checked_add(1).ok_or_else(|| {
                            "Cloud session safety epoch is exhausted.".to_string()
                        })?,
                    },
                )?;
                Ok(value)
            })
        });
        self.session_blocked
            .store(result.is_err(), Ordering::SeqCst);
        result
    }

    fn finish_sign_out_attempt(
        &self,
        attempt: SignOutAttempt,
        local_success: bool,
    ) -> Result<(), String> {
        let _guard = self
            .commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.ensure_sign_out_attempt(attempt)?;
        self.session_blocked.store(!local_success, Ordering::SeqCst);
        self.sign_out_attempt.store(0, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.sign_out_in_progress.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn ensure_sign_out_attempt(&self, attempt: SignOutAttempt) -> Result<(), String> {
        if self.sign_out_in_progress.load(Ordering::SeqCst)
            && self.sign_out_attempt.load(Ordering::SeqCst) == attempt.id
        {
            Ok(())
        } else {
            Err(SESSION_OPERATION_SUPERSEDED.to_string())
        }
    }

    fn mutate_sign_out_attempt<T>(
        &self,
        attempt: SignOutAttempt,
        mutation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.ensure_sign_out_attempt(attempt)?;
        let result = mutation();
        self.generation.fetch_add(1, Ordering::SeqCst);
        result
    }

    fn claim_refresh(&self, generation: u64) -> Result<RefreshClaim<'_>, String> {
        self.ensure_current(generation)?;
        if self.sign_out_in_progress.load(Ordering::SeqCst)
            || self.session_blocked.load(Ordering::SeqCst)
        {
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        let mut state = self
            .refresh_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(flight) = state.flights.get_mut(&generation) {
            flight.participants = flight.participants.saturating_add(1);
            return Ok(RefreshClaim {
                coordinator: self,
                generation,
                flight_id: flight.id,
                leader: false,
                published: false,
            });
        }
        state.next_id = state.next_id.wrapping_add(1).max(1);
        let flight_id = state.next_id;
        state.flights.insert(
            generation,
            RefreshFlight {
                id: flight_id,
                participants: 1,
                result: None,
            },
        );
        Ok(RefreshClaim {
            coordinator: self,
            generation,
            flight_id,
            leader: true,
            published: false,
        })
    }

    fn publish_refresh_result(
        &self,
        generation: u64,
        flight_id: u64,
        result: Result<CloudConfig, String>,
    ) -> Result<(), String> {
        let mut state = self
            .refresh_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let flight = state
            .flights
            .get_mut(&generation)
            .filter(|flight| flight.id == flight_id)
            .ok_or_else(|| SESSION_OPERATION_SUPERSEDED.to_string())?;
        if flight.result.is_some() {
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        flight.result = Some(result);
        Ok(())
    }

    fn refresh_result(
        &self,
        generation: u64,
        flight_id: u64,
    ) -> Result<Option<Result<CloudConfig, String>>, String> {
        let state = self
            .refresh_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let flight = state
            .flights
            .get(&generation)
            .filter(|flight| flight.id == flight_id)
            .ok_or_else(|| SESSION_OPERATION_SUPERSEDED.to_string())?;
        Ok(flight.result.clone())
    }

    fn release_refresh_claim(
        &self,
        generation: u64,
        flight_id: u64,
        leader: bool,
        published: bool,
    ) {
        let mut state = self
            .refresh_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut remove = false;
        if let Some(flight) = state
            .flights
            .get_mut(&generation)
            .filter(|flight| flight.id == flight_id)
        {
            if leader && !published && flight.result.is_none() {
                flight.result = Some(Err(REFRESH_FLIGHT_INTERRUPTED.to_string()));
            }
            flight.participants = flight.participants.saturating_sub(1);
            remove = flight.participants == 0;
        }
        if remove {
            state.flights.remove(&generation);
        }
    }

    fn replace_if_current<T>(
        &self,
        expected: u64,
        mutation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.ensure_current(expected)?;
        let result = mutation();
        match self.generation.compare_exchange(
            expected,
            expected.wrapping_add(1),
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => result,
            Err(_) => Err(SESSION_OPERATION_SUPERSEDED.to_string()),
        }
    }

    fn inspect_if_current<T>(
        &self,
        expected: u64,
        inspection: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.ensure_current(expected)?;
        let result = inspection();
        self.ensure_current(expected)?;
        result
    }

    fn invalidate<T>(&self, mutation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        // Advance before waiting for the commit lock so a slow refresh cannot
        // pass its final generation check while sign-out is queued.
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _guard = self
            .commit
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = mutation();
        self.generation.fetch_add(1, Ordering::SeqCst);
        result
    }
}

struct RefreshClaim<'a> {
    coordinator: &'a CloudSessionCoordinator,
    generation: u64,
    flight_id: u64,
    leader: bool,
    published: bool,
}

impl RefreshClaim<'_> {
    fn is_leader(&self) -> bool {
        self.leader
    }

    fn publish(&mut self, result: Result<CloudConfig, String>) -> Result<(), String> {
        if !self.leader || self.published {
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        self.coordinator
            .publish_refresh_result(self.generation, self.flight_id, result)?;
        self.published = true;
        Ok(())
    }

    async fn wait_result(&self, app: &AppContext) -> Result<CloudConfig, String> {
        loop {
            // A sign-out in another TokenLedger process only communicates via
            // this durable marker, so followers must not rely on atomics alone.
            self.coordinator.ensure_session_gate_open(app)?;
            if let Some(result) = self
                .coordinator
                .refresh_result(self.generation, self.flight_id)?
            {
                return result;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}

impl Drop for RefreshClaim<'_> {
    fn drop(&mut self) {
        self.coordinator.release_refresh_claim(
            self.generation,
            self.flight_id,
            self.leader,
            self.published,
        );
    }
}

pub(crate) struct CloudSessionUseLease {
    coordinator: &'static CloudSessionCoordinator,
    generation: u64,
    gate_epoch: u64,
}

impl CloudSessionUseLease {
    pub(crate) fn ensure_current(&self, app: &AppContext) -> Result<(), String> {
        if self.coordinator.sign_out_in_progress.load(Ordering::SeqCst)
            || self
                .coordinator
                .ensure_gate_epoch(app, self.gate_epoch)
                .is_err()
        {
            return Err(SESSION_OPERATION_SUPERSEDED.to_string());
        }
        self.coordinator.ensure_current(self.generation)
    }

    pub(crate) fn commit_if_current<T>(
        &self,
        app: &AppContext,
        mutation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.ensure_current(app)?;
        with_cloud_session_gate_lock(app, || {
            self.ensure_current(app)?;
            let result = mutation()?;
            self.ensure_current(app)?;
            Ok(result)
        })
    }
}

impl Drop for CloudSessionUseLease {
    fn drop(&mut self) {
        self.coordinator.active_uses.fetch_sub(1, Ordering::SeqCst);
    }
}

static CLOUD_SESSION_COORDINATOR: OnceLock<CloudSessionCoordinator> = OnceLock::new();

fn cloud_session_coordinator() -> &'static CloudSessionCoordinator {
    CLOUD_SESSION_COORDINATOR.get_or_init(CloudSessionCoordinator::default)
}

fn fail_closed_cloud_session_after_load_error(
    app: &AppContext,
    session_coordinator: &CloudSessionCoordinator,
    expected_generation: u64,
    source_error: &str,
) {
    if source_error == SESSION_OPERATION_SUPERSEDED {
        return;
    }
    // A real secure-storage failure only owns its captured generation. A newer
    // auth may have acquired the commit lock since this failed load returned.
    let _ = session_coordinator.replace_if_current(expected_generation, || {
        crate::quota_sync::invalidate_session_locally(app);
        Ok(())
    });
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct CloudConfig {
    pub supabase_url: String,
    pub supabase_key: String,
    #[serde(default, skip_serializing)]
    pub session: Option<CloudSession>,
}

impl std::fmt::Debug for CloudConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudConfig")
            .field("supabase_url", &self.supabase_url)
            .field("supabase_key", &crate::redact::Hidden(&self.supabase_key))
            .field("session", &self.session)
            .finish()
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct CloudSession {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub email: String,
    pub expires_at: i64,
}

impl std::fmt::Debug for CloudSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudSession")
            .field("access_token", &crate::redact::Hidden(&self.access_token))
            .field("refresh_token", &crate::redact::Hidden(&self.refresh_token))
            .field("user_id", &self.user_id)
            .field("email", &crate::redact::Hidden(&self.email))
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AuthRequest {
    pub email: String,
    pub password: String,
}

impl std::fmt::Debug for AuthRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthRequest")
            .field("email", &crate::redact::Hidden(&self.email))
            .field("password", &crate::redact::Hidden(&self.password))
            .finish()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatsQuery {
    pub range: String,
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub machines: Option<Vec<String>>,
    #[serde(default)]
    pub machine: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub models: Option<Vec<String>>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub token_mode: Option<String>,
    /// 仅 `range = "custom"` 时使用的本地日期闭区间（YYYY-MM-DD）。
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageDetailsQuery {
    #[serde(default)]
    pub scope: Option<String>,
    pub range: String,
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub machines: Option<Vec<String>>,
    #[serde(default)]
    pub machine: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub models: Option<Vec<String>>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub token_mode: Option<String>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    /// 契约 §2.7：只看这些供应商账号的网关与导入行，仅本机。
    #[serde(default)]
    pub providers: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EntityDashboardQuery {
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub entity: Option<EntitySelectorInput>,
    pub range: String,
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub machines: Option<Vec<String>>,
    #[serde(default)]
    pub machine: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub models: Option<Vec<String>>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub token_mode: Option<String>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
}

#[derive(Debug, Clone)]
struct StatRow {
    id: i64,
    tool: String,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    /// Cache read + write combined (historical column).
    cached_tokens: i64,
    /// Write share of cached_tokens. A zero value is also used by sources
    /// that cannot distinguish reads from writes, so it is not provenance.
    cache_write_tokens: i64,
    cache_write_known: Option<bool>,
    usage_provenance: Option<String>,
    timestamp: String,
    /// The stored timestamp when `timestamp` was shifted into a query
    /// timezone (`rows_in_timezone`): prices are chosen by the instant the
    /// record happened, not by the shifted wall clock.
    pricing_timestamp: Option<String>,
    session_id: String,
    cost_usd: Option<f64>,
    machine_id: String,
}

impl StatRow {
    /// The timestamp that picks this record's price (price table schema 2).
    fn price_timestamp(&self) -> &str {
        self.pricing_timestamp.as_deref().unwrap_or(&self.timestamp)
    }

    fn cache_split_is_proven(&self) -> bool {
        if let Some(known) = self.cache_write_known {
            return known
                && self.cached_tokens >= 0
                && self.cache_write_tokens >= 0
                && self.cache_write_tokens <= self.cached_tokens;
        }
        (self.cached_tokens == 0 && self.cache_write_tokens == 0)
            || (self.cached_tokens > 0
                && self.cache_write_tokens > 0
                && self.cache_write_tokens <= self.cached_tokens)
    }

    fn cache_read_tokens(&self) -> i64 {
        (self.cached_tokens - self.cache_write_tokens).max(0)
    }
}

fn config_path(app: &AppContext) -> Result<std::path::PathBuf, String> {
    let app_dir = app.app_data_dir();
    fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
    Ok(app_dir.join(CLOUD_CONFIG_FILE))
}

fn cloud_session_gate_now() -> i64 {
    Utc::now().timestamp_millis()
}

fn new_cloud_session_gate_nonce() -> u128 {
    use sha2::{Digest, Sha256};

    let counter = CLOUD_SESSION_GATE_NONCE_COUNTER
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(std::process::id().to_be_bytes());
    hasher.update(counter.to_be_bytes());
    hasher.update(timestamp.to_be_bytes());
    hasher.update(format!("{:?}", std::thread::current().id()).as_bytes());
    let digest = hasher.finalize();
    let mut nonce = [0_u8; 16];
    nonce.copy_from_slice(&digest[..16]);
    u128::from_be_bytes(nonce).max(1)
}

fn parse_cloud_session_gate_nonce(value: &str) -> Option<u128> {
    (value.len() == 32)
        .then(|| u128::from_str_radix(value, 16).ok())
        .flatten()
        .filter(|nonce| *nonce != 0)
}

fn load_cloud_session_gate_state(app: &AppContext) -> Result<CloudSessionGateState, String> {
    let bytes = match crate::quota::read_private_app_data_file(
        app.app_data_dir(),
        CLOUD_SESSION_GATE_FILE,
        MAX_CLOUD_SESSION_GATE_BYTES,
    )? {
        None => return Ok(CloudSessionGateState::Ready { epoch: 0 }),
        Some(bytes) => bytes,
    };

    // Existing installations used these exact marker values. A legacy blocked
    // marker has no live owner and is therefore recoverable only through an
    // explicit sign-in/sign-out takeover; normal session reads remain blocked.
    if bytes.as_slice() == b"ready" {
        return Ok(CloudSessionGateState::Ready { epoch: 0 });
    }
    if bytes.as_slice() == b"blocked" {
        return Ok(CloudSessionGateState::Blocked {
            epoch: 0,
            owner_nonce: None,
            blocked_at: None,
            lease_expires_at: None,
        });
    }

    let record = serde_json::from_slice::<CloudSessionGateRecord>(&bytes)
        .map_err(|_| "Unable to read cloud session safety state.".to_string())?;
    if record.schema_version != CLOUD_SESSION_GATE_SCHEMA_VERSION {
        return Err("Unable to read cloud session safety state.".to_string());
    }
    match record.status {
        CloudSessionGateStatus::Ready
            if record.owner_nonce.is_none()
                && record.blocked_at.is_none()
                && record.lease_expires_at.is_none() =>
        {
            Ok(CloudSessionGateState::Ready {
                epoch: record.epoch,
            })
        }
        CloudSessionGateStatus::Blocked => {
            let owner_nonce = record
                .owner_nonce
                .as_deref()
                .and_then(parse_cloud_session_gate_nonce)
                .ok_or_else(|| "Unable to read cloud session safety state.".to_string())?;
            let blocked_at = record
                .blocked_at
                .filter(|value| *value >= 0)
                .ok_or_else(|| "Unable to read cloud session safety state.".to_string())?;
            let lease_expires_at = record
                .lease_expires_at
                .filter(|value| {
                    *value > blocked_at
                        && value.saturating_sub(blocked_at) <= CLOUD_SESSION_GATE_LEASE_MILLIS
                })
                .ok_or_else(|| "Unable to read cloud session safety state.".to_string())?;
            Ok(CloudSessionGateState::Blocked {
                epoch: record.epoch,
                owner_nonce: Some(owner_nonce),
                blocked_at: Some(blocked_at),
                lease_expires_at: Some(lease_expires_at),
            })
        }
        _ => Err("Unable to read cloud session safety state.".to_string()),
    }
}

fn save_cloud_session_gate_state(
    app: &AppContext,
    state: CloudSessionGateState,
) -> Result<(), String> {
    let record = match state {
        CloudSessionGateState::Ready { epoch } => CloudSessionGateRecord {
            schema_version: CLOUD_SESSION_GATE_SCHEMA_VERSION,
            epoch,
            status: CloudSessionGateStatus::Ready,
            owner_nonce: None,
            blocked_at: None,
            lease_expires_at: None,
        },
        CloudSessionGateState::Blocked {
            epoch,
            owner_nonce: Some(owner_nonce),
            blocked_at: Some(blocked_at),
            lease_expires_at: Some(lease_expires_at),
        } if owner_nonce != 0
            && blocked_at >= 0
            && lease_expires_at > blocked_at
            && lease_expires_at.saturating_sub(blocked_at) <= CLOUD_SESSION_GATE_LEASE_MILLIS =>
        {
            CloudSessionGateRecord {
                schema_version: CLOUD_SESSION_GATE_SCHEMA_VERSION,
                epoch,
                status: CloudSessionGateStatus::Blocked,
                owner_nonce: Some(format!("{owner_nonce:032x}")),
                blocked_at: Some(blocked_at),
                lease_expires_at: Some(lease_expires_at),
            }
        }
        CloudSessionGateState::Blocked { .. } => {
            return Err("Unable to save cloud session safety state.".to_string())
        }
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|_| "Unable to save cloud session safety state.".to_string())?;
    crate::quota::write_private_app_data_file(app.app_data_dir(), CLOUD_SESSION_GATE_FILE, &bytes)
}

fn load_keyring_failure_epoch(app: &AppContext) -> Result<Option<u64>, String> {
    let Some(bytes) = crate::quota::read_private_app_data_file(
        app.app_data_dir(),
        CLOUD_SESSION_KEYRING_FAILURE_FILE,
        MAX_CLOUD_SESSION_KEYRING_FAILURE_BYTES,
    )?
    else {
        return Ok(None);
    };
    let record = serde_json::from_slice::<CloudSessionKeyringFailureRecord>(&bytes)
        .map_err(|_| "Unable to read cloud session keyring safety state.".to_string())?;
    if record.schema_version != CLOUD_SESSION_KEYRING_FAILURE_SCHEMA_VERSION {
        return Err("Unable to read cloud session keyring safety state.".to_string());
    }
    Ok(Some(record.gate_epoch))
}

fn persist_keyring_failure_epoch(app: &AppContext, gate_epoch: u64) -> Result<(), String> {
    let record = CloudSessionKeyringFailureRecord {
        schema_version: CLOUD_SESSION_KEYRING_FAILURE_SCHEMA_VERSION,
        gate_epoch,
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|_| "Unable to save cloud session keyring safety state.".to_string())?;
    crate::quota::write_private_app_data_file(
        app.app_data_dir(),
        CLOUD_SESSION_KEYRING_FAILURE_FILE,
        &bytes,
    )
    .map_err(|_| "Unable to save cloud session keyring safety state.".to_string())
}

#[cfg(test)]
fn load_cloud_session_gate(app: &AppContext) -> Result<bool, String> {
    load_cloud_session_gate_state(app).map(CloudSessionGateState::is_blocked)
}

#[cfg(test)]
fn save_cloud_session_gate(app: &AppContext, blocked: bool) -> Result<(), String> {
    if blocked {
        crate::quota::write_private_app_data_file(
            app.app_data_dir(),
            CLOUD_SESSION_GATE_FILE,
            b"blocked",
        )
    } else {
        let epoch = load_cloud_session_gate_state(app)
            .map(|state| state.epoch())
            .unwrap_or(0);
        save_cloud_session_gate_state(app, CloudSessionGateState::Ready { epoch })
    }
}

fn with_cloud_session_gate_lock<T>(
    app: &AppContext,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    fs::create_dir_all(app.app_data_dir())
        .map_err(|_| "Unable to acquire cloud session safety lock.".to_string())?;
    let lock_path = app.app_data_dir().join(CLOUD_SESSION_GATE_LOCK_FILE);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    drop(
        options
            .open(&lock_path)
            .map_err(|_| "Unable to acquire cloud session safety lock.".to_string())?,
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = fs::symlink_metadata(&lock_path)
            .map_err(|_| "Unable to acquire cloud session safety lock.".to_string())?;
        if !metadata.file_type().is_file() || metadata.nlink() != 1 {
            return Err("Unable to acquire cloud session safety lock.".to_string());
        }
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Unable to acquire cloud session safety lock.".to_string())?;
    }

    let connection = Connection::open(&lock_path)
        .map_err(|_| "Unable to acquire cloud session safety lock.".to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_millis(
            CLOUD_SESSION_GATE_LOCK_TIMEOUT_MILLIS,
        ))
        .map_err(|_| "Unable to acquire cloud session safety lock.".to_string())?;
    connection
        .execute_batch(
            "BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS gate_lock (id INTEGER PRIMARY KEY);",
        )
        .map_err(|_| "Unable to acquire cloud session safety lock.".to_string())?;

    match action() {
        Ok(value) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|_| "Unable to release cloud session safety lock.".to_string())?;
            Ok(value)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn session_keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_SESSION_USER)
        .map_err(|e| format!("system keyring unavailable: {e}"))
}

fn validate_stored_cloud_session(session: &CloudSession) -> Result<(), String> {
    if session.access_token.trim().is_empty()
        || session.refresh_token.trim().is_empty()
        || session.user_id.trim().is_empty()
    {
        return Err(
            "stored Supabase session is invalid: required session fields are empty.".to_string(),
        );
    }
    Ok(())
}

fn parse_stored_cloud_session(raw: &str) -> Result<CloudSession, String> {
    let session = serde_json::from_str::<CloudSession>(raw).map_err(|_| {
        "stored Supabase session is invalid: credential encoding or JSON shape is unsupported."
            .to_string()
    })?;
    validate_stored_cloud_session(&session)?;
    Ok(session)
}

fn decode_keyring_session_secret(
    secret: &[u8],
    windows_password_encoding: bool,
) -> Result<(CloudSession, bool), String> {
    if windows_password_encoding && secret.len().is_multiple_of(2) {
        let utf16 = secret
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        if let Ok(raw) = String::from_utf16(&utf16) {
            if let Ok(session) = parse_stored_cloud_session(&raw) {
                return Ok((session, false));
            }
        }
    }

    if let Ok(raw) = std::str::from_utf8(secret) {
        if let Ok(session) = parse_stored_cloud_session(raw) {
            // keyring 3.x stores Windows passwords as UTF-16LE. Some existing
            // TokenLedger credentials were written as a raw UTF-8 JSON blob;
            // accept that legacy representation once and rewrite it below.
            return Ok((session, windows_password_encoding));
        }
    }

    Err(
        "stored Supabase session is invalid: credential encoding or JSON shape is unsupported."
            .to_string(),
    )
}

fn decode_and_migrate_keyring_session(
    secret: &[u8],
    windows_password_encoding: bool,
    migrate_legacy: &mut dyn FnMut(&CloudSession) -> Result<(), String>,
) -> Result<CloudSession, String> {
    let (session, needs_migration) =
        decode_keyring_session_secret(secret, windows_password_encoding)?;
    if needs_migration {
        migrate_legacy(&session)?;
    }
    Ok(session)
}

fn load_session_from_keyring() -> Result<Option<CloudSession>, String> {
    let entry = session_keyring_entry()?;
    let mut secret = match entry.get_secret() {
        Ok(secret) => secret,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(format!("failed to read Supabase session from keyring: {e}")),
    };
    let result =
        decode_and_migrate_keyring_session(&secret, cfg!(target_os = "windows"), &mut |session| {
            let raw = serde_json::to_string(session).map_err(|e| e.to_string())?;
            entry
                .set_password(&raw)
                .map_err(|e| format!("failed to migrate legacy Supabase session in keyring: {e}"))
        })
        .map(Some);
    secret.fill(0);
    result
}

fn save_session_to_keyring(session: &CloudSession) -> Result<(), String> {
    validate_stored_cloud_session(session)?;
    let entry = session_keyring_entry()?;
    let raw = serde_json::to_string(session).map_err(|e| e.to_string())?;
    entry
        .set_password(&raw)
        .map_err(|e| format!("failed to store Supabase session in keyring: {e}"))
}

fn clear_session_from_keyring() -> Result<(), String> {
    let entry = session_keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "failed to clear Supabase session from keyring: {e}"
        )),
    }
}

fn decode_base64url(input: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len() * 3 / 4);
    let mut accumulator = 0u32;
    let mut sextets = 0u8;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            b'=' => continue,
            _ => return None,
        } as u32;
        accumulator = (accumulator << 6) | value;
        sextets += 1;
        if sextets == 4 {
            output.push(((accumulator >> 16) & 0xff) as u8);
            output.push(((accumulator >> 8) & 0xff) as u8);
            output.push((accumulator & 0xff) as u8);
            accumulator = 0;
            sextets = 0;
        }
    }
    match sextets {
        0 => {}
        2 => output.push(((accumulator >> 4) & 0xff) as u8),
        3 => {
            output.push(((accumulator >> 10) & 0xff) as u8);
            output.push(((accumulator >> 2) & 0xff) as u8);
        }
        _ => return None,
    }
    Some(output)
}

pub(crate) fn is_forbidden_supabase_service_role_key(key: &str) -> bool {
    let key = key.trim();
    if key.starts_with("sb_secret_") || key.eq_ignore_ascii_case("service_role") {
        return true;
    }
    let Some(payload) = key.split('.').nth(1).and_then(decode_base64url) else {
        return false;
    };
    serde_json::from_slice::<Value>(&payload)
        .ok()
        .and_then(|value| value.get("role").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|role| role == "service_role")
}

fn scrub_forbidden_cloud_config(mut config: CloudConfig) -> Option<CloudConfig> {
    if !is_forbidden_supabase_service_role_key(&config.supabase_key) {
        return None;
    }
    config.supabase_key.clear();
    config.session = None;
    Some(config)
}

fn normalize_supabase_url(url: &str) -> String {
    let raw = url.trim().trim_end_matches('/').to_string();
    if raw.is_empty() {
        return raw;
    }

    let parse_target = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.clone()
    } else {
        format!("https://{}", raw)
    };

    if let Ok(parsed) = Url::parse(&parse_target) {
        if let Some(host) = parsed.host_str() {
            let mut origin = format!("{}://{}", parsed.scheme(), host);
            if let Some(port) = parsed.port() {
                origin.push_str(&format!(":{}", port));
            }

            let path = parsed.path().trim_end_matches('/');
            let is_supabase_endpoint = path.is_empty()
                || path == "/"
                || path == "/rest/v1"
                || path.starts_with("/rest/v1/")
                || path == "/auth/v1"
                || path.starts_with("/auth/v1/")
                || path == "/functions/v1"
                || path.starts_with("/functions/v1/");

            if is_supabase_endpoint || host.contains("supabase.co") {
                return origin;
            }
        }
    }

    raw
}

fn default_cloud_config() -> CloudConfig {
    let mut config: CloudConfig =
        serde_json::from_str(DEFAULT_CLOUD_CONFIG_JSON).unwrap_or_default();
    config.supabase_url = normalize_supabase_url(&config.supabase_url);
    config.session = None;
    config
}

fn is_legacy_cloud_project(config: &CloudConfig) -> bool {
    LEGACY_SUPABASE_REFS
        .iter()
        .any(|project_ref| config.supabase_url.contains(project_ref))
}

/// Read only the non-secret cloud connection fields for the initial UI.
///
/// The full cloud-config loader intentionally joins this read with the secure
/// session in Keychain. That is correct for cloud work, but it made a local
/// dashboard cold start request a system credential prompt before the user
/// asked to inspect or use cloud features. Keep the startup projection
/// session-free; the settings surface calls `get_cloud_status` when it needs
/// the authenticated state.
fn load_public_cloud_config_file(app: &AppContext) -> Result<CloudConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(default_cloud_config());
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut config: CloudConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    config.supabase_url = normalize_supabase_url(&config.supabase_url);
    config.session = None;
    if let Some(scrubbed) = scrub_forbidden_cloud_config(config.clone()) {
        return Ok(scrubbed);
    }
    if is_legacy_cloud_project(&config) {
        return Ok(default_cloud_config());
    }
    Ok(config)
}

pub(crate) fn load_cloud_config_file(app: &AppContext) -> Result<CloudConfig, String> {
    let mut load_secure_session = load_session_from_keyring;
    let mut save_secure_session = save_session_to_keyring;
    let mut clear_secure_session = clear_session_from_keyring;
    load_cloud_config_file_with_keyring_ops(
        app,
        cloud_session_coordinator(),
        &mut load_secure_session,
        &mut save_secure_session,
        &mut clear_secure_session,
    )
}

fn load_cloud_config_file_for_sign_out(app: &AppContext) -> Result<CloudConfig, String> {
    let mut load_secure_session = load_session_from_keyring;
    let mut save_secure_session = save_session_to_keyring;
    let mut clear_secure_session = clear_session_from_keyring;
    load_cloud_config_file_with_keyring_ops_mode(
        app,
        cloud_session_coordinator(),
        &mut load_secure_session,
        &mut save_secure_session,
        &mut clear_secure_session,
        true,
        false,
    )
}

fn load_cloud_config_file_for_status_check(app: &AppContext) -> Result<CloudConfig, String> {
    // This is the explicit settings action. It is the only normal cloud-status
    // path allowed to clear a cached Keychain failure and try the prompt again.
    let mut load_secure_session = load_session_from_keyring;
    let mut save_secure_session = save_session_to_keyring;
    let mut clear_secure_session = clear_session_from_keyring;
    load_cloud_config_file_with_keyring_ops_mode(
        app,
        cloud_session_coordinator(),
        &mut load_secure_session,
        &mut save_secure_session,
        &mut clear_secure_session,
        false,
        true,
    )
}

#[cfg(test)]
fn load_cloud_config_file_with_forbidden_clear(
    app: &AppContext,
    forbidden_clear: &mut dyn FnMut() -> Result<(), String>,
) -> Result<CloudConfig, String> {
    let mut load_secure_session = load_session_from_keyring;
    let mut save_secure_session = save_session_to_keyring;
    load_cloud_config_file_with_keyring_ops(
        app,
        cloud_session_coordinator(),
        &mut load_secure_session,
        &mut save_secure_session,
        forbidden_clear,
    )
}

fn load_cloud_config_file_with_keyring_ops(
    app: &AppContext,
    session_coordinator: &CloudSessionCoordinator,
    load_secure_session: &mut dyn FnMut() -> Result<Option<CloudSession>, String>,
    save_secure_session: &mut dyn FnMut(&CloudSession) -> Result<(), String>,
    clear_secure_session: &mut dyn FnMut() -> Result<(), String>,
) -> Result<CloudConfig, String> {
    load_cloud_config_file_with_keyring_ops_mode(
        app,
        session_coordinator,
        load_secure_session,
        save_secure_session,
        clear_secure_session,
        false,
        false,
    )
}

fn load_cloud_config_file_with_keyring_ops_mode(
    app: &AppContext,
    session_coordinator: &CloudSessionCoordinator,
    load_secure_session: &mut dyn FnMut() -> Result<Option<CloudSession>, String>,
    save_secure_session: &mut dyn FnMut(&CloudSession) -> Result<(), String>,
    clear_secure_session: &mut dyn FnMut() -> Result<(), String>,
    allow_blocked_session: bool,
    retry_keyring_read: bool,
) -> Result<CloudConfig, String> {
    let expected_generation = session_coordinator.current();
    load_cloud_config_file_with_keyring_ops_at_generation(
        app,
        session_coordinator,
        load_secure_session,
        save_secure_session,
        clear_secure_session,
        allow_blocked_session,
        retry_keyring_read,
        expected_generation,
    )
}

// Keep generation capture separate so loader races can be scheduled in tests
// before acquiring the commit lock, without replacing the real loader logic.
#[allow(clippy::too_many_arguments)]
fn load_cloud_config_file_with_keyring_ops_at_generation(
    app: &AppContext,
    session_coordinator: &CloudSessionCoordinator,
    load_secure_session: &mut dyn FnMut() -> Result<Option<CloudSession>, String>,
    save_secure_session: &mut dyn FnMut(&CloudSession) -> Result<(), String>,
    clear_secure_session: &mut dyn FnMut() -> Result<(), String>,
    allow_blocked_session: bool,
    retry_keyring_read: bool,
    expected_generation: u64,
) -> Result<CloudConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        let mut config = default_cloud_config();
        if let Some(scrubbed) = scrub_forbidden_cloud_config(config.clone()) {
            crate::quota_sync::invalidate_session_locally(app);
            session_coordinator.invalidate(|| {
                save_cloud_config_file(app, &scrubbed)?;
                clear_secure_session()
            })?;
            return Ok(scrubbed);
        }
        if !allow_blocked_session && session_coordinator.is_session_blocked(app) {
            return Ok(config);
        }
        config.session = match session_coordinator.inspect_if_current(expected_generation, || {
            if allow_blocked_session {
                load_secure_session()
            } else {
                session_coordinator.load_session_for_ready_epoch(
                    app,
                    load_secure_session,
                    retry_keyring_read,
                )
            }
        }) {
            Ok(session) => session,
            Err(error) => {
                fail_closed_cloud_session_after_load_error(
                    app,
                    session_coordinator,
                    expected_generation,
                    &error,
                );
                return Err(error);
            }
        };
        return Ok(config);
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut config: CloudConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let legacy_session = config.session.take();
    config.supabase_url = normalize_supabase_url(&config.supabase_url);
    if let Some(scrubbed) = scrub_forbidden_cloud_config(config.clone()) {
        crate::quota_sync::invalidate_session_locally(app);
        session_coordinator.invalidate(|| {
            save_cloud_config_file(app, &scrubbed)?;
            clear_secure_session()
        })?;
        return Ok(scrubbed);
    }
    if is_legacy_cloud_project(&config) {
        let next = default_cloud_config();
        crate::quota_sync::invalidate_session_locally(app);
        session_coordinator.invalidate(|| {
            clear_secure_session()?;
            save_cloud_config_file(app, &next)
        })?;
        return Ok(next);
    }
    if let Some(legacy_session) = legacy_session {
        // Scrub and migrate under the same generation-checked commit lock.
        // A sign-out or project switch that starts at any point either runs
        // afterwards and clears the migrated value, or supersedes this commit.
        let migrated = session_coordinator.replace_if_current(expected_generation, || {
            save_cloud_config_file(app, &config)?;
            if !allow_blocked_session && session_coordinator.is_session_blocked(app) {
                return Ok(None);
            }
            let secure_session = if allow_blocked_session {
                load_secure_session()?
            } else {
                session_coordinator.load_session_for_ready_epoch(
                    app,
                    load_secure_session,
                    retry_keyring_read,
                )?
            };
            match secure_session {
                Some(session) => Ok(Some(session)),
                None => {
                    save_secure_session(&legacy_session)?;
                    Ok(Some(legacy_session))
                }
            }
        });
        match migrated {
            Ok(session) => config.session = session,
            Err(error) => {
                fail_closed_cloud_session_after_load_error(
                    app,
                    session_coordinator,
                    expected_generation.wrapping_add(1),
                    &error,
                );
                return Err(error);
            }
        }
        return Ok(config);
    }
    if !allow_blocked_session && session_coordinator.is_session_blocked(app) {
        return Ok(config);
    }
    config.session = match session_coordinator.inspect_if_current(expected_generation, || {
        if allow_blocked_session {
            load_secure_session()
        } else {
            session_coordinator.load_session_for_ready_epoch(
                app,
                load_secure_session,
                retry_keyring_read,
            )
        }
    }) {
        Ok(session) => session,
        Err(error) => {
            fail_closed_cloud_session_after_load_error(
                app,
                session_coordinator,
                expected_generation,
                &error,
            );
            return Err(error);
        }
    };
    Ok(config)
}

fn save_cloud_config_file(app: &AppContext, config: &CloudConfig) -> Result<(), String> {
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    crate::quota::write_private_app_data_file(
        app.app_data_dir(),
        CLOUD_CONFIG_FILE,
        content.as_bytes(),
    )
}

/// The device id `token_logs` rows carry; other uploads only send it hashed.
pub(crate) fn local_machine_id(app: &AppContext) -> String {
    fallback_machine_id(&db::get_db_path(app))
}

fn fallback_machine_id(db_path: &Path) -> String {
    crate::device_identity::for_db_or_unknown(db_path)
}

fn default_prices() -> Value {
    serde_json::from_str(DEFAULT_PRICES_JSON).unwrap_or(Value::Null)
}

fn merge_price_overrides(base: &Value, overrides: &Value) -> Value {
    match (base, overrides) {
        (Value::Object(base_obj), Value::Object(override_obj)) => {
            let mut merged = base_obj.clone();
            for (key, override_value) in override_obj {
                let merged_value = match merged.get(key) {
                    Some(base_value) => merge_price_overrides(base_value, override_value),
                    None => override_value.clone(),
                };
                merged.insert(key.clone(), merged_value);
            }
            Value::Object(merged)
        }
        (_, override_value) => override_value.clone(),
    }
}

// ---- User price overrides (T10.171) ----
//
// `<app_data_dir>/prices.json` holds only what the user changed: for a bundled
// model the rate fields that differ from the bundled table, for a model found
// by auto-discovery ("待核价") the fields that differ from the tool fallback it
// is estimated with, except that a models.dev import keeps every price it
// imported. Everything else follows the bundled table on load, so a bundled
// price correction reaches every model the user never edited.

const PRICE_OVERRIDES_FILE: &str = "prices.json";
/// SHA-256 of the override file as the current format last wrote it. With the
/// record missing or another hash, a file with the traits of an older version
/// (`has_legacy_override_traits`) is migrated once; any other file is taken as
/// this format's and its hash recorded.
const PRICE_OVERRIDES_STATE_FILE: &str = "prices.overrides-state.json";
const PRICE_OVERRIDES_FORMAT: u64 = 2;
/// The result of the last migration for the settings page and the ids of
/// the notices the user dismissed (T10.189). "恢复默认" keeps it, like the
/// backups it points to.
const PRICE_MIGRATION_NOTICE_FILE: &str = "prices.migration-notice.json";
const PRICE_MIGRATION_NOTICE_FORMAT: u64 = 1;
/// Dismissed notice ids kept; older ones are dropped first.
const PRICE_MIGRATION_DISMISSED_LIMIT: usize = 32;
const PRICE_RATE_FIELDS: [&str; 4] = ["input", "output", "cache_input", "cache_write"];
/// Serialises every read, migration and rewrite of the override file.
static PRICE_OVERRIDES_LOCK: Mutex<()> = Mutex::new(());

/// Every value each model's rate fields had in the bundled price table of a
/// released build, plus the table this release ships (T10.168, 2504f5d9). A
/// released build is taken to be each commit that set a new version in
/// `src-tauri/tauri.conf.json`: 60 version bumps from 0.1.0 to 1.2.77, which
/// used 7 distinct tables (`src-tauri/prices.json`, earlier
/// `legacy/prices.json` and `prices.json`). Values that only ever existed
/// between two releases are left out: no override file can hold them as a
/// byproduct. One line per model: `model|field=value,value;field=value`.
///
/// Older versions saved the editor's whole table. JavaScript writes `3.0` as
/// `3`, which serde_json never equals to the bundled `3.0`, so every integral
/// bundled value was pinned in the override file; before 2026-06-13 the file
/// was a full copy of the table. A legacy override equal to one of these
/// values is such a byproduct, not a user edit. The list is frozen: the
/// current format never writes byproducts, so later price changes need not be
/// added.
const LEGACY_BUNDLED_PRICE_HISTORY: &str = "\
aliyun-imageseg|input=0;output=0.014
claude-3-5-haiku|input=0.8;output=4
claude-3-5-sonnet|input=3;output=15
claude-3-7-sonnet|input=3;output=15
claude-3-opus|input=15;output=75
claude-fable-5|input=10;output=50;cache_input=1;cache_write=12.5
claude-fable-5-1|input=10;output=50;cache_input=0.25,1;cache_write=12.5
claude-haiku-4-5|input=1;output=5;cache_input=0.1;cache_write=1.25
claude-mythos-5|input=10;output=50;cache_input=1;cache_write=12.5
claude-mythos-5-1|input=10;output=50;cache_input=0.25;cache_write=12.5
claude-opus-4|input=15;output=75;cache_input=1.5;cache_write=18.75
claude-opus-4-1|input=15;output=75;cache_input=1.5;cache_write=18.75
claude-opus-4-5|input=5;output=25;cache_input=0.5;cache_write=6.25
claude-opus-4-6|input=5;output=25;cache_input=0.5;cache_write=6.25
claude-opus-4-7|input=5;output=25;cache_input=0.5;cache_write=6.25
claude-opus-4-8|input=5,10;output=25,50;cache_input=0.5;cache_write=6.25
claude-opus-5|input=5;output=25;cache_input=0.5;cache_write=6.25
claude-opus-5-5|input=4;output=20;cache_input=0.2;cache_write=5
claude-sonnet-4|input=3;output=15;cache_input=0.3;cache_write=3.75
claude-sonnet-4-2|input=3;output=15
claude-sonnet-4-5|input=3;output=15;cache_input=0.3;cache_write=3.75
claude-sonnet-4-6|input=3;output=15;cache_input=0.3;cache_write=3.75
claude-sonnet-5|input=2,3;output=10,15;cache_input=0.2,0.3;cache_write=2.5,3.75
claude-unknown|input=3;output=15;cache_input=0.3;cache_write=3.75
codex-agent|input=1.5;output=2
codex-mini-latest|input=1.5;output=6;cache_input=0.375;cache_write=1.5
deepseek|input=0.14,0.27;output=0.28,1.1
deepseek-chat|input=0.27;output=1.1
deepseek-flash|input=0.28;output=1.11;cache_input=0.0056
deepseek-r1|input=0.55;output=2.19
deepseek-v3.1|input=0.27;output=1.1
deepseek-v3.2-exp|input=0.27;output=1.1
deepseek-v3.2-speciale|input=0.27;output=1.1
deepseek-v4-flash|input=0.14,0.28;output=0.28,1.11;cache_input=0.0028,0.0056
deepseek-v4-flash-ali|input=0.14;output=0.28;cache_input=0.014
deepseek-v4-pro|input=0.42,1.25,1.74;output=0.83,3.48,3.75;cache_input=0.0042,0.042
deepseek-v4-pro-ali|input=1.67;output=3.33;cache_input=0.14
default|input=1;output=3
doubao-embedding|input=0.07;output=0
doubao-embedding-large|input=0.1;output=0
doubao-embedding-vision|input=0.25;output=0
doubao-seed-2.0-code|input=0.44,0.67;output=2.22,3.33;cache_input=0.09,0.13
doubao-seed-2.0-lite|input=0.08,0.125;output=0.5,0.75;cache_input=0.017,0.025
doubao-seed-2.0-mini|input=0.03,0.056;output=0.28,0.56;cache_input=0.006,0.011
doubao-seed-2.0-pro|input=0.44,0.67;output=2.22,3.33;cache_input=0.09,0.13
doubao-seed-2.1-lite|input=0.11;output=0.375;cache_input=0.022
doubao-seed-2.1-pro|input=0.83;output=4.17;cache_input=0.17
ernie-4.5|input=0.07;output=0.28;cache_input=0
ernie-5.0|input=0.14,1.39;output=0.56,5.56;cache_input=0
ernie-5.1|input=0.83;output=3.06;cache_input=0
ernie-x1.1|input=0.14;output=0.56;cache_input=0
gemini-1.5-pro|input=1.25;output=5
gemini-2.0-flash|input=0.1;output=0.4
gemini-2.5-flash|input=0.3;output=2.5
gemini-2.5-flash-lite|input=0.1;output=0.4
gemini-2.5-pro|input=1.25;output=10;cache_input=0.125
gemini-3-flash-preview|input=0.5;output=3;cache_input=0.05
gemini-3.1-flash|input=0.5;output=3
gemini-3.1-flash-lite|input=0.25;output=1.5;cache_input=0.025,0.05
gemini-3.1-pro|input=2;output=12;cache_input=0.2
gemini-3.1-pro-preview|input=2;output=12;cache_input=0.2
gemini-3.5-flash|input=1.5;output=9;cache_input=0.15
gemini-3.5-flash-agent|input=0.075,1.5;output=0.3,9
gemini-3.5-flash-lite|input=0.3;output=2.5;cache_input=0.03
gemini-3.5-pro|input=2;output=12
gemini-3.6-flash|input=0.75;output=3.75;cache_input=0.075
gemini-3.7-flash|input=0.75;output=3.75;cache_input=0.075
gemini-3.8-flash|input=0.75;output=3.75;cache_input=0.075
glm-5|input=0.83;output=3.06;cache_input=0.21
glm-5-turbo|input=0.97;output=3.61;cache_input=0.25
glm-5.1|input=1.11;output=3.89;cache_input=0.28
glm-5.2|input=1.11;output=3.89;cache_input=0.28;cache_write=0.28
gpt-4.1|input=2;output=8;cache_input=0.5;cache_write=2
gpt-4.1-mini|input=0.4;output=1.6;cache_input=0.1;cache_write=0.4
gpt-4.1-nano|input=0.1;output=0.4;cache_input=0.025;cache_write=0.1
gpt-4.5|input=75;output=150
gpt-4o|input=2.5;output=10;cache_input=1.25;cache_write=2.5
gpt-4o-mini|input=0.15;output=0.6;cache_input=0.075;cache_write=0.15
gpt-5|input=1.25;output=10;cache_input=0.125;cache_write=1.25
gpt-5-codex|input=1.25;output=10;cache_input=0.125;cache_write=1.25
gpt-5-mini|input=0.25;output=2;cache_input=0.025;cache_write=0.25
gpt-5-nano|input=0.05;output=0.4;cache_input=0.005;cache_write=0.05
gpt-5.1|input=1.25;output=10;cache_input=0.125;cache_write=1.25
gpt-5.1-codex|input=1.25;output=10;cache_input=0.125;cache_write=1.25
gpt-5.1-codex-max|input=1.25;output=10;cache_input=0.125;cache_write=1.25
gpt-5.1-codex-mini|input=0.25;output=2;cache_input=0.025;cache_write=0.25
gpt-5.2|input=1.75;output=14;cache_input=0.175;cache_write=1.75
gpt-5.2-codex|input=1.75;output=14;cache_input=0.175;cache_write=1.75
gpt-5.2-pro|input=21;output=168;cache_input=21;cache_write=21
gpt-5.3-codex|input=1.75,2.5;output=14,15;cache_input=0.175;cache_write=1.75
gpt-5.4|input=2.5;output=15;cache_input=0.25;cache_write=2.5
gpt-5.4-mini|input=0.75;output=4.5;cache_input=0.075;cache_write=0.75
gpt-5.4-nano|input=0.2;output=1.25;cache_input=0.02;cache_write=0.2
gpt-5.4-pro|input=30;output=180;cache_input=30;cache_write=30
gpt-5.5|input=5;output=30;cache_input=0.5;cache_write=5
gpt-5.5-pro|input=30;output=180;cache_input=30;cache_write=30
gpt-5.6|input=4,5;output=20,30;cache_input=0.4,0.5;cache_write=5,6.25
gpt-5.6-luna|input=0.2,1;output=1.2,6;cache_input=0.02,0.1;cache_write=0.25,1.25
gpt-5.6-sol|input=4,5;output=20,30;cache_input=0.4,0.5;cache_write=5,6.25
gpt-5.6-terra|input=2,2.5;output=12,15;cache_input=0.2,0.25;cache_write=2.5,3.125
gpt-6-astra|input=10;output=50;cache_input=1;cache_write=12.5
gpt-6-luna|input=0.1;output=0.5;cache_input=0.01;cache_write=0.125
gpt-6-sol|input=2;output=10;cache_input=0.2;cache_write=2.5
grok-4.3|input=1.25;output=2.5;cache_input=0,0.2
grok-4.5|input=2;output=6;cache_input=0.3
grok-4.6|input=2;output=6;cache_input=0.5
grok-4.7|input=2;output=6;cache_input=0.5
grok-build-0.1|input=1;output=2;cache_input=0.2
hunyuan-2.0-instruct|input=0.11;output=0.28;cache_input=0
hunyuan-2.0-thinking|input=0.14;output=0.56;cache_input=0
kimi-k2.6|input=0.9;output=3.75;cache_input=0.15
kimi-k2.7-code|input=0.9;output=3.75;cache_input=0.18
kimi-k2.7-code-highspeed|input=1.81;output=7.5;cache_input=0.36
kimi-k3|input=2.78;output=13.89;cache_input=0.28;cache_write=2.78
mimo-7b|input=0;output=0
mimo-v2-flash|input=0.1;output=0.3
mimo-v2-pro|input=0.3;output=0.9
mimo-v2.5|input=0.14,0.3,0.78;output=0.28,0.9,3.89;cache_input=0.0028,0.16
mimo-v2.5-pro|input=0.3,0.42,1.94;output=0.83,0.9,5.83;cache_input=0.0035,0.39
mimo-v2.6-flash|input=0.14;output=0.28;cache_input=0.0028
mimo-v2.6-pro|input=0.42;output=0.83;cache_input=0.0035
mimo-v2.6-pro-ultraspeed|input=4.17;output=8.33;cache_input=0.035
minimax|input=0.15,0.29,0.3;output=0.2,1.17,1.2
minimax-m2|input=0.29;output=1.17
minimax-m2-her|input=0.29,0.3;output=1.17,1.2
minimax-m2.1|input=0.29,0.3;output=1.17,1.2
minimax-m2.1-highspeed|input=0.58;output=2.33;cache_input=0.029;cache_write=0.36
minimax-m2.5|input=0.29,0.3;output=1.17,1.2
minimax-m2.5-highspeed|input=0.58;output=2.33;cache_input=0.029;cache_write=0.36
minimax-m2.7|input=0.29,0.3;output=1.17,1.2;cache_input=0,0.058;cache_write=0.36
minimax-m2.7-highspeed|input=0.58;output=2.33;cache_input=0.058;cache_write=0.36
minimax-m3|input=0.29,0.58,0.88;output=1.17,2.33,3.5;cache_input=0.058,0.12
minimax-model|input=0.15,0.29,0.3;output=0.2,1.17,1.2
minimax/minimax-m2.7|input=0.15,0.29,0.3;output=0.2,1.17,1.2;cache_input=0.058;cache_write=0.36
nano-banana-2|input=0.5;output=3;cache_input=0
o1-mini|input=3;output=12
o3|input=2,10;output=8,40;cache_input=0.5;cache_write=2
o3-mini|input=1.1;output=4.4;cache_input=0.55;cache_write=1.1
o4-mini|input=1.1;output=4.4;cache_input=0.275;cache_write=1.1
qwen-deep-research|input=7.5;output=22.64;cache_input=0
qwen3-flash|input=0.05;output=0.4
qwen3-max|input=0.56,1.2;output=2.22,6;cache_input=0.11
qwen3-plus|input=0.11;output=0.44
qwen3.5-max|input=1.2;output=6
qwen3.5-plus|input=0.11;output=0.44
qwen3.6-flash|input=0.17,0.67;output=1,4;cache_input=0.033,0.07
qwen3.6-plus|input=0.28,1.11;output=1.67,6.67;cache_input=0.056,0.11
qwen3.7-flash|input=0.1;output=0.4
qwen3.7-max|input=1.67;output=5;cache_input=0.17,0.33
qwen3.7-plus|input=0.28,0.3,0.83;output=1.11,1.2,3.33;cache_input=0.056,0.08
reasonix-agent|input=0.17;output=1
text-embedding-3-large|input=0.13;output=0
text-embedding-3-small|input=0.02;output=0
text-embedding-v4|input=0.07;output=0
";

type LegacyPriceHistory = HashMap<&'static str, HashMap<&'static str, Vec<f64>>>;

fn legacy_bundled_price_history() -> &'static LegacyPriceHistory {
    static HISTORY: OnceLock<LegacyPriceHistory> = OnceLock::new();
    HISTORY.get_or_init(|| {
        LEGACY_BUNDLED_PRICE_HISTORY
            .lines()
            .filter_map(|line| line.split_once('|'))
            .map(|(model, fields)| {
                let fields = fields
                    .split(';')
                    .filter_map(|field| field.split_once('='))
                    .map(|(field, values)| {
                        let values = values
                            .split(',')
                            .filter_map(|value| value.parse::<f64>().ok())
                            .collect();
                        (field, values)
                    })
                    .collect();
                (model, fields)
            })
            .collect()
    })
}

/// Price equality up to the last bits of an f64. A fallback estimate such as
/// `0.29 * 0.1` prints as `0.028999999999999998`; serde_json without
/// `float_roundtrip` reads that text back as `0.029`, so the table the editor
/// sends back differs from what `get_prices` returned in the last bit. Prices
/// carry at most six significant digits, so a relative tolerance of 1e-12
/// never makes two different prices equal.
fn price_numbers_equal(left: f64, right: f64) -> bool {
    left == right || (left - right).abs() <= 1e-12 * left.abs().max(right.abs())
}

fn price_number_in(values: &[f64], value: f64) -> bool {
    values
        .iter()
        .any(|candidate| price_numbers_equal(*candidate, value))
}

/// Whether the bundled table ever had `value` for `model`'s `field`.
fn is_legacy_bundled_price(model: &str, field: &str, value: &Value) -> bool {
    let Some(value) = value.as_f64() else {
        return false;
    };
    legacy_bundled_price_history()
        .get(model)
        .and_then(|fields| fields.get(field))
        .is_some_and(|values| price_number_in(values, value))
}

/// Every rate an older version could have shown for a model estimated with
/// `fallback_key` (see `materialize_discovered_price`): the fallback's values
/// in any bundled table, cache reads at 10% of its input, and cache writes at
/// 125% of its input (every fallback before T10.93) or at its input
/// (non-Claude fallbacks since). Older saves wrote these next to the field the
/// user edited, and the fallback may have changed since.
fn legacy_fallback_price_candidates(fallback_key: &str) -> HashMap<&'static str, Vec<f64>> {
    let history = legacy_bundled_price_history();
    let Some(fields) = history.get(fallback_key).or_else(|| history.get("default")) else {
        return HashMap::new();
    };
    let mut candidates: HashMap<&'static str, Vec<f64>> = PRICE_RATE_FIELDS
        .iter()
        .map(|field| (*field, fields.get(field).cloned().unwrap_or_default()))
        .collect();
    for input in fields.get("input").into_iter().flatten() {
        candidates
            .entry("cache_input")
            .or_default()
            .push(input * 0.1);
        let cache_write = candidates.entry("cache_write").or_default();
        cache_write.push(input * 1.25);
        if !fallback_key.starts_with("claude") {
            cache_write.push(*input);
        }
    }
    candidates
}

/// JSON equality that compares numbers by value (`price_numbers_equal`): the
/// editor sends `3` for the bundled `3.0`, which serde_json keeps apart, and a
/// computed estimate comes back a bit off after its trip through JSON text.
fn price_values_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => match (left.as_f64(), right.as_f64()) {
            (Some(left), Some(right)) => price_numbers_equal(left, right),
            _ => false,
        },
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| price_values_equal(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left)| {
                    right
                        .get(key)
                        .is_some_and(|right| price_values_equal(left, right))
                })
        }
        _ => left == right,
    }
}

fn price_override_status(entry: &Value) -> Option<&str> {
    entry.pointer("/_meta/status").and_then(Value::as_str)
}

/// Rows that started as an auto-discovered model. The visual editor marks an
/// edited row `user_edited`, a models.dev import `models_dev_imported`.
fn is_discovered_price_override(entry: &Value) -> bool {
    matches!(
        price_override_status(entry),
        Some("auto_discovered" | "user_edited" | "models_dev_imported")
    )
}

/// The fallback key an auto-discovered row is estimated with. Imports saved by
/// older versions dropped `fallback_key`; like auto-discovery, derive it from
/// the alphabetically first tool.
fn price_override_fallback_key(entry: &Value) -> String {
    if let Some(key) = entry
        .pointer("/_meta/fallback_key")
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
    {
        return key.to_string();
    }
    let tool = entry
        .pointer("/_meta/tools")
        .and_then(Value::as_array)
        .and_then(|tools| tools.iter().filter_map(Value::as_str).min())
        .unwrap_or_default();
    tool_fallback_price_key(tool).to_string()
}

/// The rates auto-discovery gives a model estimated with `fallback_key`,
/// computed by the same code as `merge_discovered_prices`.
fn discovered_fallback_rates(explicit: &Value, fallback_key: &str) -> Map<String, Value> {
    let fallback = explicit
        .get(fallback_key)
        .or_else(|| explicit.get("default"))
        .unwrap_or(&Value::Null);
    let placeholder = DiscoveredModelPrice {
        tool: String::new(),
        model_key: String::new(),
        model: String::new(),
        tools: Vec::new(),
        first_seen_at: String::new(),
        last_seen_at: String::new(),
    };
    let materialized = materialize_discovered_price(fallback, fallback_key, &placeholder);
    PRICE_RATE_FIELDS
        .iter()
        .filter_map(|field| {
            materialized
                .get(*field)
                .map(|value| ((*field).to_string(), value.clone()))
        })
        .collect()
}

/// The bundled table with the user's overrides applied. A bundled model merges
/// field by field; an auto-discovered model stores only the fields the user
/// changed, so the rest comes from its tool fallback, as auto-discovery would
/// estimate it.
fn apply_price_overrides(defaults: &Value, overrides: &Map<String, Value>) -> Value {
    let mut explicit = merge_price_overrides(defaults, &Value::Object(overrides.clone()));
    price_schedule::strip_overridden_history(&mut explicit, overrides);
    let bundled = defaults.as_object();
    let completions: Vec<(String, Map<String, Value>)> = overrides
        .iter()
        .filter(|(model, entry)| {
            !bundled.is_some_and(|bundled| bundled.contains_key(model.as_str()))
                && entry.is_object()
                && is_discovered_price_override(entry)
        })
        .map(|(model, entry)| {
            let fallback_key = price_override_fallback_key(entry);
            (
                model.clone(),
                discovered_fallback_rates(&explicit, &fallback_key),
            )
        })
        .collect();
    if let Some(table) = explicit.as_object_mut() {
        for (model, fallback) in completions {
            if let Some(Value::Object(entry)) = table.get_mut(&model) {
                for (field, value) in fallback {
                    entry.entry(field).or_insert(value);
                }
            }
        }
    }
    explicit
}

/// The rate fields a models.dev import took from models.dev: those not listed
/// in `_meta.estimated_fields`, which the import filled from the row's
/// fallback estimate. `None` for other rows, and for an import row without
/// that list (the import feature always writes it), whose fields can then
/// only be told apart by comparing them with the fallback.
fn imported_price_fields(entry: &Value) -> Option<Vec<&'static str>> {
    if price_override_status(entry) != Some("models_dev_imported") {
        return None;
    }
    let estimated = entry.pointer("/_meta/estimated_fields")?.as_array()?;
    Some(
        PRICE_RATE_FIELDS
            .iter()
            .copied()
            .filter(|field| !estimated.iter().any(|name| name.as_str() == Some(*field)))
            .collect(),
    )
}

/// Rebuilds the override set from the editor's whole table (`edited`) and the
/// explicit table the editor was loaded from (`previous`). Only real edits are
/// kept: fields that differ from the bundled table and, for auto-discovered
/// rows, fields that differ from the fallback the editor was showing. An
/// untouched auto-discovered row stays with auto-discovery.
///
/// Two exceptions keep what the user did on an auto-discovered row even when
/// the price equals the estimate (review P2-2, U-7): a models.dev import keeps
/// every price it took from models.dev, and a row the user edited
/// (`user_edited`) whose prices all equal the estimate is kept as a `_meta`
/// row, so it stays marked as checked and follows the estimate.
fn price_overrides_from_edit(
    defaults: &Value,
    previous: &Value,
    edited: &Value,
) -> Result<Map<String, Value>, String> {
    let Some(edited) = edited.as_object() else {
        return Err("价格表必须是 JSON 对象".to_string());
    };
    let empty = Map::new();
    let bundled = defaults.as_object().unwrap_or(&empty);
    let mut overrides = Map::new();
    for (model, entry) in edited {
        let Some(fields) = entry.as_object() else {
            if !bundled
                .get(model)
                .is_some_and(|bundled| price_values_equal(entry, bundled))
            {
                overrides.insert(model.clone(), entry.clone());
            }
            continue;
        };
        if let Some(bundled_entry) = bundled.get(model) {
            let mut changed = Map::new();
            let mut changed_rate = false;
            for (field, value) in fields {
                if field == "_meta"
                    || bundled_entry
                        .get(field)
                        .is_some_and(|bundled| price_values_equal(value, bundled))
                {
                    continue;
                }
                changed_rate |= PRICE_RATE_FIELDS.contains(&field.as_str());
                changed.insert(field.clone(), value.clone());
            }
            if changed_rate && price_override_status(entry) != Some("auto_discovered") {
                if let Some(meta) = fields.get("_meta") {
                    changed.insert("_meta".to_string(), meta.clone());
                }
            }
            if !changed.is_empty() {
                overrides.insert(model.clone(), Value::Object(changed));
            }
        } else if is_discovered_price_override(entry) {
            let fallback_key = price_override_fallback_key(entry);
            let fallback = discovered_fallback_rates(previous, &fallback_key);
            let imported = imported_price_fields(entry).unwrap_or_default();
            let mut changed = Map::new();
            for (field, value) in fields {
                let unchanged_rate = PRICE_RATE_FIELDS.contains(&field.as_str())
                    && !imported.contains(&field.as_str())
                    && fallback
                        .get(field)
                        .is_some_and(|fallback| price_values_equal(value, fallback));
                if field != "_meta" && !unchanged_rate {
                    changed.insert(field.clone(), value.clone());
                }
            }
            let changed_rate = changed
                .keys()
                .any(|field| PRICE_RATE_FIELDS.contains(&field.as_str()));
            if !changed_rate && price_override_status(entry) == Some("auto_discovered") {
                // Untouched "待核价" row: auto-discovery keeps estimating it.
                continue;
            }
            let mut meta = fields
                .get("_meta")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if meta.get("status").and_then(Value::as_str) == Some("auto_discovered") {
                // Edited in the JSON view without touching `_meta`.
                meta.insert("status".to_string(), json!("user_edited"));
                meta.insert("price_source".to_string(), json!("user_override"));
            }
            meta.entry("fallback_key")
                .or_insert_with(|| json!(fallback_key));
            changed.insert("_meta".to_string(), Value::Object(meta));
            overrides.insert(model.clone(), Value::Object(changed));
        } else {
            overrides.insert(model.clone(), entry.clone());
        }
    }
    Ok(overrides)
}

/// Converts an override file written before T10.171 into the current shape.
/// Old versions saved the editor's whole table, so the file mixes real edits
/// with byproducts. Per model:
/// - an `auto_discovered` row (the "待核价" marker) is dropped: the editor
///   marks every edited row `user_edited`, so this one was never touched;
/// - a rate field equal to the bundled value, to a value a released bundled
///   table had for that model (`LEGACY_BUNDLED_PRICE_HISTORY`), or, for a row
///   that started as auto-discovered, to its tool fallback before or after
///   this migration or to any estimate that fallback gave in an older version
///   (`legacy_fallback_price_candidates`) is dropped;
/// - except in a models.dev import, whose prices from models.dev (the rate
///   fields `_meta.estimated_fields` does not list) go only when equal to
///   today's bundled value. The listed fields held the estimate when the row
///   was imported and follow the rule above: the visual editor keeps the
///   import's status and list, so a cache price typed in later stays;
/// - a model left without rate fields is dropped together with its metadata;
/// - a model the bundled table has dropped since, whose override holds only
///   values that table once had, is dropped;
/// - everything else, including models the user added, is kept.
///
/// Applying it to its own output changes nothing, and its output has none of
/// the traits `has_legacy_override_traits` looks for.
fn migrate_legacy_price_overrides(
    defaults: &Value,
    legacy: &Map<String, Value>,
) -> Map<String, Value> {
    let empty = Map::new();
    let bundled = defaults.as_object().unwrap_or(&empty);
    let before = merge_price_overrides(defaults, &Value::Object(legacy.clone()));
    let mut migrated = Map::new();
    let mut discovered = Vec::new();
    for (model, entry) in legacy {
        let Some(fields) = entry.as_object() else {
            migrated.insert(model.clone(), entry.clone());
            continue;
        };
        match price_override_status(entry) {
            Some("auto_discovered") => continue,
            Some("user_edited" | "models_dev_imported") => {
                discovered.push((model, entry, fields));
                continue;
            }
            _ => {}
        }
        match bundled.get(model) {
            Some(bundled_entry) => {
                if let Some(kept) = keep_user_price_fields(
                    model,
                    fields,
                    Some(bundled_entry),
                    &[],
                    &HashMap::new(),
                    &[],
                ) {
                    migrated.insert(model.clone(), Value::Object(kept));
                }
            }
            None if is_legacy_whole_table_pin(model, fields) => {}
            None => {
                migrated.insert(model.clone(), entry.clone());
            }
        }
    }
    let after = merge_price_overrides(defaults, &Value::Object(migrated.clone()));
    for (model, entry, fields) in discovered {
        let fallback_key = price_override_fallback_key(entry);
        let bundled_entry = bundled.get(model);
        let fallbacks = [
            discovered_fallback_rates(&before, &fallback_key),
            discovered_fallback_rates(&after, &fallback_key),
        ];
        let earlier_fallbacks = legacy_fallback_price_candidates(&fallback_key);
        let imported_fields = imported_price_fields(entry).unwrap_or_default();
        let Some(mut kept) = keep_user_price_fields(
            model,
            fields,
            bundled_entry,
            &fallbacks,
            &earlier_fallbacks,
            &imported_fields,
        ) else {
            continue;
        };
        if bundled_entry.is_none() {
            if let Some(Value::Object(meta)) = kept.get_mut("_meta") {
                meta.entry("fallback_key")
                    .or_insert_with(|| json!(fallback_key));
            }
        }
        migrated.insert(model.clone(), Value::Object(kept));
    }
    migrated
}

/// Keeps the rate fields that are the user's own choice. A field in
/// `imported` (a price a models.dev import took from models.dev) goes only
/// when it equals the bundled value; any other goes when it equals the
/// bundled value, a value the bundled table once had, one of `fallbacks`, or
/// one of `earlier_fallbacks`. `None` when every rate field was dropped.
fn keep_user_price_fields(
    model: &str,
    fields: &Map<String, Value>,
    bundled_entry: Option<&Value>,
    fallbacks: &[Map<String, Value>],
    earlier_fallbacks: &HashMap<&'static str, Vec<f64>>,
    imported: &[&str],
) -> Option<Map<String, Value>> {
    let mut kept = Map::new();
    let mut dropped_rate = false;
    let mut kept_rate = false;
    for (field, value) in fields {
        if !PRICE_RATE_FIELDS.contains(&field.as_str()) {
            kept.insert(field.clone(), value.clone());
            continue;
        }
        let bundled = bundled_entry
            .and_then(|entry| entry.get(field))
            .is_some_and(|bundled| price_values_equal(value, bundled));
        let estimate_or_history = !imported.contains(&field.as_str()) && {
            let historical =
                bundled_entry.is_some() && is_legacy_bundled_price(model, field, value);
            let fallback = fallbacks.iter().any(|rates| {
                rates
                    .get(field)
                    .is_some_and(|rate| price_values_equal(value, rate))
            });
            let earlier_fallback = value.as_f64().is_some_and(|value| {
                earlier_fallbacks
                    .get(field.as_str())
                    .is_some_and(|values| price_number_in(values, value))
            });
            historical || fallback || earlier_fallback
        };
        if bundled || estimate_or_history {
            dropped_rate = true;
        } else {
            kept.insert(field.clone(), value.clone());
            kept_rate = true;
        }
    }
    (kept_rate || !dropped_rate).then_some(kept)
}

/// A model the bundled table has dropped since, whose override holds nothing
/// but values that table once had: what an old whole-table save left behind.
fn is_legacy_whole_table_pin(model: &str, fields: &Map<String, Value>) -> bool {
    !fields.is_empty()
        && fields.iter().all(|(field, value)| {
            PRICE_RATE_FIELDS.contains(&field.as_str())
                && is_legacy_bundled_price(model, field, value)
        })
}

/// Whether `overrides` carries a mark only an older version leaves behind
/// (review P2-1): a "待核价" row, a bundled model's rate equal to today's
/// bundled value (the old saves wrote every integral bundled price, `default`
/// 1 / 3 among them, and before 2026-06-13 the whole table), or a model the
/// bundled table has dropped whose override holds nothing but values that
/// table once had. The current format writes none of these, so a file
/// without them is taken as this version's even when its hash record is
/// missing or stale (restored or synced without the state file, or edited by
/// hand) and is left as it is.
fn has_legacy_override_traits(defaults: &Value, overrides: &Map<String, Value>) -> bool {
    let bundled = defaults.as_object();
    overrides.iter().any(|(model, entry)| {
        let Some(fields) = entry.as_object() else {
            return false;
        };
        if price_override_status(entry) == Some("auto_discovered") {
            return true;
        }
        match bundled.and_then(|bundled| bundled.get(model)) {
            Some(bundled_entry) => fields.iter().any(|(field, value)| {
                PRICE_RATE_FIELDS.contains(&field.as_str())
                    && bundled_entry
                        .get(field)
                        .is_some_and(|bundled| price_values_equal(value, bundled))
            }),
            None => is_legacy_whole_table_pin(model, fields),
        }
    })
}

fn price_overrides_digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn recorded_price_overrides_digest(app_dir: &Path) -> Option<String> {
    let bytes = fs::read(app_dir.join(PRICE_OVERRIDES_STATE_FILE)).ok()?;
    let state = serde_json::from_slice::<Value>(&bytes).ok()?;
    if state.get("format").and_then(Value::as_u64) != Some(PRICE_OVERRIDES_FORMAT) {
        return None;
    }
    state
        .get("overrides_sha256")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn record_price_overrides_digest(app_dir: &Path, digest: &str) -> Result<(), String> {
    let state = json!({ "format": PRICE_OVERRIDES_FORMAT, "overrides_sha256": digest });
    write_price_file(
        &app_dir.join(PRICE_OVERRIDES_STATE_FILE),
        state.to_string().as_bytes(),
    )
}

/// Writes through a temporary file in the same directory, an fsync, and a
/// rename onto `path`. The destination changes in one directory update, so a
/// crash, a short write, or a refused rename leaves any existing price file
/// byte for byte. There is no in-place overwrite: that fallback could truncate
/// a good `prices.json` when the disk filled up (R-74).
fn write_price_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    persist_price_bytes(path, bytes, &PriceFilePersist::durable())
}

/// How one price-file write reaches disk. Tests narrow it to simulate a write
/// that stops halfway or a rename the operating system refuses.
struct PriceFilePersist {
    /// Stop after this many bytes of the temporary file, before the rename.
    /// `None` writes the whole payload.
    interrupt_after: Option<usize>,
    rename: fn(&Path, &Path) -> std::io::Result<()>,
}

impl PriceFilePersist {
    fn durable() -> Self {
        Self {
            interrupt_after: None,
            rename: replace_price_file,
        }
    }
}

fn sibling_price_temp(path: &Path) -> PathBuf {
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("prices");
    path.with_file_name(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ))
}

fn create_price_temp(path: &Path) -> std::io::Result<(PathBuf, fs::File)> {
    let mut last_error = None;
    for _ in 0..8 {
        let temp = sibling_price_temp(path);
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "price temp name still taken",
        )
    }))
}

/// Stages `bytes` in a sibling temporary file and renames it onto `path`.
/// Any failure deletes the temporary file and does not open `path` for writing.
fn persist_price_bytes(path: &Path, bytes: &[u8], io: &PriceFilePersist) -> Result<(), String> {
    use std::io::Write as _;

    let (temp, mut file) = create_price_temp(path).map_err(|error| error.to_string())?;
    let staged = (|| -> std::io::Result<()> {
        if let Some(limit) = io.interrupt_after {
            let end = limit.min(bytes.len());
            file.write_all(&bytes[..end])?;
            file.sync_all()?;
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "price file write interrupted",
            ));
        }
        file.write_all(bytes)?;
        file.sync_all()
    })();
    // Drop the handle before the rename. Windows will not replace a file this
    // process still has open, and the same-directory rename is the atomic step.
    drop(file);
    let outcome = staged.and_then(|()| (io.rename)(&temp, path));
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
    }
    outcome.map_err(|error| error.to_string())
}

/// Replaces `to` with `from` in the same directory.
///
/// Windows: `fs::rename`, which is the POSIX-semantics rename
/// (`FileRenameInfoEx` + `REPLACE_IF_EXISTS`) wherever the filesystem offers it.
/// That is exactly what a price file needs, because prices are read on every
/// stats refresh: a reader holding the old `prices.json` open must not be able
/// to refuse the save. A reader keeps its old bytes, the name moves on.
///
/// This used to be `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`, which needs
/// *every* open handle on the target to have granted DELETE, so it fails with
/// `ERROR_ACCESS_DENIED` (5) for as long as anything is reading the file.
/// Measured on Windows 11 / NTFS with one reader opening the file in a loop:
/// 165 of 200 writes refused, against 0 of 200 for `fs::rename` (see the TOKE-10
/// hand-off comment). `cargo test` on the PR branch never saw it because that
/// branch was verified on Linux, where the `#[cfg(windows)]` body does not
/// compile at all.
///
/// Windows builds too old for a POSIX rename fall back inside std to
/// `MoveFileExW`, so a few short retries cover the moment a reader happens to be
/// inside its read. Nothing here may fall back to an in-place write: truncating
/// the live file is the corruption R-74 is about.
///
/// The bytes are fsynced before this point; the rename itself is not
/// write-through, so losing power in the instant after a save can leave the
/// previous `prices.json` in place. That is a whole old file, never a torn one —
/// the same durability the bundled `write_price_file` had on Windows before this
/// branch. If write-through is wanted back, call `MoveFileExW` first and fall
/// back to `fs::rename` only when it is refused.
#[cfg(windows)]
fn replace_price_file(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last_error = None;
    for attempt in 0..5u32 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        // A reader holds the file for microseconds; back off briefly rather than
        // failing a user's save.
        std::thread::sleep(std::time::Duration::from_millis(1u64 << attempt.min(3)));
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("price file replace failed")))
}

#[cfg(not(windows))]
fn replace_price_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)?;
    let parent = to
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::File::open(parent)?.sync_all()
}

/// Stores `overrides` in the current format and records the file's hash. An
/// empty set removes the file, so every model follows the bundled table.
///
/// A hash that cannot be recorded is only a warning (review P2-1): the
/// overrides are already saved, and a file in this format without its record
/// is read as it is (`has_legacy_override_traits`), which records the hash
/// then. Failing here would tell the user the save failed while it did not.
fn store_price_overrides(app_dir: &Path, overrides: &Map<String, Value>) -> Result<(), String> {
    if overrides.is_empty() {
        return remove_price_overrides(app_dir);
    }
    let content = serde_json::to_string_pretty(overrides).map_err(|error| error.to_string())?;
    write_price_file(&app_dir.join(PRICE_OVERRIDES_FILE), content.as_bytes())?;
    if let Err(error) =
        record_price_overrides_digest(app_dir, &price_overrides_digest(content.as_bytes()))
    {
        log::warn!("price overrides saved, but their state record was not: {error}");
    }
    Ok(())
}

fn remove_price_overrides(app_dir: &Path) -> Result<(), String> {
    match fs::remove_file(app_dir.join(PRICE_OVERRIDES_FILE)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let _ = fs::remove_file(app_dir.join(PRICE_OVERRIDES_STATE_FILE));
    #[cfg(not(windows))]
    fs::File::open(app_dir)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn lock_price_overrides() -> std::sync::MutexGuard<'static, ()> {
    PRICE_OVERRIDES_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn load_saved_prices(app: &AppContext) -> Value {
    let (prices, read) = {
        let _guard = lock_price_overrides();
        let recovery = price_repricing::recover(app);
        if let Some(warning) = recovery.warning {
            log::warn!("{warning}");
        }
        load_saved_prices_locked(app)
    };
    if read.stale {
        // Stats cached with the prices from before the migration are stale
        // (review P3-3). Dropped outside the lock: stats code loads prices.
        cache::invalidate_all(&db::get_db_path(app));
    }
    prices
}

/// `load_saved_prices` for callers that already hold `PRICE_OVERRIDES_LOCK`.
/// Also says what the read found (`PriceOverridesRead`): after a migration
/// the caller drops cached stats once the lock is released.
fn load_saved_prices_locked(app: &AppContext) -> (Value, PriceOverridesRead) {
    let defaults = price_feed::effective_defaults(app.app_data_dir());
    let (overrides, read) = read_price_overrides(app.app_data_dir(), &defaults);
    let prices = match overrides {
        Some(overrides) => apply_price_overrides(&defaults, &overrides),
        None => defaults,
    };
    (prices, read)
}

/// What a read of the override file found besides the overrides.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct PriceOverridesRead {
    /// The read migrated the overrides to something else, so stats cached
    /// with the old prices are stale.
    stale: bool,
    /// The file needs the migration, but its original could not be backed
    /// up: it is priced as it is and left byte for byte, and saving or
    /// resetting prices is refused until a later start manages the backup
    /// (T10.189 review P3-3, T10.202).
    migration_postponed: bool,
}

/// The override files whose migration this run postponed because their
/// original could not be backed up, by app data directory and SHA-256. The
/// next start tries again. Retrying within the run could switch the prices,
/// and the table open in the settings editor, to the migrated ones midway.
static POSTPONED_PRICE_MIGRATIONS: Mutex<Vec<(PathBuf, String)>> = Mutex::new(Vec::new());

fn postponed_price_migrations() -> std::sync::MutexGuard<'static, Vec<(PathBuf, String)>> {
    POSTPONED_PRICE_MIGRATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Set once a failure to save the migration, the state record or the
/// migration notice has been logged: prices load on every stats query, and
/// the failure repeats.
static PRICE_OVERRIDES_MIGRATION_UNSAVED: AtomicBool = AtomicBool::new(false);
static PRICE_OVERRIDES_STATE_UNSAVED: AtomicBool = AtomicBool::new(false);
static PRICE_MIGRATION_NOTICE_UNSAVED: AtomicBool = AtomicBool::new(false);

/// Reads the override file. A file an older version wrote is migrated first;
/// the first price load after launch (the background scan) runs it, so this
/// is the startup migration. Unreadable or malformed files are ignored.
///
/// `stale` says whether this read migrated the overrides to something else.
/// When the migrated overrides cannot be stored, the migration runs again in
/// memory on every read; that counts once per run, like its warning. When
/// the original cannot be backed up, nothing is migrated: the file is read
/// as it is until the next start (`migration_postponed`). A migration that
/// took prices out also leaves a notice for the settings page (T10.189).
fn read_price_overrides(
    app_dir: &Path,
    defaults: &Value,
) -> (Option<Map<String, Value>>, PriceOverridesRead) {
    let Ok(bytes) = fs::read(app_dir.join(PRICE_OVERRIDES_FILE)) else {
        return (None, PriceOverridesRead::default());
    };
    let Ok(Value::Object(overrides)) = serde_json::from_slice::<Value>(&bytes) else {
        return (None, PriceOverridesRead::default());
    };
    let digest = price_overrides_digest(&bytes);
    if recorded_price_overrides_digest(app_dir).as_deref() == Some(digest.as_str()) {
        return (Some(overrides), PriceOverridesRead::default());
    }
    if !has_legacy_override_traits(defaults, &overrides) {
        // This format wrote it, but the hash record is missing or stale:
        // restored or synced without the state file, or edited by hand.
        // Every value in it is the user's, so it is only re-recorded.
        if let Err(error) = record_price_overrides_digest(app_dir, &digest) {
            if !PRICE_OVERRIDES_STATE_UNSAVED.swap(true, Ordering::Relaxed) {
                log::warn!("price override state was not recorded: {error}");
            }
        }
        return (Some(overrides), PriceOverridesRead::default());
    }
    let postponed = PriceOverridesRead {
        stale: false,
        migration_postponed: true,
    };
    if postponed_price_migrations()
        .iter()
        .any(|(dir, file_digest)| dir == app_dir && *file_digest == digest)
    {
        return (Some(overrides), postponed);
    }
    let migrated = migrate_legacy_price_overrides(defaults, &overrides);
    let stale =
        match persist_price_override_migration(app_dir, &bytes, &digest, &overrides, &migrated) {
            Ok(None) => false,
            Ok(Some(backup_file)) => {
                record_price_migration_notice(
                    app_dir,
                    defaults,
                    &overrides,
                    &migrated,
                    &digest,
                    &backup_file,
                );
                true
            }
            Err(PriceMigrationNotSaved::StateNotRecorded(error)) => {
                // Nothing was migrated after all: only the hash record is
                // missing, as in the branch above (review P3-c).
                if !PRICE_OVERRIDES_STATE_UNSAVED.swap(true, Ordering::Relaxed) {
                    log::warn!("price override state was not recorded: {error}");
                }
                false
            }
            Err(unsaved @ PriceMigrationNotSaved::NoBackup(_)) => {
                // Without a backup the migrated prices must not apply: a
                // save would store them over the original, and its values
                // would be gone (T10.189 review P3-3). Warned once per file.
                log::warn!("price override migration postponed to the next start: {unsaved}");
                postponed_price_migrations().push((app_dir.to_path_buf(), digest));
                return (Some(overrides), postponed);
            }
            Err(unsaved) => {
                if let PriceMigrationNotSaved::NotStored { backup_file, .. } = &unsaved {
                    // Prices load migrated and the backup is there, so the
                    // settings page tells the user all the same.
                    record_price_migration_notice(
                        app_dir,
                        defaults,
                        &overrides,
                        &migrated,
                        &digest,
                        backup_file,
                    );
                }
                // Prices still load migrated; the file is migrated again next time.
                let first = !PRICE_OVERRIDES_MIGRATION_UNSAVED.swap(true, Ordering::Relaxed);
                if first {
                    log::warn!("price override migration was not saved: {unsaved}");
                }
                first
            }
        };
    (
        (!migrated.is_empty()).then_some(migrated),
        PriceOverridesRead {
            stale,
            migration_postponed: false,
        },
    )
}

/// Why `persist_price_override_migration` saved no migration.
#[derive(Debug)]
enum PriceMigrationNotSaved {
    /// The migration changed nothing and only the file's hash record could
    /// not be written: no migration is lost (review P3-c).
    StateNotRecorded(String),
    /// No backup could be written, so the file was left as it was.
    NoBackup(String),
    /// The backup is kept, but the migrated overrides could not be stored.
    NotStored { backup_file: String, error: String },
}

impl std::fmt::Display for PriceMigrationNotSaved {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StateNotRecorded(error) => {
                write!(formatter, "the state record was not written: {error}")
            }
            Self::NoBackup(error) => {
                write!(formatter, "the original could not be backed up: {error}")
            }
            Self::NotStored { backup_file, error } => write!(
                formatter,
                "the original is kept as {backup_file}, but the migration was not stored: {error}"
            ),
        }
    }
}

/// Saves a migration: the original file is first kept as a backup
/// (`write_legacy_price_backup`), then the migrated overrides are stored.
/// Returns the backup's name, or `None` when the migration left the file as
/// it was and only its hash was recorded.
fn persist_price_override_migration(
    app_dir: &Path,
    original_bytes: &[u8],
    digest: &str,
    original: &Map<String, Value>,
    migrated: &Map<String, Value>,
) -> Result<Option<String>, PriceMigrationNotSaved> {
    if migrated == original {
        return record_price_overrides_digest(app_dir, digest)
            .map(|()| None)
            .map_err(PriceMigrationNotSaved::StateNotRecorded);
    }
    let backup_file = write_legacy_price_backup(app_dir, original_bytes, digest)
        .map_err(PriceMigrationNotSaved::NoBackup)?;
    if let Err(error) = store_price_overrides(app_dir, migrated) {
        return Err(PriceMigrationNotSaved::NotStored { backup_file, error });
    }
    log::info!(
        "migrated legacy price overrides: kept {} of {} models, original kept as {backup_file}",
        migrated.len(),
        original.len()
    );
    Ok(Some(backup_file))
}

/// Keeps the file an older version wrote as
/// `prices.legacy-backup-<first 12 hex of its SHA-256>.json`, once per
/// content. A file of that name with other content (cut short by an earlier
/// crash, say) is left alone and the backup gets a `-2`, `-3`… suffix
/// instead (review P3-2). Returns the backup's file name.
fn write_legacy_price_backup(app_dir: &Path, bytes: &[u8], digest: &str) -> Result<String, String> {
    let stem = format!("prices.legacy-backup-{}", &digest[..12]);
    for attempt in 1..=100 {
        let name = if attempt == 1 {
            format!("{stem}.json")
        } else {
            format!("{stem}-{attempt}.json")
        };
        let path = app_dir.join(&name);
        match fs::read(&path) {
            Ok(existing) if price_overrides_digest(&existing) == digest => return Ok(name),
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                write_price_file(&path, bytes)?;
                return Ok(name);
            }
            Err(error) => return Err(format!("{name}: {error}")),
        }
    }
    Err(format!("no free name for the price override backup {stem}"))
}

// ---- Migration notice for the settings page (T10.189, U-5 and U-6) ----
//
// A migration that takes prices out of the override file leaves one notice:
// how many models and prices it cleared, which of them are now priced
// differently, and where the backup is. The settings page shows it until the
// user dismisses it; a dismissed migration never shows again, a later one
// does. None of this changes which prices apply.

/// A price a migration took out whose rate is now different. `current` is
/// the rate the model is priced at from now on (`effective_price_rate`);
/// `None` when the model has no price of its own any more and is priced by
/// its tool's fallback, which depends on the tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceMigrationChange {
    pub model: String,
    pub field: String,
    pub previous: f64,
    pub current: Option<f64>,
}

/// The rate fields a migration took out for one model; `whole_model` when
/// the model left the override file altogether.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceMigrationClearedModel {
    pub model: String,
    pub fields: Vec<String>,
    pub whole_model: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceMigrationNotice {
    /// SHA-256 of the file the migration read. A file always migrates the
    /// same way, so this names the migration: the same file read again (a
    /// migration that cannot be saved runs on every read) is the same
    /// migration, and one dismissal covers it.
    pub id: String,
    /// When the migration first ran, RFC 3339 in UTC.
    pub migrated_at: String,
    /// The original file's backup in the app data directory.
    pub backup_file: String,
    pub models_cleared: usize,
    pub fields_cleared: usize,
    pub cleared: Vec<PriceMigrationClearedModel>,
    /// The cleared prices whose rate is now different; every other cleared
    /// price equals the rate that applies now.
    pub changed: Vec<PriceMigrationChange>,
}

/// What `get_price_migration_notice` returns: the notice, and the directory
/// that holds the backup as this device names it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceMigrationNoticeView {
    #[serde(flatten)]
    pub notice: PriceMigrationNotice,
    pub backup_dir: String,
}

/// `PRICE_MIGRATION_NOTICE_FILE`: the last migration's notice and the ids of
/// the notices the user dismissed.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriceMigrationNoticeRecord {
    #[serde(default)]
    format: u64,
    #[serde(default)]
    notice: Option<PriceMigrationNotice>,
    #[serde(default)]
    dismissed_ids: Vec<String>,
}

/// The rate `estimate_cost_with_price` charges per million tokens of `field`
/// with `entry`, its defaults included.
fn effective_price_rate(entry: &Value, field: &str) -> Option<f64> {
    const MILLION: i64 = 1_000_000;
    let [input, output, cache_read, cache_write] = match field {
        "input" => [MILLION, 0, 0, 0],
        "output" => [0, MILLION, 0, 0],
        "cache_input" => [0, 0, MILLION, 0],
        "cache_write" => [0, 0, 0, MILLION],
        _ => return None,
    };
    Some(estimate_cost_with_price(
        entry,
        input,
        output,
        cache_read,
        cache_write,
    ))
}

/// The price entry `model` is priced with once a migration is in effect
/// (`after` is the table with the migrated overrides applied): its own row,
/// else the row its name matches, else, for a model auto-discovery found,
/// the estimate from its tool fallback as `merge_discovered_prices` gives it.
/// `None` when none applies: the model is priced by its tool's fallback.
fn price_after_migration(after: &Value, model: &str, legacy_entry: &Value) -> Option<Value> {
    if let Some(entry) = after.get(model) {
        return Some(entry.clone());
    }
    if let Some((_, entry)) = matching_model_price(after, model) {
        return Some(entry.clone());
    }
    is_discovered_price_override(legacy_entry).then(|| {
        Value::Object(discovered_fallback_rates(
            after,
            &price_override_fallback_key(legacy_entry),
        ))
    })
}

/// Per model, the prices the migration from `legacy` to `migrated` took out,
/// and those of them whose rate is now different. A rate field whose value
/// is not a number was no price: it goes with its row but counts as neither,
/// so 「其余 K 项」 on the settings page counts prices only (T10.189 review
/// P3-5 b).
fn cleared_price_fields(
    defaults: &Value,
    legacy: &Map<String, Value>,
    migrated: &Map<String, Value>,
) -> (Vec<PriceMigrationClearedModel>, Vec<PriceMigrationChange>) {
    let after = apply_price_overrides(defaults, migrated);
    let mut cleared = Vec::new();
    let mut changed = Vec::new();
    for (model, entry) in legacy {
        let Some(fields) = entry.as_object() else {
            continue;
        };
        let kept = migrated.get(model).and_then(Value::as_object);
        let removed: Vec<(&str, f64)> = PRICE_RATE_FIELDS
            .iter()
            .copied()
            .filter(|field| !kept.is_some_and(|kept| kept.contains_key(*field)))
            .filter_map(|field| Some((field, fields.get(field)?.as_f64()?)))
            .collect();
        if removed.is_empty() {
            continue;
        }
        let now = price_after_migration(&after, model, entry);
        for &(field, previous) in &removed {
            let current = now
                .as_ref()
                .and_then(|entry| effective_price_rate(entry, field));
            if !current.is_some_and(|current| price_numbers_equal(previous, current)) {
                changed.push(PriceMigrationChange {
                    model: model.clone(),
                    field: field.to_string(),
                    previous,
                    current,
                });
            }
        }
        cleared.push(PriceMigrationClearedModel {
            model: model.clone(),
            fields: removed.iter().map(|(field, _)| field.to_string()).collect(),
            whole_model: kept.is_none(),
        });
    }
    cleared.sort_by(|left, right| left.model.cmp(&right.model));
    changed.sort_by(|left, right| left.model.cmp(&right.model));
    (cleared, changed)
}

/// The notice the migration from `legacy` to `migrated` leaves, or `None`
/// when it took out no price.
fn price_migration_notice(
    defaults: &Value,
    legacy: &Map<String, Value>,
    migrated: &Map<String, Value>,
    id: &str,
    backup_file: &str,
    migrated_at: &str,
) -> Option<PriceMigrationNotice> {
    let (cleared, changed) = cleared_price_fields(defaults, legacy, migrated);
    let fields_cleared = cleared.iter().map(|model| model.fields.len()).sum();
    (fields_cleared > 0).then(|| PriceMigrationNotice {
        id: id.to_string(),
        migrated_at: migrated_at.to_string(),
        backup_file: backup_file.to_string(),
        models_cleared: cleared.len(),
        fields_cleared,
        cleared,
        changed,
    })
}

/// The notice record, or an empty one when it is missing, unreadable or of
/// another format.
fn read_price_migration_notice_record(app_dir: &Path) -> PriceMigrationNoticeRecord {
    fs::read(app_dir.join(PRICE_MIGRATION_NOTICE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PriceMigrationNoticeRecord>(&bytes).ok())
        .filter(|record| record.format == PRICE_MIGRATION_NOTICE_FORMAT)
        .unwrap_or_default()
}

fn write_price_migration_notice_record(
    app_dir: &Path,
    record: &mut PriceMigrationNoticeRecord,
) -> Result<(), String> {
    record.format = PRICE_MIGRATION_NOTICE_FORMAT;
    let content = serde_json::to_string_pretty(record).map_err(|error| error.to_string())?;
    write_price_file(
        &app_dir.join(PRICE_MIGRATION_NOTICE_FILE),
        content.as_bytes(),
    )
}

/// Keeps the notice of the migration of the file with SHA-256 `digest` for
/// the settings page, when it took out any price. The same migration run
/// again (one that cannot be saved runs on every read) leaves the record as
/// it is, so its time and a dismissal stay. A failure only logs a warning
/// with the counts: the prices load all the same.
fn record_price_migration_notice(
    app_dir: &Path,
    defaults: &Value,
    legacy: &Map<String, Value>,
    migrated: &Map<String, Value>,
    digest: &str,
    backup_file: &str,
) {
    let mut record = read_price_migration_notice_record(app_dir);
    if record
        .notice
        .as_ref()
        .is_some_and(|notice| notice.id == digest)
    {
        return;
    }
    let migrated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let Some(notice) = price_migration_notice(
        defaults,
        legacy,
        migrated,
        digest,
        backup_file,
        &migrated_at,
    ) else {
        return;
    };
    let (models, fields) = (notice.models_cleared, notice.fields_cleared);
    record.notice = Some(notice);
    if let Err(error) = write_price_migration_notice_record(app_dir, &mut record) {
        if !PRICE_MIGRATION_NOTICE_UNSAVED.swap(true, Ordering::Relaxed) {
            log::warn!(
                "price migration notice was not recorded ({models} models, {fields} prices cleared): {error}"
            );
        }
    }
}

/// The last migration's notice unless the user dismissed it. A migration no
/// price read has run yet runs first, so the notice never lags behind the
/// prices.
pub fn get_price_migration_notice_impl(
    app: &AppContext,
) -> Result<Option<PriceMigrationNoticeView>, String> {
    load_saved_prices(app);
    let _guard = lock_price_overrides();
    let app_dir = app.app_data_dir();
    let record = read_price_migration_notice_record(app_dir);
    Ok(record
        .notice
        .filter(|notice| !record.dismissed_ids.contains(&notice.id))
        .map(|notice| PriceMigrationNoticeView {
            notice,
            backup_dir: app_dir.to_string_lossy().into_owned(),
        }))
}

/// Dismisses the notice of migration `id` for good. The last
/// `PRICE_MIGRATION_DISMISSED_LIMIT` ids are kept.
pub fn dismiss_price_migration_notice_impl(app: &AppContext, id: &str) -> Result<(), String> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("价格整理提示的编号无效".to_string());
    }
    let _guard = lock_price_overrides();
    let app_dir = app.app_data_dir();
    let mut record = read_price_migration_notice_record(app_dir);
    if record.dismissed_ids.iter().any(|dismissed| dismissed == id) {
        return Ok(());
    }
    record.dismissed_ids.push(id.to_string());
    let overflow = record
        .dismissed_ids
        .len()
        .saturating_sub(PRICE_MIGRATION_DISMISSED_LIMIT);
    record.dismissed_ids.drain(..overflow);
    write_price_migration_notice_record(app_dir, &mut record)
}

#[derive(Debug)]
struct DiscoveredModelPrice {
    tool: String,
    model_key: String,
    model: String,
    tools: Vec<String>,
    first_seen_at: String,
    last_seen_at: String,
}

fn load_discovered_model_prices(app: &AppContext) -> Vec<DiscoveredModelPrice> {
    let db_path = db::get_db_path(app);
    if !db_path.exists() {
        return Vec::new();
    }
    let Ok(conn) = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT MIN(tool), model_key, MIN(model),
                GROUP_CONCAT(DISTINCT tool), MIN(first_seen_at), MAX(last_seen_at)
         FROM discovered_models
         GROUP BY model_key
         ORDER BY MIN(first_seen_at), model_key",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| {
        let tools: String = row.get(3)?;
        Ok(DiscoveredModelPrice {
            tool: row.get(0)?,
            model_key: row.get(1)?,
            model: row.get(2)?,
            tools: tools.split(',').map(str::to_string).collect(),
            first_seen_at: row.get(4)?,
            last_seen_at: row.get(5)?,
        })
    }) else {
        return Vec::new();
    };

    rows.filter_map(Result::ok).collect()
}

fn is_snapshot_suffix(suffix: &str) -> bool {
    let s = suffix.trim().to_ascii_lowercase();
    if s == "latest" || s.starts_with("snapshot") {
        return true;
    }
    // Check YYYY-MM-DD (e.g. 2026-07-09, 2024-08-06)
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() == 3
        && parts[0].len() == 4
        && parts[0].chars().all(|c| c.is_ascii_digit())
        && parts[1].len() == 2
        && parts[1].chars().all(|c| c.is_ascii_digit())
        && parts[2].len() == 2
        && parts[2].chars().all(|c| c.is_ascii_digit())
    {
        return true;
    }
    // Check YYYYMMDD (8 digits) or MMDD (4 digits)
    if (s.len() == 8 || s.len() == 4) && s.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    // Check e.g. YYYYMMDD-vX or YYYY-MM-DD-vX
    if let Some((date_part, ver_part)) = s.rsplit_once('-') {
        if ver_part.starts_with('v')
            && !ver_part[1..].is_empty()
            && ver_part[1..].chars().all(|c| c.is_ascii_digit())
        {
            return is_snapshot_suffix(date_part);
        }
    }
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MatchQuality {
    Snapshot = 1,
    PathStripped = 2,
    Exact = 3,
}

fn evaluate_model_match(raw_model: &str, key: &str) -> Option<MatchQuality> {
    let clean_raw = raw_model.trim().to_ascii_lowercase();
    let clean_key = key.trim().to_ascii_lowercase();
    if clean_raw.is_empty() || clean_key.is_empty() || clean_key == "default" {
        return None;
    }

    if clean_raw == clean_key {
        return Some(MatchQuality::Exact);
    }

    let stripped_raw = crate::scanner::clean_model_name(&clean_raw).to_ascii_lowercase();
    if stripped_raw != clean_raw && stripped_raw == clean_key {
        return Some(MatchQuality::PathStripped);
    }

    for candidate_base in [&clean_raw, &stripped_raw] {
        if let Some(remainder) = candidate_base.strip_prefix(&clean_key) {
            if let Some(first_char) = remainder.chars().next() {
                if matches!(first_char, '-' | ':' | '@') {
                    let suffix = &remainder[first_char.len_utf8()..];
                    if is_snapshot_suffix(suffix) {
                        return Some(MatchQuality::Snapshot);
                    }
                }
            }
        }
    }

    None
}

fn matching_model_price<'a>(prices: &'a Value, model: &str) -> Option<(&'a str, &'a Value)> {
    prices.as_object().and_then(|obj| {
        obj.iter()
            .filter_map(|(key, value)| {
                evaluate_model_match(model, key)
                    .map(|quality| (quality, key.len(), key.as_str(), value))
            })
            // Ties go to the greatest key, independent of the table's key order.
            .max_by_key(|(quality, len, key, _)| (*quality, *len, *key))
            .map(|(_, _, key, value)| (key, value))
    })
}

fn tool_fallback_price_key(tool: &str) -> &'static str {
    match tool.to_lowercase().as_str() {
        "claude" => "claude-unknown",
        "codex" => "codex-agent",
        "antigravity" => "gemini-3.5-flash-agent",
        "minimax" | "marvis" | "trae" | "opencode" | "kilo" => "minimax-model",
        "reasonix" => "reasonix-agent",
        "deepseek" => "deepseek",
        "kimi" | "kimidesktop" => "kimi-k2.6",
        "grok" => "grok-4.3",
        "gemini" => "gemini-3.5-flash",
        // Pi is a multi-provider harness: a discovered model can belong to any
        // vendor, so the honest fallback is the generic default price, not a
        // specific model from one provider.
        "pi" => "default",
        _ => "default",
    }
}

fn materialize_discovered_price(
    fallback: &Value,
    fallback_key: &str,
    discovered: &DiscoveredModelPrice,
) -> Value {
    let input = fallback.get("input").and_then(Value::as_f64).unwrap_or(1.0);
    let output = fallback
        .get("output")
        .and_then(Value::as_f64)
        .unwrap_or(3.0);
    let cache_input = fallback
        .get("cache_input")
        .and_then(Value::as_f64)
        .unwrap_or(input * 0.1);
    let default_cache_write = if fallback_key.starts_with("claude") {
        input * 1.25
    } else {
        input
    };
    let cache_write = fallback
        .get("cache_write")
        .and_then(Value::as_f64)
        .unwrap_or(default_cache_write);

    json!({
        "input": input,
        "output": output,
        "cache_input": cache_input,
        "cache_write": cache_write,
        "_meta": {
            "status": "auto_discovered",
            "price_source": "tool_fallback",
            "fallback_key": fallback_key,
            "observed_model": discovered.model,
            "tools": discovered.tools,
            "first_seen_at": discovered.first_seen_at,
            "last_seen_at": discovered.last_seen_at
        }
    })
}

fn merge_discovered_prices(mut prices: Value, discovered: &[DiscoveredModelPrice]) -> Value {
    // Resolve every candidate against the same pre-discovery snapshot. This
    // prevents a newly added short key such as `model-1` from suppressing a
    // distinct `model-10` discovered in the same scan.
    let explicit_prices = prices.clone();
    let Some(price_obj) = prices.as_object_mut() else {
        return prices;
    };

    for entry in discovered {
        if scanner::model_discovery_key(&entry.model).as_deref() != Some(entry.model_key.as_str())
            || matching_model_price(&explicit_prices, &entry.model).is_some()
        {
            continue;
        }
        let fallback_key = tool_fallback_price_key(&entry.tool);
        let fallback = explicit_prices
            .get(fallback_key)
            .or_else(|| explicit_prices.get("default"))
            .unwrap_or(&Value::Null);
        price_obj.insert(
            entry.model_key.clone(),
            materialize_discovered_price(fallback, fallback_key, entry),
        );
    }

    prices
}

fn load_prices(app: &AppContext) -> Value {
    let prices = load_saved_prices(app);
    let discovered = load_discovered_model_prices(app);
    merge_discovered_prices(prices, &discovered)
}

pub(crate) fn auto_discovered_price_keys(app: &AppContext) -> HashSet<String> {
    load_prices(app)
        .as_object()
        .into_iter()
        .flat_map(|prices| prices.iter())
        .filter(|(_, config)| {
            config.pointer("/_meta/status").and_then(Value::as_str) == Some("auto_discovered")
        })
        .map(|(model, _)| model.clone())
        .collect()
}

/// Longest-substring model match against the price table, with per-tool
/// fallback keys when no model key matches.
fn lookup_model_prices<'a>(prices: &'a Value, tool: &str, model: &str) -> &'a Value {
    lookup_model_price_with_source(prices, tool, model).0
}

/// 单价从哪里来（T10.162 方案 §3.1「兜底计数」，T10.183）。只有 `Listed` 算列价；
/// 其余来源（以及列价条目里缺省的字段）都算兜底，缓存节省据此统计兜底读写量。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PriceSource {
    /// 按型号命中价格表的显式条目，含用户覆盖与用户改过的自动发现项
    /// （`_meta.status` 不再是 `auto_discovered`）。
    Listed,
    /// 按型号命中自动发现的「待核价」条目，单价抄自某个工具的兜底键。
    AutoDiscovered,
    /// 型号未命中，按调用工具的兜底键计价。
    ToolFallback,
    /// 型号与工具兜底键都未命中，按 `default` 计价。
    Default,
    /// 价格表里连 `default` 都没有，单价全部取内置缺省。
    Missing,
}

/// `lookup_model_prices` 的同一解析顺序，另外给出价格来源。
fn lookup_model_price_with_source<'a>(
    prices: &'a Value,
    tool: &str,
    model: &str,
) -> (&'a Value, PriceSource) {
    if let Some((_, value)) = matching_model_price(prices, model) {
        let source =
            if value.pointer("/_meta/status").and_then(Value::as_str) == Some("auto_discovered") {
                PriceSource::AutoDiscovered
            } else {
                PriceSource::Listed
            };
        return (value, source);
    }
    let fallback_key = tool_fallback_price_key(tool);
    if let Some(value) = prices.get(fallback_key) {
        let source = if fallback_key == "default" {
            PriceSource::Default
        } else {
            PriceSource::ToolFallback
        };
        return (value, source);
    }
    match prices.get("default") {
        Some(value) => (value, PriceSource::Default),
        None => (&Value::Null, PriceSource::Missing),
    }
}

/// Cache reads and writes are priced separately: reads at `cache_input`
/// (fallback 0.1x input, the common read multiplier), writes at `cache_write`
/// (fallback 1.25x input, the common 5-minute-TTL write multiplier).
/// Legacy rows that predate the cache_write_tokens column pass write=0 and
/// are priced as pure reads, matching the old behaviour. This flat form
/// ignores old-price segments and tiers, so only tests use it; app code prices
/// a record with `estimate_cost_at`.
#[cfg(test)]
fn estimate_cost(
    prices: &Value,
    tool: &str,
    model: &str,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
) -> f64 {
    estimate_cost_with_price(
        lookup_model_prices(prices, tool, model),
        input,
        output,
        cache_read,
        cache_write,
    )
}

/// `estimate_cost` for one ledger record: the price in effect at `timestamp`
/// (`history`) and, for per-request tools, the long-context tier its prompt
/// falls in (`tiers`); see `price_schedule`.
#[allow(clippy::too_many_arguments)]
fn estimate_cost_at(
    prices: &Value,
    tool: &str,
    model: &str,
    timestamp: &str,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
) -> f64 {
    let entry = price_schedule::entry_for_record(
        lookup_model_prices(prices, tool, model),
        tool,
        timestamp,
        prompt_tokens(input, cache_read, cache_write),
    );
    estimate_cost_with_price(&entry, input, output, cache_read, cache_write)
}

/// The prompt length a long-context tier is judged by: fresh input plus
/// cache reads and writes, negative counts ignored.
fn prompt_tokens(input: i64, cache_read: i64, cache_write: i64) -> i64 {
    input
        .max(0)
        .saturating_add(cache_read.max(0))
        .saturating_add(cache_write.max(0))
}

/// `estimate_cost` for a price entry already resolved by `lookup_model_prices`.
/// The lookup depends only on the table, the tool and the model, so a caller
/// pricing many rows can resolve each (tool, model) once and still get the
/// same result bit for bit.
fn estimate_cost_with_price(
    p: &Value,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
) -> f64 {
    let p_input = p.get("input").and_then(|v| v.as_f64()).unwrap_or(1.0);
    let p_output = p.get("output").and_then(|v| v.as_f64()).unwrap_or(3.0);

    // Scanners normalize inclusive provider inputs (Zcode included since
    // schema v10) before storage: input contains only fresh tokens and cache
    // volume is carried separately.
    let read_price = p
        .get("cache_input")
        .and_then(|v| v.as_f64())
        .unwrap_or(p_input * 0.1);
    let write_price = p
        .get("cache_write")
        .and_then(|v| v.as_f64())
        .unwrap_or(p_input * 1.25);
    let input_cost = (input as f64 / 1_000_000.0) * p_input;
    let cached_cost = (cache_read as f64 / 1_000_000.0) * read_price
        + (cache_write as f64 / 1_000_000.0) * write_price;

    input_cost + (output as f64 / 1_000_000.0) * p_output + cached_cost
}

/// API-equivalent money saved by cache hits: what the read volume would have
/// cost as fresh input, minus what it actually costs at the read price.
///
/// T10.183 起只保留给测试：这是 T10.183 之前的毛值公式原文，`stats_perf_oracle`
/// 与逐位测试用它确认 `cacheSavedUsd`（缓存读取节省）逐位不变；生产路径改用
/// `estimate_cache_savings_parts` 与 `PriceRates::cache_parts`。
#[cfg(test)]
fn estimate_cache_savings(prices: &Value, tool: &str, model: &str, cache_read: i64) -> f64 {
    if cache_read <= 0 {
        return 0.0;
    }
    let p = lookup_model_prices(prices, tool, model);
    let p_input = p.get("input").and_then(|v| v.as_f64()).unwrap_or(1.0);
    let read_price = p
        .get("cache_input")
        .and_then(|v| v.as_f64())
        .unwrap_or(p_input * 0.1);
    ((cache_read as f64) / 1_000_000.0) * (p_input - read_price).max(0.0)
}

/// 缓存节省分量的逐行参考实现（T10.162 方案 §3.1，契约 dashboard-stats-v2 §2.4）：
///
/// - 缓存读取节省 = 读取量 × max(输入价 − 缓存读价, 0)，缺读价按输入价 × 0.1；
/// - 缓存写入溢价 = 写入量 × max(缓存写价 − 输入价, 0)，缺写价按输入价 × 1.25
///   （与预估费用同一兜底，用户决定 Q4）；
/// - 单价不是列价（见 `PriceSource`）的读取量、写入量分别计入兜底计数。
///
/// 单价解析与兜底和 `estimate_cost` 相同；`PriceRates::cache_parts` 是同一公式的按
/// (工具, 模型) 缓存版本，二者由 `price_memo_matches_per_row_estimates_bit_for_bit`
/// 逐位对照（T10.167 评审 F2：改公式须两处同改）。
fn estimate_cache_savings_parts(
    prices: &Value,
    tool: &str,
    model: &str,
    cache_read: i64,
    cache_write: i64,
) -> CacheSavingsParts {
    let (p, source) = lookup_model_price_with_source(prices, tool, model);
    let listed_input = p.get("input").and_then(|v| v.as_f64());
    let p_input = listed_input.unwrap_or(1.0);
    let listed_read_price = p.get("cache_input").and_then(|v| v.as_f64());
    let listed_write_price = p.get("cache_write").and_then(|v| v.as_f64());
    let listed_entry = source == PriceSource::Listed && listed_input.is_some();
    let mut parts = CacheSavingsParts::default();
    if cache_read > 0 {
        let read_price = listed_read_price.unwrap_or(p_input * 0.1);
        parts.read_saved = ((cache_read as f64) / 1_000_000.0) * (p_input - read_price).max(0.0);
        if !(listed_entry && listed_read_price.is_some()) {
            parts.fallback_read_tokens = cache_read;
        }
    }
    if cache_write > 0 {
        let write_price = listed_write_price.unwrap_or(p_input * 1.25);
        parts.write_premium =
            ((cache_write as f64) / 1_000_000.0) * (write_price - p_input).max(0.0);
        if !(listed_entry && listed_write_price.is_some()) {
            parts.fallback_write_tokens = cache_write;
        }
    }
    parts
}

#[cfg(test)]
mod price_override_tests;

#[cfg(test)]
mod price_override_dry_run;

#[cfg(test)]
mod estimate_cost_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static PRICE_TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn assert_roughly_eq(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 0.000001,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn price_overrides_are_merged_over_new_defaults() {
        let defaults = json!({
            "claude-fable-5": { "input": 10.0, "output": 50.0, "cache_input": 1.0, "cache_write": 12.5 },
            "new-model": { "input": 2.0, "output": 8.0 },
            "default": { "input": 1.0, "output": 3.0 }
        });
        let legacy_saved_defaults = json!({
            "claude-fable-5": { "input": 10.0, "output": 50.0 }
        });

        let merged = merge_price_overrides(&defaults, &legacy_saved_defaults);

        assert_eq!(merged["claude-fable-5"]["input"], json!(10.0));
        assert_eq!(merged["claude-fable-5"]["cache_input"], json!(1.0));
        assert_eq!(merged["claude-fable-5"]["cache_write"], json!(12.5));
        assert_eq!(merged["new-model"]["input"], json!(2.0));
    }

    #[test]
    fn unchanged_default_prices_do_not_create_overrides() {
        let defaults = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "model": { "input": 2.0, "output": 8.0 }
        });

        assert_eq!(
            price_overrides_from_edit(&defaults, &defaults, &defaults),
            Ok(Map::new())
        );
        // The editor sends integral prices back as JSON integers.
        let resent = json!({
            "default": { "input": 1, "output": 3 },
            "model": { "input": 2, "output": 8 }
        });
        assert_eq!(
            price_overrides_from_edit(&defaults, &defaults, &resent),
            Ok(Map::new())
        );

        let edited = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "model": { "input": 2.25, "output": 8.0 }
        });
        assert_eq!(
            price_overrides_from_edit(&defaults, &defaults, &edited).map(Value::Object),
            Ok(json!({ "model": { "input": 2.25 } }))
        );
    }

    #[test]
    fn uses_longest_matching_model_key() {
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "gpt-4.1": { "input": 2.0, "output": 8.0, "cache_input": 0.5 },
            "gpt-4.1-mini": { "input": 0.4, "output": 1.6, "cache_input": 0.1 },
            "mimo-v2.5": { "input": 0.78, "output": 3.89, "cache_input": 0.16 },
            "mimo-v2.5-pro": { "input": 1.94, "output": 5.83, "cache_input": 0.39 }
        });

        assert_roughly_eq(
            estimate_cost(
                &prices,
                "other",
                "gpt-4.1-mini",
                1_000_000,
                1_000_000,
                1_000_000,
                0,
            ),
            2.1,
        );
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "other",
                "mimo-v2.5-pro",
                1_000_000,
                1_000_000,
                1_000_000,
                0,
            ),
            8.16,
        );
    }

    #[test]
    fn bundled_prices_cover_recent_frontier_models() {
        let prices = default_prices();

        // GPT-5.6 于 2026-07-30（Terra/Luna）与 2026-08-21（Sol）降价，T10.168 按官方现价更正。
        assert_eq!(prices["gpt-5.6"]["input"], json!(4.0));
        assert_eq!(prices["gpt-5.6-sol"]["cache_write"], json!(5.0));
        assert_eq!(prices["gpt-5.6-terra"]["output"], json!(12.0));
        assert_eq!(prices["gpt-5.6-luna"]["cache_input"], json!(0.02));
        assert_eq!(prices["gpt-5.2"]["input"], json!(1.75));
        assert_eq!(prices["gpt-5-nano"]["output"], json!(0.4));
        assert_eq!(prices["claude-fable-5"]["output"], json!(50.0));
        // 官方已把发布价 2/10 定为标准价，原定 2026-09-01 涨到 3/15 未执行（T10.168 撤回 T10.92 的切换）。
        assert_eq!(prices["claude-sonnet-5"]["input"], json!(2.0));
        assert_eq!(prices["claude-sonnet-5"]["output"], json!(10.0));
        assert_eq!(prices["claude-sonnet-5"]["cache_input"], json!(0.2));
        assert_eq!(prices["claude-sonnet-5"]["cache_write"], json!(2.5));
        assert_eq!(prices["claude-mythos-5"]["cache_write"], json!(12.5));
    }

    #[test]
    fn normalized_codex_input_bills_fresh_reads_and_writes_once() {
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "gpt-5.6-sol": {
                "input": 5.0,
                "output": 30.0,
                "cache_input": 0.5,
                "cache_write": 6.25
            }
        });

        // Codex scanner stores 100K fresh input separately from 800K reads
        // and 100K writes, plus 100K output:
        // $0.50 + $0.40 + $0.625 + $3.00.
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "codex",
                "gpt-5.6-sol",
                100_000,
                100_000,
                800_000,
                100_000,
            ),
            4.525,
        );
        assert_roughly_eq(
            estimate_cache_savings(&prices, "codex", "gpt-5.6-sol", 1_000_000),
            4.5,
        );
        // T10.183：同一 100K 写入按 (6.25 − 5) 计写入溢价 $0.125，已含在上面的预估费用里。
        let parts = estimate_cache_savings_parts(&prices, "codex", "gpt-5.6-sol", 800_000, 100_000);
        assert_roughly_eq(parts.read_saved, 3.6);
        assert_roughly_eq(parts.write_premium, 0.125);
        assert_eq!(
            (parts.fallback_read_tokens, parts.fallback_write_tokens),
            (0, 0)
        );
    }

    #[test]
    fn falls_back_to_ten_percent_cache_price() {
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "model": { "input": 2.0, "output": 8.0 }
        });

        assert_roughly_eq(
            estimate_cost(
                &prices, "other", "model", 1_000_000, 1_000_000, 1_000_000, 0,
            ),
            10.2,
        );
    }

    #[test]
    fn prices_cache_writes_separately_from_reads() {
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "claude-fable-5": { "input": 10.0, "output": 50.0, "cache_input": 1.0, "cache_write": 12.5 }
        });

        // 1M reads at $1 + 1M writes at $12.5, no fresh input/output.
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "claude",
                "claude-fable-5",
                0,
                0,
                1_000_000,
                1_000_000,
            ),
            13.5,
        );
        // Write price falls back to 1.25x input when not configured.
        let no_write = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "model": { "input": 2.0, "output": 8.0 }
        });
        assert_roughly_eq(
            estimate_cost(&no_write, "other", "model", 0, 0, 0, 1_000_000),
            2.5,
        );
    }

    #[test]
    fn cache_savings_use_input_minus_read_price() {
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "claude-fable-5": { "input": 10.0, "output": 50.0, "cache_input": 1.0 }
        });
        // 1M cache reads: $10 as fresh input vs $1 as reads → $9 saved.
        assert_roughly_eq(
            estimate_cache_savings(&prices, "claude", "claude-fable-5", 1_000_000),
            9.0,
        );
    }

    fn discovered(tool: &str, model: &str) -> DiscoveredModelPrice {
        DiscoveredModelPrice {
            tool: tool.to_string(),
            model_key: model.to_ascii_lowercase(),
            model: model.to_string(),
            tools: vec![tool.to_string()],
            first_seen_at: "2026-07-10 10:00:00".to_string(),
            last_seen_at: "2026-07-10 11:00:00".to_string(),
        }
    }

    #[test]
    fn auto_discovery_adds_unmatched_models_without_duplicating_known_families() {
        let prices = default_prices();
        let before_cost = estimate_cost(
            &prices,
            "codex",
            "future-model-1",
            1_000_000,
            1_000_000,
            100_000,
            0,
        );
        let merged = merge_discovered_prices(
            prices,
            &[
                discovered("codex", "future-model-1"),
                discovered("codex", "future-model-10"),
                discovered("codex", "gpt-5.6-sol-2026-07-09"),
            ],
        );

        assert_eq!(
            merged["future-model-1"]["_meta"]["status"],
            json!("auto_discovered")
        );
        assert_eq!(
            merged["future-model-1"]["_meta"]["fallback_key"],
            json!("codex-agent")
        );
        assert!(merged.get("future-model-10").is_some());
        assert!(merged.get("gpt-5.6-sol-2026-07-09").is_none());
        assert!(merged["future-model-1"].get("cache_input").is_some());
        assert!(merged["future-model-1"].get("cache_write").is_some());

        let after_cost = estimate_cost(
            &merged,
            "codex",
            "future-model-1",
            1_000_000,
            1_000_000,
            100_000,
            0,
        );
        assert_roughly_eq(after_cost, before_cost);
    }

    #[test]
    fn auto_discovery_never_overwrites_an_existing_user_price() {
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "future-model": { "input": 9.0, "output": 99.0 }
        });
        let merged = merge_discovered_prices(prices, &[discovered("codex", "future-model")]);

        assert_eq!(merged["future-model"]["input"], json!(9.0));
        assert!(merged["future-model"].get("_meta").is_none());
    }

    #[test]
    fn repricing_change_detection_ignores_discovery_metadata() {
        let before = json!({
            "future-model": {
                "input": 1.0,
                "output": 3.0,
                "cache_input": 0.1,
                "cache_write": 1.25,
                "_meta": { "status": "auto_discovered", "last_seen_at": "10:00" }
            }
        });
        let after = json!({
            "future-model": {
                "input": 1.0,
                "output": 3.0,
                "cache_input": 0.1,
                "cache_write": 1.25,
                "_meta": { "status": "user_edited", "last_seen_at": "11:00" }
            }
        });

        assert_eq!(price_rate_snapshot(&before), price_rate_snapshot(&after));
    }

    #[test]
    fn discovered_models_are_merged_into_effective_prices_and_survive_reset() {
        let app_dir = std::env::temp_dir().join(format!(
            "tokenledger_discovered_prices_{}_{}",
            std::process::id(),
            PRICE_TEST_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&app_dir);
        let app = AppContext::for_test(app_dir.clone());
        let db_path = db::get_db_path(&app);
        db::init_db(&db_path).expect("initialize price discovery test db");
        let conn = Connection::open(&db_path).expect("open price discovery test db");
        conn.execute(
            "INSERT INTO discovered_models (tool, model_key, model)
             VALUES ('codex', 'provider-future-2027', 'Provider-Future-2027')",
            [],
        )
        .expect("insert discovered model");
        drop(conn);

        let prices = get_prices_impl(&app).expect("load effective prices");
        assert_eq!(
            prices["provider-future-2027"]["_meta"]["status"],
            json!("auto_discovered")
        );
        assert_eq!(
            prices["provider-future-2027"]["_meta"]["fallback_key"],
            json!("codex-agent")
        );

        let reset = reset_prices_impl(&app).expect("reset effective prices");
        assert_eq!(
            reset["prices"]["provider-future-2027"]["_meta"]["status"],
            json!("auto_discovered")
        );

        let _ = fs::remove_dir_all(app_dir);
    }

    #[test]
    fn claude_fable_5_1_and_5_are_isolated_and_not_merged_by_substring() {
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "claude-fable-5": { "input": 10.0, "output": 50.0, "cache_input": 1.0, "cache_write": 12.5 },
            "claude-fable-5-1": { "input": 12.0, "output": 60.0, "cache_input": 1.2, "cache_write": 15.0 },
            "claude-unknown": { "input": 3.0, "output": 15.0 }
        });

        // claude-fable-5 matches exact
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "claude",
                "claude-fable-5",
                1_000_000,
                1_000_000,
                0,
                0,
            ),
            60.0,
        );

        // claude-fable-5-1 matches its own key, not claude-fable-5
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "claude",
                "claude-fable-5-1",
                1_000_000,
                1_000_000,
                0,
                0,
            ),
            72.0,
        );

        // A future version claude-fable-5-2 without explicit key must NOT match claude-fable-5,
        // but fall back to claude-unknown
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "claude",
                "claude-fable-5-2",
                1_000_000,
                1_000_000,
                0,
                0,
            ),
            18.0,
        );
    }

    #[test]
    fn auto_discovery_surfaces_claude_fable_5_1_separately_when_not_in_table() {
        // Table only has claude-fable-5, NOT claude-fable-5-1
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "claude-fable-5": { "input": 10.0, "output": 50.0, "cache_input": 1.0, "cache_write": 12.5 },
            "claude-unknown": { "input": 3.0, "output": 15.0 }
        });

        let merged = merge_discovered_prices(prices, &[discovered("claude", "claude-fable-5-1")]);

        // claude-fable-5-1 must be auto-discovered and NOT suppressed by claude-fable-5
        assert!(merged.get("claude-fable-5-1").is_some());
        assert_eq!(
            merged["claude-fable-5-1"]["_meta"]["status"],
            json!("auto_discovered")
        );
    }

    #[test]
    fn valid_date_and_latest_snapshots_still_resolve_to_base_family() {
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "codex-agent": { "input": 1.5, "output": 2.0 },
            "claude-3-5-sonnet": { "input": 3.0, "output": 15.0 },
            "gpt-5.6-sol": { "input": 5.0, "output": 30.0 }
        });

        // 8-digit date snapshot matches base family
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "claude",
                "claude-3-5-sonnet-20241022",
                1_000_000,
                1_000_000,
                0,
                0,
            ),
            18.0,
        );

        // ISO date snapshot matches base family
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "codex",
                "gpt-5.6-sol-2026-07-09",
                1_000_000,
                1_000_000,
                0,
                0,
            ),
            35.0,
        );

        // latest snapshot matches base family
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "codex",
                "gpt-5.6-sol-latest",
                1_000_000,
                1_000_000,
                0,
                0,
            ),
            35.0,
        );

        // Sub-version or variant does NOT match base family as a snapshot
        assert_roughly_eq(
            estimate_cost(
                &prices,
                "codex",
                "gpt-5.6-sol-pro",
                1_000_000,
                1_000_000,
                0,
                0,
            ),
            3.5, // falls back to codex-agent (1.5 + 2.0)
        );
    }

    #[test]
    fn model_1_does_not_suppress_model_10() {
        let prices = json!({
            "default": { "input": 1.0, "output": 3.0 },
            "model-1": { "input": 1.0, "output": 2.0 }
        });

        let merged = merge_discovered_prices(prices, &[discovered("other", "model-10")]);

        assert!(merged.get("model-10").is_some());
        assert_eq!(
            merged["model-10"]["_meta"]["status"],
            json!("auto_discovered")
        );
    }
}

/// The headline token metric is "effective tokens" — input + output, the
/// volume that actually did work. Cache reads/writes used to be included
/// here, which made the totals 50-300x larger than what the providers' own
/// dashboards report and let cache-heavy tools dwarf everything else in the
/// charts. Cache volume is still tracked and surfaced separately.
fn effective_tokens(input: i64, output: i64) -> i64 {
    input + output
}

/// 自定义范围最长两年：日桶轴最多 731 个，足够复盘一整年并对比上一年。
const MAX_CUSTOM_RANGE_DAYS: i64 = 731;

/// T10.185：云端 v2 RPC 自 T10.113 迁移 `20260905162953` 起已支持 `custom`；这条消息现在只在
/// 旧服务器身上出现——要么四个 v2 RPC 签名整体缺失（`CloudRpcFailureKind::MissingSignature`
/// 且请求是 custom，此时旧版 v1 签名也没有 start/end 参数，无法兜底），要么 v2 签名已部署但
/// 尚未跑过这条迁移，共享的 `private.tokenledger_normalize_query_v2` 会对 `custom` 报
/// `query-v2: invalid range custom`（`CloudRpcFailureKind::RangeUnsupported`，见
/// `is_custom_range_rejected_by_schema`）。两种情况都必须诚实降级为「云端范围受限」
/// （`classifyCloudFailure` 的 `range-unsupported`），绝不能显示「云端服务暂不可用」或掉回预设。
const CUSTOM_RANGE_CLOUD_UNSUPPORTED: &str =
    "云端汇总暂不支持自定义日期范围；请切换到“本地机器”或选择预设范围。";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatsRange {
    Today,
    Week,
    Month,
    Year,
    All,
    /// 用户指定的本地日期闭区间（复盘报表，T10.108）；同期对比取紧邻的上一段等长区间。
    Custom {
        start: NaiveDate,
        end: NaiveDate,
    },
}

impl StatsRange {
    fn parse_with_bounds(
        value: &str,
        start: Option<&str>,
        end: Option<&str>,
    ) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "today" => Ok(Self::Today),
            "week" => Ok(Self::Week),
            "month" => Ok(Self::Month),
            "year" => Ok(Self::Year),
            "all" => Ok(Self::All),
            "custom" => {
                let parse_date = |label: &str, raw: Option<&str>| -> Result<NaiveDate, String> {
                    let raw = raw
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| format!("custom range requires {label} as YYYY-MM-DD"))?;
                    NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| {
                        format!("invalid custom range {label} '{raw}'; expected YYYY-MM-DD")
                    })
                };
                let start = parse_date("start", start)?;
                let end = parse_date("end", end)?;
                if end < start {
                    return Err(format!("custom range end {end} is before start {start}"));
                }
                let span_days = (end - start).num_days() + 1;
                if span_days > MAX_CUSTOM_RANGE_DAYS {
                    return Err(format!(
                        "custom range spans {span_days} days; the maximum is {MAX_CUSTOM_RANGE_DAYS}"
                    ));
                }
                Ok(Self::Custom { start, end })
            }
            _ => Err(format!(
                "invalid range '{}'; expected today, week, month, year, all, or custom",
                value
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Today => "today",
            Self::Week => "week",
            Self::Month => "month",
            Self::Year => "year",
            Self::All => "all",
            Self::Custom { .. } => "custom",
        }
    }

    /// 自定义范围的本地日期闭区间；预设范围返回 None。
    fn custom_bounds(self) -> Option<(NaiveDate, NaiveDate)> {
        match self {
            Self::Custom { start, end } => Some((start, end)),
            _ => None,
        }
    }

    /// 单日（今日或自定义单日）用小时桶，其余用日桶或月桶。
    fn uses_hour_buckets(self) -> bool {
        match self {
            Self::Today => true,
            Self::Custom { start, end } => start == end,
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
struct NormalizedStatsQuery {
    range: StatsRange,
    timezone: String,
    tz: Tz,
    machines: Vec<String>,
    tools: Vec<String>,
    models: Vec<String>,
    search: Option<String>,
    token_mode: String,
    /// 只有本机明细会设置；空表示不按账号筛选。
    providers: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatsScope {
    Local,
    Cloud,
}

impl StatsScope {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value
            .unwrap_or("local")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "local" => Ok(Self::Local),
            "cloud" => Ok(Self::Cloud),
            value => Err(format!(
                "invalid stats scope '{value}'; expected local or cloud"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Cloud => "cloud",
        }
    }
}

impl NormalizedStatsQuery {
    fn from_query(query: LocalStatsQuery) -> Result<Self, String> {
        let filters = normalize_filters(
            query.machines,
            query.machine,
            query.tools,
            query.tool,
            query.models,
            query.model,
            query.search,
        )?;
        let token_mode = query
            .token_mode
            .unwrap_or_else(|| "effective".to_string())
            .trim()
            .to_ascii_lowercase();
        if token_mode != "effective" {
            if token_mode == "total" {
                return Err(
                    "tokenMode 'total' is not supported by local Stats v2; use 'effective'"
                        .to_string(),
                );
            }
            return Err(format!(
                "invalid tokenMode '{}'; expected effective",
                token_mode
            ));
        }

        let requested_timezone = query.timezone.trim();
        let timezone =
            if requested_timezone.is_empty() || requested_timezone.eq_ignore_ascii_case("local") {
                iana_time_zone::get_timezone()
                    .map_err(|error| format!("cannot detect the local IANA timezone: {error}"))?
            } else {
                requested_timezone.to_string()
            };
        let tz = timezone
            .parse::<Tz>()
            .map_err(|_| format!("invalid IANA timezone '{timezone}'"))?;
        let timezone = tz.name().to_string();

        let range = StatsRange::parse_with_bounds(
            &query.range,
            query.start.as_deref(),
            query.end.as_deref(),
        )?;
        // T10.185 review P3-1: a custom range starting after "today" in the
        // request's own time zone can never be satisfied — not locally, and
        // not by any cloud server, migrated or not. Checked here (rather than
        // inside the timezone-naive `parse_with_bounds`) because `tz` is only
        // known once the timezone has already been resolved above. Caught
        // before any cloud RPC is attempted, so the message is always this
        // clear one, never a network-classified "云端版本不兼容".
        if let Some((start, _end)) = range.custom_bounds() {
            let today_in_tz = Utc::now().with_timezone(&tz).date_naive();
            if start > today_in_tz {
                return Err(format!(
                    "custom range start {start} is after today ({today_in_tz}) in time zone {timezone}"
                ));
            }
        }

        Ok(Self {
            range,
            timezone,
            tz,
            machines: filters.machines,
            tools: filters.tools,
            models: filters.models,
            search: filters.search,
            token_mode,
            providers: Vec::new(),
        })
    }

    fn request_json(&self) -> Value {
        let mut request = json!({
            "range": self.range.as_str(),
            "timezone": self.timezone,
            "machines": self.machines,
            "tools": self.tools,
            "models": self.models,
            "search": self.search,
            "tokenMode": self.token_mode
        });
        // 自定义范围的日期是查询身份的一部分：进缓存指纹，也原样回显给客户端比对。
        if let Some((start, end)) = self.range.custom_bounds() {
            request["start"] = json!(start.format("%Y-%m-%d").to_string());
            request["end"] = json!(end.format("%Y-%m-%d").to_string());
        }
        // 只在按账号筛选时出现，不按账号的回显与指纹保持原样。
        if !self.providers.is_empty() {
            request["providers"] = json!(self.providers);
        }
        request
    }

    fn echo_json(&self) -> Value {
        let mut echo = self
            .request_json()
            .as_object()
            .cloned()
            .expect("canonical query is an object");
        insert_singular_echo(&mut echo, "machine", &self.machines);
        insert_singular_echo(&mut echo, "tool", &self.tools);
        insert_singular_echo(&mut echo, "model", &self.models);
        Value::Object(echo)
    }

    fn fingerprint(&self, entity: Option<&NormalizedEntitySelector>) -> String {
        let mut identity = Map::new();
        identity.insert("query".to_string(), self.request_json());
        if let Some(entity) = entity {
            identity.insert("entity".to_string(), entity_json(entity));
        }
        fingerprint_json(&Value::Object(identity))
    }

    fn single_machine(&self) -> Option<&str> {
        match self.machines.as_slice() {
            [value] => Some(value),
            _ => None,
        }
    }

    fn single_tool(&self) -> Option<&str> {
        match self.tools.as_slice() {
            [value] => Some(value),
            _ => None,
        }
    }

    fn single_model(&self) -> Option<&str> {
        match self.models.as_slice() {
            [value] => Some(value),
            _ => None,
        }
    }

    /// T10.185: a legacy (`_v1`/timezone) RPC signature has no `start`/`end`
    /// parameters at all, so it structurally cannot represent a custom range —
    /// excluded here regardless of filter cardinality, never just downgraded.
    fn legacy_dashboard_representable(&self) -> bool {
        self.range.custom_bounds().is_none()
            && self.machines.len() <= 1
            && self.tools.is_empty()
            && self.models.is_empty()
            && self.search.is_none()
    }

    fn legacy_filter_representable(&self) -> bool {
        self.range.custom_bounds().is_none()
            && self.machines.len() <= 1
            && self.tools.len() <= 1
            && self.models.len() <= 1
            && self.search.is_none()
    }
}

fn insert_singular_echo(target: &mut Map<String, Value>, key: &str, values: &[String]) {
    match values {
        [] => {
            target.insert(key.to_string(), Value::Null);
        }
        [value] => {
            target.insert(key.to_string(), json!(value));
        }
        _ => {}
    }
}

fn singular_compat_value(values: &[String]) -> Option<Value> {
    match values {
        [] => Some(Value::Null),
        [value] => Some(json!(value)),
        _ => None,
    }
}

fn entity_json(entity: &NormalizedEntitySelector) -> Value {
    json!({ "kind": entity.kind.as_str(), "id": entity.id })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComparisonBucket {
    Hour,
    Day,
}

impl ComparisonBucket {
    fn as_str(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
        }
    }
}

#[derive(Debug, Clone)]
struct ComparisonWindow {
    kind: &'static str,
    bucket: ComparisonBucket,
    aligned_time: NaiveTime,
    current_start: DateTime<Tz>,
    current_end: DateTime<Tz>,
    previous_start: DateTime<Tz>,
    previous_end: DateTime<Tz>,
}

#[derive(Debug, Clone)]
struct QueryBounds {
    current_start: Option<DateTime<Tz>>,
    current_end: DateTime<Tz>,
    comparison: Option<ComparisonWindow>,
}

#[derive(Debug, Clone, Copy)]
enum BoundarySide {
    Start,
    End,
}

fn midnight(date: NaiveDate) -> NaiveDateTime {
    date.and_hms_opt(0, 0, 0).expect("midnight is valid")
}

fn previous_month(year: i32, month: u32) -> (i32, u32) {
    if month == 1 {
        (year - 1, 12)
    } else {
        (year, month - 1)
    }
}

fn next_month(year: i32, month: u32) -> (i32, u32) {
    if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = next_month(year, month);
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|date| date.pred_opt())
        .expect("calendar month has a final day")
        .day()
}

fn resolve_wall_time(
    timezone: Tz,
    value: NaiveDateTime,
    side: BoundarySide,
) -> Result<DateTime<Tz>, String> {
    let choose = |result| match result {
        LocalResult::Single(value) => Some(value),
        LocalResult::Ambiguous(first, second) => Some(match side {
            BoundarySide::Start => first,
            BoundarySide::End => second,
        }),
        LocalResult::None => None,
    };

    if let Some(value) = choose(timezone.from_local_datetime(&value)) {
        return Ok(value);
    }

    // A wall-clock time inside a spring-forward gap has no corresponding
    // instant. Calendar windows advance to the first valid minute, and the
    // adjusted instant is used consistently for SQL and response metadata.
    (1..=180)
        .find_map(|minutes| {
            let candidate = value + Duration::minutes(minutes);
            choose(timezone.from_local_datetime(&candidate))
        })
        .ok_or_else(|| {
            format!(
                "cannot resolve wall-clock boundary {value} in timezone {}",
                timezone.name()
            )
        })
}

fn query_bounds(range: StatsRange, now: DateTime<Tz>) -> Result<QueryBounds, String> {
    let timezone = now.timezone();
    let today_start = resolve_wall_time(timezone, midnight(now.date_naive()), BoundarySide::Start)?;
    let bounds = match range {
        StatsRange::Today => {
            let previous_date = now.date_naive() - Duration::days(1);
            QueryBounds {
                current_start: Some(today_start),
                current_end: now,
                comparison: Some(ComparisonWindow {
                    kind: "dayOverDay",
                    bucket: ComparisonBucket::Hour,
                    aligned_time: now.time(),
                    current_start: today_start,
                    current_end: now,
                    previous_start: resolve_wall_time(
                        timezone,
                        midnight(previous_date),
                        BoundarySide::Start,
                    )?,
                    // Calendar-wall-clock alignment deliberately avoids
                    // subtracting a fixed 24 hours across DST changes.
                    previous_end: resolve_wall_time(
                        timezone,
                        previous_date.and_time(now.time()),
                        BoundarySide::End,
                    )?,
                }),
            }
        }
        StatsRange::Week => {
            let days_since_monday = now.weekday().num_days_from_monday() as i64;
            let current_start = resolve_wall_time(
                timezone,
                midnight(now.date_naive() - Duration::days(days_since_monday)),
                BoundarySide::Start,
            )?;
            let previous_start = resolve_wall_time(
                timezone,
                midnight(now.date_naive() - Duration::days(days_since_monday + 7)),
                BoundarySide::Start,
            )?;
            QueryBounds {
                current_start: Some(current_start),
                current_end: now,
                comparison: Some(ComparisonWindow {
                    kind: "weekOverWeek",
                    bucket: ComparisonBucket::Day,
                    aligned_time: now.time(),
                    current_start,
                    current_end: now,
                    previous_start,
                    previous_end: resolve_wall_time(
                        timezone,
                        (now.date_naive() - Duration::days(7)).and_time(now.time()),
                        BoundarySide::End,
                    )?,
                }),
            }
        }
        StatsRange::Month => {
            let current_start = resolve_wall_time(
                timezone,
                midnight(
                    NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
                        .expect("current month start is valid"),
                ),
                BoundarySide::Start,
            )?;
            let (previous_year, previous_month) = previous_month(now.year(), now.month());
            let previous_start = resolve_wall_time(
                timezone,
                midnight(
                    NaiveDate::from_ymd_opt(previous_year, previous_month, 1)
                        .expect("previous month start is valid"),
                ),
                BoundarySide::Start,
            )?;
            let aligned_day = now.day().min(days_in_month(previous_year, previous_month));
            let aligned_current_end = resolve_wall_time(
                timezone,
                NaiveDate::from_ymd_opt(now.year(), now.month(), aligned_day)
                    .expect("aligned current date is valid")
                    .and_time(now.time()),
                BoundarySide::End,
            )?;
            let aligned_previous_end = resolve_wall_time(
                timezone,
                NaiveDate::from_ymd_opt(previous_year, previous_month, aligned_day)
                    .expect("aligned previous date is valid")
                    .and_time(now.time()),
                BoundarySide::End,
            )?;
            QueryBounds {
                current_start: Some(current_start),
                current_end: now,
                comparison: Some(ComparisonWindow {
                    kind: "monthOverMonth",
                    bucket: ComparisonBucket::Day,
                    aligned_time: now.time(),
                    current_start,
                    current_end: aligned_current_end,
                    previous_start,
                    previous_end: aligned_previous_end,
                }),
            }
        }
        StatsRange::Custom { start, end } => {
            let current_start = resolve_wall_time(timezone, midnight(start), BoundarySide::Start)?;
            // 闭区间取结束日的最后一秒；跨越“现在”的区间截到现在，沿用预设范围的
            // 进行中语义，上一区间按同一进度对齐。
            let end_of_range = resolve_wall_time(
                timezone,
                end.and_hms_opt(23, 59, 59).expect("end of day is valid"),
                BoundarySide::End,
            )?;
            let current_end = if end_of_range < now {
                end_of_range
            } else {
                now
            };
            let span_days = (end - start).num_days() + 1;
            let previous_start = resolve_wall_time(
                timezone,
                midnight(start - Duration::days(span_days)),
                BoundarySide::Start,
            )?;
            let aligned_time = current_end.time();
            let previous_end = resolve_wall_time(
                timezone,
                (current_end.date_naive() - Duration::days(span_days)).and_time(aligned_time),
                BoundarySide::End,
            )?;
            QueryBounds {
                current_start: Some(current_start),
                current_end,
                comparison: Some(ComparisonWindow {
                    kind: "periodOverPeriod",
                    bucket: if span_days == 1 {
                        ComparisonBucket::Hour
                    } else {
                        ComparisonBucket::Day
                    },
                    aligned_time,
                    current_start,
                    current_end,
                    previous_start,
                    previous_end,
                }),
            }
        }
        StatsRange::Year => QueryBounds {
            current_start: Some(resolve_wall_time(
                timezone,
                midnight(NaiveDate::from_ymd_opt(now.year(), 1, 1).expect("year start is valid")),
                BoundarySide::Start,
            )?),
            current_end: now,
            comparison: None,
        },
        StatsRange::All => QueryBounds {
            current_start: None,
            current_end: now,
            comparison: None,
        },
    };
    Ok(bounds)
}

fn storage_timestamp(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn storage_boundary(value: &DateTime<Tz>) -> NaiveDateTime {
    value.with_timezone(&Local).naive_local()
}

fn resolve_storage_timestamp(value: NaiveDateTime) -> Result<DateTime<Local>, String> {
    let choose = |result| match result {
        LocalResult::Single(value) => Some(value),
        // Legacy storage has no offset and cannot distinguish the repeated
        // hour. Choose the earlier instant deterministically.
        LocalResult::Ambiguous(first, _) => Some(first),
        LocalResult::None => None,
    };
    if let Some(value) = choose(Local.from_local_datetime(&value)) {
        return Ok(value);
    }
    (1..=180)
        .find_map(|minutes| {
            choose(Local.from_local_datetime(&(value + Duration::minutes(minutes))))
        })
        .ok_or_else(|| format!("cannot resolve stored local timestamp {value}"))
}

fn timestamp_in_timezone(value: &str, timezone: Tz) -> Result<DateTime<Tz>, String> {
    let naive = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
        .map_err(|_| format!("invalid stored timestamp '{value}'"))?;
    Ok(resolve_storage_timestamp(naive)?.with_timezone(&timezone))
}

fn rows_in_timezone(rows: &[StatRow], timezone: Tz) -> Result<Vec<StatRow>, String> {
    rows.iter()
        .map(|row| {
            let mut row = row.clone();
            let shifted =
                storage_timestamp(timestamp_in_timezone(&row.timestamp, timezone)?.naive_local());
            if row.pricing_timestamp.is_none() {
                row.pricing_timestamp = Some(std::mem::replace(&mut row.timestamp, shifted));
            } else {
                row.timestamp = shifted;
            }
            Ok(row)
        })
        .collect()
}

fn initial_trends_at(range: StatsRange, now: NaiveDateTime) -> HashMap<String, Value> {
    let mut trends_map = HashMap::new();

    match range {
        StatsRange::Today => {
            for h in 0..24 {
                let key = format!("{:02}:00", h);
                trends_map.insert(key.clone(), json!({ "date": key }));
            }
        }
        StatsRange::Week => {
            let weekday = now.weekday().number_from_monday() as i64;
            let monday = now - Duration::days(weekday - 1);
            for i in 0..7 {
                let day = monday + Duration::days(i);
                let key = day.format("%Y-%m-%d").to_string();
                trends_map.insert(key.clone(), json!({ "date": key }));
            }
        }
        StatsRange::Month => {
            let last_day = days_in_month(now.year(), now.month());
            for day in 1..=last_day {
                let key = format!("{}-{:02}-{:02}", now.year(), now.month(), day);
                trends_map.insert(key.clone(), json!({ "date": key }));
            }
        }
        StatsRange::Year => {
            for m in 1..=12 {
                let key = format!("{}-{:02}", now.year(), m);
                trends_map.insert(key.clone(), json!({ "date": key }));
            }
        }
        StatsRange::All => {
            let start = now - Duration::days(30);
            for i in 0..=30 {
                let day = start + Duration::days(i);
                let key = day.format("%Y-%m-%d").to_string();
                trends_map.insert(key.clone(), json!({ "date": key }));
            }
        }
        StatsRange::Custom { start, end } => {
            if start == end {
                for h in 0..24 {
                    let key = format!("{:02}:00", h);
                    trends_map.insert(key.clone(), json!({ "date": key }));
                }
            } else {
                let mut day = start;
                while day <= end {
                    let key = day.format("%Y-%m-%d").to_string();
                    trends_map.insert(key.clone(), json!({ "date": key }));
                    day += Duration::days(1);
                }
            }
        }
    }

    trends_map
}

fn trend_key(range: StatsRange, timestamp: &str, clean_date: &str) -> String {
    if range.uses_hour_buckets() {
        return timestamp
            .get(11..13)
            .map(|h| format!("{}:00", h))
            .unwrap_or_default();
    }
    match range {
        StatsRange::Year => timestamp.get(0..7).unwrap_or_default().to_string(),
        _ => clean_date.to_string(),
    }
}

/// 工具或模型在统计窗口内的累计。聚合时只做整数/浮点加法，结束后一次性生成与旧实现
/// 同形的 JSON；此前每行要改写十几个 JSON 字段并为每个字段名分配字符串（T10.167）。
struct WindowTotals<'a> {
    input: i64,
    output: i64,
    cached: i64,
    cache_read: i64,
    cache_write: i64,
    total: i64,
    cost: f64,
    requests: i64,
    cache_split_proven: bool,
    heatmap: HashMap<&'a str, i64>,
    /// 与 `heatmap` 同日期键的逐日记录数与预估费用（契约 §2.6 本机可选扩展）。
    heatmap_requests: HashMap<&'a str, i64>,
    heatmap_cost: HashMap<&'a str, f64>,
    /// 只有工具使用：该工具下各模型的有效 Token。
    models: HashMap<&'a str, i64>,
}

impl<'a> WindowTotals<'a> {
    fn new() -> Self {
        Self {
            input: 0,
            output: 0,
            cached: 0,
            cache_read: 0,
            cache_write: 0,
            total: 0,
            cost: 0.0,
            requests: 0,
            cache_split_proven: true,
            heatmap: HashMap::new(),
            heatmap_requests: HashMap::new(),
            heatmap_cost: HashMap::new(),
            models: HashMap::new(),
        }
    }

    fn add(
        &mut self,
        row: &StatRow,
        total: i64,
        cost: f64,
        cache_split_proven: bool,
        heatmap_date: Option<&'a str>,
    ) {
        self.input += row.input_tokens;
        self.output += row.output_tokens;
        self.cached += row.cached_tokens;
        self.cache_read += row.cache_read_tokens();
        self.cache_write += row.cache_write_tokens;
        self.total += total;
        self.cost += cost;
        self.requests += 1;
        self.cache_split_proven &= cache_split_proven;
        if let Some(date) = heatmap_date {
            *self.heatmap.entry(date).or_insert(0) += total;
            *self.heatmap_requests.entry(date).or_insert(0) += 1;
            *self.heatmap_cost.entry(date).or_insert(0.0) += cost;
        }
    }

    /// 读写拆分不能被每一行证明时，不输出 `cacheRead`/`cacheWrite`（与旧实现一致）。
    fn into_json(self, name: &str, include_models: bool) -> Value {
        let mut object = Map::new();
        object.insert("name".to_string(), json!(name));
        object.insert("input".to_string(), json!(self.input));
        object.insert("output".to_string(), json!(self.output));
        object.insert("cached".to_string(), json!(self.cached));
        if self.cache_split_proven {
            object.insert("cacheRead".to_string(), json!(self.cache_read));
            object.insert("cacheWrite".to_string(), json!(self.cache_write));
        }
        object.insert("total".to_string(), json!(self.total));
        object.insert("cost".to_string(), json!(self.cost));
        object.insert("requests".to_string(), json!(self.requests));
        object.insert("heatmap".to_string(), json_counts(self.heatmap));
        object.insert(
            "heatmapRequests".to_string(),
            json_counts(self.heatmap_requests),
        );
        object.insert("heatmapCost".to_string(), json_amounts(self.heatmap_cost));
        if include_models {
            object.insert("models".to_string(), json_counts(self.models));
        }
        Value::Object(object)
    }
}

fn json_amounts(amounts: HashMap<&str, f64>) -> Value {
    Value::Object(
        amounts
            .into_iter()
            .map(|(key, value)| (key.to_string(), json!((value * 1e6).round() / 1e6)))
            .collect(),
    )
}

fn json_counts(counts: HashMap<&str, i64>) -> Value {
    Value::Object(
        counts
            .into_iter()
            .map(|(key, value)| (key.to_string(), json!(value)))
            .collect(),
    )
}

/// 契约 §2.7：按网关供应商（账号）拆分本期用量。只有网关与导入行带供应商，
/// 扫描行不计入任何账号；口径与 `tools[*]` 相同（逐行估价、同一窗口）。
fn aggregate_provider_split(
    rows: &[StatRow],
    providers: &HashMap<i64, String>,
    prices: &Value,
    filter_start: Option<NaiveDateTime>,
    filter_end: NaiveDateTime,
) -> Value {
    let filter_start = filter_start.map(storage_timestamp);
    let filter_end = storage_timestamp(filter_end);
    let mut memo = PriceMemo::new(prices);
    let mut totals: HashMap<&str, WindowTotals> = HashMap::new();
    for row in rows {
        let Some(provider) = providers
            .get(&row.id)
            .filter(|provider| !provider.is_empty())
        else {
            continue;
        };
        if filter_start
            .as_ref()
            .is_some_and(|start| row.timestamp < *start)
            || row.timestamp > filter_end
        {
            continue;
        }
        let clean_date = row.timestamp.split_whitespace().next().unwrap_or("");
        let price = memo.row_price(row);
        totals
            .entry(provider.as_str())
            .or_insert_with(WindowTotals::new)
            .add(
                row,
                effective_tokens(row.input_tokens, row.output_tokens),
                price.cost,
                row.cache_split_is_proven(),
                (clean_date.len() == 10).then_some(clean_date),
            );
    }
    Value::Object(
        totals
            .into_iter()
            .map(|(name, totals)| (name.to_string(), totals.into_json(name, false)))
            .collect(),
    )
}

/// 契约 §2.8：本期带 Context 构成的网关行的构成合计与输入合计，读者据此求平均构成。
/// 没有这样的行时为 `None`，不输出空对象。
fn aggregate_context_composition(
    rows: &[StatRow],
    contexts: &HashMap<i64, crate::gateway::ContextSize>,
    filter_start: Option<NaiveDateTime>,
    filter_end: NaiveDateTime,
) -> Option<Value> {
    let filter_start = filter_start.map(storage_timestamp);
    let filter_end = storage_timestamp(filter_end);
    let mut sum = crate::gateway::ContextSize::default();
    let (mut requests, mut prompt_tokens) = (0_i64, 0_i64);
    for row in rows {
        let Some(context) = contexts.get(&row.id) else {
            continue;
        };
        if filter_start
            .as_ref()
            .is_some_and(|start| row.timestamp < *start)
            || row.timestamp > filter_end
        {
            continue;
        }
        requests += 1;
        prompt_tokens += row.input_tokens.max(0) + row.cached_tokens.max(0);
        sum.system_bytes += context.system_bytes;
        sum.tools_bytes += context.tools_bytes;
        sum.history_bytes += context.history_bytes;
        sum.tool_results_bytes += context.tool_results_bytes;
        sum.attachments_bytes += context.attachments_bytes;
        sum.messages += context.messages;
        sum.tool_results += context.tool_results;
        sum.attachments += context.attachments;
    }
    if requests == 0 {
        return None;
    }
    let mut value = json!(sum);
    value["requests"] = json!(requests);
    value["promptTokens"] = json!(prompt_tokens);
    Some(value)
}

fn aggregate_rows_for_window(
    rows: &[StatRow],
    range: StatsRange,
    prices: &Value,
    now: NaiveDateTime,
    filter_start: Option<NaiveDateTime>,
    filter_end: NaiveDateTime,
) -> Value {
    let filter_start = filter_start.map(storage_timestamp);
    let filter_end = storage_timestamp(filter_end);
    let mut trends_map = initial_trends_at(range, now);
    // 与 `trends_map` 同键：每个趋势桶里各工具的有效 Token。
    let mut trend_tokens: HashMap<String, HashMap<&str, i64>> = trends_map
        .keys()
        .map(|key| (key.clone(), HashMap::new()))
        .collect();

    let mut summary_input = 0;
    let mut summary_output = 0;
    let mut summary_cached = 0;
    let mut summary_cache_read = 0;
    let mut summary_cache_write = 0;
    // 缓存读取节省（即 `cacheSavedUsd`）、写入溢价与兜底计数（T10.183）。
    let mut summary_cache_savings = CacheSavingsParts::default();
    let mut summary_cache_split_proven = true;
    let mut summary_cost = 0.0;
    let mut summary_requests = 0;
    let mut summary_tokens = 0;

    let mut tools: HashMap<&str, WindowTotals> = HashMap::new();
    let mut models: HashMap<&str, WindowTotals> = HashMap::new();
    let mut heatmap_map: HashMap<&str, i64> = HashMap::new();
    let mut heatmap_requests: HashMap<&str, i64> = HashMap::new();
    let mut heatmap_cost: HashMap<&str, f64> = HashMap::new();
    let mut history_list = Vec::new();
    let mut active_tools: HashSet<&str> = HashSet::new();
    let mut machine_stats: HashMap<&str, SummaryAccumulator> = HashMap::new();
    // 每个 (工具, 模型) 只做一次价格匹配；此前每行最多匹配 4 次（T10.167）。
    let mut memo = PriceMemo::new(prices);

    for row in rows {
        let row_total = effective_tokens(row.input_tokens, row.output_tokens);
        let clean_date = row.timestamp.split_whitespace().next().unwrap_or("");

        let passed_filter = filter_start
            .as_ref()
            .map(|start| row.timestamp >= *start)
            .unwrap_or(true)
            && row.timestamp <= filter_end;

        if !passed_filter {
            continue;
        }
        // 只给窗口内的行估价：窗口外（同期对比的上一期）的行此前也会被估价后丢弃。
        let price = memo.row_price(row);
        let row_cost = price.cost;
        let row_cache_split_proven = row.cache_split_is_proven();
        let heatmap_date = (clean_date.len() == 10).then_some(clean_date);

        active_tools.insert(row.tool.as_str());
        if !row.machine_id.is_empty() {
            machine_stats
                .entry(row.machine_id.as_str())
                .or_default()
                .add_row(row, price);
        }

        if let Some(date) = heatmap_date {
            *heatmap_map.entry(date).or_insert(0) += row_total;
            *heatmap_requests.entry(date).or_insert(0) += 1;
            *heatmap_cost.entry(date).or_insert(0.0) += row_cost;
        }

        let tool = tools
            .entry(row.tool.as_str())
            .or_insert_with(WindowTotals::new);
        tool.add(
            row,
            row_total,
            row_cost,
            row_cache_split_proven,
            heatmap_date,
        );
        // Keep the model distribution in the same period as the tool's
        // input/output/total values. Previously this ran before the range
        // filter and silently mixed all-time models into period cards.
        *tool.models.entry(row.model.as_str()).or_insert(0) += row_total;
        models
            .entry(row.model.as_str())
            .or_insert_with(WindowTotals::new)
            .add(
                row,
                row_total,
                row_cost,
                row_cache_split_proven,
                heatmap_date,
            );

        summary_input += row.input_tokens;
        summary_output += row.output_tokens;
        summary_cached += row.cached_tokens;
        summary_cache_read += row.cache_read_tokens();
        summary_cache_write += row.cache_write_tokens;
        summary_cache_savings.add(price.cache);
        summary_cache_split_proven &= row_cache_split_proven;
        summary_cost += row_cost;
        summary_requests += 1;
        summary_tokens += row_total;

        let key = trend_key(range, &row.timestamp, clean_date);
        if let Some(bucket) = trend_tokens.get_mut(&key) {
            *bucket.entry(row.tool.as_str()).or_insert(0) += row_total;
        }

        if history_list.len() < 200 {
            let mut history_item = json!({
                "id": row.id,
                "tool": row.tool,
                "model": row.model,
                "inputTokens": row.input_tokens,
                "outputTokens": row.output_tokens,
                "cachedTokens": row.cached_tokens,
                "cost": row_cost,
                "timestamp": row.timestamp,
                "sessionId": row.session_id,
                "machineId": row.machine_id
            });
            if row_cache_split_proven {
                let item = history_item
                    .as_object_mut()
                    .expect("local history item is an object");
                item.insert(
                    "cacheReadTokens".to_string(),
                    json!(row.cache_read_tokens()),
                );
                item.insert(
                    "cacheWriteTokens".to_string(),
                    json!(row.cache_write_tokens),
                );
            }
            if let Some(provenance) = &row.usage_provenance {
                history_item["usageProvenance"] = json!(provenance);
            }
            history_list.push(history_item);
        }
    }

    let tools_stats: Map<String, Value> = tools
        .into_iter()
        .map(|(name, totals)| (name.to_string(), totals.into_json(name, true)))
        .collect();
    let models_stats: Map<String, Value> = models
        .into_iter()
        .map(|(name, totals)| (name.to_string(), totals.into_json(name, false)))
        .collect();

    let mut trends_list = Vec::new();
    let mut sorted_keys: Vec<String> = trends_map.keys().cloned().collect();
    sorted_keys.sort();
    for key in sorted_keys {
        let mut trend_val = trends_map.remove(&key).unwrap();
        let trend_obj = trend_val.as_object_mut().unwrap();
        for (tool, tokens) in trend_tokens.remove(&key).unwrap_or_default() {
            trend_obj.insert(tool.to_string(), json!(tokens));
        }
        for tool in &active_tools {
            if !trend_obj.contains_key(*tool) {
                trend_obj.insert(tool.to_string(), json!(0));
            }
        }
        trends_list.push(trend_val);
    }

    let avg_tokens = if summary_requests > 0 {
        (summary_tokens as f64 / summary_requests as f64).round() as i64
    } else {
        0
    };

    let mut machine_list: Vec<String> = machine_stats
        .keys()
        .map(|machine| machine.to_string())
        .collect();
    machine_list.sort();
    let machine_distribution = local_machine_distribution(owned_keys(machine_stats));

    let mut summary = json!({
        // totalTokens is the effective volume (input + output); cache remains
        // combined unless every cached row proves the read/write split.
        "totalTokens": summary_tokens,
        "inputTokens": summary_input,
        "outputTokens": summary_output,
        "cachedTokens": summary_cached,
        "totalCost": summary_cost,
        "totalRequests": summary_requests,
        "avgTokensPerReq": avg_tokens
    });
    if summary_cache_split_proven {
        let object = summary.as_object_mut().expect("local summary is an object");
        object.insert("cacheReadTokens".to_string(), json!(summary_cache_read));
        object.insert("cacheWriteTokens".to_string(), json!(summary_cache_write));
        object.insert(
            "cacheSavedUsd".to_string(),
            json!(summary_cache_savings.read_saved),
        );
        // 契约 §2.4：与读写拆分同一门槛，缺失即不可得（T10.183）。
        object.insert(
            "cacheSavings".to_string(),
            summary_cache_savings.local_prices_json(),
        );
    }

    // 逐个移入，不经 `json!` 宏对大对象再深拷贝一遍。
    let mut stats = Map::new();
    stats.insert("summary".to_string(), summary);
    stats.insert("tools".to_string(), Value::Object(tools_stats));
    stats.insert("models".to_string(), Value::Object(models_stats));
    stats.insert("trends".to_string(), Value::Array(trends_list));
    stats.insert("heatmap".to_string(), json_counts(heatmap_map));
    stats.insert("heatmapRequests".to_string(), json_counts(heatmap_requests));
    stats.insert("heatmapCost".to_string(), json_amounts(heatmap_cost));
    stats.insert("history".to_string(), Value::Array(history_list));
    stats.insert("machines".to_string(), json!(machine_list));
    stats.insert(
        "machineDistribution".to_string(),
        Value::Array(machine_distribution),
    );
    Value::Object(stats)
}

#[allow(dead_code)]
fn append_stats_filters(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    start: Option<&DateTime<Tz>>,
    end: &DateTime<Tz>,
    query: &NormalizedStatsQuery,
) {
    append_stats_filters_with_entity(sql, values, start, end, query, None);
}

fn append_dimension_filter(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    column: &str,
    selected: &[String],
) {
    if selected.is_empty() {
        return;
    }
    sql.push_str(" AND ");
    sql.push_str(column);
    sql.push_str(" IN (");
    sql.push_str(&vec!["?"; selected.len()].join(","));
    sql.push(')');
    values.extend(selected.iter().cloned().map(SqlValue::Text));
}

fn append_search_filter(sql: &mut String, values: &mut Vec<SqlValue>, search: Option<&str>) {
    let Some(search) = search else {
        return;
    };
    let columns = ["tool", "model", "machine_id", "session_id"];
    sql.push_str(" AND (");
    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            sql.push_str(" OR ");
        }
        if search.is_ascii() {
            sql.push_str("instr(lower(");
            sql.push_str(column);
            sql.push_str("), lower(?)) > 0");
        } else {
            sql.push_str("instr(");
            sql.push_str(column);
            sql.push_str(", ?) > 0");
        }
        values.push(SqlValue::Text(search.to_string()));
    }
    sql.push(')');
}

fn append_stats_filters_with_entity(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    start: Option<&DateTime<Tz>>,
    end: &DateTime<Tz>,
    query: &NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
) {
    if let Some(start) = start {
        sql.push_str(" AND timestamp >= ?");
        values.push(SqlValue::Text(storage_timestamp(storage_boundary(start))));
    }
    sql.push_str(" AND timestamp <= ?");
    values.push(SqlValue::Text(storage_timestamp(storage_boundary(end))));
    append_dimension_filter(sql, values, "machine_id", &query.machines);
    append_dimension_filter(sql, values, "tool", &query.tools);
    append_dimension_filter(sql, values, "model", &query.models);
    if let Some(entity) = entity {
        match entity.kind {
            EntityKind::Tool => sql.push_str(" AND tool = ?"),
            EntityKind::Model => sql.push_str(" AND model = ?"),
        }
        values.push(SqlValue::Text(entity.id.clone()));
    }
    if !query.providers.is_empty() {
        // 供应商只记在网关与导入行上，扫描行没有账号，按账号筛选时不出现。
        sql.push_str(" AND id IN (SELECT id FROM temp.gw_rows WHERE provider IN (");
        sql.push_str(&vec!["?"; query.providers.len()].join(","));
        sql.push_str("))");
        values.extend(query.providers.iter().cloned().map(SqlValue::Text));
    }
    append_search_filter(sql, values, query.search.as_deref());
}

fn map_stat_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StatRow> {
    Ok(StatRow {
        pricing_timestamp: None,
        id: row.get(0)?,
        tool: row.get(1)?,
        model: row.get(2)?,
        input_tokens: row.get(3)?,
        output_tokens: row.get(4)?,
        cached_tokens: row.get(5)?,
        cache_write_tokens: row.get(6)?,
        cache_write_known: row.get(11)?,
        usage_provenance: row.get(12)?,
        timestamp: row.get(7)?,
        session_id: row.get(8)?,
        cost_usd: row.get(9)?,
        machine_id: row.get(10)?,
    })
}

fn read_local_rows_filtered(
    db_path: &Path,
    query: &NormalizedStatsQuery,
    start: Option<&DateTime<Tz>>,
    end: &DateTime<Tz>,
    entity: Option<&NormalizedEntitySelector>,
) -> Result<Vec<StatRow>, String> {
    let conn = gateway_overlay::open_stats_connection(db_path)?;
    let mut sql = "SELECT id, tool, model, input_tokens, output_tokens, cached_tokens, \
                   cache_write_tokens, timestamp, session_id, cost_usd, machine_id, cache_write_known, usage_provenance \
                   FROM token_logs WHERE 1 = 1"
        .to_string();
    let mut values = Vec::new();
    append_stats_filters_with_entity(&mut sql, &mut values, start, end, query, entity);
    sql.push_str(" ORDER BY timestamp DESC, id DESC");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), map_stat_row)
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) mod anomaly_rows;
mod device_cloud_move;
mod gateway_cloud;
mod gateway_overlay;
pub mod gateway_request_log;
pub mod magpie_import;
pub mod peer_shared;
mod price_feed;
mod price_memo;
mod price_repricing;
mod price_schedule;
mod scanner_sync;
mod sync_history_guard;
pub mod wallpaper_preview;
use price_memo::{CacheSavingsParts, PriceMemo, RowPrice};
#[cfg(test)]
#[path = "cache_savings_tests.rs"]
mod cache_savings_tests;

#[derive(Debug, Clone)]
struct SummaryAccumulator {
    input: i64,
    output: i64,
    cached: i64,
    cache_read: i64,
    cache_write: i64,
    /// 缓存读取节省（即 `cacheSavedUsd`）、写入溢价与兜底计数（T10.183）。
    cache_savings: CacheSavingsParts,
    cost: f64,
    requests: i64,
    cache_split_proven: bool,
}

impl Default for SummaryAccumulator {
    fn default() -> Self {
        Self {
            input: 0,
            output: 0,
            cached: 0,
            cache_read: 0,
            cache_write: 0,
            cache_savings: CacheSavingsParts::default(),
            cost: 0.0,
            requests: 0,
            cache_split_proven: true,
        }
    }
}

impl SummaryAccumulator {
    /// `price` 来自本次调用的 `PriceMemo::row_price`，与逐行 `estimate_cost` /
    /// `estimate_cache_savings_parts` 结果逐位一致（T10.167、T10.183）。
    fn add_row(&mut self, row: &StatRow, price: RowPrice) {
        self.input += row.input_tokens;
        self.output += row.output_tokens;
        self.cached += row.cached_tokens;
        self.cache_read += row.cache_read_tokens();
        self.cache_write += row.cache_write_tokens;
        self.cache_savings.add(price.cache);
        self.cache_split_proven &= row.cache_split_is_proven();
        self.cost += price.cost;
        self.requests += 1;
    }

    fn effective_tokens(&self) -> i64 {
        effective_tokens(self.input, self.output)
    }

    fn as_json(&self) -> Value {
        let effective = self.effective_tokens();
        let average = if self.requests > 0 {
            (effective as f64 / self.requests as f64).round() as i64
        } else {
            0
        };
        let mut summary = json!({
            "totalTokens": effective,
            "inputTokens": self.input,
            "outputTokens": self.output,
            "cachedTokens": self.cached,
            "totalCost": self.cost,
            "totalRequests": self.requests,
            "avgTokensPerReq": average
        });
        if self.cache_split_proven {
            let object = summary
                .as_object_mut()
                .expect("summary accumulator JSON is an object");
            object.insert("cacheReadTokens".to_string(), json!(self.cache_read));
            object.insert("cacheWriteTokens".to_string(), json!(self.cache_write));
            object.insert(
                "cacheSavedUsd".to_string(),
                json!(self.cache_savings.read_saved),
            );
            // 契约 §2.4：与读写拆分同一门槛，缺失即不可得（T10.183）。
            object.insert(
                "cacheSavings".to_string(),
                self.cache_savings.local_prices_json(),
            );
        }
        summary
    }
}

fn comparison_period(
    rows: &[StatRow],
    start: NaiveDateTime,
    end: NaiveDateTime,
    bucket: ComparisonBucket,
    slot_count: usize,
    memo: &mut PriceMemo<'_>,
) -> (SummaryAccumulator, Vec<Value>) {
    let mut slots = vec![SummaryAccumulator::default(); slot_count];
    let mut summary = SummaryAccumulator::default();
    // 窗口边界按存储格式只格式化一次；此前每行都重新格式化两次（T10.167）。
    let window_start = storage_timestamp(start);
    let window_end = storage_timestamp(end);

    for row in rows {
        if row.timestamp < window_start || row.timestamp > window_end {
            continue;
        }
        let Ok(timestamp) = NaiveDateTime::parse_from_str(&row.timestamp, "%Y-%m-%d %H:%M:%S")
        else {
            continue;
        };
        let index = match bucket {
            ComparisonBucket::Hour => (timestamp - start).num_hours(),
            ComparisonBucket::Day => (timestamp.date() - start.date()).num_days(),
        };
        if index < 0 || index as usize >= slots.len() {
            continue;
        }
        let price = memo.row_price(row);
        summary.add_row(row, price);
        slots[index as usize].add_row(row, price);
    }

    let series = slots
        .into_iter()
        .enumerate()
        .map(|(index, slot)| {
            let bucket_label = match bucket {
                ComparisonBucket::Hour => (start + Duration::hours(index as i64))
                    .format("%H:00")
                    .to_string(),
                ComparisonBucket::Day => (start + Duration::days(index as i64))
                    .format("%Y-%m-%d")
                    .to_string(),
            };
            json!({
                "bucket": bucket_label,
                "tokens": slot.effective_tokens(),
                "requests": slot.requests,
                "cost": slot.cost
            })
        })
        .collect();

    (summary, series)
}

fn comparison_slot_count(
    start: NaiveDateTime,
    end: NaiveDateTime,
    bucket: ComparisonBucket,
) -> usize {
    match bucket {
        ComparisonBucket::Hour => (end - start).num_hours().max(0) as usize + 1,
        ComparisonBucket::Day => (end.date() - start.date()).num_days().max(0) as usize + 1,
    }
}

fn delta_direction(current: f64, previous: f64) -> &'static str {
    if previous == 0.0 && current > 0.0 {
        "new"
    } else if (current - previous).abs() < f64::EPSILON {
        "flat"
    } else if current > previous {
        "up"
    } else {
        "down"
    }
}

fn delta_value(current: f64, previous: f64, integer: bool) -> Value {
    let percent = if previous == 0.0 {
        Value::Null
    } else {
        json!(((current - previous) / previous) * 100.0)
    };
    let absolute = current - previous;
    json!({
        "absolute": if integer { json!(absolute as i64) } else { json!(absolute) },
        "percent": percent,
        "direction": delta_direction(current, previous)
    })
}

fn build_comparison(
    rows: &[StatRow],
    window: &ComparisonWindow,
    query: &NormalizedStatsQuery,
    prices: &Value,
) -> Value {
    // Resolved DateTimes remain the SQL envelope and response boundaries.
    // Bucket aggregation uses the originally requested wall-clock progress so
    // a spring gap resolving to 03:00 does not add a fourth bucket to only one
    // period. A fall fold likewise remains one shared wall-clock hour bucket.
    let current_start = window.current_start.naive_local();
    let current_end = window
        .current_end
        .date_naive()
        .and_time(window.aligned_time);
    let previous_start = window.previous_start.naive_local();
    let previous_end = window
        .previous_end
        .date_naive()
        .and_time(window.aligned_time);
    let slot_count = comparison_slot_count(current_start, current_end, window.bucket);
    let mut memo = PriceMemo::new(prices);
    let (current, current_series) = comparison_period(
        rows,
        current_start,
        current_end,
        window.bucket,
        slot_count,
        &mut memo,
    );
    let (previous, previous_series) = comparison_period(
        rows,
        previous_start,
        previous_end,
        window.bucket,
        slot_count,
        &mut memo,
    );
    let current_tokens = current.effective_tokens();
    let previous_tokens = previous.effective_tokens();

    json!({
        "window": {
            "kind": window.kind,
            "timezone": query.timezone,
            "bucket": window.bucket.as_str(),
            "currentStart": window.current_start.to_rfc3339(),
            "currentEnd": window.current_end.to_rfc3339(),
            "previousStart": window.previous_start.to_rfc3339(),
            "previousEnd": window.previous_end.to_rfc3339(),
            "alignedThrough": current_end.format("%Y-%m-%d %H:%M").to_string()
        },
        "current": {
            "summary": current.as_json(),
            "series": current_series
        },
        "previous": {
            "summary": previous.as_json(),
            "series": previous_series
        },
        "delta": {
            "tokens": delta_value(current_tokens as f64, previous_tokens as f64, true),
            "requests": delta_value(current.requests as f64, previous.requests as f64, true),
            "cost": delta_value(current.cost, previous.cost, false)
        }
    })
}

fn insert_stats_v2_fields(
    stats: &mut Value,
    rows: &[StatRow],
    bounds: &QueryBounds,
    query: &NormalizedStatsQuery,
    prices: &Value,
    now: DateTime<Tz>,
    entity: Option<&NormalizedEntitySelector>,
) {
    let Some(root) = stats.as_object_mut() else {
        return;
    };
    if let Some(window) = &bounds.comparison {
        root.insert(
            "comparison".to_string(),
            build_comparison(rows, window, query, prices),
        );
    }
    let mut meta = json!({
        "contractVersion": 2,
        "generatedAt": now.to_rfc3339(),
        "lastRefreshedAt": Value::Null,
        "timezone": query.timezone,
        "range": query.range.as_str(),
        "stale": false,
        "query": query.echo_json(),
        "capabilities": {
            "comparison": bounds.comparison.is_some(),
            "detailPagination": true,
            "entityDashboard": true,
            "multiFilterSearch": true,
            "quotaSnapshots": false,
            // 契约 §2.4：本机按缓存净节省口径计算（T10.183）。
            "cacheSavings": true
        }
    });
    let meta_object = meta.as_object_mut().expect("local stats meta is an object");
    if let Some(machine) = singular_compat_value(&query.machines) {
        meta_object.insert("machine".to_string(), machine);
    }
    if let Some(entity) = entity {
        meta_object.insert("entity".to_string(), entity_json(entity));
    }
    root.insert("meta".to_string(), meta);
}

fn earliest_query_start(bounds: &QueryBounds) -> Option<&DateTime<Tz>> {
    bounds
        .comparison
        .as_ref()
        .map(|window| &window.previous_start)
        .or(bounds.current_start.as_ref())
}

fn get_local_stats_v2_impl_at(
    app: &AppContext,
    query: LocalStatsQuery,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let query = NormalizedStatsQuery::from_query(query)?;
    Ok(get_local_stats_v2_snapshot_at(app, query, now)?.stats)
}

struct LocalStatsSnapshot {
    stats: Value,
    rows: Vec<StatRow>,
    bounds: QueryBounds,
    query: NormalizedStatsQuery,
    prices: Value,
    zoned_now: DateTime<Tz>,
}

fn get_local_stats_v2_snapshot_at(
    app: &AppContext,
    query: NormalizedStatsQuery,
    now: DateTime<Local>,
) -> Result<LocalStatsSnapshot, String> {
    get_local_stats_v2_snapshot_with_entity_at(app, query, None, now)
}

fn get_local_stats_v2_snapshot_with_entity_at(
    app: &AppContext,
    query: NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
    now: DateTime<Local>,
) -> Result<LocalStatsSnapshot, String> {
    let zoned_now = now.with_timezone(&query.tz);
    let bounds = query_bounds(query.range, zoned_now)?;
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let prices = load_prices(app);
    let storage_rows = read_local_rows_filtered(
        &db_path,
        &query,
        earliest_query_start(&bounds),
        &bounds.current_end,
        entity,
    )?;
    let rows = rows_in_timezone(&storage_rows, query.tz)?;
    let mut stats = aggregate_rows_for_window(
        &rows,
        query.range,
        &prices,
        zoned_now.naive_local(),
        bounds.current_start.as_ref().map(DateTime::naive_local),
        bounds.current_end.naive_local(),
    );
    insert_stats_v2_fields(
        &mut stats, &rows, &bounds, &query, &prices, zoned_now, entity,
    );
    if let Some(signature) = gateway_overlay::ledger_signature(&db_path) {
        stats["meta"]["capabilities"]["gatewayLedger"] = json!(true);
        if entity.is_none() {
            let providers = gateway_overlay::row_providers(&db_path, &signature)?;
            stats["providers"] = aggregate_provider_split(
                &rows,
                &providers,
                &prices,
                bounds.current_start.as_ref().map(DateTime::naive_local),
                bounds.current_end.naive_local(),
            );
            let contexts = gateway_overlay::row_contexts(&db_path, &signature)?;
            if let Some(composition) = aggregate_context_composition(
                &rows,
                &contexts,
                bounds.current_start.as_ref().map(DateTime::naive_local),
                bounds.current_end.naive_local(),
            ) {
                stats["contextComposition"] = composition;
            }
        }
    }
    Ok(LocalStatsSnapshot {
        stats,
        rows,
        bounds,
        query,
        prices,
        zoned_now,
    })
}

// TODO(T7.3b 跟进)：v1 命令移除后本函数暂无调用方，保留待后续统一清理；allow 防止 clippy -D warnings 门禁误伤。
#[allow(dead_code)]
pub fn get_local_stats_v2_impl(app: &AppContext, query: LocalStatsQuery) -> Result<Value, String> {
    get_local_stats_v2_impl_at(app, query, Local::now())
}

/// 聚合本机完整账本的行为分析数据。这里故意不复用 Stats v2 的 `history`
/// 数组：该数组是给首页展示的 200 条样本，而行为分析必须覆盖查询区间内的
/// 全部 token_logs 行。`projects` 是契约 v1.2 的可选项目筛选，`None` 与空数组
/// 都表示不筛选。
pub fn get_local_behavior_analysis_impl(
    app: &AppContext,
    query: LocalStatsQuery,
    projects: Option<&[String]>,
) -> Result<Value, String> {
    local_behavior_analysis_at(app, query, projects, Local::now())
}

/// 不带项目筛选的入口，与只发 `query` 的旧客户端走同一路径（测试与性能基线沿用）。
#[cfg(test)]
pub(crate) fn get_local_behavior_analysis_impl_at(
    app: &AppContext,
    raw_query: LocalStatsQuery,
    now: DateTime<Local>,
) -> Result<Value, String> {
    local_behavior_analysis_at(app, raw_query, None, now)
}

pub(crate) fn local_behavior_analysis_at(
    app: &AppContext,
    raw_query: LocalStatsQuery,
    projects: Option<&[String]>,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let query = NormalizedStatsQuery::from_query(raw_query)?;
    let zoned_now = now.with_timezone(&query.tz);
    let bounds = query_bounds(query.range, zoned_now)?;
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|error| error.to_string())?;
    let filter = BehaviorProjectFilter::from_request(projects);
    // 项目索引只读（契约 v1.2）。未采集时不读任何会话归属；此时带非空筛选直接报错，
    // 不把未过滤的数据当作过滤结果返回。索引读不出来时降级（root 决定 R-32）：不带
    // 筛选就省略项目维度，照常返回 v1.1 字段；带筛选返回固定错误码，从不外露 SQLite 原文。
    let index = match behavior_view::load(&db_path) {
        Ok(index) => Some(index),
        Err(_) if filter.is_some() => return Err(PROJECT_DIMENSION_UNAVAILABLE.to_string()),
        Err(_) => None,
    };
    let view = match &index {
        Some(ProjectIndexView::Off { .. }) if filter.is_some() => {
            return Err(PROJECT_DIMENSION_DISABLED.to_string());
        }
        Some(ProjectIndexView::On(view)) => Some(view),
        Some(ProjectIndexView::Off { .. }) | None => None,
    };
    let window = behavior_window(
        &db_path,
        &query,
        &bounds,
        zoned_now,
        view.zip(filter.as_ref()),
    )?;
    // The storage-time copy is a temporary: only the selected-zone rows stay alive.
    let mut rows = rows_in_timezone(
        &read_local_rows_filtered(
            &db_path,
            &query,
            window.start.as_ref(),
            &bounds.current_end,
            None,
        )?,
        query.tz,
    )?;
    let projects = match &index {
        None => BehaviorProjectScope::Unavailable,
        Some(ProjectIndexView::Off { state }) => BehaviorProjectScope::Off(state),
        Some(ProjectIndexView::On(view)) => {
            // Coverage counts ignore the project filter; the filter then applies
            // to every dimension, including the project fields themselves.
            let (indexed_sessions, pending_sessions) = behavior_index_coverage(view, &rows);
            if let Some(filter) = &filter {
                rows.retain(|row| {
                    filter.matches(view, behavior_place(view, &row.tool, &row.session_id))
                });
            }
            BehaviorProjectScope::On {
                view,
                filter: filter.as_ref(),
                indexed_sessions,
                pending_sessions,
            }
        }
    };
    let prices = load_prices(app);
    build_local_behavior_analysis(
        rows, &query, &bounds, &window, &prices, zoned_now, &projects,
    )
}

/// 行为分析实际扫描的区间。预设与自定义范围沿用 Stats v2 的 `query_bounds`（预设忽略
/// start/end，按所选时区的本地日历取今日、本周一、本月 1 日、1 月 1 日起至当前时刻）；
/// `all` 在行为分析里只覆盖截至今天的最近 `MAX_CUSTOM_RANGE_DAYS` 个本地日历日，
/// 与自定义范围同一上限，避免对多年账本做无界全量聚合。
struct BehaviorWindow {
    start: Option<DateTime<Tz>>,
    /// 仅 `all`：窗口之前仍有符合同一过滤条件的本机记录。
    truncated: bool,
}

fn behavior_window(
    db_path: &Path,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    now: DateTime<Tz>,
    projects: Option<(&CollectingView, &BehaviorProjectFilter)>,
) -> Result<BehaviorWindow, String> {
    if query.range != StatsRange::All {
        return Ok(BehaviorWindow {
            start: bounds.current_start,
            truncated: false,
        });
    }
    let first_day = now.date_naive() - Duration::days(MAX_CUSTOM_RANGE_DAYS - 1);
    let start = resolve_wall_time(now.timezone(), midnight(first_day), BoundarySide::Start)?;
    Ok(BehaviorWindow {
        start: Some(start),
        truncated: behavior_rows_exist_before(db_path, query, &start, projects)?,
    })
}

/// 同一过滤条件下，`start` 之前是否还有本机记录。复用窗口查询的过滤构造，保证
/// 设备/工具/模型/搜索口径一致；存储时间精确到秒，`<= start - 1s` 即 `< start`。
/// 项目筛选（契约 v1.2）也是过滤条件：带筛选时逐行按项目归属判断，命中即停。
fn behavior_rows_exist_before(
    db_path: &Path,
    query: &NormalizedStatsQuery,
    start: &DateTime<Tz>,
    projects: Option<(&CollectingView, &BehaviorProjectFilter)>,
) -> Result<bool, String> {
    let conn = gateway_overlay::open_stats_connection(db_path)?;
    let before = *start - Duration::seconds(1);
    let mut values = Vec::new();
    let Some((view, filter)) = projects else {
        let mut sql = "SELECT EXISTS(SELECT 1 FROM token_logs WHERE 1 = 1".to_string();
        append_stats_filters_with_entity(&mut sql, &mut values, None, &before, query, None);
        sql.push(')');
        return conn
            .query_row(&sql, params_from_iter(values.iter()), |row| {
                row.get::<_, i64>(0)
            })
            .map(|exists| exists != 0)
            .map_err(|error| error.to_string());
    };
    let mut sql = "SELECT tool, session_id FROM token_logs WHERE 1 = 1".to_string();
    append_stats_filters_with_entity(&mut sql, &mut values, None, &before, query, None);
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let mut rows = statement
        .query(params_from_iter(values.iter()))
        .map_err(|error| error.to_string())?;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let tool: String = row.get(0).map_err(|error| error.to_string())?;
        let session_id: String = row.get(1).map_err(|error| error.to_string())?;
        if filter.matches(view, behavior_place(view, &tool, &session_id)) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn behavior_date_range(
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    window: &BehaviorWindow,
    first_record_at: Option<&str>,
    now: DateTime<Tz>,
) -> (NaiveDate, NaiveDate) {
    let start = query
        .range
        .custom_bounds()
        .map(|value| value.0)
        .or_else(|| bounds.current_start.as_ref().map(DateTime::date_naive))
        // A truncated `all` starts at the capped window; otherwise at the
        // oldest selected record so the axis carries no empty prefix.
        .or_else(|| {
            window
                .start
                .filter(|_| window.truncated)
                .map(|start| start.date_naive())
        })
        .or_else(|| {
            first_record_at
                .and_then(|timestamp| timestamp.get(..10))
                .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        })
        .unwrap_or_else(|| now.date_naive());
    let end = bounds.current_end.date_naive();
    (start, end.max(start))
}

/// 扫描器在来源缺少会话标识时写入的占位值（MiniMax、Marvis、部分 opencode 类日志等）。
/// 逐轮分析（`session_analysis::resolver`）同样把它视为缺少会话元数据。
const BEHAVIOR_UNKNOWN_SESSION_ID: &str = "unknown_session";

/// 行为分析里的真实会话 ID：空值、纯空白与占位值都视为缺失，不能被合并成一个“会话”。
/// 无会话的网关记录带合成 ID（契约 §2.5），同样不算会话，否则每个请求各成一个会话。
fn behavior_session_id(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()
        && trimmed != BEHAVIOR_UNKNOWN_SESSION_ID
        && !gateway_overlay::is_synthetic_session(trimmed))
    .then_some(raw)
}

// -----------------------------------------------------------------------------
// 项目维度（行为契约 v1.2，T10.182）。项目归属只读自本机项目索引
// （`project_index::behavior_view`，用户开启后才有数据）；本命令不写索引。
// 项目数据只出现在本命令的响应里，不进入 Stats v2、云同步或导出。
// -----------------------------------------------------------------------------

use crate::project_index::behavior_view::{
    self, CollectingView, ProjectEntry, ProjectIndexView, SessionPlace,
};

/// 项目维度未开启或授权版本过低时，带非空 `projects` 筛选返回的错误码。
const PROJECT_DIMENSION_DISABLED: &str = "project_dimension_disabled";
/// 本机项目索引读不出来时，带非空 `projects` 筛选返回的错误码（不带筛选时省略项目维度）。
const PROJECT_DIMENSION_UNAVAILABLE: &str = "project_dimension_unavailable";
/// 项目筛选的保留值：全部未归属。
const BEHAVIOR_UNATTRIBUTED_KEY: &str = "@unattributed";
/// `projects[]` 最多返回的项目数，其余合并进 `projectsRemainder`。
const BEHAVIOR_PROJECT_LIMIT: usize = 50;

/// 无法归到项目的原因（`unattributed.reasons[].reason`），声明顺序即输出顺序。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UnattributedReason {
    /// 来源不记录工作目录。
    UnsupportedSource,
    /// 来源支持，但日志已清理或不可读、缺字段、路径无效或超出读取上限。
    Unresolved,
    /// 尚未建立索引：会话还没有索引行。
    Pending,
    /// 缺少会话 ID：与 v1.1 `unknownSession*` 是同一批记录。
    MissingSession,
}

impl UnattributedReason {
    const ALL: [Self; 4] = [
        Self::UnsupportedSource,
        Self::Unresolved,
        Self::Pending,
        Self::MissingSession,
    ];

    fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedSource => "unsupported_source",
            Self::Unresolved => "unresolved",
            Self::Pending => "pending",
            Self::MissingSession => "missing_session",
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

/// 一条记录在项目维度中的归属。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BehaviorPlace {
    /// `CollectingView::projects` 的下标：命名项目或固定分组。
    Project(usize),
    Unattributed(UnattributedReason),
}

fn behavior_place(view: &CollectingView, tool: &str, raw_session_id: &str) -> BehaviorPlace {
    match behavior_session_id(raw_session_id) {
        Some(session_id) => session_place(view, tool, session_id),
        None => BehaviorPlace::Unattributed(UnattributedReason::MissingSession),
    }
}

/// 真实会话的归属；索引里还没有行的会话算“尚未建立索引”。
fn session_place(view: &CollectingView, tool: &str, session_id: &str) -> BehaviorPlace {
    match view.place(tool, session_id) {
        Some(SessionPlace::Project(index)) => BehaviorPlace::Project(index),
        Some(SessionPlace::UnsupportedSource) => {
            BehaviorPlace::Unattributed(UnattributedReason::UnsupportedSource)
        }
        Some(SessionPlace::Unresolved) => {
            BehaviorPlace::Unattributed(UnattributedReason::Unresolved)
        }
        None => BehaviorPlace::Unattributed(UnattributedReason::Pending),
    }
}

/// 项目筛选：取值是响应返回的不透明 `key`，另有保留值 `@unattributed`（全部未归属）。
/// 不认识的键不匹配任何记录，也不报错。
struct BehaviorProjectFilter {
    /// 去重后按码点序，原样回显到 `meta.projectDimension.filter`。
    keys: Vec<String>,
    unattributed: bool,
}

impl BehaviorProjectFilter {
    /// `None` 与空数组都表示不筛选。
    fn from_request(projects: Option<&[String]>) -> Option<Self> {
        let projects = projects.filter(|keys| !keys.is_empty())?;
        let mut keys = projects.to_vec();
        keys.sort_unstable();
        keys.dedup();
        let unattributed = keys.iter().any(|key| key == BEHAVIOR_UNATTRIBUTED_KEY);
        Some(Self { keys, unattributed })
    }

    fn matches(&self, view: &CollectingView, place: BehaviorPlace) -> bool {
        match place {
            BehaviorPlace::Project(index) => {
                self.keys.binary_search(&view.projects[index].key).is_ok()
            }
            BehaviorPlace::Unattributed(_) => self.unattributed,
        }
    }
}

/// 一次行为聚合的项目维度。
enum BehaviorProjectScope<'v> {
    /// 项目索引读不出来（R-32）：省略 `meta.projectDimension`，与不支持项目维度的
    /// 后端相同，其余字段照常。
    Unavailable,
    /// 未开启（`disabled`）或授权版本过低（`consent_required`）：只报告
    /// `meta.projectDimension.state`，不输出任何项目内容。
    Off(&'static str),
    /// 采集中（`indexing`、`ready`、`failed`）。
    On {
        view: &'v CollectingView,
        filter: Option<&'v BehaviorProjectFilter>,
        /// 所选范围内（不计项目筛选）已有、尚无索引行的真实会话数。
        indexed_sessions: usize,
        pending_sessions: usize,
    },
}

impl<'v> BehaviorProjectScope<'v> {
    fn view(&self) -> Option<&'v CollectingView> {
        match self {
            Self::On { view, .. } => Some(view),
            Self::Off(_) | Self::Unavailable => None,
        }
    }
}

/// 所选范围内（不计项目筛选）已有索引行与尚无索引行的真实会话数。
fn behavior_index_coverage(view: &CollectingView, rows: &[StatRow]) -> (usize, usize) {
    let mut seen: HashSet<(&str, &str)> = HashSet::new();
    let (mut indexed, mut pending) = (0, 0);
    for row in rows {
        let Some(session_id) = behavior_session_id(&row.session_id) else {
            continue;
        };
        if seen.insert((row.tool.as_str(), session_id)) {
            if view.place(&row.tool, session_id).is_some() {
                indexed += 1;
            } else {
                pending += 1;
            }
        }
    }
    (indexed, pending)
}

/// 一个项目、固定分组或一类未归属在所选区间内的聚合。
struct BehaviorProjectTotals<'a> {
    tokens: i64,
    requests: i64,
    session_count: i64,
    /// D5① 的单条估价之和；任一记录不可得即为 `None`，不记 0，也不只加已知部分。
    cost: Option<f64>,
    tools: HashMap<&'a str, i64>,
}

impl<'a> BehaviorProjectTotals<'a> {
    fn new() -> Self {
        Self {
            tokens: 0,
            requests: 0,
            session_count: 0,
            cost: Some(0.0),
            tools: HashMap::new(),
        }
    }

    fn add(&mut self, tool: &'a str, tokens: i64, cost: Option<f64>) {
        self.tokens += tokens;
        self.requests += 1;
        add_behavior_cost(&mut self.cost, cost);
        *self.tools.entry(tool).or_insert(0) += tokens;
    }

    /// 合计（项目余量、未归属合计）；工具构成不参与。
    fn absorb(&mut self, other: &Self) {
        self.tokens += other.tokens;
        self.requests += other.requests;
        self.session_count += other.session_count;
        add_behavior_cost(&mut self.cost, other.cost);
    }

    /// `[{ id, tokens }]`，按有效 Token 倒序、同值按工具名字节序。
    fn tool_rows(&self) -> Vec<Value> {
        let mut tools: Vec<(&str, i64)> = self
            .tools
            .iter()
            .map(|(id, tokens)| (*id, *tokens))
            .collect();
        tools.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        tools
            .into_iter()
            .map(|(id, tokens)| json!({ "id": id, "tokens": tokens }))
            .collect()
    }
}

/// 占比的分母是 `summary.tokens`（含未归属）；分母为 0 时不可得（`null`），不写 0。
fn behavior_share(tokens: i64, total: i64) -> Option<f64> {
    (total > 0).then(|| tokens as f64 / total as f64)
}

fn behavior_project_ref(entry: &ProjectEntry) -> Value {
    json!({ "key": entry.key, "label": entry.label, "kind": entry.kind })
}

/// 写入 v1.2 项目字段。未采集时只写 `meta.projectDimension.state`；索引读不出来时什么都不写。
fn insert_behavior_projects(
    result: &mut Value,
    scope: &BehaviorProjectScope<'_>,
    project_totals: HashMap<usize, BehaviorProjectTotals<'_>>,
    unattributed: &[BehaviorProjectTotals<'_>],
    total_tokens: i64,
) {
    let (view, filter, indexed_sessions, pending_sessions) = match scope {
        BehaviorProjectScope::Unavailable => return,
        BehaviorProjectScope::Off(state) => {
            result["meta"]["projectDimension"] = json!({ "state": state });
            return;
        }
        BehaviorProjectScope::On {
            view,
            filter,
            indexed_sessions,
            pending_sessions,
        } => (*view, *filter, *indexed_sessions, *pending_sessions),
    };
    let mut dimension = json!({
        "state": view.state,
        "indexedSessions": indexed_sessions,
        "pendingSessions": pending_sessions,
        "filter": filter.map_or(&[][..], |filter| filter.keys.as_slice()),
    });
    if view.state == "failed" {
        // Only a fixed backfill code or null: never a path or raw error text.
        dimension["lastFailure"] = json!(view.last_failure);
    }
    result["meta"]["projectDimension"] = dimension;

    let mut ranked: Vec<_> = project_totals.into_iter().collect();
    ranked.sort_by(|(a_index, a), (b_index, b)| {
        b.tokens.cmp(&a.tokens).then_with(|| {
            view.projects[*a_index]
                .key
                .cmp(&view.projects[*b_index].key)
        })
    });
    let rest = if ranked.len() > BEHAVIOR_PROJECT_LIMIT {
        ranked.split_off(BEHAVIOR_PROJECT_LIMIT)
    } else {
        Vec::new()
    };
    let project_rows: Vec<Value> = ranked
        .iter()
        .map(|(index, totals)| {
            let entry = &view.projects[*index];
            json!({
                "key": entry.key,
                "label": entry.label,
                "kind": entry.kind,
                "tokens": totals.tokens,
                "requests": totals.requests,
                "sessionCount": totals.session_count,
                "cost": totals.cost,
                "share": behavior_share(totals.tokens, total_tokens),
                "tools": totals.tool_rows()
            })
        })
        .collect();
    let remainder = if rest.is_empty() {
        Value::Null
    } else {
        let mut sum = BehaviorProjectTotals::new();
        for (_, totals) in &rest {
            sum.absorb(totals);
        }
        json!({
            "tokens": sum.tokens,
            "requests": sum.requests,
            "sessionCount": sum.session_count,
            "cost": sum.cost,
            "share": behavior_share(sum.tokens, total_tokens),
            "projectCount": rest.len()
        })
    };
    let mut all = BehaviorProjectTotals::new();
    let mut reasons = Vec::new();
    for reason in UnattributedReason::ALL {
        let totals = &unattributed[reason.index()];
        all.absorb(totals);
        if totals.requests > 0 {
            reasons.push(json!({
                "reason": reason.as_str(),
                "tokens": totals.tokens,
                "requests": totals.requests,
                // Records without a session ID are no sessions: the count is
                // unknown (null), never 0.
                "sessionCount": (reason != UnattributedReason::MissingSession)
                    .then_some(totals.session_count),
                "share": behavior_share(totals.tokens, total_tokens)
            }));
        }
    }
    if let Some(object) = result.as_object_mut() {
        object.insert("projects".to_string(), Value::Array(project_rows));
        object.insert("projectLimit".to_string(), json!(BEHAVIOR_PROJECT_LIMIT));
        object.insert("projectsTruncated".to_string(), json!(!rest.is_empty()));
        object.insert("projectsRemainder".to_string(), remainder);
        object.insert(
            "unattributed".to_string(),
            json!({
                "tokens": all.tokens,
                "requests": all.requests,
                "sessionCount": all.session_count,
                "cost": all.cost,
                "share": behavior_share(all.tokens, total_tokens),
                "reasons": reasons
            }),
        );
    }
}

/// 一次行为聚合内的记录估价。价格表在一次聚合内不变，`lookup_model_prices` 只取决于
/// 价格表、工具与模型，所以按 (工具, 模型) 缓存匹配到的价格项后，再经同一
/// `estimate_cost_with_price` 计价，结果与逐行 `estimate_cost_at` 逐位相同；省掉的是每行
/// 对整张价格表的最长匹配与字符串分配。
struct BehaviorPricer<'p, 'r> {
    prices: &'p Value,
    matched: HashMap<(&'r str, &'r str), &'p Value>,
}

impl<'p, 'r> BehaviorPricer<'p, 'r> {
    fn new(prices: &'p Value) -> Self {
        Self {
            prices,
            matched: HashMap::new(),
        }
    }

    /// 一条记录的预估费用（USD），与 Stats v2 本机 `summary.totalCost` 同源同口径：已存
    /// `cost_usd` 优先，缺失时按当前价格表估算（最长模型匹配 → 工具回退 → `default`）。
    /// 结果不是有限的非负数（损坏的存储值）时视为不可得，绝不按 0 计入。
    fn row_cost(&mut self, row: &'r StatRow) -> Option<f64> {
        let cost = match row.cost_usd {
            Some(cost) => cost,
            None => {
                let prices = self.prices;
                let price = *self
                    .matched
                    .entry((row.tool.as_str(), row.model.as_str()))
                    .or_insert_with(|| lookup_model_prices(prices, &row.tool, &row.model));
                let price = price_schedule::entry_for_record(
                    price,
                    &row.tool,
                    row.price_timestamp(),
                    prompt_tokens(
                        row.input_tokens,
                        row.cache_read_tokens(),
                        row.cache_write_tokens,
                    ),
                );
                estimate_cost_with_price(
                    &price,
                    row.input_tokens,
                    row.output_tokens,
                    row.cache_read_tokens(),
                    row.cache_write_tokens,
                )
            }
        };
        (cost.is_finite() && cost >= 0.0).then_some(cost)
    }
}

/// 任一记录费用不可得或累计溢出，合计即不可得；不拿部分金额冒充总额。
fn add_behavior_cost(total: &mut Option<f64>, cost: Option<f64>) {
    *total = match (*total, cost) {
        (Some(sum), Some(cost)) => Some(sum + cost).filter(|sum| sum.is_finite()),
        _ => None,
    };
}

/// 一个工具在所选区间内的聚合。
#[derive(Default)]
struct BehaviorTool<'a> {
    tokens: i64,
    requests: i64,
    session_ids: HashSet<&'a str>,
    /// 缺少会话 ID 的记录数（契约 v1.1 `tools[].unknownSessionRecords`）：让界面在工具行
    /// 注明缺失，而不是用 `sessionCount: 0` 掩盖未知（GLB-01）。
    unknown_session_records: i64,
}

/// 一个真实会话在所选区间内的聚合（D5①：费用、起止时间与主模型，只增字段）。
struct BehaviorSession<'a> {
    tokens: i64,
    requests: i64,
    cost: Option<f64>,
    first_at: &'a str,
    last_at: &'a str,
    /// (模型, 有效 Token, 记录数)。一个会话通常只用一两个模型，线性查找即可。
    models: Vec<(&'a str, i64, i64)>,
    /// 契约 v1.2：会话的项目归属，首次见到会话时查一次索引；未采集时为 `None`。
    place: Option<BehaviorPlace>,
}

impl<'a> BehaviorSession<'a> {
    fn new(timestamp: &'a str, place: Option<BehaviorPlace>) -> Self {
        Self {
            tokens: 0,
            requests: 0,
            cost: Some(0.0),
            first_at: timestamp,
            last_at: timestamp,
            models: Vec::new(),
            place,
        }
    }

    fn add(&mut self, row: &'a StatRow, tokens: i64, cost: Option<f64>) {
        self.tokens += tokens;
        self.requests += 1;
        add_behavior_cost(&mut self.cost, cost);
        // Selected-zone wall clock `YYYY-MM-DD HH:MM:SS` sorts chronologically.
        self.first_at = self.first_at.min(row.timestamp.as_str());
        self.last_at = self.last_at.max(row.timestamp.as_str());
        match self
            .models
            .iter_mut()
            .find(|(model, _, _)| *model == row.model)
        {
            Some(entry) => {
                entry.1 += tokens;
                entry.2 += 1;
            }
            None => self.models.push((row.model.as_str(), tokens, 1)),
        }
    }

    /// 会话内有效 Token 最多的模型；Token 相同取记录多者，再取模型名字节序靠前者。
    fn top_model(&self) -> Option<&'a str> {
        self.models
            .iter()
            .max_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)).then_with(|| b.0.cmp(a.0)))
            .map(|(model, _, _)| *model)
    }
}

fn percentile_nearest_rank(values: &[i64], percentile: f64) -> i64 {
    if values.is_empty() {
        return 0;
    }
    let rank = ((values.len() as f64 * percentile).ceil() as usize).max(1);
    values[rank.min(values.len()) - 1]
}

fn build_request_size_bins(values: &[i64]) -> Vec<Value> {
    if values.is_empty() {
        return vec![json!({ "lower": 0, "upper": 1000, "requests": 0 })];
    }
    const MAX_BINS: i64 = 32;
    let max = *values.iter().max().unwrap_or(&0);
    // Keep the familiar 0..1000 bucket for ordinary requests, while capping
    // work and response size for unusually large single requests.
    let thousand_buckets = max.max(0) / 1000 + 1;
    let bucket_stride = (thousand_buckets + MAX_BINS - 1) / MAX_BINS;
    let width = bucket_stride.max(1).saturating_mul(1000);
    let bin_count = ((max / width) + 1).max(1) as usize;
    let mut counts = vec![0usize; bin_count];
    for value in values {
        let index = (*value / width).max(0) as usize;
        counts[index.min(bin_count - 1)] += 1;
    }
    counts
        .into_iter()
        .enumerate()
        .map(|(index, requests)| {
            let lower = index as i64 * width;
            json!({ "lower": lower, "upper": lower.saturating_add(width), "requests": requests })
        })
        .collect()
}

fn build_local_behavior_analysis(
    rows: Vec<StatRow>,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    window: &BehaviorWindow,
    prices: &Value,
    now: DateTime<Tz>,
    projects: &BehaviorProjectScope<'_>,
) -> Result<Value, String> {
    let first_record_at = rows
        .iter()
        .map(|row| row.timestamp.as_str())
        .min()
        .map(str::to_string);
    let last_record_at = rows
        .iter()
        .map(|row| row.timestamp.as_str())
        .max()
        .map(str::to_string);
    let (range_start, range_end) =
        behavior_date_range(query, bounds, window, first_record_at.as_deref(), now);

    let mut total_tokens = 0i64;
    let mut input_tokens = 0i64;
    let mut output_tokens = 0i64;
    let mut cached_tokens = 0i64;
    let mut unknown_session_records = 0i64;
    let mut unknown_session_tokens = 0i64;
    let mut total_cost: Option<f64> = Some(0.0);
    let mut tools: HashMap<&str, BehaviorTool<'_>> = HashMap::new();
    let mut sessions: HashMap<(&str, &str), BehaviorSession<'_>> = HashMap::new();
    let mut models: HashSet<String> = HashSet::new();
    let mut active_days: HashSet<String> = HashSet::new();
    let mut day_hours: HashMap<(String, u32), (i64, i64)> = HashMap::new();
    let mut model_hours: HashMap<(u32, String), (i64, i64)> = HashMap::new();
    let mut model_days: HashMap<(String, String), (i64, i64)> = HashMap::new();
    let mut request_sizes: HashMap<String, Vec<i64>> = HashMap::new();
    let mut pricer = BehaviorPricer::new(prices);
    let project_view = projects.view();
    let mut project_totals: HashMap<usize, BehaviorProjectTotals<'_>> = HashMap::new();
    let mut unattributed: Vec<BehaviorProjectTotals<'_>> = UnattributedReason::ALL
        .iter()
        .map(|_| BehaviorProjectTotals::new())
        .collect();

    for row in &rows {
        let tokens = effective_tokens(row.input_tokens, row.output_tokens);
        let date = row.timestamp.get(..10).unwrap_or_default().to_string();
        let hour = row
            .timestamp
            .get(11..13)
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        let cost = pricer.row_cost(row);
        total_tokens += tokens;
        input_tokens += row.input_tokens;
        output_tokens += row.output_tokens;
        cached_tokens += row.cached_tokens;
        add_behavior_cost(&mut total_cost, cost);
        models.insert(row.model.clone());
        active_days.insert(date.clone());
        let tool = tools.entry(row.tool.as_str()).or_default();
        tool.tokens += tokens;
        tool.requests += 1;
        let place = if let Some(session_id) = behavior_session_id(&row.session_id) {
            tool.session_ids.insert(session_id);
            let session = sessions
                .entry((row.tool.as_str(), session_id))
                .or_insert_with(|| {
                    BehaviorSession::new(
                        &row.timestamp,
                        project_view.map(|view| session_place(view, &row.tool, session_id)),
                    )
                });
            session.add(row, tokens, cost);
            session.place
        } else {
            tool.unknown_session_records += 1;
            unknown_session_records += 1;
            unknown_session_tokens += tokens;
            project_view.map(|_| BehaviorPlace::Unattributed(UnattributedReason::MissingSession))
        };
        match place {
            Some(BehaviorPlace::Project(index)) => project_totals
                .entry(index)
                .or_insert_with(BehaviorProjectTotals::new)
                .add(&row.tool, tokens, cost),
            Some(BehaviorPlace::Unattributed(reason)) => {
                unattributed[reason.index()].add(&row.tool, tokens, cost)
            }
            None => {}
        }
        let bucket = day_hours.entry((date.clone(), hour)).or_insert((0, 0));
        bucket.0 += tokens;
        bucket.1 += 1;
        let bucket = model_hours
            .entry((hour, row.model.clone()))
            .or_insert((0, 0));
        bucket.0 += tokens;
        bucket.1 += 1;
        let bucket = model_days
            .entry((date, row.model.clone()))
            .or_insert((0, 0));
        bucket.0 += tokens;
        bucket.1 += 1;
        request_sizes
            .entry(row.model.clone())
            .or_default()
            .push(tokens);
    }

    let mut tool_rows: Vec<_> = tools
        .into_iter()
        .map(|(id, tool)| {
            json!({
                "id": id,
                "tokens": tool.tokens,
                "requests": tool.requests,
                "sessionCount": tool.session_ids.len(),
                "unknownSessionRecords": tool.unknown_session_records
            })
        })
        .collect();
    tool_rows.sort_by(|a, b| {
        b["tokens"]
            .as_i64()
            .cmp(&a["tokens"].as_i64())
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });

    // Every real session belongs to exactly one project or unattributed reason.
    for session in sessions.values() {
        match session.place {
            Some(BehaviorPlace::Project(index)) => {
                if let Some(totals) = project_totals.get_mut(&index) {
                    totals.session_count += 1;
                }
            }
            Some(BehaviorPlace::Unattributed(reason)) => {
                unattributed[reason.index()].session_count += 1;
            }
            None => {}
        }
    }

    // Rank the typed aggregates and serialize only the published top 100.
    let mut ranked_sessions: Vec<_> = sessions.into_iter().collect();
    ranked_sessions.sort_by(|((a_tool, a_id), a), ((b_tool, b_id), b)| {
        b.tokens
            .cmp(&a.tokens)
            .then_with(|| a_tool.cmp(b_tool))
            .then_with(|| a_id.cmp(b_id))
    });
    let session_count = ranked_sessions.len();
    let sessions_truncated = session_count > 100;
    ranked_sessions.truncate(100);
    let session_rows: Vec<_> = ranked_sessions
        .into_iter()
        .map(|((tool, id), session)| {
            let mut row = json!({
                "id": id,
                "tool": tool,
                "tokens": session.tokens,
                "requests": session.requests,
                "cost": session.cost,
                "firstAt": session.first_at,
                "lastAt": session.last_at,
                "topModel": session.top_model()
            });
            if let (Some(view), Some(place)) = (project_view, session.place) {
                match place {
                    BehaviorPlace::Project(index) => {
                        row["project"] = behavior_project_ref(&view.projects[index]);
                    }
                    BehaviorPlace::Unattributed(reason) => {
                        row["project"] = Value::Null;
                        row["projectReason"] = json!(reason.as_str());
                    }
                }
            }
            row
        })
        .collect();

    let mut day_hour_rows: Vec<_> = day_hours
        .into_iter()
        .map(|((date, hour), (tokens, requests))| json!({ "date": date, "hour": hour, "tokens": tokens, "requests": requests }))
        .collect();
    day_hour_rows.sort_by(|a, b| {
        a["date"]
            .as_str()
            .cmp(&b["date"].as_str())
            .then_with(|| a["hour"].as_u64().cmp(&b["hour"].as_u64()))
    });
    let mut model_hour_rows: Vec<_> = model_hours
        .into_iter()
        .map(|((hour, model), (tokens, requests))| json!({ "hour": hour, "model": model, "tokens": tokens, "requests": requests }))
        .collect();
    model_hour_rows.sort_by(|a, b| {
        a["hour"]
            .as_u64()
            .cmp(&b["hour"].as_u64())
            .then_with(|| a["model"].as_str().cmp(&b["model"].as_str()))
    });
    let mut model_day_rows: Vec<_> = model_days
        .into_iter()
        .map(|((date, model), (tokens, requests))| json!({ "date": date, "model": model, "tokens": tokens, "requests": requests }))
        .collect();
    model_day_rows.sort_by(|a, b| {
        a["date"]
            .as_str()
            .cmp(&b["date"].as_str())
            .then_with(|| a["model"].as_str().cmp(&b["model"].as_str()))
    });
    let mut request_size_rows: Vec<_> = request_sizes
        .into_iter()
        .map(|(model, mut values)| {
            values.sort_unstable();
            let requests = values.len();
            json!({
                "model": model,
                "requests": requests,
                "p50": percentile_nearest_rank(&values, 0.5),
                "p90": percentile_nearest_rank(&values, 0.9),
                "max": values.last().copied().unwrap_or(0),
                "bins": build_request_size_bins(&values)
            })
        })
        .collect();
    // The first entry is the default selection: the model with the most records,
    // not whichever model name sorts first alphabetically.
    request_size_rows.sort_by(|a, b| {
        b["requests"]
            .as_u64()
            .cmp(&a["requests"].as_u64())
            .then_with(|| a["model"].as_str().cmp(&b["model"].as_str()))
    });

    let mut result = json!({
        "meta": {
            "source": "local",
            "complete": true,
            "range": query.range.as_str(),
            "start": range_start.format("%Y-%m-%d").to_string(),
            "end": range_end.format("%Y-%m-%d").to_string(),
            "timezone": query.timezone,
            "recordCount": rows.len(),
            "firstRecordAt": first_record_at,
            "lastRecordAt": last_record_at,
            "sessionLimit": 100,
            "sessionsTruncated": sessions_truncated,
            "rangeDayLimit": MAX_CUSTOM_RANGE_DAYS,
            "rangeTruncated": window.truncated
        },
        "summary": {
            "tokens": total_tokens,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "cachedTokens": cached_tokens,
            "requests": rows.len(),
            "activeDays": active_days.len(),
            "toolCount": tool_rows.len(),
            "sessionCount": session_count,
            "modelCount": models.len(),
            "unknownSessionRecords": unknown_session_records,
            "unknownSessionTokens": unknown_session_tokens,
            "totalCost": total_cost,
            "costComplete": total_cost.is_some()
        },
        "tools": tool_rows,
        "sessions": session_rows,
        "dayHours": day_hour_rows,
        "modelHours": model_hour_rows,
        "modelDays": model_day_rows,
        "requestSizes": request_size_rows
    });
    insert_behavior_projects(
        &mut result,
        projects,
        project_totals,
        &unattributed,
        total_tokens,
    );
    Ok(result)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DetailCursor {
    timestamp: String,
    id: i64,
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("detail cursor has invalid hex length".to_string());
    }
    fn nibble(value: u8) -> Option<u8> {
        match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            b'A'..=b'F' => Some(value - b'A' + 10),
            _ => None,
        }
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = nibble(pair[0]).ok_or_else(|| "detail cursor is not hex".to_string())?;
            let low = nibble(pair[1]).ok_or_else(|| "detail cursor is not hex".to_string())?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn encode_detail_cursor(
    row: &StatRow,
    query: &NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
) -> String {
    format!(
        "v2.{}.{}.{}",
        query.fingerprint(entity),
        encode_hex(row.timestamp.as_bytes()),
        row.id
    )
}

fn decode_detail_cursor(
    value: &str,
    query: &NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
) -> Result<DetailCursor, String> {
    if value.len() > MAX_CURSOR_BYTES {
        return Err("detail cursor is too long".to_string());
    }
    let mut parts = value.split('.');
    if parts.next() != Some("v2") {
        return Err("unsupported detail cursor version".to_string());
    }
    let fingerprint = parts
        .next()
        .ok_or_else(|| "detail cursor is missing query fingerprint".to_string())?;
    if fingerprint != query.fingerprint(entity) {
        return Err("detail cursor query fingerprint does not match".to_string());
    }
    let timestamp_hex = parts
        .next()
        .ok_or_else(|| "detail cursor is missing timestamp".to_string())?;
    let id = parts
        .next()
        .ok_or_else(|| "detail cursor is missing id".to_string())?
        .parse::<i64>()
        .map_err(|_| "detail cursor id is invalid".to_string())?;
    // 网关与导入行的 id 是负数，翻页可能停在这样的行上。
    if parts.next().is_some() || id == 0 {
        return Err("detail cursor is invalid".to_string());
    }
    let timestamp = String::from_utf8(decode_hex(timestamp_hex)?)
        .map_err(|_| "detail cursor timestamp is not UTF-8".to_string())?;
    NaiveDateTime::parse_from_str(&timestamp, "%Y-%m-%d %H:%M:%S")
        .map_err(|_| "detail cursor timestamp is invalid".to_string())?;
    Ok(DetailCursor { timestamp, id })
}

fn is_legacy_detail_cursor(value: &str) -> bool {
    value.len() <= MAX_CURSOR_BYTES && value.starts_with("v1.")
}

#[allow(dead_code)]
fn query_filtered_summary(
    conn: &Connection,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    prices: &Value,
) -> Result<SummaryAccumulator, String> {
    query_filtered_summary_with_entity(conn, query, bounds, prices, None)
}

fn query_filtered_summary_with_entity(
    conn: &Connection,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    prices: &Value,
    entity: Option<&NormalizedEntitySelector>,
) -> Result<SummaryAccumulator, String> {
    // 逐行估价，与总览共用 `PriceMemo::row_price` 与 `SummaryAccumulator::add_row`
    // （T10.205，修正 T10.196 评审 O-2）。此前按 (工具, 模型) 分组，组内先把读写
    // 量各自求和、再统一取 max(合计 − 写入, 0) 估算这一组的缓存读量；同一组里有
    // 多行、其中缓存写入大于合计（拆分不可证明）时，`max` 不是线性的，分组算出的
    // 读量与逐行各自取 max 后相加不相等，明细合计因此会与总览 KPI（逐行相加）
    // 差一点。改成与总览同一逐行函数后不会再分叉，`PriceMemo` 仍按 (工具, 模型)
    // 缓存单价，逐行只多两次哈希查找与乘加，不逐行重新匹配价格表。
    let mut sql = "SELECT id, tool, model, input_tokens, output_tokens, cached_tokens, \
                   cache_write_tokens, timestamp, session_id, cost_usd, machine_id, cache_write_known, usage_provenance \
                   FROM token_logs WHERE 1 = 1"
        .to_string();
    let mut values = Vec::new();
    append_stats_filters_with_entity(
        &mut sql,
        &mut values,
        bounds.current_start.as_ref(),
        &bounds.current_end,
        query,
        entity,
    );
    sql.push_str(" ORDER BY timestamp DESC, id DESC");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), map_stat_row)
        .map_err(|e| e.to_string())?;

    let mut summary = SummaryAccumulator::default();
    let mut memo = PriceMemo::new(prices);
    for row in rows {
        let row = row.map_err(|e| e.to_string())?;
        let price = memo.row_price(&row);
        summary.add_row(&row, price);
    }
    Ok(summary)
}

/// 筛选范围内带耗时的网关与导入行：(行数, 输出 Token, 耗时毫秒)。没有这样的行时为 `None`。
fn query_timed_output_summary(
    conn: &Connection,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    entity: Option<&NormalizedEntitySelector>,
) -> Result<Option<(i64, i64, i64)>, String> {
    let mut sql = "SELECT COUNT(*), COALESCE(SUM(output_tokens), 0), COALESCE(SUM(latency_ms), 0) \
                   FROM temp.gw_rows WHERE latency_ms > 0 AND output_tokens > 0 \
                   AND id IN (SELECT id FROM token_logs WHERE 1 = 1"
        .to_string();
    let mut values = Vec::new();
    append_stats_filters_with_entity(
        &mut sql,
        &mut values,
        bounds.current_start.as_ref(),
        &bounds.current_end,
        query,
        entity,
    );
    sql.push(')');
    let (requests, output, latency): (i64, i64, i64) = conn
        .query_row(&sql, params_from_iter(values.iter()), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?;
    Ok((requests > 0).then_some((requests, output, latency)))
}

/// 契约 §2.5：有带耗时的行时，合计另带 `timedRequests` / `timedOutputTokens` / `timedLatencyMs`。
fn filtered_summary_json(summary: &SummaryAccumulator, timed: Option<(i64, i64, i64)>) -> Value {
    let mut value = summary.as_json();
    if let (Some((requests, output, latency)), Some(object)) = (timed, value.as_object_mut()) {
        object.insert("timedRequests".to_string(), json!(requests));
        object.insert("timedOutputTokens".to_string(), json!(output));
        object.insert("timedLatencyMs".to_string(), json!(latency));
    }
    value
}

#[cfg(test)]
mod details_summary_matches_overview_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn all_range_query() -> NormalizedStatsQuery {
        NormalizedStatsQuery::from_query(LocalStatsQuery {
            range: "all".to_string(),
            timezone: "UTC".to_string(),
            machines: None,
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: None,
            start: None,
            end: None,
        })
        .expect("normalize all-range query")
    }

    /// T10.205（修正 T10.196 评审 O-2）：明细合计（`filteredSummary.totalCost`）与
    /// 总览 KPI（`summary.totalCost`）在一个小账本上必须相等，账本里有两行缺费用、
    /// 同一 (工具, 模型)，其中一行缓存写入大于合计（拆分不可证明）——这类行此前在
    /// 分组估价与逐行估价之间不相等（差 −4.202e-5 一类的小数）。
    #[test]
    fn details_total_cost_matches_the_overview_total_with_a_cache_write_exceeding_row() {
        let root = std::env::temp_dir().join(format!(
            "tokenledger-details-vs-overview-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let app = AppContext::for_test(root.clone());
        let db_path = db::get_db_path(&app);
        db::init_db(&db_path).expect("initialize test database");
        {
            let conn = db::get_connection(&db_path).expect("open test database");
            // (tool, model, input, output, cached, cache_write, cost_usd, unique_key)
            let fixture = [
                (
                    "codex",
                    "gpt-5",
                    500_000,
                    100_000,
                    0,
                    0,
                    Some(2.5),
                    "priced",
                ),
                (
                    "codex",
                    "gpt-5",
                    100_000,
                    0,
                    1_000,
                    200,
                    None,
                    "cache-normal",
                ),
                // 写入(800) 大于合计(500)：拆分不可证明，触发 O-2。
                (
                    "codex",
                    "gpt-5",
                    100_000,
                    0,
                    500,
                    800,
                    None,
                    "cache-write-exceeds",
                ),
            ];
            for (tool, model, input, output, cached, cache_write, cost, key) in fixture {
                conn.execute(
                    "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, \
                     cached_tokens, cache_write_tokens, timestamp, session_id, unique_key, \
                     cost_usd, machine_id, sync_status) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-09-24 10:00:00', 'session', ?7, ?8, \
                             'machine', 0)",
                    rusqlite::params![tool, model, input, output, cached, cache_write, key, cost],
                )
                .expect("insert test log");
            }
        }

        let now = Local::now();
        let overview =
            get_local_stats_v2_snapshot_at(&app, all_range_query(), now).expect("overview stats");
        let overview_total = overview.stats["summary"]["totalCost"]
            .as_f64()
            .expect("overview totalCost must be a finite number for this fixture");

        let details = get_usage_details_normalized_at(&app, all_range_query(), None, None, 50, now)
            .expect("details");
        let details_total = details["filteredSummary"]["totalCost"]
            .as_f64()
            .expect("details totalCost must be a finite number for this fixture");

        assert_eq!(
            details_total.to_bits(),
            overview_total.to_bits(),
            "details filteredSummary.totalCost ({details_total}) must equal the overview \
             summary.totalCost ({overview_total})"
        );

        let _ = fs::remove_dir_all(root);
    }
}

#[allow(dead_code)]
fn query_detail_items(
    conn: &Connection,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    cursor: Option<&DetailCursor>,
    limit: usize,
) -> Result<Vec<StatRow>, String> {
    query_detail_items_with_entity(conn, query, bounds, cursor, limit, None)
}

fn query_detail_items_with_entity(
    conn: &Connection,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    cursor: Option<&DetailCursor>,
    limit: usize,
    entity: Option<&NormalizedEntitySelector>,
) -> Result<Vec<StatRow>, String> {
    let mut sql = "SELECT id, tool, model, input_tokens, output_tokens, cached_tokens, \
                   cache_write_tokens, timestamp, session_id, cost_usd, machine_id, cache_write_known, usage_provenance \
                   FROM token_logs WHERE 1 = 1"
        .to_string();
    let mut values = Vec::new();
    append_stats_filters_with_entity(
        &mut sql,
        &mut values,
        bounds.current_start.as_ref(),
        &bounds.current_end,
        query,
        entity,
    );
    if let Some(cursor) = cursor {
        sql.push_str(" AND (timestamp < ? OR (timestamp = ? AND id < ?))");
        values.push(SqlValue::Text(cursor.timestamp.clone()));
        values.push(SqlValue::Text(cursor.timestamp.clone()));
        values.push(SqlValue::Integer(cursor.id));
    }
    sql.push_str(" ORDER BY timestamp DESC, id DESC LIMIT ?");
    values.push(SqlValue::Integer((limit + 1) as i64));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), map_stat_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Copy)]
enum DetailFacet {
    Tool,
    Model,
    Machine,
}

impl DetailFacet {
    fn column(self) -> &'static str {
        match self {
            Self::Tool => "tool",
            Self::Model => "model",
            Self::Machine => "machine_id",
        }
    }
}

#[allow(dead_code)]
fn query_detail_facet(
    conn: &Connection,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    facet: DetailFacet,
) -> Result<Vec<Value>, String> {
    query_detail_facet_with_entity(conn, query, bounds, facet, None)
}

fn query_detail_facet_with_entity(
    conn: &Connection,
    query: &NormalizedStatsQuery,
    bounds: &QueryBounds,
    facet: DetailFacet,
    entity: Option<&NormalizedEntitySelector>,
) -> Result<Vec<Value>, String> {
    let mut facet_query = query.clone();
    match facet {
        DetailFacet::Tool => facet_query.tools.clear(),
        DetailFacet::Model => facet_query.models.clear(),
        DetailFacet::Machine => facet_query.machines.clear(),
    }
    let column = facet.column();
    let mut sql = format!(
        "SELECT {column}, COUNT(*) FROM token_logs \
         WHERE 1 = 1 AND trim({column}) <> ''"
    );
    let mut values = Vec::new();
    append_stats_filters_with_entity(
        &mut sql,
        &mut values,
        bounds.current_start.as_ref(),
        &bounds.current_end,
        &facet_query,
        entity,
    );
    sql.push_str(&format!(
        " GROUP BY {column} ORDER BY COUNT(*) DESC, {column} ASC"
    ));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), |row| {
            let value: String = row.get(0)?;
            let count: i64 = row.get(1)?;
            Ok(json!({ "value": value, "count": count }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn get_usage_details_impl_at(
    app: &AppContext,
    raw: UsageDetailsQuery,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let mut query = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: raw.range,
        timezone: raw.timezone,
        machines: raw.machines,
        machine: raw.machine,
        tools: raw.tools,
        tool: raw.tool,
        models: raw.models,
        model: raw.model,
        search: raw.search,
        token_mode: raw.token_mode.or_else(|| Some("effective".to_string())),
        start: raw.start,
        end: raw.end,
    })?;
    query.providers = crate::stats_query::normalize_providers(raw.providers)?;
    get_usage_details_normalized_at(
        app,
        query,
        None,
        raw.cursor.as_deref(),
        raw.limit.unwrap_or(50),
        now,
    )
}

fn get_usage_details_normalized_at(
    app: &AppContext,
    query: NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
    raw_cursor: Option<&str>,
    requested_limit: usize,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let limit = requested_limit.clamp(1, 100);
    let cursor = raw_cursor
        .map(ascii_trim)
        .filter(|value| !value.is_empty())
        .map(|value| decode_detail_cursor(value, &query, entity))
        .transpose()?;
    let zoned_now = now.with_timezone(&query.tz);
    let bounds = query_bounds(query.range, zoned_now)?;
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let prices = load_prices(app);

    let gateway_ledger = gateway_overlay::ledger_signature(&db_path).is_some();
    let mut conn = gateway_overlay::open_stats_connection(&db_path)?;
    if !query.providers.is_empty() {
        // 没有网关账本时没有任何账号行：给筛选一个空表，结果为空而不是报错。
        conn.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS gw_rows (id INTEGER PRIMARY KEY, provider TEXT NOT NULL)",
        )
        .map_err(|e| e.to_string())?;
    }
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let summary =
        query_filtered_summary_with_entity(&transaction, &query, &bounds, &prices, entity)?;
    let timed = if gateway_ledger {
        query_timed_output_summary(&transaction, &query, &bounds, entity)?
    } else {
        None
    };
    let mut rows = query_detail_items_with_entity(
        &transaction,
        &query,
        &bounds,
        cursor.as_ref(),
        limit,
        entity,
    )?;
    let available_tools =
        query_detail_facet_with_entity(&transaction, &query, &bounds, DetailFacet::Tool, entity)?;
    let available_models =
        query_detail_facet_with_entity(&transaction, &query, &bounds, DetailFacet::Model, entity)?;
    let available_machines = query_detail_facet_with_entity(
        &transaction,
        &query,
        &bounds,
        DetailFacet::Machine,
        entity,
    )?;
    transaction.commit().map_err(|e| e.to_string())?;

    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = has_more
        .then(|| {
            rows.last()
                .map(|row| encode_detail_cursor(row, &query, entity))
        })
        .flatten();
    let mut memo = PriceMemo::new(&prices);
    let items: Vec<Value> = rows
        .iter()
        .map(|row| -> Result<Value, String> {
            let cost = memo.row_price(row).cost;
            let mut item = json!({
                "id": row.id,
                "tool": row.tool,
                "model": row.model,
                "inputTokens": row.input_tokens,
                "outputTokens": row.output_tokens,
                "cachedTokens": row.cached_tokens,
                "cost": cost,
                "timestamp": timestamp_in_timezone(&row.timestamp, query.tz)?.to_rfc3339(),
                "sessionId": row.session_id,
                "machineId": row.machine_id,
                "granularity": "request"
            });
            let object = item
                .as_object_mut()
                .expect("local detail item is an object");
            if gateway_ledger {
                match gateway_overlay::gateway_detail(&conn, row.id) {
                    Some(detail) => {
                        object.insert("source".to_string(), json!(detail.source));
                        object.insert("provider".to_string(), json!(detail.provider));
                        if let Some(latency_ms) = detail.latency_ms {
                            object.insert("latencyMs".to_string(), json!(latency_ms));
                        }
                        if let Some(context) = detail.context {
                            object.insert("context".to_string(), json!(context));
                        }
                    }
                    None => {
                        object.insert("source".to_string(), json!("scan"));
                    }
                }
            }
            if let Some(provenance) = &row.usage_provenance {
                object.insert("usageProvenance".to_string(), json!(provenance));
            }
            if row.cache_split_is_proven() {
                object.insert(
                    "cacheReadTokens".to_string(),
                    json!(row.cache_read_tokens()),
                );
                object.insert(
                    "cacheWriteTokens".to_string(),
                    json!(row.cache_write_tokens),
                );
            }
            Ok(item)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut meta = json!({
        "contractVersion": 2,
        "scope": StatsScope::Local.as_str(),
        "generatedAt": zoned_now.to_rfc3339(),
        "timezone": query.timezone,
        "range": query.range.as_str(),
        "query": query.echo_json(),
        "capabilities": {
            "comparison": bounds.comparison.is_some(),
            "detailPagination": true,
            "entityDashboard": true,
            "multiFilterSearch": true,
            "quotaSnapshots": false,
            "cacheSavings": true
        }
    });
    let meta_object = meta
        .as_object_mut()
        .expect("local detail meta is an object");
    if gateway_ledger {
        meta_object["capabilities"]["gatewayLedger"] = json!(true);
    }
    if let Some(machine) = singular_compat_value(&query.machines) {
        meta_object.insert("machine".to_string(), machine);
    }
    if let Some(entity) = entity {
        meta_object.insert("entity".to_string(), entity_json(entity));
    }

    Ok(json!({
        "items": items,
        "nextCursor": next_cursor,
        "hasMore": has_more,
        "totalCount": summary.requests,
        "filteredSummary": filtered_summary_json(&summary, timed),
        "availableFilters": {
            "tools": available_tools,
            "models": available_models,
            "machines": available_machines
        },
        "granularity": "request",
        "meta": meta
    }))
}

pub fn get_usage_details_impl(app: &AppContext, query: UsageDetailsQuery) -> Result<Value, String> {
    get_usage_details_impl_at(app, query, Local::now())
}

#[derive(Debug, Clone)]
struct NormalizedEntityRequest {
    query: NormalizedStatsQuery,
    entity: NormalizedEntitySelector,
}

impl NormalizedEntityRequest {
    /// T10.185: same structural exclusion as `legacy_dashboard_representable` —
    /// the legacy entity RPC has no `start`/`end` parameters, so custom ranges
    /// never fall back to it.
    fn legacy_representable(&self) -> bool {
        if self.query.range.custom_bounds().is_some() {
            return false;
        }
        if self.query.machines.len() > 1 || self.query.search.is_some() {
            return false;
        }
        match self.entity.kind {
            EntityKind::Model => self.query.tools.len() <= 1 && self.query.models.is_empty(),
            EntityKind::Tool => self.query.tools.is_empty() && self.query.models.is_empty(),
        }
    }
}

fn normalize_entity_query(raw: &EntityDashboardQuery) -> Result<NormalizedEntityRequest, String> {
    let (entity, query_tools, query_models, query_tool, query_model) = if let Some(entity) =
        raw.entity.clone()
    {
        (
            NormalizedEntitySelector::from_input(entity)?,
            raw.tools.clone(),
            raw.models.clone(),
            raw.tool.clone(),
            raw.model.clone(),
        )
    } else {
        let legacy = normalize_filters(
            None,
            None,
            None,
            raw.tool.clone(),
            None,
            raw.model.clone(),
            None,
        )?;
        if raw.tools.as_ref().is_some_and(|values| !values.is_empty())
            || raw.models.as_ref().is_some_and(|values| !values.is_empty())
        {
            return Err(
                    "entity-selector-required: plural tool/model filters require entity.kind + entity.id"
                        .to_string(),
                );
        }
        let entity = if let Some(model) = legacy.models.first() {
            NormalizedEntitySelector {
                kind: EntityKind::Model,
                id: model.clone(),
            }
        } else if let Some(tool) = legacy.tools.first() {
            NormalizedEntitySelector {
                kind: EntityKind::Tool,
                id: tool.clone(),
            }
        } else {
            return Err(
                "entity-selector-required: entity dashboard requires a tool or model".to_string(),
            );
        };
        let tools = (entity.kind == EntityKind::Model).then(|| legacy.tools.clone());
        (entity, tools, Some(Vec::new()), None, None)
    };

    let query = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: raw.range.clone(),
        timezone: raw.timezone.clone(),
        machines: raw.machines.clone(),
        machine: raw.machine.clone(),
        tools: query_tools,
        tool: query_tool,
        models: query_models,
        model: query_model,
        search: raw.search.clone(),
        token_mode: raw.token_mode.clone(),
        start: raw.start.clone(),
        end: raw.end.clone(),
    })?;
    match entity.kind {
        EntityKind::Tool if !query.tools.is_empty() => {
            return Err("entity-query-conflict: tools must be empty for a tool entity".to_string())
        }
        EntityKind::Model if !query.models.is_empty() => {
            return Err(
                "entity-query-conflict: models must be empty for a model entity".to_string(),
            )
        }
        _ => {}
    }
    Ok(NormalizedEntityRequest { query, entity })
}

struct LocalEntityMetrics {
    composition: Value,
    heatmap: Value,
    peak: Value,
    activity: Value,
}

fn sort_entity_distribution(items: &mut [Value]) {
    items.sort_by(|left, right| {
        let left_tokens = left.get("tokens").and_then(Value::as_i64).unwrap_or(0);
        let right_tokens = right.get("tokens").and_then(Value::as_i64).unwrap_or(0);
        right_tokens.cmp(&left_tokens).then_with(|| {
            left.get("value")
                .and_then(Value::as_str)
                .cmp(&right.get("value").and_then(Value::as_str))
        })
    });
}

/// 聚合时用借用的键，出结果前再转成分布函数需要的 `String` 键（条目数很少）。
fn owned_keys(source: HashMap<&str, SummaryAccumulator>) -> HashMap<String, SummaryAccumulator> {
    source
        .into_iter()
        .map(|(key, summary)| (key.to_string(), summary))
        .collect()
}

fn local_token_distribution(source: HashMap<String, SummaryAccumulator>) -> Vec<Value> {
    let mut items = source
        .into_iter()
        .map(|(value, summary)| {
            let mut item = json!({
                "value": value,
                "tokens": summary.effective_tokens(),
                "inputTokens": summary.input,
                "outputTokens": summary.output,
                "cachedTokens": summary.cached,
                "requests": summary.requests,
                "cost": summary.cost
            });
            if summary.cache_split_proven {
                item.as_object_mut()
                    .expect("local token distribution item is an object")
                    .insert("cacheWriteTokens".to_string(), json!(summary.cache_write));
            }
            item
        })
        .collect::<Vec<_>>();
    sort_entity_distribution(&mut items);
    items
}

fn local_machine_distribution(source: HashMap<String, SummaryAccumulator>) -> Vec<Value> {
    let mut items = source
        .into_iter()
        .map(|(value, summary)| {
            let mut item = json!({
                "value": value,
                "tokens": summary.effective_tokens(),
                "inputTokens": summary.input,
                "outputTokens": summary.output,
                "cachedTokens": summary.cached,
                "requests": summary.requests,
                "cost": summary.cost
            });
            if summary.cache_split_proven {
                item.as_object_mut()
                    .expect("local machine distribution item is an object")
                    .insert("cacheWriteTokens".to_string(), json!(summary.cache_write));
            }
            item
        })
        .collect::<Vec<_>>();
    sort_entity_distribution(&mut items);
    items
}

fn query_local_entity_heatmap(
    app: &AppContext,
    query: &NormalizedStatsQuery,
    entity: &NormalizedEntitySelector,
    now: &DateTime<Tz>,
) -> Result<Value, String> {
    let year_start = resolve_wall_time(
        query.tz,
        midnight(NaiveDate::from_ymd_opt(now.year(), 1, 1).expect("year start is a valid date")),
        BoundarySide::Start,
    )?;
    let db_path = db::get_db_path(app);
    let conn = gateway_overlay::open_stats_connection(&db_path)?;
    let mut sql = "SELECT timestamp, input_tokens, output_tokens \
                   FROM token_logs WHERE 1 = 1"
        .to_string();
    let mut values = Vec::new();
    append_stats_filters_with_entity(
        &mut sql,
        &mut values,
        Some(&year_start),
        now,
        query,
        Some(entity),
    );
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let mut rows = stmt
        .query(params_from_iter(values.iter()))
        .map_err(|error| error.to_string())?;
    let mut heatmap = Map::new();
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let timestamp: String = row.get(0).map_err(|error| error.to_string())?;
        let input: i64 = row.get(1).map_err(|error| error.to_string())?;
        let output: i64 = row.get(2).map_err(|error| error.to_string())?;
        let date = timestamp_in_timezone(&timestamp, query.tz)?
            .date_naive()
            .to_string();
        let total = heatmap.get(&date).and_then(Value::as_i64).unwrap_or(0)
            + effective_tokens(input, output);
        heatmap.insert(date, json!(total));
    }
    Ok(Value::Object(heatmap))
}

fn build_local_entity_metrics(
    rows: &[StatRow],
    bounds: &QueryBounds,
    query: &NormalizedStatsQuery,
    prices: &Value,
    heatmap: Value,
) -> LocalEntityMetrics {
    let current_start = bounds
        .current_start
        .as_ref()
        .map(|value| storage_timestamp(value.naive_local()));
    let current_end = storage_timestamp(bounds.current_end.naive_local());
    // 键直接借用行里的字符串，行内不再为每个桶克隆一次（T10.167）。
    let mut tools = HashMap::<&str, SummaryAccumulator>::new();
    let mut models = HashMap::<&str, SummaryAccumulator>::new();
    let mut machines = HashMap::<&str, SummaryAccumulator>::new();
    // 小时桶以两字节的 "HH" 为键、输出时再补 ":00"：前缀等长，比较顺序与 "HH:00" 相同。
    let mut peaks = HashMap::<&str, SummaryAccumulator>::new();
    let hour_buckets = query.range.uses_hour_buckets();
    let mut active_days = HashSet::<&str>::new();
    let mut first_seen_at: Option<&str> = None;
    let mut last_seen_at: Option<&str> = None;
    // 同一行计入工具、模型、设备与峰值四个桶，价格只算一次（T10.167）。
    let mut memo = PriceMemo::new(prices);

    for row in rows {
        if current_start
            .as_ref()
            .is_some_and(|start| row.timestamp < *start)
            || row.timestamp > current_end
        {
            continue;
        }
        let Some(date) = row.timestamp.get(..10) else {
            continue;
        };
        let price = memo.row_price(row);
        tools
            .entry(row.tool.as_str())
            .or_default()
            .add_row(row, price);
        models
            .entry(row.model.as_str())
            .or_default()
            .add_row(row, price);
        if !row.machine_id.trim().is_empty() {
            machines
                .entry(row.machine_id.as_str())
                .or_default()
                .add_row(row, price);
        }
        let bucket = if hour_buckets {
            row.timestamp.get(11..13)
        } else {
            Some(date)
        };
        if let Some(bucket) = bucket {
            peaks.entry(bucket).or_default().add_row(row, price);
        }
        active_days.insert(date);
        let timestamp = row.timestamp.as_str();
        if first_seen_at.is_none_or(|first| timestamp < first) {
            first_seen_at = Some(timestamp);
        }
        if last_seen_at.is_none_or(|last| timestamp > last) {
            last_seen_at = Some(timestamp);
        }
    }

    let peak = peaks
        .into_iter()
        .max_by(|(left_bucket, left), (right_bucket, right)| {
            left.effective_tokens()
                .cmp(&right.effective_tokens())
                .then_with(|| right_bucket.cmp(left_bucket))
        })
        .map(|(bucket, summary)| {
            let bucket = if hour_buckets {
                format!("{bucket}:00")
            } else {
                bucket.to_string()
            };
            json!({
                "bucket": bucket,
                "tokens": summary.effective_tokens(),
                "requests": summary.requests,
                "cost": summary.cost
            })
        })
        .unwrap_or_else(|| json!({}));

    LocalEntityMetrics {
        composition: json!({
            "tools": local_token_distribution(owned_keys(tools)),
            "models": local_token_distribution(owned_keys(models)),
            "machines": local_machine_distribution(owned_keys(machines))
        }),
        heatmap,
        peak,
        activity: json!({
            "activeDays": active_days.len(),
            "firstSeenAt": first_seen_at,
            "lastSeenAt": last_seen_at
        }),
    }
}

fn build_local_entity_dashboard(
    stats: Value,
    details: Value,
    request: &NormalizedEntityRequest,
    metrics: LocalEntityMetrics,
) -> Result<Value, String> {
    let summary = stats
        .get("summary")
        .cloned()
        .ok_or_else(|| "local entity stats response is missing summary".to_string())?;
    let comparison = stats.get("comparison").cloned().unwrap_or(Value::Null);
    let mut meta = stats.get("meta").cloned().unwrap_or_else(|| json!({}));
    let meta_object = meta
        .as_object_mut()
        .ok_or_else(|| "local entity stats meta is invalid".to_string())?;
    meta_object.insert("scope".to_string(), json!(StatsScope::Local.as_str()));
    meta_object.insert(
        "capabilities".to_string(),
        json!({
            "comparison": !comparison.is_null(),
            "detailPagination": true,
            "entityDashboard": true,
            "multiFilterSearch": true,
            "quotaSnapshots": false,
            "cacheSavings": true
        }),
    );

    let compatibility_tool = match request.entity.kind {
        EntityKind::Tool => Some(request.entity.id.as_str()),
        EntityKind::Model => request.query.single_tool(),
    };
    let compatibility_model =
        (request.entity.kind == EntityKind::Model).then_some(request.entity.id.as_str());

    Ok(json!({
        "entity": {
            "kind": request.entity.kind.as_str(),
            "id": request.entity.id,
            "tool": compatibility_tool,
            "model": compatibility_model
        },
        "summary": summary,
        "comparison": comparison,
        "composition": metrics.composition,
        "heatmap": metrics.heatmap,
        "peak": metrics.peak,
        "activity": metrics.activity,
        "historyPage": details,
        "granularity": "request",
        "meta": meta
    }))
}

fn get_local_entity_dashboard_impl_at(
    app: &AppContext,
    query: EntityDashboardQuery,
    now: DateTime<Local>,
) -> Result<Value, String> {
    let request = normalize_entity_query(&query)?;
    let snapshot = get_local_stats_v2_snapshot_with_entity_at(
        app,
        request.query.clone(),
        Some(&request.entity),
        now,
    )?;
    let heatmap =
        query_local_entity_heatmap(app, &snapshot.query, &request.entity, &snapshot.zoned_now)?;
    let metrics = build_local_entity_metrics(
        &snapshot.rows,
        &snapshot.bounds,
        &snapshot.query,
        &snapshot.prices,
        heatmap,
    );
    let details = get_usage_details_normalized_at(
        app,
        snapshot.query.clone(),
        Some(&request.entity),
        None,
        20,
        now,
    )?;
    build_local_entity_dashboard(snapshot.stats, details, &request, metrics)
}

pub fn get_local_entity_dashboard_impl(
    app: &AppContext,
    query: EntityDashboardQuery,
) -> Result<Value, String> {
    get_local_entity_dashboard_impl_at(app, query, Local::now())
}

#[cfg(test)]
#[path = "behavior_analysis_tests.rs"]
mod behavior_analysis_tests;
#[cfg(test)]
#[path = "local_stats_v2_tests.rs"]
mod local_stats_v2_tests;
#[cfg(test)]
#[path = "stats_perf_tests.rs"]
mod stats_perf_tests;

#[cfg(test)]
#[path = "scan_scale_gate_tests.rs"]
mod scan_scale_gate_tests;

#[cfg(test)]
#[path = "cloud_stats_v2_tests.rs"]
mod cloud_stats_v2_tests;

#[cfg(test)]
#[path = "project_dimension_guard_tests.rs"]
mod project_dimension_guard_tests;

fn parse_auth_session(body: &Value) -> Option<CloudSession> {
    let source = body
        .get("session")
        .filter(|v| v.is_object())
        .unwrap_or(body);
    let access_token = source.get("access_token")?.as_str()?.to_string();
    let refresh_token = source.get("refresh_token")?.as_str()?.to_string();
    let expires_in = source
        .get("expires_in")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600);
    let user = source.get("user").or_else(|| body.get("user"))?;
    let user_id = user.get("id")?.as_str()?.to_string();
    let email = user
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Some(CloudSession {
        access_token,
        refresh_token,
        user_id,
        email,
        expires_at: Utc::now().timestamp() + expires_in - 60,
    })
}

pub(crate) async fn refresh_session_if_needed(app: &AppContext) -> Result<CloudConfig, String> {
    let lease = cloud_session_coordinator().begin_session_use(app)?;
    refresh_session_if_needed_with_lease(app, &lease).await
}

/// Acquire a durable-epoch-fenced cloud session for callers outside this
/// module. The returned lease must be retained for the entire remote request;
/// callers must validate it before send and after response, and use
/// `commit_if_current` for any account-scoped local commit.
pub(crate) async fn acquire_current_cloud_session(
    app: &AppContext,
) -> Result<(CloudConfig, CloudSessionUseLease), String> {
    let _ = refresh_session_if_needed(app).await?;
    let lease = cloud_session_coordinator().begin_session_use(app)?;
    let config = load_cloud_config_file(app)?;
    lease.ensure_current(app)?;
    Ok((config, lease))
}

async fn refresh_session_if_needed_with_lease(
    app: &AppContext,
    lease: &CloudSessionUseLease,
) -> Result<CloudConfig, String> {
    let expected_generation = lease.generation;
    let config = load_cloud_config_file(app)?;
    lease.ensure_current(app)?;
    let session = config
        .session
        .clone()
        .ok_or_else(|| "Please sign in to Supabase first.".to_string())?;

    if config.supabase_url.is_empty() || config.supabase_key.is_empty() {
        return Err("Please configure Supabase URL and publishable key first.".to_string());
    }

    if session.expires_at > Utc::now().timestamp() + 60 {
        lease.ensure_current(app)?;
        return Ok(config);
    }

    let coordinator = cloud_session_coordinator();
    let mut refresh_claim = coordinator.claim_refresh(expected_generation)?;
    if !refresh_claim.is_leader() {
        return refresh_claim.wait_result(app).await;
    }

    // Re-read after winning the flight. A preceding flight can finish between
    // the first stale read and this claim being installed.
    let latest = load_cloud_config_file(app)?;
    lease.ensure_current(app)?;
    let result = match latest.session.as_ref() {
        Some(current) if current.expires_at > Utc::now().timestamp() + 60 => Ok(latest),
        Some(_) => perform_session_refresh(app, lease, expected_generation, latest).await,
        None => Err("Please sign in to Supabase first.".to_string()),
    };
    refresh_claim.publish(result.clone())?;
    result
}

async fn perform_session_refresh(
    app: &AppContext,
    lease: &CloudSessionUseLease,
    expected_generation: u64,
    mut config: CloudConfig,
) -> Result<CloudConfig, String> {
    let session = config
        .session
        .clone()
        .ok_or_else(|| "Please sign in to Supabase first.".to_string())?;

    let url = format!(
        "{}/auth/v1/token?grant_type=refresh_token",
        config.supabase_url
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Supabase session refresh client unavailable: {error}"))?;
    lease.ensure_current(app)?;
    let res = send_cloud_request_with_retry("Supabase session refresh", || {
        client
            .post(&url)
            .header("apikey", &config.supabase_key)
            .header("Content-Type", "application/json")
            .json(&json!({ "refresh_token": session.refresh_token }))
    })
    .await?;
    // Re-read the durable gate before interpreting or committing an old
    // process's response. Process-local generation alone is insufficient.
    lease.ensure_current(app)?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        lease.ensure_current(app)?;
        if matches!(status.as_u16(), 400 | 401 | 403) {
            config.session = None;
            cloud_session_coordinator().commit_new_session_with_keyring_ops(
                app,
                AuthChangeClaim {
                    generation: expected_generation,
                    gate_epoch: lease.gate_epoch,
                },
                clear_session_from_keyring,
                || Ok(()),
            )?;
            crate::quota_sync::invalidate_session_locally(app);
            return Err("Supabase session expired. Please sign in again.".to_string());
        }
        return Err(supabase_api_error(status, body));
    }

    let body: Value = res.json().await.map_err(|e| e.to_string())?;
    lease.ensure_current(app)?;
    let refreshed = parse_auth_session(&body)
        .ok_or_else(|| "Invalid Supabase refresh response.".to_string())?;
    if refreshed.user_id != session.user_id {
        return Err("Invalid Supabase refresh response.".to_string());
    }
    cloud_session_coordinator().commit_new_session_with_keyring_ops(
        app,
        AuthChangeClaim {
            generation: expected_generation,
            gate_epoch: lease.gate_epoch,
        },
        clear_session_from_keyring,
        || save_session_to_keyring(&refreshed),
    )?;
    config.session = Some(refreshed);
    Ok(config)
}

fn cleanup_old_files(dir: &Path, prefix: &str, keep: usize) -> usize {
    let current_name = format!("{prefix}current.png");
    if let Ok(entries) = fs::read_dir(dir) {
        let mut files = Vec::new();
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name != current_name && name.starts_with(prefix) && name.ends_with(".png") {
                        if let Ok(metadata) = entry.metadata() {
                            if let Ok(modified) = metadata.modified() {
                                files.push((modified, path));
                            }
                        }
                    }
                }
            }
        }
        files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        let mut removed = 0;
        for (_, path) in files.iter().skip(keep) {
            if fs::remove_file(path).is_ok() {
                removed += 1;
            }
        }
        return removed;
    }
    0
}

fn cleanup_history_files_strict(dir: &Path, prefix: &str) -> Result<usize, String> {
    cleanup_history_files_with(dir, prefix, |path| fs::remove_file(path))
}

fn cleanup_history_files_with<F>(dir: &Path, prefix: &str, remove_file: F) -> Result<usize, String>
where
    F: Fn(&Path) -> std::io::Result<()>,
{
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("无法读取历史壁纸目录：{error}")),
    };
    let current_name = format!("{prefix}current.png");
    let mut removed = 0;
    let mut failed = 0;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                failed += 1;
                continue;
            }
        };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !path.is_file()
            || name == current_name
            || !name.starts_with(prefix)
            || !name.ends_with(".png")
        {
            continue;
        }
        match remove_file(&path) {
            Ok(()) => removed += 1,
            Err(_) => failed += 1,
        }
    }
    if failed > 0 {
        Err(format!(
            "历史壁纸仅部分清理：已删除 {removed} 个，失败 {failed} 个。"
        ))
    } else {
        Ok(removed)
    }
}

pub(crate) fn enforce_wallpaper_retention(app: &AppContext) -> (usize, usize) {
    let app_dir = app.app_data_dir();
    let wallpaper_removed = cleanup_old_files(
        &app_dir.join("wallpapers"),
        "wallpaper_",
        WALLPAPER_HISTORY_LIMIT,
    );
    let lockscreen_removed = cleanup_old_files(
        &app_dir.join("lockscreens"),
        "lockscreen_",
        WALLPAPER_HISTORY_LIMIT,
    );
    (wallpaper_removed, lockscreen_removed)
}

pub(crate) const fn lockscreen_wallpaper_supported() -> bool {
    cfg!(target_os = "windows")
}

fn restore_lockscreen_after_failed_attempt(
    current_path: &Path,
    attempted_history_path: &Path,
    previous_current: Option<&[u8]>,
) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Err(error) = fs::remove_file(attempted_history_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            failures.push(format!("history cleanup failed: {error}"));
        }
    }

    match previous_current {
        Some(previous) => {
            if let Err(error) = fs::write(current_path, previous) {
                failures.push(format!("current restore failed: {error}"));
                let _ = fs::remove_file(current_path);
            }
        }
        None => {
            if let Err(error) = fs::remove_file(current_path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    failures.push(format!("current cleanup failed: {error}"));
                }
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn lockscreen_attempt_error(
    current_path: &Path,
    attempted_path: &Path,
    previous_current: Option<&[u8]>,
    cause: String,
) -> String {
    match restore_lockscreen_after_failed_attempt(current_path, attempted_path, previous_current) {
        Ok(()) => cause,
        Err(restore_error) => format!("{cause}; rollback failed: {restore_error}"),
    }
}

fn apply_lockscreen_setter<F>(
    current_path: &Path,
    attempted_path: &Path,
    previous_current: Option<&[u8]>,
    setter: F,
) -> Result<String, String>
where
    F: FnOnce(&Path) -> Result<(bool, String), String>,
{
    if current_path == attempted_path {
        return Err(lockscreen_attempt_error(
            current_path,
            attempted_path,
            previous_current,
            "Lock-screen setter requires a fresh file identity".to_string(),
        ));
    }

    if let Err(error) = fs::copy(current_path, attempted_path) {
        return Err(lockscreen_attempt_error(
            current_path,
            attempted_path,
            previous_current,
            format!("Failed to prepare lock-screen setter image: {error}"),
        ));
    }
    if let Ok(file) = fs::File::open(attempted_path) {
        let _ = file.sync_all();
    }

    match setter(attempted_path) {
        Ok((true, message)) => Ok(message),
        Ok((false, message)) => Err(lockscreen_attempt_error(
            current_path,
            attempted_path,
            previous_current,
            format!("Lock-screen update was not applied: {message}"),
        )),
        Err(error) => Err(lockscreen_attempt_error(
            current_path,
            attempted_path,
            previous_current,
            format!("Lock-screen update failed: {error}"),
        )),
    }
}

#[cfg(test)]
mod wallpaper_retention_tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(label: &str) -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "tokenledger-{label}-{}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_histories(dir: &Path, prefix: &str, count: usize) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(format!("{prefix}current.png")), b"current").unwrap();
        for index in 0..count {
            fs::write(
                dir.join(format!("{prefix}20260715_000000_{index:06}.png")),
                format!("history-{index}"),
            )
            .unwrap();
        }
    }

    fn history_names(dir: &Path, prefix: &str) -> Vec<String> {
        let current_name = format!("{prefix}current.png");
        let mut names = fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| {
                name != &current_name && name.starts_with(prefix) && name.ends_with(".png")
            })
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    #[test]
    fn startup_retention_keeps_current_and_only_five_newest_histories() {
        let root = temp_root("wallpaper-retention");
        let wallpapers = root.join("wallpapers");
        let lockscreens = root.join("lockscreens");
        write_histories(&wallpapers, "wallpaper_", 5);
        write_histories(&lockscreens, "lockscreen_", 1_000);
        let app = AppContext::for_test(root.clone());

        assert_eq!(enforce_wallpaper_retention(&app), (0, 995));
        assert_eq!(history_names(&wallpapers, "wallpaper_").len(), 5);
        assert_eq!(history_names(&lockscreens, "lockscreen_").len(), 5);
        assert!(wallpapers.join("wallpaper_current.png").exists());
        assert!(lockscreens.join("lockscreen_current.png").exists());
        assert_eq!(
            history_names(&lockscreens, "lockscreen_").first().unwrap(),
            "lockscreen_20260715_000000_000995.png"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_cleanup_keeps_current_wallpaper_files() {
        let root = temp_root("wallpaper-history-cleanup");
        let wallpapers = root.join("wallpapers");
        let lockscreens = root.join("lockscreens");
        write_histories(&wallpapers, "wallpaper_", 3);
        write_histories(&lockscreens, "lockscreen_", 2);

        assert_eq!(
            cleanup_history_files_strict(&wallpapers, "wallpaper_").unwrap(),
            3
        );
        assert_eq!(
            cleanup_history_files_strict(&lockscreens, "lockscreen_").unwrap(),
            2
        );
        assert!(wallpapers.join("wallpaper_current.png").exists());
        assert!(lockscreens.join("lockscreen_current.png").exists());
        assert!(history_names(&wallpapers, "wallpaper_").is_empty());
        assert!(history_names(&lockscreens, "lockscreen_").is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_cleanup_reports_partial_remove_failures() {
        let root = temp_root("wallpaper-history-partial-failure");
        let wallpapers = root.join("wallpapers");
        write_histories(&wallpapers, "wallpaper_", 2);
        let calls = AtomicUsize::new(0);

        let error = cleanup_history_files_with(&wallpapers, "wallpaper_", |path| {
            if calls.fetch_add(1, Ordering::Relaxed) == 0 {
                fs::remove_file(path)
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "fixture failure",
                ))
            }
        })
        .unwrap_err();

        assert!(error.contains("已删除 1 个"));
        assert!(error.contains("失败 1 个"));
        assert!(wallpapers.join("wallpaper_current.png").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_lockscreen_attempt_restores_previous_current_and_removes_history() {
        let root = temp_root("lockscreen-restore");
        let current = root.join("lockscreen_current.png");
        let history = root.join("lockscreen_attempt.png");
        fs::write(&current, b"new-attempt").unwrap();
        fs::write(&history, b"new-attempt").unwrap();

        restore_lockscreen_after_failed_attempt(&current, &history, Some(b"previous")).unwrap();

        assert_eq!(fs::read(&current).unwrap(), b"previous");
        assert!(!history.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_first_lockscreen_attempt_leaves_no_generated_file() {
        let root = temp_root("lockscreen-first-failure");
        let current = root.join("lockscreen_current.png");
        let history = root.join("lockscreen_attempt.png");
        fs::write(&current, b"new-attempt").unwrap();
        fs::write(&history, b"new-attempt").unwrap();

        restore_lockscreen_after_failed_attempt(&current, &history, None).unwrap();

        assert!(!current.exists());
        assert!(!history.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn successful_lockscreen_attempt_applies_a_fresh_history_path() {
        let root = temp_root("lockscreen-fresh-path");
        let current = root.join("lockscreen_current.png");
        let attempted = root.join("lockscreen_20260721_184500_000001.png");
        fs::write(&current, b"new-image").unwrap();

        let message = apply_lockscreen_setter(
            &current,
            &attempted,
            Some(b"previous-image"),
            |setter_path| {
                assert_eq!(setter_path, attempted);
                assert_ne!(setter_path, current);
                assert_eq!(fs::read(setter_path).unwrap(), b"new-image");
                Ok((true, "applied".to_string()))
            },
        )
        .unwrap();

        assert_eq!(message, "applied");
        assert_eq!(fs::read(&current).unwrap(), b"new-image");
        assert_eq!(fs::read(&attempted).unwrap(), b"new-image");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejected_lockscreen_attempt_is_an_error_and_rolls_back() {
        let root = temp_root("lockscreen-rejected");
        let current = root.join("lockscreen_current.png");
        let attempted = root.join("lockscreen_20260721_184500_000002.png");
        fs::write(&current, b"new-image").unwrap();

        let error = apply_lockscreen_setter(&current, &attempted, Some(b"previous-image"), |_| {
            Ok((false, "policy denied".to_string()))
        })
        .unwrap_err();

        assert!(error.contains("not applied"));
        assert!(error.contains("policy denied"));
        assert_eq!(fs::read(&current).unwrap(), b"previous-image");
        assert!(!attempted.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lockscreen_rendering_capability_is_compiled_for_windows_only() {
        assert_eq!(
            lockscreen_wallpaper_supported(),
            cfg!(target_os = "windows")
        );
    }

    #[test]
    fn wallpaper_timezone_preserves_the_detected_iana_zone() {
        assert_eq!(
            canonical_wallpaper_timezone("Asia/Shanghai").unwrap(),
            "Asia/Shanghai"
        );
    }

    #[test]
    fn wallpaper_timezone_rejects_non_iana_windows_zone_names() {
        let error = canonical_wallpaper_timezone("China Standard Time").unwrap_err();
        assert!(error.contains("invalid local IANA timezone"));
    }

    #[test]
    fn wallpaper_timezone_matches_the_current_operating_system() {
        let detected = iana_time_zone::get_timezone().expect("detect local IANA timezone");
        assert_eq!(local_wallpaper_timezone().unwrap(), detected);
    }

    #[test]
    fn legacy_wallpaper_choices_cannot_reach_native_side_effects_before_consent() {
        let root = temp_root("legacy-wallpaper-consent");
        let app = AppContext::for_test(root.clone());
        let settings = AppSettings {
            wallpaper_consent_version: 0,
            wallpaper_desktop_enabled: true,
            wallpaper_dynamic_bg_enabled: true,
            ..Default::default()
        };
        settings::save_settings_file(&app, &settings).unwrap();

        assert!(!should_show_dynamic_wallpaper(&settings));
        let error = perform_wallpaper_update(&app, "desktop").unwrap_err();
        assert!(error.contains("authorization"));
        assert!(!root.join("wallpapers").exists());
        assert!(!root.join("lockscreens").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confirmed_dynamic_wallpaper_choice_keeps_the_existing_native_path() {
        let settings = AppSettings {
            wallpaper_desktop_enabled: true,
            wallpaper_dynamic_bg_enabled: true,
            ..Default::default()
        };
        assert!(should_show_dynamic_wallpaper(&settings));
    }

    #[test]
    fn static_wallpaper_choice_never_requests_dynamic_window() {
        let settings = AppSettings {
            wallpaper_desktop_enabled: true,
            wallpaper_dynamic_bg_enabled: false,
            ..Default::default()
        };
        assert!(!should_show_dynamic_wallpaper(&settings));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn disabled_desktop_rejects_dynamic_manual_update() {
        let root = temp_root("disabled-dynamic-wallpaper");
        let app = AppContext::for_test(root.clone());
        let settings = AppSettings {
            wallpaper_desktop_enabled: false,
            wallpaper_dynamic_bg_enabled: true,
            ..Default::default()
        };
        settings::save_settings_file(&app, &settings).unwrap();

        let error = perform_wallpaper_update(&app, "desktop").unwrap_err();
        assert!(error.contains("请先启用桌面壁纸"));
        assert!(!root.join("wallpapers").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unrelated_setting_save_does_not_reapply_wallpaper() {
        let previous = AppSettings {
            wallpaper_desktop_enabled: true,
            ..Default::default()
        };
        let mut current = previous.clone();
        current.scan_interval_secs += 60;
        assert!(!wallpaper_settings_changed(&previous, &current));
    }

    #[test]
    fn wallpaper_mode_change_requires_native_reconciliation() {
        let previous = AppSettings {
            wallpaper_desktop_enabled: true,
            ..Default::default()
        };
        let mut current = previous.clone();
        current.wallpaper_dynamic_bg_enabled = true;
        assert!(wallpaper_settings_changed(&previous, &current));
    }

    #[test]
    fn cloud_wallpaper_rejects_malformed_stats_instead_of_rendering_zeroes() {
        let malformed = json!({
            "summary": {
                "totalTokens": 10,
                "totalRequests": 1
            },
            "tools": {},
            "models": {},
            "trends": [],
            "heatmap": {},
            "history": []
        });

        let Err(error) = wallstats_from_dashboard_json(&malformed) else {
            panic!("malformed cloud stats must not be accepted");
        };

        assert!(error.contains("malformed summary.inputTokens"));
    }

    #[test]
    fn cloud_wallpaper_excludes_reserved_trend_metadata_from_token_totals() {
        let stats = json!({
            "summary": {
                "totalTokens": 100,
                "inputTokens": 60,
                "outputTokens": 40,
                "cachedTokens": 0,
                "totalCost": 0.1,
                "totalRequests": 40,
                "avgTokensPerReq": 2.5
            },
            "tools": {},
            "models": {},
            "trends": [{ "date": "09:00", "codex": 100, "__requests": 40 }],
            "heatmap": {},
            "history": []
        });

        let wall_stats = wallstats_from_dashboard_json(&stats).unwrap();
        assert_eq!(wall_stats.hourly_trend[9], 100);
    }

    // ---- Cloud "较昨日同期" (T10.195 review P1-1) ----

    /// Minimal, otherwise-valid cloud dashboard JSON with the given
    /// `comparison` value spliced in (or omitted entirely when `None`).
    fn cloud_stats_json_with_comparison(comparison: Option<Value>) -> Value {
        let mut stats = json!({
            "summary": {
                "totalTokens": 100,
                "inputTokens": 60,
                "outputTokens": 40,
                "cachedTokens": 0,
                "totalCost": 0.1,
                "totalRequests": 10,
                "avgTokensPerReq": 10.0
            },
            "tools": {},
            "models": {},
            "trends": [],
            "heatmap": {},
            "history": []
        });
        if let Some(comparison) = comparison {
            stats
                .as_object_mut()
                .expect("stats fixture is an object")
                .insert("comparison".to_string(), comparison);
        }
        stats
    }

    #[test]
    fn cloud_wallpaper_reads_yesterday_same_period_from_a_present_day_over_day_comparison() {
        let stats = cloud_stats_json_with_comparison(Some(json!({
            "window": { "kind": "dayOverDay" },
            "previous": { "summary": { "totalTokens": 990_451, "totalRequests": 65 } }
        })));
        let wall_stats = wallstats_from_dashboard_json(&stats).unwrap();
        assert_eq!(wall_stats.yesterday_total, 990_451);
        assert_eq!(wall_stats.yesterday_requests, 65);
    }

    #[test]
    fn cloud_wallpaper_treats_a_missing_comparison_as_unknown() {
        let stats = cloud_stats_json_with_comparison(None);
        let wall_stats = wallstats_from_dashboard_json(&stats).unwrap();
        assert_eq!(wall_stats.yesterday_total, wallpaper::STAT_UNKNOWN);
        assert_eq!(wall_stats.yesterday_requests, wallpaper::STAT_UNKNOWN);
    }

    #[test]
    fn cloud_wallpaper_treats_a_wrong_kind_comparison_as_unknown() {
        // e.g. `range` mapped to a week-over-week comparison instead of the
        // wallpaper's own always-"today" query -- must not be misread as a
        // same-time-of-day baseline.
        let stats = cloud_stats_json_with_comparison(Some(json!({
            "window": { "kind": "weekOverWeek" },
            "previous": { "summary": { "totalTokens": 500, "totalRequests": 5 } }
        })));
        let wall_stats = wallstats_from_dashboard_json(&stats).unwrap();
        assert_eq!(wall_stats.yesterday_total, wallpaper::STAT_UNKNOWN);
        assert_eq!(wall_stats.yesterday_requests, wallpaper::STAT_UNKNOWN);
    }

    #[test]
    fn cloud_wallpaper_treats_a_zero_zero_previous_summary_as_an_unprovable_baseline() {
        // REQUIREMENTS REQ-COMP-01 / the review's P1-1: a cloud previous of
        // 0/0 means "基线缺失", not a real, successfully-read zero -- unlike
        // the local SQL path, the cloud RPC gives no way to tell those two
        // apart.
        let stats = cloud_stats_json_with_comparison(Some(json!({
            "window": { "kind": "dayOverDay" },
            "previous": { "summary": { "totalTokens": 0, "totalRequests": 0 } }
        })));
        let wall_stats = wallstats_from_dashboard_json(&stats).unwrap();
        // T10.210 (review P3-8): this must read back as `STAT_BASELINE_MISSING`,
        // not `STAT_UNKNOWN` — the change pill shows "基线缺失" here, never
        // "不可得"/"新增"/"持平" (the two sentinels used to be the same value,
        // which collapsed both into "不可得").
        assert_eq!(wall_stats.yesterday_total, wallpaper::STAT_BASELINE_MISSING);
        assert_eq!(
            wall_stats.yesterday_requests,
            wallpaper::STAT_BASELINE_MISSING
        );
    }

    #[test]
    fn cloud_wallpaper_rejects_negative_previous_summary_as_unknown() {
        for (tokens, requests) in [(-10, 1), (10, -1), (-10, -1)] {
            let stats = cloud_stats_json_with_comparison(Some(json!({
                "window": { "kind": "dayOverDay" },
                "previous": { "summary": { "totalTokens": tokens, "totalRequests": requests } }
            })));
            let wall_stats = wallstats_from_dashboard_json(&stats).unwrap();
            assert_eq!(wall_stats.yesterday_total, wallpaper::STAT_UNKNOWN);
            assert_eq!(wall_stats.yesterday_requests, wallpaper::STAT_UNKNOWN);
        }
    }

    #[test]
    fn cloud_wallpaper_baseline_missing_is_a_different_sentinel_from_unknown() {
        // Regression guard (T10.210): a missing/wrong-kind comparison and a
        // 0/0 comparison must not collapse back into the same value — one is
        // "the read failed", the other is "the read succeeded but proved
        // nothing", and the change pill draws different text for each.
        assert_ne!(wallpaper::STAT_UNKNOWN, wallpaper::STAT_BASELINE_MISSING);

        let missing = cloud_stats_json_with_comparison(None);
        let missing_stats = wallstats_from_dashboard_json(&missing).unwrap();
        let zero_zero = cloud_stats_json_with_comparison(Some(json!({
            "window": { "kind": "dayOverDay" },
            "previous": { "summary": { "totalTokens": 0, "totalRequests": 0 } }
        })));
        let zero_zero_stats = wallstats_from_dashboard_json(&zero_zero).unwrap();

        assert_eq!(missing_stats.yesterday_total, wallpaper::STAT_UNKNOWN);
        assert_eq!(
            zero_zero_stats.yesterday_total,
            wallpaper::STAT_BASELINE_MISSING
        );
        assert_ne!(
            missing_stats.yesterday_total,
            zero_zero_stats.yesterday_total
        );
    }

    #[test]
    fn cloud_cache_savings_fail_closed_without_a_proven_split() {
        let root = temp_root("cloud-cache-savings-combined");
        let app = AppContext::for_test(root.clone());
        let combined = json!({
            "summary": {
                "cachedTokens": 100,
                "cacheReadTokens": 100,
                "cacheWriteTokens": 0,
                "cacheSavedUsd": 99.0,
                "cacheSavings": {
                    "readSavedUsd": 99.0,
                    "writePremiumUsd": 0.0,
                    "netSavedUsd": 99.0,
                    "fallbackPricedReadTokens": 0,
                    "fallbackPricedWriteTokens": 0,
                    "priceBasis": "uploaded-prices"
                }
            },
            "models": {
                "gpt-test": { "cached": 100, "cacheWrite": 0, "tool": "codex" }
            }
        });

        let processed = post_process_cloud_stats(&app, combined);
        assert!(processed["summary"].get("cacheReadTokens").is_none());
        assert!(processed["summary"].get("cacheWriteTokens").is_none());
        assert!(processed["summary"].get("cacheSavedUsd").is_none());
        // T10.183：净节省与读写拆分同一门槛，拆分被剥离时对象一并剥离。
        assert!(processed["summary"].get("cacheSavings").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cloud_cache_savings_are_estimated_only_for_a_complete_consistent_split() {
        let root = temp_root("cloud-cache-savings-split");
        let app = AppContext::for_test(root.clone());
        let split = json!({
            "summary": {
                "cachedTokens": 100,
                "cacheReadTokens": 80,
                "cacheWriteTokens": 20
            },
            "models": {
                "gpt-test": {
                    "cached": 100,
                    "cacheRead": 80,
                    "cacheWrite": 20,
                    "tool": "codex"
                }
            }
        });

        let processed = post_process_cloud_stats(&app, split);
        assert!(processed["summary"]["cacheSavedUsd"].is_number());
        // T10.183：旧云端（未声明 cacheSavings 能力）由本机价格表桥接净节省，
        // 读取节省与 cacheSavedUsd 逐位相同；gpt-test 不在价格表里，读写都按兜底计数。
        let savings = &processed["summary"]["cacheSavings"];
        assert_eq!(savings["priceBasis"], json!("local-prices"));
        assert_eq!(
            savings["readSavedUsd"].as_f64().unwrap().to_bits(),
            processed["summary"]["cacheSavedUsd"]
                .as_f64()
                .unwrap()
                .to_bits()
        );
        assert_eq!(savings["fallbackPricedReadTokens"], json!(80));
        assert_eq!(savings["fallbackPricedWriteTokens"], json!(20));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_year_trends_use_canonical_year_month_keys() {
        let now = NaiveDate::from_ymd_opt(2026, 9, 1)
            .unwrap()
            .and_hms_opt(8, 0, 0)
            .unwrap();
        let buckets = initial_trends_at(StatsRange::Year, now);
        assert!(buckets.contains_key("2026-01"));
        assert!(buckets.contains_key("2026-12"));
        assert_eq!(
            trend_key(StatsRange::Year, "2026-09-01 08:00:00", "2026-09-01"),
            "2026-09"
        );
    }

    #[test]
    fn custom_range_parses_inclusive_dates_and_rejects_bad_input() {
        let range = StatsRange::parse_with_bounds("custom", Some("2026-08-01"), Some("2026-08-31"))
            .unwrap();
        assert_eq!(
            range.custom_bounds(),
            Some((
                NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 31).unwrap()
            ))
        );
        assert_eq!(range.as_str(), "custom");
        assert!(!range.uses_hour_buckets());
        assert!(
            StatsRange::parse_with_bounds("custom", Some("2026-08-02"), Some("2026-08-02"))
                .unwrap()
                .uses_hour_buckets()
        );
        assert!(StatsRange::parse_with_bounds("custom", None, Some("2026-08-02")).is_err());
        assert!(
            StatsRange::parse_with_bounds("custom", Some("2026-08-03"), Some("2026-08-02"))
                .is_err()
        );
        assert!(
            StatsRange::parse_with_bounds("custom", Some("2024-01-01"), Some("2026-09-05"))
                .is_err()
        );
        assert!(
            StatsRange::parse_with_bounds("custom", Some("2026/08/01"), Some("2026-08-02"))
                .is_err()
        );
        assert!(StatsRange::parse_with_bounds("custom", None, None).is_err());
        assert_eq!(
            StatsRange::parse_with_bounds("week", None, None).unwrap(),
            StatsRange::Week
        );
    }

    #[test]
    fn custom_range_bounds_compare_against_the_preceding_equal_span() {
        let tz: Tz = "Asia/Shanghai".parse().unwrap();
        let now = tz.with_ymd_and_hms(2026, 9, 5, 10, 30, 0).unwrap();
        let range = StatsRange::parse_with_bounds("custom", Some("2026-08-01"), Some("2026-08-31"))
            .unwrap();
        let bounds = query_bounds(range, now).unwrap();
        let window = bounds
            .comparison
            .expect("custom ranges always carry a comparison window");
        assert_eq!(window.kind, "periodOverPeriod");
        assert_eq!(window.bucket, ComparisonBucket::Day);
        assert_eq!(
            bounds.current_start.unwrap().to_rfc3339(),
            "2026-08-01T00:00:00+08:00"
        );
        assert_eq!(bounds.current_end.to_rfc3339(), "2026-08-31T23:59:59+08:00");
        assert_eq!(
            window.previous_start.to_rfc3339(),
            "2026-07-01T00:00:00+08:00"
        );
        assert_eq!(
            window.previous_end.to_rfc3339(),
            "2026-07-31T23:59:59+08:00"
        );
        assert_eq!(
            comparison_slot_count(
                window.current_start.naive_local(),
                window
                    .current_end
                    .date_naive()
                    .and_time(window.aligned_time),
                window.bucket
            ),
            31
        );

        // 跨越“现在”的区间截到现在，上一区间对齐到同一进度。
        let open = StatsRange::parse_with_bounds("custom", Some("2026-09-01"), Some("2026-09-07"))
            .unwrap();
        let open_bounds = query_bounds(open, now).unwrap();
        let open_window = open_bounds.comparison.unwrap();
        assert_eq!(open_bounds.current_end, now);
        assert_eq!(
            open_window.previous_start.to_rfc3339(),
            "2026-08-25T00:00:00+08:00"
        );
        assert_eq!(
            open_window.previous_end.to_rfc3339(),
            "2026-08-29T10:30:00+08:00"
        );

        // 单日用小时桶。
        let day = StatsRange::parse_with_bounds("custom", Some("2026-08-02"), Some("2026-08-02"))
            .unwrap();
        let day_bounds = query_bounds(day, now).unwrap();
        assert_eq!(
            day_bounds.comparison.unwrap().bucket,
            ComparisonBucket::Hour
        );
    }

    #[test]
    fn custom_range_trends_prefill_every_day_or_hour_and_echo_bounds() {
        let now = NaiveDate::from_ymd_opt(2026, 9, 5)
            .unwrap()
            .and_hms_opt(8, 0, 0)
            .unwrap();
        let range = StatsRange::parse_with_bounds("custom", Some("2026-08-30"), Some("2026-09-02"))
            .unwrap();
        let buckets = initial_trends_at(range, now);
        assert_eq!(buckets.len(), 4);
        assert!(buckets.contains_key("2026-08-30"));
        assert!(buckets.contains_key("2026-09-02"));
        assert_eq!(
            trend_key(range, "2026-09-01 08:00:00", "2026-09-01"),
            "2026-09-01"
        );
        let day = StatsRange::parse_with_bounds("custom", Some("2026-09-01"), Some("2026-09-01"))
            .unwrap();
        assert_eq!(initial_trends_at(day, now).len(), 24);
        assert_eq!(trend_key(day, "2026-09-01 08:15:00", "2026-09-01"), "08:00");

        let query = NormalizedStatsQuery::from_query(LocalStatsQuery {
            range: "custom".to_string(),
            start: Some("2026-08-30".to_string()),
            end: Some("2026-09-02".to_string()),
            timezone: "Asia/Shanghai".to_string(),
            machines: None,
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: None,
        })
        .unwrap();
        let echo = query.echo_json();
        assert_eq!(echo["range"], "custom");
        assert_eq!(echo["start"], "2026-08-30");
        assert_eq!(echo["end"], "2026-09-02");
        assert_ne!(
            query.fingerprint(None),
            NormalizedStatsQuery::from_query(LocalStatsQuery {
                range: "custom".to_string(),
                start: Some("2026-08-29".to_string()),
                end: Some("2026-09-02".to_string()),
                timezone: "Asia/Shanghai".to_string(),
                machines: None,
                machine: None,
                tools: None,
                tool: None,
                models: None,
                model: None,
                search: None,
                token_mode: None,
            })
            .unwrap()
            .fingerprint(None)
        );
    }

    fn custom_query_fixture(start: &str, end: &str) -> NormalizedStatsQuery {
        NormalizedStatsQuery::from_query(LocalStatsQuery {
            range: "custom".to_string(),
            start: Some(start.to_string()),
            end: Some(end.to_string()),
            timezone: "Asia/Shanghai".to_string(),
            machines: None,
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: None,
        })
        .unwrap()
    }

    // T10.185: the v2 payload builders must transparently carry start/end for
    // a custom range (this is the actual "parameter transmission" the task
    // unlocks), while the legacy (`_v1`/timezone) signatures never see them —
    // proof of *why* custom ranges must never fall back to a legacy RPC.
    #[test]
    fn cloud_v2_payloads_carry_custom_bounds_and_legacy_payloads_cannot() {
        let query = custom_query_fixture("2026-07-01", "2026-07-14");

        let dashboard_payload = query_v2_rpc_payload("user-1", &query);
        assert_eq!(dashboard_payload["p_query"]["range"], "custom");
        assert_eq!(dashboard_payload["p_query"]["start"], "2026-07-01");
        assert_eq!(dashboard_payload["p_query"]["end"], "2026-07-14");

        let details_request = CloudDetailsRequest {
            query: query.clone(),
            cursor: None,
            limit: 50,
        };
        let details_payload = details_v2_rpc_payload("user-1", &details_request);
        assert_eq!(details_payload["p_query"]["start"], "2026-07-01");
        assert_eq!(details_payload["p_query"]["end"], "2026-07-14");

        let entity_request = NormalizedEntityRequest {
            query: query.clone(),
            entity: NormalizedEntitySelector {
                kind: EntityKind::Tool,
                id: "codex".to_string(),
            },
        };
        let entity_payload = entity_v2_rpc_payload("user-1", &entity_request);
        assert_eq!(entity_payload["p_query"]["start"], "2026-07-01");
        assert_eq!(entity_payload["p_query"]["end"], "2026-07-14");

        // The legacy signatures have no start/end parameter at all: sending
        // "custom" as `p_range` there has nowhere honest to go, which is
        // exactly why `legacy_*_representable()` refuses it outright instead
        // of forwarding a query the SQL side cannot execute correctly.
        let legacy_dashboard = dashboard_legacy_rpc_payload("user-1", &query, true);
        assert!(legacy_dashboard.get("start").is_none());
        assert!(legacy_dashboard.get("end").is_none());
        let legacy_comparison = comparison_legacy_rpc_payload("user-1", &query);
        assert!(legacy_comparison.get("start").is_none());
        let legacy_details = details_legacy_rpc_payload("user-1", &details_request);
        assert!(legacy_details.get("start").is_none());
        let legacy_entity = entity_legacy_rpc_payload("user-1", &entity_request);
        assert!(legacy_entity.get("start").is_none());
    }

    #[test]
    fn legacy_fallbacks_never_claim_a_custom_range_is_representable() {
        let custom = custom_query_fixture("2026-07-01", "2026-07-01");
        // No filters at all: the *only* reason these must say "no" is the
        // custom range, not filter cardinality (T10.185).
        assert!(!custom.legacy_dashboard_representable());
        assert!(!custom.legacy_filter_representable());

        let month = NormalizedStatsQuery::from_query(LocalStatsQuery {
            range: "month".to_string(),
            start: None,
            end: None,
            timezone: "Asia/Shanghai".to_string(),
            machines: None,
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: None,
        })
        .unwrap();
        assert!(month.legacy_dashboard_representable());
        assert!(month.legacy_filter_representable());

        let custom_entity = NormalizedEntityRequest {
            query: custom,
            entity: NormalizedEntitySelector {
                kind: EntityKind::Tool,
                id: "codex".to_string(),
            },
        };
        assert!(!custom_entity.legacy_representable());
        let month_entity = NormalizedEntityRequest {
            query: month,
            entity: NormalizedEntitySelector {
                kind: EntityKind::Tool,
                id: "codex".to_string(),
            },
        };
        assert!(month_entity.legacy_representable());
    }

    #[test]
    fn schema_rejection_of_custom_range_is_classified_as_range_unsupported() {
        // The exact, stable diagnostic a v2-capable-but-unmigrated Supabase
        // project raises from the shared `tokenledger_normalize_query_v2`
        // (T10.113's migration `20260905162953`): HTTP 400, SQLSTATE 22023,
        // message `query-v2: invalid range custom`.
        let body = r#"{"code":"22023","details":null,"hint":null,"message":"query-v2: invalid range custom"}"#;
        assert!(is_custom_range_rejected_by_schema(
            reqwest::StatusCode::BAD_REQUEST,
            body
        ));
        // An unrelated 400 must not be misclassified as range-unsupported.
        assert!(!is_custom_range_rejected_by_schema(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"code":"22P02","message":"invalid input syntax"}"#
        ));
        // Same body text under a different status must not match either.
        assert!(!is_custom_range_rejected_by_schema(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            body
        ));
        // T10.185 review P3-2 shared test vector: the SAME SQLSTATE 22023 but
        // a different, equally real Stats v2 rejection (a too-wide custom
        // range) must not be misread as the migration-not-run signal. Mirrors
        // Android's `SupabaseGatewayTest.kt` `isLegacyCustomRangeRejection`
        // negative case exactly (status 400, code 22023, detail
        // "query-v2: custom range exceeds 731 days").
        assert!(!is_custom_range_rejected_by_schema(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"code":"22023","message":"query-v2: custom range exceeds 731 days"}"#
        ));
        // Mirrors Android's other negative case: same detail text, but a 500
        // instead of 400 must not match.
        assert!(!is_custom_range_rejected_by_schema(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"code":"22023","message":"query-v2: invalid range custom"}"#
        ));
        assert_eq!(
            CloudRpcFailure::new(
                "get_dashboard_stats_v2",
                CloudRpcFailureKind::RangeUnsupported
            )
            .safe_message(),
            CUSTOM_RANGE_CLOUD_UNSUPPORTED
        );
    }

    /// T10.185 review P2-1/FI-1: the three former `reject_custom_range_for_cloud`
    /// call sites (stats, details, entity) must no longer refuse `custom`
    /// before ever reaching cloud code. Unlike the first version of this test
    /// (review finding: it called the `_impl` functions directly, so it never
    /// executed the command-level dispatch where two of the three rejections
    /// actually lived, and a corrupt-config error masked the third), this now
    /// drives the exact functions the client hits:
    /// - stats: `get_cloud_stats_for_query_impl` directly — the former
    ///   rejection sat as the first line of this very function.
    /// - details/entity: `get_usage_details_for_scope` /
    ///   `get_entity_dashboard_for_scope`, the scope-dispatch functions the
    ///   `#[tauri::command]` wrappers now delegate to — the former rejections
    ///   sat in the `StatsScope::Cloud` arm of exactly this dispatch, which a
    ///   call to the `_impl` function alone skips entirely.
    ///
    /// Still hermetic like `cloud_wallpaper_failure_never_falls_back_to_a_local_system_write`:
    /// a malformed (not missing) cloud config fails fast and deterministically
    /// without consulting the real OS keyring, so each assertion is simply
    /// "the failure is not the old client-side rejection text" — proving the
    /// request was dispatched toward cloud code rather than rejected first.
    #[test]
    fn cloud_scope_no_longer_rejects_custom_ranges_before_reaching_cloud_code() {
        let root = temp_root("cloud-custom-range-t10185");
        let app = Arc::new(AppContext::for_test(root.clone()));
        fs::write(root.join(CLOUD_CONFIG_FILE), b"{not-json").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let stats_error = rt
            .block_on(get_cloud_stats_for_query_impl(
                &app,
                custom_query_fixture("2026-07-01", "2026-07-14"),
            ))
            .unwrap_err();
        assert!(
            !stats_error.contains("自定义日期范围"),
            "cloud custom-range stats must reach real cloud code, not the removed rejection: {stats_error}"
        );

        let details_error = rt
            .block_on(get_usage_details_for_scope(
                app.clone(),
                UsageDetailsQuery {
                    scope: Some("cloud".to_string()),
                    range: "custom".to_string(),
                    start: Some("2026-07-01".to_string()),
                    end: Some("2026-07-14".to_string()),
                    timezone: "Asia/Shanghai".to_string(),
                    machines: None,
                    machine: None,
                    tools: None,
                    tool: None,
                    models: None,
                    model: None,
                    search: None,
                    token_mode: None,
                    cursor: None,
                    limit: None,
                    providers: None,
                },
            ))
            .unwrap_err();
        assert!(
            !details_error.contains("自定义日期范围"),
            "cloud custom-range details must reach the scope dispatch's cloud arm, not the removed rejection: {details_error}"
        );

        let entity_error = rt
            .block_on(get_entity_dashboard_for_scope(
                app.clone(),
                EntityDashboardQuery {
                    scope: Some("cloud".to_string()),
                    entity: Some(EntitySelectorInput {
                        kind: "tool".to_string(),
                        id: "codex".to_string(),
                    }),
                    range: "custom".to_string(),
                    start: Some("2026-07-01".to_string()),
                    end: Some("2026-07-14".to_string()),
                    timezone: "Asia/Shanghai".to_string(),
                    machines: None,
                    machine: None,
                    tools: None,
                    tool: None,
                    models: None,
                    model: None,
                    search: None,
                    token_mode: None,
                },
            ))
            .unwrap_err();
        assert!(
            !entity_error.contains("自定义日期范围"),
            "cloud custom-range entity dashboard must reach the scope dispatch's cloud arm, not the removed rejection: {entity_error}"
        );

        fs::remove_dir_all(root).unwrap();
    }

    /// T10.185 review P2-1/FI-3a: `classify_cloud_rpc_failure` (the pure
    /// classification chain extracted from `CloudRpcContext::call`) must keep
    /// telling apart the two distinct old-server shapes: a v2 RPC that does
    /// not exist at all (`MissingSignature`) versus one that exists but whose
    /// shared normalizer schema-rejects `custom` because migration
    /// `20260905162953` has not run yet (`RangeUnsupported`). Losing the
    /// latter branch would make an unmigrated server's honest 400/`22023`
    /// fall through to a generic `Http(400)`, which `safe_message()` would
    /// render as "Cloud RPC request failed (HTTP 400)." instead of "云端范围受限".
    #[test]
    fn classify_cloud_rpc_failure_tells_missing_signature_from_unmigrated_schema_rejection() {
        let missing_signature_body = r#"{"code":"PGRST202","message":"Could not find the function public.get_dashboard_stats_v2 in the schema cache"}"#;
        assert_eq!(
            classify_cloud_rpc_failure(
                reqwest::StatusCode::NOT_FOUND,
                missing_signature_body,
                "get_dashboard_stats_v2",
            ),
            CloudRpcFailureKind::MissingSignature
        );

        let unmigrated_schema_body =
            r#"{"code":"22023","message":"query-v2: invalid range custom"}"#;
        assert_eq!(
            classify_cloud_rpc_failure(
                reqwest::StatusCode::BAD_REQUEST,
                unmigrated_schema_body,
                "get_dashboard_stats_v2",
            ),
            CloudRpcFailureKind::RangeUnsupported
        );

        // An unrelated 400 (not the specific 22023/invalid-range-custom shape)
        // must not be swept into `RangeUnsupported`.
        let unrelated_bad_request = r#"{"code":"22P02","message":"invalid input syntax"}"#;
        assert_eq!(
            classify_cloud_rpc_failure(
                reqwest::StatusCode::BAD_REQUEST,
                unrelated_bad_request,
                "get_dashboard_stats_v2",
            ),
            CloudRpcFailureKind::Http(400)
        );

        assert_eq!(
            classify_cloud_rpc_failure(
                reqwest::StatusCode::FORBIDDEN,
                "{}",
                "get_dashboard_stats_v2"
            ),
            CloudRpcFailureKind::AuthRequired
        );
    }

    fn synthetic_cloud_rpc_context(app: &AppContext) -> CloudRpcContext {
        // T10.185 review P2-1/FI-3b: a hand-built context for exercising the
        // `resolve_cloud_*_v2_result` decision functions directly. It is never
        // used to send a request or to check `session_lease` in the tests
        // that use it below (both arms under test return before touching
        // `context` again), so a dummy lease and loopback-only config are
        // safe — no network call, no real OS keyring, no real coordinator
        // state is touched.
        CloudRpcContext {
            app: app.clone(),
            config: CloudConfig {
                supabase_url: "http://127.0.0.1:1".to_string(),
                supabase_key: "test-key".to_string(),
                session: None,
            },
            session: CloudSession {
                access_token: "fixture-access".to_string(),
                refresh_token: "fixture-refresh".to_string(),
                user_id: "fixture-user".to_string(),
                email: "fixture@example.invalid".to_string(),
                expires_at: 9_999_999_999,
            },
            client: reqwest::Client::new(),
            session_lease: CloudSessionUseLease {
                coordinator: cloud_session_coordinator(),
                generation: 0,
                gate_epoch: 0,
            },
        }
    }

    /// T10.185 review P2-1/FI-3b: when the v2 signature is entirely missing
    /// (old/unmigrated server, not just the migration-not-run schema
    /// rejection) and the query used a custom range, no legacy dashboard
    /// signature has ever accepted `start`/`end`, so the result must stay the
    /// specific `CUSTOM_RANGE_CLOUD_UNSUPPORTED` text — never the generic
    /// capability-missing `safe_message()`. Drives the real
    /// `resolve_cloud_dashboard_v2_result` with a synthetic failure; no
    /// network or keyring involved.
    #[test]
    fn missing_signature_with_custom_range_keeps_the_range_message_for_dashboard() {
        let root = temp_root("cloud-custom-range-t10185-dashboard-resolve");
        let app = AppContext::for_test(root.clone());
        let context = synthetic_cloud_rpc_context(&app);
        let query = custom_query_fixture("2026-07-01", "2026-07-14");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let error = rt
            .block_on(resolve_cloud_dashboard_v2_result(
                &context,
                &query,
                Err(CloudRpcFailure::new(
                    RPC_DASHBOARD_STATS_V2,
                    CloudRpcFailureKind::MissingSignature,
                )),
            ))
            .unwrap_err();
        assert_eq!(error, CUSTOM_RANGE_CLOUD_UNSUPPORTED);
        fs::remove_dir_all(root).unwrap();
    }

    /// T10.185 review P2-1/FI-3b: same invariant as the dashboard case above,
    /// for the usage-details RPC.
    #[test]
    fn missing_signature_with_custom_range_keeps_the_range_message_for_details() {
        let root = temp_root("cloud-custom-range-t10185-details-resolve");
        let app = AppContext::for_test(root.clone());
        let context = synthetic_cloud_rpc_context(&app);
        let request = CloudDetailsRequest {
            query: custom_query_fixture("2026-07-01", "2026-07-14"),
            cursor: None,
            limit: 50,
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let error = rt
            .block_on(resolve_cloud_details_v2_result(
                &context,
                &request,
                Err(CloudRpcFailure::new(
                    RPC_USAGE_DETAILS_V2,
                    CloudRpcFailureKind::MissingSignature,
                )),
            ))
            .unwrap_err();
        assert_eq!(error, CUSTOM_RANGE_CLOUD_UNSUPPORTED);
        fs::remove_dir_all(root).unwrap();
    }

    /// T10.185 review P2-1/FI-3b: same invariant as the dashboard case above,
    /// for the entity dashboard RPC.
    #[test]
    fn missing_signature_with_custom_range_keeps_the_range_message_for_entity() {
        let root = temp_root("cloud-custom-range-t10185-entity-resolve");
        let app = AppContext::for_test(root.clone());
        let context = synthetic_cloud_rpc_context(&app);
        let normalized = normalize_entity_query(&EntityDashboardQuery {
            scope: Some("cloud".to_string()),
            entity: Some(EntitySelectorInput {
                kind: "tool".to_string(),
                id: "codex".to_string(),
            }),
            range: "custom".to_string(),
            start: Some("2026-07-01".to_string()),
            end: Some("2026-07-14".to_string()),
            timezone: "Asia/Shanghai".to_string(),
            machines: None,
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: None,
        })
        .unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let error = rt
            .block_on(resolve_cloud_entity_v2_result(
                &context,
                &normalized,
                Err(CloudRpcFailure::new(
                    RPC_ENTITY_DASHBOARD_V2,
                    CloudRpcFailureKind::MissingSignature,
                )),
            ))
            .unwrap_err();
        assert_eq!(error, CUSTOM_RANGE_CLOUD_UNSUPPORTED);
        fs::remove_dir_all(root).unwrap();
    }

    /// T10.185 review P2-1/FI-2R: the persistent stats cache fingerprint must
    /// key on time zone, not just the wall-clock `start`/`end` dates. Once
    /// cloud `custom` ranges are live, the same `start`/`end` in two
    /// different time zones are different absolute windows (a UTC+8 and a
    /// UTC-8 "2026-07-01..2026-07-14" cover different instants) — without
    /// this, they would collide in the persistent cache.
    #[test]
    fn fingerprint_differs_across_time_zones_for_the_same_custom_range() {
        let shanghai = custom_query_fixture("2026-07-01", "2026-07-14");
        let los_angeles = NormalizedStatsQuery::from_query(LocalStatsQuery {
            range: "custom".to_string(),
            start: Some("2026-07-01".to_string()),
            end: Some("2026-07-14".to_string()),
            timezone: "America/Los_Angeles".to_string(),
            machines: None,
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: None,
        })
        .unwrap();
        assert_ne!(shanghai.timezone, los_angeles.timezone);
        assert_ne!(shanghai.fingerprint(None), los_angeles.fingerprint(None));
    }

    /// T10.185 review P3-1: a custom range whose start is after "today" in
    /// the request's time zone can never be satisfied — reject it locally
    /// (clear, specific message) rather than let it reach a cloud RPC and
    /// come back as a network-classified error.
    #[test]
    fn custom_range_start_after_today_in_request_timezone_is_rejected() {
        let far_future_error = NormalizedStatsQuery::from_query(LocalStatsQuery {
            range: "custom".to_string(),
            start: Some("2099-06-15".to_string()),
            end: Some("2099-06-15".to_string()),
            timezone: "Asia/Shanghai".to_string(),
            machines: None,
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: None,
        })
        .unwrap_err();
        assert!(far_future_error.contains("after today"));
        assert!(!far_future_error.contains("云端版本不兼容"));

        // "today" itself, in the request's time zone, must still be allowed —
        // this is a "not after today" rule, not "must be strictly before".
        let today_in_shanghai = Utc::now().with_timezone(&"Asia/Shanghai".parse::<Tz>().unwrap());
        let today = today_in_shanghai
            .date_naive()
            .format("%Y-%m-%d")
            .to_string();
        let allowed = NormalizedStatsQuery::from_query(LocalStatsQuery {
            range: "custom".to_string(),
            start: Some(today.clone()),
            end: Some(today),
            timezone: "Asia/Shanghai".to_string(),
            machines: None,
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: None,
        });
        assert!(
            allowed.is_ok(),
            "today itself must be an allowed custom-range start: {allowed:?}"
        );
    }

    #[test]
    fn cloud_wallpaper_failure_never_falls_back_to_a_local_system_write() {
        let root = temp_root("cloud-wallpaper-fail-closed");
        let app = AppContext::for_test(root.clone());
        let settings = AppSettings {
            wallpaper_desktop_enabled: true,
            wallpaper_dynamic_bg_enabled: false,
            wallpaper_use_cloud: true,
            ..Default::default()
        };
        settings::save_settings_file(&app, &settings).unwrap();
        // Keep this test hermetic: a missing config would otherwise let the
        // production loader consult (and potentially migrate) the developer's
        // real operating-system credential store.
        fs::write(root.join(CLOUD_CONFIG_FILE), b"{not-json").unwrap();

        let error = perform_wallpaper_update(&app, "desktop").unwrap_err();

        assert!(error.contains("Cloud wallpaper update aborted"));
        assert!(!root.join("wallpapers/wallpaper_current.png").exists());
        assert!(!root.join("lockscreens/lockscreen_current.png").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn direct_lockscreen_request_is_rejected_before_rendering() {
        let root = temp_root("unsupported-lockscreen");
        let app = AppContext::for_test(root.clone());

        let error = perform_wallpaper_update(&app, "lockscreen").unwrap_err();

        assert!(error.contains("only supported on Windows"));
        assert!(!root.join("lockscreens/lockscreen_current.png").exists());
        assert!(!root.join("lockscreens").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dynamic_desktop_update_skips_cloud_stats_and_raster_rendering() {
        let root = temp_root("dynamic-wallpaper-no-stats");
        let app = AppContext::for_test(root.clone());
        let settings = AppSettings {
            wallpaper_desktop_enabled: true,
            wallpaper_dynamic_bg_enabled: true,
            wallpaper_use_cloud: true,
            ..Default::default()
        };
        settings::save_settings_file(&app, &settings).unwrap();

        let (desktop, lockscreen, returned_path) =
            perform_wallpaper_update(&app, "desktop").unwrap();

        assert!(desktop);
        assert!(!lockscreen);
        assert!(returned_path.ends_with("wallpapers/wallpaper_current.png"));
        assert!(!Path::new(&returned_path).exists());
        fs::remove_dir_all(root).unwrap();
    }
}

// ================= NATIVE SETTERS/GETTERS =================

#[cfg(target_os = "windows")]
fn get_screen_size() -> (u32, u32) {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDeviceCaps, ReleaseDC, DESKTOPHORZRES, DESKTOPVERTRES,
    };
    unsafe {
        let hdc = GetDC(None);
        let w = GetDeviceCaps(Some(hdc), DESKTOPHORZRES);
        let h = GetDeviceCaps(Some(hdc), DESKTOPVERTRES);
        ReleaseDC(None, hdc);
        if w > 0 && h > 0 {
            (w as u32, h as u32)
        } else {
            (1920, 1080)
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn get_screen_size() -> (u32, u32) {
    (1920, 1080)
}

// ================= APP COMMANDS =================

pub fn get_settings_impl(app: &AppContext) -> Result<AppSettings, String> {
    Ok(settings::load_settings(app))
}

pub fn get_prices_impl(app: &AppContext) -> Result<Value, String> {
    Ok(load_prices(app))
}

/// Only what the user changed in the price editor, for a local backup
/// (`local-backup-v1`): the defaults (online table, else bundled) are left
/// out so a restore never pins older defaults over newer ones.
pub(crate) fn price_overrides_for_backup(app: &AppContext) -> Map<String, Value> {
    let _guard = lock_price_overrides();
    price_overrides_locked(app)
}

fn price_overrides_locked(app: &AppContext) -> Map<String, Value> {
    read_price_overrides(
        app.app_data_dir(),
        &price_feed::effective_defaults(app.app_data_dir()),
    )
    .0
    .unwrap_or_default()
}

/// Replaces the user's price overrides with `merge(current)` through the
/// editor's save path, so costs are recalculated where rates change. Reading,
/// merging and saving share the lock an online update takes to install a new
/// table: the defaults cannot change in between. Returns whether anything
/// changed.
pub(crate) fn restore_price_overrides(
    app: &AppContext,
    merge: impl FnOnce(&Map<String, Value>) -> Map<String, Value>,
) -> Result<bool, String> {
    let _guard = lock_price_overrides();
    let local = price_overrides_locked(app);
    let merged = merge(&local);
    if merged == local {
        return Ok(false);
    }
    let table = merge_discovered_prices(
        apply_price_overrides(&price_feed::effective_defaults(app.app_data_dir()), &merged),
        &load_discovered_model_prices(app),
    );
    save_prices_locked(app, table)?;
    Ok(true)
}

/// Writes `prices` as a downloaded table newer than the bundled one.
#[cfg(test)]
pub(crate) fn install_test_price_feed(app: &AppContext, prices: Value) {
    price_feed::install_for_test(app.app_data_dir(), prices);
}

fn price_rate_snapshot(prices: &Value) -> Value {
    let mut snapshot = Map::new();
    let Some(models) = prices.as_object() else {
        return Value::Object(snapshot);
    };
    for (model, config) in models {
        let Some(config) = config.as_object() else {
            continue;
        };
        let mut rates = Map::new();
        for field in ["input", "output", "cache_input", "cache_write"] {
            if let Some(value) = config.get(field).and_then(Value::as_f64) {
                rates.insert(field.to_string(), json!(value));
            }
        }
        // Old-price segments and long-context tiers change what a record
        // costs as much as the rates do (price table schema 2).
        for field in ["history", "tiers"] {
            if let Some(value) = config.get(field) {
                rates.insert(field.to_string(), value.clone());
            }
        }
        snapshot.insert(model.clone(), Value::Object(rates));
    }
    Value::Object(snapshot)
}

/// Why a save or reset left a price file alone whose migration waits for a
/// backup (`PriceOverridesRead::migration_postponed`). The settings page
/// shows them after 「保存价格表失败: 」 or 「重置价格表失败: 」.
const PRICE_SAVE_WAITS_FOR_BACKUP: &str = "价格文件需要按新版规则整理，但原文件没能备份。为了不丢掉你原来的价格，这次没有保存，价格文件也没有改动。请确认应用数据目录可以写入、磁盘还有空间，然后重新启动 TokenLedger：启动时会先备份再整理，之后再改价格。编辑框里还没保存的修改，需要的话先复制下来。";
const PRICE_RESET_WAITS_FOR_BACKUP: &str = "价格文件需要按新版规则整理，但原文件没能备份。为了不丢掉你原来的价格，这次没有恢复默认，价格文件也没有改动。请确认应用数据目录可以写入、磁盘还有空间，然后重新启动 TokenLedger：启动时会先备份再整理，之后再恢复默认。";

/// Saves the editor's whole table. Only real edits reach the override file
/// (see `price_overrides_from_edit`); repricing runs when the effective rates
/// actually change, compared like prices (`price_values_equal`). This entry
/// checks no editor revision: it is for callers that hand over a whole table
/// of their own, such as restoring a backup, and for tests. The settings
/// editor goes through `save_prices_for_editor`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn save_prices_impl(app: &AppContext, prices: Value) -> Result<Value, String> {
    let _guard = lock_price_overrides();
    save_prices_locked(app, prices)
}

/// `save_prices_impl` for the editor: the table revision it loaded is checked
/// under the same lock an online update takes to install a new table, so an
/// update cannot land between the check and the save.
pub fn save_prices_for_editor(
    app: &AppContext,
    prices: Value,
    editor_revision: Option<u64>,
) -> Result<Value, String> {
    let _guard = lock_price_overrides();
    price_feed::ensure_editor_revision(app.app_data_dir(), editor_revision)?;
    save_prices_locked(app, prices)
}

fn save_prices_locked(app: &AppContext, prices: Value) -> Result<Value, String> {
    let previous_recovery = price_repricing::recover(app);
    let defaults = price_feed::effective_defaults(app.app_data_dir());
    let (previous, read) = load_saved_prices_locked(app);
    if read.migration_postponed {
        return Err(PRICE_SAVE_WAITS_FOR_BACKUP.to_string());
    }
    let discovered = load_discovered_model_prices(app);
    let previous_rates =
        price_rate_snapshot(&merge_discovered_prices(previous.clone(), &discovered));
    let overrides = price_overrides_from_edit(&defaults, &previous, &prices)?;
    let next = merge_discovered_prices(apply_price_overrides(&defaults, &overrides), &discovered);
    // Entries edited in this save pass the same checks as the bundled and
    // downloaded tables, so a negative multiplier never prices a record. An
    // older override left unchanged is not re-checked, so it cannot block
    // saving other models.
    for (model, entry) in &overrides {
        let edited_now = !next
            .get(model)
            .zip(previous.get(model))
            .is_some_and(|(next, previous)| price_values_equal(next, previous));
        if entry.is_object() && edited_now {
            price_schedule::validate_entry(model, entry)?;
        }
    }
    let prices_changed = !price_values_equal(&previous_rates, &price_rate_snapshot(&next));
    let bytes = if overrides.is_empty() {
        None
    } else {
        Some(serde_json::to_vec_pretty(&overrides).map_err(|e| e.to_string())?)
    };
    if previous_recovery.pending {
        // An editor can resend 12.0 as 12 or reorder fields. Preserve the
        // intent's exact digest, but accept an unchanged effective table.
        if !price_values_equal(&next, &merge_discovered_prices(previous, &discovered)) {
            return Err("上次价格已经保存，但统计重算尚未完成；请先再次保存相同价格或重启应用重试，再修改价格。".into());
        }
        return Ok(price_save_result("价格已保存。", &previous_recovery));
    }
    let intent = if prices_changed {
        Some(price_repricing::prepare(
            app.app_data_dir(),
            bytes.as_deref(),
        )?)
    } else {
        None
    };
    if let Err(error) = store_price_overrides(app.app_data_dir(), &overrides) {
        if !intent.as_ref().is_some_and(|i| {
            price_repricing::matches_current(app.app_data_dir(), i).unwrap_or(false)
        }) {
            let _ = price_repricing::recover(app);
            return Err(error);
        }
        // Rename may have succeeded before a durability confirmation failed.
        let mut recovery = price_repricing::recover(app);
        recovery.warning = Some(format!(
            "价格文件已更新，但持久化确认失败；请检查磁盘状态。{}",
            recovery.warning.unwrap_or_default()
        ));
        return Ok(price_save_result("价格文件已更新。", &recovery));
    }
    cache::invalidate_all(&db::get_db_path(app));
    let mut recovery = if intent.is_some() {
        price_repricing::recover(app)
    } else {
        price_repricing::Recovery::default()
    };
    recovery.repriced += previous_recovery.repriced;
    if recovery.warning.is_none() {
        recovery.warning = previous_recovery.warning;
    }
    Ok(price_save_result(
        if overrides.is_empty() {
            "Using bundled default prices."
        } else {
            "Saved price overrides."
        },
        &recovery,
    ))
}

fn price_save_result(message: &str, recovery: &price_repricing::Recovery) -> Value {
    json!({"saved":true,"message":if recovery.repriced>0 {format!("{} 已标记 {} 条估算记录重新计价。",message,recovery.repriced)} else {message.to_string()},
        "repriced":recovery.repriced,"repricing_pending":recovery.pending,"warning":recovery.warning})
}

pub fn reset_prices_impl(app: &AppContext) -> Result<Value, String> {
    let _guard = lock_price_overrides();
    let previous_recovery = price_repricing::recover(app);
    let discovered = load_discovered_model_prices(app);
    let (previous, read) = load_saved_prices_locked(app);
    if read.migration_postponed {
        return Err(PRICE_RESET_WAITS_FOR_BACKUP.to_string());
    }
    let previous_rates = price_rate_snapshot(&merge_discovered_prices(previous, &discovered));
    let prices = merge_discovered_prices(
        price_feed::effective_defaults(app.app_data_dir()),
        &discovered,
    );
    if previous_recovery.pending {
        if price_repricing::file_digest(app.app_data_dir())?.is_some() {
            return Err("上次价格已经保存，但统计重算尚未完成；请先再次保存相同价格或重启应用重试，再恢复默认。".into());
        }
        let mut result = price_save_result("已恢复默认价格。", &previous_recovery);
        result["prices"] = prices;
        return Ok(result);
    }
    let changed = !price_values_equal(&previous_rates, &price_rate_snapshot(&prices));
    let intent = if changed {
        Some(price_repricing::prepare(app.app_data_dir(), None)?)
    } else {
        None
    };
    if let Err(error) = remove_price_overrides(app.app_data_dir()) {
        if !intent.as_ref().is_some_and(|i| {
            price_repricing::matches_current(app.app_data_dir(), i).unwrap_or(false)
        }) {
            let _ = price_repricing::recover(app);
            return Err(error);
        }
        let mut recovery = price_repricing::recover(app);
        recovery.warning = Some(format!(
            "默认价格已恢复，但持久化确认失败；请检查磁盘状态。{}",
            recovery.warning.unwrap_or_default()
        ));
        let mut result = price_save_result("已恢复默认价格。", &recovery);
        result["prices"] = prices;
        return Ok(result);
    }
    cache::invalidate_all(&db::get_db_path(app));
    let mut recovery = if intent.is_some() {
        price_repricing::recover(app)
    } else {
        price_repricing::Recovery::default()
    };
    recovery.repriced += previous_recovery.repriced;
    if recovery.warning.is_none() {
        recovery.warning = previous_recovery.warning;
    }
    let mut result = price_save_result("已恢复默认价格。", &recovery);
    result["prices"] = prices;
    Ok(result)
}

pub fn get_db_info_impl(app: &AppContext) -> Result<Value, String> {
    let db_path = db::get_db_path(app);
    let size_bytes = fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);

    let conn = db::get_connection(&db_path).map_err(|e| e.to_string())?;

    let total_records: i64 = conn
        .query_row("SELECT COUNT(*) FROM token_logs", [], |row| row.get(0))
        .unwrap_or(0);

    let unsynced_records: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM token_logs WHERE sync_status = 0 OR cloud_user_id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let earliest: String = conn
        .query_row("SELECT MIN(timestamp) FROM token_logs", [], |row| {
            row.get(0)
        })
        .unwrap_or(None)
        .unwrap_or_else(|| "-".to_string());

    let latest: String = conn
        .query_row("SELECT MAX(timestamp) FROM token_logs", [], |row| {
            row.get(0)
        })
        .unwrap_or(None)
        .unwrap_or_else(|| "-".to_string());

    // T10.105c：暴露空闲页，让设置页能说明“可回收多少”而不是只报文件大小。
    let footprint = db::storage_footprint(&conn).ok();
    let reclaimable_bytes = footprint.map(|f| f.reclaimable_bytes()).unwrap_or(0);
    let freelist_pages = footprint.map(|f| f.freelist_pages).unwrap_or(0);

    Ok(json!({
        "path": db_path.to_string_lossy().to_string(),
        "totalRecords": total_records,
        "unsyncedRecords": unsynced_records,
        "sizeBytes": size_bytes,
        "reclaimableBytes": reclaimable_bytes,
        "freelistPages": freelist_pages,
        "earliest": earliest,
        "latest": latest,
    }))
}

pub fn export_db_csv_impl(app: &AppContext) -> Result<Value, String> {
    let db_path = db::get_db_path(app);
    let app_dir = app.app_data_dir();
    let export_path = app_dir.join("tokenledger_export.csv");

    let conn = db::get_connection(&db_path).map_err(|e| e.to_string())?;
    // 与本机看板同一张生效价格表：内置表 + 用户价格覆盖 + 自动发现的待核价项。
    let (csv_content, count) = ledger_csv(&conn, &load_prices(app))?;

    fs::write(&export_path, csv_content).map_err(|e| e.to_string())?;

    Ok(json!({
        "message": format!("成功导出 {} 条记录", count),
        "path": export_path.to_string_lossy().to_string(),
    }))
}

/// 请求明细 CSV 的上限：远大于逐页导出的条数上限，只用来挡住异常输入。
const USAGE_CSV_MAX_BYTES: usize = 64 * 1024 * 1024;

pub fn export_usage_csv_impl(app: &AppContext, content: &str) -> Result<Value, String> {
    if content.len() > USAGE_CSV_MAX_BYTES {
        return Err("导出内容过大，请缩小范围或筛选后再导出".to_string());
    }
    let rows = content.lines().count().saturating_sub(1);
    let export_path = app.app_data_dir().join("tokenledger_requests.csv");
    // 加 BOM，Excel 直接打开时中文模型名与设备名不乱码。
    let mut body = String::with_capacity(content.len() + 3);
    body.push('\u{feff}');
    body.push_str(content);
    fs::write(&export_path, body).map_err(|e| e.to_string())?;
    Ok(json!({
        "message": format!("已导出 {} 条记录", rows),
        "path": export_path.to_string_lossy().to_string(),
    }))
}

#[cfg(test)]
mod export_usage_csv_tests {
    use super::*;

    fn temp_app(tag: &str) -> AppContext {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_usage_csv_{tag}_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        AppContext::for_test(path)
    }

    #[test]
    fn writes_fixed_file_with_bom_and_counts_rows() {
        let app = temp_app("ok");
        let result =
            export_usage_csv_impl(&app, "time,tool\n2026-07-15,codex\n2026-07-15,claude\n")
                .expect("export");
        assert_eq!(result["message"], "已导出 2 条记录");
        let written =
            fs::read_to_string(app.app_data_dir().join("tokenledger_requests.csv")).expect("read");
        assert!(written.starts_with('\u{feff}'));
        assert_eq!(
            written.trim_start_matches('\u{feff}').lines().next(),
            Some("time,tool")
        );
    }

    #[test]
    fn rejects_oversized_content() {
        let app = temp_app("big");
        let content = "x".repeat(USAGE_CSV_MAX_BYTES + 1);
        assert!(export_usage_csv_impl(&app, &content).is_err());
        assert!(!app.app_data_dir().join("tokenledger_requests.csv").exists());
    }
}

/// 导出 CSV 的正文与记录数。`prices` 只用于 `estimated_cost_usd`；由调用方传入，
/// 测试可以换一张查不到价格的表。
/// 导出 CSV 的单元格。型号、工具、会话 ID 来自别的程序写的日志，以 `=`、`+`、
/// `-`、`@` 或制表符开头的值在表格软件里会被当成公式执行，所以前面加 `'`。
fn csv_field(s: &str) -> String {
    let s = if s.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{s}")
    } else {
        s.to_string()
    };
    if s.contains([',', '"', '\n', '\r', '\'']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

fn ledger_csv(conn: &Connection, prices: &Value) -> Result<(String, usize), String> {
    ledger_csv_window(conn, prices, None)
}

/// 导出列（CSV 表头与 JSON 键同名）。桌面「导出 CSV」与命令行导出共用这一份。
const LEDGER_EXPORT_COLUMNS: [&str; 16] = [
    "id",
    "tool",
    "model",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "cache_write_tokens",
    "timestamp",
    "session_id",
    "unique_key",
    "cost_usd",
    "estimated_cost_usd",
    "machine_id",
    "sync_status",
    "cloud_user_id",
    "synced_at",
];

/// 账本导出的一行，CSV 与 JSON 从同一份取值生成。
struct LedgerExportRow {
    log: StatRow,
    unique_key: String,
    sync_status: i32,
    cloud_user_id: String,
    synced_at: String,
    estimated_cost_usd: Option<f64>,
}

/// 账本时间闭区间（存储格式的本地时间）；`None` 起点表示不设下限。
type LedgerWindow = (Option<String>, String);

fn for_each_ledger_row(
    conn: &Connection,
    prices: &Value,
    window: Option<&LedgerWindow>,
    mut visit: impl FnMut(LedgerExportRow),
) -> Result<usize, String> {
    let mut sql = String::from("SELECT id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status, cloud_user_id, synced_at, cache_write_known, usage_provenance FROM token_logs WHERE 1 = 1");
    let mut values: Vec<SqlValue> = Vec::new();
    if let Some((start, end)) = window {
        if let Some(start) = start {
            sql.push_str(" AND timestamp >= ?");
            values.push(SqlValue::Text(start.clone()));
        }
        sql.push_str(" AND timestamp <= ?");
        values.push(SqlValue::Text(end.clone()));
    }
    sql.push_str(" ORDER BY timestamp DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let mut estimator = CsvCostEstimator::new(prices);
    let mut rows = stmt
        .query(rusqlite::params_from_iter(values))
        .map_err(|e| e.to_string())?;
    let mut count = 0;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        // 看板汇总用的行结构，逐行估价才能直接复用 `PriceMemo::row_price`。
        let log = StatRow {
            pricing_timestamp: None,
            id: row.get(0).unwrap_or(0),
            tool: row.get(1).unwrap_or_default(),
            model: row.get(2).unwrap_or_default(),
            input_tokens: row.get(3).unwrap_or(0),
            output_tokens: row.get(4).unwrap_or(0),
            cached_tokens: row.get(5).unwrap_or(0),
            cache_write_tokens: row.get(6).unwrap_or(0),
            cache_write_known: row.get(15).unwrap_or(None),
            usage_provenance: row.get(16).unwrap_or(None),
            timestamp: row.get(7).unwrap_or_default(),
            session_id: row.get(8).unwrap_or_default(),
            // NULL 表示账本没存费用（看板读取时按价格表现算），导出写空而不是 0，
            // 免得把「没存」读成「免费」（T10.154 D70，GLB-01）。
            cost_usd: row.get(10).ok().flatten(),
            machine_id: row.get(11).unwrap_or_default(),
        };
        let estimated_cost_usd = estimator.estimate(&log);
        visit(LedgerExportRow {
            log,
            unique_key: row.get(9).unwrap_or_default(),
            sync_status: row.get(12).unwrap_or(0),
            cloud_user_id: row.get(13).unwrap_or_default(),
            synced_at: row.get(14).unwrap_or_default(),
            estimated_cost_usd,
        });
        count += 1;
    }
    Ok(count)
}

fn ledger_csv_window(
    conn: &Connection,
    prices: &Value,
    window: Option<&LedgerWindow>,
) -> Result<(String, usize), String> {
    let mut csv_content = LEDGER_EXPORT_COLUMNS.join(",");
    csv_content.push('\n');
    let esc = csv_field;
    // 两个费用列同一数字格式；None 写空。
    let usd = |cost: Option<f64>| cost.map(|cost| cost.to_string()).unwrap_or_default();
    let count = for_each_ledger_row(conn, prices, window, |row| {
        let log = &row.log;
        csv_content.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            log.id,
            esc(&log.tool),
            esc(&log.model),
            log.input_tokens,
            log.output_tokens,
            log.cached_tokens,
            log.cache_write_tokens,
            esc(&log.timestamp),
            esc(&log.session_id),
            esc(&row.unique_key),
            usd(log.cost_usd),
            usd(row.estimated_cost_usd),
            esc(&log.machine_id),
            row.sync_status,
            esc(&row.cloud_user_id),
            esc(&row.synced_at)
        ));
    })?;
    Ok((csv_content, count))
}

/// JSON 导出：与 CSV 同列同值，费用不可得写 `null`；字符串原样输出，不加 CSV 的公式防护前缀。
fn ledger_json_window(
    conn: &Connection,
    prices: &Value,
    window: Option<&LedgerWindow>,
) -> Result<(Value, usize), String> {
    let mut items = Vec::new();
    let count = for_each_ledger_row(conn, prices, window, |row| {
        let log = row.log;
        let values = [
            json!(log.id),
            json!(log.tool),
            json!(log.model),
            json!(log.input_tokens),
            json!(log.output_tokens),
            json!(log.cached_tokens),
            json!(log.cache_write_tokens),
            json!(log.timestamp),
            json!(log.session_id),
            json!(row.unique_key),
            json!(log.cost_usd),
            json!(row.estimated_cost_usd),
            json!(log.machine_id),
            json!(row.sync_status),
            json!(row.cloud_user_id),
            json!(row.synced_at),
        ];
        let item: serde_json::Map<String, Value> = LEDGER_EXPORT_COLUMNS
            .iter()
            .map(|column| column.to_string())
            .zip(values)
            .collect();
        items.push(Value::Object(item));
    })?;
    Ok((Value::Array(items), count))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LedgerExportFormat {
    Csv,
    Json,
}

/// 命令行导出：`range` 为空时导出整本账本（与桌面「导出 CSV」相同），否则按看板同一套
/// 时间窗（同一时区规则与闭区间）筛选。返回正文与记录数，写到哪里由调用方决定。
pub(crate) fn export_ledger_impl(
    app: &AppContext,
    range: Option<LocalStatsQuery>,
    format: LedgerExportFormat,
) -> Result<(String, usize), String> {
    let window = match range {
        Some(query) => {
            let query = NormalizedStatsQuery::from_query(query)?;
            let bounds = query_bounds(query.range, Local::now().with_timezone(&query.tz))?;
            Some((
                bounds
                    .current_start
                    .as_ref()
                    .map(|start| storage_timestamp(storage_boundary(start))),
                storage_timestamp(storage_boundary(&bounds.current_end)),
            ))
        }
        None => None,
    };
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let conn = db::get_connection(&db_path).map_err(|e| e.to_string())?;
    let prices = load_prices(app);
    match format {
        LedgerExportFormat::Csv => ledger_csv_window(&conn, &prices, window.as_ref()),
        LedgerExportFormat::Json => {
            let (items, count) = ledger_json_window(&conn, &prices, window.as_ref())?;
            let text = serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?;
            Ok((text, count))
        }
    }
}

/// CSV `estimated_cost_usd` 的逐行取值（用户决定 U-11，T10.196）：本机看板汇总逐行计入
/// 预估费用的同一个数，即 `PriceMemo::row_price(..).cost`。账本存了费用就是该值；否则按
/// 同一张价格表与同一套兜底现算（最长型号匹配 → 工具兜底键 → `default`；缺缓存读写价按
/// 输入价 × 0.1 / × 1.25；读取量 = max(缓存合计 − 写入, 0)）。
///
/// 价格表里型号、工具兜底键与 `default` 都查不到时价格不可得，返回 `None` 写空，不写 0
/// （GLB-01）。看板此时仍按代码里的缺省单价（输入 1、输出 3）计；但内置价格表总带
/// `default`，用户覆盖只能改、不能删，实际账本走不到这一支。
///
/// 结果不是有限数时也写空（T10.196 评审 P3-1，root 决定 R-49）：账本存的金额是 ±∞
/// （畸形来源数据，NaN 写进 SQLite 即成 NULL），或单价大到乘出溢出。总览对这类行和合计
/// 本来就显示「不可得」，这一列又用于逐行相加，不写 `inf`；`cost_usd` 仍照账本原样。
/// 账本存的金额为负时同样写空、不计入求和（R-64，T10.205；改前是照抄负数，总览 KPI
/// 合计把它算进去、明细逐行反而显示不可得，四处口径不一，见 T10.196 评审 O-1）：
/// 判定统一在 `PriceMemo::row_price` 一处做（见 `stored_cost_or_unavailable`），
/// 这里与总览、明细合计一样，经同一个 `is_finite()` 过滤自动获得。
struct CsvCostEstimator<'p> {
    prices: &'p Value,
    memo: PriceMemo<'p>,
    /// 每个 (工具, 模型) 在价格表里能否查到价格，只查一次。
    priced: HashMap<String, HashMap<String, bool>>,
}

impl<'p> CsvCostEstimator<'p> {
    fn new(prices: &'p Value) -> Self {
        Self {
            prices,
            memo: PriceMemo::new(prices),
            priced: HashMap::new(),
        }
    }

    fn estimate(&mut self, row: &StatRow) -> Option<f64> {
        if row.cost_usd.is_none() && !self.has_price(&row.tool, &row.model) {
            return None;
        }
        Some(self.memo.row_price(row).cost).filter(|cost| cost.is_finite())
    }

    /// 与 `PriceMemo` 同一个解析函数，只看价格来源，不另算单价。
    fn has_price(&mut self, tool: &str, model: &str) -> bool {
        if let Some(priced) = self.priced.get(tool).and_then(|models| models.get(model)) {
            return *priced;
        }
        let (_, source) = lookup_model_price_with_source(self.prices, tool, model);
        let priced = source != PriceSource::Missing;
        self.priced
            .entry(tool.to_string())
            .or_default()
            .insert(model.to_string(), priced);
        priced
    }
}

#[cfg(test)]
mod csv_export_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn csv_export_leaves_unstored_cost_empty_instead_of_zero() {
        let root = std::env::temp_dir().join(format!(
            "tokenledger-csv-export-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let app = AppContext::for_test(root.clone());
        let db_path = db::get_db_path(&app);
        db::init_db(&db_path).expect("initialize test database");
        let conn = db::get_connection(&db_path).expect("open test database");
        for (key, timestamp, cost) in [
            ("csv-priced", "2026-09-24 10:00:00", Some(0.0125)),
            ("csv-unpriced", "2026-09-24 09:00:00", None),
            ("csv-free", "2026-09-24 08:00:00", Some(0.0)),
        ] {
            conn.execute(
                "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id, sync_status) VALUES ('codex', 'gpt-5', 100, 20, 0, 0, ?1, 'session', ?2, ?3, 'machine', 0)",
                rusqlite::params![timestamp, key, cost],
            )
            .expect("insert test log");
        }
        drop(conn);

        let result = export_db_csv_impl(&app).expect("export csv");
        let csv = fs::read_to_string(result["path"].as_str().expect("export path"))
            .expect("read exported csv");
        let cost_of = |key: &str| -> String {
            let line = csv
                .lines()
                .find(|line| line.contains(key))
                .expect("exported row");
            line.split(',')
                .nth(10)
                .expect("cost_usd column")
                .to_string()
        };
        // 列名不变；已知费用照旧写原值，账本没存的写空，真 0 仍写 0。
        assert!(csv.starts_with(
            "id,tool,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,timestamp,session_id,unique_key,cost_usd,"
        ));
        assert_eq!(cost_of("csv-priced"), "0.0125");
        assert_eq!(cost_of("csv-unpriced"), "");
        assert_eq!(cost_of("csv-free"), "0");

        let _ = fs::remove_dir_all(root);
    }

    // ---- `estimated_cost_usd`（用户决定 U-11，T10.196） ----

    /// 一次性的测试账本：临时目录 + 应用自身建库；Drop 时删除。
    struct TestLedger {
        app: AppContext,
    }

    impl Drop for TestLedger {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.app.app_data_dir());
        }
    }

    fn test_ledger(tag: &str) -> TestLedger {
        let root = std::env::temp_dir().join(format!(
            "tokenledger-csv-estimate-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let app = AppContext::for_test(root);
        db::init_db(&db::get_db_path(&app)).expect("initialize test database");
        TestLedger { app }
    }

    impl TestLedger {
        /// 写一条记录；`cache` 是存储口径：（缓存读写合计, 其中写入）。
        fn log(
            &self,
            key: &str,
            (tool, model): (&str, &str),
            (input, output): (i64, i64),
            (cached, cache_write): (i64, i64),
            cost: Option<f64>,
        ) -> &Self {
            let conn = db::get_connection(&db::get_db_path(&self.app)).expect("open test database");
            conn.execute(
                "INSERT INTO token_logs (tool, model, input_tokens, output_tokens, cached_tokens,
                     cache_write_tokens, timestamp, session_id, unique_key, cost_usd, machine_id,
                     sync_status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-09-24 10:00:00', 'session', ?7, ?8,
                         'machine', 0)",
                params![tool, model, input, output, cached, cache_write, key, cost],
            )
            .expect("insert test log");
            self
        }

        fn export(&self) -> String {
            let result = export_db_csv_impl(&self.app).expect("export csv");
            fs::read_to_string(result["path"].as_str().expect("export path"))
                .expect("read exported csv")
        }

        /// 导出一次，按 `unique_key` 取 (`cost_usd`, `estimated_cost_usd`)。
        fn exported_costs(&self) -> HashMap<String, (String, String)> {
            costs_by_key(&self.export())
        }
    }

    /// 按 RFC 4180 把导出文件拆成记录（字段可带引号、逗号与换行）；第一条是表头。
    fn csv_records(text: &str) -> Vec<Vec<String>> {
        let mut records = Vec::new();
        let mut record = Vec::new();
        let mut field = String::new();
        let mut quoted = false;
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            match (quoted, ch) {
                (true, '"') if chars.peek() == Some(&'"') => {
                    field.push('"');
                    chars.next();
                }
                (true, '"') => quoted = false,
                (true, _) => field.push(ch),
                (false, '"') => quoted = true,
                (false, ',') => record.push(std::mem::take(&mut field)),
                (false, '\n') => {
                    record.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut record));
                }
                (false, _) => field.push(ch),
            }
        }
        assert!(
            !quoted && field.is_empty() && record.is_empty(),
            "the export ends with a complete record"
        );
        records
    }

    fn column(header: &[String], name: &str) -> usize {
        header
            .iter()
            .position(|field| field == name)
            .unwrap_or_else(|| panic!("{name} column"))
    }

    /// 每条记录的 (`cost_usd`, `estimated_cost_usd`)，按 `unique_key` 取；顺带核对列数。
    fn costs_by_key(text: &str) -> HashMap<String, (String, String)> {
        let records = csv_records(text);
        let header = &records[0];
        let (key, cost, estimate) = (
            column(header, "unique_key"),
            column(header, "cost_usd"),
            column(header, "estimated_cost_usd"),
        );
        records[1..]
            .iter()
            .map(|record| {
                assert_eq!(record.len(), header.len(), "one field per column");
                (
                    record[key].clone(),
                    (record[cost].clone(), record[estimate].clone()),
                )
            })
            .collect()
    }

    fn pair(cost_usd: &str, estimated_cost_usd: &str) -> (String, String) {
        (cost_usd.to_string(), estimated_cost_usd.to_string())
    }

    #[test]
    fn csv_export_puts_estimated_cost_right_after_cost_usd() {
        let ledger = test_ledger("header");
        // 型号带逗号与引号：该字段加引号后，其余各列仍对齐。
        ledger.log(
            "csv-quoted",
            ("codex", "odd,\"model\""),
            (100, 20),
            (0, 0),
            None,
        );
        let records = csv_records(&ledger.export());
        assert_eq!(
            records[0],
            [
                "id",
                "tool",
                "model",
                "input_tokens",
                "output_tokens",
                "cached_tokens",
                "cache_write_tokens",
                "timestamp",
                "session_id",
                "unique_key",
                "cost_usd",
                "estimated_cost_usd",
                "machine_id",
                "sync_status",
                "cloud_user_id",
                "synced_at",
            ]
        );
        assert_eq!(records.len(), 2, "header plus one row");
        let row = &records[1];
        assert_eq!(row.len(), records[0].len());
        assert_eq!(row[2], "odd,\"model\"");
        assert_eq!(row[9], "csv-quoted");
        assert_eq!(row[10], "", "cost_usd stays the raw ledger value");
        assert_eq!(row[12], "machine");
        // 表外型号按 Codex 的工具兜底键估算，与看板同一兜底，不留空。
        let prices = load_prices(&ledger.app);
        assert_eq!(
            row[11],
            estimate_cost(&prices, "codex", "odd,\"model\"", 100, 20, 0, 0).to_string()
        );
    }

    #[test]
    fn csv_estimated_cost_takes_the_stored_cost_first() {
        let ledger = test_ledger("stored");
        ledger
            .log(
                "stored",
                ("opencode", "claude-sonnet-5"),
                (1_000_000, 1_000_000),
                (0, 0),
                Some(0.5),
            )
            // 带缓存读写的行：看板同样照抄存值，缓存只影响缓存节省。
            .log(
                "stored-cache",
                ("minimax", "claude-sonnet-5"),
                (1_000_000, 0),
                (300_000, 100_000),
                Some(0.0125),
            )
            .log(
                "stored-tiny",
                ("hermes", "gpt-5"),
                (10, 10),
                (0, 0),
                Some(0.000_000_1),
            );
        // 价格表对同一行会算出别的数，照抄才有检验意义。
        let prices = load_prices(&ledger.app);
        assert_eq!(
            estimate_cost(
                &prices,
                "opencode",
                "claude-sonnet-5",
                1_000_000,
                1_000_000,
                0,
                0
            ),
            12.0
        );
        let costs = ledger.exported_costs();
        assert_eq!(costs["stored"], pair("0.5", "0.5"));
        assert_eq!(costs["stored-cache"], pair("0.0125", "0.0125"));
        // 两列同一数字格式：f64 的 Display，不用科学计数法。
        assert_eq!(costs["stored-tiny"], pair("0.0000001", "0.0000001"));
    }

    #[test]
    fn csv_estimated_cost_keeps_a_known_zero() {
        let ledger = test_ledger("zero");
        ledger
            .log(
                "stored-zero",
                ("opencode", "gpt-5"),
                (100, 20),
                (0, 0),
                Some(0.0),
            )
            // 价格表里的真 0：嵌入模型的输出单价是 0，只有输出的记录估出 0。
            .log(
                "priced-zero",
                ("codex", "text-embedding-3-small"),
                (0, 5_000),
                (0, 0),
                None,
            );
        let costs = ledger.exported_costs();
        assert_eq!(costs["stored-zero"], pair("0", "0"));
        assert_eq!(costs["priced-zero"], pair("", "0"));
    }

    #[test]
    fn csv_field_neutralizes_formula_prefixes() {
        assert_eq!(csv_field("gpt-5"), "gpt-5");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
        assert_eq!(csv_field("+1"), "\"'+1\"");
        assert_eq!(csv_field("-2"), "\"'-2\"");
        assert_eq!(csv_field("@SUM(A1)"), "\"'@SUM(A1)\"");
        assert_eq!(csv_field("\tx"), "\"'\tx\"");
    }

    #[test]
    fn csv_estimated_cost_is_blank_when_no_price_is_found() {
        let ledger = test_ledger("unknown");
        ledger
            .log(
                "unpriced",
                ("hermes", "mystery-model"),
                (100, 20),
                (0, 0),
                None,
            )
            .log(
                "unpriced-stored",
                ("hermes", "mystery-model"),
                (100, 20),
                (0, 0),
                Some(0.02),
            )
            .log(
                "priced",
                ("codex", "gpt-5"),
                (1_000_000, 100_000),
                (0, 0),
                None,
            );
        // 一张没有 `default`、也没有工具兜底键的表：Hermes 的表外型号查不到任何价格。
        let prices = json!({ "gpt-5": { "input": 1.25, "output": 10.0 } });
        let conn = db::get_connection(&db::get_db_path(&ledger.app)).expect("open test database");
        let (text, count) = ledger_csv(&conn, &prices).expect("build csv");
        assert_eq!(count, 3);
        let costs = costs_by_key(&text);
        // 不可得写空，不写 0（GLB-01）；账本存了费用照样照抄。
        assert_eq!(costs["unpriced"], pair("", ""));
        assert_eq!(costs["unpriced-stored"], pair("0.02", "0.02"));
        assert_eq!(costs["priced"], pair("", "2.25"));

        // 同一条记录在内置表下按 `default` 估算，不留空（看板同一兜底）。
        let bundled = ledger.exported_costs();
        assert_eq!(
            bundled["unpriced"],
            pair(
                "",
                &estimate_cost(
                    &load_prices(&ledger.app),
                    "hermes",
                    "mystery-model",
                    100,
                    20,
                    0,
                    0
                )
                .to_string()
            )
        );
    }

    #[test]
    fn csv_estimated_cost_is_blank_when_the_value_is_not_finite() {
        let ledger = test_ledger("non-finite");
        ledger
            // 畸形来源金额（`scanner::helpers::to_float` 会把 "inf" 解析成 +∞），
            // SQLite 按 REAL 原样保存。
            .log(
                "stored-inf",
                ("opencode", "gpt-5"),
                (100, 20),
                (0, 0),
                Some(f64::INFINITY),
            )
            .log(
                "stored-negative-inf",
                ("hermes", "gpt-5"),
                (100, 20),
                (0, 0),
                Some(f64::NEG_INFINITY),
            )
            // NaN 写进 SQLite 即成 NULL：按账本没存费用处理，照常按价格表估算。
            .log(
                "stored-nan",
                ("hermes", "mystery-model"),
                (100, 20),
                (0, 0),
                Some(f64::NAN),
            )
            // 负数不可得（R-64）：`cost_usd` 仍照账本原样，新列写空、不再照抄。
            .log(
                "stored-negative",
                ("opencode", "gpt-5"),
                (100, 20),
                (0, 0),
                Some(-0.01),
            );
        let prices = load_prices(&ledger.app);
        let costs = ledger.exported_costs();
        // `cost_usd` 照账本原样（U-11 不改）；新列不写 `inf`，写空。
        assert_eq!(costs["stored-inf"], pair("inf", ""));
        assert_eq!(costs["stored-negative-inf"], pair("-inf", ""));
        assert_eq!(
            costs["stored-nan"],
            pair(
                "",
                &estimate_cost(&prices, "hermes", "mystery-model", 100, 20, 0, 0).to_string()
            )
        );
        assert_eq!(costs["stored-negative"], pair("-0.01", ""));

        // 不经 SQLite、直接交给估价器的 NaN 同样写空。
        let mut estimator = CsvCostEstimator::new(&prices);
        let nan_row = StatRow {
            pricing_timestamp: None,
            id: 1,
            tool: "opencode".to_string(),
            model: "gpt-5".to_string(),
            input_tokens: 100,
            output_tokens: 20,
            cached_tokens: 0,
            cache_write_tokens: 0,
            cache_write_known: None,
            usage_provenance: None,
            timestamp: "2026-09-24 10:00:00".to_string(),
            session_id: "session".to_string(),
            cost_usd: Some(f64::NAN),
            machine_id: "machine".to_string(),
        };
        assert_eq!(estimator.estimate(&nan_row), None);

        // 有限的单价也可能乘出溢出：总览合计此时同样是不可得，这一列写空。
        ledger.log(
            "overflow",
            ("codex", "gpt-5"),
            (1_000_000, 1_000_000),
            (0, 0),
            None,
        );
        let huge = json!({ "gpt-5": { "input": 1e308, "output": 1e308 } });
        let conn = db::get_connection(&db::get_db_path(&ledger.app)).expect("open test database");
        let (text, _) = ledger_csv(&conn, &huge).expect("build csv");
        assert_eq!(costs_by_key(&text)["overflow"], pair("", ""));
    }

    #[test]
    fn csv_estimated_cost_follows_the_current_price_overrides() {
        let ledger = test_ledger("override");
        ledger.log(
            "sonnet",
            ("claude", "claude-sonnet-5"),
            (1_000_000, 1_000_000),
            (0, 0),
            None,
        );
        // 内置价：输入 2、输出 10（美元/百万 Token）。
        assert_eq!(ledger.exported_costs()["sonnet"], pair("", "12"));

        // 设置页把输入单价改成 3，走价格编辑器同一保存路径。
        let mut editor = get_prices_impl(&ledger.app).expect("load prices");
        editor["claude-sonnet-5"]["input"] = json!(3.0);
        save_prices_impl(&ledger.app, editor).expect("save price override");
        assert_eq!(ledger.exported_costs()["sonnet"], pair("", "13"));
    }

    #[test]
    fn csv_estimated_cost_prices_cache_reads_and_writes_like_the_dashboard() {
        // 存储口径：cached_tokens 是读写合计，cache_write_tokens 是其中的写入；
        // 读取 = 合计 − 写入，与看板 `StatRow::cache_read_tokens` 同一口径。
        let cases = [
            // 列价：输入 2、缓存读 0.2、缓存写 2.5、输出 10 → 2 + 1 + 0.2 + 1.25。
            (
                "listed",
                ("claude", "claude-sonnet-5"),
                (1_000_000, 100_000),
                (1_500_000, 500_000),
                4.45,
            ),
            // 缺缓存价：读按输入 0.8 × 0.1、写按 0.8 × 1.25 → 2M × 0.08 + 1M × 1.0。
            (
                "fallback",
                ("claude", "claude-3-5-haiku"),
                (0, 0),
                (3_000_000, 1_000_000),
                1.16,
            ),
            // 只有合计、写入为 0（Codex）：全部按读取计 → 1M × 0.5。
            (
                "combined",
                ("codex", "gpt-5.5"),
                (0, 0),
                (1_000_000, 0),
                0.5,
            ),
        ];
        let ledger = test_ledger("cache");
        for (key, source, tokens, cache, _) in cases {
            ledger.log(key, source, tokens, cache, None);
        }
        let prices = load_prices(&ledger.app);
        let costs = ledger.exported_costs();
        for (key, (tool, model), (input, output), (cached, write), expected) in cases {
            let (cost_usd, estimate) = &costs[key];
            assert_eq!(cost_usd, "", "{key}: cost_usd stays blank");
            let value: f64 = estimate.parse().expect("estimated_cost_usd is a number");
            assert!(
                (value - expected).abs() <= 1e-9,
                "{key}: {value} vs {expected}"
            );
            // 与看板逐行估价的参考实现逐位一致。
            assert_eq!(
                *estimate,
                estimate_cost(&prices, tool, model, input, output, cached - write, write)
                    .to_string(),
                "{key}"
            );
        }
    }

    #[test]
    fn csv_estimated_costs_sum_to_the_local_dashboard_total() {
        use super::stats_perf_tests::{
            bench_stats_query, build_synthetic_ledger, fixed_now, BenchScope,
        };
        // T10.167 的合成账本，带异常值：负的来源费用、写入大于合计的缓存拆分、空型号、
        // 自动发现的待核价型号与只能走工具兜底的型号。
        let ledger = build_synthetic_ledger("csv_estimate", 1_200, 0x7196, true);
        // 再加一条用户价格覆盖：两边读的必须是同一张生效价格表。
        let mut editor = get_prices_impl(&ledger.app).expect("load prices");
        editor["claude-opus-4-8"]["input"] = json!(4.5);
        save_prices_impl(&ledger.app, editor).expect("save price override");

        let result = export_db_csv_impl(&ledger.app).expect("export csv");
        let text = fs::read_to_string(result["path"].as_str().expect("export path"))
            .expect("read exported csv");
        let records = csv_records(&text);
        let (cost, estimate) = (
            column(&records[0], "cost_usd"),
            column(&records[0], "estimated_cost_usd"),
        );
        let rows = &records[1..];
        assert_eq!(rows.len(), ledger.rows);
        let stored = rows.iter().filter(|row| !row[cost].is_empty()).count();
        assert!(
            stored > 0 && stored < rows.len(),
            "the ledger mixes stored and unstored costs"
        );
        let mut estimated_sum = 0.0;
        let mut stored_sum = 0.0;
        // R-64（T10.205）：账本存的费用为负或非有限时不可得，不回退到价格表估算——
        // 内置表虽然总有 `default`，这类行的 `estimated_cost_usd` 仍然留空，不是
        // “每行都有价”。这样的行同时会把总览合计传染成不可得（同一 `row_price`）。
        let mut unavailable_rows = 0;
        for row in rows {
            if row[estimate].is_empty() {
                assert!(
                    row[cost].starts_with('-') || row[cost] == "inf" || row[cost] == "-inf",
                    "blank estimate without a corrupt stored cost (R-64): cost_usd={:?}",
                    row[cost]
                );
                unavailable_rows += 1;
                continue;
            }
            estimated_sum += row[estimate]
                .parse::<f64>()
                .expect("estimated_cost_usd is a number");
            if !row[cost].is_empty() {
                stored_sum += row[cost].parse::<f64>().expect("cost_usd is a number");
            }
        }

        let stats = get_local_stats_v2_impl_at(
            &ledger.app,
            bench_stats_query("all", BenchScope::All),
            fixed_now(),
        )
        .expect("local dashboard stats");
        let summary = &stats["summary"];
        assert_eq!(
            summary["totalRequests"].as_u64(),
            Some(rows.len() as u64),
            "the dashboard counts the same rows"
        );
        if unavailable_rows > 0 {
            // 至少一行不可得，总览合计（同一 `row_price`）随之整体不可得（R-64）。
            assert!(
                summary["totalCost"].is_null(),
                "a corrupt stored cost must make the dashboard total unavailable too, got {}",
                summary["totalCost"]
            );
            return;
        }
        let dashboard_total = summary["totalCost"].as_f64().expect("dashboard total cost");
        // 本机统计测试对费用用的同一容差（`cache_savings_tests::assert_close`）。
        assert!(
            (estimated_sum - dashboard_total).abs() <= 1e-9,
            "CSV estimated sum {estimated_sum} vs dashboard total {dashboard_total}"
        );
        // 只加 `cost_usd` 对不上看板，这正是新列要补的缺口（T10.186 评审 P2-1）。
        assert!(
            (stored_sum - dashboard_total).abs() > 1.0,
            "stored {stored_sum} vs dashboard {dashboard_total}"
        );
    }
}

pub fn cleanup_db_impl(app: &AppContext, date: String) -> Result<Value, String> {
    if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err("日期格式必须为 YYYY-MM-DD".to_string());
    }

    let db_path = db::get_db_path(app);
    let mut conn = db::get_connection(&db_path).map_err(|e| e.to_string())?;

    let cutoff = format!("{} 00:00:00", date);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let affected = tx
        .execute(
            "DELETE FROM token_logs WHERE timestamp < ?",
            params![cutoff],
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);

    let mut message = format!("成功清理了 {} 条在 {} 之前的记录", affected, date);
    if affected > 0 {
        cache::invalidate_all(&db_path);
        // 删除只会把页面挂到空闲链表上，文件不会变小；清理本来就是用户确认过的
        // 重操作，顺手回收超过一成的空闲页，用户才能看到“清理”真的释放了磁盘。
        match db::reclaim_space_if_fragmented(&db_path, CLEANUP_RECLAIM_MIN_FREE_RATIO) {
            Ok(Some(reclaimed)) => {
                message.push_str(&format!(
                    "，并回收了 {} 磁盘空间",
                    format_megabytes(reclaimed.freed_bytes())
                ));
            }
            Ok(None) => {}
            Err(error) => {
                log::warn!("post-cleanup vacuum skipped: {error}");
                message.push_str("；空间回收未完成，可稍后在“数据库概览”手动回收");
            }
        }
    }

    Ok(json!({ "message": message }))
}

/// 清理后自动回收的空闲页占比门槛。
const CLEANUP_RECLAIM_MIN_FREE_RATIO: f64 = 0.10;

pub fn format_megabytes(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_048_576.0)
}

/// 用户在设置页显式触发的空间回收；不改数据，因此不动统计缓存。
pub fn reclaim_db_space_impl(app: &AppContext) -> Result<Value, String> {
    let db_path = db::get_db_path(app);
    let reclaimed = db::reclaim_space(&db_path)
        .map_err(|e| format!("空间回收失败：{e}。若正在扫描或同步，请稍后再试"))?;
    Ok(json!({
        "message": format!(
            "已回收 {}，数据库现为 {}",
            format_megabytes(reclaimed.freed_bytes()),
            format_megabytes(reclaimed.after_bytes)
        ),
        "beforeBytes": reclaimed.before_bytes,
        "afterBytes": reclaimed.after_bytes,
        "freedBytes": reclaimed.freed_bytes(),
    }))
}

pub fn reset_local_sync_impl(app: &AppContext) -> Result<Value, String> {
    let db_path = db::get_db_path(app);
    let conn = db::get_connection(&db_path).map_err(|e| e.to_string())?;
    let machine_id = fallback_machine_id(&db_path);

    // Query all distinct tools to queue a cloud purge
    let mut stmt = conn
        .prepare("SELECT DISTINCT tool FROM token_logs")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut tools = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let tool: String = row.get(0).map_err(|e| e.to_string())?;
        tools.push(tool);
    }

    for tool in tools {
        conn.execute(
            "INSERT OR IGNORE INTO pending_cloud_purges (tool, machine_id) VALUES (?1, ?2)",
            params![tool, machine_id],
        )
        .map_err(|e| e.to_string())?;
    }

    let affected = conn
        .execute(
            "UPDATE token_logs SET sync_status = 0, cloud_user_id = NULL, synced_at = NULL",
            [],
        )
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "message": format!("本地同步状态重置成功，并已加入云端清理队列，共标记 {} 条历史日志为未同步", affected)
    }))
}

/// 刷新扫描后的自动上传。托盘面板「后台同步」关着时不上传（设置页的手动同步不受影响）；
/// 暂停状态在扫描结束后、真正上传前才读，扫描途中关掉同步同样生效。
/// 返回是否启动了上传线程。
fn spawn_post_scan_sync(app: &AppContext) -> bool {
    if crate::settings::background_sync_paused_now(app) {
        return false;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        if crate::settings::background_sync_paused_now(&handle) {
            return;
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        if let Err(e) = rt.block_on(background_sync_to_supabase_impl(&handle)) {
            log::debug!("Post-scan cloud sync skipped/failed: {}", e);
        }
    });
    true
}

#[cfg(test)]
mod post_scan_sync_tests {
    use super::*;

    #[test]
    fn sync_paused_during_a_scan_stops_the_post_scan_upload() {
        let dir = std::env::temp_dir().join(format!(
            "tokenledger-post-scan-sync-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let app = AppContext::for_test(dir.clone());
        // 扫描开始时同步还开着（旧实现在这里就定下了要不要上传）……
        assert!(!crate::settings::load_settings(&app).background_sync_paused);
        // ……扫描途中用户在托盘面板关掉同步，扫描结束后不能再启动上传。
        crate::settings::update_background_pause(
            &app,
            crate::settings::BackgroundPause::Sync,
            true,
        )
        .expect("pause sync");
        assert!(!spawn_post_scan_sync(&app));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sync_paused_while_queued_behind_another_upload_starts_no_new_upload() {
        let dir = std::env::temp_dir().join(format!(
            "tokenledger-queued-sync-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        let app = AppContext::for_test(dir.clone());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            // 前一次上传占着 singleflight，自动上传排队（此时同步还开着）。
            let held = acquire_cloud_sync_singleflight().await;
            let queued_app = app.clone();
            let queued =
                tokio::spawn(async move { background_sync_to_supabase_impl(&queued_app).await });
            tokio::task::yield_now().await;
            // 排队期间用户暂停同步，然后前一次上传结束、释放锁。
            crate::settings::update_background_pause(
                &app,
                crate::settings::BackgroundPause::Sync,
                true,
            )
            .expect("pause sync");
            drop(held);
            // 排队的自动上传拿到锁后看到暂停，不新启动上传（也不会去读云端会话）。
            assert_eq!(queued.await.expect("join"), Ok(None));
        });
        let _ = std::fs::remove_dir_all(dir);
    }
}

pub fn refresh_scan_impl(app: &AppContext) -> Result<Value, String> {
    refresh_scan_with(app, true)
}

/// `post_scan_cloud_sync` 为假时只扫描入库，不在后台线程里推云端：命令行进程扫完就退出，
/// 带不走那条线程，也不该为了扫描去读系统安全存储里的云端会话；新记录由桌面端下一轮同步带上。
pub(crate) fn refresh_scan_with(
    app: &AppContext,
    post_scan_cloud_sync: bool,
) -> Result<Value, String> {
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let prices_before = auto_discovered_price_keys(app);

    let scan_options = scanner::ScanOptions::from_settings(&crate::settings::load_settings(app));
    match scanner::run_scan_singleflight(&db_path, &scan_options) {
        Ok(scan) => {
            let outcome = scan.outcome;
            if scan.joined_existing {
                let message = if outcome.codex_rebuild_deferred {
                    format!(
                        "Codex 历史重建已安全延期（{} 个源文件待处理）；旧账本已保留，稍后会自动重试。",
                        outcome.codex_rebuild_failed_files
                    )
                } else {
                    format!(
                        "Scan completed by an existing refresh. New records: {}",
                        outcome.inserted
                    )
                };
                return Ok(json!({
                    "success": true,
                    "message": message,
                    "inserted": outcome.inserted,
                    "codexRebuildDeferred": outcome.codex_rebuild_deferred,
                    "codexRebuildFailedFiles": outcome.codex_rebuild_failed_files,
                    "observedModels": outcome.discovered_models,
                    "discoveredPriceModels": [],
                    "shared": true
                }));
            }
            if outcome.inserted > 0 {
                cache::invalidate_all(&db_path);
            }
            let mut discovered_price_models = auto_discovered_price_keys(app)
                .difference(&prices_before)
                .cloned()
                .collect::<Vec<_>>();
            discovered_price_models.sort();
            if post_scan_cloud_sync {
                spawn_post_scan_sync(app);
            }
            let price_message = if discovered_price_models.is_empty() {
                String::new()
            } else {
                format!(
                    " Discovered price entries: {} (fallback estimates; please verify).",
                    discovered_price_models.len()
                )
            };
            let message = if outcome.codex_rebuild_deferred {
                format!(
                    "Codex 历史重建已安全延期（{} 个源文件待处理）；旧账本已保留，稍后会自动重试。{}",
                    outcome.codex_rebuild_failed_files, price_message
                )
            } else {
                format!(
                    "Scan completed. New records: {}{}",
                    outcome.inserted, price_message
                )
            };
            Ok(json!({
                "success": true,
                "message": message,
                "inserted": outcome.inserted,
                "codexRebuildDeferred": outcome.codex_rebuild_deferred,
                "codexRebuildFailedFiles": outcome.codex_rebuild_failed_files,
                "observedModels": outcome.discovered_models,
                "discoveredPriceModels": discovered_price_models,
                "shared": false
            }))
        }
        Err(e) => Err(e.to_string()),
    }
}

// TODO(T7.3b 跟进)：v1 命令移除后本函数暂无调用方，保留待后续统一清理；allow 防止 clippy -D warnings 门禁误伤。
#[allow(dead_code)]
pub fn get_stats_impl(app: &AppContext, range: String) -> Result<Value, String> {
    get_local_stats_v2_impl(
        app,
        LocalStatsQuery {
            range,
            start: None,
            end: None,
            timezone: "local".to_string(),
            machines: None,
            machine: None,
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: Some("effective".to_string()),
        },
    )
}

fn wallstats_from_dashboard_json(value: &Value) -> Result<wallpaper::WallStats, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "cloud dashboard response is not an object".to_string())?;
    let summary = root
        .get("summary")
        .and_then(Value::as_object)
        .ok_or_else(|| "cloud dashboard response has a malformed summary".to_string())?;
    for field in [
        "totalTokens",
        "inputTokens",
        "outputTokens",
        "cachedTokens",
        "totalCost",
        "totalRequests",
        "avgTokensPerReq",
    ] {
        if !summary
            .get(field)
            .and_then(Value::as_f64)
            .is_some_and(|number| number.is_finite() && number >= 0.0)
        {
            return Err(format!(
                "cloud dashboard response has a malformed summary.{field}"
            ));
        }
    }
    for field in ["tools", "models", "heatmap"] {
        if !root.get(field).is_some_and(Value::is_object) {
            return Err(format!(
                "cloud dashboard response has a malformed {field} field"
            ));
        }
    }
    for field in ["trends", "history"] {
        if !root.get(field).is_some_and(Value::is_array) {
            return Err(format!(
                "cloud dashboard response has a malformed {field} field"
            ));
        }
    }

    let today_total = value
        .pointer("/summary/totalTokens")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            "cloud dashboard response has a non-integer summary.totalTokens".to_string()
        })?;
    let today_requests = value
        .pointer("/summary/totalRequests")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| {
            "cloud dashboard response has a non-integer summary.totalRequests".to_string()
        })?;

    let mut model_ranking: Vec<(String, i64)> = value
        .get("models")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.values()
                .map(|model| {
                    (
                        model
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        model.get("total").and_then(|t| t.as_i64()).unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    model_ranking.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    model_ranking.truncate(5);

    let mut tool_distribution: Vec<(String, i64)> = value
        .get("tools")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.values()
                .map(|tool| {
                    (
                        tool.get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        tool.get("total").and_then(|t| t.as_i64()).unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    tool_distribution.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    // trends elements use the "HH:00" key (trend_key for range="today"); each
    // element stores per-tool token sums. System-reserved `__*` fields such as
    // `__requests` are metadata, so only non-reserved numeric tool keys belong
    // in the matching hour bucket.
    let mut hourly_trend = vec![0i64; 24];
    if let Some(trends) = value.get("trends").and_then(|v| v.as_array()) {
        for trend in trends {
            if let Some(obj) = trend.as_object() {
                let hour = obj
                    .get("date")
                    .and_then(|d| d.as_str())
                    .and_then(|d| d.get(0..2))
                    .and_then(|h| h.parse::<usize>().ok());
                if let Some(hour) = hour {
                    if hour < 24 {
                        let sum: i64 = obj
                            .iter()
                            .filter(|(k, _)| k.as_str() != "date" && !k.starts_with("__"))
                            .filter_map(|(_, v)| v.as_i64())
                            .sum();
                        hourly_trend[hour] += sum;
                    }
                }
            }
        }
    }

    let heatmap: Vec<(String, i64)> = value
        .get("heatmap")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(0)))
                .collect()
        })
        .unwrap_or_default();

    // T10.195 review P1-1: the dashboard "today" range itself carries no
    // yesterday data, but `get_cloud_stats_for_query_impl` merges
    // `get_usage_comparison_v2`'s response into this same JSON's
    // `comparison` field before it reaches here (`merge_cloud_dashboard`) --
    // that is the "较昨日同期" scalars' real, same-time-of-day source. The
    // previous revision ignored it and always wrote 0/0, which
    // `perform_wallpaper_update`'s cloud branch then overwrote with a whole
    // previous CALENDAR DAY from `fetch_cloud_yesterday`, so the pill showed
    // a percentage against the wrong baseline while still labelled "较昨日
    // 同期".
    let (yesterday_total, yesterday_requests) = cloud_day_over_day_previous_scalars(value);

    Ok(wallpaper::WallStats {
        today_total,
        yesterday_total,
        today_requests,
        yesterday_requests,
        hourly_trend,
        // `fetch_cloud_yesterday` (`get_yesterday_stats`) stays the source
        // for this 24-hour reference curve only: that RPC intentionally
        // reports a whole previous calendar day (supabase/schema.sql), a
        // different comparison from the change pill's scalars above.
        yesterday_hourly_trend: vec![0; 24],
        tool_distribution,
        model_ranking,
        heatmap,
        generated_at: Local::now(),
    })
}

/// Cloud "较昨日同期" scalars from the merged dashboard JSON's `comparison`
/// (T10.195 review P1-1). See `docs/contracts/dashboard-stats-v2.md` §3 for
/// the exact shape: `comparison.window.kind`, `comparison.previous.summary.*`.
/// Returns `(STAT_UNKNOWN, STAT_UNKNOWN)` unless all of the following hold:
/// - `comparison` is present and not null;
/// - `comparison.window.kind == "dayOverDay"` (the wallpaper always queries
///   `range = "today"`, so this is the expected kind, but a missing,
///   malformed or future-kind response must not be misread as one);
/// - `comparison.previous.summary.totalTokens`/`totalRequests` are both
///   present, finite integers.
///
/// When those hold but the previous summary reads back as exactly 0/0, this
/// returns `(STAT_BASELINE_MISSING, STAT_BASELINE_MISSING)` instead (T10.210)
/// — a distinct sentinel from `STAT_UNKNOWN`, see below.
///
/// A previous summary of exactly 0 tokens AND 0 requests is treated as an
/// unprovable baseline, not a real zero (REQUIREMENTS REQ-COMP-01: "云端无法
/// 证明上期基线时显示"基线缺失"") — unlike the local SQL path (`wallpaper.rs`'s
/// `fetch_stats_at`), there is no way here to tell "a genuinely quiet
/// previous period" apart from "the RPC could not compute a baseline". This
/// case now returns `STAT_BASELINE_MISSING`, distinct from `STAT_UNKNOWN`
/// (comparison missing/malformed — the read itself did not produce an
/// answer): `ChangeBadge::classify` shows "基线缺失" for the former and
/// `UNKNOWN_TEXT` ("不可得") for the latter (T10.210; before this the two
/// were the same value and both rendered as "不可得").
fn cloud_day_over_day_previous_scalars(value: &Value) -> (i64, i64) {
    let comparison = value.get("comparison").filter(|value| !value.is_null());
    let is_day_over_day = comparison
        .and_then(|comparison| comparison.pointer("/window/kind"))
        .and_then(Value::as_str)
        == Some("dayOverDay");
    if !is_day_over_day {
        return (wallpaper::STAT_UNKNOWN, wallpaper::STAT_UNKNOWN);
    }
    let previous_tokens = comparison
        .and_then(|comparison| comparison.pointer("/previous/summary/totalTokens"))
        .and_then(Value::as_i64);
    let previous_requests = comparison
        .and_then(|comparison| comparison.pointer("/previous/summary/totalRequests"))
        .and_then(Value::as_i64);
    match (previous_tokens, previous_requests) {
        (Some(0), Some(0)) => (
            wallpaper::STAT_BASELINE_MISSING,
            wallpaper::STAT_BASELINE_MISSING,
        ),
        (Some(tokens), Some(requests)) if tokens >= 0 && requests >= 0 => (tokens, requests),
        _ => (wallpaper::STAT_UNKNOWN, wallpaper::STAT_UNKNOWN),
    }
}

/// 云端壁纸模式下，dashboard RPC 不返回昨日数据，这里单独补一次。
///
/// 走 `get_yesterday_stats` RPC 做服务端聚合，返回单行
/// `{ total, requests, hourly: int[24] }`。相比旧的「拉 token_logs 再客户端
/// 聚合」，不受 PostgREST 1000 行上限影响，繁忙日不会被截断。结果按
/// `(scope="cloud_yesterday", range="today", device_filter)` 进 5min 缓存，
/// 高频壁纸更新不再每次都打 Supabase。
fn cloud_cache_identity(origin: &str, user_id: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(origin.as_bytes());
    hasher.update([0]);
    hasher.update(user_id.as_bytes());
    format!("{:x}", hasher.finalize())
}

async fn cloud_cache_partition(app: &AppContext) -> Result<(String, CloudSessionUseLease), String> {
    let (config, lease) = acquire_current_cloud_session(app).await?;
    let session = config
        .session
        .as_ref()
        .ok_or_else(|| "Please sign in to Supabase first.".to_string())?;
    Ok((
        cloud_cache_identity(&config.supabase_url, &session.user_id),
        lease,
    ))
}

async fn fetch_cloud_yesterday(
    app: &AppContext,
    device_filter: &str,
    timezone: &str,
) -> Result<(i64, i64, Vec<i64>), String> {
    let (partition, session_lease) = cloud_cache_partition(app).await?;
    let generation = session_lease.generation;
    let gate_epoch = session_lease.gate_epoch;
    let db_path = db::get_db_path(app);
    let partitioned_device =
        format!("{device_filter}\u{1e}{partition}\u{1e}{generation}\u{1e}{gate_epoch}");
    let key =
        cache::CacheKey::with_timezone("cloud_yesterday", "today", &partitioned_device, timezone);

    let json = if let Some(cached) = cache::read(&db_path, &key) {
        session_lease.ensure_current(app)?;
        cached
    } else {
        let fresh = fetch_cloud_yesterday_uncached(app, device_filter, timezone).await?;
        let _ = session_lease.commit_if_current(app, || {
            cache::write(&db_path, &key, &fresh);
            Ok(())
        });
        fresh
    };
    session_lease.ensure_current(app)?;

    // T10.195 review P1-1: an unreadable total/requests becomes unknown, not
    // a fake 0 -- `perform_wallpaper_update`'s cloud branch no longer reads
    // these two return values for the change-pill scalars (that now comes
    // from `wallstats_from_dashboard_json`'s own `comparison` read), but this
    // function's return type keeps them for its other, non-scalar use (the
    // 24-hour reference curve) and must not silently misreport a failed
    // parse as a real zero either.
    let total = json
        .get("total")
        .and_then(|v| v.as_i64())
        .unwrap_or(wallpaper::STAT_UNKNOWN);
    let requests = json
        .get("requests")
        .and_then(|v| v.as_i64())
        .unwrap_or(wallpaper::STAT_UNKNOWN);
    let mut hourly = vec![0i64; 24];
    if let Some(arr) = json.get("hourly").and_then(|v| v.as_array()) {
        for (i, v) in arr.iter().take(24).enumerate() {
            hourly[i] = v.as_i64().unwrap_or(0);
        }
    }
    Ok((total, requests, hourly))
}

/// Slow path for `fetch_cloud_yesterday`: one POST to the
/// `get_yesterday_stats` RPC. Returns the raw jsonb body so the caller can
/// cache it verbatim.
async fn fetch_cloud_yesterday_uncached(
    app: &AppContext,
    device_filter: &str,
    timezone: &str,
) -> Result<Value, String> {
    let context = CloudRpcContext::for_app(app).await?;

    let url = format!(
        "{}/rest/v1/rpc/get_yesterday_stats",
        context.config.supabase_url
    );
    let payload = json!({
        "p_user": context.session.user_id.clone(),
        "p_machine": device_filter,
        "p_timezone": timezone,
    });

    context.session_lease.ensure_current(app)?;
    let res = context
        .client
        .post(&url)
        .header("apikey", &context.config.supabase_key)
        .header(
            "Authorization",
            format!("Bearer {}", context.session.access_token),
        )
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Cloud yesterday request failed: {}", e))?;
    context.session_lease.ensure_current(app)?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        context.session_lease.ensure_current(app)?;
        if is_missing_rpc_signature(status, &body, "get_yesterday_stats") {
            log::warn!(
                "Supabase get_yesterday_stats timezone signature unavailable; retrying legacy RPC signature."
            );
            let legacy_payload = json!({
                "p_user": context.session.user_id.clone(),
                "p_machine": device_filter,
            });
            context.session_lease.ensure_current(app)?;
            let legacy_res = context
                .client
                .post(&url)
                .header("apikey", &context.config.supabase_key)
                .header(
                    "Authorization",
                    format!("Bearer {}", context.session.access_token),
                )
                .header("Content-Type", "application/json")
                .json(&legacy_payload)
                .send()
                .await
                .map_err(|e| format!("Cloud yesterday request failed: {}", e))?;
            context.session_lease.ensure_current(app)?;

            if !legacy_res.status().is_success() {
                let legacy_status = legacy_res.status();
                let legacy_body = legacy_res.text().await.unwrap_or_default();
                context.session_lease.ensure_current(app)?;
                return Err(supabase_api_error(legacy_status, legacy_body));
            }

            let value = legacy_res.json().await.map_err(|e| e.to_string())?;
            context.session_lease.ensure_current(app)?;
            return Ok(value);
        }
        return Err(supabase_api_error(status, body));
    }

    let value = res.json().await.map_err(|e| e.to_string())?;
    context.session_lease.ensure_current(app)?;
    Ok(value)
}

fn canonical_wallpaper_timezone(timezone: &str) -> Result<String, String> {
    let timezone = timezone
        .parse::<Tz>()
        .map_err(|_| format!("invalid local IANA timezone '{timezone}'"))?;
    Ok(timezone.name().to_string())
}

fn local_wallpaper_timezone() -> Result<String, String> {
    let detected = iana_time_zone::get_timezone()
        .map_err(|error| format!("cannot detect the local IANA timezone: {error}"))?;
    canonical_wallpaper_timezone(&detected)
}

/// Statistics the raster wallpaper is drawn from: `None` means the local
/// SQLite path (`draw_*_wallpaper_image` reads it directly), `Some` is the
/// verified cloud dashboard. Shared by the real update and the settings
/// preview so both draw the same numbers.
pub(crate) fn resolve_wallpaper_stats(
    app: &AppContext,
    settings: &AppSettings,
) -> Result<Option<wallpaper::WallStats>, String> {
    if !settings.wallpaper_use_cloud {
        return Ok(None);
    }
    let device_filter = settings.wallpaper_device_filter.clone();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            format!(
                "Cloud wallpaper update aborted before system changes: runtime unavailable: {error}"
            )
        })?;
    // Raster wallpapers run outside the WebView, so resolve the
    // operating-system IANA timezone here. Using UTC made a Shanghai lock
    // screen stop at the current UTC wall-clock hour while the dashboard
    // correctly continued through local time.
    let timezone = local_wallpaper_timezone()?;
    let json = rt
        .block_on(get_cached_stats_impl(
            app,
            "cloud".to_string(),
            "today".to_string(),
            device_filter.clone(),
            timezone.clone(),
        ))
        .map_err(|error| {
            format!("Cloud wallpaper update aborted before system changes: {error}")
        })?;
    let mut cloud_stats = wallstats_from_dashboard_json(&json).map_err(|error| {
        format!("Cloud wallpaper update aborted before system changes: {error}")
    })?;
    // dashboard RPC 不含 24 小时参照曲线，单独补一次；「较昨日同期」标量已经
    // 由 wallstats_from_dashboard_json 从同一份 JSON 的 comparison 里读出
    // （T10.195 review P1-1），这里不再覆盖，因为这个兼容 RPC 报的是整个
    // 昨天（supabase/schema.sql 的 get_yesterday_stats），不是同一时刻截断。
    // 主统计已经经过强制云端校验，绝不会因此改走本地渲染。
    match rt.block_on(fetch_cloud_yesterday(app, &device_filter, &timezone)) {
        Ok((_, _, y_hourly)) => {
            cloud_stats.yesterday_hourly_trend = y_hourly;
        }
        Err(error) => log::warn!("Failed to fetch cloud yesterday data: {error}"),
    }
    Ok(Some(cloud_stats))
}

pub(crate) fn render_desktop_wallpaper(
    stats: Option<&wallpaper::WallStats>,
    db_path: &Path,
    width: u32,
    height: u32,
) -> Result<image::RgbaImage, String> {
    match stats {
        Some(stats) => wallpaper::draw_desktop_wallpaper_image_with_stats(stats, width, height),
        None => wallpaper::draw_desktop_wallpaper_image(db_path, width, height),
    }
    .ok_or_else(|| "Failed to draw desktop wallpaper.".to_string())
}

pub fn perform_wallpaper_update(
    app: &AppContext,
    target: &str,
) -> Result<(bool, bool, String), String> {
    let settings = settings::load_settings(app);
    if !settings.wallpaper_automation_authorized() {
        return Err("Wallpaper authorization is required before system changes.".to_string());
    }
    if cfg!(target_os = "macos")
        && settings.wallpaper_dynamic_bg_enabled
        && matches!(target, "desktop" | "both")
        && !settings.wallpaper_desktop_enabled
    {
        return Err("请先启用桌面壁纸，再执行更新。".to_string());
    }
    let _update_guard = WALLPAPER_UPDATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "wallpaper update lock poisoned".to_string())?;
    let app_dir = app.app_data_dir();
    let (wallpaper_removed, lockscreen_removed) = enforce_wallpaper_retention(app);
    if wallpaper_removed > 0 || lockscreen_removed > 0 {
        log::info!(
            "wallpaper retention pruned {wallpaper_removed} desktop and {lockscreen_removed} lockscreen history files"
        );
    }

    if target == "lockscreen" && !lockscreen_wallpaper_supported() {
        return Err("Lock-screen wallpaper is only supported on Windows".to_string());
    }

    let wp_dir = app_dir.join("wallpapers");
    let ls_dir = app_dir.join("lockscreens");
    fs::create_dir_all(&wp_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&ls_dir).map_err(|e| e.to_string())?;

    // Stable path reused on every update so the macOS wallpaper agent
    // does not re-parse a brand-new file on each refresh (avoids the
    // ~1s flicker to the previous / system-default wallpaper).
    let wallpaper_path = wp_dir.join("wallpaper_current.png");
    let lockscreen_path = ls_dir.join("lockscreen_current.png");
    #[cfg(target_os = "macos")]
    if settings.wallpaper_dynamic_bg_enabled && matches!(target, "desktop" | "both") {
        // The dynamic desktop is rendered by the transparent Webview and never
        // consumes raster statistics. Return before any SQLite/cloud query.
        return Ok((true, false, wallpaper_path.to_string_lossy().to_string()));
    }

    let db_path = db::get_db_path(app);
    let (width, height) = get_screen_size();
    let stamp = Local::now().format("%Y%m%d_%H%M%S_%f").to_string();
    let mut set_bg_ok = false;
    let mut set_ls_ok = false;

    let stats = resolve_wallpaper_stats(app, &settings)?;

    if target == "desktop" || target == "both" {
        #[cfg(target_os = "macos")]
        {
            if settings.wallpaper_dynamic_bg_enabled {
                // On macOS, desktop wallpaper is program-driven via a transparent Webview window.
                // We bypass PNG rendering and set picture commands, returning success.
                set_bg_ok = true;
            } else {
                // Render static PNG and set via AppleScript
                let img = render_desktop_wallpaper(stats.as_ref(), &db_path, width, height)?;

                img.save(&wallpaper_path).map_err(|e| e.to_string())?;
                if let Ok(f) = std::fs::File::open(&wallpaper_path) {
                    let _ = f.sync_all();
                }
                let history_path = wp_dir.join(format!("wallpaper_{}.png", stamp));
                let _ = std::fs::copy(&wallpaper_path, &history_path);
                set_bg_ok = wallpaper::set_wallpaper(&wallpaper_path);
                if set_bg_ok {
                    cleanup_old_files(&wp_dir, "wallpaper_", WALLPAPER_HISTORY_LIMIT);
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let img = render_desktop_wallpaper(stats.as_ref(), &db_path, width, height)?;

            img.save(&wallpaper_path).map_err(|e| e.to_string())?;
            // fsync so the wallpaper agent can never read a half-written file.
            if let Ok(f) = std::fs::File::open(&wallpaper_path) {
                let _ = f.sync_all();
            }
            // Save a timestamped history copy so users can roll back.
            let history_path = wp_dir.join(format!("wallpaper_{}.png", stamp));
            let _ = std::fs::copy(&wallpaper_path, &history_path);
            set_bg_ok = wallpaper::set_wallpaper(&wallpaper_path);
            if set_bg_ok {
                cleanup_old_files(&wp_dir, "wallpaper_", WALLPAPER_HISTORY_LIMIT);
            }
        }
    }

    if (target == "lockscreen" || target == "both") && lockscreen_wallpaper_supported() {
        let previous_current = match fs::read(&lockscreen_path) {
            Ok(previous) => Some(previous),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let img = if let Some(ref s) = stats {
            wallpaper::draw_lockscreen_wallpaper_image_with_stats(s, width, height)
        } else {
            wallpaper::draw_lockscreen_wallpaper_image(&db_path, width, height)
        }
        .ok_or_else(|| "Failed to draw lock screen wallpaper.".to_string())?;

        img.save(&lockscreen_path).map_err(|e| e.to_string())?;
        if let Ok(f) = std::fs::File::open(&lockscreen_path) {
            let _ = f.sync_all();
        }
        // Windows identifies a file-backed lock-screen image by its StorageFile
        // URI. Keep `current` as our latest artifact, but apply a fresh path on
        // every update so the system cannot reuse the previous URI/cache entry.
        let ls_history = ls_dir.join(format!("lockscreen_{}.png", stamp));
        apply_lockscreen_setter(
            &lockscreen_path,
            &ls_history,
            previous_current.as_deref(),
            wallpaper::set_lockscreen,
        )?;
        set_ls_ok = true;
        cleanup_old_files(&ls_dir, "lockscreen_", WALLPAPER_HISTORY_LIMIT);
    }

    let returned_path = if target == "lockscreen" {
        lockscreen_path.to_string_lossy().to_string()
    } else {
        wallpaper_path.to_string_lossy().to_string()
    };
    Ok((set_bg_ok, set_ls_ok, returned_path))
}

// Legacy wrapper retained so the eframe path (now removed) could format
// its own status JSON. The Tauri command goes through
// `perform_wallpaper_update` directly via `update_wallpaper_cmd`. Not
// dead per se, just no longer wired.
#[allow(dead_code)]
pub fn update_wallpaper_impl(app: &AppContext, target: String) -> Result<Value, String> {
    match perform_wallpaper_update(app, &target) {
        Ok((set_bg_ok, set_ls_ok, path)) => Ok(json!({
            "success": if target == "both" { set_bg_ok || set_ls_ok } else if target == "lockscreen" { set_ls_ok } else { set_bg_ok },
            "message": format!("Wallpaper update finished. desktop={}, lockscreen={}", set_bg_ok, set_ls_ok),
            "path": path
        })),
        Err(e) => Err(e),
    }
}
fn public_cloud_config_value(config: &CloudConfig) -> Value {
    json!({
        "supabase_url": config.supabase_url,
        "supabase_key": config.supabase_key
    })
}

pub fn get_cloud_config_impl(app: &AppContext) -> Result<Value, String> {
    let config = load_public_cloud_config_file(app)?;
    Ok(public_cloud_config_value(&config))
}

pub fn save_cloud_config_impl(app: &AppContext, config: CloudConfig) -> Result<Value, String> {
    let candidate_key = config.supabase_key.trim().to_string();
    if is_forbidden_supabase_service_role_key(&candidate_key) {
        return Err(
            "Service-role keys are forbidden; use a publishable or legacy anon key.".to_string(),
        );
    }
    let existing = load_cloud_config_file(app)?;
    let next = CloudConfig {
        supabase_url: normalize_supabase_url(&config.supabase_url),
        supabase_key: candidate_key,
        session: None,
    };

    let mut clear_secure_session = clear_session_from_keyring;
    persist_cloud_config_change(app, existing, next, &mut clear_secure_session)
}

fn persist_cloud_config_change(
    app: &AppContext,
    existing: CloudConfig,
    mut next: CloudConfig,
    clear_secure_session: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    let identity_changes =
        existing.supabase_url != next.supabase_url || existing.supabase_key != next.supabase_key;
    if identity_changes && existing.session.is_some() {
        return Err("Please sign out before changing the Supabase project or key.".to_string());
    }

    if !identity_changes {
        next.session = existing.session;
    } else {
        // Stop quota work before attempting any fallible identity cleanup.
        // A keyring failure must leave the old project intact and sync off.
        crate::quota_sync::invalidate_session_locally(app);
        cache::invalidate_all(&db::get_db_path(app));
        return cloud_session_coordinator().commit_cloud_identity_change_with_ops(
            app,
            clear_secure_session,
            || {
                save_cloud_config_file(app, &next)?;
                Ok(json!({
                    "success": true,
                    "message": "Supabase configuration saved."
                }))
            },
        );
    }

    save_cloud_config_file(app, &next)?;
    Ok(json!({
        "success": true,
        "message": "Supabase configuration saved."
    }))
}

#[cfg(test)]
mod cloud_config_security_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn test_app() -> (AppContext, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "tokenledger-cloud-key-security-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        (AppContext::for_test(root.clone()), root)
    }

    fn keyring_session_fixture() -> CloudSession {
        CloudSession {
            access_token: "fixture-access".to_string(),
            refresh_token: "fixture-refresh".to_string(),
            user_id: "fixture-user".to_string(),
            email: "fixture@example.invalid".to_string(),
            expires_at: 9_999_999_999,
        }
    }

    #[test]
    fn windows_keyring_current_utf16_session_loads_without_rewrite() {
        let expected = keyring_session_fixture();
        let json = serde_json::to_string(&expected).expect("serialize session fixture");
        let secret = json
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let writes = AtomicUsize::new(0);
        let loaded = decode_and_migrate_keyring_session(&secret, true, &mut |_| {
            writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect("decode current Windows password encoding");

        assert_eq!(loaded.user_id, expected.user_id);
        assert_eq!(loaded.refresh_token, expected.refresh_token);
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn windows_keyring_legacy_utf8_session_is_validated_and_rewritten_once() {
        let expected = keyring_session_fixture();
        let secret = serde_json::to_vec(&expected).expect("serialize legacy session fixture");
        let writes = AtomicUsize::new(0);
        let mut migrated_user = String::new();
        let loaded = decode_and_migrate_keyring_session(&secret, true, &mut |session| {
            writes.fetch_add(1, Ordering::SeqCst);
            migrated_user = session.user_id.clone();
            Ok(())
        })
        .expect("migrate legacy Windows UTF-8 credential");

        assert_eq!(loaded.access_token, expected.access_token);
        assert_eq!(migrated_user, expected.user_id);
        assert_eq!(writes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn non_windows_utf8_session_remains_native_and_is_not_rewritten() {
        let expected = keyring_session_fixture();
        let secret = serde_json::to_vec(&expected).expect("serialize session fixture");
        let writes = AtomicUsize::new(0);
        let loaded = decode_and_migrate_keyring_session(&secret, false, &mut |_| {
            writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect("decode non-Windows native credential");

        assert_eq!(loaded.email, expected.email);
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn keyring_migration_failure_and_invalid_secrets_fail_closed_without_token_leaks() {
        let expected = keyring_session_fixture();
        let secret = serde_json::to_vec(&expected).expect("serialize legacy session fixture");
        let migration_error = decode_and_migrate_keyring_session(&secret, true, &mut |_| {
            Err("injected keyring migration failure".to_string())
        })
        .expect_err("failed migration must not return the legacy session");
        assert_eq!(migration_error, "injected keyring migration failure");

        let invalid_error = decode_and_migrate_keyring_session(
            br#"{"access_token":"must-not-leak","refresh_token":"","user_id":"u","email":"","expires_at":1}"#,
            true,
            &mut |_| panic!("invalid session must not be rewritten"),
        )
        .expect_err("invalid session fields must fail closed");
        assert_eq!(
            invalid_error,
            "stored Supabase session is invalid: credential encoding or JSON shape is unsupported."
        );
        assert!(!invalid_error.contains("must-not-leak"));
    }

    fn service_role_jwt() -> &'static str {
        "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature"
    }

    #[test]
    fn detector_rejects_service_role_but_accepts_publishable_and_legacy_anon() {
        assert!(is_forbidden_supabase_service_role_key("sb_secret_example"));
        assert!(is_forbidden_supabase_service_role_key(service_role_jwt()));
        assert!(!is_forbidden_supabase_service_role_key(
            "sb_publishable_example"
        ));
        assert!(!is_forbidden_supabase_service_role_key(
            "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature"
        ));
    }

    #[test]
    fn save_rejects_service_role_before_any_file_write() {
        let (app, root) = test_app();
        let error = save_cloud_config_impl(
            &app,
            CloudConfig {
                supabase_url: "https://example.supabase.co".to_string(),
                supabase_key: "sb_secret_never-persist".to_string(),
                session: None,
            },
        )
        .expect_err("service role must fail closed");
        assert!(error.contains("Service-role"));
        assert!(!root.join(CLOUD_CONFIG_FILE).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn loaded_secret_is_scrubbed_on_disk_before_public_ipc_projection() {
        let (app, root) = test_app();
        let secret = service_role_jwt();
        fs::write(
            root.join(CLOUD_CONFIG_FILE),
            serde_json::to_vec(&json!({
                "supabase_url": "https://example.supabase.co",
                "supabase_key": secret,
                "session": {
                    "access_token": "access-never-rendered",
                    "refresh_token": "refresh-never-rendered",
                    "user_id": "user",
                    "email": "user@example.invalid",
                    "expires_at": 1,
                }
            }))
            .expect("malicious fixture"),
        )
        .expect("write malicious config");
        let mut cleared = false;
        let scrubbed = load_cloud_config_file_with_forbidden_clear(&app, &mut || {
            cleared = true;
            Ok(())
        })
        .expect("forbidden config must be scrubbed");
        assert!(cleared);
        assert!(scrubbed.supabase_key.is_empty());
        assert!(scrubbed.session.is_none());
        let persisted = fs::read_to_string(root.join(CLOUD_CONFIG_FILE)).expect("scrubbed file");
        assert!(!persisted.contains(secret));
        assert!(!persisted.contains("access-never-rendered"));
        let ipc = public_cloud_config_value(&scrubbed);
        let encoded = serde_json::to_string(&ipc).expect("public config");
        assert!(!encoded.contains(secret));
        assert!(!encoded.contains("access-never-rendered"));
        assert!(!encoded.contains("refresh-never-rendered"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn save_propagates_corrupt_existing_config_instead_of_overwriting_it() {
        let (app, root) = test_app();
        fs::write(root.join(CLOUD_CONFIG_FILE), b"{not-json").expect("corrupt config");
        let error = save_cloud_config_impl(
            &app,
            CloudConfig {
                supabase_url: "https://new.supabase.co".to_string(),
                supabase_key: "sb_publishable_new".to_string(),
                session: None,
            },
        )
        .expect_err("corrupt identity must not become default");
        assert!(!error.is_empty());
        assert_eq!(
            fs::read(root.join(CLOUD_CONFIG_FILE)).unwrap(),
            b"{not-json"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn identity_change_stops_quota_and_propagates_keyring_clear_failure() {
        let (app, root) = test_app();
        let mut settings = settings::load_settings(&app);
        settings.quota_snapshot_sync_enabled = true;
        settings::save_settings_file(&app, &settings).expect("enable fixture sync");
        let error = persist_cloud_config_change(
            &app,
            CloudConfig {
                supabase_url: "https://old.supabase.co".to_string(),
                supabase_key: "sb_publishable_old".to_string(),
                session: None,
            },
            CloudConfig {
                supabase_url: "https://new.supabase.co".to_string(),
                supabase_key: "sb_publishable_new".to_string(),
                session: None,
            },
            &mut || Err("injected keyring clear failure".to_string()),
        )
        .expect_err("identity cleanup failure must propagate");
        assert_eq!(error, "injected keyring clear failure");
        assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(!root.join(CLOUD_CONFIG_FILE).exists());
        assert!(matches!(
            load_cloud_session_gate_state(&app).expect("failed transition stays durable"),
            CloudSessionGateState::Blocked { .. }
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn keyring_read_failure_is_cached_until_explicit_status_retry() {
        let (app, root) = test_app();
        let coordinator = CloudSessionCoordinator::default();
        let reads = AtomicUsize::new(0);
        let mut load = || {
            let attempt = reads.fetch_add(1, Ordering::SeqCst);
            Err(if attempt == 0 {
                "injected keyring read failure"
            } else {
                "injected explicit retry failure"
            }
            .to_string())
        };
        let error = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut load,
            &mut |_| panic!("save must not run"),
            &mut || panic!("clear must not run"),
        )
        .expect_err("secure storage failure must fail closed");
        assert_eq!(error, "injected keyring read failure");
        assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);

        let repeated = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut load,
            &mut |_| panic!("save must not run after cached failure"),
            &mut || panic!("clear must not run after cached failure"),
        )
        .expect_err("same account epoch must reuse the safe failure");
        assert_eq!(repeated, "injected keyring read failure");
        assert_eq!(reads.load(Ordering::SeqCst), 1);

        let retried = load_cloud_config_file_with_keyring_ops_mode(
            &app,
            &coordinator,
            &mut load,
            &mut |_| panic!("save must not run after explicit retry"),
            &mut || panic!("clear must not run after explicit retry"),
            false,
            true,
        )
        .expect_err("explicit status retry should perform one new secure read");
        assert_eq!(retried, "injected explicit retry failure");
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn superseded_config_load_preserves_new_auth_and_quota_state() {
        for config_kind in ["missing", "public", "legacy-session"] {
            let (app, root) = test_app();
            let coordinator = CloudSessionCoordinator::default();
            let public_config = CloudConfig {
                supabase_url: "https://fixture.supabase.co".to_string(),
                supabase_key: "fixture-public-key".to_string(),
                session: None,
            };
            if config_kind == "legacy-session" {
                fs::write(
                    root.join(CLOUD_CONFIG_FILE),
                    serde_json::to_vec(&json!({
                        "supabase_url": public_config.supabase_url,
                        "supabase_key": public_config.supabase_key,
                        "session": keyring_session_fixture(),
                    }))
                    .expect("legacy config bytes"),
                )
                .expect("legacy config fixture");
            } else if config_kind == "public" {
                save_cloud_config_file(&app, &public_config).expect("public config fixture");
            }
            settings::update_quota_snapshot_sync_enabled(&app, true).expect("enable sync fixture");
            let settings_before = fs::read(root.join("app_settings.json")).expect("settings bytes");
            let stop_path = root.join("quota_local_stop_v1.json");
            let stop_before = fs::read(&stop_path).ok();
            let config_before = fs::read(root.join(CLOUD_CONFIG_FILE)).ok();

            // Status/config request S captured G but has not acquired commit.
            // Explicit auth B wins that lock and captures G+1 before S resumes.
            let old_generation = coordinator.current();
            let auth = coordinator.begin_auth_change(&app).expect("new auth B");
            let error = load_cloud_config_file_with_keyring_ops_at_generation(
                &app,
                &coordinator,
                &mut || panic!("superseded loader must not read keyring"),
                &mut |_| panic!("superseded loader must not migrate keyring"),
                &mut || panic!("superseded loader must not clear keyring"),
                false,
                false,
                old_generation,
            )
            .expect_err("old loader is superseded");
            assert_eq!(error, SESSION_OPERATION_SUPERSEDED);
            assert_eq!(coordinator.current(), auth.generation);
            assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
            assert_eq!(
                fs::read(root.join("app_settings.json")).unwrap(),
                settings_before
            );
            assert_eq!(fs::read(&stop_path).ok(), stop_before);
            assert_eq!(fs::read(root.join(CLOUD_CONFIG_FILE)).ok(), config_before);

            let secure_session = Mutex::new(None);
            let session = keyring_session_fixture();
            coordinator
                .commit_new_session_with_keyring_ops(
                    &app,
                    auth,
                    || Ok(()),
                    || {
                        *secure_session.lock().expect("fake keyring") = Some(session.clone());
                        Ok(())
                    },
                )
                .expect("old loader cannot cancel B keyring commit");
            assert_eq!(
                secure_session
                    .lock()
                    .expect("fake keyring")
                    .as_ref()
                    .map(|session| session.user_id.as_str()),
                Some(session.user_id.as_str())
            );
            assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
            assert_eq!(fs::read(&stop_path).ok(), stop_before);
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn current_config_load_secure_storage_failure_still_fails_closed() {
        for config_kind in ["missing", "public", "legacy-session"] {
            let (app, root) = test_app();
            let coordinator = CloudSessionCoordinator::default();
            if config_kind != "missing" {
                fs::write(
                    root.join(CLOUD_CONFIG_FILE),
                    serde_json::to_vec(&json!({
                        "supabase_url": "https://fixture.supabase.co",
                        "supabase_key": "fixture-public-key",
                        "session": if config_kind == "legacy-session" {
                            serde_json::to_value(keyring_session_fixture()).unwrap()
                        } else {
                            Value::Null
                        },
                    }))
                    .expect("config bytes"),
                )
                .expect("config fixture");
            }
            settings::update_quota_snapshot_sync_enabled(&app, true).expect("enable sync fixture");
            let generation_before = coordinator.current();
            let error = load_cloud_config_file_with_keyring_ops(
                &app,
                &coordinator,
                &mut || Err("injected current keyring denial".to_string()),
                &mut |_| panic!("failed read must not migrate keyring"),
                &mut || panic!("failed read must not clear keyring"),
            )
            .expect_err("current secure-storage failure");
            assert_eq!(error, "injected current keyring denial");
            assert!(coordinator.current() > generation_before);
            assert!(
                !settings::load_settings_result(&app)
                    .expect("persisted settings remain readable after stop")
                    .quota_snapshot_sync_enabled
            );
            assert!(!root.join("quota_sync_binding_v2.json").exists());
            assert!(!root.join("quota_remote_cache_v2.json").exists());
            let stopped: Value = serde_json::from_slice(
                &fs::read(root.join("quota_local_stop_v1.json")).expect("durable quota stop"),
            )
            .expect("quota stop bytes");
            // The stop sentinel is cleared only after disabled settings and
            // absence of the binding have been verified durably.
            assert_eq!(stopped["schemaVersion"], 1);
            assert_eq!(stopped["active"], false);
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn delayed_real_load_error_cannot_fail_closed_a_new_auth_generation() {
        let (app, root) = test_app();
        let coordinator = CloudSessionCoordinator::default();
        settings::update_quota_snapshot_sync_enabled(&app, true).expect("enable sync fixture");
        let old_generation = coordinator.current();
        let auth = coordinator.begin_auth_change(&app).expect("new auth B");
        fail_closed_cloud_session_after_load_error(
            &app,
            &coordinator,
            old_generation,
            "injected earlier keyring denial",
        );
        assert_eq!(coordinator.current(), auth.generation);
        assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(!root.join("quota_local_stop_v1.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn durable_keyring_failure_blocks_a_new_coordinator_until_explicit_retry() {
        let (app, root) = test_app();
        let first_coordinator = CloudSessionCoordinator::default();
        let first_error = load_cloud_config_file_with_keyring_ops(
            &app,
            &first_coordinator,
            &mut || Err("injected first process keyring failure".to_string()),
            &mut |_| panic!("save must not run"),
            &mut || panic!("clear must not run"),
        )
        .expect_err("first keyring read must fail closed");
        assert_eq!(first_error, "injected first process keyring failure");
        assert!(root.join(CLOUD_SESSION_KEYRING_FAILURE_FILE).exists());

        let second_coordinator = CloudSessionCoordinator::default();
        let repeated = load_cloud_config_file_with_keyring_ops(
            &app,
            &second_coordinator,
            &mut || panic!("a new coordinator must honor the durable failure"),
            &mut |_| panic!("save must not run after durable failure"),
            &mut || panic!("clear must not run after durable failure"),
        )
        .expect_err("a new coordinator must not prompt again");
        assert_eq!(repeated, CACHED_KEYRING_READ_FAILURE);

        let recovered = load_cloud_config_file_with_keyring_ops_mode(
            &app,
            &second_coordinator,
            &mut || Ok(None),
            &mut |_| panic!("save must not run during recovery"),
            &mut || panic!("clear must not run during recovery"),
            false,
            true,
        )
        .expect("explicit retry should clear the durable failure");
        assert!(recovered.session.is_none());
        assert!(!root.join(CLOUD_SESSION_KEYRING_FAILURE_FILE).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ready_epoch_session_cache_avoids_repeated_keyring_reads() {
        let (app, root) = test_app();
        let coordinator = CloudSessionCoordinator::default();
        let reads = AtomicUsize::new(0);
        let expected = CloudSession {
            access_token: "access".to_string(),
            refresh_token: "refresh".to_string(),
            user_id: "user".to_string(),
            email: "user@example.invalid".to_string(),
            expires_at: 9_999_999_999,
        };
        let mut load = || {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok(Some(expected.clone()))
        };
        let mut save = |_: &CloudSession| panic!("cache test must not save keyring");
        let mut clear = || panic!("cache test must not clear keyring");

        let first = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut load,
            &mut save,
            &mut clear,
        )
        .expect("first secure load");
        let second = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut load,
            &mut save,
            &mut clear,
        )
        .expect("same epoch cache hit");
        assert_eq!(
            first
                .session
                .as_ref()
                .map(|session| session.user_id.as_str()),
            Some(expected.user_id.as_str())
        );
        assert_eq!(
            second
                .session
                .as_ref()
                .map(|session| session.access_token.as_str()),
            Some(expected.access_token.as_str())
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);

        save_cloud_session_gate_state(&app, CloudSessionGateState::Ready { epoch: 1 })
            .expect("advance durable account epoch");
        let third = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut load,
            &mut save,
            &mut clear,
        )
        .expect("new epoch secure reload");
        assert_eq!(
            third
                .session
                .as_ref()
                .map(|session| session.refresh_token.as_str()),
            Some(expected.refresh_token.as_str())
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn blocked_session_gate_hides_keyring_state_from_normal_loads() {
        let (app, root) = test_app();
        save_cloud_session_gate(&app, true).expect("block session gate");
        let coordinator = CloudSessionCoordinator::default();
        let config = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut || panic!("blocked normal load must not read keyring"),
            &mut |_| panic!("blocked normal load must not save keyring"),
            &mut || Ok(()),
        )
        .expect("blocked config projection");
        assert!(config.session.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn explicit_sign_out_clears_keyring_even_when_config_is_corrupt() {
        let (app, root) = test_app();
        fs::write(root.join(CLOUD_CONFIG_FILE), b"{not-json").expect("corrupt config");
        save_cloud_session_gate(&app, true).expect("block session gate");
        let coordinator = CloudSessionCoordinator::default();
        let attempt = coordinator
            .begin_sign_out(&app)
            .expect("claim explicit sign-out");
        let mut cleared = false;
        coordinator
            .complete_sign_out_with_clear(&app, attempt, || {
                cleared = true;
                Ok(())
            })
            .expect("local sign-out cleanup");
        coordinator
            .finish_sign_out_attempt(attempt, true)
            .expect("finish explicit sign-out");
        assert!(cleared);
        assert!(!load_cloud_session_gate(&app).expect("ready gate"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn general_settings_save_preserves_the_locked_quota_sync_value() {
        let (app, root) = test_app();
        let latest = settings::AppSettings {
            quota_snapshot_sync_enabled: true,
            ..Default::default()
        };
        settings::update_quota_snapshot_sync_enabled(&app, true)
            .expect("persist authoritative quota sync fixture");
        let state = Arc::new(Mutex::new(latest));
        let incoming = settings::AppSettings::default();
        let (_, saved) =
            persist_general_settings_change(&app, &state, incoming).expect("save general settings");
        assert!(saved.quota_snapshot_sync_enabled);
        assert!(settings::load_settings(&app).quota_snapshot_sync_enabled);
        assert!(
            state
                .lock()
                .expect("settings state")
                .quota_snapshot_sync_enabled
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cloud_cache_identity_isolated_by_origin_and_user() {
        let first = cloud_cache_identity("https://project.supabase.co", "user-a");
        let second = cloud_cache_identity("https://project.supabase.co", "user-b");
        let third = cloud_cache_identity("https://other.supabase.co", "user-a");
        assert_ne!(first, second);
        assert_ne!(first, third);
        assert!(!first.contains("user-a"));
        assert!(!first.contains("supabase"));
    }

    #[test]
    fn keyring_read_failure_scrubs_a_legacy_plaintext_session_first() {
        let (app, root) = test_app();
        fs::write(
            root.join(CLOUD_CONFIG_FILE),
            serde_json::to_vec(&json!({
                "supabase_url": "https://example.supabase.co",
                "supabase_key": "sb_publishable_example",
                "session": {
                    "access_token": "legacy-access",
                    "refresh_token": "legacy-refresh",
                    "user_id": "legacy-user",
                    "email": "legacy@example.invalid",
                    "expires_at": 42,
                }
            }))
            .expect("legacy fixture"),
        )
        .expect("write legacy fixture");
        let coordinator = CloudSessionCoordinator::default();
        let error = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut || Err("injected keyring read failure".to_string()),
            &mut |_| panic!("save must not run"),
            &mut || Ok(()),
        )
        .expect_err("secure storage failure must fail closed");
        assert_eq!(error, "injected keyring read failure");
        let persisted: Value = serde_json::from_slice(
            &fs::read(root.join(CLOUD_CONFIG_FILE)).expect("scrubbed config"),
        )
        .expect("valid scrubbed config");
        assert!(persisted.get("session").is_none());
        assert!(!persisted.to_string().contains("legacy-access"));
        assert!(!persisted.to_string().contains("legacy-refresh"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_plaintext_session_is_not_returned_when_keyring_migration_fails() {
        let (app, root) = test_app();
        fs::write(
            root.join(CLOUD_CONFIG_FILE),
            serde_json::to_vec(&json!({
                "supabase_url": "https://example.supabase.co",
                "supabase_key": "sb_publishable_example",
                "session": {
                    "access_token": "legacy-access",
                    "refresh_token": "legacy-refresh",
                    "user_id": "legacy-user",
                    "email": "legacy@example.invalid",
                    "expires_at": 42,
                }
            }))
            .expect("legacy fixture"),
        )
        .expect("write legacy fixture");
        let coordinator = CloudSessionCoordinator::default();
        let mut save_attempted = false;
        let error = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut || Ok(None),
            &mut |_| {
                save_attempted = true;
                Err("injected keyring write failure".to_string())
            },
            &mut || Ok(()),
        )
        .expect_err("plaintext session must never be used as fallback auth");
        assert!(save_attempted);
        assert_eq!(error, "injected keyring write failure");
        let persisted: Value = serde_json::from_slice(
            &fs::read(root.join(CLOUD_CONFIG_FILE)).expect("scrubbed config"),
        )
        .expect("valid scrubbed config");
        assert!(persisted.get("session").is_none());
        assert!(!persisted.to_string().contains("legacy-access"));
        assert!(!persisted.to_string().contains("legacy-refresh"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn public_cloud_config_projection_ignores_legacy_session_without_keyring_access() {
        let (app, root) = test_app();
        fs::write(
            root.join(CLOUD_CONFIG_FILE),
            serde_json::to_vec(&json!({
                "supabase_url": "https://example.supabase.co/",
                "supabase_key": "sb_publishable_fixture",
                "session": {
                    "access_token": "legacy-access-never-read",
                    "refresh_token": "legacy-refresh-never-read",
                    "user_id": "fixture-user",
                    "email": "fixture@example.invalid",
                    "expires_at": 42,
                }
            }))
            .expect("public config fixture"),
        )
        .expect("write public config fixture");

        let public = get_cloud_config_impl(&app).expect("public config must not need keyring");
        assert_eq!(public["supabase_url"], "https://example.supabase.co");
        assert_eq!(public["supabase_key"], "sb_publishable_fixture");
        assert!(!public.to_string().contains("legacy-access-never-read"));
        assert!(!public.to_string().contains("fixture@example.invalid"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn public_cloud_config_projection_fail_closes_service_role_key_without_keyring_access() {
        let (app, root) = test_app();
        fs::write(
            root.join(CLOUD_CONFIG_FILE),
            serde_json::to_vec(&json!({
                "supabase_url": "https://example.supabase.co",
                "supabase_key": service_role_jwt()
            }))
            .expect("service-role public config fixture"),
        )
        .expect("write service-role public config fixture");

        let public = get_cloud_config_impl(&app).expect("service-role projection must fail closed");
        assert_eq!(public["supabase_url"], "https://example.supabase.co");
        assert_eq!(public["supabase_key"], "");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retired_project_migration_propagates_cleanup_failure_and_stops_quota() {
        let (app, root) = test_app();
        fs::write(
            root.join(CLOUD_CONFIG_FILE),
            serde_json::to_vec(&json!({
                "supabase_url": "https://legacyretiredprojectref.supabase.co",
                "supabase_key": "sb_publishable_legacy"
            }))
            .expect("retired project fixture"),
        )
        .expect("write retired project fixture");
        let mut settings = settings::load_settings(&app);
        settings.quota_snapshot_sync_enabled = true;
        settings::save_settings_file(&app, &settings).expect("enable fixture sync");
        let coordinator = CloudSessionCoordinator::default();
        let error = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut || Ok(None),
            &mut |_| Ok(()),
            &mut || Err("injected retired-project clear failure".to_string()),
        )
        .expect_err("retired project cleanup must not report success");
        assert_eq!(error, "injected retired-project clear failure");
        assert!(!settings::load_settings(&app).quota_snapshot_sync_enabled);
        let persisted = fs::read_to_string(root.join(CLOUD_CONFIG_FILE)).expect("old config");
        assert!(persisted.contains("legacyretiredprojectref"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalidation_prevents_a_late_refresh_commit() {
        let coordinator = CloudSessionCoordinator::default();
        let refresh_generation = coordinator.current();
        coordinator
            .invalidate(|| Ok(()))
            .expect("sign-out invalidation");
        let mut committed = false;
        let error = coordinator
            .replace_if_current(refresh_generation, || {
                committed = true;
                Ok(())
            })
            .expect_err("late refresh must be superseded");
        assert_eq!(error, SESSION_OPERATION_SUPERSEDED);
        assert!(!committed);
    }

    #[test]
    fn sign_out_entry_invalidation_prevents_a_late_refresh_commit() {
        let coordinator = CloudSessionCoordinator::default();
        let refresh_generation = coordinator.current();
        coordinator.invalidate_claims();
        let mut committed = false;
        let error = coordinator
            .replace_if_current(refresh_generation, || {
                committed = true;
                Ok(())
            })
            .expect_err("sign-out entry must supersede a late refresh");
        assert_eq!(error, SESSION_OPERATION_SUPERSEDED);
        assert!(!committed);
    }

    #[test]
    fn remote_logout_finishes_before_the_cross_process_gate_reopens() {
        let source = include_str!("mod.rs");
        let orchestration = source
            .split_once("prepare_for_sign_out_with_config(")
            .expect("sign-out quota cleanup call")
            .1;
        let remote_logout = orchestration
            .find("best_effort_remote_logout(captured_config.as_ref()).await")
            .expect("bounded remote logout call");
        let ready_transition = orchestration
            .find("session_coordinator.complete_sign_out(&app, sign_out_attempt)")
            .expect("local clear and ready transition");
        assert!(
            remote_logout < ready_transition,
            "the captured-session logout must finish while the durable gate is still blocked"
        );
    }

    #[test]
    fn remote_logout_is_scoped_to_the_captured_session() {
        let url = supabase_local_logout_url("https://example.supabase.co/")
            .expect("valid local logout URL");
        assert_eq!(url.path(), "/auth/v1/logout");
        assert_eq!(url.query(), Some("scope=local"));
    }

    #[test]
    fn sign_out_gate_failure_propagates_without_starting_cleanup() {
        let coordinator = CloudSessionCoordinator::default();
        let cleanup_calls = AtomicUsize::new(0);
        let error = coordinator
            .begin_sign_out_with_gate(|_| Err("injected durable gate failure".to_string()))
            .expect_err("missing crash tombstone must reject sign-out entry");
        assert_eq!(error, "injected durable gate failure");
        assert!(!coordinator.sign_out_in_progress.load(Ordering::SeqCst));
        assert_eq!(coordinator.sign_out_attempt.load(Ordering::SeqCst), 0);
        assert!(coordinator.session_blocked.load(Ordering::SeqCst));
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 0);

        let retry = coordinator
            .begin_sign_out_with_gate(|_| {
                cleanup_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .expect("a deliberate retry can claim the released flight");
        assert_eq!(cleanup_calls.load(Ordering::SeqCst), 1);
        coordinator
            .finish_sign_out_attempt(retry, false)
            .expect("finish retry fixture");
    }

    #[test]
    fn concurrent_sign_out_entries_are_process_single_flight() {
        let coordinator = CloudSessionCoordinator::default();
        let start = std::sync::Barrier::new(2);
        let gate_writes = AtomicUsize::new(0);
        let attempts = Mutex::new(Vec::new());
        let failures = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    start.wait();
                    match coordinator.begin_sign_out_with_gate(|_| {
                        gate_writes.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }) {
                        Ok(attempt) => attempts.lock().expect("attempts").push(attempt),
                        Err(error) => {
                            assert_eq!(error, SIGN_OUT_ALREADY_IN_PROGRESS);
                            failures.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                });
            }
        });
        let attempts = attempts.into_inner().expect("attempts");
        assert_eq!(attempts.len(), 1);
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        assert_eq!(gate_writes.load(Ordering::SeqCst), 1);
        coordinator
            .finish_sign_out_attempt(attempts[0], false)
            .expect("finish winning flight");
    }

    #[test]
    fn stale_sign_out_attempt_cannot_clear_a_new_session_commit() {
        let (app, root) = test_app();
        let coordinator = CloudSessionCoordinator::default();
        let attempt = coordinator.begin_sign_out(&app).expect("begin sign-out");
        coordinator
            .complete_sign_out_with_clear(&app, attempt, || Ok(()))
            .expect("clear old session");
        coordinator
            .finish_sign_out_attempt(attempt, true)
            .expect("finish old sign-out");

        let auth_claim = coordinator.begin_auth_change(&app).expect("new auth claim");
        let mut new_session_present = false;
        coordinator
            .replace_if_current(auth_claim.generation, || {
                new_session_present = true;
                Ok(())
            })
            .expect("commit new session fixture");

        let mut stale_clear_called = false;
        let error = coordinator
            .complete_sign_out_with_clear(&app, attempt, || {
                stale_clear_called = true;
                Ok(())
            })
            .expect_err("old attempt must not clear a newer session");
        assert_eq!(error, SESSION_OPERATION_SUPERSEDED);
        assert!(new_session_present);
        assert!(!stale_clear_called);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn new_auth_attempt_fences_older_keyring_commits_with_or_without_same_config_save() {
        for save_same_config in [false, true] {
            for older_returns_first in [false, true] {
                let (app, root) = test_app();
                let coordinator = CloudSessionCoordinator::default();
                let config = CloudConfig {
                    supabase_url: "https://fixture.supabase.co".to_string(),
                    supabase_key: "fixture-public-key".to_string(),
                    session: None,
                };
                save_cloud_config_file(&app, &config).expect("public config fixture");
                let secure_session = Mutex::new(None::<CloudSession>);
                let reads = AtomicUsize::new(0);
                let mut load_secure = || {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Ok(secure_session.lock().expect("secure session").clone())
                };
                coordinator
                    .load_session_for_ready_epoch(&app, &mut load_secure, false)
                    .expect("initial cached empty session");
                let old = coordinator.begin_auth_change(&app).expect("auth A");
                if save_same_config {
                    persist_cloud_config_change(&app, config.clone(), config, &mut || {
                        panic!("same config must not clear secure storage")
                    })
                    .expect("save unchanged config during auth A");
                }
                let current = coordinator.begin_auth_change(&app).expect("auth B");
                assert!(current.generation > old.generation);
                assert_eq!(current.gate_epoch, old.gate_epoch);
                coordinator
                    .load_session_for_ready_epoch(&app, &mut load_secure, false)
                    .expect("auth entry retains cached session");
                assert_eq!(reads.load(Ordering::SeqCst), 1);

                let stale_mutations = AtomicUsize::new(0);
                let reject_old = || {
                    assert_eq!(
                        coordinator
                            .commit_new_session_with_keyring_ops(
                                &app,
                                old,
                                || {
                                    stale_mutations.fetch_add(1, Ordering::SeqCst);
                                    Ok(())
                                },
                                || {
                                    stale_mutations.fetch_add(1, Ordering::SeqCst);
                                    Ok(())
                                },
                            )
                            .expect_err("auth A cannot mutate keyring after auth B starts"),
                        SESSION_OPERATION_SUPERSEDED
                    );
                };
                if older_returns_first {
                    reject_old();
                }
                let expected = keyring_session_fixture();
                coordinator
                    .commit_new_session_with_keyring_ops(
                        &app,
                        current,
                        || {
                            *secure_session.lock().expect("secure session") = None;
                            Ok(())
                        },
                        || {
                            *secure_session.lock().expect("secure session") =
                                Some(expected.clone());
                            Ok(())
                        },
                    )
                    .expect("auth B commits its session");
                if !older_returns_first {
                    reject_old();
                }
                assert_eq!(stale_mutations.load(Ordering::SeqCst), 0);
                let loaded = coordinator
                    .load_session_for_ready_epoch(&app, &mut load_secure, false)
                    .expect("read committed B instead of cached empty session")
                    .expect("B session");
                assert_eq!(loaded.user_id, expected.user_id);
                assert_eq!(reads.load(Ordering::SeqCst), 2);
                let _ = fs::remove_dir_all(root);
            }
        }
    }

    #[test]
    fn concurrent_auth_entries_have_one_current_generation() {
        let (app, root) = test_app();
        let coordinator = CloudSessionCoordinator::default();
        let start = std::sync::Barrier::new(2);
        let claims = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    start.wait();
                    let claim = coordinator.begin_auth_change(&app).expect("auth entry");
                    claims.lock().expect("claims").push(claim);
                });
            }
        });
        let claims = claims.into_inner().expect("claims");
        assert_ne!(claims[0].generation, claims[1].generation);
        assert_eq!(
            claims
                .iter()
                .filter(|claim| coordinator.ensure_auth_claim_current(&app, **claim).is_ok())
                .count(),
            1
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn same_config_save_preserves_inflight_auth_and_cached_session() {
        let (app, root) = test_app();
        let coordinator = CloudSessionCoordinator::default();
        let session = keyring_session_fixture();
        let config = CloudConfig {
            supabase_url: "https://fixture.supabase.co".to_string(),
            supabase_key: "fixture-public-key".to_string(),
            session: Some(session.clone()),
        };
        save_cloud_config_file(&app, &config).expect("public config fixture");
        let reads = AtomicUsize::new(0);
        let mut load_secure = || {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok(Some(session.clone()))
        };
        coordinator
            .load_session_for_ready_epoch(&app, &mut load_secure, false)
            .expect("cache existing session");
        let auth = coordinator.begin_auth_change(&app).expect("auth entry");
        persist_cloud_config_change(&app, config.clone(), config, &mut || {
            panic!("same config must not clear secure storage")
        })
        .expect("save unchanged config");
        coordinator
            .ensure_auth_claim_current(&app, auth)
            .expect("same config does not cancel auth");
        let loaded = coordinator
            .load_session_for_ready_epoch(&app, &mut load_secure, false)
            .expect("cached session migrates to auth generation")
            .expect("existing session retained");
        assert_eq!(loaded.access_token, session.access_token);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn new_auth_attempt_preserves_keyring_failure_suppression_and_fences_signup_confirmation() {
        let (app, root) = test_app();
        let coordinator = CloudSessionCoordinator::default();
        let reads = AtomicUsize::new(0);
        let mut load_secure = || {
            reads.fetch_add(1, Ordering::SeqCst);
            Err("injected keyring denial".to_string())
        };
        assert!(coordinator
            .load_session_for_ready_epoch(&app, &mut load_secure, false)
            .is_err());
        let old = coordinator.begin_auth_change(&app).expect("auth A");
        let current = coordinator.begin_auth_change(&app).expect("auth B");
        assert_eq!(current.gate_epoch, old.gate_epoch);
        assert!(coordinator
            .load_session_for_ready_epoch(&app, &mut load_secure, false)
            .is_err());
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(
            finish_sign_up_response(
                &app,
                &coordinator,
                old,
                &json!({ "user": { "id": "fixture-user" } }),
                |_| panic!("obsolete confirmation must not persist a session"),
            )
            .expect_err("auth B also supersedes auth A email confirmation"),
            SESSION_OPERATION_SUPERSEDED
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn another_process_durable_gate_supersedes_an_old_session_lease() {
        let (app_a, root) = test_app();
        let app_b = AppContext::for_test(root.clone());
        save_cloud_session_gate(&app_a, false).expect("ready shared gate");
        let process_a = Box::leak(Box::new(CloudSessionCoordinator::default()));
        let lease = process_a
            .begin_session_use(&app_a)
            .expect("old process lease");
        let process_b = CloudSessionCoordinator::default();
        let attempt = process_b
            .begin_sign_out(&app_b)
            .expect("other process sign-out");

        // Process A's atomics and generation are unchanged; only the shared
        // durable tombstone can invalidate this old request.
        assert!(process_a.ensure_current(lease.generation).is_ok());
        assert_eq!(
            lease
                .ensure_current(&app_a)
                .expect_err("durable gate must win"),
            SESSION_OPERATION_SUPERSEDED
        );
        process_b
            .finish_sign_out_attempt(attempt, false)
            .expect("finish other-process fixture");
        drop(lease);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cross_process_sign_out_blocks_auth_entry_and_late_auth_commit() {
        let (app_a, root) = test_app();
        let app_b = AppContext::for_test(root.clone());
        save_cloud_session_gate(&app_a, false).expect("ready shared gate");
        let process_a = CloudSessionCoordinator::default();
        let process_b = CloudSessionCoordinator::default();

        // Simulate an auth request that started while the gate was ready. Its
        // network request is deliberately outside the cross-process lock.
        let old_auth_claim = process_b
            .begin_auth_change(&app_b)
            .expect("auth starts before sign-out");
        let sign_out = process_a
            .begin_sign_out(&app_a)
            .expect("process A owns sign-out");
        assert_eq!(
            process_b
                .begin_auth_change(&app_b)
                .expect_err("active sign-out blocks new auth"),
            SESSION_OPERATION_SUPERSEDED
        );

        let keyring_mutations = AtomicUsize::new(0);
        assert_eq!(
            process_b
                .commit_new_session_with_keyring_ops(
                    &app_b,
                    old_auth_claim,
                    || {
                        keyring_mutations.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    || {
                        keyring_mutations.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .expect_err("late auth commit cannot reopen an active sign-out"),
            SESSION_OPERATION_SUPERSEDED
        );
        assert_eq!(keyring_mutations.load(Ordering::SeqCst), 0);

        process_a
            .complete_sign_out_with_clear(&app_a, sign_out, || Ok(()))
            .expect("owner completes sign-out");
        process_a
            .finish_sign_out_attempt(sign_out, true)
            .expect("finish sign-out fixture");
        assert!(!load_cloud_session_gate(&app_a).expect("ready gate"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_identity_change_fences_an_older_cross_process_auth_claim() {
        let (app_a, root) = test_app();
        let app_b = AppContext::for_test(root.clone());
        save_cloud_session_gate(&app_a, false).expect("ready shared gate");
        let old_config = CloudConfig {
            supabase_url: "https://old.supabase.co".to_string(),
            supabase_key: "sb_publishable_old".to_string(),
            session: None,
        };
        let new_config = CloudConfig {
            supabase_url: "https://new.supabase.co".to_string(),
            supabase_key: "sb_publishable_new".to_string(),
            session: None,
        };
        save_cloud_config_file(&app_a, &old_config).expect("persist old identity");
        let process_a = CloudSessionCoordinator::default();
        let process_b = CloudSessionCoordinator::default();
        let old_auth_claim = process_a
            .begin_auth_change(&app_a)
            .expect("process A auth starts on old project");
        let secure_session = Arc::new(Mutex::new(Some("old")));
        let for_clear = secure_session.clone();

        process_b
            .commit_cloud_identity_change_with_ops(
                &app_b,
                move || {
                    *for_clear.lock().expect("secure session") = None;
                    Ok(())
                },
                || save_cloud_config_file(&app_b, &new_config),
            )
            .expect("process B changes project identity");

        let ready = load_cloud_session_gate_state(&app_a).expect("ready changed identity");
        assert!(matches!(ready, CloudSessionGateState::Ready { .. }));
        assert!(ready.epoch() > old_auth_claim.gate_epoch);
        let persisted: CloudConfig = serde_json::from_slice(
            &fs::read(root.join(CLOUD_CONFIG_FILE)).expect("new identity file"),
        )
        .expect("valid new identity");
        assert_eq!(persisted.supabase_url, new_config.supabase_url);
        assert_eq!(persisted.supabase_key, new_config.supabase_key);
        assert_eq!(*secure_session.lock().expect("secure session"), None);

        let stale_mutations = AtomicUsize::new(0);
        assert_eq!(
            process_a
                .commit_new_session_with_keyring_ops(
                    &app_a,
                    old_auth_claim,
                    || {
                        stale_mutations.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    || {
                        stale_mutations.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .expect_err("old-project auth cannot overwrite the new identity"),
            SESSION_OPERATION_SUPERSEDED
        );
        assert_eq!(stale_mutations.load(Ordering::SeqCst), 0);
        assert_eq!(*secure_session.lock().expect("secure session"), None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn signup_confirmation_response_is_fenced_after_sign_out_or_config_change() {
        for change_config in [false, true] {
            let (app, root) = test_app();
            let coordinator = CloudSessionCoordinator::default();
            let claim = coordinator.begin_auth_change(&app).expect("signup claim");
            let confirmation = json!({ "user": { "id": "fixture-user" } });
            let current = finish_sign_up_response(&app, &coordinator, claim, &confirmation, |_| {
                panic!("confirmation must not persist a session")
            })
            .expect("current email confirmation");
            assert_eq!(current["success"], true);
            if change_config {
                // Another process changes the durable epoch without changing
                // the first process's atomic generation.
                let other_process = CloudSessionCoordinator::default();
                other_process
                    .commit_cloud_identity_change_with_ops(&app, || Ok(()), || Ok(()))
                    .expect("new project identity");
            } else {
                let attempt = coordinator.begin_sign_out(&app).expect("start sign-out");
                coordinator
                    .complete_sign_out_with_clear(&app, attempt, || Ok(()))
                    .expect("finish local sign-out");
                coordinator
                    .finish_sign_out_attempt(attempt, true)
                    .expect("release sign-out");
            }
            let error = finish_sign_up_response(&app, &coordinator, claim, &confirmation, |_| {
                panic!("obsolete response must not persist a session")
            })
            .expect_err("late confirmation is obsolete");
            assert_eq!(error, SESSION_OPERATION_SUPERSEDED);
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn failed_project_identity_persist_keeps_gate_blocked_and_old_config_intact() {
        let (app_a, root) = test_app();
        let app_b = AppContext::for_test(root.clone());
        save_cloud_session_gate(&app_a, false).expect("ready shared gate");
        let old_config = CloudConfig {
            supabase_url: "https://old.supabase.co".to_string(),
            supabase_key: "sb_publishable_old".to_string(),
            session: None,
        };
        save_cloud_config_file(&app_a, &old_config).expect("persist old identity");
        let old_bytes = fs::read(root.join(CLOUD_CONFIG_FILE)).expect("old identity bytes");
        let process_b = CloudSessionCoordinator::default();
        let secure_session = Arc::new(Mutex::new(Some("old")));
        let for_clear = secure_session.clone();
        let persist_calls = AtomicUsize::new(0);

        let error = process_b
            .commit_cloud_identity_change_with_ops(
                &app_b,
                move || {
                    *for_clear.lock().expect("secure session") = None;
                    Ok(())
                },
                || {
                    persist_calls.fetch_add(1, Ordering::SeqCst);
                    Err::<(), _>("injected config persist failure".to_string())
                },
            )
            .expect_err("identity persist failure must propagate");

        assert_eq!(error, "injected config persist failure");
        assert_eq!(persist_calls.load(Ordering::SeqCst), 1);
        assert_eq!(*secure_session.lock().expect("secure session"), None);
        assert_eq!(
            fs::read(root.join(CLOUD_CONFIG_FILE)).expect("old identity retained"),
            old_bytes
        );
        let gate = load_cloud_session_gate_state(&app_a).expect("durable failure gate");
        assert!(matches!(
            gate,
            CloudSessionGateState::Blocked {
                owner_nonce: Some(_),
                ..
            }
        ));
        assert!(gate.has_active_lease(cloud_session_gate_now()));
        assert!(process_b.session_blocked.load(Ordering::SeqCst));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn completed_cross_process_sign_out_fences_old_auth_refresh_and_cloud_commits() {
        let (app_a, root) = test_app();
        let app_b = AppContext::for_test(root.clone());
        save_cloud_session_gate(&app_a, false).expect("ready shared gate");

        let auth_process = Box::leak(Box::new(CloudSessionCoordinator::default()));
        let refresh_process = Box::leak(Box::new(CloudSessionCoordinator::default()));
        let cloud_process = Box::leak(Box::new(CloudSessionCoordinator::default()));
        let sign_out_process = CloudSessionCoordinator::default();
        let old_auth_claim = auth_process
            .begin_auth_change(&app_a)
            .expect("old auth starts at ready epoch");
        let old_refresh_lease = refresh_process
            .begin_session_use(&app_a)
            .expect("old refresh lease");
        let old_cloud_lease = cloud_process
            .begin_session_use(&app_a)
            .expect("old cloud lease");
        let old_epoch = old_cloud_lease.gate_epoch;
        let secure_session = Arc::new(Mutex::new(Some("old")));

        let sign_out = sign_out_process
            .begin_sign_out(&app_b)
            .expect("process B begins sign-out");
        let for_sign_out = secure_session.clone();
        sign_out_process
            .complete_sign_out_with_clear(&app_b, sign_out, move || {
                *for_sign_out.lock().expect("secure session") = None;
                Ok(())
            })
            .expect("process B clears old session");
        sign_out_process
            .finish_sign_out_attempt(sign_out, true)
            .expect("process B finishes sign-out");
        let ready_epoch = load_cloud_session_gate_state(&app_b)
            .expect("ready gate after sign-out")
            .epoch();
        assert!(ready_epoch > old_epoch);
        assert_eq!(*secure_session.lock().expect("secure session"), None);

        let auth_mutations = AtomicUsize::new(0);
        assert_eq!(
            auth_process
                .commit_new_session_with_keyring_ops(
                    &app_a,
                    old_auth_claim,
                    || {
                        auth_mutations.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    || {
                        auth_mutations.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .expect_err("old auth cannot commit after completed sign-out"),
            SESSION_OPERATION_SUPERSEDED
        );
        assert_eq!(auth_mutations.load(Ordering::SeqCst), 0);

        let refresh_mutations = AtomicUsize::new(0);
        assert_eq!(
            refresh_process
                .commit_new_session_with_keyring_ops(
                    &app_a,
                    AuthChangeClaim {
                        generation: old_refresh_lease.generation,
                        gate_epoch: old_refresh_lease.gate_epoch,
                    },
                    || {
                        refresh_mutations.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                    || {
                        refresh_mutations.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .expect_err("old refresh cannot resurrect the cleared session"),
            SESSION_OPERATION_SUPERSEDED
        );
        assert_eq!(refresh_mutations.load(Ordering::SeqCst), 0);

        let cloud_committed = AtomicBool::new(false);
        assert_eq!(
            old_cloud_lease
                .commit_if_current(&app_a, || {
                    cloud_committed.store(true, Ordering::SeqCst);
                    Ok(())
                })
                .expect_err("old cloud lease cannot commit after gate returns ready"),
            SESSION_OPERATION_SUPERSEDED
        );
        assert!(!cloud_committed.load(Ordering::SeqCst));
        assert_eq!(*secure_session.lock().expect("secure session"), None);

        let recovery_claim = auth_process
            .begin_auth_change(&app_a)
            .expect("new explicit auth captures the new ready epoch");
        let for_recovery_clear = secure_session.clone();
        let for_recovery_save = secure_session.clone();
        auth_process
            .commit_new_session_with_keyring_ops(
                &app_a,
                recovery_claim,
                move || {
                    *for_recovery_clear.lock().expect("secure session") = None;
                    Ok(())
                },
                move || {
                    *for_recovery_save.lock().expect("secure session") = Some("new");
                    Ok(())
                },
            )
            .expect("new explicit auth may recover after sign-out");
        assert_eq!(*secure_session.lock().expect("secure session"), Some("new"));

        drop(old_refresh_lease);
        drop(old_cloud_lease);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_blocked_gate_allows_only_explicit_epoch_advancing_recovery() {
        let (app, root) = test_app();
        save_cloud_session_gate(&app, true).expect("legacy blocked marker");
        let coordinator: &'static CloudSessionCoordinator =
            Box::leak(Box::new(CloudSessionCoordinator::default()));
        assert!(coordinator.begin_session_use(&app).is_err());

        let claim = coordinator
            .begin_auth_change(&app)
            .expect("explicit auth may take over ownerless legacy marker");
        assert_eq!(claim.gate_epoch, 0);
        coordinator
            .commit_new_session_with_keyring_ops(&app, claim, || Ok(()), || Ok(()))
            .expect("legacy recovery commit");
        assert!(matches!(
            load_cloud_session_gate_state(&app).expect("recovered ready gate"),
            CloudSessionGateState::Ready { epoch } if epoch >= 2
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cross_process_double_sign_out_has_one_unexpired_owner() {
        let (app_a, root) = test_app();
        let app_b = AppContext::for_test(root.clone());
        save_cloud_session_gate(&app_a, false).expect("ready shared gate");
        let process_a = CloudSessionCoordinator::default();
        let process_b = CloudSessionCoordinator::default();

        let start = std::sync::Barrier::new(2);
        let winners = Mutex::new(Vec::new());
        let failures = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for (index, coordinator, app) in [(0, &process_a, &app_a), (1, &process_b, &app_b)] {
                let start = &start;
                let winners = &winners;
                let failures = &failures;
                scope.spawn(move || {
                    start.wait();
                    match coordinator.begin_sign_out(app) {
                        Ok(attempt) => winners
                            .lock()
                            .expect("cross-process winners")
                            .push((index, attempt)),
                        Err(error) => {
                            assert_eq!(error, SIGN_OUT_ALREADY_IN_PROGRESS);
                            failures.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                });
            }
        });
        let winners = winners.into_inner().expect("cross-process winners");
        assert_eq!(winners.len(), 1);
        assert_eq!(failures.load(Ordering::SeqCst), 1);
        let (winner_index, winner) = winners[0];
        let (winning_process, winning_app) = if winner_index == 0 {
            (&process_a, &app_a)
        } else {
            (&process_b, &app_b)
        };
        let clears = AtomicUsize::new(0);
        winning_process
            .complete_sign_out_with_clear(winning_app, winner, || {
                clears.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .expect("winning owner clears keyring");
        winning_process
            .finish_sign_out_attempt(winner, true)
            .expect("finish winning sign-out");
        assert_eq!(clears.load(Ordering::SeqCst), 1);
        assert!(!load_cloud_session_gate(&app_b).expect("ready gate"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn expired_sign_out_allows_auth_takeover_and_old_owner_cannot_clear_new_session() {
        let (app_a, root) = test_app();
        let app_b = AppContext::for_test(root.clone());
        save_cloud_session_gate(&app_a, false).expect("ready shared gate");
        let process_a = CloudSessionCoordinator::default();
        let process_b = CloudSessionCoordinator::default();
        let old_attempt = process_a
            .begin_sign_out(&app_a)
            .expect("old process begins sign-out");

        with_cloud_session_gate_lock(&app_b, || {
            let gate = load_cloud_session_gate_state(&app_b)?;
            assert!(gate.is_owned_by(old_attempt.owner_nonce));
            let now = cloud_session_gate_now();
            save_cloud_session_gate_state(
                &app_b,
                CloudSessionGateState::Blocked {
                    epoch: gate.epoch(),
                    owner_nonce: Some(old_attempt.owner_nonce),
                    blocked_at: Some(now - CLOUD_SESSION_GATE_LEASE_MILLIS),
                    lease_expires_at: Some(now - 1),
                },
            )
        })
        .expect("expire abandoned owner lease");

        let auth_claim = process_b
            .begin_auth_change(&app_b)
            .expect("expired owner permits explicit auth recovery");
        let secure_session = Arc::new(Mutex::new(Some("old")));
        let for_clear = secure_session.clone();
        let for_save = secure_session.clone();
        process_b
            .commit_new_session_with_keyring_ops(
                &app_b,
                auth_claim,
                move || {
                    *for_clear.lock().expect("secure session") = None;
                    Ok(())
                },
                move || {
                    *for_save.lock().expect("secure session") = Some("new");
                    Ok(())
                },
            )
            .expect("explicit auth takes over expired gate");

        let stale_clear_called = AtomicBool::new(false);
        assert_eq!(
            process_a
                .complete_sign_out_with_clear(&app_a, old_attempt, || {
                    stale_clear_called.store(true, Ordering::SeqCst);
                    *secure_session.lock().expect("secure session") = None;
                    Ok(())
                })
                .expect_err("old owner cannot clear the new auth session"),
            SESSION_OPERATION_SUPERSEDED
        );
        assert!(!stale_clear_called.load(Ordering::SeqCst));
        assert_eq!(*secure_session.lock().expect("secure session"), Some("new"));
        process_a
            .finish_sign_out_attempt(old_attempt, false)
            .expect("retire superseded local attempt");
        assert!(!load_cloud_session_gate(&app_a).expect("auth takeover opens gate"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn expired_blocked_gate_self_heals_to_ready_without_explicit_auth() {
        let (app, root) = test_app();
        let now = cloud_session_gate_now();
        // A crash/interrupted sign-out two minutes ago left a durable Blocked
        // record whose lease has since expired (lease window stays within the
        // 60s validator bound).
        save_cloud_session_gate_state(
            &app,
            CloudSessionGateState::Blocked {
                epoch: 5,
                owner_nonce: Some(1),
                blocked_at: Some(now - 120_000),
                lease_expires_at: Some(now - 60_000),
            },
        )
        .expect("persist expired blocked gate");

        let coordinator = CloudSessionCoordinator::default();
        assert!(
            !coordinator.is_session_blocked(&app),
            "expired blocked lease must self-heal instead of forcing re-login"
        );
        match load_cloud_session_gate_state(&app).expect("healed gate persists") {
            CloudSessionGateState::Ready { epoch } => {
                assert_eq!(epoch, 5, "self-heal must not advance the epoch")
            }
            other => panic!("expected Ready gate after self-heal, got {other:?}"),
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn expired_blocked_gate_restores_default_config_and_keyring_session() {
        let (app, root) = test_app();
        let now = cloud_session_gate_now();
        save_cloud_session_gate_state(
            &app,
            CloudSessionGateState::Blocked {
                epoch: 9,
                owner_nonce: Some(7),
                blocked_at: Some(now - 120_000),
                lease_expires_at: Some(now - 60_000),
            },
        )
        .expect("persist expired blocked gate");

        let expected_config = default_cloud_config();
        let expected_session = CloudSession {
            access_token: "access".to_string(),
            refresh_token: "refresh".to_string(),
            user_id: "user".to_string(),
            email: "user@example.invalid".to_string(),
            expires_at: 9_999_999_999,
        };
        let reads = AtomicUsize::new(0);
        let coordinator = CloudSessionCoordinator::default();
        let config = load_cloud_config_file_with_keyring_ops(
            &app,
            &coordinator,
            &mut || {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(Some(expected_session.clone()))
            },
            &mut |_| panic!("restoring an existing session must not rewrite keyring"),
            &mut || panic!("restoring an existing session must not clear keyring"),
        )
        .expect("expired gate restores the configured session");

        assert_eq!(config.supabase_url, expected_config.supabase_url);
        assert_eq!(config.supabase_key, expected_config.supabase_key);
        // 开源发行版不内置任何默认云端项目：默认配置为空，用户须显式配置自己的
        // Supabase 项目。若发行方需要自带默认值，改 cloud.defaults.json 即可。
        assert!(
            config.supabase_url.is_empty() && config.supabase_key.is_empty(),
            "the shipped defaults must not point at any cloud project"
        );
        assert!(!is_forbidden_supabase_service_role_key(
            &config.supabase_key
        ));
        assert_eq!(
            config
                .session
                .as_ref()
                .map(|session| (session.user_id.as_str(), session.email.as_str())),
            Some((
                expected_session.user_id.as_str(),
                expected_session.email.as_str()
            ))
        );
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(
            load_cloud_session_gate_state(&app).expect("healed gate persists"),
            CloudSessionGateState::Ready { epoch: 9 }
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn active_blocked_gate_stays_blocked_and_is_not_rewritten() {
        let (app, root) = test_app();
        let now = cloud_session_gate_now();
        save_cloud_session_gate_state(
            &app,
            CloudSessionGateState::Blocked {
                epoch: 7,
                owner_nonce: Some(1),
                blocked_at: Some(now),
                lease_expires_at: Some(now + CLOUD_SESSION_GATE_LEASE_MILLIS),
            },
        )
        .expect("persist actively leased blocked gate");

        let coordinator = CloudSessionCoordinator::default();
        assert!(
            coordinator.is_session_blocked(&app),
            "an in-progress sign-out lease must still fail closed"
        );
        assert!(
            load_cloud_session_gate_state(&app)
                .expect("gate unchanged")
                .is_blocked(),
            "an active lease must not be overwritten by the check"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_ownerless_blocked_marker_stays_fail_closed() {
        let (app, root) = test_app();
        save_cloud_session_gate(&app, true).expect("legacy blocked marker");
        let coordinator = CloudSessionCoordinator::default();
        assert!(
            coordinator.is_session_blocked(&app),
            "ownerless legacy marker must keep normal loads blocked"
        );
        assert!(
            load_cloud_session_gate(&app).expect("marker unchanged"),
            "legacy marker must not be rewritten by the check"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cloud_send_error_kind_retryability_matches_classification_policy() {
        assert!(CloudSendErrorKind::Connect.is_retryable());
        assert!(CloudSendErrorKind::Timeout.is_retryable());
        assert!(CloudSendErrorKind::Network.is_retryable());
        assert!(!CloudSendErrorKind::Other.is_retryable());
    }

    #[test]
    fn cloud_http_retry_backoff_grows_bounded_and_never_overflows() {
        assert_eq!(
            cloud_http_retry_backoff(0),
            std::time::Duration::from_millis(CLOUD_HTTP_RETRY_BASE_MILLIS),
            "first retry waits exactly the base delay"
        );
        let mut previous = cloud_http_retry_backoff(0);
        for attempt in 1..=8 {
            let next = cloud_http_retry_backoff(attempt);
            assert!(
                next > previous,
                "backoff must grow monotonically (attempt {attempt})"
            );
            previous = next;
        }
        let huge = cloud_http_retry_backoff(usize::MAX);
        assert!(
            huge.as_millis() > 0,
            "saturating arithmetic must keep extreme attempts usable"
        );
    }

    #[test]
    fn refresh_rotation_is_single_flight_and_followers_share_success() {
        let coordinator = CloudSessionCoordinator::default();
        let generation = coordinator.current();
        let participants = 8;
        let claimed = std::sync::Barrier::new(participants);
        let leaders = AtomicUsize::new(0);
        let observations = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..participants {
                scope.spawn(|| {
                    let mut claim = coordinator
                        .claim_refresh(generation)
                        .expect("shared refresh claim");
                    claimed.wait();
                    if claim.is_leader() {
                        leaders.fetch_add(1, Ordering::SeqCst);
                        claim
                            .publish(Ok(CloudConfig {
                                supabase_url: "https://example.supabase.co".to_string(),
                                supabase_key: "sb_publishable_example".to_string(),
                                session: Some(CloudSession {
                                    access_token: "rotated-access".to_string(),
                                    refresh_token: "rotated-refresh".to_string(),
                                    user_id: "user-a".to_string(),
                                    email: "a@example.invalid".to_string(),
                                    expires_at: 9_999_999_999,
                                }),
                            }))
                            .expect("publish shared rotation");
                    }
                    loop {
                        if let Some(result) = coordinator
                            .refresh_result(generation, claim.flight_id)
                            .expect("flight remains while participants hold claims")
                        {
                            let config = result.expect("shared refresh success");
                            assert_eq!(
                                config.session.expect("rotated session").access_token,
                                "rotated-access"
                            );
                            observations.fetch_add(1, Ordering::SeqCst);
                            break;
                        }
                        std::thread::yield_now();
                    }
                });
            }
        });
        assert_eq!(leaders.load(Ordering::SeqCst), 1);
        assert_eq!(observations.load(Ordering::SeqCst), participants);
        assert!(coordinator
            .refresh_state
            .lock()
            .expect("refresh state")
            .flights
            .is_empty());
    }

    #[test]
    fn sign_out_reports_only_local_cleanup_failure_without_cloud_deletion_claims() {
        let response = merge_supabase_sign_out_result(
            Some("remote warning".to_string()),
            true,
            Err("injected local cleanup failure".to_string()),
        );
        assert_eq!(response["signedOut"], false);
        assert_eq!(response["localSignOutError"], true);
        assert_eq!(response["quotaCleanupPending"], true);
        assert!(response["message"]
            .as_str()
            .expect("safe message")
            .contains("额度同步停止状态未能安全保存"));
        assert!(!response["message"]
            .as_str()
            .expect("safe message")
            .contains("远端"));
        assert!(!response
            .to_string()
            .contains("injected local cleanup failure"));
    }
}

pub async fn get_cloud_status_impl(app: &AppContext) -> Result<Value, String> {
    let config = load_cloud_config_file_for_status_check(app)?;
    let session = config.session.as_ref();
    Ok(json!({
        "configured": !config.supabase_url.is_empty() && !config.supabase_key.is_empty(),
        "authenticated": session.is_some(),
        "email": session.map(|s| s.email.clone()).unwrap_or_default(),
        "userId": session.map(|s| s.user_id.clone()).unwrap_or_default()
    }))
}

fn persist_new_cloud_session(
    app: &AppContext,
    claim: AuthChangeClaim,
    session: &CloudSession,
) -> Result<(), String> {
    cloud_session_coordinator().commit_new_session_with_keyring_ops(
        app,
        claim,
        clear_session_from_keyring,
        || save_session_to_keyring(session),
    )?;
    cache::invalidate_all(&db::get_db_path(app));
    Ok(())
}

pub async fn supabase_sign_in_impl(
    app: &AppContext,
    credentials: AuthRequest,
) -> Result<Value, String> {
    let auth_claim = cloud_session_coordinator().begin_auth_change(app)?;
    let config = load_cloud_config_file(app)?;
    cloud_session_coordinator().ensure_auth_claim_current(app, auth_claim)?;
    if config.session.is_some() {
        return Err("Please sign out before signing in to another account.".to_string());
    }
    if config.supabase_url.is_empty() || config.supabase_key.is_empty() {
        return Err("Please configure Supabase URL and publishable key first.".to_string());
    }

    let url = format!("{}/auth/v1/token?grant_type=password", config.supabase_url);
    let response = auth_http::request_auth(
        &url,
        &config.supabase_key,
        &json!({ "email": credentials.email, "password": credentials.password }),
        auth_http::AuthOperation::SignIn,
        // Poll only the atomic generation while awaiting HTTP. The durable gate
        // is checked below and by the commit, without synchronous disk polling.
        || cloud_session_coordinator().ensure_current(auth_claim.generation),
    )
    .await;
    cloud_session_coordinator().ensure_auth_claim_current(app, auth_claim)?;
    let body = response?;
    let session = parse_auth_session(&body)
        .ok_or_else(|| "Invalid Supabase sign in response.".to_string())?;
    let email = session.email.clone();
    let user_id = session.user_id.clone();
    persist_new_cloud_session(app, auth_claim, &session)?;

    Ok(json!({
        "success": true,
        "message": "Signed in to Supabase.",
        "email": email,
        "userId": user_id
    }))
}

pub async fn supabase_sign_up_impl(
    app: &AppContext,
    credentials: AuthRequest,
) -> Result<Value, String> {
    let auth_claim = cloud_session_coordinator().begin_auth_change(app)?;
    let config = load_cloud_config_file(app)?;
    cloud_session_coordinator().ensure_auth_claim_current(app, auth_claim)?;
    if config.session.is_some() {
        return Err("Please sign out before creating or switching accounts.".to_string());
    }
    if config.supabase_url.is_empty() || config.supabase_key.is_empty() {
        return Err("Please configure Supabase URL and publishable key first.".to_string());
    }

    let url = format!("{}/auth/v1/signup", config.supabase_url);
    let response = auth_http::request_auth(
        &url,
        &config.supabase_key,
        &json!({ "email": credentials.email, "password": credentials.password }),
        auth_http::AuthOperation::SignUp,
        || cloud_session_coordinator().ensure_current(auth_claim.generation),
    )
    .await;
    cloud_session_coordinator().ensure_auth_claim_current(app, auth_claim)?;
    let body = response?;
    finish_sign_up_response(
        app,
        cloud_session_coordinator(),
        auth_claim,
        &body,
        |session| persist_new_cloud_session(app, auth_claim, session),
    )
}

fn finish_sign_up_response<F>(
    app: &AppContext,
    coordinator: &CloudSessionCoordinator,
    claim: AuthChangeClaim,
    body: &Value,
    persist: F,
) -> Result<Value, String>
where
    F: FnOnce(&CloudSession) -> Result<(), String>,
{
    // Email-confirmation responses carry no session to commit, so they need an
    // explicit fence too. An obsolete signup must not report current success.
    coordinator.ensure_auth_claim_current(app, claim)?;
    if let Some(session) = parse_auth_session(body) {
        let email = session.email.clone();
        let user_id = session.user_id.clone();
        persist(&session)?;
        Ok(json!({
            "success": true,
            "message": "Supabase account created and signed in.",
            "email": email,
            "userId": user_id
        }))
    } else {
        Ok(json!({
            "success": true,
            "message": "Supabase account created. Check your email if confirmation is required."
        }))
    }
}

fn backfill_null_costs(db_path: &std::path::Path, prices: &Value) -> Result<(), String> {
    let mut conn = db::get_connection(db_path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // Check count of rows where cost_usd is NULL
    let count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM token_logs WHERE cost_usd IS NULL",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    if count > 0 {
        log::info!("Found {count} historical rows with NULL cost_usd. Backfilling...");

        let mut stmt = tx
            .prepare("SELECT id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, timestamp FROM token_logs WHERE cost_usd IS NULL")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut updates = Vec::new();
        for (id, tool, model, input, output, cached, cache_write, timestamp) in rows.flatten() {
            let cache_read = (cached - cache_write).max(0);
            // Frozen at the price in effect when the record was made, so a
            // later price change never reaches it (MODEL_PRICING.md).
            let cost = estimate_cost_at(
                prices,
                &tool,
                &model,
                &timestamp,
                input,
                output,
                cache_read,
                cache_write,
            );
            updates.push((id, cost));
        }

        if !updates.is_empty() {
            let mut update_stmt = tx
                .prepare("UPDATE token_logs SET cost_usd = ?, sync_status = 0 WHERE id = ?")
                .map_err(|e| e.to_string())?;
            for (id, cost) in updates {
                update_stmt
                    .execute(params![cost, id])
                    .map_err(|e| e.to_string())?;
            }
            log::info!("Successfully backfilled costs and queued only the affected rows for sync.");
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

const PENDING_SYNC_WORK_SQL: &str = "SELECT EXISTS(
         SELECT 1 FROM token_logs
         WHERE (sync_status = 0 OR cloud_user_id IS NULL OR cloud_user_id != ?1)
           AND NOT (
               tool = 'codex'
               AND (machine_id = ?2 OR machine_id = '')
               AND EXISTS(
                   SELECT 1 FROM pending_cloud_purges p
                   WHERE p.tool = 'codex'
                     AND p.machine_id = ?2
                     AND p.ready = 0
               )
           )
         LIMIT 1
     ) OR EXISTS(
         SELECT 1 FROM pending_cloud_purges WHERE ready = 1 LIMIT 1
     ) OR EXISTS(
         SELECT 1 FROM scan_cloud_dirty_buckets WHERE user_id = ?1 LIMIT 1
     )";

// Unknown writes poison the complete hourly bucket, including zero-read rows.
fn scan_cache_write_projection(rows: impl IntoIterator<Item = (i64, Option<bool>)>) -> Option<i64> {
    let mut total = 0;
    let mut known = true;
    for (write, provenance) in rows {
        total += write;
        known &= provenance != Some(false);
    }
    known.then_some(total)
}

const RAW_SYNC_LOGS_SQL: &str =
    "SELECT id, tool, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, timestamp, cost_usd, machine_id, sync_status, cloud_user_id, sync_revision, cache_write_known
     FROM token_logs
     WHERE (substr(timestamp, 1, 13) || ':00:00', tool, model, coalesce(nullif(machine_id, ''), ?2)) IN (
         SELECT DISTINCT substr(timestamp, 1, 13) || ':00:00', tool, model, coalesce(nullif(machine_id, ''), ?2)
         FROM token_logs
         WHERE (sync_status = 0 OR cloud_user_id IS NULL OR cloud_user_id != ?1)
           AND NOT (
               tool = 'codex'
               AND (machine_id = ?2 OR machine_id = '')
               AND EXISTS(
                   SELECT 1 FROM pending_cloud_purges p
                   WHERE p.tool = 'codex'
                     AND p.machine_id = ?2
                     AND p.ready = 0
               )
           )
         UNION
         SELECT hour_bucket, tool, model, coalesce(nullif(machine_id, ''), ?2)
         FROM scan_cloud_dirty_buckets WHERE user_id = ?1
           AND NOT (tool = 'codex' AND coalesce(nullif(machine_id, ''), ?2) = ?2
             AND EXISTS(SELECT 1 FROM pending_cloud_purges p
               WHERE p.tool = 'codex' AND p.machine_id = ?2 AND p.ready = 0))
     )";

const GATEWAY_DELETE_BATCH_SIZE: usize = 50;

fn codex_rebuild_pending(db_path: &std::path::Path, machine_id: &str) -> Result<bool, String> {
    let conn = db::get_connection(db_path).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pending_cloud_purges
                        WHERE tool = 'codex' AND machine_id = ?1 AND ready = 0)",
        params![machine_id],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|e| e.to_string())
}

/// Written only after every upsert, delete and local mark succeeded; a lost
/// state file just re-sends the gateway hours once.
fn save_gateway_cloud_state(db_path: &std::path::Path, plan: &gateway_cloud::GatewayPlan) {
    if let Err(error) = gateway_cloud::save_state(db_path, &plan.next_state) {
        log::warn!("{error}");
    }
}

// A purge and its corrected aggregate upload form one logical cloud mutation.
// Serializing the full sync lifecycle prevents a second in-process sync from
// interleaving a later DELETE after the first caller has already re-uploaded
// and marked its local Codex rows as synced. Tokio's mutex is cancellation-safe
// and is never poisoned when a task exits early or panics.
static CLOUD_SYNC_SINGLEFLIGHT: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

async fn acquire_cloud_sync_singleflight() -> tokio::sync::MutexGuard<'static, ()> {
    CLOUD_SYNC_SINGLEFLIGHT
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

// Local receipt metadata never enters the cloud payload. A stale upload can
// succeed remotely, but must leave any newer local revision pending for retry.
const MARK_SYNCED_REVISION_SQL: &str =
    "UPDATE token_logs SET sync_status = 1, cloud_user_id = ?1, synced_at = ?2
     WHERE id = ?3 AND sync_revision = ?4";

fn mark_uploaded_revisions(
    conn: &rusqlite::Connection,
    user_id: &str,
    synced_at: &str,
    snapshots: &[(i64, i64)],
) -> Result<usize, String> {
    let mut statement = conn
        .prepare(MARK_SYNCED_REVISION_SQL)
        .map_err(|e| e.to_string())?;
    let mut marked = 0;
    for (id, revision) in snapshots {
        marked += statement
            .execute(params![user_id, synced_at, id, revision])
            .map_err(|e| e.to_string())?;
    }
    Ok(marked)
}

#[cfg(test)]
#[path = "sync_revision_tests.rs"]
mod sync_revision_tests;

pub async fn sync_to_supabase_impl(app: &AppContext) -> Result<Value, String> {
    let sync_flight = acquire_cloud_sync_singleflight().await;
    sync_to_supabase_locked(app, sync_flight).await
}

/// 自动上传（调度器与刷新扫描后）。托盘面板「后台同步」的暂停状态在拿到 singleflight 之后才读：
/// 排队等前一次上传期间被暂停，就不再新启动这一次；返回 `Ok(None)`。显式手动同步走
/// [`sync_to_supabase_impl`]，不受暂停影响。
pub async fn background_sync_to_supabase_impl(app: &AppContext) -> Result<Option<Value>, String> {
    let sync_flight = acquire_cloud_sync_singleflight().await;
    if crate::settings::background_sync_paused_now(app) {
        return Ok(None);
    }
    sync_to_supabase_locked(app, sync_flight).await.map(Some)
}

async fn sync_to_supabase_locked(
    app: &AppContext,
    _sync_flight: tokio::sync::MutexGuard<'static, ()>,
) -> Result<Value, String> {
    let (config, session_lease) = acquire_current_cloud_session(app).await?;
    let session = config
        .session
        .clone()
        .ok_or_else(|| "Please sign in to Supabase first.".to_string())?;
    let db_path = db::get_db_path(app);
    db::init_db(&db_path).map_err(|e| e.to_string())?;
    let fallback_machine = fallback_machine_id(&db_path);
    let history_guard = sync_history_guard::HistoryGuard::load(&db_path)?;
    // Before anything is uploaded under the device id: rows old versions
    // uploaded under the hostname move to it (once per account).
    let moved_count =
        device_cloud_move::move_legacy_cloud_rows(app, &db_path, &config, &session, &session_lease)
            .await?;
    let has_pending_work = {
        let conn = db::get_connection(&db_path).map_err(|e| e.to_string())?;
        conn.query_row(
            PENDING_SYNC_WORK_SQL,
            params![&session.user_id, &fallback_machine],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    };
    // dashboard-stats-v2 §2.5: hours touched by the gateway are uploaded from
    // the merged rows. While a Codex rebuild purge is pending they wait, so a
    // merged hour never interleaves with the purge and its re-upload.
    let mut gateway_hours =
        gateway_cloud::collect_hours(&db_path, &session.user_id, &fallback_machine)?;
    history_guard.retain_complete_hours(&mut gateway_hours);
    let gateway_deferred =
        !gateway_hours.is_empty() && codex_rebuild_pending(&db_path, &fallback_machine)?;
    let mut gateway_state = gateway_cloud::load_state(&db_path);
    let gateway_dirty = !gateway_deferred
        && gateway_cloud::plan(
            &gateway_hours,
            &gateway_state,
            &session.user_id,
            &fallback_machine,
            &|_| 0.0,
        )
        .has_work();
    if !has_pending_work && !gateway_dirty && moved_count == 0 {
        session_lease.ensure_current(app)?;
        return Ok(json!({
            "success": true,
            "message": if history_guard.pending() { "当前可同步数据已处理，旧网关历史待核对。" } else { "云端数据已是最新状态。" },
            "synced_count": 0,
            "purged_count": 0,
            "summary_refreshed": false,
            "history_pending": history_guard.pending(),
            "warning": history_guard.warning(None)
        }));
    }
    let prices = load_prices(app);
    backfill_null_costs(&db_path, &prices)?;
    // One-time cloud purges queued by schema upgrades (e.g. the v2 Claude
    // dedup rebuild): delete this machine's rows for the tool from the cloud
    // before re-pushing corrected aggregates, otherwise the stale inflated
    // rows would remain alongside the rebuilt ones.
    let purged_count = if history_guard.pending() {
        // A tool-wide delete could destroy older gateway hours we cannot reconstruct.
        // Keep its intent queued; complete newer hours can still be upserted below.
        0
    } else {
        process_pending_cloud_purges(app, &db_path, &config, &session, &session_lease).await?
    };
    if purged_count > 0 {
        // A purge removed rows the state says were uploaded.
        gateway_state = gateway_cloud::CloudState::default();
    }
    // Backfill is a local revision too. Capture gateway receipt revisions only
    // after it completes, so an ordinary first upload needs no second pass.
    let mut gateway_hours =
        gateway_cloud::collect_hours(&db_path, &session.user_id, &fallback_machine)?;
    history_guard.retain_complete_hours(&mut gateway_hours);
    let gateway_deferred =
        !gateway_hours.is_empty() && codex_rebuild_pending(&db_path, &fallback_machine)?;

    struct RawLog {
        id: i64,
        tool: String,
        model: String,
        input_tokens: i64,
        output_tokens: i64,
        cached_tokens: i64,
        cache_write_tokens: i64,
        timestamp: String,
        cost_usd: Option<f64>,
        machine_id: String,
        sync_status: i32,
        cloud_user_id: Option<String>,
        sync_revision: i64,
        cache_write_known: Option<bool>,
    }

    use scanner_sync::Bucket as AggKey;

    let mut raw_logs = Vec::new();
    let dirty;
    {
        let mut conn = db::get_connection(&db_path).map_err(|e| e.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if !scanner_sync::gateway_snapshot_matches(&tx, &gateway_hours)
            .map_err(|e| e.to_string())?
        {
            return Err("扫描数据在同步准备期间发生变化，请重试同步。".to_string());
        }
        let mut deferred_hours = history_guard.deferred_hours(&tx)?;
        if gateway_deferred {
            deferred_hours.extend(gateway_hours.keys().cloned());
        }
        dirty =
            scanner_sync::dirty_snapshot(&tx, &session.user_id, &fallback_machine, &deferred_hours)
                .map_err(|e| e.to_string())?;
        let mut stmt = tx.prepare(RAW_SYNC_LOGS_SQL).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params![&session.user_id, &fallback_machine])
            .map_err(|e| e.to_string())?;

        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let timestamp: String = row.get(7).map_err(|e| e.to_string())?;
            if !history_guard.allows(&gateway_cloud::hour_bucket(&timestamp)) {
                continue;
            }
            raw_logs.push(RawLog {
                id: row.get(0).map_err(|e| e.to_string())?,
                tool: row.get(1).map_err(|e| e.to_string())?,
                model: row.get(2).map_err(|e| e.to_string())?,
                input_tokens: row.get(3).map_err(|e| e.to_string())?,
                output_tokens: row.get(4).map_err(|e| e.to_string())?,
                cached_tokens: row.get(5).map_err(|e| e.to_string())?,
                cache_write_tokens: row.get(6).map_err(|e| e.to_string())?,
                timestamp,
                cost_usd: row.get(8).map_err(|e| e.to_string())?,
                machine_id: row.get(9).map_err(|e| e.to_string())?,
                sync_status: row.get(10).map_err(|e| e.to_string())?,
                cloud_user_id: row.get(11).map_err(|e| e.to_string())?,
                sync_revision: row.get(12).map_err(|e| e.to_string())?,
                cache_write_known: row.get(13).map_err(|e| e.to_string())?,
            });
        }
        drop(rows);
        drop(stmt);
        let gateway_ids = gateway_hours
            .values()
            .flatten()
            .filter(|r| !r.gateway && !gateway_deferred)
            .map(|r| r.id);
        scanner_sync::remember_sending(
            &tx,
            &session.user_id,
            &fallback_machine,
            raw_logs
                .iter()
                .filter(|r| !deferred_hours.contains(&gateway_cloud::hour_bucket(&r.timestamp)))
                .map(|r| r.id)
                .chain(gateway_ids),
        )
        .map_err(|e| e.to_string())?;
        session_lease.commit_if_current(app, || tx.commit().map_err(|e| e.to_string()))?;
    }

    let gateway_skip_hours: HashSet<String> = gateway_hours.keys().cloned().collect();
    let gateway_plan = (!gateway_deferred).then(|| {
        gateway_cloud::plan(
            &gateway_hours,
            &gateway_state,
            &session.user_id,
            &fallback_machine,
            &|row: &gateway_cloud::HourRow| {
                row.cost_usd.unwrap_or_else(|| {
                    estimate_cost_at(
                        &prices,
                        &row.tool,
                        &row.model,
                        &row.timestamp,
                        row.input_tokens,
                        row.output_tokens,
                        (row.cached_tokens - row.cache_write_tokens).max(0),
                        row.cache_write_tokens,
                    )
                })
            },
        )
    });

    let mut groups: HashMap<AggKey, Vec<RawLog>> = HashMap::new();
    for raw in raw_logs {
        let hour_bucket = gateway_cloud::hour_bucket(&raw.timestamp);
        if gateway_skip_hours.contains(&hour_bucket) {
            continue;
        }
        let mut machine_id = raw.machine_id.clone();
        if machine_id.is_empty() {
            machine_id = fallback_machine.clone();
        }
        let key = AggKey {
            tool: raw.tool.clone(),
            model: raw.model.clone(),
            hour_bucket,
            machine_id,
        };
        groups.entry(key).or_default().push(raw);
    }

    let mut sync_logs = Vec::new();
    for (key, group_rows) in groups {
        let mut input_tokens = 0;
        let mut output_tokens = 0;
        let mut cached_tokens = 0;
        let cache_write_tokens = scan_cache_write_projection(
            group_rows
                .iter()
                .map(|r| (r.cache_write_tokens, r.cache_write_known)),
        );
        let mut cost_usd = 0.0;
        let mut raw_ids = Vec::new();

        for r in &group_rows {
            input_tokens += r.input_tokens;
            output_tokens += r.output_tokens;
            cached_tokens += r.cached_tokens;

            let row_cost = r.cost_usd.unwrap_or_else(|| {
                let cache_read = (r.cached_tokens - r.cache_write_tokens).max(0);
                estimate_cost_at(
                    &prices,
                    &r.tool,
                    &r.model,
                    &r.timestamp,
                    r.input_tokens,
                    r.output_tokens,
                    cache_read,
                    r.cache_write_tokens,
                )
            });
            cost_usd += row_cost;

            let needs_sync = r.sync_status == 0
                || r.cloud_user_id.is_none()
                || r.cloud_user_id.as_ref().unwrap() != &session.user_id;

            if needs_sync {
                raw_ids.push((r.id, r.sync_revision));
            }
        }

        if raw_ids.is_empty() && !dirty.buckets.contains(&key) {
            continue;
        }

        let requests = group_rows.len() as i64;
        let unique_key = format!(
            "agg_{}_{}_{}_{}",
            key.machine_id, key.tool, key.model, key.hour_bucket
        );

        sync_logs.push(json!({
            "raw_ids": raw_ids,
            "user_id": session.user_id,
            "tool": key.tool,
            "model": key.model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_tokens": cached_tokens,
            "cache_write_tokens": cache_write_tokens,
            "timestamp": key.hour_bucket,
            "session_id": "agg",
            "unique_key": unique_key,
            "cost_usd": cost_usd,
            "machine_id": key.machine_id,
            "requests": requests,
            "gateway_requests": 0
        }));
    }
    let (mut gateway_deletes, gateway_mark_ids) = match &gateway_plan {
        Some(plan) => {
            sync_logs.extend(plan.upserts.iter().map(|agg| agg.payload(&session.user_id)));
            (plan.deletes.clone(), plan.mark_ids.clone())
        }
        None => (Vec::new(), Vec::new()),
    };

    scanner_sync::repair_payloads(
        &dirty,
        &gateway_hours,
        gateway_deferred,
        &session.user_id,
        &mut sync_logs,
        &mut gateway_deletes,
        &|row| {
            row.cost_usd.unwrap_or_else(|| {
                estimate_cost_at(
                    &prices,
                    &row.tool,
                    &row.model,
                    &row.timestamp,
                    row.input_tokens,
                    row.output_tokens,
                    (row.cached_tokens - row.cache_write_tokens).max(0),
                    row.cache_write_tokens,
                )
            })
        },
    );

    if sync_logs.is_empty()
        && purged_count == 0
        && moved_count == 0
        && gateway_deletes.is_empty()
        && gateway_mark_ids.is_empty()
    {
        if let Some(plan) = &gateway_plan {
            save_gateway_cloud_state(&db_path, plan);
        }
        session_lease.ensure_current(app)?;
        return Ok(json!({
            "success": true,
            "message": if history_guard.pending() { "当前可同步数据已处理，旧网关历史待核对。" } else { "云端数据已是最新状态。" },
            "synced_count": 0,
            "purged_count": 0,
            "summary_refreshed": true,
            "history_pending": history_guard.pending(),
            "warning": history_guard.warning(None)
        }));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Cloud sync client unavailable: {e}"))?;
    let url = format!(
        "{}/rest/v1/token_logs?on_conflict=user_id,unique_key",
        config.supabase_url
    );

    // Clouds deployed before schema v2 don't have the cache_write_tokens
    // column yet; PostgREST rejects unknown keys, so drop the field and
    // retry once, then keep it dropped for the remaining chunks.
    let mut include_cache_write = true;
    let mut include_gateway_requests = true;
    for chunk in sync_logs.chunks(SYNC_BATCH_SIZE) {
        loop {
            session_lease.ensure_current(app)?;
            let payload: Vec<Value> = chunk
                .iter()
                .map(|log| {
                    let mut cloned = log.clone();
                    let obj = cloned.as_object_mut().unwrap();
                    obj.remove("raw_ids");
                    if !include_cache_write {
                        obj.remove("cache_write_tokens");
                    }
                    if !include_gateway_requests {
                        obj.remove("gateway_requests");
                    }
                    cloned
                })
                .collect();

            let res = client
                .post(&url)
                .header("apikey", &config.supabase_key)
                .header("Authorization", format!("Bearer {}", session.access_token))
                .header("Content-Type", "application/json")
                .header("Prefer", "resolution=merge-duplicates,return=minimal")
                .json(&payload)
                .send()
                .await
                .map_err(|e| format!("Cloud sync failed: {}", e))?;
            session_lease.ensure_current(app)?;

            if res.status().is_success() {
                break;
            }
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            session_lease.ensure_current(app)?;
            if include_cache_write && body.contains("cache_write_tokens") {
                log::warn!(
                    "Cloud schema predates cache_write_tokens; retrying without the column. Apply the repository migrations (`supabase db push`, see supabase/README.md) to enable split cache sync; supabase/schema.sql is a stale baseline and must not be executed directly."
                );
                include_cache_write = false;
                continue;
            }
            if include_gateway_requests && body.contains("gateway_requests") {
                log::warn!(
                    "Cloud schema predates gateway_requests; retrying without the column. Apply the repository migrations (see supabase/README.md) to record gateway provenance."
                );
                include_gateway_requests = false;
                continue;
            }
            return Err(supabase_api_error(status, body));
        }
    }

    // Aggregates the gateway merge no longer produces. Upserts go first so a
    // failure here leaves extra rows for the retry, never a missing hour.
    for chunk in gateway_deletes.chunks(GATEWAY_DELETE_BATCH_SIZE) {
        session_lease.ensure_current(app)?;
        let res = client
            .delete(format!("{}/rest/v1/token_logs", config.supabase_url))
            .query(&[
                ("user_id", format!("eq.{}", session.user_id)),
                ("unique_key", gateway_cloud::postgrest_in_filter(chunk)),
            ])
            .header("apikey", &config.supabase_key)
            .header("Authorization", format!("Bearer {}", session.access_token))
            .header("Prefer", "return=minimal")
            .send()
            .await
            .map_err(|e| format!("Cloud sync failed: {}", e))?;
        session_lease.ensure_current(app)?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(supabase_api_error(status, body));
        }
    }

    {
        session_lease.ensure_current(app)?;
        let mut conn = db::get_connection(&db_path).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let synced_at = Utc::now().to_rfc3339();
        let mut uploaded_rows = gateway_mark_ids;
        for log in &sync_logs {
            if let Some(raw_ids) = log.get("raw_ids") {
                let snapshots: Vec<(i64, i64)> = serde_json::from_value(raw_ids.clone())
                    .map_err(|error| format!("Invalid local sync receipt: {error}"))?;
                uploaded_rows.extend(snapshots);
            }
        }
        mark_uploaded_revisions(&tx, &session.user_id, &synced_at, &uploaded_rows)?;
        scanner_sync::acknowledge_dirty(&tx, &session.user_id, &dirty.ids)
            .map_err(|e| e.to_string())?;
        session_lease.commit_if_current(app, || tx.commit().map_err(|e| e.to_string()))?;
        session_lease.ensure_current(app)?;
    }
    if let Some(plan) = &gateway_plan {
        save_gateway_cloud_state(&db_path, plan);
    }

    // Upload completion and cloud-summary refresh are separate outcomes. Drop
    // every local cloud cache entry as soon as writes are committed so a stale
    // five-minute payload can never make a successful upload look ineffective.
    session_lease.commit_if_current(app, || {
        cache::invalidate_cloud(&db_path);
        Ok(())
    })?;

    let refresh_warning = match request_refresh_summaries_impl(app).await {
        Ok(_) => None,
        Err(error) => {
            log::warn!("Post-sync cloud refresh failed: {error}");
            Some("Token 数据已上传，但云端汇总刷新尚未确认；看板数据可能短暂不完整。")
        }
    };
    let summary_refreshed = refresh_warning.is_none();
    let mut message = if purged_count > 0 {
        format!(
            "已同步 {} 个云端小时聚合组，并完成 {} 项历史清理。",
            sync_logs.len(),
            purged_count
        )
    } else {
        format!("已同步 {} 个云端小时聚合组。", sync_logs.len())
    };
    if moved_count > 0 {
        message.push_str(&format!(
            "本机原先按电脑名上传的 {moved_count} 条云端记录已改用随机设备 ID。"
        ));
    }

    Ok(json!({
        "success": true,
        "message": message,
        "synced_count": sync_logs.len(),
        "purged_count": purged_count,
        "moved_count": moved_count,
        "summary_refreshed": summary_refreshed,
        "warning": history_guard.warning(refresh_warning),
        "history_pending": history_guard.pending()
    }))
}

/// Executes (and clears) one-time cloud purge requests queued in the local
/// pending_cloud_purges table. Each entry deletes this user's rows for one
/// (tool, machine_id) pair via PostgREST; RLS scopes the delete to the
/// authenticated user, and other machines' data is untouched.
fn load_ready_cloud_purges(db_path: &Path) -> Result<Vec<(i64, String, String)>, String> {
    let conn = db::get_connection(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, tool, machine_id
             FROM pending_cloud_purges
             WHERE ready = 1",
        )
        .map_err(|e| e.to_string())?;
    let purges = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(purges)
}

fn complete_local_cloud_purge(db_path: &std::path::Path, purge_id: i64) -> Result<(), String> {
    let conn = db::get_connection(db_path).map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM pending_cloud_purges WHERE id = ?1 AND ready = 1",
        params![purge_id],
    )
    .map_err(|e| e.to_string())?;
    // A remote DELETE is immediately user-visible even when the following
    // aggregate upload fails. Drop every cloud-derived cache shape now,
    // including the dedicated wallpaper/yesterday scope that
    // `cache::invalidate_cloud` does not cover.
    tx.execute(
        "DELETE FROM local_stats_cache
         WHERE scope = 'cloud' OR scope = 'cloud_yesterday'",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

async fn process_pending_cloud_purges(
    app: &AppContext,
    db_path: &Path,
    config: &CloudConfig,
    session: &CloudSession,
    session_lease: &CloudSessionUseLease,
) -> Result<usize, String> {
    let purges = load_ready_cloud_purges(db_path)?;

    if purges.is_empty() {
        return Ok(0);
    }

    let purge_count = purges.len();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Cloud purge client unavailable: {e}"))?;
    for (purge_id, tool, machine_id) in purges {
        session_lease.ensure_current(app)?;
        let url = format!("{}/rest/v1/token_logs", config.supabase_url);
        let res = client
            .delete(&url)
            .query(&[
                ("tool", format!("eq.{}", tool)),
                ("machine_id", format!("eq.{}", machine_id)),
            ])
            .header("apikey", &config.supabase_key)
            .header("Authorization", format!("Bearer {}", session.access_token))
            .header("Prefer", "return=minimal")
            .send()
            .await
            .map_err(|e| format!("Cloud purge failed: {}", e))?;

        session_lease.ensure_current(app)?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            session_lease.ensure_current(app)?;
            return Err(format!(
                "Cloud purge for tool={} failed ({}): {}",
                tool, status, body
            ));
        }

        session_lease.commit_if_current(app, || complete_local_cloud_purge(db_path, purge_id))?;
        log::info!("cloud purge done: tool={tool}, machine_id={machine_id}");
    }
    Ok(purge_count)
}

#[cfg(test)]
mod codex_rebuild_sync_gate_tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn test_db(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "tokenledger_{name}_{}_{}.db",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_file(&path);
        db::init_test_db(&path).expect("initialize sync-gate test database");
        path
    }

    #[test]
    fn cloud_sync_singleflight_blocks_a_second_purge_upload_lifecycle() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_time()
            .build()
            .expect("build sync singleflight runtime");
        runtime.block_on(async {
            let first_flight = acquire_cloud_sync_singleflight().await;
            let second_attempted = Arc::new(tokio::sync::Notify::new());
            let second_entered = Arc::new(AtomicBool::new(false));
            let attempted_signal = Arc::clone(&second_attempted);
            let entered_signal = Arc::clone(&second_entered);
            let second = tokio::spawn(async move {
                attempted_signal.notify_one();
                let _second_flight = acquire_cloud_sync_singleflight().await;
                entered_signal.store(true, Ordering::SeqCst);
            });

            second_attempted.notified().await;
            tokio::time::sleep(Duration::from_millis(25)).await;
            assert!(
                !second_entered.load(Ordering::SeqCst),
                "a second sync must not enter while the first owns purge plus upload"
            );

            drop(first_flight);
            tokio::time::timeout(Duration::from_secs(1), second)
                .await
                .expect("second sync acquires the released flight")
                .expect("second sync task completes");
            assert!(second_entered.load(Ordering::SeqCst));
        });
    }

    #[test]
    fn staged_codex_rows_are_excluded_for_every_unsynced_condition() {
        let path = test_db("codex_sync_gate");
        let conn = Connection::open(&path).expect("open test database");
        conn.execute_batch(
            "DELETE FROM pending_cloud_purges;
             INSERT INTO pending_cloud_purges (tool, machine_id, ready)
                 VALUES ('codex', 'machine-a', 0);
             INSERT INTO token_logs (
                 tool, model, input_tokens, output_tokens, cached_tokens,
                 timestamp, session_id, unique_key, machine_id, sync_status,
                 cloud_user_id
             ) VALUES
                 ('codex', 'gpt-test', 1, 1, 0, '2026-08-01 00:00:00',
                  's1', 'blocked-status', 'machine-a', 0, 'cloud-user'),
                 ('codex', 'gpt-test', 1, 1, 0, '2026-08-01 01:00:00',
                  's2', 'blocked-null-user', '', 1, NULL),
                 ('codex', 'gpt-test', 1, 1, 0, '2026-08-01 02:00:00',
                  's3', 'blocked-other-user', 'machine-a', 1, 'other-user');",
        )
        .expect("seed all unsynced Codex shapes");

        let pending: bool = conn
            .query_row(
                PENDING_SYNC_WORK_SQL,
                params!["cloud-user", "machine-a"],
                |row| row.get(0),
            )
            .expect("query pending work");
        assert!(
            !pending,
            "ready=0 must block sync_status, NULL owner, and mismatched owner rows"
        );
        let blocked_ids = conn
            .prepare(RAW_SYNC_LOGS_SQL)
            .expect("prepare gated raw-log query")
            .query_map(params!["cloud-user", "machine-a"], |row| {
                row.get::<_, i64>(0)
            })
            .expect("query gated raw logs")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect gated raw logs");
        assert!(blocked_ids.is_empty());

        conn.execute(
            "UPDATE pending_cloud_purges SET ready = 1
             WHERE tool = 'codex' AND machine_id = 'machine-a'",
            [],
        )
        .expect("make rebuild purge actionable");
        let pending_after_swap: bool = conn
            .query_row(
                PENDING_SYNC_WORK_SQL,
                params!["cloud-user", "machine-a"],
                |row| row.get(0),
            )
            .expect("query actionable work");
        assert!(pending_after_swap);
        let ready_ids = conn
            .prepare(RAW_SYNC_LOGS_SQL)
            .expect("prepare actionable raw-log query")
            .query_map(params!["cloud-user", "machine-a"], |row| {
                row.get::<_, i64>(0)
            })
            .expect("query actionable raw logs")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect actionable raw logs");
        assert_eq!(ready_ids.len(), 3);

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn staged_codex_gate_does_not_block_other_tools_or_machines() {
        let path = test_db("codex_sync_gate_scope");
        let conn = Connection::open(&path).expect("open test database");
        conn.execute_batch(
            "DELETE FROM pending_cloud_purges;
             INSERT INTO pending_cloud_purges (tool, machine_id, ready)
                 VALUES ('codex', 'machine-a', 0);
             INSERT INTO token_logs (
                 tool, model, input_tokens, output_tokens, cached_tokens,
                 timestamp, session_id, unique_key, machine_id, sync_status,
                 cloud_user_id
             ) VALUES
                 ('codex', 'gpt-test', 1, 1, 0, '2026-08-01 00:00:00',
                  's1', 'blocked-current', 'machine-a', 0, 'cloud-user'),
                 ('codex', 'gpt-test', 1, 1, 0, '2026-08-01 01:00:00',
                  's2', 'allowed-other-machine', 'machine-b', 0, 'cloud-user'),
                 ('opencode', 'provider', 1, 1, 0, '2026-08-01 02:00:00',
                  's3', 'allowed-other-tool', 'machine-a', 0, 'cloud-user');",
        )
        .expect("seed scoped sync gate");

        let mut keys = conn
            .prepare(RAW_SYNC_LOGS_SQL)
            .expect("prepare scoped raw-log query")
            .query_map(params!["cloud-user", "machine-a"], |row| {
                row.get::<_, i64>(0)
            })
            .expect("query scoped raw logs")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect scoped raw logs");
        keys.sort_unstable();
        assert_eq!(keys.len(), 2);
        let blocked_id: i64 = conn
            .query_row(
                "SELECT id FROM token_logs WHERE unique_key = 'blocked-current'",
                [],
                |row| row.get(0),
            )
            .expect("read blocked row id");
        assert!(!keys.contains(&blocked_id));

        drop(conn);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn only_ready_purges_run_and_success_clears_all_cloud_cache_scopes() {
        let path = test_db("codex_ready_purge");
        let conn = Connection::open(&path).expect("open test database");
        conn.execute_batch(
            "DELETE FROM pending_cloud_purges;
             INSERT INTO pending_cloud_purges (tool, machine_id, ready)
                 VALUES ('codex', 'machine-a', 0);
             INSERT INTO pending_cloud_purges (tool, machine_id, ready)
                 VALUES ('claude', 'machine-a', 1);
             INSERT INTO local_stats_cache
                 (scope, range_key, device_filter, data_json, updated_at)
             VALUES
                 ('local', 'today', 'all', '{}', 1),
                 ('cloud', 'today', 'all', '{}', 1),
                 ('cloud_yesterday', 'today', 'all', '{}', 1);",
        )
        .expect("seed purge queue and caches");
        let staged_id: i64 = conn
            .query_row(
                "SELECT id FROM pending_cloud_purges WHERE tool = 'codex'",
                [],
                |row| row.get(0),
            )
            .expect("read staged purge id");
        let ready_id: i64 = conn
            .query_row(
                "SELECT id FROM pending_cloud_purges WHERE tool = 'claude'",
                [],
                |row| row.get(0),
            )
            .expect("read ready purge id");
        drop(conn);

        let ready = load_ready_cloud_purges(&path).expect("load actionable purges");
        assert_eq!(
            ready,
            vec![(ready_id, "claude".to_string(), "machine-a".to_string())]
        );
        complete_local_cloud_purge(&path, ready_id).expect("complete local purge state");

        let conn = Connection::open(&path).expect("reopen test database");
        let staged_ready: i64 = conn
            .query_row(
                "SELECT ready FROM pending_cloud_purges WHERE id = ?1",
                [staged_id],
                |row| row.get(0),
            )
            .expect("read retained staged purge");
        assert_eq!(staged_ready, 0);
        let ready_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pending_cloud_purges WHERE id = ?1",
                [ready_id],
                |row| row.get(0),
            )
            .expect("count completed purge");
        assert_eq!(ready_count, 0);
        let scopes = conn
            .prepare("SELECT scope FROM local_stats_cache ORDER BY scope")
            .expect("prepare cache scope query")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query cache scopes")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect cache scopes");
        assert_eq!(scopes, vec!["local".to_string()]);

        drop(conn);
        let _ = fs::remove_file(path);
    }
}

const RPC_DASHBOARD_STATS_V2: &str = "get_dashboard_stats_v2";
const RPC_USAGE_COMPARISON_V2: &str = "get_usage_comparison_v2";
const RPC_USAGE_DETAILS_V2: &str = "get_usage_details_v2";
const RPC_ENTITY_DASHBOARD_V2: &str = "get_usage_entity_dashboard_v2";
const RPC_DASHBOARD_STATS: &str = "get_dashboard_stats";
const RPC_USAGE_COMPARISON: &str = "get_usage_comparison_v1";
const RPC_USAGE_DETAILS: &str = "get_usage_details_v1";
const RPC_ENTITY_DASHBOARD: &str = "get_usage_entity_dashboard_v1";

struct CloudRpcContext {
    app: AppContext,
    config: CloudConfig,
    session: CloudSession,
    client: reqwest::Client,
    session_lease: CloudSessionUseLease,
}

impl CloudRpcContext {
    async fn for_app(app: &AppContext) -> Result<Self, String> {
        let (config, session_lease) = acquire_current_cloud_session(app).await?;
        let session = config
            .session
            .clone()
            .ok_or_else(|| "Please sign in to Supabase first.".to_string())?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|error| format!("Cloud client unavailable: {error}"))?;
        Ok(Self {
            app: app.clone(),
            config,
            session,
            client,
            session_lease,
        })
    }

    async fn call(
        &self,
        function_name: &'static str,
        payload: &Value,
    ) -> Result<Value, CloudRpcFailure> {
        self.session_lease
            .ensure_current(&self.app)
            .map_err(|_| CloudRpcFailure::new(function_name, CloudRpcFailureKind::Superseded))?;
        let url = format!("{}/rest/v1/rpc/{function_name}", self.config.supabase_url);
        let response = self
            .client
            .post(url)
            .header("apikey", &self.config.supabase_key)
            .header(
                "Authorization",
                format!("Bearer {}", self.session.access_token),
            )
            .header("Content-Type", "application/json")
            .json(payload)
            .send()
            .await
            .map_err(|_| CloudRpcFailure::new(function_name, CloudRpcFailureKind::Transport))?;
        self.session_lease
            .ensure_current(&self.app)
            .map_err(|_| CloudRpcFailure::new(function_name, CloudRpcFailureKind::Superseded))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        self.session_lease
            .ensure_current(&self.app)
            .map_err(|_| CloudRpcFailure::new(function_name, CloudRpcFailureKind::Superseded))?;
        if !status.is_success() {
            return Err(CloudRpcFailure::new(
                function_name,
                classify_cloud_rpc_failure(status, &body, function_name),
            ));
        }
        serde_json::from_str(&body)
            .map_err(|_| CloudRpcFailure::new(function_name, CloudRpcFailureKind::InvalidResponse))
    }
}

/// T10.185 review P2-1/FI-3a: the non-2xx classification chain used by
/// `CloudRpcContext::call`, pulled out as a pure function so a regression
/// (e.g. losing the `is_custom_range_rejected_by_schema` branch, which would
/// make an unmigrated server's 400/`22023` fall through to a generic
/// `Http(400)` instead of the honest `RangeUnsupported`/"云端范围受限") is
/// caught by a direct unit test instead of requiring a live cloud round-trip.
/// Order matters: a missing signature is checked first because an
/// entirely-absent v2 RPC and a present-but-schema-rejecting v2 RPC are
/// different old-server shapes (see the doc comment on
/// `is_custom_range_rejected_by_schema`).
fn classify_cloud_rpc_failure(
    status: reqwest::StatusCode,
    body: &str,
    function_name: &str,
) -> CloudRpcFailureKind {
    if is_missing_rpc_signature(status, body, function_name) {
        CloudRpcFailureKind::MissingSignature
    } else if is_custom_range_rejected_by_schema(status, body) {
        CloudRpcFailureKind::RangeUnsupported
    } else if matches!(status.as_u16(), 401 | 403) {
        CloudRpcFailureKind::AuthRequired
    } else {
        CloudRpcFailureKind::Http(status.as_u16())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloudRpcFailureKind {
    MissingSignature,
    /// T10.185: the RPC signature exists but this database has not run the
    /// custom-date-range migration yet; see `is_custom_range_rejected_by_schema`.
    RangeUnsupported,
    AuthRequired,
    Http(u16),
    Transport,
    Superseded,
    InvalidResponse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CloudRpcFailure {
    function_name: &'static str,
    kind: CloudRpcFailureKind,
}

impl CloudRpcFailure {
    fn new(function_name: &'static str, kind: CloudRpcFailureKind) -> Self {
        Self {
            function_name,
            kind,
        }
    }

    fn is_missing_signature(self) -> bool {
        self.kind == CloudRpcFailureKind::MissingSignature
    }

    fn safe_message(self) -> String {
        match self.kind {
            CloudRpcFailureKind::MissingSignature => {
                format!("Cloud capability '{}' is unavailable.", self.function_name)
            }
            // Same wording as the old client-side rejection so
            // `classifyCloudFailure` keeps classifying it as `range-unsupported`
            // ("云端范围受限") and never as the generic "云端服务暂不可用" (T10.180).
            CloudRpcFailureKind::RangeUnsupported => CUSTOM_RANGE_CLOUD_UNSUPPORTED.to_string(),
            CloudRpcFailureKind::AuthRequired => {
                "Cloud session is not authorized. Please sign in again.".to_string()
            }
            CloudRpcFailureKind::Http(status) => {
                format!("Cloud RPC request failed (HTTP {status}).")
            }
            CloudRpcFailureKind::Transport => {
                "Cloud RPC request could not be completed.".to_string()
            }
            CloudRpcFailureKind::Superseded => {
                "Cloud RPC request was superseded by a newer session state.".to_string()
            }
            CloudRpcFailureKind::InvalidResponse => {
                "Cloud RPC returned an invalid response.".to_string()
            }
        }
    }
}

#[derive(Debug, Clone)]
struct CloudDetailsRequest {
    query: NormalizedStatsQuery,
    cursor: Option<String>,
    limit: usize,
}

fn normalize_details_request(query: &UsageDetailsQuery) -> Result<CloudDetailsRequest, String> {
    let normalized = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range: query.range.clone(),
        start: query.start.clone(),
        end: query.end.clone(),
        timezone: query.timezone.clone(),
        machines: query.machines.clone(),
        machine: query.machine.clone(),
        tools: query.tools.clone(),
        tool: query.tool.clone(),
        models: query.models.clone(),
        model: query.model.clone(),
        search: query.search.clone(),
        token_mode: query
            .token_mode
            .clone()
            .or_else(|| Some("effective".to_string())),
    })?;
    let cursor = query
        .cursor
        .as_deref()
        .map(ascii_trim)
        .and_then(|cursor| (!cursor.is_empty()).then(|| cursor.to_string()));
    if let Some(cursor) = cursor.as_deref() {
        if cursor.len() > MAX_CURSOR_BYTES {
            return Err("detail cursor is too long".to_string());
        }
    }
    Ok(CloudDetailsRequest {
        query: normalized,
        cursor,
        limit: query.limit.unwrap_or(50).clamp(1, 100),
    })
}

fn query_context_json(query: &NormalizedStatsQuery) -> Value {
    query.echo_json()
}

fn validate_cloud_v2_echo(
    response: &Value,
    query: &NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
) -> Result<(), String> {
    let echoed_query = response
        .pointer("/meta/query")
        .cloned()
        .ok_or_else(|| "Cloud Stats v2 response is missing its query echo.".to_string())?;
    let echoed_query = serde_json::from_value::<LocalStatsQuery>(echoed_query)
        .map_err(|_| "Cloud Stats v2 response has a malformed query echo.".to_string())?;
    let echoed_query = NormalizedStatsQuery::from_query(echoed_query)
        .map_err(|_| "Cloud Stats v2 response has a malformed query echo.".to_string())?;
    if echoed_query.request_json() != query.request_json() {
        return Err("Cloud Stats v2 response query echo does not match the request.".to_string());
    }

    match entity {
        Some(expected) => {
            let echoed_entity = response
                .pointer("/meta/entity")
                .cloned()
                .ok_or_else(|| "Cloud Stats v2 response is missing its entity echo.".to_string())?;
            let echoed_entity = serde_json::from_value::<EntitySelectorInput>(echoed_entity)
                .map_err(|_| "Cloud Stats v2 response has a malformed entity echo.".to_string())?;
            let echoed_entity = NormalizedEntitySelector::from_input(echoed_entity)
                .map_err(|_| "Cloud Stats v2 response has a malformed entity echo.".to_string())?;
            if &echoed_entity != expected {
                return Err(
                    "Cloud Stats v2 response entity echo does not match the request.".to_string(),
                );
            }
        }
        None if response
            .pointer("/meta/entity")
            .is_some_and(|value| !value.is_null()) =>
        {
            return Err(
                "Cloud Stats v2 response unexpectedly contains an entity echo.".to_string(),
            );
        }
        None => {}
    }
    Ok(())
}

fn validate_cloud_v2_echoes(
    response: &Value,
    query: &NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
    child_fields: &[&str],
) -> Result<(), String> {
    validate_cloud_v2_echo(response, query, entity)?;
    for field in child_fields {
        if let Some(child) = response.get(*field).filter(|value| !value.is_null()) {
            validate_cloud_v2_echo(child, query, entity)?;
        }
    }
    Ok(())
}

fn query_v2_rpc_payload(user_id: &str, query: &NormalizedStatsQuery) -> Value {
    json!({ "p_user": user_id, "p_query": query.request_json() })
}

fn dashboard_legacy_rpc_payload(
    user_id: &str,
    query: &NormalizedStatsQuery,
    timezone: bool,
) -> Value {
    let mut payload = Map::new();
    payload.insert("p_user".to_string(), json!(user_id));
    payload.insert("p_range".to_string(), json!(query.range.as_str()));
    payload.insert("p_machine".to_string(), json!(query.single_machine()));
    if timezone {
        payload.insert("p_timezone".to_string(), json!(query.timezone));
    }
    Value::Object(payload)
}

fn comparison_legacy_rpc_payload(user_id: &str, query: &NormalizedStatsQuery) -> Value {
    json!({
        "p_user": user_id,
        "p_range": query.range.as_str(),
        "p_machine": query.single_machine(),
        "p_tool": query.single_tool(),
        "p_model": query.single_model(),
        "p_timezone": query.timezone
    })
}

fn details_v2_rpc_payload(user_id: &str, request: &CloudDetailsRequest) -> Value {
    json!({
        "p_user": user_id,
        "p_query": request.query.request_json(),
        "p_cursor": request.cursor,
        "p_limit": request.limit
    })
}

fn details_legacy_rpc_payload(user_id: &str, request: &CloudDetailsRequest) -> Value {
    json!({
        "p_user": user_id,
        "p_range": request.query.range.as_str(),
        "p_machine": request.query.single_machine(),
        "p_tool": request.query.single_tool(),
        "p_model": request.query.single_model(),
        "p_timezone": request.query.timezone,
        "p_cursor": request.cursor,
        "p_limit": request.limit
    })
}

fn entity_v2_rpc_payload(user_id: &str, request: &NormalizedEntityRequest) -> Value {
    json!({
        "p_user": user_id,
        "p_query": request.query.request_json(),
        "p_entity": entity_json(&request.entity),
        "p_cursor": Value::Null,
        "p_limit": 20
    })
}

fn entity_legacy_rpc_payload(user_id: &str, request: &NormalizedEntityRequest) -> Value {
    let (tool, model) = match request.entity.kind {
        EntityKind::Tool => (Some(request.entity.id.as_str()), None),
        EntityKind::Model => (
            request.query.single_tool(),
            Some(request.entity.id.as_str()),
        ),
    };
    json!({
        "p_user": user_id,
        "p_range": request.query.range.as_str(),
        "p_machine": request.query.single_machine(),
        "p_tool": tool,
        "p_model": model,
        "p_timezone": request.query.timezone
    })
}

#[derive(Debug, Clone, Copy)]
struct BridgeCapabilities {
    comparison: bool,
    detail_pagination: bool,
    entity_dashboard: bool,
    multi_filter_search: bool,
}

fn set_bridge_meta(
    response: &mut Value,
    scope: StatsScope,
    capabilities: BridgeCapabilities,
    contract_v2: bool,
    query: Option<&NormalizedStatsQuery>,
    entity: Option<&NormalizedEntitySelector>,
) -> Result<(), String> {
    let root = response
        .as_object_mut()
        .ok_or_else(|| "cloud RPC returned a non-object response".to_string())?;
    let meta_value = root.entry("meta".to_string()).or_insert_with(|| json!({}));
    if !meta_value.is_object() {
        *meta_value = json!({});
    }
    let meta = meta_value.as_object_mut().expect("meta was normalized");
    let quota_snapshots = meta
        .get("capabilities")
        .and_then(Value::as_object)
        .and_then(|value| value.get("quotaSnapshots"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // 契约 §2.4：RPC 声明按缓存净节省口径计算时原样转告；没有声明（旧云端）就不补这一位，
    // 桌面桥接出的对象由 `priceBasis: local-prices` 标明来源（T10.183）。
    let rpc_cache_savings = meta
        .get("capabilities")
        .and_then(Value::as_object)
        .and_then(|value| value.get("cacheSavings"))
        .and_then(Value::as_bool)
        == Some(true);
    if contract_v2 {
        meta.insert("contractVersion".to_string(), json!(2));
    }
    if let Some(query) = query {
        meta.insert("query".to_string(), query_context_json(query));
        if let Some(machine) = singular_compat_value(&query.machines) {
            meta.insert("machine".to_string(), machine);
        } else {
            meta.remove("machine");
        }
    }
    if let Some(entity) = entity {
        meta.insert("entity".to_string(), entity_json(entity));
    } else {
        meta.remove("entity");
    }
    meta.insert("scope".to_string(), json!(scope.as_str()));
    let mut bridged_capabilities = json!({
        "comparison": capabilities.comparison,
        "detailPagination": capabilities.detail_pagination,
        "entityDashboard": capabilities.entity_dashboard,
        "multiFilterSearch": capabilities.multi_filter_search,
        "quotaSnapshots": quota_snapshots
    });
    if rpc_cache_savings {
        bridged_capabilities["cacheSavings"] = json!(true);
    }
    meta.insert("capabilities".to_string(), bridged_capabilities);
    Ok(())
}

fn advertises_multi_filter_search(response: &Value) -> bool {
    response
        .pointer("/meta/capabilities/multiFilterSearch")
        .and_then(Value::as_bool)
        == Some(true)
}

fn merge_cloud_dashboard(
    mut dashboard: Value,
    comparison: Option<Value>,
    extended_available: bool,
    multi_filter_search: bool,
    contract_v2: bool,
    query: &NormalizedStatsQuery,
) -> Result<Value, String> {
    let comparison_available = comparison.as_ref().is_some_and(|value| !value.is_null());
    if let Some(comparison) = comparison.filter(|value| !value.is_null()) {
        dashboard
            .as_object_mut()
            .ok_or_else(|| "cloud dashboard response is invalid".to_string())?
            .insert("comparison".to_string(), comparison);
    }
    set_bridge_meta(
        &mut dashboard,
        StatsScope::Cloud,
        BridgeCapabilities {
            comparison: comparison_available,
            detail_pagination: extended_available,
            entity_dashboard: extended_available,
            multi_filter_search,
        },
        contract_v2,
        Some(query),
        None,
    )?;
    Ok(dashboard)
}

fn mark_cloud_v2_response(
    mut response: Value,
    query: &NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
    multi_filter_search: bool,
) -> Result<Value, String> {
    let comparison = response
        .get("comparison")
        .is_some_and(|value| !value.is_null());
    set_bridge_meta(
        &mut response,
        StatsScope::Cloud,
        BridgeCapabilities {
            comparison,
            detail_pagination: true,
            entity_dashboard: true,
            multi_filter_search,
        },
        true,
        Some(query),
        entity,
    )?;
    Ok(response)
}

fn enrich_cloud_detail_items(response: &mut Value) {
    let Some(items) = response.get_mut("items").and_then(Value::as_array_mut) else {
        return;
    };
    for item in items {
        let Some(item) = item.as_object_mut() else {
            continue;
        };
        if !item.contains_key("cacheReadTokens") {
            // A legacy response may expose only combined cachedTokens. That
            // value cannot be relabelled as cache reads. Derive the split only
            // when the source explicitly supplies a numeric write component.
            if let (Some(cached), Some(cache_write)) = (
                item.get("cachedTokens").and_then(Value::as_i64),
                item.get("cacheWriteTokens").and_then(Value::as_i64),
            ) {
                item.insert(
                    "cacheReadTokens".to_string(),
                    json!((cached - cache_write).max(0)),
                );
            }
        }
        item.entry("granularity".to_string())
            .or_insert_with(|| json!("hour"));
    }
}

#[cfg(test)]
mod cloud_detail_cache_semantics_tests {
    use super::*;

    #[test]
    fn legacy_combined_cache_is_not_relabelled_as_cache_read() {
        let mut response = json!({
            "items": [
                {
                    "id": "combined-only",
                    "cachedTokens": 120
                },
                {
                    "id": "split-source",
                    "cachedTokens": 120,
                    "cacheWriteTokens": 20
                },
                {
                    "id": "explicit-read",
                    "cachedTokens": 120,
                    "cacheWriteTokens": 20,
                    "cacheReadTokens": 75
                }
            ]
        });

        enrich_cloud_detail_items(&mut response);
        let items = response["items"].as_array().expect("detail items");
        assert!(items[0].get("cacheReadTokens").is_none());
        assert!(items[0].get("cacheWriteTokens").is_none());
        assert_eq!(items[1]["cacheReadTokens"], 100);
        assert_eq!(items[1]["cacheWriteTokens"], 20);
        assert_eq!(items[2]["cacheReadTokens"], 75);
        assert!(items
            .iter()
            .all(|item| item["granularity"].as_str() == Some("hour")));
    }
}

fn post_process_cloud_details(
    mut response: Value,
    query: &NormalizedStatsQuery,
    multi_filter_search: bool,
) -> Result<Value, String> {
    let multi_filter_search = multi_filter_search && advertises_multi_filter_search(&response);
    enrich_cloud_detail_items(&mut response);
    mark_cloud_v2_response(response, query, None, multi_filter_search)
}

fn post_process_cloud_entity(
    mut response: Value,
    request: &NormalizedEntityRequest,
    multi_filter_search: bool,
) -> Result<Value, String> {
    let multi_filter_search = multi_filter_search && advertises_multi_filter_search(&response);
    if let Some(history_page) = response.get_mut("historyPage") {
        enrich_cloud_detail_items(history_page);
    }
    mark_cloud_v2_response(
        response,
        &request.query,
        Some(&request.entity),
        multi_filter_search,
    )
}

fn unavailable_meta(
    query: &NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
) -> Value {
    let mut meta = json!({
        "contractVersion": 2,
        "scope": StatsScope::Cloud.as_str(),
        "timezone": query.timezone,
        "range": query.range.as_str(),
        "query": query_context_json(query),
        "capabilities": {
            "comparison": false,
            "detailPagination": false,
            "entityDashboard": false,
            "multiFilterSearch": false,
            "quotaSnapshots": false
        }
    });
    let meta_object = meta.as_object_mut().expect("unavailable meta is an object");
    if let Some(machine) = singular_compat_value(&query.machines) {
        meta_object.insert("machine".to_string(), machine);
    }
    if let Some(entity) = entity {
        meta_object.insert("entity".to_string(), entity_json(entity));
    }
    meta
}

fn cloud_details_unavailable(
    query: &NormalizedStatsQuery,
    entity: Option<&NormalizedEntitySelector>,
) -> Value {
    json!({
        "status": "unavailable",
        "unavailable": {
            "code": "cloud-stats-v2-rpc-unavailable",
            "message": "Cloud detail pagination is unavailable until Stats v2 is deployed."
        },
        "items": [],
        "nextCursor": Value::Null,
        "hasMore": Value::Null,
        "totalCount": Value::Null,
        "filteredSummary": Value::Null,
        "availableFilters": Value::Null,
        "granularity": Value::Null,
        "meta": unavailable_meta(query, entity)
    })
}

fn cloud_entity_unavailable(request: &NormalizedEntityRequest) -> Value {
    let compatibility_tool = match request.entity.kind {
        EntityKind::Tool => Some(request.entity.id.as_str()),
        EntityKind::Model => request.query.single_tool(),
    };
    let compatibility_model =
        (request.entity.kind == EntityKind::Model).then_some(request.entity.id.as_str());
    json!({
        "status": "unavailable",
        "unavailable": {
            "code": "cloud-stats-v2-rpc-unavailable",
            "message": "Cloud entity dashboards are unavailable until Stats v2 is deployed."
        },
        "entity": {
            "kind": request.entity.kind.as_str(),
            "id": request.entity.id,
            "tool": compatibility_tool,
            "model": compatibility_model
        },
        "summary": Value::Null,
        "comparison": Value::Null,
        "composition": Value::Null,
        "heatmap": Value::Null,
        "peak": Value::Null,
        "activity": Value::Null,
        "historyPage": cloud_details_unavailable(&request.query, Some(&request.entity)),
        "granularity": Value::Null,
        "meta": unavailable_meta(&request.query, Some(&request.entity))
    })
}

// TODO(T7.3b 跟进)：v1 命令移除后本函数暂无调用方，保留待后续统一清理；allow 防止 clippy -D warnings 门禁误伤。
#[allow(dead_code)]
pub async fn get_cloud_stats_impl(
    app: &AppContext,
    range: String,
    device_filter: String,
    timezone: String,
) -> Result<Value, String> {
    let query = NormalizedStatsQuery::from_query(LocalStatsQuery {
        range,
        start: None,
        end: None,
        timezone,
        machines: None,
        machine: Some(device_filter),
        tools: None,
        tool: None,
        models: None,
        model: None,
        search: None,
        token_mode: Some("effective".to_string()),
    })?;
    get_cloud_stats_for_query_impl(app, query).await
}

async fn get_cloud_stats_for_query_impl(
    app: &AppContext,
    query: NormalizedStatsQuery,
) -> Result<Value, String> {
    let context = CloudRpcContext::for_app(app).await?;
    let modern_payload = query_v2_rpc_payload(&context.session.user_id, &query);
    let dashboard_result = context.call(RPC_DASHBOARD_STATS_V2, &modern_payload).await;
    let (dashboard, dashboard_v2) =
        resolve_cloud_dashboard_v2_result(&context, &query, dashboard_result).await?;
    let dashboard_multi_filter_search = dashboard_v2 && advertises_multi_filter_search(&dashboard);
    let dashboard = post_process_cloud_stats(app, dashboard);

    let comparison_payload = query_v2_rpc_payload(&context.session.user_id, &query);
    let (comparison, extended_available, comparison_v2) = match context
        .call(RPC_USAGE_COMPARISON_V2, &comparison_payload)
        .await
    {
        Ok(comparison) => {
            if !comparison.is_null() {
                validate_cloud_v2_echoes(&comparison, &query, None, &[])?;
            }
            (Some(comparison), true, true)
        }
        Err(error) if error.is_missing_signature() && query.legacy_filter_representable() => {
            let legacy_payload = comparison_legacy_rpc_payload(&context.session.user_id, &query);
            match context.call(RPC_USAGE_COMPARISON, &legacy_payload).await {
                Ok(comparison) => (Some(comparison), true, false),
                Err(error) if error.is_missing_signature() => (None, false, false),
                Err(error) => {
                    log::warn!("{}", error.safe_message());
                    (None, false, false)
                }
            }
        }
        Err(error) if error.is_missing_signature() => (None, false, false),
        Err(error) => {
            log::warn!("{}", error.safe_message());
            (None, false, false)
        }
    };
    merge_cloud_dashboard(
        dashboard,
        comparison,
        extended_available,
        dashboard_multi_filter_search && comparison_v2,
        dashboard_v2,
        &query,
    )
}

/// T10.185 review P2-1/FI-3b: extracted from `get_cloud_stats_for_query_impl`
/// so the "v2 signature entirely missing" decision (in particular the
/// custom-range short-circuit, which must never degrade to the generic
/// capability-missing text) is driven by a synthetic `Result` in a direct
/// unit test rather than requiring a live cloud round-trip. This is the
/// exact code the production caller runs — it receives the real
/// `context.call(...).await` result — not a parallel copy of the decision.
async fn resolve_cloud_dashboard_v2_result(
    context: &CloudRpcContext,
    query: &NormalizedStatsQuery,
    result: Result<Value, CloudRpcFailure>,
) -> Result<(Value, bool), String> {
    match result {
        Ok(dashboard) => {
            validate_cloud_v2_echoes(&dashboard, query, None, &["comparison", "historyPage"])?;
            Ok((dashboard, true))
        }
        Err(error) if error.is_missing_signature() && query.range.custom_bounds().is_some() => {
            // T10.185: no legacy (`_v1`/timezone) dashboard signature has
            // start/end parameters, so a custom range can never fall back to
            // one; say so plainly instead of the generic multi-filter message.
            Err(CUSTOM_RANGE_CLOUD_UNSUPPORTED.to_string())
        }
        Err(error) if error.is_missing_signature() => {
            if !query.legacy_dashboard_representable() {
                return Err(format!(
                    "Cloud dashboard does not support the requested multi-filter/search query: {}",
                    error.safe_message()
                ));
            }
            log::warn!(
                "Cloud dashboard v2 unavailable; retrying the representable legacy signature."
            );
            let timezone_payload =
                dashboard_legacy_rpc_payload(&context.session.user_id, query, true);
            match context.call(RPC_DASHBOARD_STATS, &timezone_payload).await {
                Ok(dashboard) => Ok((dashboard, false)),
                Err(error) if error.is_missing_signature() => {
                    log::warn!(
                        "Cloud dashboard timezone signature unavailable; retrying the oldest signature."
                    );
                    let legacy_payload =
                        dashboard_legacy_rpc_payload(&context.session.user_id, query, false);
                    Ok((
                        context
                            .call(RPC_DASHBOARD_STATS, &legacy_payload)
                            .await
                            .map_err(CloudRpcFailure::safe_message)?,
                        false,
                    ))
                }
                Err(error) => Err(error.safe_message()),
            }
        }
        Err(error) => Err(error.safe_message()),
    }
}

async fn get_cloud_usage_details_impl(
    app: &AppContext,
    query: UsageDetailsQuery,
) -> Result<Value, String> {
    if query
        .providers
        .as_ref()
        .is_some_and(|values| !values.is_empty())
    {
        return Err("providers filter is only available for local usage details".to_string());
    }
    let request = normalize_details_request(&query)?;
    let context = CloudRpcContext::for_app(app).await?;
    let payload = details_v2_rpc_payload(&context.session.user_id, &request);
    let result = context.call(RPC_USAGE_DETAILS_V2, &payload).await;
    resolve_cloud_details_v2_result(&context, &request, result).await
}

/// T10.185 review P2-1/FI-3b: see `resolve_cloud_dashboard_v2_result` for why
/// this is extracted (same custom-range-must-not-degrade invariant, for the
/// usage-details RPC).
async fn resolve_cloud_details_v2_result(
    context: &CloudRpcContext,
    request: &CloudDetailsRequest,
    result: Result<Value, CloudRpcFailure>,
) -> Result<Value, String> {
    match result {
        Ok(response) => {
            validate_cloud_v2_echoes(&response, &request.query, None, &[])?;
            post_process_cloud_details(response, &request.query, true)
        }
        Err(error)
            if error.is_missing_signature() && request.query.range.custom_bounds().is_some() =>
        {
            // T10.185: same structural exclusion as the dashboard path — the
            // legacy details RPC has no start/end parameters.
            Err(CUSTOM_RANGE_CLOUD_UNSUPPORTED.to_string())
        }
        Err(error)
            if error.is_missing_signature()
                && request.query.legacy_filter_representable()
                && request
                    .cursor
                    .as_deref()
                    .is_none_or(is_legacy_detail_cursor) =>
        {
            let legacy_payload = details_legacy_rpc_payload(&context.session.user_id, request);
            match context.call(RPC_USAGE_DETAILS, &legacy_payload).await {
                Ok(response) => post_process_cloud_details(response, &request.query, false),
                Err(error) if error.is_missing_signature() => {
                    Ok(cloud_details_unavailable(&request.query, None))
                }
                Err(error) => Err(error.safe_message()),
            }
        }
        Err(error) if error.is_missing_signature() => {
            Ok(cloud_details_unavailable(&request.query, None))
        }
        Err(error) => Err(error.safe_message()),
    }
}

async fn get_cloud_entity_dashboard_impl(
    app: &AppContext,
    query: EntityDashboardQuery,
) -> Result<Value, String> {
    let normalized = normalize_entity_query(&query)?;
    let context = CloudRpcContext::for_app(app).await?;
    let payload = entity_v2_rpc_payload(&context.session.user_id, &normalized);
    let result = context.call(RPC_ENTITY_DASHBOARD_V2, &payload).await;
    resolve_cloud_entity_v2_result(&context, &normalized, result).await
}

/// T10.185 review P2-1/FI-3b: see `resolve_cloud_dashboard_v2_result` for why
/// this is extracted (same custom-range-must-not-degrade invariant, for the
/// entity dashboard RPC).
async fn resolve_cloud_entity_v2_result(
    context: &CloudRpcContext,
    normalized: &NormalizedEntityRequest,
    result: Result<Value, CloudRpcFailure>,
) -> Result<Value, String> {
    match result {
        Ok(response) => {
            validate_cloud_v2_echoes(
                &response,
                &normalized.query,
                Some(&normalized.entity),
                &["historyPage"],
            )?;
            post_process_cloud_entity(response, normalized, true)
        }
        Err(error)
            if error.is_missing_signature() && normalized.query.range.custom_bounds().is_some() =>
        {
            // T10.185: same structural exclusion as the dashboard path — the
            // legacy entity RPC has no start/end parameters.
            Err(CUSTOM_RANGE_CLOUD_UNSUPPORTED.to_string())
        }
        Err(error) if error.is_missing_signature() && normalized.legacy_representable() => {
            let legacy_payload = entity_legacy_rpc_payload(&context.session.user_id, normalized);
            match context.call(RPC_ENTITY_DASHBOARD, &legacy_payload).await {
                Ok(response) => post_process_cloud_entity(response, normalized, false),
                Err(error) if error.is_missing_signature() => {
                    Ok(cloud_entity_unavailable(normalized))
                }
                Err(error) => Err(error.safe_message()),
            }
        }
        Err(error) if error.is_missing_signature() => Ok(cloud_entity_unavailable(normalized)),
        Err(error) => Err(error.safe_message()),
    }
}

fn post_process_cloud_stats(app: &AppContext, mut aggregated: Value) -> Value {
    let prices = load_prices(app);
    // 契约 §2.4：RPC 已声明按缓存净节省口径计算（B 期）时直接采用它的节省字段，
    // 缺失即该范围不可得，不再用本机价格表桥接；没有声明（旧云端）才桥接（T10.183）。
    let rpc_cache_savings = aggregated
        .pointer("/meta/capabilities/cacheSavings")
        .and_then(Value::as_bool)
        == Some(true);
    let bridged_cache_savings = (|| {
        let summary = aggregated.get("summary")?.as_object()?;
        let summary_cached = summary.get("cachedTokens")?.as_i64()?;
        let summary_read = summary.get("cacheReadTokens")?.as_i64()?;
        let summary_write = summary.get("cacheWriteTokens")?.as_i64()?;
        if summary_cached < 0
            || summary_read < 0
            || summary_write < 0
            || summary_read.checked_add(summary_write) != Some(summary_cached)
        {
            return None;
        }

        let models = aggregated.get("models")?.as_object()?;
        let mut model_cached_total = 0i64;
        let mut model_read_total = 0i64;
        let mut model_write_total = 0i64;
        let mut estimated = CacheSavingsParts::default();
        for (model_name, model_val) in models {
            let cached = model_val.get("cached")?.as_i64()?;
            let cache_read = model_val.get("cacheRead")?.as_i64()?;
            let cache_write = model_val.get("cacheWrite")?.as_i64()?;
            if cached < 0
                || cache_read < 0
                || cache_write < 0
                || cache_read.checked_add(cache_write) != Some(cached)
            {
                return None;
            }
            model_cached_total = model_cached_total.checked_add(cached)?;
            model_read_total = model_read_total.checked_add(cache_read)?;
            model_write_total = model_write_total.checked_add(cache_write)?;
            let tool = model_val
                .get("tool")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    let m = model_name.to_lowercase();
                    if m.contains("gpt") || m.contains("o1-") {
                        "codex".to_string()
                    } else if m.contains("claude") {
                        "claude".to_string()
                    } else if m.contains("gemini") {
                        "antigravity".to_string()
                    } else if m.contains("deepseek") {
                        "deepseek".to_string()
                    } else if m.contains("minimax") || m.contains("marvis") {
                        "minimax".to_string()
                    } else {
                        "default".to_string()
                    }
                });
            estimated.add(estimate_cache_savings_parts(
                &prices,
                &tool,
                model_name,
                cache_read,
                cache_write,
            ));
        }
        if model_cached_total != summary_cached
            || model_read_total != summary_read
            || model_write_total != summary_write
        {
            return None;
        }
        Some(estimated)
    })();

    if let Some(summary) = aggregated
        .get_mut("summary")
        .and_then(|s| s.as_object_mut())
    {
        match bridged_cache_savings {
            Some(parts) if !rpc_cache_savings => {
                summary.insert("cacheSavedUsd".to_string(), json!(parts.read_saved));
                summary.insert("cacheSavings".to_string(), parts.local_prices_json());
            }
            // RPC 自己产出节省字段：原样保留，不把本机价格混进云端按上传价冻结的数。
            Some(_) => {}
            None => {
                // Older/partial cloud RPCs can synthesize a summary split from a
                // coalesced cache-write value while model rows carry no matching
                // cache-read provenance. Do not let that bridge artifact reach the
                // desktop as a proven read/write split, nor any savings built on it.
                summary.remove("cacheReadTokens");
                summary.remove("cacheWriteTokens");
                summary.remove("cacheSavedUsd");
                summary.remove("cacheSavings");
            }
        }
    }
    aggregated
}

/// `request_refresh_summaries` calls the `request_refresh()` Supabase RPC
/// so the materialized views pick up the latest token_logs writes. We
/// fire this from `sync_to_supabase` after every batch push; the cloud
/// dashboard will then be in sync without paying for a manual refresh.
pub async fn request_refresh_summaries_impl(app: &AppContext) -> Result<Value, String> {
    let context = CloudRpcContext::for_app(app).await?;
    let body = context
        .call("request_refresh", &json!({}))
        .await
        .map_err(CloudRpcFailure::safe_message)?;
    // Invalidate the cloud cache so the next stats call re-fetches.
    let db_path = db::get_db_path(app);
    context.session_lease.commit_if_current(app, || {
        cache::invalidate_cloud(&db_path);
        Ok(())
    })?;
    Ok(body)
}

/// `get_cached_stats` is the entry point the React dashboard calls. It
/// transparently caches `StatsData` by the full canonical query fingerprint
/// (scope, range, timezone, token mode, plural filters, and literal search)
/// with a 5 minute TTL.
///
///   * scope=local -> in-process aggregation of local SQLite token_logs.
///   * scope=cloud -> Supabase RPC over the materialized views.
///
/// On a cache miss we call the slow path and write the result back. On a
/// hit we deserialize the JSON and return it directly. Either way the
/// shape is identical to what the dashboard expects.
pub async fn get_cached_stats_impl(
    app: &AppContext,
    scope: String,
    range: String,
    device_filter: String,
    timezone: String,
) -> Result<Value, String> {
    get_cached_stats_query_impl(
        app,
        scope,
        LocalStatsQuery {
            range,
            start: None,
            end: None,
            timezone,
            machines: None,
            machine: Some(device_filter),
            tools: None,
            tool: None,
            models: None,
            model: None,
            search: None,
            token_mode: Some("effective".to_string()),
        },
    )
    .await
}

async fn get_cached_stats_query_impl(
    app: &AppContext,
    scope: String,
    raw_query: LocalStatsQuery,
) -> Result<Value, String> {
    const LOCAL_STATS_REPRESENTATION_VERSION: &str = "cache-split-proof-v1";

    let scope = StatsScope::parse(Some(&scope))?;
    let query = NormalizedStatsQuery::from_query(raw_query)?;
    let db_path = db::get_db_path(app);
    let base_fingerprint = query.fingerprint(None);
    let cloud_partition = if scope == StatsScope::Cloud {
        Some(cloud_cache_partition(app).await?)
    } else {
        None
    };
    let fingerprint = match cloud_partition.as_ref() {
        Some((partition, lease)) => {
            format!(
                "{base_fingerprint}:account:{partition}:generation:{}:gate:{}",
                lease.generation, lease.gate_epoch
            )
        }
        // Do not let a pre-T10.1b persistent cache reintroduce the old
        // "write=0 means read" presentation for up to five minutes after an
        // upgrade. This is an internal representation version, not a public
        // StatsData contract version.
        None => match gateway_overlay::ledger_signature(&db_path) {
            Some(gateway) => format!(
                "{base_fingerprint}:representation:{LOCAL_STATS_REPRESENTATION_VERSION}:gateway:{gateway}"
            ),
            None => {
                format!("{base_fingerprint}:representation:{LOCAL_STATS_REPRESENTATION_VERSION}")
            }
        },
    };
    let key = cache::CacheKey::for_query(scope.as_str(), query.range.as_str(), &fingerprint);

    if let Some(cached) = cache::read(&db_path, &key) {
        if let Some((_, lease)) = cloud_partition.as_ref() {
            lease.ensure_current(app)?;
        }
        return Ok(cached);
    }

    let fresh = match scope {
        StatsScope::Cloud => get_cloud_stats_for_query_impl(app, query).await?,
        StatsScope::Local => {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                Ok::<_, String>(get_local_stats_v2_snapshot_at(&app, query, Local::now())?.stats)
            })
            .await
            .map_err(|error| format!("cached local stats task panicked: {error}"))??
        }
    };

    match cloud_partition.as_ref() {
        Some((_, lease)) => {
            let _ = lease.commit_if_current(app, || {
                cache::write(&db_path, &key, &fresh);
                Ok(())
            });
        }
        None => cache::write(&db_path, &key, &fresh),
    }
    if let Some((_, lease)) = cloud_partition.as_ref() {
        lease.ensure_current(app)?;
    }
    Ok(fresh)
}
