use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::app_paths::AppContext;

/// 订阅设置的存储模型与校验（T10.188）。文件在 `cost_profile/` 目录、命令在
/// `crate::cost_profile`；在这里声明，是因为 `tests/quota_parser.rs` 按路径单独编译本文件，
/// 那个测试 crate 里没有 `crate::cost_profile`。
#[path = "cost_profile/model.rs"]
pub(crate) mod cost_model;

const SETTINGS_FILE: &str = "app_settings.json";
const SETTINGS_LOCK_FILE: &str = "app_settings.lock.sqlite3";
const SETTINGS_LOCK_TIMEOUT_MILLIS: u64 = 2_000;
pub const WALLPAPER_CONSENT_VERSION: u32 = 1;
static SETTINGS_FILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomQuotaEndpointConfig {
    pub id: String,
    pub display_name: String,
    pub url: String,
    pub enabled: bool,
    /// Non-secret metadata used to render settings without reading the API
    /// key. A missing value means this installation predates the metadata
    /// field and will be checked only during an explicit action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_configured: Option<bool>,
}

fn settings_file_lock() -> MutexGuard<'static, ()> {
    SETTINGS_FILE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with_settings_cross_process_lock<T>(
    app: &AppContext,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    const LOCK_ERROR: &str = "Unable to acquire settings persistence lock.";
    const RELEASE_ERROR: &str = "Unable to release settings persistence lock.";

    fs::create_dir_all(app.app_data_dir()).map_err(|_| LOCK_ERROR.to_string())?;
    let lock_path = app.app_data_dir().join(SETTINGS_LOCK_FILE);
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
            .map_err(|_| LOCK_ERROR.to_string())?,
    );

    let metadata = fs::symlink_metadata(&lock_path).map_err(|_| LOCK_ERROR.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LOCK_ERROR.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.nlink() != 1 {
            return Err(LOCK_ERROR.to_string());
        }
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| LOCK_ERROR.to_string())?;
    }

    let connection = Connection::open(&lock_path).map_err(|_| LOCK_ERROR.to_string())?;
    connection
        .busy_timeout(Duration::from_millis(SETTINGS_LOCK_TIMEOUT_MILLIS))
        .map_err(|_| LOCK_ERROR.to_string())?;
    connection
        .execute_batch(
            "BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS settings_lock (id INTEGER PRIMARY KEY);",
        )
        .map_err(|_| LOCK_ERROR.to_string())?;

    match action() {
        Ok(value) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|_| RELEASE_ERROR.to_string())?;
            Ok(value)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn with_settings_write_lock<T>(
    app: &AppContext,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    // Lock order is managed AppSettings state (when a caller has it), then the
    // process mutex, then this short cross-process SQLite lock. The action may
    // only perform settings file I/O; it must never acquire quota/pending locks
    // or perform network work while the SQLite transaction is open.
    let _guard = settings_file_lock();
    with_settings_cross_process_lock(app, action)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AppSettings {
    /// Local log scan interval (seconds).
    pub scan_interval_secs: u64,
    /// Internal one-time migration marker for background scan policy defaults.
    #[serde(default)]
    pub scan_policy_version: u32,
    /// Desktop wallpaper refresh interval (seconds).
    pub desktop_interval_secs: u64,
    /// Lock-screen wallpaper refresh interval (seconds).
    pub lockscreen_interval_secs: u64,
    /// Whether the desktop wallpaper is auto-updated.
    pub wallpaper_desktop_enabled: bool,
    /// Whether the lock-screen wallpaper is auto-updated.
    pub wallpaper_lockscreen_enabled: bool,
    /// Explicit authorization generation for automatic system wallpaper
    /// writes. Settings written before M10 deserialize to 0 and are therefore
    /// inert until the user confirms or rejects the historical choices.
    #[serde(default)]
    pub wallpaper_consent_version: u32,
    /// Launch on system startup.
    pub autostart_enabled: bool,
    /// Start hidden to the tray instead of showing the window.
    pub start_minimized: bool,
    /// Show the compact desktop widget window when the app starts. It is a
    /// user-visible side effect, so it defaults to off (ADR-015).
    #[serde(default)]
    pub widget_open_at_startup: bool,
    /// 在 macOS 菜单栏图标旁显示今日预估费用（T10.154 D69）。悬停提示始终
    /// 带着这份摘要；只有常驻的菜单栏标题需要用户开启。
    #[serde(default)]
    pub tray_text_enabled: bool,
    /// 托盘文字显示哪一项：`cost` 今日预估费用（默认）、`quota` 最紧额度的可用百分比。
    /// macOS 写在菜单栏图标旁；Windows / Linux 托盘没有标题位，改把它画成图标本身。
    #[serde(default = "default_tray_text_metric")]
    pub tray_text_metric: String,
    /// 托盘面板的快捷开关：暂停后台定时扫描（手动刷新照常）。只经
    /// `update_background_pause` 写入，通用 `save_settings` 不合并它。
    #[serde(default)]
    pub background_scan_paused: bool,
    /// 托盘面板的快捷开关：暂停后台云端同步（扫描后的用量同步与额度快照同步；手动同步照常）。
    /// 只经 `update_background_pause` 写入，通用 `save_settings` 不合并它。
    #[serde(default)]
    pub background_sync_paused: bool,
    /// Show the tray widget while the pointer hovers the tray icon and hide it
    /// again once the pointer has left both the icon and the widget; a click
    /// pins it instead (T10.110). Default on: this is the status-bar popover
    /// behaviour users expect, and the transient window never takes focus.
    #[serde(default = "default_tray_hover_widget_enabled")]
    pub tray_hover_widget_enabled: bool,
    /// 指针要在托盘图标上停留多少毫秒才弹出托盘挂件；取值与上限见
    /// `DEFAULT_TRAY_HOVER_DELAY_MS` / `TRAY_HOVER_DELAY_MAX_MS`。
    #[serde(default = "default_tray_hover_delay_ms")]
    pub tray_hover_delay_ms: u64,
    /// Keep a second widget window on the desktop layer (below normal windows,
    /// above the wallpaper). A visible side effect, so it defaults to off.
    #[serde(default)]
    pub desktop_widget_enabled: bool,
    /// Publish the live routing scene to the cloud for the Android live
    /// wallpaper (routing-snapshot-v1). Uploads data, so it defaults to off.
    #[serde(default)]
    pub routing_publish_enabled: bool,
    /// Last desktop-widget position in physical pixels; None = bottom-right
    /// corner of the primary work area.
    #[serde(default)]
    pub desktop_widget_position: Option<(i32, i32)>,
    /// Per-surface widget content configuration (T10.124). The tray popover
    /// and the desktop widget render the same view but serve different jobs
    /// (deliberate glance vs. ambient), so each keeps its own layout, theme,
    /// default range and pinned quota provider — mirroring the Android
    /// per-instance `WidgetConfig`. Unknown strings fall back to the default
    /// in `sanitized`, so a settings file written by a newer build never
    /// leaves an older one rendering nothing.
    #[serde(default = "default_popover_layout")]
    pub widget_popover_layout: String,
    #[serde(default = "default_widget_theme")]
    pub widget_popover_theme: String,
    #[serde(default = "default_widget_range")]
    pub widget_popover_range: String,
    /// None = pick the tightest readable window across every source.
    #[serde(default)]
    pub widget_popover_provider: Option<String>,
    #[serde(default = "default_widget_layout")]
    pub widget_desktop_layout: String,
    #[serde(default = "default_widget_theme")]
    pub widget_desktop_theme: String,
    #[serde(default = "default_widget_range")]
    pub widget_desktop_range: String,
    #[serde(default)]
    pub widget_desktop_provider: Option<String>,
    /// Whether to use cloud aggregated stats to render wallpaper.
    pub wallpaper_use_cloud: bool,
    /// Device filter applied when rendering wallpaper from cloud stats.
    #[serde(default = "default_wallpaper_device_filter")]
    pub wallpaper_device_filter: String,
    /// Whether to use dynamic background (Webview overlay) on macOS instead of static image wallpaper.
    #[serde(default = "default_wallpaper_dynamic_bg_enabled")]
    pub wallpaper_dynamic_bg_enabled: bool,
    /// Allow the local Codex quota provider. It prefers the stable app-server
    /// protocol and may fall back to a constrained experimental JSONL reader.
    #[serde(default)]
    pub quota_codex_local_enabled: bool,
    /// 「读取 Claude 额度」总开关（U-107）。status line 来源恒随它开关；实验来源
    /// `quota_claude_codexbar_enabled` 只有它为真时才参与。旧设置文件没有这个键时，
    /// 按两个旧开关迁移（`migrate_legacy_claude_quota_toggle`）。
    #[serde(default)]
    pub quota_claude_enabled: bool,
    /// Allow reading the normalized snapshot written by the explicit Claude
    /// Code status-line integration. The helper never persists the full
    /// status-line payload.
    #[serde(default)]
    pub quota_claude_statusline_enabled: bool,
    /// Allow TokenLedger's built-in Claude consumer quota reader to run the
    /// locally installed Claude agent in a bounded PTY and parse `/usage`.
    /// The field retains its historical name so existing settings migrate;
    /// an installed CodexBar CLI is used only as an optional fallback.
    #[serde(default)]
    pub quota_claude_codexbar_enabled: bool,
    /// Allow the built-in Antigravity local provider. It probes only an
    /// explicitly enabled, same-device Antigravity app/agy loopback service.
    #[serde(default)]
    pub quota_antigravity_local_enabled: bool,
    /// Allow an installed CodexBar CLI as a fallback when the built-in
    /// Antigravity local probe cannot produce a validated quota snapshot.
    #[serde(default)]
    pub quota_antigravity_codexbar_enabled: bool,
    /// User-configured company quota endpoints. API keys are deliberately not
    /// serialized here; they live in the operating-system credential store.
    #[serde(default)]
    pub quota_custom_endpoints: Vec<CustomQuotaEndpointConfig>,
    /// Allow the validated quota envelope projection to be synchronized to
    /// the authenticated user's cloud account. This is deliberately separate
    /// from each local Provider authorization and defaults to disabled.
    #[serde(default)]
    pub quota_snapshot_sync_enabled: bool,
    /// 订阅设置（T10.188，契约 docs/contracts/cost-profile-local-v1.md）。这四个
    /// `cost_*` 字段只经 `cost_profile` 的专用命令按 revision 条件写入；通用
    /// `save_settings` 不合并它们，陈旧的设置页状态因此覆盖不了订阅设置。读取宽松：
    /// 任何一项不合法只丢这一项并记条数，绝不让整份设置文件解析失败。
    #[serde(default, deserialize_with = "cost_model::deserialize_stored_plans")]
    pub cost_subscription_plans: Vec<cost_model::CostSubscriptionPlan>,
    /// 标为按量付费的工具；不在其中的工具即「未设置」，不默认视为按量。
    #[serde(
        default,
        deserialize_with = "cost_model::deserialize_stored_billing_modes"
    )]
    pub cost_tool_billing_modes: BTreeMap<String, cost_model::CostBillingMode>,
    /// 1 美元 = x 元，默认 7.2；`None` 表示文件里的值无法识别，人民币换算不可得。
    #[serde(
        default = "cost_model::default_cny_per_usd",
        deserialize_with = "cost_model::deserialize_stored_cny_per_usd"
    )]
    pub cost_cny_per_usd: Option<f64>,
    /// 订阅设置的版本号：每次成功保存（含「删除全部订阅设置」）加一。
    #[serde(default, deserialize_with = "cost_model::deserialize_stored_revision")]
    pub cost_profile_revision: u64,
    /// 模型接入总开关（U-112）：供应商、Agent、网关、路由四个入口与本地网关监听。
    /// 只经 `update_model_access_enabled` 写入，通用 `save_settings` 不合并它。
    #[serde(default)]
    pub model_access_enabled: bool,
    /// 一次性迁移标记：0 表示旧设置文件还没按升级前的使用情况决定上面的开关。
    #[serde(default)]
    pub model_access_version: u32,
    /// 一次性迁移标记：0 表示托盘挂件还停在旧默认板式「用量详情」时，要换成新默认「托盘面板」。
    #[serde(default)]
    pub widget_panel_version: u32,
}

pub const WIDGET_PANEL_VERSION: u32 = 1;

pub const MODEL_ACCESS_VERSION: u32 = 1;

fn default_wallpaper_device_filter() -> String {
    "all_cloud".to_string()
}

fn default_wallpaper_dynamic_bg_enabled() -> bool {
    true
}

fn default_tray_hover_widget_enabled() -> bool {
    true
}

/// 指针要在托盘图标上停留这么久才弹出托盘挂件（T10.125）。托盘图标只有十几像素宽，
/// 去点旁边的图标、去右下角看时间都会从它上面扫过；没有停留判定就变成"路过即弹出"。
/// 0 表示恢复旧的"立即弹出"。
pub const DEFAULT_TRAY_HOVER_DELAY_MS: u64 = 450;
/// 停留时长的上限：再长就不像"悬停查看"而像没反应，越界一律夹回。
pub const TRAY_HOVER_DELAY_MAX_MS: u64 = 2000;

fn default_tray_hover_delay_ms() -> u64 {
    DEFAULT_TRAY_HOVER_DELAY_MS
}

/// 挂件板式的闭合取值。前端 `src/utils/widgetConfig.ts` 用同一组字符串；
/// 两端都以「未知即回落到默认」为准，不做静默丢弃。
pub const WIDGET_LAYOUTS: [&str; 6] = ["usage", "combo", "quota", "compact", "routing", "panel"];
/// 托盘挂件的默认板式：额度、今日用量、网关与快捷开关一屏看完。
pub const DEFAULT_POPOVER_LAYOUT: &str = "panel";
pub const TRAY_TEXT_METRICS: [&str; 2] = ["cost", "quota"];
pub const WIDGET_THEMES: [&str; 3] = ["system", "light", "dark"];
pub const WIDGET_RANGES: [&str; 3] = ["today", "week", "month"];

fn default_widget_layout() -> String {
    WIDGET_LAYOUTS[0].to_string()
}

fn default_popover_layout() -> String {
    DEFAULT_POPOVER_LAYOUT.to_string()
}

fn default_tray_text_metric() -> String {
    TRAY_TEXT_METRICS[0].to_string()
}

fn default_widget_theme() -> String {
    WIDGET_THEMES[0].to_string()
}

fn default_widget_range() -> String {
    WIDGET_RANGES[0].to_string()
}

fn sanitize_enum(value: &str, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&value) {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            scan_interval_secs: 900,
            scan_policy_version: 1,
            desktop_interval_secs: 60,
            lockscreen_interval_secs: 300,
            wallpaper_desktop_enabled: false,
            wallpaper_lockscreen_enabled: false,
            wallpaper_consent_version: WALLPAPER_CONSENT_VERSION,
            autostart_enabled: false,
            start_minimized: false,
            widget_open_at_startup: false,
            tray_text_enabled: false,
            tray_text_metric: default_tray_text_metric(),
            background_scan_paused: false,
            background_sync_paused: false,
            tray_hover_widget_enabled: true,
            tray_hover_delay_ms: default_tray_hover_delay_ms(),
            desktop_widget_enabled: false,
            routing_publish_enabled: false,
            desktop_widget_position: None,
            widget_popover_layout: default_popover_layout(),
            widget_popover_theme: default_widget_theme(),
            widget_popover_range: default_widget_range(),
            widget_popover_provider: None,
            widget_desktop_layout: default_widget_layout(),
            widget_desktop_theme: default_widget_theme(),
            widget_desktop_range: default_widget_range(),
            widget_desktop_provider: None,
            wallpaper_use_cloud: false,
            wallpaper_device_filter: "all_cloud".to_string(),
            wallpaper_dynamic_bg_enabled: false,
            quota_codex_local_enabled: false,
            quota_claude_enabled: false,
            quota_claude_statusline_enabled: false,
            quota_claude_codexbar_enabled: false,
            quota_antigravity_local_enabled: false,
            quota_antigravity_codexbar_enabled: false,
            quota_custom_endpoints: Vec::new(),
            quota_snapshot_sync_enabled: false,
            cost_subscription_plans: Vec::new(),
            cost_tool_billing_modes: BTreeMap::new(),
            cost_cny_per_usd: cost_model::default_cny_per_usd(),
            cost_profile_revision: 0,
            model_access_enabled: false,
            model_access_version: MODEL_ACCESS_VERSION,
            widget_panel_version: WIDGET_PANEL_VERSION,
        }
    }
}

impl AppSettings {
    /// Automatic wallpaper work is fail-closed. A legacy settings file may
    /// still carry its old switches so the confirmation UI can accurately
    /// offer to restore them, but native startup/schedulers must ignore them.
    pub fn wallpaper_automation_authorized(&self) -> bool {
        self.wallpaper_consent_version >= WALLPAPER_CONSENT_VERSION
    }

    /// Legacy settings that already have every wallpaper-related switch off
    /// are safe and require no user decision. Advance only those settings to
    /// the current consent generation; any historical opt-in stays paused so
    /// the UI can ask whether it should be restored.
    fn normalize_safe_wallpaper_consent(&mut self) -> bool {
        if self.wallpaper_consent_version < WALLPAPER_CONSENT_VERSION
            && !self.wallpaper_desktop_enabled
            && !self.wallpaper_lockscreen_enabled
            && !self.wallpaper_dynamic_bg_enabled
            && !self.wallpaper_use_cloud
        {
            self.wallpaper_consent_version = WALLPAPER_CONSENT_VERSION;
            return true;
        }
        false
    }

    /// 两个旧 Claude 字段由总开关派生（U-107）：status line 与总开关一致，实验来源
    /// 只能在总开关打开时为真。读取额度的各处仍按旧字段判断，因此只需在这里收敛。
    fn normalize_claude_quota_toggles(&mut self) {
        self.quota_claude_statusline_enabled = self.quota_claude_enabled;
        self.quota_claude_codexbar_enabled &= self.quota_claude_enabled;
    }

    /// Clamp intervals to sane lower bounds so the scheduler can never busy-loop.
    pub fn sanitized(mut self) -> Self {
        self.normalize_claude_quota_toggles();
        // Run this before platform sanitization clears an unsupported
        // lock-screen switch so a historical Windows opt-in still requires a
        // decision when the same settings file is opened elsewhere.
        self.normalize_safe_wallpaper_consent();
        self.scan_interval_secs = self.scan_interval_secs.max(60);
        self.desktop_interval_secs = self.desktop_interval_secs.max(15);
        self.lockscreen_interval_secs = self.lockscreen_interval_secs.max(30);
        if !cfg!(target_os = "windows") {
            self.wallpaper_lockscreen_enabled = false;
        }
        self.tray_hover_delay_ms = self.tray_hover_delay_ms.min(TRAY_HOVER_DELAY_MAX_MS);
        // 挂件配置写进文件的是自由字符串（旧版本、手改文件、未来新增取值都可能出现）。
        // 渲染时再判断就得在四处各写一遍兜底，这里一次性收敛到闭合取值。
        self.widget_popover_layout = sanitize_enum(
            &self.widget_popover_layout,
            &WIDGET_LAYOUTS,
            DEFAULT_POPOVER_LAYOUT,
        );
        self.tray_text_metric = sanitize_enum(
            &self.tray_text_metric,
            &TRAY_TEXT_METRICS,
            TRAY_TEXT_METRICS[0],
        );
        self.widget_desktop_layout = sanitize_enum(
            &self.widget_desktop_layout,
            &WIDGET_LAYOUTS,
            WIDGET_LAYOUTS[0],
        );
        self.widget_popover_theme =
            sanitize_enum(&self.widget_popover_theme, &WIDGET_THEMES, WIDGET_THEMES[0]);
        self.widget_desktop_theme =
            sanitize_enum(&self.widget_desktop_theme, &WIDGET_THEMES, WIDGET_THEMES[0]);
        self.widget_popover_range =
            sanitize_enum(&self.widget_popover_range, &WIDGET_RANGES, WIDGET_RANGES[0]);
        self.widget_desktop_range =
            sanitize_enum(&self.widget_desktop_range, &WIDGET_RANGES, WIDGET_RANGES[0]);
        // 空串等价于"不钉住来源"，避免界面上出现一个永远匹配不到的空 id。
        self.widget_popover_provider = self
            .widget_popover_provider
            .take()
            .filter(|value| !value.trim().is_empty());
        self.widget_desktop_provider = self
            .widget_desktop_provider
            .take()
            .filter(|value| !value.trim().is_empty());
        // 订阅设置：不合法的条目丢弃并只记条数，从不改写成默认值（T10.188）。
        cost_model::sanitize_stored(&mut self);
        self
    }
}

fn settings_path(app: &AppContext) -> Result<PathBuf, String> {
    let app_dir = app.app_data_dir();
    fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
    Ok(app_dir.join(SETTINGS_FILE))
}

pub fn load_settings(app: &AppContext) -> AppSettings {
    let _guard = settings_file_lock();
    let (mut settings, claude_migrated) =
        load_settings_raw_with_migration_unlocked(app).unwrap_or_default();
    let mut should_persist = settings.normalize_safe_wallpaper_consent() || claude_migrated;
    if settings.scan_policy_version == 0 {
        // Version 0 covers every settings file written before T5.1c. Only the
        // historical 60-second default is migrated; deliberate custom values
        // remain untouched.
        if settings.scan_interval_secs == 60 {
            settings.scan_interval_secs = 900;
        }
        settings.scan_policy_version = 1;
        should_persist = true;
    }
    if settings.widget_panel_version < WIDGET_PANEL_VERSION {
        // 只替换旧默认值：用户主动选过的其他板式保持不动。
        if settings.widget_popover_layout == WIDGET_LAYOUTS[0] {
            settings.widget_popover_layout = DEFAULT_POPOVER_LAYOUT.to_string();
        }
        settings.widget_panel_version = WIDGET_PANEL_VERSION;
        should_persist = true;
    }
    settings = settings.sanitized();
    if should_persist {
        if let Err(error) =
            with_settings_cross_process_lock(app, || save_settings_file_unlocked(app, &settings))
        {
            log::warn!("failed to persist settings migration: {error}");
        }
    }
    settings
}

fn load_settings_result_unlocked(app: &AppContext) -> Result<AppSettings, String> {
    load_settings_raw_result_unlocked(app).map(AppSettings::sanitized)
}

fn load_settings_raw_result_unlocked(app: &AppContext) -> Result<AppSettings, String> {
    load_settings_raw_with_migration_unlocked(app).map(|(settings, _)| settings)
}

/// 第二个值表示这份文件是迁移前的旧格式，需要写回。
fn load_settings_raw_with_migration_unlocked(
    app: &AppContext,
) -> Result<(AppSettings, bool), String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok((AppSettings::default(), false));
    }
    let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    parse_settings_with_migration(&content)
}

/// 旧版本只有两个 Claude 开关，任一为真都表示用户授权过 Claude 额度读取。
pub(crate) fn migrate_legacy_claude_quota_toggle(
    statusline_enabled: bool,
    codexbar_enabled: bool,
) -> bool {
    statusline_enabled || codexbar_enabled
}

fn parse_settings_with_migration(content: &str) -> Result<(AppSettings, bool), String> {
    let value = serde_json::from_str::<serde_json::Value>(content).map_err(|e| e.to_string())?;
    let legacy_claude = value
        .as_object()
        .is_some_and(|object| !object.contains_key("quota_claude_enabled"));
    let mut settings =
        serde_json::from_value::<AppSettings>(value).map_err(|error| error.to_string())?;
    if legacy_claude {
        settings.quota_claude_enabled = migrate_legacy_claude_quota_toggle(
            settings.quota_claude_statusline_enabled,
            settings.quota_claude_codexbar_enabled,
        );
    }
    Ok((settings, legacy_claude))
}

pub(crate) fn load_settings_result(app: &AppContext) -> Result<AppSettings, String> {
    let _guard = settings_file_lock();
    load_settings_result_unlocked(app)
}

#[cfg(test)]
pub fn save_settings_file(app: &AppContext, settings: &AppSettings) -> Result<(), String> {
    with_settings_write_lock(app, || save_settings_file_unlocked(app, settings))
}

fn save_settings_file_unlocked(app: &AppContext, settings: &AppSettings) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    crate::quota::write_private_app_data_file(app.app_data_dir(), SETTINGS_FILE, content.as_bytes())
}

/// Atomically updates the quota sync opt-in from the authoritative on-disk
/// settings value while preserving every unrelated field.
pub(crate) fn update_quota_snapshot_sync_enabled(
    app: &AppContext,
    enabled: bool,
) -> Result<AppSettings, String> {
    with_settings_write_lock(app, || {
        let mut current = load_settings_result_unlocked(app)?;
        current.quota_snapshot_sync_enabled = enabled;
        save_settings_file_unlocked(app, &current)?;
        Ok(current)
    })
}

pub(crate) fn enable_quota_snapshot_sync(app: &AppContext) -> Result<AppSettings, String> {
    with_settings_write_lock(app, || {
        let mut current = load_settings_result_unlocked(app)?;
        // A read-only desktop is a supported sync participant: it may have no
        // local Provider authorization and still consume durable snapshots
        // published by another device.
        current.quota_snapshot_sync_enabled = true;
        save_settings_file_unlocked(app, &current)?;
        Ok(current)
    })
}

/// Replaces only the non-secret custom quota endpoint metadata while
/// preserving every independently coordinated setting field.
pub(crate) fn replace_custom_quota_endpoints(
    app: &AppContext,
    endpoints: Vec<CustomQuotaEndpointConfig>,
) -> Result<AppSettings, String> {
    with_settings_write_lock(app, || {
        let mut current = load_settings_result_unlocked(app)?;
        current.quota_custom_endpoints = endpoints;
        save_settings_file_unlocked(app, &current)?;
        Ok(current)
    })
}

/// 订阅设置（T10.188）的专用读改写，照 `replace_custom_quota_endpoints` 的做法：在设置
/// 写锁内读取磁盘上的权威设置交给 `decide`，revision 比对与校验都在锁内完成；`decide`
/// 给出新值时只替换四个 `cost_*` 字段，其余字段一律保留磁盘上的值，不给出时什么都不写。
/// 失败只报告发生在哪一步：底层错误原文可能引用设置文件内容，不往外传。
pub(crate) fn update_cost_profile<T>(
    app: &AppContext,
    decide: impl FnOnce(&AppSettings) -> (T, Option<cost_model::StoredCostProfile>),
) -> Result<(T, Option<AppSettings>), cost_model::StoreFailure> {
    let mut stage = cost_model::StoreFailure::Lock;
    let result = with_settings_write_lock(app, || {
        stage = cost_model::StoreFailure::Read;
        let mut current = load_settings_result_unlocked(app)?;
        let (outcome, next) = decide(&current);
        let written = match next {
            Some(next) => {
                next.store_into(&mut current);
                stage = cost_model::StoreFailure::Write;
                save_settings_file_unlocked(app, &current)?;
                Some(current)
            }
            None => None,
        };
        stage = cost_model::StoreFailure::Release;
        Ok((outcome, written))
    });
    result.map_err(|_| stage)
}

/// Persists the desktop-widget switch from Rust-side entry points (tray menu,
/// window close) while preserving every unrelated field (T10.110).
pub(crate) fn update_desktop_widget_enabled(
    app: &AppContext,
    enabled: bool,
) -> Result<AppSettings, String> {
    with_settings_write_lock(app, || {
        let mut current = load_settings_result_unlocked(app)?;
        current.desktop_widget_enabled = enabled;
        save_settings_file_unlocked(app, &current)?;
        Ok(current)
    })
}

/// 旧设置文件第一次被读到时决定模型接入开关（U-112）：`was_in_use` 为真（升级前已有
/// 启用的供应商或指向网关的 Agent）则保持开启，否则关闭；写回标记后不再重判。从没写过
/// 设置文件的旧安装同样要判断，新安装判断结果自然为假。`was_in_use` 在设置锁外执行。
pub(crate) fn migrate_model_access_once(
    app: &AppContext,
    loaded: AppSettings,
    was_in_use: impl FnOnce() -> bool,
) -> AppSettings {
    let file_exists = || settings_path(app).is_ok_and(|path| path.exists());
    if loaded.model_access_version >= MODEL_ACCESS_VERSION && file_exists() {
        return loaded;
    }
    let in_use = was_in_use();
    let result = with_settings_write_lock(app, || {
        let mut current = load_settings_result_unlocked(app)?;
        if current.model_access_version < MODEL_ACCESS_VERSION || !file_exists() {
            current.model_access_enabled = in_use;
            current.model_access_version = MODEL_ACCESS_VERSION;
            save_settings_file_unlocked(app, &current)?;
        }
        Ok(current)
    });
    result.unwrap_or_else(|error| {
        log::warn!("failed to persist model access migration: {error}");
        AppSettings {
            model_access_enabled: in_use,
            ..loaded
        }
    })
}

/// 模型接入总开关的专用读改写：只改这一项，其余字段保留磁盘上的值。
pub(crate) fn update_model_access_enabled(
    app: &AppContext,
    enabled: bool,
) -> Result<AppSettings, String> {
    with_settings_write_lock(app, || {
        let mut current = load_settings_result_unlocked(app)?;
        current.model_access_enabled = enabled;
        current.model_access_version = MODEL_ACCESS_VERSION;
        save_settings_file_unlocked(app, &current)?;
        Ok(current)
    })
}

/// 托盘面板快捷开关里的两项后台暂停：只改这一项，其余字段保留磁盘上的值。
pub(crate) fn update_background_pause(
    app: &AppContext,
    target: BackgroundPause,
    paused: bool,
) -> Result<AppSettings, String> {
    with_settings_write_lock(app, || {
        let mut current = load_settings_result_unlocked(app)?;
        match target {
            BackgroundPause::Scan => current.background_scan_paused = paused,
            BackgroundPause::Sync => current.background_sync_paused = paused,
        }
        save_settings_file_unlocked(app, &current)?;
        Ok(current)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackgroundPause {
    Scan,
    Sync,
}

/// Remembers where the user dragged the desktop widget (physical pixels).
pub(crate) fn update_desktop_widget_position(
    app: &AppContext,
    position: Option<(i32, i32)>,
) -> Result<AppSettings, String> {
    with_settings_write_lock(app, || {
        let mut current = load_settings_result_unlocked(app)?;
        current.desktop_widget_position = position;
        save_settings_file_unlocked(app, &current)?;
        Ok(current)
    })
}

/// Persists a general settings edit without allowing a stale managed-state
/// copy to overwrite the independently coordinated quota sync opt-in.
pub(crate) fn save_general_settings_preserving_quota_sync(
    app: &AppContext,
    previous: &AppSettings,
    incoming: AppSettings,
) -> Result<AppSettings, String> {
    with_settings_write_lock(app, || {
        let mut next = load_settings_result_unlocked(app)?;
        let previous = previous.clone().sanitized();
        let incoming = incoming.sanitized();

        macro_rules! merge_changed_field {
            ($field:ident) => {
                if incoming.$field != previous.$field {
                    next.$field = incoming.$field.clone();
                }
            };
        }

        merge_changed_field!(scan_interval_secs);
        merge_changed_field!(desktop_interval_secs);
        merge_changed_field!(lockscreen_interval_secs);
        merge_changed_field!(wallpaper_desktop_enabled);
        merge_changed_field!(wallpaper_lockscreen_enabled);
        merge_changed_field!(wallpaper_consent_version);
        merge_changed_field!(autostart_enabled);
        merge_changed_field!(start_minimized);
        merge_changed_field!(widget_open_at_startup);
        merge_changed_field!(tray_text_enabled);
        merge_changed_field!(widget_open_at_startup);
        merge_changed_field!(tray_text_enabled);
        merge_changed_field!(tray_text_metric);
        merge_changed_field!(tray_hover_widget_enabled);
        merge_changed_field!(tray_hover_delay_ms);
        merge_changed_field!(desktop_widget_enabled);
        merge_changed_field!(routing_publish_enabled);
        merge_changed_field!(desktop_widget_position);
        merge_changed_field!(widget_popover_layout);
        merge_changed_field!(widget_popover_theme);
        merge_changed_field!(widget_popover_range);
        merge_changed_field!(widget_popover_provider);
        merge_changed_field!(widget_desktop_layout);
        merge_changed_field!(widget_desktop_theme);
        merge_changed_field!(widget_desktop_range);
        merge_changed_field!(widget_desktop_provider);
        merge_changed_field!(wallpaper_use_cloud);
        merge_changed_field!(wallpaper_device_filter);
        merge_changed_field!(wallpaper_dynamic_bg_enabled);
        merge_changed_field!(quota_codex_local_enabled);
        merge_changed_field!(quota_claude_enabled);
        merge_changed_field!(quota_claude_statusline_enabled);
        merge_changed_field!(quota_claude_codexbar_enabled);
        merge_changed_field!(quota_antigravity_local_enabled);
        merge_changed_field!(quota_antigravity_codexbar_enabled);
        // 合并后再收敛一次：另一进程刚关掉总开关时，陈旧的实验来源改动不能单独生效。
        next.normalize_claude_quota_toggles();
        // quota_custom_endpoints is intentionally never accepted through the
        // broad settings save. Dedicated commands coordinate metadata with
        // the operating-system credential store without exposing secrets.
        // quota_snapshot_sync_enabled is intentionally never merged here. It
        // remains owned by its dedicated coordinated command.
        // The cost_* subscription profile fields (T10.188) are never merged here
        // either: only `save_cost_profile` writes them, conditioned on revision.
        // model_access_* likewise belong to `update_model_access_enabled`.
        save_settings_file_unlocked(app, &next)?;
        Ok(next)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_hover_delay_is_clamped_to_a_usable_range() {
        // 手改过的设置文件可能写出任意数字；超过上限就不像"悬停查看"而像没反应。
        let mut settings = AppSettings {
            tray_hover_delay_ms: 99_999,
            ..AppSettings::default()
        };
        settings = settings.sanitized();
        assert_eq!(settings.tray_hover_delay_ms, TRAY_HOVER_DELAY_MAX_MS);
        // 0 是合法值：它表示恢复旧的"立即弹出"。
        let zero = AppSettings {
            tray_hover_delay_ms: 0,
            ..AppSettings::default()
        }
        .sanitized();
        assert_eq!(zero.tray_hover_delay_ms, 0);
        // 默认值与 widget_window 的常量同源，两边不会各写一个数字。
        assert_eq!(
            AppSettings::default().tray_hover_delay_ms,
            DEFAULT_TRAY_HOVER_DELAY_MS
        );
    }
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const SETTINGS_LOCK_WORKER_ROOT: &str = "TOKENLEDGER_SETTINGS_LOCK_WORKER_ROOT";
    const SETTINGS_LOCK_WORKER_ROLE: &str = "TOKENLEDGER_SETTINGS_LOCK_WORKER_ROLE";

    fn test_app_context(label: &str) -> AppContext {
        let directory = std::env::temp_dir().join(format!(
            "tokenledger-settings-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock")
                .as_nanos()
        ));
        AppContext::for_test(directory)
    }

    fn wait_for_path(path: &Path, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while !path.exists() {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn settings_cross_process_lock_worker() {
        let Ok(root) = std::env::var(SETTINGS_LOCK_WORKER_ROOT) else {
            return;
        };
        let role = std::env::var(SETTINGS_LOCK_WORKER_ROLE).expect("worker role");
        let root = PathBuf::from(root);
        fs::create_dir_all(&root).expect("worker root");
        fs::write(root.join(format!("{role}.started")), b"started").expect("worker started");
        let app = AppContext::for_test(root.clone());
        with_settings_cross_process_lock(&app, || {
            fs::write(root.join(format!("{role}.entered")), b"entered")
                .map_err(|error| error.to_string())?;
            if role == "holder" {
                wait_for_path(&root.join("release"), Duration::from_secs(5));
            }
            Ok(())
        })
        .expect("cross-process settings lock");
    }

    #[test]
    fn settings_stale_provider_delta_worker() {
        let Ok(root) = std::env::var(SETTINGS_LOCK_WORKER_ROOT) else {
            return;
        };
        let role = std::env::var(SETTINGS_LOCK_WORKER_ROLE).expect("worker role");
        let root = PathBuf::from(root);
        let app = AppContext::for_test(root.clone());
        let previous = load_settings_result(&app).expect("worker previous settings");
        fs::write(root.join(format!("{role}.loaded")), b"loaded").expect("worker loaded");
        wait_for_path(
            &root.join(format!("release-{role}")),
            Duration::from_secs(5),
        );
        let mut incoming = previous.clone();
        if role == "revoker" {
            incoming.quota_codex_local_enabled = false;
            incoming.quota_claude_enabled = false;
            incoming.quota_claude_statusline_enabled = false;
            incoming.quota_claude_codexbar_enabled = false;
            incoming.quota_antigravity_local_enabled = false;
            incoming.quota_antigravity_codexbar_enabled = false;
        } else {
            incoming.desktop_interval_secs = 123;
        }
        save_general_settings_preserving_quota_sync(&app, &previous, incoming)
            .expect("worker delta merge");
    }

    #[test]
    fn settings_rmw_lock_serializes_distinct_processes() {
        let app = test_app_context("cross-process-lock");
        fs::create_dir_all(app.app_data_dir()).expect("app data");
        let executable = std::env::current_exe().expect("current test executable");
        let spawn_worker = |role: &str| {
            Command::new(&executable)
                .args([
                    "--exact",
                    "settings::tests::settings_cross_process_lock_worker",
                    "--nocapture",
                ])
                .env(SETTINGS_LOCK_WORKER_ROOT, app.app_data_dir())
                .env(SETTINGS_LOCK_WORKER_ROLE, role)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn settings lock worker")
        };

        let mut holder = spawn_worker("holder");
        wait_for_path(
            &app.app_data_dir().join("holder.entered"),
            Duration::from_secs(5),
        );
        let mut waiter = spawn_worker("waiter");
        wait_for_path(
            &app.app_data_dir().join("waiter.started"),
            Duration::from_secs(5),
        );
        std::thread::sleep(Duration::from_millis(100));
        assert!(!app.app_data_dir().join("waiter.entered").exists());

        fs::write(app.app_data_dir().join("release"), b"release").expect("release holder");
        assert!(holder.wait().expect("holder status").success());
        assert!(waiter.wait().expect("waiter status").success());
        assert!(app.app_data_dir().join("waiter.entered").exists());
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    #[test]
    fn stale_second_process_cannot_restore_revoked_providers() {
        let app = test_app_context("cross-process-provider-delta");
        let original = AppSettings {
            quota_codex_local_enabled: true,
            quota_claude_enabled: true,
            quota_claude_statusline_enabled: true,
            quota_claude_codexbar_enabled: true,
            quota_antigravity_local_enabled: true,
            quota_antigravity_codexbar_enabled: true,
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        };
        save_settings_file(&app, &original).expect("save original settings");
        let executable = std::env::current_exe().expect("current test executable");
        let spawn_worker = |role: &str| {
            Command::new(&executable)
                .args([
                    "--exact",
                    "settings::tests::settings_stale_provider_delta_worker",
                    "--nocapture",
                ])
                .env(SETTINGS_LOCK_WORKER_ROOT, app.app_data_dir())
                .env(SETTINGS_LOCK_WORKER_ROLE, role)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn settings delta worker")
        };

        let mut revoker = spawn_worker("revoker");
        let mut stale = spawn_worker("stale");
        wait_for_path(
            &app.app_data_dir().join("revoker.loaded"),
            Duration::from_secs(5),
        );
        wait_for_path(
            &app.app_data_dir().join("stale.loaded"),
            Duration::from_secs(5),
        );
        fs::write(app.app_data_dir().join("release-revoker"), b"release").expect("release revoker");
        assert!(revoker.wait().expect("revoker status").success());
        fs::write(app.app_data_dir().join("release-stale"), b"release")
            .expect("release stale worker");
        assert!(stale.wait().expect("stale status").success());

        let merged = load_settings_result(&app).expect("merged settings");
        assert_eq!(merged.desktop_interval_secs, 123);
        assert!(!merged.quota_codex_local_enabled);
        assert!(!merged.quota_claude_statusline_enabled);
        assert!(!merged.quota_claude_codexbar_enabled);
        assert!(!merged.quota_antigravity_local_enabled);
        assert!(!merged.quota_antigravity_codexbar_enabled);
        assert!(merged.quota_snapshot_sync_enabled);
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    #[test]
    fn legacy_true_lockscreen_setting_is_disabled_outside_windows() {
        let legacy = AppSettings {
            wallpaper_lockscreen_enabled: true,
            ..Default::default()
        };

        assert_eq!(
            legacy.sanitized().wallpaper_lockscreen_enabled,
            cfg!(target_os = "windows")
        );
    }

    #[test]
    fn clean_install_defaults_never_enable_wallpaper_automation() {
        let settings = AppSettings::default();
        assert_eq!(
            settings.wallpaper_consent_version,
            WALLPAPER_CONSENT_VERSION
        );
        assert!(!settings.wallpaper_desktop_enabled);
        assert!(!settings.wallpaper_lockscreen_enabled);
        assert!(!settings.wallpaper_dynamic_bg_enabled);
        assert!(settings.wallpaper_automation_authorized());
    }

    #[test]
    fn legacy_settings_preserve_choices_but_are_not_authorized() {
        let legacy = serde_json::json!({
            "scan_interval_secs": 900,
            "desktop_interval_secs": 60,
            "lockscreen_interval_secs": 300,
            "wallpaper_desktop_enabled": true,
            "wallpaper_lockscreen_enabled": false,
            "autostart_enabled": false,
            "start_minimized": false,
            "wallpaper_use_cloud": true,
            "wallpaper_dynamic_bg_enabled": true
        });

        let parsed: AppSettings = serde_json::from_value(legacy).expect("parse legacy settings");
        assert_eq!(parsed.wallpaper_consent_version, 0);
        assert!(parsed.wallpaper_desktop_enabled);
        assert!(parsed.wallpaper_dynamic_bg_enabled);
        assert!(!parsed.wallpaper_automation_authorized());
    }

    #[test]
    fn safe_legacy_wallpaper_settings_normalize_without_confirmation() {
        let app = test_app_context("safe-wallpaper-consent-migration");
        fs::create_dir_all(app.app_data_dir()).expect("create settings directory");
        let legacy = serde_json::json!({
            "scan_interval_secs": 900,
            "scan_policy_version": 1,
            "desktop_interval_secs": 60,
            "lockscreen_interval_secs": 300,
            "wallpaper_desktop_enabled": false,
            "wallpaper_lockscreen_enabled": false,
            "autostart_enabled": false,
            "start_minimized": false,
            "wallpaper_use_cloud": false,
            "wallpaper_dynamic_bg_enabled": false
        });
        fs::write(
            app.app_data_dir().join(SETTINGS_FILE),
            serde_json::to_vec_pretty(&legacy).expect("serialize legacy settings"),
        )
        .expect("write legacy settings");

        let migrated = load_settings(&app);
        assert_eq!(
            migrated.wallpaper_consent_version,
            WALLPAPER_CONSENT_VERSION
        );
        assert!(!migrated.wallpaper_desktop_enabled);
        assert!(!migrated.wallpaper_lockscreen_enabled);
        assert!(!migrated.wallpaper_dynamic_bg_enabled);
        assert!(!migrated.wallpaper_use_cloud);
        let persisted: serde_json::Value = serde_json::from_slice(
            &fs::read(app.app_data_dir().join(SETTINGS_FILE))
                .expect("read migrated wallpaper settings"),
        )
        .expect("parse migrated wallpaper settings");
        assert_eq!(
            persisted["wallpaper_consent_version"],
            WALLPAPER_CONSENT_VERSION
        );
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    #[test]
    fn every_historical_wallpaper_opt_in_still_requires_confirmation() {
        for field in [
            "wallpaper_desktop_enabled",
            "wallpaper_lockscreen_enabled",
            "wallpaper_dynamic_bg_enabled",
            "wallpaper_use_cloud",
        ] {
            let mut legacy = serde_json::json!({
                "scan_interval_secs": 900,
                "desktop_interval_secs": 60,
                "lockscreen_interval_secs": 300,
                "wallpaper_desktop_enabled": false,
                "wallpaper_lockscreen_enabled": false,
                "autostart_enabled": false,
                "start_minimized": false,
                "wallpaper_use_cloud": false,
                "wallpaper_dynamic_bg_enabled": false
            });
            legacy[field] = serde_json::json!(true);

            let parsed: AppSettings =
                serde_json::from_value(legacy).expect("parse historical wallpaper setting");
            assert_eq!(
                parsed.sanitized().wallpaper_consent_version,
                0,
                "{field} must remain pending"
            );
        }
    }

    #[test]
    fn legacy_settings_default_new_quota_opt_ins_to_disabled() {
        let legacy = serde_json::json!({
            "scan_interval_secs": 60,
            "desktop_interval_secs": 60,
            "lockscreen_interval_secs": 300,
            "wallpaper_desktop_enabled": true,
            "wallpaper_lockscreen_enabled": false,
            "autostart_enabled": false,
            "start_minimized": false,
            "wallpaper_use_cloud": false
        });

        let parsed: AppSettings = serde_json::from_value(legacy).expect("parse legacy settings");
        assert!(!parsed.quota_codex_local_enabled);
        assert!(!parsed.quota_claude_statusline_enabled);
        assert!(!parsed.quota_claude_codexbar_enabled);
        assert!(!parsed.quota_antigravity_local_enabled);
        assert!(!parsed.quota_antigravity_codexbar_enabled);
        assert!(parsed.quota_custom_endpoints.is_empty());
        assert!(!parsed.quota_snapshot_sync_enabled);
    }

    #[test]
    fn old_default_popover_layout_moves_to_the_tray_panel_once() {
        let legacy = |label: &str, layout: &str| {
            let app = test_app_context(label);
            fs::create_dir_all(app.app_data_dir()).expect("create settings directory");
            let value = serde_json::json!({
                "scan_interval_secs": 900,
                "scan_policy_version": 1,
                "desktop_interval_secs": 60,
                "lockscreen_interval_secs": 300,
                "wallpaper_desktop_enabled": false,
                "wallpaper_lockscreen_enabled": false,
                "autostart_enabled": false,
                "start_minimized": false,
                "wallpaper_use_cloud": false,
                "widget_popover_layout": layout,
                "widget_desktop_layout": "usage"
            });
            fs::write(
                app.app_data_dir().join(SETTINGS_FILE),
                serde_json::to_vec_pretty(&value).expect("serialize legacy settings"),
            )
            .expect("write legacy settings");
            app
        };
        let app = legacy("panel-migration-default", "usage");
        let migrated = load_settings(&app);
        assert_eq!(migrated.widget_popover_layout, "panel");
        // 桌面小组件不跟着换；新字段取默认值。
        assert_eq!(migrated.widget_desktop_layout, "usage");
        assert_eq!(migrated.tray_text_metric, "cost");
        assert!(!migrated.background_scan_paused && !migrated.background_sync_paused);
        // 迁移只做一次：之后用户再选回「用量详情」要保留。
        let mut chosen = migrated.clone();
        chosen.widget_popover_layout = "usage".to_string();
        save_settings_file_unlocked(&app, &chosen).expect("save chosen layout");
        assert_eq!(load_settings(&app).widget_popover_layout, "usage");
        let _ = fs::remove_dir_all(app.app_data_dir());

        let app = legacy("panel-migration-custom", "routing");
        assert_eq!(load_settings(&app).widget_popover_layout, "routing");
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    #[test]
    fn background_pauses_and_tray_metric_only_change_through_their_own_paths() {
        let app = test_app_context("background-pause");
        let saved = update_background_pause(&app, BackgroundPause::Scan, true).expect("pause scan");
        assert!(saved.background_scan_paused && !saved.background_sync_paused);
        let saved = update_background_pause(&app, BackgroundPause::Sync, true).expect("pause sync");
        assert!(saved.background_scan_paused && saved.background_sync_paused);

        // 通用保存带着陈旧的「未暂停」也不能把暂停改回去；托盘数字的取值则照常合并。
        let previous = AppSettings::default();
        let mut incoming = previous.clone();
        incoming.tray_text_metric = "quota".to_string();
        let merged = save_general_settings_preserving_quota_sync(&app, &previous, incoming)
            .expect("general save");
        assert!(merged.background_scan_paused && merged.background_sync_paused);
        assert_eq!(merged.tray_text_metric, "quota");

        let unknown = AppSettings {
            tray_text_metric: "tokens".to_string(),
            widget_popover_layout: "future".to_string(),
            ..AppSettings::default()
        }
        .sanitized();
        assert_eq!(unknown.tray_text_metric, "cost");
        assert_eq!(unknown.widget_popover_layout, "panel");
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    #[test]
    fn legacy_sixty_second_default_migrates_once_to_fifteen_minutes() {
        let app = test_app_context("scan-policy-migration");
        fs::create_dir_all(app.app_data_dir()).expect("create settings directory");
        let legacy = serde_json::json!({
            "scan_interval_secs": 60,
            "desktop_interval_secs": 60,
            "lockscreen_interval_secs": 300,
            "wallpaper_desktop_enabled": false,
            "wallpaper_lockscreen_enabled": false,
            "autostart_enabled": false,
            "start_minimized": false,
            "wallpaper_use_cloud": false
        });
        fs::write(
            app.app_data_dir().join(SETTINGS_FILE),
            serde_json::to_vec_pretty(&legacy).expect("serialize legacy settings"),
        )
        .expect("write legacy settings");

        let migrated = load_settings(&app);
        assert_eq!(migrated.scan_interval_secs, 900);
        assert_eq!(migrated.scan_policy_version, 1);
        let persisted: serde_json::Value = serde_json::from_slice(
            &fs::read(app.app_data_dir().join(SETTINGS_FILE)).expect("read migrated settings"),
        )
        .expect("parse migrated settings");
        assert_eq!(persisted["scan_interval_secs"], 900);
        assert_eq!(persisted["scan_policy_version"], 1);

        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    fn write_legacy_settings(app: &AppContext) {
        fs::create_dir_all(app.app_data_dir()).expect("create settings directory");
        let legacy = serde_json::json!({
            "scan_interval_secs": 900,
            "scan_policy_version": 1,
            "desktop_interval_secs": 60,
            "lockscreen_interval_secs": 300,
            "wallpaper_desktop_enabled": false,
            "wallpaper_lockscreen_enabled": false,
            "autostart_enabled": false,
            "start_minimized": false,
            "wallpaper_use_cloud": false
        });
        fs::write(
            app.app_data_dir().join(SETTINGS_FILE),
            serde_json::to_vec_pretty(&legacy).expect("serialize legacy settings"),
        )
        .expect("write legacy settings");
    }

    #[test]
    fn model_access_migrates_once_from_previous_gateway_use() {
        for in_use in [false, true] {
            let app = test_app_context("model-access-migration");
            write_legacy_settings(&app);
            let loaded = load_settings(&app);
            assert_eq!(loaded.model_access_version, 0);

            let migrated = migrate_model_access_once(&app, loaded, || in_use);
            assert_eq!(migrated.model_access_enabled, in_use);
            assert_eq!(migrated.model_access_version, MODEL_ACCESS_VERSION);
            let persisted = load_settings(&app);
            assert_eq!(persisted.model_access_enabled, in_use);
            assert_eq!(persisted.model_access_version, MODEL_ACCESS_VERSION);

            // 标记写回后不再判断，用户之后的选择不会被升级规则改回去。
            let again = migrate_model_access_once(&app, persisted, || !in_use);
            assert_eq!(again.model_access_enabled, in_use);
            let _ = fs::remove_dir_all(app.app_data_dir());
        }
    }

    #[test]
    fn model_access_defaults_off_for_new_installs_but_not_for_fileless_users() {
        let fresh = test_app_context("model-access-fresh");
        let settings = migrate_model_access_once(&fresh, load_settings(&fresh), || false);
        assert!(!settings.model_access_enabled);
        assert!(fresh.app_data_dir().join(SETTINGS_FILE).exists());
        let _ = fs::remove_dir_all(fresh.app_data_dir());

        // 从没写过设置文件、却已经配过网关的旧安装，升级后保持开启。
        let fileless = test_app_context("model-access-fileless");
        let settings = migrate_model_access_once(&fileless, load_settings(&fileless), || true);
        assert!(settings.model_access_enabled);
        assert!(load_settings(&fileless).model_access_enabled);
        let _ = fs::remove_dir_all(fileless.app_data_dir());
    }

    #[test]
    fn model_access_is_only_written_by_its_dedicated_update() {
        let app = test_app_context("model-access-update");
        save_settings_file(&app, &AppSettings::default()).expect("save defaults");
        let previous = load_settings(&app);
        let enabled = update_model_access_enabled(&app, true).expect("enable model access");
        assert!(enabled.model_access_enabled);

        // 通用保存既不能打开它，也不能把已打开的开关改回去。
        let flipped = AppSettings {
            desktop_interval_secs: 123,
            model_access_enabled: true,
            ..previous.clone()
        };
        let disabled = update_model_access_enabled(&app, false).expect("disable model access");
        assert!(!disabled.model_access_enabled);
        let merged = save_general_settings_preserving_quota_sync(&app, &previous, flipped)
            .expect("general save");
        assert_eq!(merged.desktop_interval_secs, 123);
        assert!(!merged.model_access_enabled);
        assert!(!load_settings(&app).model_access_enabled);
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    #[test]
    fn settings_are_atomically_replaced_as_private_data() {
        let app = test_app_context("atomic-private");
        let settings = AppSettings {
            quota_codex_local_enabled: true,
            quota_claude_enabled: true,
            quota_claude_statusline_enabled: true,
            quota_claude_codexbar_enabled: true,
            quota_antigravity_local_enabled: true,
            quota_antigravity_codexbar_enabled: true,
            ..Default::default()
        };

        save_settings_file(&app, &settings).expect("save settings");
        let loaded = load_settings(&app);
        assert!(loaded.quota_codex_local_enabled);
        assert!(loaded.quota_claude_statusline_enabled);
        assert!(loaded.quota_claude_codexbar_enabled);
        assert!(loaded.quota_antigravity_local_enabled);
        assert!(loaded.quota_antigravity_codexbar_enabled);

        #[cfg(unix)]
        let path = app.app_data_dir().join(SETTINGS_FILE);
        let lock_path = app.app_data_dir().join(SETTINGS_LOCK_FILE);
        let lock_metadata = fs::symlink_metadata(&lock_path).expect("settings lock metadata");
        assert!(lock_metadata.is_file());
        assert!(!lock_metadata.file_type().is_symlink());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path)
                    .expect("settings metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(lock_metadata.permissions().mode() & 0o777, 0o600);
        }

        let mut entries = fs::read_dir(app.app_data_dir())
            .expect("read app data")
            .map(|entry| entry.expect("directory entry").file_name())
            .collect::<Vec<_>>();
        entries.sort();
        assert_eq!(
            entries,
            vec![
                std::ffi::OsString::from(SETTINGS_FILE),
                std::ffi::OsString::from(SETTINGS_LOCK_FILE)
            ]
        );
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    #[test]
    fn quota_field_update_preserves_authoritative_unrelated_fields() {
        let app = test_app_context("quota-field-rmw");
        let authoritative = AppSettings {
            scan_interval_secs: 111,
            quota_codex_local_enabled: true,
            quota_snapshot_sync_enabled: true,
            ..Default::default()
        };
        save_settings_file(&app, &authoritative).expect("save authoritative settings");

        let updated =
            update_quota_snapshot_sync_enabled(&app, false).expect("field-level quota update");
        assert_eq!(updated.scan_interval_secs, 111);
        assert!(updated.quota_codex_local_enabled);
        assert!(!updated.quota_snapshot_sync_enabled);
        assert_eq!(load_settings(&app).scan_interval_secs, 111);
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    #[test]
    fn general_save_cannot_restore_stale_quota_sync_true() {
        let app = test_app_context("general-preserves-quota");
        let authoritative = AppSettings {
            quota_snapshot_sync_enabled: false,
            quota_custom_endpoints: vec![CustomQuotaEndpointConfig {
                id: "0123456789abcdef01234567".to_string(),
                display_name: "研发账号额度".to_string(),
                url: "https://gateway.example.com/v1/me/quota".to_string(),
                enabled: true,
                api_key_configured: None,
            }],
            ..Default::default()
        };
        save_settings_file(&app, &authoritative).expect("save fail-closed state");

        let mut stale_incoming = authoritative.clone();
        stale_incoming.scan_interval_secs = 123;
        stale_incoming.quota_snapshot_sync_enabled = true;
        stale_incoming.quota_custom_endpoints.clear();
        let persisted =
            save_general_settings_preserving_quota_sync(&app, &authoritative, stale_incoming)
                .expect("save general settings");
        assert_eq!(persisted.scan_interval_secs, 123);
        assert!(!persisted.quota_snapshot_sync_enabled);
        assert_eq!(persisted.quota_custom_endpoints.len(), 1);
        assert!(!load_settings(&app).quota_snapshot_sync_enabled);
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    #[test]
    fn stale_general_save_cannot_restore_revoked_provider_authorization() {
        let app = test_app_context("provider-delta-merge");
        let original = AppSettings {
            quota_codex_local_enabled: true,
            quota_claude_enabled: true,
            quota_claude_statusline_enabled: true,
            quota_claude_codexbar_enabled: true,
            quota_antigravity_local_enabled: true,
            quota_antigravity_codexbar_enabled: true,
            quota_snapshot_sync_enabled: true,
            ..AppSettings::default()
        };
        save_settings_file(&app, &original).expect("save original settings");

        let revoked = AppSettings {
            quota_codex_local_enabled: false,
            quota_claude_enabled: false,
            quota_claude_statusline_enabled: false,
            quota_claude_codexbar_enabled: false,
            quota_antigravity_local_enabled: false,
            quota_antigravity_codexbar_enabled: false,
            ..original.clone()
        };
        let revoked = save_general_settings_preserving_quota_sync(&app, &original, revoked)
            .expect("revoke providers");
        assert!(!revoked.quota_codex_local_enabled);
        assert!(!revoked.quota_claude_statusline_enabled);
        assert!(!revoked.quota_claude_codexbar_enabled);
        assert!(!revoked.quota_antigravity_local_enabled);
        assert!(!revoked.quota_antigravity_codexbar_enabled);

        let stale_wallpaper_edit = AppSettings {
            desktop_interval_secs: 123,
            ..original.clone()
        };
        let merged =
            save_general_settings_preserving_quota_sync(&app, &original, stale_wallpaper_edit)
                .expect("merge stale unrelated edit");
        assert_eq!(merged.desktop_interval_secs, 123);
        assert!(!merged.quota_codex_local_enabled);
        assert!(!merged.quota_claude_statusline_enabled);
        assert!(!merged.quota_claude_codexbar_enabled);
        assert!(!merged.quota_antigravity_local_enabled);
        assert!(!merged.quota_antigravity_codexbar_enabled);
        assert!(merged.quota_snapshot_sync_enabled);
        let _ = fs::remove_dir_all(app.app_data_dir());
    }

    /// quota_sync 判断「Claude 授权是否被撤销」的同一谓词；迁移前后必须一致，
    /// 否则升级会被当成撤权，提升同步授权代次并清掉 LKG。
    fn claude_authorized(settings: &AppSettings) -> bool {
        settings.quota_claude_statusline_enabled || settings.quota_claude_codexbar_enabled
    }

    #[test]
    fn legacy_claude_toggles_migrate_to_one_equivalent_switch() {
        for (statusline, codexbar) in [(false, false), (true, false), (false, true), (true, true)] {
            let app = test_app_context("claude-toggle-migration");
            fs::create_dir_all(app.app_data_dir()).expect("create settings directory");
            let legacy = serde_json::json!({
                "scan_interval_secs": 900,
                "scan_policy_version": 1,
                "desktop_interval_secs": 60,
                "lockscreen_interval_secs": 300,
                "wallpaper_desktop_enabled": false,
                "wallpaper_lockscreen_enabled": false,
                "autostart_enabled": false,
                "start_minimized": false,
                "wallpaper_use_cloud": false,
                "quota_claude_statusline_enabled": statusline,
                "quota_claude_codexbar_enabled": codexbar
            });
            let legacy_settings: AppSettings =
                serde_json::from_value(legacy.clone()).expect("parse legacy settings");
            fs::write(
                app.app_data_dir().join(SETTINGS_FILE),
                serde_json::to_vec_pretty(&legacy).expect("serialize legacy settings"),
            )
            .expect("write legacy settings");

            let migrated = load_settings(&app);
            let label = format!("statusline={statusline} codexbar={codexbar}");
            assert_eq!(
                migrated.quota_claude_enabled,
                statusline || codexbar,
                "{label}"
            );
            // 用户显式开过实验来源才保留，迁移不会替任何人打开它。
            assert_eq!(migrated.quota_claude_codexbar_enabled, codexbar, "{label}");
            assert_eq!(
                claude_authorized(&migrated),
                claude_authorized(&legacy_settings),
                "{label}"
            );

            let persisted: serde_json::Value = serde_json::from_slice(
                &fs::read(app.app_data_dir().join(SETTINGS_FILE)).expect("read migrated settings"),
            )
            .expect("parse migrated settings");
            assert_eq!(
                persisted["quota_claude_enabled"],
                statusline || codexbar,
                "{label}"
            );
            // 写回后再读不会重复迁移，也不会改变结果。
            assert_eq!(
                serde_json::to_value(load_settings(&app)).expect("reload"),
                serde_json::to_value(&migrated).expect("migrated"),
                "{label}"
            );
            let _ = fs::remove_dir_all(app.app_data_dir());
        }
    }

    #[test]
    fn explicit_claude_switch_wins_over_legacy_fields() {
        let (parsed, migrated) = parse_settings_with_migration(
            r#"{"scan_interval_secs":900,"desktop_interval_secs":60,"lockscreen_interval_secs":300,
                "wallpaper_desktop_enabled":false,"wallpaper_lockscreen_enabled":false,
                "autostart_enabled":false,"start_minimized":false,"wallpaper_use_cloud":false,
                "quota_claude_enabled":false,
                "quota_claude_statusline_enabled":true,"quota_claude_codexbar_enabled":true}"#,
        )
        .expect("parse settings");
        assert!(!migrated);
        let sanitized = parsed.sanitized();
        assert!(!sanitized.quota_claude_enabled);
        assert!(!sanitized.quota_claude_statusline_enabled);
        assert!(!sanitized.quota_claude_codexbar_enabled);
    }

    #[test]
    fn experimental_claude_source_only_participates_under_the_main_switch() {
        let app = test_app_context("claude-toggle-merge");
        let original = AppSettings {
            quota_claude_enabled: true,
            ..AppSettings::default()
        }
        .sanitized();
        save_settings_file(&app, &original).expect("save original settings");
        assert!(original.quota_claude_statusline_enabled);

        let advanced = AppSettings {
            quota_claude_codexbar_enabled: true,
            ..original.clone()
        };
        let saved = save_general_settings_preserving_quota_sync(&app, &original, advanced)
            .expect("enable advanced source");
        assert!(saved.quota_claude_codexbar_enabled);

        let off = AppSettings {
            quota_claude_enabled: false,
            ..saved.clone()
        };
        let saved = save_general_settings_preserving_quota_sync(&app, &saved, off)
            .expect("disable main switch");
        assert!(!saved.quota_claude_statusline_enabled);
        assert!(!saved.quota_claude_codexbar_enabled);

        // 主开关已关时，单独打开实验来源不生效。
        let stale = AppSettings {
            quota_claude_codexbar_enabled: true,
            ..original.clone()
        };
        let merged = save_general_settings_preserving_quota_sync(&app, &original, stale)
            .expect("stale advanced edit");
        assert!(!merged.quota_claude_enabled);
        assert!(!merged.quota_claude_codexbar_enabled);
        let _ = fs::remove_dir_all(app.app_data_dir());
    }
}
