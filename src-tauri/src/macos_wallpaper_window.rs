#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};

#[cfg(target_os = "macos")]
extern "C" {
    pub fn CGWindowLevelForKey(key: i32) -> i32;
}

#[cfg(target_os = "macos")]
const K_CG_DESKTOP_WINDOW_LEVEL_KEY: i32 = 2;

#[cfg(target_os = "macos")]
fn is_main_thread() -> bool {
    use objc::{class, msg_send, sel, sel_impl};
    unsafe { msg_send![class!(NSThread), isMainThread] }
}

#[cfg(target_os = "macos")]
fn show_wallpaper_window_on_main_thread(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let monitor = app_handle
        .primary_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "macOS primary monitor is unavailable".to_string())?;
    let size = monitor.size();
    let position = monitor.position();
    let scale = monitor.scale_factor();
    let x = position.x as f64 / scale;
    let y = position.y as f64 / scale;
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;

    let window = if let Some(window) = app_handle.get_webview_window("wallpaper") {
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window
    } else {
        tauri::WebviewWindowBuilder::new(
            app_handle,
            "wallpaper",
            tauri::WebviewUrl::App("index.html?view=wallpaper".into()),
        )
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .visible(false)
        .focusable(false)
        .focused(false)
        .title("TokenLedger Wallpaper")
        .position(x, y)
        .inner_size(width, height)
        .skip_taskbar(true)
        .build()
        .map_err(|error| format!("failed to build wallpaper window: {error}"))?
    };

    use objc::{msg_send, sel, sel_impl};
    let ns_window = window
        .ns_window()
        .map_err(|error| format!("failed to access wallpaper NSWindow: {error}"))?;
    let native_window = ns_window as *mut objc::runtime::Object;
    window
        .set_focusable(false)
        .map_err(|error| format!("failed to make wallpaper window non-focusable: {error}"))?;
    unsafe {
        // Keep the WebView above the system background and below desktop icons.
        let desktop_level = CGWindowLevelForKey(K_CG_DESKTOP_WINDOW_LEVEL_KEY);
        let () = msg_send![native_window, setLevel: (desktop_level + 1) as isize];
        let () = msg_send![native_window, setIgnoresMouseEvents: true];
        let () = msg_send![native_window, setCanBecomeVisibleWithoutLogin: false];

        // Public NSWindowCollectionBehavior values from AppKit/NSWindow.h.
        const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
        const STATIONARY: usize = 1 << 4;
        const IGNORES_CYCLE: usize = 1 << 6;
        let behavior: usize = msg_send![native_window, collectionBehavior];
        let new_behavior = behavior | CAN_JOIN_ALL_SPACES | STATIONARY | IGNORES_CYCLE;
        let () = msg_send![native_window, setCollectionBehavior: new_behavior];
    }
    window.show().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub fn show_wallpaper_window(app_handle: &tauri::AppHandle) -> Result<(), String> {
    if is_main_thread() {
        return show_wallpaper_window_on_main_thread(app_handle);
    }
    let handle = app_handle.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_on_main = cancelled.clone();
    app_handle
        .run_on_main_thread(move || {
            if cancelled_on_main.load(Ordering::Acquire) {
                return;
            }
            let _ = sender.send(show_wallpaper_window_on_main_thread(&handle));
        })
        .map_err(|error| error.to_string())?;
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(error) => {
            cancelled.store(true, Ordering::Release);
            Err(format!("timed out applying wallpaper window: {error}"))
        }
    }
}

#[cfg(target_os = "macos")]
pub fn hide_wallpaper_window(app_handle: &tauri::AppHandle) -> Result<(), String> {
    if is_main_thread() {
        return match app_handle.get_webview_window("wallpaper") {
            Some(window) => window.close().map_err(|error| error.to_string()),
            None => Ok(()),
        };
    }
    let handle = app_handle.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_on_main = cancelled.clone();
    app_handle
        .run_on_main_thread(move || {
            if cancelled_on_main.load(Ordering::Acquire) {
                return;
            }
            let result = match handle.get_webview_window("wallpaper") {
                Some(window) => window.close().map_err(|error| error.to_string()),
                None => Ok(()),
            };
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(error) => {
            cancelled.store(true, Ordering::Release);
            Err(format!("timed out closing wallpaper window: {error}"))
        }
    }
}

// Stub implementation for non-macOS platforms
#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub fn show_wallpaper_window(_app_handle: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
pub fn hide_wallpaper_window(_app_handle: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}
