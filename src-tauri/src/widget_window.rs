//! 桌面挂件窗口（T10.105a）。
//!
//! 一个无边框、置顶、不进任务栏的小窗，只加载 `index.html?view=widget`。宽度恒为 364
//! 逻辑像素，高度按当前板式从 [`widget_card_size`] 取（T10.193，方案 §6.4；U-13）。窗口
//! 按需创建、关闭即隐藏，进程生命周期内只存在一个实例；托盘单击在点击位置附近弹出，
//! macOS 的菜单/主窗口入口同样锚定菜单栏；其他平台沿用上次位置或贴工作区右下角，换板式则按 [`resize_anchored_to_nearest_corner`]
//! 现场改尺寸。窗口本身不采集数据：挂件 Webview 复用 `get_cached_stats`
//! 与本机额度命令，并订阅调度器广播的 `stats-updated`。
//!
//! 托盘状态文字（B6）同样在这里：tooltip 始终写今日预估费用与有效 Token；
//! macOS 菜单栏标题只在用户开启 `tray_text_enabled` 后显示，关闭即恢复纯图标。
//!
//! T10.110 追加两件事：
//! 1. 托盘弹层的显隐状态机——指向托盘图标即临时显示（窗口不可获焦，不打断当前
//!    输入），指针离开托盘与挂件后延时隐藏；单击托盘“钉住”，再次单击或挂件内
//!    “隐藏”解除。
//! 2. 第二个 label 为 `desktop-widget` 的桌面小组件窗口：`always_on_bottom`，
//!    压在普通窗口之下、壁纸之上，可拖动并记住位置；设置页开关、托盘菜单勾选项
//!    与窗口关闭三处收敛到同一个持久化开关。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::menu::CheckMenuItem;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::app_paths::AppContext;
use crate::commands;
use crate::settings::{self, AppSettings};

pub const WIDGET_LABEL: &str = "widget";
pub const DESKTOP_WIDGET_LABEL: &str = "desktop-widget";
pub const TRAY_ID: &str = "main";
/// 与 `src/components/widget/cardModel.ts` 的 `WIDGET_CARD_WIDTH`/`TRAY_BAR_EXTRA`
/// （T10.192，方案 §6.4）逐字同步：宽度恒定，托盘挂件比桌面小组件多一段顶栏（U-13）。
/// 改这两个数先看那边要不要一起改；`widget_card_size_matches_cardmodel_ts` 把两边钉在一起。
pub const WIDGET_CARD_WIDTH: f64 = 364.0;
pub const WIDGET_TRAY_BAR_EXTRA: f64 = 26.0;
const EDGE_MARGIN: f64 = 12.0;
/// 指针离开托盘图标/挂件后等这么久再隐藏，给它从图标滑进挂件的时间。
pub const HOVER_HIDE_DELAY_MS: u64 = 450;
/// 拖动桌面小组件后去抖这么久再写设置文件。
const DESKTOP_MOVE_PERSIST_DELAY_MS: u64 = 600;

/// 托盘弹层的显隐状态机（T10.110）。全部是原子量：托盘事件线程、IPC 命令线程和
/// 延时隐藏线程都会读写它，主线程只负责真正的 show/hide。
#[derive(Debug, Default)]
pub struct WidgetPopoverState {
    pinned: AtomicBool,
    tray_hovered: AtomicBool,
    widget_hovered: AtomicBool,
    hide_generation: AtomicU64,
    show_generation: AtomicU64,
}

/// 只有既没钉住、指针又不在托盘和挂件上时才允许自动隐藏。
pub fn popover_should_hide(pinned: bool, tray_hovered: bool, widget_hovered: bool) -> bool {
    !pinned && !tray_hovered && !widget_hovered
}

/// 停留计时到点时是否还该弹出：指针必须仍停在托盘图标上，且挂件当前不可见。
/// 半路离开、或期间已被单击钉住显示，这次延时显示都作废。
pub fn popover_should_show(tray_hovered: bool, visible: bool) -> bool {
    tray_hovered && !visible
}

impl WidgetPopoverState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_pinned(&self) -> bool {
        self.pinned.load(Ordering::Acquire)
    }

    fn set_pinned(&self, pinned: bool) {
        self.pinned.store(pinned, Ordering::Release);
    }

    fn set_tray_hovered(&self, hovered: bool) {
        self.tray_hovered.store(hovered, Ordering::Release);
    }

    fn is_tray_hovered(&self) -> bool {
        self.tray_hovered.load(Ordering::Acquire)
    }

    fn set_widget_hovered(&self, hovered: bool) {
        self.widget_hovered.store(hovered, Ordering::Release);
    }

    fn should_hide(&self) -> bool {
        popover_should_hide(
            self.pinned.load(Ordering::Acquire),
            self.tray_hovered.load(Ordering::Acquire),
            self.widget_hovered.load(Ordering::Acquire),
        )
    }

    fn begin_hide(&self) -> u64 {
        self.hide_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn cancel_pending_hide(&self) {
        self.hide_generation.fetch_add(1, Ordering::AcqRel);
    }

    fn owns_hide(&self, generation: u64) -> bool {
        self.hide_generation.load(Ordering::Acquire) == generation
    }

    fn begin_show(&self) -> u64 {
        self.show_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn cancel_pending_show(&self) {
        self.show_generation.fetch_add(1, Ordering::AcqRel);
    }

    fn owns_show(&self, generation: u64) -> bool {
        self.show_generation.load(Ordering::Acquire) == generation
    }

    fn should_show_generation(&self, generation: u64, visible: bool) -> bool {
        self.owns_show(generation) && popover_should_show(self.is_tray_hovered(), visible)
    }
}

/// 桌面小组件的进程内状态：托盘菜单勾选项、拖动位置去抖计数、退出标记。
#[derive(Default)]
pub struct DesktopWidgetState {
    move_generation: AtomicU64,
    exiting: AtomicBool,
    menu_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
}

impl DesktopWidgetState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_menu_item(&self, item: CheckMenuItem<tauri::Wry>) {
        if let Ok(mut guard) = self.menu_item.lock() {
            *guard = Some(item);
        }
    }

    fn set_menu_checked(&self, checked: bool) {
        if let Ok(guard) = self.menu_item.lock() {
            if let Some(item) = guard.as_ref() {
                let _ = item.set_checked(checked);
            }
        }
    }

    /// 退出时窗口逐个销毁，不能把这种 close 当成用户“移除”。
    pub fn mark_exiting(&self) {
        self.exiting.store(true, Ordering::Release);
    }

    fn is_exiting(&self) -> bool {
        self.exiting.load(Ordering::Acquire)
    }
}

/// 托盘点击位置或图标矩形（物理像素）。宽高为 0 时表示只有一个点。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Anchor {
    pub fn point(x: f64, y: f64) -> Self {
        Self {
            x,
            y,
            width: 0.0,
            height: 0.0,
        }
    }
}

/// 显示器工作区（物理像素，已去掉任务栏/菜单栏）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 桌面小组件按板式的高度（逻辑像素），抄自 `cardModel.ts` 的 `DESKTOP_HEIGHTS`（T10.192）。
/// 未知板式回落默认板式「用量详情」，与前端 `sanitize_enum`/`parseWidgetLayout` 同一条兜底规则，
/// 不 panic、不给零尺寸窗口。
fn desktop_layout_height(layout: &str) -> f64 {
    match layout {
        "combo" => 172.0,
        "quota" => 272.0,
        "compact" => 104.0,
        _ => 388.0,
    }
}

/// 两块挂件共用的按板式定尺寸（逻辑像素），与 `cardModel.ts` 的 `widgetCardSize` 逐字同步（W4、U-13）。
/// `surface`：`"popover"`（托盘挂件，加 26px 顶栏）或 `"desktop"`（桌面小组件）。
pub fn widget_card_size(surface: &str, layout: &str) -> (f64, f64) {
    let extra = if surface == "popover" {
        WIDGET_TRAY_BAR_EXTRA
    } else {
        0.0
    };
    (WIDGET_CARD_WIDTH, desktop_layout_height(layout) + extra)
}

/// 从设置里读当前板式；状态还没注册或锁中毒都回落默认板式，不阻塞窗口创建。
fn configured_widget_layout<R: tauri::Runtime>(app: &tauri::AppHandle<R>, surface: &str) -> String {
    app.try_state::<Arc<Mutex<AppSettings>>>()
        .and_then(|state| {
            state.lock().ok().map(|guard| {
                if surface == "popover" {
                    guard.widget_popover_layout.clone()
                } else {
                    guard.widget_desktop_layout.clone()
                }
            })
        })
        .unwrap_or_else(|| settings::WIDGET_LAYOUTS[0].to_string())
}

/// 板式改变导致窗口尺寸变化时的锚点角（W4）：横、纵两个方向各自独立判断窗口哪一侧离所在
/// 显示器工作区的边更近，保持那一侧不动，只让另一侧随尺寸变化；结果再夹回工作区，多显示器
/// 由调用方传入该窗口实际所在显示器的 `bounds`。`old_rect` = (x, y, width, height)，与
/// `new_size` 同为物理像素。
pub fn resize_anchored_to_nearest_corner(
    old_rect: (f64, f64, f64, f64),
    new_size: (f64, f64),
    bounds: Bounds,
    margin: f64,
) -> (f64, f64) {
    let (old_x, old_y, old_w, old_h) = old_rect;
    let (new_w, new_h) = new_size;
    let dist_left = (old_x - bounds.x).abs();
    let dist_right = (bounds.x + bounds.width - (old_x + old_w)).abs();
    let dist_top = (old_y - bounds.y).abs();
    let dist_bottom = (bounds.y + bounds.height - (old_y + old_h)).abs();
    let x = if dist_right < dist_left {
        old_x + old_w - new_w
    } else {
        old_x
    };
    let y = if dist_bottom < dist_top {
        old_y + old_h - new_h
    } else {
        old_y
    };
    let min_x = bounds.x + margin;
    let min_y = bounds.y + margin;
    let max_x = (bounds.x + bounds.width - new_w - margin).max(min_x);
    let max_y = (bounds.y + bounds.height - new_h - margin).max(min_y);
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

/// 计算挂件左上角（物理像素）。
///
/// 有锚点时水平居中于锚点、优先放在锚点上方（Windows 任务栏通常在底部），
/// 上方放不下再放到下方；无锚点时贴工作区右下角。任何情况下结果都夹在工作区
/// 内并留出 `margin` 边距，工作区比挂件还小时退化为贴左上边距。
pub fn place_widget(
    anchor: Option<Anchor>,
    bounds: Bounds,
    size: (f64, f64),
    margin: f64,
) -> (f64, f64) {
    let (width, height) = size;
    let (x, y) = match anchor {
        Some(anchor) => {
            let x = anchor.x + anchor.width / 2.0 - width / 2.0;
            let above = anchor.y - margin - height;
            let y = if above >= bounds.y + margin {
                above
            } else {
                anchor.y + anchor.height + margin
            };
            (x, y)
        }
        None => (
            bounds.x + bounds.width - width - margin,
            bounds.y + bounds.height - height - margin,
        ),
    };
    let min_x = bounds.x + margin;
    let min_y = bounds.y + margin;
    let max_x = (bounds.x + bounds.width - width - margin).max(min_x);
    let max_y = (bounds.y + bounds.height - height - margin).max(min_y);
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

/// macOS 弹层没有可用图标矩形时，也必须留在菜单栏所在的顶部。
/// 桌面常驻小组件不经过这个选择器，仍保留用户拖动的位置。
fn popover_anchor(anchor: Option<Anchor>, bounds: Bounds, macos: bool) -> Option<Anchor> {
    anchor.or_else(|| macos.then(|| Anchor::point(bounds.x + bounds.width, bounds.y)))
}

#[cfg(target_os = "macos")]
fn menu_bar_anchor<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Anchor> {
    let rect = app.tray_by_id(TRAY_ID)?.rect().ok()??;
    // tray-icon supplies physical coordinates (including the screen scale).
    let position = rect.position.to_physical::<f64>(1.0);
    let size = rect.size.to_physical::<f64>(1.0);
    (size.width > 0.0 && size.height > 0.0).then_some(Anchor {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn ensure_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<(tauri::WebviewWindow<R>, bool)> {
    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        return Ok((window, false));
    }
    let (width, height) = widget_card_size("popover", &configured_widget_layout(app, "popover"));
    let window = WebviewWindowBuilder::new(
        app,
        WIDGET_LABEL,
        WebviewUrl::App("index.html?view=widget".into()),
    )
    .title("TokenLedger 挂件")
    .inner_size(width, height)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .transparent(cfg!(target_os = "macos"))
    .shadow(true)
    .build()?;
    #[cfg(target_os = "macos")]
    if let Err(error) = window_vibrancy::apply_vibrancy(
        &window,
        window_vibrancy::NSVisualEffectMaterial::Popover,
        None,
        Some(16.0),
    ) {
        log::warn!("widget popover material unavailable: {error}");
    }
    Ok((window, true))
}

fn monitor_bounds<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    anchor: Option<Anchor>,
) -> Option<(Bounds, f64)> {
    let from_anchor = anchor.and_then(|anchor| {
        app.monitor_from_point(
            anchor.x + anchor.width / 2.0,
            anchor.y + anchor.height / 2.0,
        )
        .ok()
        .flatten()
    });
    let monitor = from_anchor
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    Some((
        Bounds {
            x: f64::from(area.position.x),
            y: f64::from(area.position.y),
            width: f64::from(area.size.width),
            height: f64::from(area.size.height),
        },
        monitor.scale_factor(),
    ))
}

/// 显示挂件。首次创建或带锚点（托盘点击/悬停）时重新定位；已有窗口且无锚点时沿用
/// 用户拖动后的位置；macOS 始终重新锚定菜单栏（不可用时顶部兜底）。`focus=false`（托盘悬停）时窗口不可获焦：Windows 加
/// `WS_EX_NOACTIVATE`、macOS 的 `canBecomeKeyWindow` 返回 false，显示不会打断用户
/// 正在输入的应用；`focus=true`（单击/菜单/启动）恢复可获焦并把焦点交给挂件。
pub fn show<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    anchor: Option<Anchor>,
    focus: bool,
) -> tauri::Result<()> {
    let (window, created) = ensure_window(app)?;
    #[cfg(target_os = "macos")]
    let anchor = menu_bar_anchor(app).or(anchor);
    if let Some((bounds, scale)) = monitor_bounds(app, &window, anchor) {
        let anchor = popover_anchor(anchor, bounds, cfg!(target_os = "macos"));
        let layout = configured_widget_layout(app, "popover");
        let logical_size = widget_card_size("popover", &layout);
        reposition_for_size(
            &window,
            anchor,
            created,
            bounds,
            scale,
            logical_size,
            EDGE_MARGIN * scale,
        );
    }
    // 先改可获焦标志再显示：Windows 的 SW_SHOW 只对可激活窗口抢前台。
    let _ = window.set_focusable(focus);
    window.show()?;
    if focus {
        let _ = window.set_focus();
    }
    Ok(())
}

/// 按目标尺寸摆好窗口（W4、U-13）。创建时或带新锚点（托盘点击/悬停）时整套重新定位——沿用
/// [`place_widget`]：锚点居中或贴右下角；已有窗口且没有新锚点（菜单/启动等重新弹出）时，尺寸
/// 没变就保持用户拖动过的位置不动，尺寸变了（换了板式）则按 [`resize_anchored_to_nearest_corner`]
/// 保持离屏幕边缘最近的角不动，再夹回工作区——这样托盘挂件下次弹出就已经是新尺寸。返回值是
/// 这次实际落点（没有挪动则 `None`），供桌面小组件把新位置持久化。
fn reposition_for_size<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    anchor: Option<Anchor>,
    created: bool,
    bounds: Bounds,
    scale: f64,
    logical_size: (f64, f64),
    margin: f64,
) -> Option<(i32, i32)> {
    let size = (logical_size.0 * scale, logical_size.1 * scale);
    if created || anchor.is_some() {
        let _ = window.set_size(PhysicalSize::new(
            size.0.round() as u32,
            size.1.round() as u32,
        ));
        let (x, y) = place_widget(anchor, bounds, size, margin);
        let (x, y) = (x.round() as i32, y.round() as i32);
        let _ = window.set_position(PhysicalPosition::new(x, y));
        return Some((x, y));
    }
    let (Ok(old_size), Ok(old_position)) = (window.inner_size(), window.outer_position()) else {
        return None;
    };
    let old_rect = (
        f64::from(old_position.x),
        f64::from(old_position.y),
        f64::from(old_size.width),
        f64::from(old_size.height),
    );
    if (old_rect.2 - size.0).abs() < 0.5 && (old_rect.3 - size.1).abs() < 0.5 {
        return None;
    }
    let (x, y) = resize_anchored_to_nearest_corner(old_rect, size, bounds, margin);
    let (x, y) = (x.round() as i32, y.round() as i32);
    let _ = window.set_size(PhysicalSize::new(
        size.0.round() as u32,
        size.1.round() as u32,
    ));
    let _ = window.set_position(PhysicalPosition::new(x, y));
    Some((x, y))
}

pub fn hide<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
        window.hide()?;
    }
    Ok(())
}

pub fn is_visible<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.get_webview_window(WIDGET_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// 托盘单击：已钉住 → 隐藏并解除钉住；临时显示中 → 钉住并交焦点；隐藏中 → 钉住显示。
pub fn click<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &WidgetPopoverState,
    anchor: Option<Anchor>,
) -> tauri::Result<()> {
    state.cancel_pending_hide();
    if is_visible(app) {
        if state.is_pinned() {
            release_pin(state);
            return hide(app);
        }
        state.set_pinned(true);
        if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
            let _ = window.set_focusable(true);
            let _ = window.set_focus();
        }
        return Ok(());
    }
    state.set_pinned(true);
    show(app, anchor, true)
}

/// 菜单、侧栏、启动等显式入口：钉住显示。
pub fn show_pinned<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &WidgetPopoverState,
    anchor: Option<Anchor>,
) -> tauri::Result<()> {
    state.cancel_pending_hide();
    state.set_pinned(true);
    show(app, anchor, true)
}

/// 挂件内“隐藏”、托盘双击等：解除钉住并隐藏。
pub fn dismiss<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &WidgetPopoverState,
) -> tauri::Result<()> {
    release_pin(state);
    hide(app)
}

/// 窗口关闭事件只隐藏，但要把钉住状态一起清掉，否则下次悬停不会自动收起。
pub fn release_pin(state: &WidgetPopoverState) {
    // 隐藏不会可靠地产生 Webview mouseleave，显式结束本次指针会话。
    state.set_widget_hovered(false);
    state.set_tray_hovered(false);
    state.set_pinned(false);
    state.cancel_pending_hide();
    state.cancel_pending_show();
}

/// 指针进入托盘图标：停留 `dwell_ms` 后临时显示（不抢焦点）；已显示时只取消待执行的隐藏。
///
/// 停留判定是 T10.125 加的。此前 `Enter` 直接 show，而托盘图标只有十几像素宽，
/// 鼠标去点旁边的图标或滑向右下角都会扫过它，于是"路过"被当成"想看"，
/// 一块 340x440 的窗口就弹了出来。`dwell_ms == 0` 保留旧的立即弹出行为。
pub fn on_tray_enter<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<WidgetPopoverState>,
    anchor: Anchor,
    dwell_ms: u64,
) -> Result<(), String> {
    state.set_tray_hovered(true);
    state.cancel_pending_hide();
    let generation = state.begin_show();
    if dwell_ms == 0 {
        return show_if_hidden(app, state, anchor, generation);
    }
    let app = app.clone();
    let state = state.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(dwell_ms));
        // 期间离开图标（cancel_pending_show）或又进来一次（新的 generation）都作废这次。
        if state.owns_show(generation) && state.is_tray_hovered() {
            let _ = show_if_hidden(&app, &state, anchor, generation);
        }
    });
    Ok(())
}

/// 指针离开托盘图标：作废还没到点的弹出，并在挂件也没被悬停且未钉住时延时隐藏。
pub fn on_tray_leave<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<WidgetPopoverState>,
) {
    state.set_tray_hovered(false);
    state.cancel_pending_show();
    schedule_hide(app, state);
}

/// 真正弹出前在主线程再判一次：已经显示就什么都不做（从挂件滑回图标不该重新定位窗口），
/// 指针在计时到点与主线程排到之间离开了图标也不再弹。
fn show_if_hidden<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<WidgetPopoverState>,
    anchor: Anchor,
    generation: u64,
) -> Result<(), String> {
    let state = state.clone();
    on_main_thread(app, move |handle| {
        if state.should_show_generation(generation, is_visible(handle)) {
            show(handle, Some(anchor), false)
        } else {
            Ok(())
        }
    })
}

/// 挂件 Webview 上报指针进出（`widget_pointer_hover` 命令）。
pub fn on_widget_hover<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<WidgetPopoverState>,
    inside: bool,
) {
    state.set_widget_hovered(inside);
    if inside {
        state.cancel_pending_hide();
    } else {
        schedule_hide(app, state);
    }
}

fn schedule_hide<R: tauri::Runtime>(app: &tauri::AppHandle<R>, state: &Arc<WidgetPopoverState>) {
    if !state.should_hide() {
        return;
    }
    let generation = state.begin_hide();
    let app = app.clone();
    let state = state.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(HOVER_HIDE_DELAY_MS));
        if state.owns_hide(generation) && state.should_hide() {
            let _ = hide_on_main_thread(&app);
        }
    });
}

/// 窗口创建与显示必须在原生主线程执行（macOS 硬性要求，Windows 也更稳）。
/// 托盘事件与 IPC 命令都从这里进入。
fn on_main_thread<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: impl FnOnce(&tauri::AppHandle<R>) -> tauri::Result<()> + Send + 'static,
) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = action(&handle) {
            log::warn!("widget window action failed: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

pub fn show_pinned_on_main_thread<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<WidgetPopoverState>,
    anchor: Option<Anchor>,
) -> Result<(), String> {
    let state = state.clone();
    on_main_thread(app, move |handle| show_pinned(handle, &state, anchor))
}

pub fn hide_on_main_thread<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    on_main_thread(app, hide)
}

pub fn dismiss_on_main_thread<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<WidgetPopoverState>,
) -> Result<(), String> {
    let state = state.clone();
    on_main_thread(app, move |handle| dismiss(handle, &state))
}

/// 托盘单击/菜单“显示 / 隐藏挂件”：见 [`click`]。
pub fn toggle_on_main_thread<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &Arc<WidgetPopoverState>,
    anchor: Option<Anchor>,
) -> Result<(), String> {
    let state = state.clone();
    on_main_thread(app, move |handle| click(handle, &state, anchor))
}

#[tauri::command]
pub fn show_widget_window(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<WidgetPopoverState>>,
) -> Result<(), String> {
    show_pinned_on_main_thread(&app_handle, state.inner(), None)
}

#[tauri::command]
pub fn hide_widget_window(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<WidgetPopoverState>>,
) -> Result<(), String> {
    dismiss_on_main_thread(&app_handle, state.inner())
}

#[tauri::command]
pub fn toggle_widget_window(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<WidgetPopoverState>>,
) -> Result<(), String> {
    toggle_on_main_thread(&app_handle, state.inner(), None)
}

/// 挂件 Webview 的 mouseenter / mouseleave 上报；悬停期间不自动隐藏。
#[tauri::command]
pub fn widget_pointer_hover(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, Arc<WidgetPopoverState>>,
    inside: bool,
) -> Result<(), String> {
    on_widget_hover(&app_handle, state.inner(), inside);
    Ok(())
}

// ------------------------------------------------------------------ 桌面小组件

/// 恢复上次拖动位置：至少一半仍落在给定工作区内才沿用，否则回到工作区右下角。
pub fn restore_desktop_position(
    saved: Option<(f64, f64)>,
    bounds: Bounds,
    size: (f64, f64),
    margin: f64,
) -> (f64, f64) {
    if let Some((x, y)) = saved {
        let (width, height) = size;
        let center_x = x + width / 2.0;
        let center_y = y + height / 2.0;
        let inside = center_x >= bounds.x
            && center_x <= bounds.x + bounds.width
            && center_y >= bounds.y
            && center_y <= bounds.y + bounds.height;
        if inside {
            return (x, y);
        }
    }
    place_widget(None, bounds, size, margin)
}

/// 保存的位置是物理像素；用左上角所在显示器的缩放把逻辑尺寸转为物理尺寸后再探测中心。
fn desktop_monitor_probe(
    saved: Option<(f64, f64)>,
    logical_size: (f64, f64),
    origin_scale: f64,
) -> Option<Anchor> {
    saved.map(|(x, y)| {
        Anchor::point(
            x + logical_size.0 * origin_scale / 2.0,
            y + logical_size.1 * origin_scale / 2.0,
        )
    })
}

fn ensure_desktop_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<(tauri::WebviewWindow<R>, bool)> {
    if let Some(window) = app.get_webview_window(DESKTOP_WIDGET_LABEL) {
        return Ok((window, false));
    }
    let (width, height) = widget_card_size("desktop", &configured_widget_layout(app, "desktop"));
    let window = WebviewWindowBuilder::new(
        app,
        DESKTOP_WIDGET_LABEL,
        WebviewUrl::App("index.html?view=widget&mode=desktop".into()),
    )
    .title("TokenLedger 桌面小组件")
    .inner_size(width, height)
    .resizable(false)
    .decorations(false)
    // 压在普通窗口之下、壁纸之上：Windows 走 HWND_BOTTOM，macOS 走 BelowNormal 层级。
    .always_on_bottom(true)
    .skip_taskbar(true)
    .visible(false)
    // 两平台都透明：卡片自己画 22px 圆角与 1px 内描边，方窗口边角露出真实桌面（W2、U-13）。
    .transparent(true)
    .shadow(false)
    .focused(false)
    .build()?;
    #[cfg(target_os = "macos")]
    apply_desktop_widget_collection_behavior(&window);
    Ok((window, true))
}

/// 出现在每一个桌面空间、且不参与窗口循环（W2、U-13；方案 §6.5）。真机效果未验证——本机是
/// Windows；写法与 `macos_wallpaper_window.rs` 里已经在用的 collectionBehavior 设置同源同款。
#[cfg(target_os = "macos")]
fn apply_desktop_widget_collection_behavior<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc::{msg_send, sel, sel_impl};
    let Ok(ns_window) = window.ns_window() else {
        log::warn!("desktop widget NSWindow unavailable for collection behavior");
        return;
    };
    let native_window = ns_window as *mut objc::runtime::Object;
    unsafe {
        // Public NSWindowCollectionBehavior values from AppKit/NSWindow.h（与
        // `macos_wallpaper_window.rs` 相同的两个常量：可加入所有 Space + 不参与
        // Space 之间的窗口循环排布）。
        const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
        const STATIONARY: usize = 1 << 4;
        let behavior: usize = msg_send![native_window, collectionBehavior];
        let new_behavior = behavior | CAN_JOIN_ALL_SPACES | STATIONARY;
        let () = msg_send![native_window, setCollectionBehavior: new_behavior];
    }
}

/// 显示（必要时创建）桌面小组件；首次创建时按保存的位置或工作区右下角摆放。
pub fn show_desktop_widget<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    saved: Option<(i32, i32)>,
) -> tauri::Result<()> {
    let (window, created) = ensure_desktop_window(app)?;
    if created {
        let (logical_w, logical_h) =
            widget_card_size("desktop", &configured_widget_layout(app, "desktop"));
        let saved_point = saved.map(|(x, y)| (f64::from(x), f64::from(y)));
        // 先以物理左上角取得所在屏缩放，再用物理尺寸的中心选目标屏。
        // 显示器已拔掉时 monitor_bounds 退回当前/主显示器。
        let origin_probe = saved_point.map(|(x, y)| Anchor::point(x, y));
        let origin_scale = monitor_bounds(app, &window, origin_probe).map(|(_, scale)| scale);
        let probe = origin_scale
            .and_then(|scale| desktop_monitor_probe(saved_point, (logical_w, logical_h), scale));
        if let Some((bounds, scale)) = monitor_bounds(app, &window, probe) {
            let (x, y) = restore_desktop_position(
                saved_point,
                bounds,
                (logical_w * scale, logical_h * scale),
                EDGE_MARGIN * scale,
            );
            let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
        }
    }
    let _ = window.set_always_on_bottom(true);
    window.show()?;
    Ok(())
}

pub fn close_desktop_widget<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(DESKTOP_WIDGET_LABEL) {
        window.close()?;
    }
    Ok(())
}

/// 设置页开关、托盘菜单与启动共用的收敛点：同步窗口与菜单勾选（不写盘）。
pub fn sync_desktop_widget<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &DesktopWidgetState,
    enabled: bool,
    position: Option<(i32, i32)>,
) -> Result<(), String> {
    state.set_menu_checked(enabled);
    on_main_thread(app, move |handle| {
        if enabled {
            show_desktop_widget(handle, position)
        } else {
            close_desktop_widget(handle)
        }
    })
}

/// `save_settings` 保存后按最新设置同步桌面小组件（T10.110）；开着的时候顺带按新板式现场改
/// 尺寸（W4、U-13）——开关本身与创建/移除仍归 [`sync_desktop_widget`]，这里只在窗口已经存在时
/// 补一次改尺寸，避免关闭中的窗口被多余地挪动。
pub fn sync_desktop_widget_from_settings(app: &tauri::AppHandle, settings: &AppSettings) {
    let Some(state) = app.try_state::<Arc<DesktopWidgetState>>() else {
        return;
    };
    if let Err(error) = sync_desktop_widget(
        app,
        state.inner(),
        settings.desktop_widget_enabled,
        settings.desktop_widget_position,
    ) {
        log::warn!("desktop widget sync failed: {error}");
    }
    if settings.desktop_widget_enabled {
        let layout = settings.widget_desktop_layout.clone();
        let app = app.clone();
        let _ = on_main_thread(&app, move |handle| {
            apply_desktop_widget_layout(handle, &layout);
            Ok(())
        });
    }
}

/// 板式改变时如果桌面小组件已经在显示，按新尺寸现场改窗口：保持离屏幕边缘最近的角不动、
/// 夹回工作区，并把新的左上角写回 `desktop_widget_position`（与拖动后持久化用同一个字段），
/// 下次重启仍从这里恢复。窗口还没创建（开关本来就关着）时什么都不做——`ensure_desktop_window`
/// 已经会在下次真正创建时读当前设置里的尺寸，不需要在这里补。
fn apply_desktop_widget_layout<R: tauri::Runtime>(app: &tauri::AppHandle<R>, layout: &str) {
    let Some(window) = app.get_webview_window(DESKTOP_WIDGET_LABEL) else {
        return;
    };
    let Some((bounds, scale)) = monitor_bounds(app, &window, None) else {
        return;
    };
    let logical_size = widget_card_size("desktop", layout);
    let Some((x, y)) = reposition_for_size(
        &window,
        None,
        false,
        bounds,
        scale,
        logical_size,
        EDGE_MARGIN * scale,
    ) else {
        return;
    };
    persist_desktop_widget_position(app, x, y);
}

fn persist_desktop_widget_position<R: tauri::Runtime>(app: &tauri::AppHandle<R>, x: i32, y: i32) {
    let Some(ctx) = app.try_state::<Arc<AppContext>>() else {
        return;
    };
    let Some(settings_state) = app.try_state::<Arc<Mutex<AppSettings>>>() else {
        return;
    };
    match settings::update_desktop_widget_position(ctx.inner(), Some((x, y))) {
        Ok(next) => {
            if let Ok(mut guard) = settings_state.lock() {
                *guard = next;
            }
        }
        Err(error) => log::debug!("desktop widget position not saved after resize: {error}"),
    }
}

/// 托盘菜单勾选项与挂件内“从桌面移除”：写盘 + 更新内存态 + 同步窗口与菜单。
pub fn set_desktop_widget_enabled_impl(
    app: &tauri::AppHandle,
    ctx: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
    state: &Arc<DesktopWidgetState>,
    enabled: bool,
) -> Result<(), String> {
    let next = settings::update_desktop_widget_enabled(ctx, enabled)?;
    if let Ok(mut guard) = settings_state.lock() {
        *guard = next.clone();
    }
    let _ = app.emit(
        "settings-updated",
        serde_json::json!({ "source": "desktop-widget" }),
    );
    sync_desktop_widget(app, state, enabled, next.desktop_widget_position)
}

#[tauri::command]
pub fn set_desktop_widget_enabled(
    app_handle: tauri::AppHandle,
    ctx: tauri::State<'_, Arc<AppContext>>,
    settings_state: tauri::State<'_, Arc<Mutex<AppSettings>>>,
    state: tauri::State<'_, Arc<DesktopWidgetState>>,
    enabled: bool,
) -> Result<(), String> {
    set_desktop_widget_enabled_impl(
        &app_handle,
        ctx.inner(),
        settings_state.inner(),
        state.inner(),
        enabled,
    )
}

/// 用户拖动桌面小组件：去抖后把位置写进设置，重启后原位恢复。
pub fn on_desktop_widget_moved(
    ctx: Arc<AppContext>,
    settings_state: Arc<Mutex<AppSettings>>,
    state: &Arc<DesktopWidgetState>,
    position: PhysicalPosition<i32>,
) {
    let generation = state.move_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let state = state.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(DESKTOP_MOVE_PERSIST_DELAY_MS));
        if state.move_generation.load(Ordering::Acquire) != generation {
            return;
        }
        match settings::update_desktop_widget_position(&ctx, Some((position.x, position.y))) {
            Ok(next) => {
                if let Ok(mut guard) = settings_state.lock() {
                    *guard = next;
                }
            }
            Err(error) => log::debug!("desktop widget position not saved: {error}"),
        }
    });
}

/// 用户关掉桌面小组件窗口（Alt+F4、⌘W 或“从桌面移除”）等同于关闭开关；
/// 应用退出时的窗口销毁不算。
pub fn on_desktop_widget_closed(
    ctx: &AppContext,
    settings_state: &Arc<Mutex<AppSettings>>,
    state: &DesktopWidgetState,
) {
    if state.is_exiting() {
        return;
    }
    match settings::update_desktop_widget_enabled(ctx, false) {
        Ok(next) => {
            if let Ok(mut guard) = settings_state.lock() {
                *guard = next;
            }
        }
        Err(error) => log::debug!("desktop widget switch not persisted on close: {error}"),
    }
    state.set_menu_checked(false);
}

/// 读不到费用时的写法，与前端 `COST_UNAVAILABLE`（`src/utils/format.ts`）同字。
const COST_UNAVAILABLE: &str = "不可得";

/// Token 量级缩写，与前端 `formatTokens`（`src/utils/format.ts`，DESIGN §4.4）逐字相同，两端共用
/// `fixtures/token-format-v1/cases.json`（T10.191）：不足 1,000 写整数；K 保留 1 位小数，M、B 保留
/// 2 位，按绝对值选单位、负数再加 `-`；舍入后达到 1000 就进位到下一单位（999,999 写 `1.00M`，
/// 不写 `1000.0K`），B 是最高单位；读不到写「—」，不写 0（GLB-01）。小数位按显示值（十进制）
/// 四舍五入、半数远离 0（T10.204）：输入本来就是整数 Token 数，全程用 i128 整数运算求商与余数，
/// 不经过浮点数，因此 1,150 → `1.2K`，不是二进制精确值舍入误写的 `1.1K`。
fn format_tokens(value: Option<i64>) -> String {
    const UNITS: [(i128, u32, &str); 3] = [
        (1_000, 1, "K"),
        (1_000_000, 2, "M"),
        (1_000_000_000, 2, "B"),
    ];
    let Some(value) = value else {
        return "—".to_string();
    };
    let magnitude = i128::from(value.unsigned_abs());
    if magnitude < 1_000 {
        return value.to_string();
    }
    let mut unit = if magnitude >= 1_000_000_000 {
        2
    } else if magnitude >= 1_000_000 {
        1
    } else {
        0
    };
    let mut text = format_unit_magnitude(magnitude, UNITS[unit].0, UNITS[unit].1);
    if unit + 1 < UNITS.len() && text.parse::<f64>().is_ok_and(|shown| shown >= 1_000.0) {
        unit += 1;
        text = format_unit_magnitude(magnitude, UNITS[unit].0, UNITS[unit].1);
    }
    let sign = if value < 0 { "-" } else { "" };
    format!("{sign}{text}{}", UNITS[unit].2)
}

/// `magnitude / base` 舍入到 `digits` 位小数、按十进制半数远离 0（T10.204，取代原先复刻 JS
/// `toFixed` 二进制舍入的 `js_to_fixed`）：整数乘以 `10^digits` 后做整数除法取商与余数，余数的
/// 两倍达到 `base` 就进一——不经过浮点数，因此不会遇到 1,150 / 1,000 = 1.15 这类十进制小数在
/// 二进制下无法精确表示、导致 `{:.1}` 误舍成 1.1 的问题。
fn format_unit_magnitude(magnitude: i128, base: i128, digits: u32) -> String {
    let scale = 10_i128.pow(digits);
    let scaled_numerator = magnitude * scale;
    let whole = scaled_numerator / base;
    let remainder = scaled_numerator - whole * base;
    let scaled = if remainder * 2 >= base {
        whole + 1
    } else {
        whole
    };
    let digits = digits as usize;
    let text = format!("{scaled:0width$}", width = digits + 1);
    let split = text.len() - digits;
    format!("{}.{}", &text[..split], &text[split..])
}

/// 汇总级预估费用（T10.154 §4.1），与前端 `formatEstimatedUsd(value, 'summary')` 逐字相同，两端共用
/// `fixtures/estimated-usd-format-v1/cases.json`（T10.191）：`≈$` + 千分位 + 两位小数；
/// 0 < v < 0.01 写 `<$0.01`；已知 0（含 -0）写 `≈$0.00`；读不到、非有限或为负写「不可得」（GLB-01）。
///
/// 舍入对齐看板的 `Intl.NumberFormat`：先取 f64 的最短往返十进制串（Rust 的 `{}` 与 JS 的
/// `Number#toString` 给出同一组数字），再按第三位小数四舍五入（半数远离 0）。所以 1.005 写 `≈$1.01`；
/// 按二进制精确值舍入的 `{:.2}` 会写成 `≈$1.00`（1.005 实际存成 1.00499…）。
fn format_estimated_usd(value: Option<f64>) -> String {
    let Some(value) = value.filter(|value| value.is_finite() && *value >= 0.0) else {
        return COST_UNAVAILABLE.to_string();
    };
    if value == 0.0 {
        return "≈$0.00".to_string();
    }
    if value < 0.01 {
        return "<$0.01".to_string();
    }
    // `{}` 不用科学计数：1e21 也写成 22 位整数。
    let shortest = value.to_string();
    let (whole, fraction) = shortest.split_once('.').unwrap_or((shortest.as_str(), ""));
    let digit = |index: usize| {
        fraction
            .as_bytes()
            .get(index)
            .map_or(0, |byte| u32::from(byte - b'0'))
    };
    let mut cents = digit(0) * 10 + digit(1) + u32::from(digit(2) >= 5);
    let mut whole = whole.as_bytes().to_vec();
    if cents == 100 {
        cents = 0;
        increment_decimal_digits(&mut whole);
    }
    format!("≈${}.{cents:02}", group_thousands(&whole))
}

/// 给 ASCII 十进制整数串加一（999 → 1000）。
fn increment_decimal_digits(digits: &mut Vec<u8>) {
    for digit in digits.iter_mut().rev() {
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit += 1;
            return;
        }
    }
    digits.insert(0, b'1');
}

/// 每三位加一个逗号（1234567 → 1,234,567），与 `Intl.NumberFormat('en-US')` 的千分位相同。
fn group_thousands(digits: &[u8]) -> String {
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.iter().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(char::from(*digit));
    }
    grouped
}

/// 托盘悬停文案与 macOS 菜单栏标题（T10.154 D67/D68、§4.10）。金额按 §4.1 的汇总写法、Token 按
/// DESIGN §4.4，都与看板逐字相同（T10.191）；读不到费用时写「今日预估费用不可得」与「不可得」，
/// 读不到 Token 时写「—」，不把未知画成 0（GLB-01）。
pub fn tray_status_text(total_tokens: Option<i64>, total_cost: Option<f64>) -> (String, String) {
    let tokens = format_tokens(total_tokens);
    let cost = format_estimated_usd(total_cost);
    let cost_phrase = if cost == COST_UNAVAILABLE {
        format!("今日预估费用{COST_UNAVAILABLE}")
    } else {
        format!("今日预估费用 {cost}")
    };
    (
        format!("TokenLedger · {cost_phrase} · {tokens} 有效 Token · 悬停或单击查看挂件"),
        cost,
    )
}

fn summary_numbers(stats: &Value) -> (Option<i64>, Option<f64>) {
    let summary = stats.get("summary");
    // 缺字段或不是整数都算读不到，托盘写「—」而不是 0（GLB-01）。
    let tokens = summary
        .and_then(|summary| summary.get("totalTokens"))
        .and_then(Value::as_i64);
    // 缺字段、`null`（serde_json 把非有限浮点写成 null）或负数都算读不到，
    // 交给文案写「不可得」而不是当成 0；`abs` 只把 -0.0 规整成 0.0。
    let cost = summary
        .and_then(|summary| summary.get("totalCost"))
        .and_then(Value::as_f64)
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
        .map(f64::abs);
    (tokens, cost)
}

/// 用本机“今日”统计刷新托盘文字。读取走缓存过的本地统计路径，失败只记日志。
pub fn refresh_tray_status(ctx: &AppContext, app: &tauri::AppHandle, tray_text_enabled: bool) {
    let stats = match commands::get_stats_impl(ctx, "today".to_string()) {
        Ok(stats) => stats,
        Err(error) => {
            log::debug!("tray status refresh skipped: {error}");
            return;
        }
    };
    let (tokens, cost) = summary_numbers(&stats);
    let (tooltip, title) = tray_status_text(tokens, cost);
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Err(error) = tray.set_tooltip(Some(tooltip)) {
        log::debug!("tray tooltip update failed: {error}");
    }
    #[cfg(target_os = "macos")]
    {
        let title = if tray_text_enabled { Some(title) } else { None };
        if let Err(error) = tray.set_title(title) {
            log::debug!("tray title update failed: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux 托盘没有标题位；开关只影响 macOS 菜单栏。
        let _ = (tray_text_enabled, title);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIZE: (f64, f64) = (340.0, 440.0);
    const WORK_AREA: Bounds = Bounds {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };

    #[test]
    fn macos_popover_without_tray_rect_stays_below_menu_bar() {
        for bounds in [
            Bounds {
                x: 0.0,
                y: 50.0,
                width: 2880.0,
                height: 1750.0,
            },
            Bounds {
                x: -1920.0,
                y: -1060.0,
                width: 1920.0,
                height: 1040.0,
            },
        ] {
            let anchor = popover_anchor(None, bounds, true);
            let (x, y) = place_widget(anchor, bounds, (728.0, 800.0), 24.0);
            assert_eq!(y, bounds.y + 24.0);
            assert_eq!(x, bounds.x + bounds.width - 728.0 - 24.0);
            assert_eq!(popover_anchor(None, bounds, false), None);
            let rect = Anchor {
                x: bounds.x + 900.0,
                y: bounds.y - 50.0,
                width: 48.0,
                height: 50.0,
            };
            assert_eq!(popover_anchor(Some(rect), bounds, true), Some(rect));
            assert_eq!(
                place_widget(Some(rect), bounds, (728.0, 800.0), 24.0).1,
                bounds.y + 24.0
            );
        }
    }

    #[test]
    fn tray_anchor_places_the_widget_above_and_centered_on_the_click() {
        let anchor = Anchor::point(1800.0, 1030.0);
        let (x, y) = place_widget(Some(anchor), WORK_AREA, SIZE, 12.0);
        assert_eq!(y, 1030.0 - 12.0 - 440.0);
        // 水平居中会越过右边距，因此被夹回工作区内。
        assert_eq!(x, 1920.0 - 340.0 - 12.0);
    }

    #[test]
    fn anchor_near_the_top_edge_opens_the_widget_below_the_icon() {
        let anchor = Anchor {
            x: 900.0,
            y: 4.0,
            width: 24.0,
            height: 24.0,
        };
        let (x, y) = place_widget(Some(anchor), WORK_AREA, SIZE, 12.0);
        assert_eq!(y, 4.0 + 24.0 + 12.0);
        assert_eq!(x, 900.0 + 12.0 - 170.0);
    }

    #[test]
    fn without_an_anchor_the_widget_sits_in_the_bottom_right_corner() {
        let (x, y) = place_widget(None, WORK_AREA, SIZE, 12.0);
        assert_eq!((x, y), (1920.0 - 340.0 - 12.0, 1040.0 - 440.0 - 12.0));
    }

    #[test]
    fn secondary_monitor_offsets_are_respected() {
        let bounds = Bounds {
            x: -1920.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let (x, y) = place_widget(None, bounds, SIZE, 12.0);
        assert_eq!(
            (x, y),
            (-1920.0 + 1920.0 - 340.0 - 12.0, 1080.0 - 440.0 - 12.0)
        );
    }

    #[test]
    fn a_work_area_smaller_than_the_widget_falls_back_to_the_margin_corner() {
        let bounds = Bounds {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 300.0,
        };
        let (x, y) = place_widget(None, bounds, SIZE, 12.0);
        assert_eq!((x, y), (12.0, 12.0));
    }

    #[test]
    fn tray_text_carries_cost_and_effective_tokens() {
        let (tooltip, title) = tray_status_text(Some(1_234_567), Some(12.345));
        assert_eq!(
            tooltip,
            "TokenLedger · 今日预估费用 ≈$12.35 · 1.23M 有效 Token · 悬停或单击查看挂件"
        );
        assert_eq!(title, "≈$12.35");
        assert_eq!(
            tray_status_text(Some(950), Some(0.0)).0,
            "TokenLedger · 今日预估费用 ≈$0.00 · 950 有效 Token · 悬停或单击查看挂件"
        );
        assert_eq!(format_tokens(Some(45_600)), "45.6K");
    }

    #[test]
    fn tray_text_says_unavailable_instead_of_zero_when_cost_is_unknown() {
        // T10.154 D67/D68：读不到费用时写「不可得」，不能把未知画成 $0.00。
        let (tooltip, title) = tray_status_text(Some(1_234_567), None);
        assert_eq!(
            tooltip,
            "TokenLedger · 今日预估费用不可得 · 1.23M 有效 Token · 悬停或单击查看挂件"
        );
        assert_eq!(title, "不可得");
        assert!(!tooltip.contains('$'));
        assert!(!tooltip.contains("成本"));
    }

    #[test]
    fn tray_text_follows_the_dashboard_amount_and_token_formats() {
        // T10.186 评审 P3-3：托盘金额没有千分位、微小正数写成 ≈$0.00、1.005 比看板少一分；
        // Rust 的 format_tokens 把 999,999 写成 1000.0K。现在与看板逐字相同。
        let (tooltip, title) = tray_status_text(Some(999_999), Some(1234.5));
        assert_eq!(
            tooltip,
            "TokenLedger · 今日预估费用 ≈$1,234.50 · 1.00M 有效 Token · 悬停或单击查看挂件"
        );
        assert_eq!(title, "≈$1,234.50");
        let (tooltip, title) = tray_status_text(Some(1_000_000_000), Some(0.004));
        assert_eq!(
            tooltip,
            "TokenLedger · 今日预估费用 <$0.01 · 1.00B 有效 Token · 悬停或单击查看挂件"
        );
        assert_eq!(title, "<$0.01");
        assert_eq!(tray_status_text(Some(7), Some(1.005)).1, "≈$1.01");
        // 读不到 Token 写「—」，不写 0（GLB-01）。
        assert_eq!(
            tray_status_text(None, Some(0.0)).0,
            "TokenLedger · 今日预估费用 ≈$0.00 · — 有效 Token · 悬停或单击查看挂件"
        );
    }

    #[test]
    fn format_unit_magnitude_rounds_the_decimal_value_and_breaks_exact_ties_upward() {
        // T10.204：按显示值（十进制）四舍五入、半数远离 0，不复刻 JS `toFixed` 的二进制舍入。
        assert_eq!(format_unit_magnitude(1_150, 1_000, 1), "1.2");
        assert_eq!(format_unit_magnitude(1_005_000, 1_000_000, 2), "1.01");
        assert_eq!(format_unit_magnitude(1_250, 1_000, 1), "1.3");
        assert_eq!(format_unit_magnitude(1_125_000, 1_000_000, 2), "1.13");
        assert_eq!(format_unit_magnitude(0, 1_000, 2), "0.00");
        assert_eq!(
            format_unit_magnitude(999_995_000_000, 1_000_000_000, 2),
            "1000.00"
        );
    }

    /// 金额与 Token 的黄金用例与 `src/utils/format.test.ts` 共用（T10.191）：同一输入，两端必须写出同一串。
    const USD_FORMAT_CASES: &str =
        include_str!("../../fixtures/estimated-usd-format-v1/cases.json");
    const TOKEN_FORMAT_CASES: &str = include_str!("../../fixtures/token-format-v1/cases.json");

    #[derive(serde::Deserialize)]
    struct GoldenCases<T> {
        cases: Vec<GoldenCase<T>>,
    }

    #[derive(serde::Deserialize)]
    struct GoldenCase<T> {
        input: Option<T>,
        expected: String,
    }

    fn golden_cases<T: serde::de::DeserializeOwned>(json: &str) -> Vec<GoldenCase<T>> {
        serde_json::from_str::<GoldenCases<T>>(json)
            .expect("黄金用例是合法 JSON")
            .cases
    }

    #[test]
    fn estimated_usd_matches_the_shared_golden_cases() {
        let cases = golden_cases::<String>(USD_FORMAT_CASES);
        assert!(cases.len() >= 20, "金额黄金用例只剩 {} 条", cases.len());
        let mismatches: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                // 输入写成十进制字符串，交给 Rust 自己的正确舍入解析（NaN、Infinity、-0 也能写）。
                let value = case.input.as_deref().map(|raw| {
                    raw.parse::<f64>()
                        .unwrap_or_else(|_| panic!("不是数字：{raw}"))
                });
                let actual = format_estimated_usd(value);
                (actual != case.expected)
                    .then(|| format!("{:?} → {actual}，期望 {}", case.input, case.expected))
            })
            .collect();
        assert!(mismatches.is_empty(), "与前端不一致：{mismatches:#?}");
    }

    #[test]
    fn tokens_match_the_shared_golden_cases() {
        let cases = golden_cases::<i64>(TOKEN_FORMAT_CASES);
        assert!(cases.len() >= 20, "Token 黄金用例只剩 {} 条", cases.len());
        let mismatches: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let actual = format_tokens(case.input);
                (actual != case.expected)
                    .then(|| format!("{:?} → {actual}，期望 {}", case.input, case.expected))
            })
            .collect();
        assert!(mismatches.is_empty(), "与前端不一致：{mismatches:#?}");
    }

    #[test]
    fn popover_only_hides_when_unpinned_and_nothing_is_hovered() {
        assert!(popover_should_hide(false, false, false));
        assert!(!popover_should_hide(true, false, false));
        assert!(!popover_should_hide(false, true, false));
        assert!(!popover_should_hide(false, false, true));
        assert!(!popover_should_hide(true, true, true));
    }

    #[test]
    fn hover_show_needs_the_pointer_to_still_be_on_the_tray_icon() {
        // 只有指针还停在图标上、且挂件当前不可见时才弹出。
        assert!(popover_should_show(true, false));
        // 已经显示：从挂件滑回图标不该重新定位窗口。
        assert!(!popover_should_show(true, true));
        // 计时到点前指针已经划走：这次弹出作废。
        assert!(!popover_should_show(false, false));
    }

    #[test]
    fn queued_hover_show_cannot_borrow_a_new_pointer_session() {
        let state = WidgetPopoverState::new();
        state.set_tray_hovered(true);
        let queued = state.begin_show();
        assert!(state.should_show_generation(queued, false));
        // 旧计时已经排入主线程；其间离开再进入，不能借新悬停状态提前弹出。
        state.set_tray_hovered(false);
        state.cancel_pending_show();
        state.set_tray_hovered(true);
        let current = state.begin_show();
        assert!(!state.should_show_generation(queued, false));
        assert!(state.should_show_generation(current, false));
        assert!(!state.should_show_generation(current, true));
    }

    #[test]
    fn passing_over_the_tray_icon_cancels_the_pending_show() {
        let state = WidgetPopoverState::new();
        state.set_tray_hovered(true);
        let generation = state.begin_show();
        assert!(state.owns_show(generation));
        // 鼠标只是路过：停留计时还没到点就离开了。
        state.set_tray_hovered(false);
        state.cancel_pending_show();
        assert!(!state.owns_show(generation));
        // 再次进入产生新的 generation，旧计时线程醒来时不再拥有弹出权。
        state.set_tray_hovered(true);
        let next = state.begin_show();
        assert_ne!(generation, next);
        assert!(state.owns_show(next));
        // 显式关闭（含托盘双击、Escape）同样作废待弹出。
        release_pin(&state);
        assert!(!state.owns_show(next));
    }

    #[test]
    fn popover_state_generations_cancel_stale_hides() {
        let state = WidgetPopoverState::new();
        assert!(!state.is_pinned());
        state.set_tray_hovered(true);
        assert!(!state.should_hide());
        state.set_tray_hovered(false);
        assert!(state.should_hide());
        let generation = state.begin_hide();
        assert!(state.owns_hide(generation));
        // 指针在超时前回到挂件：这次隐藏作废。
        state.set_widget_hovered(true);
        state.cancel_pending_hide();
        assert!(!state.owns_hide(generation));
        assert!(!state.should_hide());
        // 钉住后即使指针全部离开也不隐藏；解除钉住恢复默认。
        state.set_widget_hovered(false);
        state.set_pinned(true);
        assert!(!state.should_hide());
        release_pin(&state);
        assert!(state.should_hide());
    }

    #[test]
    fn dismiss_clears_pointer_session_before_next_hover() {
        let state = WidgetPopoverState::new();
        state.set_pinned(true);
        state.set_widget_hovered(true);
        state.set_tray_hovered(true);
        let generation = state.begin_hide();
        release_pin(&state);
        assert!(state.should_hide());
        assert!(!state.owns_hide(generation));
        state.set_tray_hovered(true);
        assert!(!state.should_hide());
        state.set_tray_hovered(false);
        assert!(state.should_hide());
    }

    #[test]
    fn desktop_widget_position_is_restored_only_while_still_on_screen() {
        let saved = Some((1200.0, 500.0));
        assert_eq!(
            restore_desktop_position(saved, WORK_AREA, SIZE, 12.0),
            (1200.0, 500.0)
        );
        // 显示器拔掉后旧坐标落在工作区外：回到右下角。
        assert_eq!(
            restore_desktop_position(Some((4000.0, 500.0)), WORK_AREA, SIZE, 12.0),
            (1920.0 - 340.0 - 12.0, 1040.0 - 440.0 - 12.0)
        );
        assert_eq!(
            restore_desktop_position(None, WORK_AREA, SIZE, 12.0),
            (1920.0 - 340.0 - 12.0, 1040.0 - 440.0 - 12.0)
        );
        // 只露出一半以上仍算在屏内（用户故意贴边）。
        assert_eq!(
            restore_desktop_position(Some((-160.0, 500.0)), WORK_AREA, SIZE, 12.0),
            (-160.0, 500.0)
        );
    }

    #[test]
    fn desktop_monitor_probe_keeps_saved_physical_coordinates_at_mixed_dpi_seam() {
        // 左屏 150%、右屏 100%，接缝 x=1920；逻辑宽 364 若直接
        // 当作物理宽探测 1882，会留在左屏；正确物理中心是 1973。
        let probe = desktop_monitor_probe(Some((1700.0, 500.0)), (364.0, 388.0), 1.5).unwrap();
        assert_eq!((probe.x, probe.y), (1973.0, 791.0));
        assert_eq!((probe.width, probe.height), (0.0, 0.0));
        assert!(desktop_monitor_probe(None, (364.0, 388.0), 1.5).is_none());
    }

    #[test]
    fn desktop_widget_close_during_exit_is_not_a_removal() {
        let state = DesktopWidgetState::new();
        assert!(!state.is_exiting());
        state.mark_exiting();
        assert!(state.is_exiting());
    }

    #[test]
    fn summary_numbers_tolerate_missing_fields() {
        // 缺字段是读不到，不当成 0（GLB-01）：托盘写「—」与「不可得」。
        assert_eq!(summary_numbers(&serde_json::json!({})), (None, None));
        assert_eq!(
            summary_numbers(
                &serde_json::json!({ "summary": { "totalTokens": 42, "totalCost": 1.5 } })
            ),
            (Some(42), Some(1.5))
        );
        assert_eq!(
            summary_numbers(&serde_json::json!({ "summary": { "totalTokens": "42" } })),
            (None, None)
        );
    }

    #[test]
    fn summary_numbers_keep_unreadable_cost_unknown_instead_of_zero() {
        let with_cost = |cost: Value| {
            summary_numbers(
                &serde_json::json!({ "summary": { "totalTokens": 7, "totalCost": cost } }),
            )
        };
        // serde_json 把 NaN/∞ 写成 null；负数和字符串同样不是可验证的费用。
        assert_eq!(with_cost(serde_json::json!(f64::NAN)), (Some(7), None));
        assert_eq!(with_cost(Value::Null), (Some(7), None));
        assert_eq!(with_cost(serde_json::json!(-1.0)), (Some(7), None));
        assert_eq!(with_cost(serde_json::json!("1.5")), (Some(7), None));
        // 真 0 仍是已知的 0，-0.0 也按 0 写，不会出现「≈$-0.00」。
        assert_eq!(with_cost(serde_json::json!(0.0)), (Some(7), Some(0.0)));
        let (_, negative_zero) = with_cost(serde_json::json!(-0.0));
        assert_eq!(tray_status_text(Some(7), negative_zero).1, "≈$0.00");
    }

    #[test]
    fn widget_card_size_matches_cardmodel_ts_widget_card_size() {
        // 抄自 src/components/widget/cardModel.ts 的 DESKTOP_HEIGHTS / TRAY_BAR_EXTRA /
        // WIDGET_CARD_WIDTH（T10.192，方案 §6.4）。两边各自维护，不是自动跨语言比对；
        // 改任何一边先看另一边是否也要改（本任务日志的开放点也记了这件事）。
        let cases: [(&str, &str, (f64, f64)); 8] = [
            ("desktop", "usage", (364.0, 388.0)),
            ("desktop", "combo", (364.0, 172.0)),
            ("desktop", "quota", (364.0, 272.0)),
            ("desktop", "compact", (364.0, 104.0)),
            ("popover", "usage", (364.0, 414.0)),
            ("popover", "combo", (364.0, 198.0)),
            ("popover", "quota", (364.0, 298.0)),
            ("popover", "compact", (364.0, 130.0)),
        ];
        for (surface, layout, expected) in cases {
            assert_eq!(
                widget_card_size(surface, layout),
                expected,
                "{surface}/{layout}"
            );
        }
        // 闭合集合以外的板式回落默认板式，和前端 sanitize_enum 一样，不 panic、不给零尺寸。
        assert_eq!(widget_card_size("desktop", "unknown"), (364.0, 388.0));
    }

    const SECONDARY_MONITOR: Bounds = Bounds {
        x: -1920.0,
        y: 40.0,
        width: 1920.0,
        height: 1080.0,
    };

    #[test]
    fn shrinking_near_the_bottom_right_edge_keeps_that_corner_fixed() {
        // 窗口贴在工作区右下角；改成更小的板式时右边和下边应该保持贴边不动，
        // 只有左边和上边随之内收。
        let old_rect = (1920.0 - 340.0 - 12.0, 1040.0 - 440.0 - 12.0, 340.0, 440.0);
        let (x, y) = resize_anchored_to_nearest_corner(old_rect, (364.0, 104.0), WORK_AREA, 12.0);
        assert_eq!(x, old_rect.0 + old_rect.2 - 364.0);
        assert_eq!(y, old_rect.1 + old_rect.3 - 104.0);
    }

    #[test]
    fn growing_near_the_top_left_edge_keeps_that_corner_fixed() {
        // 窗口贴在工作区左上角；改成更大的板式时左边和上边不动，右边和下边向外长。
        let old_rect = (12.0, 12.0, 340.0, 104.0);
        let (x, y) = resize_anchored_to_nearest_corner(old_rect, (364.0, 388.0), WORK_AREA, 12.0);
        assert_eq!((x, y), (12.0, 12.0));
    }

    #[test]
    fn a_secondary_monitor_anchors_relative_to_its_own_bounds() {
        // 副屏原点是负数；贴在它自己右下角的窗口改板式后仍要贴在这块屏幕的右下角，
        // 不能被当成贴在主屏（原点 0,0）的右下角。
        let old_rect = (
            SECONDARY_MONITOR.x + SECONDARY_MONITOR.width - 340.0 - 12.0,
            SECONDARY_MONITOR.y + SECONDARY_MONITOR.height - 440.0 - 12.0,
            340.0,
            440.0,
        );
        let (x, y) =
            resize_anchored_to_nearest_corner(old_rect, (364.0, 172.0), SECONDARY_MONITOR, 12.0);
        assert_eq!(x, old_rect.0 + old_rect.2 - 364.0);
        assert_eq!(y, old_rect.1 + old_rect.3 - 172.0);
        assert!(x >= SECONDARY_MONITOR.x + 12.0);
    }

    #[test]
    fn a_size_larger_than_the_work_area_still_clamps_inside_it() {
        // 工作区比新尺寸还小：贴住的角会被夹回工作区内，不会有一半探出屏幕。
        let tiny_area = Bounds {
            x: 0.0,
            y: 0.0,
            width: 300.0,
            height: 300.0,
        };
        let old_rect = (12.0, 12.0, 288.0 - 12.0, 288.0 - 12.0);
        let (x, y) = resize_anchored_to_nearest_corner(old_rect, (364.0, 388.0), tiny_area, 12.0);
        assert_eq!((x, y), (12.0, 12.0));
    }
}
