// objc 0.2's msg_send! macro still probes the removed `cargo-clippy` cfg.
// This macOS-only compatibility exception can go when that dependency is retired.
#![cfg_attr(target_os = "macos", allow(unexpected_cfgs))]

// TokenLedger — Tauri 2 + React main entry point.
//
// Migration note (2026-06-07): the binary used to be launched via
// `eframe::run_native` in this same function, with the eframe UI living
// in `ui.rs` (now removed). The React frontend in `src/App.tsx` was
// previously dead code because no Tauri runtime was ever started. The
// Tauri 2 builder below makes the React UI canonical and removes the
// eframe dependency from the build.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

use app_paths::AppContext;
use settings::AppSettings;

mod app_paths;
mod cache;
mod commands;
mod cost_profile;
mod db;
mod gateway;
mod models_dev;
mod project_index;
mod quota;
pub use quota::run_claude_statusline_helper;
mod macos_wallpaper_window;
mod peer_live;
mod peer_sync;
mod peer_wire;
mod quota_sync;
mod scanner;
mod session_analysis;
mod settings;
mod stats_query;
mod wallpaper;
mod widget_window;

struct TrayWindowState {
    hide_generation: AtomicU64,
}

impl TrayWindowState {
    fn new() -> Self {
        Self {
            hide_generation: AtomicU64::new(0),
        }
    }

    fn begin_hide(&self) -> u64 {
        self.hide_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn cancel_pending_hide(&self) {
        self.hide_generation.fetch_add(1, Ordering::AcqRel);
    }

    // Only macOS defers the hide: leaving fullscreen needs an animation window
    // before the window may disappear, so that timer has to re-check whether a
    // later show/hide already took over. Every other platform hides
    // synchronously and never has a pending hide to lose — but the generation
    // arithmetic itself is platform independent, so the tests below keep
    // exercising it everywhere (same idiom as `should_refresh_lockscreen`).
    #[cfg(any(target_os = "macos", test))]
    fn owns_hide(&self, generation: u64) -> bool {
        self.hide_generation.load(Ordering::Acquire) == generation
    }
}

fn report_fatal(message: &str) {
    log::error!("{message}");
    eprintln!("{message}");
    #[cfg(target_os = "windows")]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let title = HSTRING::from("TokenLedger 启动失败");
        let body = HSTRING::from(message);
        unsafe {
            MessageBoxW(None, &body, &title, MB_OK | MB_ICONERROR);
        }
    }
}

fn block_on_async<T, F>(future: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    tauri::async_runtime::block_on(future)
}

fn emit_stats_updated(app_handle: &tauri::AppHandle) {
    let _ = app_handle.emit(
        "stats-updated",
        serde_json::json!({ "source": "scheduler" }),
    );
}

fn sync_result_has_stats_changes(result: &serde_json::Value) -> bool {
    ["synced_count", "purged_count"].iter().any(|field| {
        result
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|count| count > 0)
    })
}

fn scan_sync_and_notify(
    ctx: &AppContext,
    app_handle: &tauri::AppHandle,
    allow_idle_sync_retry: bool,
) -> bool {
    let db_path = db::get_db_path(ctx);
    if let Err(e) = db::init_db(&db_path) {
        log::error!("background db init failed: {e}");
        return false;
    }
    let prices_before = commands::auto_discovered_price_keys(ctx);
    let mut prices_changed = false;
    let mut stats_changed = false;
    let mut persisted_changes = false;

    match scanner::run_scan_singleflight(&db_path) {
        Ok(scan) => {
            if scan.joined_existing {
                log::debug!("background scan joined an existing in-flight scan");
                return false;
            }
            let outcome = scan.outcome;
            if outcome.inserted > 0 {
                log::info!("background scan inserted {} rows", outcome.inserted);
                cache::invalidate_all(&db_path);
                stats_changed = true;
                persisted_changes = true;
            }
            prices_changed = commands::auto_discovered_price_keys(ctx) != prices_before;
        }
        Err(e) => {
            log::error!("background scan failed: {e}");
        }
    }

    if persisted_changes || allow_idle_sync_retry {
        match block_on_async(commands::sync_to_supabase_impl(ctx)) {
            Ok(result) => {
                stats_changed |= sync_result_has_stats_changes(&result);
            }
            Err(e) => {
                log::debug!("Background cloud sync skipped/failed: {}", e);
            }
        }
    }
    if prices_changed {
        let _ = app_handle.emit(
            "prices-updated",
            serde_json::json!({ "source": "scheduler" }),
        );
    }
    if stats_changed || prices_changed {
        emit_stats_updated(app_handle);
        refresh_tray_status(ctx, app_handle);
    }
    stats_changed
}

/// 托盘 tooltip / 菜单栏标题跟随本机“今日”统计（T10.105a，B6）。`pub(crate)` 是因为
/// `commands::refresh_scan`（手动刷新，R-52）也要在同一次调用里立即刷新一次，不必等下一次
/// 后台扫描周期。
pub(crate) fn refresh_tray_status(ctx: &AppContext, app_handle: &tauri::AppHandle) {
    let tray_text_enabled = app_handle
        .try_state::<Arc<Mutex<AppSettings>>>()
        .and_then(|state| state.lock().ok().map(|guard| guard.tray_text_enabled))
        .unwrap_or(false);
    widget_window::refresh_tray_status(ctx, app_handle, tray_text_enabled);
}

/// 跨日检测（R-52）：与上次记录的本地日历日不同就该立即刷新一次托盘文字（“今日”的统计换了
/// 一天），不必等到下一次到期的扫描/云同步定时器。纯函数，方便单测与故障注入。
fn day_has_changed(previous: chrono::NaiveDate, current: chrono::NaiveDate) -> bool {
    previous != current
}

fn sync_quota_and_notify(ctx: &AppContext, app_handle: &tauri::AppHandle) {
    if quota_sync::background_sync_is_suppressed() {
        log::debug!(
            "Background quota sync is paused after an authentication/keyring failure; explicit settings retry is required"
        );
        return;
    }
    match block_on_async(quota_sync::sync_quota_snapshots_impl(ctx)) {
        Ok(status) => {
            let _ = app_handle.emit("quota-sync-updated", status);
        }
        Err(error) => {
            log::debug!("Background quota sync skipped/failed: {error}");
            let status = quota_sync::get_background_quota_snapshot_sync_status_impl(ctx);
            let _ = app_handle.emit("quota-sync-updated", status);
        }
    }
}

fn scheduled_wallpaper_target(settings: &AppSettings) -> Option<&'static str> {
    if !settings.wallpaper_automation_authorized() {
        return None;
    }
    let desktop = settings.wallpaper_desktop_enabled
        && !(cfg!(target_os = "macos") && settings.wallpaper_dynamic_bg_enabled);
    let lockscreen =
        settings.wallpaper_lockscreen_enabled && commands::lockscreen_wallpaper_supported();
    match (desktop, lockscreen) {
        (true, true) => Some("both"),
        (true, false) => Some("desktop"),
        (false, true) => Some("lockscreen"),
        (false, false) => None,
    }
}

#[cfg(any(target_os = "windows", test))]
fn should_refresh_lockscreen(enabled: bool, interval_due: bool, stats_changed: bool) -> bool {
    enabled && (interval_due || stats_changed)
}

#[cfg(target_os = "windows")]
fn lower_background_thread_priority() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThread() -> *mut std::ffi::c_void;
        fn SetThreadPriority(thread: *mut std::ffi::c_void, priority: i32) -> i32;
    }
    const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
    let succeeded = unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL) };
    if succeeded == 0 {
        log::warn!(
            "failed to lower background scheduler priority: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn lower_background_thread_priority() {}

fn start_background_scheduler(
    ctx: Arc<AppContext>,
    settings_state: Arc<Mutex<AppSettings>>,
    app_handle: tauri::AppHandle,
) {
    thread::spawn(move || {
        lower_background_thread_priority();
        let initial = settings_state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();

        let (wallpaper_removed, lockscreen_removed) = commands::enforce_wallpaper_retention(&ctx);
        if wallpaper_removed > 0 || lockscreen_removed > 0 {
            log::info!(
                "startup wallpaper migration pruned {wallpaper_removed} desktop and {lockscreen_removed} lockscreen history files"
            );
        }

        // Cold start scans local sources immediately, but an unchanged local
        // database must not trigger a surprise cloud/keychain operation.
        // Newly inserted rows still sync through `persisted_changes`; an idle
        // retry is deliberately deferred to the first 15-minute retry window.
        let _ = scan_sync_and_notify(&ctx, &app_handle, false);
        // 冷启动无论有没有新行，托盘文字都要先落一次“今日”数字。
        refresh_tray_status(&ctx, &app_handle);
        // Quota transport has its own five-minute cadence. Deferring the first
        // secure-session read keeps a local-only cold start quiet while still
        // preserving the configured background refresh policy.
        if let Some(target) = scheduled_wallpaper_target(&initial) {
            if let Err(e) = commands::perform_wallpaper_update(&ctx, target) {
                log::error!("background wallpaper update failed: {e}");
            } else {
                let _ = app_handle.emit(
                    "wallpaper-updated",
                    serde_json::json!({ "source": "scheduler" }),
                );
            }
        }

        let now = Instant::now();
        let mut next_scan = now + Duration::from_secs(initial.scan_interval_secs);
        let mut next_cloud_sync_retry = now + Duration::from_secs(15 * 60);
        let mut next_desktop = now + Duration::from_secs(initial.desktop_interval_secs);
        let mut next_quota_sync = now + Duration::from_secs(5 * 60);
        #[cfg(target_os = "windows")]
        let mut next_lockscreen = now + Duration::from_secs(initial.lockscreen_interval_secs);
        let mut current_day = chrono::Local::now().date_naive();

        loop {
            let now = Instant::now();
            // 只在 Windows 上把锁屏计时纳入最早到期时间；用 cfg 遮蔽的 `let`
            // 而不是 `let mut` + cfg 块，否则非 Windows 目标会触发 unused_mut，
            // macOS/Ubuntu 的 clippy -D warnings 直接失败。
            let min_next = next_scan.min(next_quota_sync).min(next_desktop);
            #[cfg(target_os = "windows")]
            let min_next = min_next.min(next_lockscreen);
            let sleep_dur = min_next
                .saturating_duration_since(now)
                .clamp(Duration::from_millis(500), Duration::from_secs(15));
            thread::sleep(sleep_dur);
            let now = Instant::now();
            let cfg = settings_state
                .lock()
                .map(|guard| guard.clone())
                .unwrap_or_default();

            // 跨日：不等定时器，当天日历日一变就立即补一次托盘文字（R-52）。
            let today = chrono::Local::now().date_naive();
            if day_has_changed(current_day, today) {
                current_day = today;
                refresh_tray_status(&ctx, &app_handle);
            }

            #[cfg(target_os = "windows")]
            let mut stats_changed = false;
            if now >= next_scan {
                let allow_idle_sync_retry = now >= next_cloud_sync_retry;
                let scan_stats_changed =
                    scan_sync_and_notify(&ctx, &app_handle, allow_idle_sync_retry);
                #[cfg(target_os = "windows")]
                {
                    stats_changed = scan_stats_changed;
                }
                #[cfg(not(target_os = "windows"))]
                let _ = scan_stats_changed;
                if allow_idle_sync_retry {
                    next_cloud_sync_retry = now + Duration::from_secs(15 * 60);
                }
                next_scan = now + Duration::from_secs(cfg.scan_interval_secs);
            }

            if now >= next_quota_sync {
                // The main window only polls quotas while visible; a tray-resident
                // app still needs a fresh local read for alerts. No keychain retry.
                if quota::alerts::load_settings(ctx.app_data_dir()).enabled {
                    let _ =
                        tauri::async_runtime::block_on(quota::get_local_quota_providers_impl(&ctx));
                }
                sync_quota_and_notify(&ctx, &app_handle);
                next_quota_sync = now + Duration::from_secs(5 * 60);
            }

            if now >= next_desktop {
                if cfg.wallpaper_automation_authorized()
                    && cfg.wallpaper_desktop_enabled
                    && !(cfg!(target_os = "macos") && cfg.wallpaper_dynamic_bg_enabled)
                {
                    if let Err(e) = commands::perform_wallpaper_update(&ctx, "desktop") {
                        log::error!("scheduled desktop wallpaper update failed: {e}");
                    } else {
                        let _ = app_handle.emit(
                            "wallpaper-updated",
                            serde_json::json!({ "source": "scheduler" }),
                        );
                    }
                }
                next_desktop = now + Duration::from_secs(cfg.desktop_interval_secs);
            }

            #[cfg(target_os = "windows")]
            if should_refresh_lockscreen(
                cfg.wallpaper_automation_authorized() && cfg.wallpaper_lockscreen_enabled,
                now >= next_lockscreen,
                stats_changed,
            ) {
                if let Err(e) = commands::perform_wallpaper_update(&ctx, "lockscreen") {
                    log::error!("scheduled lockscreen wallpaper update failed: {e}");
                } else {
                    let _ = app_handle.emit(
                        "wallpaper-updated",
                        serde_json::json!({ "source": "scheduler" }),
                    );
                }
                next_lockscreen = now + Duration::from_secs(cfg.lockscreen_interval_secs);
            }
        }
    });
}

fn hide_main_window_to_tray<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tray_state: &Arc<TrayWindowState>,
) {
    let hide_generation = tray_state.begin_hide();
    // The bump itself is what keeps a later `cancel_pending_hide` monotonic on
    // every platform; only the macOS delayed-hide path reads the value back.
    #[cfg(not(target_os = "macos"))]
    let _ = hide_generation;
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        {
            if window.is_fullscreen().unwrap_or(false) {
                let app = app.clone();
                let w = window.clone();
                let tray_state = tray_state.clone();
                let _ = window.set_fullscreen(false);
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(800)).await;
                    if !tray_state.owns_hide(hide_generation) {
                        return;
                    }
                    let _ = w.hide();
                    let _ = app.set_dock_visibility(false);
                });
            } else {
                let _ = window.hide();
                let _ = app.set_dock_visibility(false);
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = window.hide();
        }
    }
}

fn show_main_window_from_tray<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tray_state: &Arc<TrayWindowState>,
) {
    tray_state.cancel_pending_hide();
    #[cfg(target_os = "macos")]
    {
        // Hiding the last window also leaves the accessory app hidden from
        // macOS. Showing only the WebView is not sufficient when the user
        // reopens the app from the Dock or launcher.
        let _ = app.show();
        let _ = app.set_dock_visibility(true);
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();

        #[cfg(target_os = "macos")]
        activate_macos_application();

        #[cfg(target_os = "windows")]
        activate_windows_window(&window);
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn activate_macos_application() {
    use cocoa::appkit::{NSApplicationActivateIgnoringOtherApps, NSRunningApplication};
    use cocoa::base::nil;

    // Tauri's window focus call brings the NSWindow forward, but a tray-only
    // app can still remain behind the current application. Explicitly
    // activate the running application so clicking “显示窗口” or using
    // --show returns the user to TokenLedger rather than leaving a visible
    // window behind another app.
    unsafe {
        let application = NSRunningApplication::currentApplication(nil);
        let _ = application.activateWithOptions_(NSApplicationActivateIgnoringOtherApps);
    }
}

#[cfg(target_os = "windows")]
fn activate_windows_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{BringWindowToTop, SetForegroundWindow};

    let Ok(native_handle) = window.hwnd() else {
        log::debug!("unable to resolve native window handle while restoring from tray");
        return;
    };

    // Tauri's Windows handle comes from the 0.61 Windows crate while the
    // application uses 0.62 for its other Win32 integrations. Both are the
    // transparent HWND pointer ABI; reconstruct only the handle wrapper so
    // the foreground request remains isolated to the Windows build.
    let hwnd = HWND(native_handle.0);
    unsafe {
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
    }
}

fn should_start_minimized(settings_start_minimized: bool, args: &[String]) -> bool {
    if args.iter().any(|arg| arg == "--show") {
        return false;
    }
    settings_start_minimized || args.iter().any(|arg| arg == "--minimized")
}

fn should_hide_main_window_on_close(window_label: &str) -> bool {
    window_label == "main"
}

/// 挂件窗口关闭同样只隐藏：它是常驻进程里按需显示的一层，销毁后再创建会
/// 重新加载 Webview 并丢掉用户拖到的位置。
fn should_hide_widget_window_on_close(window_label: &str) -> bool {
    window_label == widget_window::WIDGET_LABEL
}

#[tauri::command]
fn focus_main_window(
    app_handle: tauri::AppHandle,
    tray_state: tauri::State<'_, Arc<TrayWindowState>>,
) -> Result<(), String> {
    let tray_state = tray_state.inner().clone();
    let handle = app_handle.clone();
    app_handle
        .run_on_main_thread(move || show_main_window_from_tray(&handle, &tray_state))
        .map_err(|error| error.to_string())
}

/// 挂件里的“设置”：拉起主窗口并让 React 切到设置页的“桌面挂件”分区（托盘挂件与
/// 桌面小组件的开关都在那里）。
#[tauri::command]
fn open_main_settings(
    app_handle: tauri::AppHandle,
    tray_state: tauri::State<'_, Arc<TrayWindowState>>,
) -> Result<(), String> {
    let tray_state = tray_state.inner().clone();
    let handle = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            show_main_window_from_tray(&handle, &tray_state);
            let _ = handle.emit(
                "open-settings",
                serde_json::json!({ "anchor": "settings-widget" }),
            );
        })
        .map_err(|error| error.to_string())
}

pub fn run() {
    let app_ctx = Arc::new(AppContext::new());
    let db_path = db::get_db_path(&app_ctx);
    if let Err(e) = db::init_db(&db_path) {
        report_fatal(&format!(
            "数据库初始化失败: {e}\n路径: {db_path}\n\n请确认该文件未被其他程序（如旧版 server.js）占用。",
            db_path = db_path.display()
        ));
        return;
    }
    if let Ok(conn) = db::get_connection(&db_path) {
        if let Err(e) = db::init_local_cache(&conn) {
            log::warn!("local stats cache init failed: {e}");
        }
    }

    let gateway_state = Arc::new(gateway::Gateway::new(
        &app_ctx.app_data_dir().join("gateway"),
        Arc::new(gateway::KeyringSecrets),
        gateway::DEFAULT_PORT,
    ));
    // Reconcile crash leftovers even when model access is switched off.
    // Conflicts retain the journal/backups; enabling cannot start the listener
    // until recovery succeeds.
    if let Err(error) = gateway_state.recover_pending_configs() {
        log::warn!("pending gateway configuration recovery failed: {error}");
    }
    let settings =
        settings::migrate_model_access_once(&app_ctx, settings::load_settings(&app_ctx), || {
            gateway_state.was_in_use()
        });
    let model_access_at_launch = settings.model_access_enabled;
    let settings_state = Arc::new(Mutex::new(settings.clone()));
    let tray_state = Arc::new(TrayWindowState::new());
    let launch_args: Vec<String> = std::env::args().collect();
    let start_minimized = should_start_minimized(settings.start_minimized, &launch_args);

    let app_ctx_for_setup = app_ctx.clone();
    let settings_state_for_setup = settings_state.clone();
    let tray_state_for_events = tray_state.clone();
    let tray_state_for_setup = tray_state.clone();
    let tray_state_for_single_instance = tray_state.clone();
    let popover_state = Arc::new(widget_window::WidgetPopoverState::new());
    let popover_state_for_events = popover_state.clone();
    let popover_state_for_setup = popover_state.clone();
    let desktop_state = Arc::new(widget_window::DesktopWidgetState::new());
    let desktop_state_for_events = desktop_state.clone();
    let desktop_state_for_setup = desktop_state.clone();
    let desktop_state_for_run = desktop_state.clone();
    let app_ctx_for_events = app_ctx.clone();
    let settings_state_for_events = settings_state.clone();
    let gateway_for_setup = gateway_state.clone();

    tauri::Builder::default()
        // Opening TokenLedger again from the Dock/launcher must restore the
        // tray-resident process instead of starting a second scheduler, tray
        // icon, SQLite writer, and cloud-sync loop.
        .plugin(tauri_plugin_single_instance::init(
            move |app, _argv, _cwd| {
                // The plugin receives the secondary launch from its Tokio
                // listener. Window/AppKit operations must be marshalled back
                // to the native main thread or a hidden tray window may stay
                // hidden even though the process is correctly reused.
                let app_handle = app.clone();
                let tray_state = tray_state_for_single_instance.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    show_main_window_from_tray(&app_handle, &tray_state);
                    let _ = app_handle.emit(
                        "single-instance-restore",
                        serde_json::json!({ "source": "launcher" }),
                    );
                }) {
                    log::warn!(
                        "failed to marshal single-instance restore to the main thread: {error}"
                    );
                }
            },
        ))
        // Alerts are sent from Rust only; no webview is granted `notification:*`.
        .plugin(tauri_plugin_notification::init())
        .manage(app_ctx.clone())
        .manage(gateway_state.clone())
        .manage(settings_state.clone())
        .manage(tray_state)
        .manage(popover_state)
        .manage(desktop_state)
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if should_hide_main_window_on_close(window.label()) {
                    api.prevent_close();
                    hide_main_window_to_tray(window.app_handle(), &tray_state_for_events);
                } else if should_hide_widget_window_on_close(window.label()) {
                    api.prevent_close();
                    widget_window::release_pin(&popover_state_for_events);
                    let _ = window.hide();
                } else if window.label() == widget_window::DESKTOP_WIDGET_LABEL {
                    // 关掉桌面小组件窗口 = 从桌面移除：开关与托盘菜单勾选一起关闭。
                    widget_window::on_desktop_widget_closed(
                        &app_ctx_for_events,
                        &settings_state_for_events,
                        &desktop_state_for_events,
                    );
                }
            }
            tauri::WindowEvent::Moved(position)
                if window.label() == widget_window::DESKTOP_WIDGET_LABEL =>
            {
                widget_window::on_desktop_widget_moved(
                    app_ctx_for_events.clone(),
                    settings_state_for_events.clone(),
                    &desktop_state_for_events,
                    *position,
                );
            }
            _ => {}
        })
        .setup(move |app| {
            // macOS: back the transparent window (see tauri.macos.conf.json,
            // which sets transparent + Overlay titlebar) with a native
            // NSVisualEffect material so the chrome reads as frosted glass.
            // Progressive enhancement — any failure is logged and ignored so a
            // styling issue can never block startup. No-op on Windows/Linux.
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) =
                        apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None)
                    {
                        log::warn!("apply_vibrancy failed: {e}");
                    }
                }
            }

            // Create System Tray
            let quit_i = tauri::menu::MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let show_i = tauri::menu::MenuItemBuilder::with_id("show", "显示窗口").build(app)?;
            let widget_i = tauri::menu::MenuItemBuilder::with_id("widget", "显示 / 隐藏托盘挂件")
                .build(app)?;
            let (desktop_widget_enabled, desktop_widget_position) = settings_state_for_setup
                .lock()
                .map(|guard| (guard.desktop_widget_enabled, guard.desktop_widget_position))
                .unwrap_or((false, None));
            // 勾选项直接表达“桌面上现在有没有小组件”，和设置页开关是同一个持久化字段。
            let desktop_i = tauri::menu::CheckMenuItemBuilder::with_id(
                "desktop-widget",
                "桌面小组件（长驻桌面）",
            )
            .checked(desktop_widget_enabled)
            .build(app)?;
            desktop_state_for_setup.set_menu_item(desktop_i.clone());
            let menu_separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let menu = tauri::menu::MenuBuilder::new(app)
                .items(&[&show_i, &widget_i, &desktop_i, &menu_separator, &quit_i])
                .build()?;

            // 指向托盘 = 临时弹出挂件（不抢焦点，移开即收起）；单击托盘 = 钉住 / 收起
            //（参考 ClaudeBar / token-monitor 的菜单栏弹窗）；Windows 双击仍然打开主窗口，
            // 菜单“显示窗口”两端通用。
            let tray_state_for_menu = tray_state_for_setup.clone();
            let tray_state_for_icon = tray_state_for_setup.clone();
            let popover_state_for_menu = popover_state_for_setup.clone();
            let popover_state_for_icon = popover_state_for_setup.clone();
            let settings_state_for_menu = settings_state_for_setup.clone();
            let settings_state_for_icon = settings_state_for_setup.clone();
            let app_ctx_for_menu = app_ctx_for_setup.clone();
            let desktop_state_for_menu = desktop_state_for_setup.clone();
            // macOS 菜单栏由系统给模板图标着色，随明暗菜单栏保持清晰。
            let tray_icon = if cfg!(target_os = "macos") {
                tauri::include_image!("icons/tray-template.png")
            } else {
                tauri::include_image!("icons/32x32.png")
            };
            let _tray = tauri::tray::TrayIconBuilder::with_id(widget_window::TRAY_ID)
                .icon(tray_icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("TokenLedger · 悬停或单击查看托盘挂件 · 菜单显示窗口或退出")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "quit" => {
                        desktop_state_for_menu.mark_exiting();
                        app.exit(0);
                    }
                    "show" => {
                        show_main_window_from_tray(app, &tray_state_for_menu);
                    }
                    "widget" => {
                        let _ = widget_window::toggle_on_main_thread(
                            app,
                            &popover_state_for_menu,
                            None,
                        );
                    }
                    "desktop-widget" => {
                        let enabled = settings_state_for_menu
                            .lock()
                            .map(|guard| guard.desktop_widget_enabled)
                            .unwrap_or(false);
                        if let Err(error) = widget_window::set_desktop_widget_enabled_impl(
                            app,
                            &app_ctx_for_menu,
                            &settings_state_for_menu,
                            &desktop_state_for_menu,
                            !enabled,
                        ) {
                            log::warn!("desktop widget toggle failed: {error}");
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| match event {
                    tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        position,
                        ..
                    } => {
                        let anchor = widget_window::Anchor::point(position.x, position.y);
                        let _ = widget_window::toggle_on_main_thread(
                            tray.app_handle(),
                            &popover_state_for_icon,
                            Some(anchor),
                        );
                    }
                    tauri::tray::TrayIconEvent::DoubleClick {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } => {
                        // 双击前总会先收到一次单击：把挂件收回去再开主窗口，避免两层叠着。
                        let _ = widget_window::dismiss_on_main_thread(
                            tray.app_handle(),
                            &popover_state_for_icon,
                        );
                        show_main_window_from_tray(tray.app_handle(), &tray_state_for_icon);
                    }
                    tauri::tray::TrayIconEvent::Enter { position, .. } => {
                        let (hover_enabled, dwell_ms) = settings_state_for_icon
                            .lock()
                            .map(|guard| {
                                (guard.tray_hover_widget_enabled, guard.tray_hover_delay_ms)
                            })
                            .unwrap_or((true, settings::DEFAULT_TRAY_HOVER_DELAY_MS));
                        if hover_enabled {
                            let anchor = widget_window::Anchor::point(position.x, position.y);
                            let _ = widget_window::on_tray_enter(
                                tray.app_handle(),
                                &popover_state_for_icon,
                                anchor,
                                dwell_ms,
                            );
                        }
                    }
                    tauri::tray::TrayIconEvent::Leave { .. } => {
                        widget_window::on_tray_leave(tray.app_handle(), &popover_state_for_icon);
                    }
                    _ => {}
                })
                .build(app)?;

            // Keep the window hidden while the native shell and tray are
            // created. Showing it only after the resolved startup mode is
            // known avoids a visible flash before a persisted minimized
            // setting takes effect; --show still intentionally wins.
            if start_minimized {
                hide_main_window_to_tray(app.handle(), &tray_state_for_setup);
            } else {
                show_main_window_from_tray(app.handle(), &tray_state_for_setup);
            }
            let widget_open_at_startup = settings_state_for_setup
                .lock()
                .map(|guard| guard.widget_open_at_startup)
                .unwrap_or(false);
            if widget_open_at_startup {
                if let Err(error) =
                    widget_window::show_pinned(app.handle(), &popover_state_for_setup, None)
                {
                    log::warn!("widget window could not be shown at startup: {error}");
                }
            }
            if desktop_widget_enabled {
                if let Err(error) =
                    widget_window::show_desktop_widget(app.handle(), desktop_widget_position)
                {
                    log::warn!("desktop widget could not be shown at startup: {error}");
                }
            }

            quota::alerts::install_notifier(Box::new(quota::alerts::TauriNotifier(
                app.handle().clone(),
            )));

            // Background scheduler (scan, sync, wallpaper) — owned by the
            // Tauri process for its lifetime.
            start_background_scheduler(
                app_ctx_for_setup.clone(),
                settings_state_for_setup.clone(),
                app.handle().clone(),
            );
            gateway_for_setup.set_enabled(model_access_at_launch);

            #[cfg(target_os = "macos")]
            {
                let cfg = settings_state_for_setup
                    .lock()
                    .map(|guard| guard.clone())
                    .unwrap_or_default();
                if cfg.wallpaper_automation_authorized()
                    && cfg.wallpaper_desktop_enabled
                    && cfg.wallpaper_dynamic_bg_enabled
                {
                    if let Err(error) = macos_wallpaper_window::show_wallpaper_window(app.handle())
                    {
                        log::error!("dynamic wallpaper window could not be shown: {error}");
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::magpie_import::magpie_import_status,
            commands::magpie_import::magpie_import_run,
            commands::magpie_import::magpie_import_clear,
            peer_sync::peer_sync_get_config,
            peer_sync::peer_sync_save_config,
            peer_sync::peer_sync_clear_config,
            peer_sync::peer_sync_preview,
            peer_sync::peer_sync_import_providers,
            commands::peer_shared::peer_sync_shared_list,
            commands::peer_shared::peer_sync_shared_pull,
            commands::peer_shared::peer_sync_shared_clear,
            peer_live::peer_live_snapshot,
            gateway::gateway_legacy_inspect,
            gateway::gateway_legacy_restore,
            gateway::gateway_set_model_access,
            gateway::gateway_status,
            gateway::gateway_list_providers,
            gateway::gateway_upsert_provider,
            gateway::gateway_set_provider_key,
            gateway::gateway_delete_provider,
            gateway::gateway_recent_requests,
            gateway::gateway_codex_inspect,
            gateway::gateway_codex_preview,
            gateway::gateway_codex_apply,
            gateway::gateway_codex_restore,
            gateway::gateway_agent_inspect,
            gateway::gateway_agent_preview,
            gateway::gateway_agent_apply,
            gateway::gateway_agent_restore,
            gateway::gateway_list_routing_groups,
            gateway::gateway_upsert_routing_group,
            gateway::gateway_delete_routing_group,
            gateway::gateway_recent_route_decisions,
            gateway::gateway_routing_feed,
            gateway::gateway_external_feed,
            gateway::gateway_reveal_local_token,
            commands::get_app_version,
            commands::get_claude_statusline_command,
            commands::preview_claude_statusline_setup,
            commands::apply_claude_statusline_setup,
            commands::restore_claude_statusline_setup,
            commands::get_claude_quota_setup,
            commands::detect_quota_sources,
            commands::list_quota_balance_sources,
            commands::set_quota_balance_source,
            commands::list_quota_experimental_plans,
            commands::set_quota_experimental_plan,
            commands::get_settings,
            commands::save_settings,
            cost_profile::get_cost_profile,
            cost_profile::validate_cost_profile,
            cost_profile::save_cost_profile,
            cost_profile::clear_cost_profile,
            quota::get_quota_providers,
            quota::get_local_quota_providers,
            quota::retry_quota_providers,
            quota::retry_local_quota_providers,
            quota::custom::list_custom_quota_endpoints,
            quota::custom::upsert_custom_quota_endpoint,
            quota::custom::delete_custom_quota_endpoint,
            quota::authorize_claude_native_quota,
            quota::authorize_antigravity_quota,
            quota::alerts::get_quota_alert_settings,
            quota::alerts::set_quota_alert_settings,
            quota_sync::get_quota_snapshot_sync_status,
            quota_sync::set_quota_snapshot_sync_enabled,
            quota_sync::sync_quota_snapshots_now,
            quota_sync::delete_quota_snapshot_provider,
            quota_sync::clear_quota_snapshots,
            commands::get_prices,
            commands::save_prices,
            commands::reset_prices,
            commands::get_price_migration_notice,
            commands::dismiss_price_migration_notice,
            models_dev::search_models_dev_prices,
            commands::get_db_info,
            commands::export_db_csv,
            commands::export_usage_csv,
            commands::cleanup_db,
            commands::reset_local_sync,
            commands::refresh_scan,
            commands::get_usage_details,
            commands::get_local_behavior_analysis,
            project_index::get_project_dimension_status,
            project_index::set_project_dimension,
            project_index::rebuild_project_index,
            session_analysis::get_local_session_analysis,
            session_analysis::cancel_local_session_analysis,
            commands::get_entity_dashboard,
            commands::update_wallpaper,
            commands::wallpaper_preview::preview_wallpaper,
            commands::get_cloud_config,
            commands::save_cloud_config,
            commands::get_cloud_status,
            commands::supabase_sign_in,
            commands::supabase_sign_up,
            commands::supabase_sign_out,
            commands::sync_to_supabase,
            commands::get_cached_stats,
            commands::cleanup_wallpaper,
            commands::reclaim_db_space,
            widget_window::show_widget_window,
            widget_window::hide_widget_window,
            widget_window::toggle_widget_window,
            widget_window::widget_pointer_hover,
            widget_window::set_desktop_widget_enabled,
            focus_main_window,
            open_main_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Underscore-prefixed because only the macOS arm consumes them: every
        // other target compiles this closure with an empty body.
        .run(move |_app, event| {
            // 退出时窗口逐个销毁：桌面小组件的 close 不能被当成用户“移除”。
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                desktop_state_for_run.mark_exiting();
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                let tray_state = _app.state::<Arc<TrayWindowState>>();
                show_main_window_from_tray(_app, tray_state.inner());
            }
        });
}

#[cfg(test)]
mod scheduler_tests {
    use super::*;

    #[test]
    fn lockscreen_only_settings_schedule_work_on_windows_only() {
        let settings = AppSettings {
            wallpaper_desktop_enabled: false,
            wallpaper_lockscreen_enabled: true,
            ..Default::default()
        };

        let expected = if cfg!(target_os = "windows") {
            Some("lockscreen")
        } else {
            None
        };
        assert_eq!(scheduled_wallpaper_target(&settings), expected);
    }

    #[test]
    fn existing_lockscreen_true_setting_cannot_expand_non_windows_startup_target() {
        let settings = AppSettings {
            wallpaper_desktop_enabled: true,
            wallpaper_lockscreen_enabled: true,
            ..Default::default()
        };

        let expected = if cfg!(target_os = "windows") {
            Some("both")
        } else {
            Some("desktop")
        };
        assert_eq!(scheduled_wallpaper_target(&settings), expected);
    }

    #[test]
    fn default_lockscreen_setting_matches_compiled_platform_capability() {
        assert!(!AppSettings::default().wallpaper_lockscreen_enabled);
    }

    #[test]
    fn legacy_enabled_wallpaper_is_inert_until_consent() {
        let settings = AppSettings {
            wallpaper_consent_version: 0,
            wallpaper_desktop_enabled: true,
            wallpaper_lockscreen_enabled: true,
            ..Default::default()
        };
        assert_eq!(scheduled_wallpaper_target(&settings), None);
    }

    #[test]
    fn macos_dynamic_wallpaper_does_not_schedule_fake_raster_updates() {
        let settings = AppSettings {
            wallpaper_desktop_enabled: true,
            wallpaper_dynamic_bg_enabled: true,
            ..Default::default()
        };
        let expected = if cfg!(target_os = "macos") {
            None
        } else {
            Some("desktop")
        };
        assert_eq!(scheduled_wallpaper_target(&settings), expected);
    }

    #[test]
    fn changed_stats_refresh_an_enabled_lockscreen_before_the_interval() {
        assert!(should_refresh_lockscreen(true, false, true));
        assert!(should_refresh_lockscreen(true, true, false));
        assert!(!should_refresh_lockscreen(false, true, true));
        assert!(!should_refresh_lockscreen(true, false, false));
    }

    #[test]
    fn a_new_local_calendar_day_asks_for_an_immediate_tray_refresh() {
        // R-52：跨日后不等下一次扫描周期，当天日历日一变就该刷新。
        let day1 = chrono::NaiveDate::from_ymd_opt(2026, 9, 25).unwrap();
        let day2 = chrono::NaiveDate::from_ymd_opt(2026, 9, 26).unwrap();
        assert!(day_has_changed(day1, day2));
        assert!(!day_has_changed(day1, day1));
    }

    #[test]
    fn sync_results_only_report_stats_changes_for_completed_writes_or_purges() {
        assert!(!sync_result_has_stats_changes(&serde_json::json!({})));
        assert!(!sync_result_has_stats_changes(&serde_json::json!({
            "synced_count": 0,
            "purged_count": 0
        })));
        assert!(sync_result_has_stats_changes(&serde_json::json!({
            "synced_count": 1,
            "purged_count": 0
        })));
        assert!(sync_result_has_stats_changes(&serde_json::json!({
            "synced_count": 0,
            "purged_count": 1
        })));
    }

    #[test]
    fn explicit_show_overrides_persisted_minimized_setting() {
        let args = vec!["tokenledger".to_string(), "--show".to_string()];
        assert!(!should_start_minimized(true, &args));
    }

    #[test]
    fn explicit_show_wins_when_minimized_is_also_present() {
        let args = vec![
            "tokenledger".to_string(),
            "--minimized".to_string(),
            "--show".to_string(),
        ];
        assert!(!should_start_minimized(false, &args));
    }

    #[test]
    fn minimized_flag_hides_window_without_persisted_setting() {
        let args = vec!["tokenledger".to_string(), "--minimized".to_string()];
        assert!(should_start_minimized(false, &args));
    }

    #[test]
    fn default_launch_remains_visible_without_minimized_setting_or_flag() {
        let args = vec!["tokenledger".to_string()];
        assert!(!should_start_minimized(false, &args));
    }

    #[test]
    fn only_the_main_window_close_is_routed_to_the_tray() {
        assert!(should_hide_main_window_on_close("main"));
        assert!(!should_hide_main_window_on_close("wallpaper"));
        assert!(!should_hide_main_window_on_close("settings"));
        assert!(!should_hide_main_window_on_close("widget"));
    }

    #[test]
    fn closing_the_widget_only_hides_it() {
        assert!(should_hide_widget_window_on_close("widget"));
        assert!(!should_hide_widget_window_on_close("main"));
        assert!(!should_hide_widget_window_on_close("wallpaper"));
    }

    #[test]
    fn restoring_from_tray_invalidates_a_deferred_fullscreen_hide() {
        let state = TrayWindowState::new();
        let pending_hide = state.begin_hide();
        assert!(state.owns_hide(pending_hide));

        state.cancel_pending_hide();

        assert!(!state.owns_hide(pending_hide));
    }

    #[test]
    fn a_new_hide_request_supersedes_an_older_deferred_hide() {
        let state = TrayWindowState::new();
        let first = state.begin_hide();
        let second = state.begin_hide();

        assert!(!state.owns_hide(first));
        assert!(state.owns_hide(second));
    }
}
