import { Activity, BarChart3, Bot, Check, Cloud, Gauge, History, Image as ImageIcon, LoaderCircle, Monitor, Plug, RefreshCw, Route, Server, Settings, Share2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { TokenLedgerIcon } from './brand/TokenLedgerIcon';
import type { Tab, CloudStatus } from '../types';
import { isUsageTab } from '../types';
import { showsWindowsLockscreenControls } from '../utils/frontendContracts';
import { useSegmentedIndicator } from '../hooks/useSegmentedIndicator';
import { handleWindowDragDoubleClick, handleWindowDragMouseDown } from './AppHeader';
import { USAGE_SUB_OPTIONS } from './usage/UsagePage';
import { USAGE_SUB_TABS } from '../utils/usageNavigation';

interface SidebarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  busy: { scan: boolean; sync: boolean };
  cloudAuthenticated: boolean;
  cloudStatusKnown?: boolean;
  cloudCapabilityVerified: boolean;
  cloudReady: boolean;
  /** 数据库信息未读到或读取失败时为 null（未知），不得显示为 0（GLB-01，T10.180）。 */
  pendingUploads: number | null;
  cloudStatus: CloudStatus;
  onScan: () => void;
  onSync: () => void;
  onCheckCloudStatus?: () => void;
  onWallpaper: (target: 'desktop' | 'lockscreen') => void;
  onOpenShareCard?: () => void;
  wallpaperBusy: boolean;
  appVersion: string;
  /** 模型接入总开关（U-112）；关闭时不显示 Agent、供应商、网关、路由四个入口。 */
  modelAccessEnabled?: boolean;
}

export interface CloudSidebarStatusCopy {
  label: string;
  compactLabel: string;
}

export function cloudSidebarStatusCopy({
  authenticated,
  capabilityVerified,
  ready,
  pendingUploads,
  statusKnown = true,
}: {
  authenticated: boolean;
  capabilityVerified: boolean;
  ready: boolean;
  /** 数据库信息未读到或读取失败时为 null（未知），不得当作 0（GLB-01，T10.180）。 */
  pendingUploads: number | null;
  statusKnown?: boolean;
}): CloudSidebarStatusCopy {
  if (!statusKnown) {
    return { label: '本地就绪 · 云端状态待检查', compactLabel: '待检查' };
  }
  if (!authenticated) {
    return { label: '本地就绪 · 云端未登录', compactLabel: '未登录' };
  }
  if (!capabilityVerified) {
    return { label: '云端账户已登录 · 待完成验证', compactLabel: '待验证' };
  }
  if (!ready) {
    return { label: '云端账户已登录 · 待首次同步', compactLabel: '待同步' };
  }
  if (pendingUploads === null) {
    return { label: '云端可用 · 待上传数未知', compactLabel: '待确认' };
  }
  if (pendingUploads > 0) {
    return { label: `云端可用 · ${pendingUploads} 条待上传`, compactLabel: '待上传' };
  }
  return { label: '本地就绪 · 云端可用', compactLabel: '云端可用' };
}

interface NavItem {
  id: Tab;
  label: string;
  icon: typeof BarChart3;
  matches: (tab: Tab) => boolean;
}

const USAGE_NAV_ITEM: NavItem = { id: 'dashboard', label: '用量', icon: BarChart3, matches: isUsageTab };

/** 用量分组内同级页面（T10.306f），仍是子页唯一的侧栏入口（U-101）。 */
const USAGE_SUB_ICONS = { overview: BarChart3, requests: History, sessions: Activity, allowances: Gauge } as const;
const USAGE_SUB_NAV_ITEMS = USAGE_SUB_OPTIONS.map(({ id, label }) => ({
  id: USAGE_SUB_TABS[id], label, icon: USAGE_SUB_ICONS[id],
}));

/**
 * The sliding pill follows the current page (`aria-current="page"`). The usage
 * group carries `aria-current="true"` so that, when its sub-entries are hidden
 * in the narrow rail, the pill falls back to the group row.
 */
const NAV_ACTIVE_SELECTOR = '[aria-current="page"], [aria-current="true"]';

const SETTINGS_NAV_ITEM: NavItem = { id: 'settings', label: '设置与云端', icon: Settings, matches: (tab) => tab === 'settings' };

const MODEL_NAV_ITEMS: NavItem[] = [
  { id: 'agents', label: 'Agent', icon: Bot, matches: (tab) => tab === 'agents' },
  { id: 'providers', label: '供应商', icon: Server, matches: (tab) => tab === 'providers' },
  { id: 'gateway', label: '网关', icon: Plug, matches: (tab) => tab === 'gateway' },
  { id: 'routing', label: '路由', icon: Route, matches: (tab) => tab === 'routing' },
];

/** Same breakpoint as the icon-only rail in index.css. */
const NARROW_RAIL_QUERY = '(max-width: 860px)';

function useNarrowRail() {
  const [narrow, setNarrow] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_RAIL_QUERY).matches
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(NARROW_RAIL_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return narrow;
}

/**
 * Only a real macOS Tauri window has the NSVisualEffectView behind the
 * webview. Browser fixtures (including mockIPC, which has no window
 * metadata) get the opaque sidebar instead of a translucent grey-blue slab.
 */
function hasNativeVibrancy() {
  if (typeof window === 'undefined' || document.documentElement.dataset.platform !== 'macos') return false;
  const internals = (window as Window & { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return Boolean(internals?.metadata?.currentWindow?.label);
}

type ScrollEdges = { overflow: boolean; top: boolean; bottom: boolean };

export function Sidebar({
  activeTab,
  onTabChange,
  busy,
  cloudAuthenticated,
  cloudStatusKnown = true,
  cloudCapabilityVerified,
  cloudReady,
  pendingUploads,
  onScan,
  onSync,
  onCheckCloudStatus,
  onWallpaper,
  onOpenShareCard,
  wallpaperBusy,
  appVersion,
  modelAccessEnabled = true,
}: SidebarProps) {
  const showLockscreenControls = showsWindowsLockscreenControls();
  // The active page pill slides between rows (T10.150); items keep aria-current.
  const navIndicatorRef = useSegmentedIndicator<HTMLElement>(NAV_ACTIVE_SELECTOR);
  // The list fades out only at an edge that has hidden rows (T10.277): a mask
  // instead of painted covers, so it works over the opaque browser fill and
  // the translucent macOS vibrancy alike.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollEdges, setScrollEdges] = useState<ScrollEdges>({ overflow: false, top: false, bottom: false });
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    const update = () => {
      const overflow = scroller.scrollHeight > scroller.clientHeight + 1;
      const top = overflow && scroller.scrollTop > 1;
      const bottom = overflow && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
      setScrollEdges((prev) => (prev.overflow === overflow && prev.top === top && prev.bottom === bottom ? prev : { overflow, top, bottom }));
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(scroller);
      for (const child of Array.from(scroller.children)) observer.observe(child);
    }
    return () => {
      scroller.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, []);
  const [nativeVibrancy] = useState(hasNativeVibrancy);
  const narrowRail = useNarrowRail();
  const usageActive = isUsageTab(activeTab);

  // Icon-only rail (≤860px): the sub-entries are hidden, so the 用量 icon
  // opens the sub-page menu instead (U-101 removed the in-page tabs).
  const usageButtonRef = useRef<HTMLButtonElement>(null);
  const usageMenuRef = useRef<HTMLDivElement>(null);
  const usageMenuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [usageMenuRequested, setUsageMenuRequested] = useState(false);
  const usageMenuOpen = usageMenuRequested && narrowRail;
  const [usageMenuStyle, setUsageMenuStyle] = useState<CSSProperties>();
  const closeUsageMenu = (restoreFocus: boolean) => {
    setUsageMenuRequested(false);
    if (restoreFocus) usageButtonRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!usageMenuOpen) return undefined;
    const place = () => {
      const anchor = usageButtonRef.current;
      const menu = usageMenuRef.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
      const height = menu.offsetHeight;
      setUsageMenuStyle({
        left: Math.round(rect.right + 8),
        top: Math.round(Math.max(8, Math.min(rect.top - 6, viewportHeight - 8 - height))),
      });
    };
    place();
    usageMenuItemRefs.current.find((item) => item?.tabIndex === 0)?.focus();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [usageMenuOpen]);

  useEffect(() => {
    if (!usageMenuOpen) return undefined;
    const closeFromOutside = (event: Event) => {
      if (
        event.target instanceof Node
        && !usageMenuRef.current?.contains(event.target)
        && !usageButtonRef.current?.contains(event.target)
      ) {
        setUsageMenuRequested(false);
      }
    };
    document.addEventListener('mousedown', closeFromOutside);
    document.addEventListener('focusin', closeFromOutside);
    return () => {
      document.removeEventListener('mousedown', closeFromOutside);
      document.removeEventListener('focusin', closeFromOutside);
    };
  }, [usageMenuOpen]);

  const handleUsageMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const count = USAGE_SUB_NAV_ITEMS.length;
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      closeUsageMenu(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = usageMenuItemRefs.current.findIndex((item) => item === document.activeElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? count - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + count) % count
          : (currentIndex - 1 + count) % count;
    usageMenuItemRefs.current[nextIndex]?.focus();
  };
  const statusLive = busy.scan || busy.sync;
  const { label: cloudStatusLabel, compactLabel: compactCloudStatusLabel } = cloudSidebarStatusCopy({
    authenticated: cloudAuthenticated,
    capabilityVerified: cloudCapabilityVerified,
    ready: cloudReady,
    pendingUploads,
    statusKnown: cloudStatusKnown,
  });
  const syncDisabled = busy.sync || !cloudStatusKnown || !cloudAuthenticated || !cloudCapabilityVerified;
  const wallpaperActionLabel = wallpaperBusy ? '设置中…' : '桌面壁纸';
  const lockscreenWallpaperActionLabel = wallpaperBusy ? '设置中…' : '锁屏壁纸';
  const wallpaperToolCount = showLockscreenControls ? 2 : 1;
  const toolCount = (onOpenShareCard ? 1 : 0) + wallpaperToolCount;
  const wallpaperActionTitle = wallpaperBusy ? '正在写入系统壁纸' : '设置桌面壁纸';
  const lockscreenWallpaperActionTitle = wallpaperBusy ? '正在写入系统壁纸' : '设置锁屏壁纸';
  const scanActionLabel = busy.scan ? '扫描中…' : '扫描';
  const scanActionAriaLabel = busy.scan ? '正在扫描本地各 AI 工具日志' : '扫描本地日志';
  const scanActionTitle = busy.scan ? '正在扫描本地各 AI 工具日志' : '立即扫描本地各 AI 工具日志';
  const syncActionLabel = busy.sync ? '同步中…' : '同步';
  const syncActionAriaLabel = busy.sync
    ? '正在同步云端数据'
    : !cloudStatusKnown
      ? '请先检查云端状态'
      : '立即同步云端';
  const syncActionTitle = busy.sync
    ? '正在同步云端数据'
    : !cloudStatusKnown
      ? '请先在设置与云端检查云端状态'
      : !cloudAuthenticated
      ? '请先在设置中登录云端'
      : !cloudCapabilityVerified
        ? '请先在设置与云端中验证 Stats v2'
        : '立即将本地数据同步至云端';
  const syncRecoveryHint = !busy.sync && !cloudStatusKnown
    ? '同步暂不可用：请先打开设置与云端检查账户状态。'
    : !busy.sync && !cloudAuthenticated
    ? '同步暂不可用：请先在设置与云端登录云端账户。'
    : !busy.sync && !cloudCapabilityVerified
      ? '同步暂不可用：请先在设置与云端完成 Stats v2 验证。'
      : null;
  const syncRecoveryAriaLabel = !cloudStatusKnown
    ? '去设置与云端检查云端状态'
    : !cloudAuthenticated
    ? '去设置与云端登录云端账户'
    : '去设置与云端验证 Stats v2';
  const syncRecoveryLabel = !cloudStatusKnown ? '检查状态' : !cloudAuthenticated ? '去登录' : '去验证';

  const renderNavItem = (item: NavItem) => (
    <button
      key={item.id}
      type="button"
      className={`nav-item ${item.matches(activeTab) ? 'nav-item-active' : ''}`}
      aria-current={item.matches(activeTab) ? 'page' : undefined}
      aria-label={item.label}
      title={item.label}
      onClick={() => onTabChange(item.matches(activeTab) ? activeTab : item.id)}
    >
      <item.icon className="h-4 w-4" />
      <span>{item.label}</span>
    </button>
  );

  const usageNavItem = (
    <button
      key={USAGE_NAV_ITEM.id}
      ref={usageButtonRef}
      type="button"
      className={`nav-item nav-item-group ${usageActive ? 'nav-item-group-active' : ''}`}
      aria-current={usageActive ? 'true' : undefined}
      aria-label={USAGE_NAV_ITEM.label}
      aria-haspopup={narrowRail ? 'menu' : undefined}
      aria-expanded={narrowRail ? usageMenuOpen : undefined}
      aria-controls={usageMenuOpen ? 'sidebar-usage-menu' : undefined}
      title={USAGE_NAV_ITEM.label}
      onClick={() => {
        if (narrowRail) {
          setUsageMenuRequested((open) => !open);
          return;
        }
        onTabChange(usageActive ? activeTab : USAGE_NAV_ITEM.id);
      }}
    >
      <USAGE_NAV_ITEM.icon className="h-4 w-4" />
      <span>{USAGE_NAV_ITEM.label}</span>
    </button>
  );

  const usageMenuRovingIndex = Math.max(0, USAGE_SUB_NAV_ITEMS.findIndex((item) => item.id === activeTab));
  const usageMenu = usageMenuOpen && createPortal(
    <div
      id="sidebar-usage-menu"
      className="theme-menu-popover sidebar-usage-menu"
      data-header-popover
      ref={usageMenuRef}
      role="menu"
      aria-label="用量子页"
      style={usageMenuStyle}
      onKeyDown={handleUsageMenuKeyDown}
    >
      <div className="theme-menu-heading" aria-hidden="true">用量</div>
      {USAGE_SUB_NAV_ITEMS.map((item, index) => {
        const current = activeTab === item.id;
        return (
          <button
            key={item.id}
            ref={(element) => { usageMenuItemRefs.current[index] = element; }}
            type="button"
            className="theme-menu-option"
            role="menuitemradio"
            aria-checked={current}
            tabIndex={index === usageMenuRovingIndex ? 0 : -1}
            onClick={() => {
              closeUsageMenu(true);
              onTabChange(item.id);
            }}
          >
            <span>{item.label}</span>
            {current && <Check className="theme-menu-check h-4 w-4" aria-hidden="true" />}
          </button>
        );
      })}
    </div>,
    document.body,
  );

  const renderUsageSubItem = (item: typeof USAGE_SUB_NAV_ITEMS[number]) => (
    <button
      key={item.id}
      type="button"
      className={`nav-item nav-sub-item ${activeTab === item.id ? 'nav-item-active' : ''}`}
      aria-current={activeTab === item.id ? 'page' : undefined}
      aria-label={item.label}
      title={`用量 · ${item.label}`}
      onClick={() => onTabChange(item.id)}
    >
      <item.icon className="h-4 w-4" aria-hidden="true" />
      <span>{item.label}</span>
    </button>
  );

  return (
    <aside
      className="app-sidebar window-drag-surface"
      data-vibrancy={nativeVibrancy ? 'native' : undefined}
      onMouseDown={handleWindowDragMouseDown}
      onDoubleClick={handleWindowDragDoubleClick}
    >
      <div className="sidebar-surface">
        <div className="sidebar-top">
          {/* Brand Header */}
          <div className="sidebar-brand">
            <div className="sidebar-logo">
              <TokenLedgerIcon className="sidebar-logo-mark" />
            </div>
            <div className="min-w-0">
              <div className="sidebar-title truncate">TokenLedger</div>
              <div className="sidebar-subtitle truncate">个人 AI 用量账本</div>
            </div>
          </div>

          {/* Short windows (down to 640×520) scroll the two lists while the
              brand stays draggable and the status card stays pinned below. */}
          <div
            ref={scrollRef}
            className="sidebar-scroll tl-scrollbar"
            data-window-drag-block
            data-overflow={scrollEdges.overflow || undefined}
            data-fade-top={scrollEdges.top || undefined}
            data-fade-bottom={scrollEdges.bottom || undefined}
          >
            {/* 1. Primary Navigation */}
            <nav ref={navIndicatorRef} className="sidebar-nav sidebar-nav-primary tl-seg" data-window-drag-block aria-label="主要页面导航">
              {narrowRail ? usageNavItem : <div className="sidebar-group-title sidebar-usage-heading" aria-hidden="true">用量</div>}
              {USAGE_SUB_NAV_ITEMS.map(renderUsageSubItem)}
              {modelAccessEnabled && (
                <>
                  <div className="sidebar-group-title" aria-hidden="true">模型接入</div>
                  {MODEL_NAV_ITEMS.map(renderNavItem)}
                </>
              )}
              {renderNavItem(SETTINGS_NAV_ITEM)}
            </nav>

            {/* 2. Tools & Highlights */}
            <div className="sidebar-group-title" aria-hidden="true">快捷工具与战报</div>
            <div className="sidebar-nav sidebar-tools" data-window-drag-block data-tool-count={toolCount} role="group" aria-label="快捷工具与战报">
              {onOpenShareCard && (
                <button
                  type="button"
                  className="nav-item sidebar-tool-item"
                  aria-label="生成数据战报卡片"
                  title="生成数据战报卡片"
                  onClick={onOpenShareCard}
                >
                  <Share2 className="h-4 w-4" />
                  <span>分享战报</span>
                </button>
              )}
              {/* T10.123 删除了这里的「桌面挂件」按钮：它只调 show_widget_window，
                  与单击托盘图标完全等价（其 title 自己都这么写），而挂件的用处是
                  主窗口没开时扫一眼——从开着的主窗口里召唤它，方向是反的。
                  两块挂件的开关现在都在设置 →「桌面挂件」分区。 */}
              <div className="sidebar-wallpaper-row" role="group" aria-label="快捷设置壁纸" aria-busy={wallpaperBusy || undefined} data-tool-count={wallpaperToolCount}>
                <button
                  type="button"
                  className="nav-item sidebar-tool-item sidebar-wallpaper-btn"
                  aria-label={wallpaperBusy ? '正在设置桌面壁纸' : '一键设置桌面壁纸'}
                  disabled={wallpaperBusy}
                  title={wallpaperActionTitle}
                  onClick={() => onWallpaper('desktop')}
                >
                  {wallpaperBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
                  <span>{wallpaperActionLabel}</span>
                </button>
                {showLockscreenControls && (
                  <button
                    type="button"
                    className="nav-item sidebar-tool-item sidebar-wallpaper-btn"
                    aria-label={wallpaperBusy ? '正在设置锁屏壁纸' : '一键设置锁屏壁纸'}
                    disabled={wallpaperBusy}
                    title={lockscreenWallpaperActionTitle}
                    onClick={() => onWallpaper('lockscreen')}
                  >
                    {wallpaperBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Monitor className="h-3.5 w-3.5" />}
                    <span>{lockscreenWallpaperActionLabel}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 3. Bottom Status & Quick Sync Strip */}
        <div className="sidebar-actions" data-window-drag-block>
          <div className="sidebar-status-card">
            <div
              className="sidebar-status-header"
              id="sidebar-cloud-status"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              title={cloudStatusLabel}
            >
              <span
                className={`sidebar-status-dot ${cloudReady ? 'is-online' : cloudAuthenticated ? 'is-warning' : 'is-offline'}${statusLive ? ' tl-live-dot' : ''}`}
                aria-hidden="true"
              />
              <span className="sidebar-status-text">{cloudStatusLabel}</span>
              <span className="sidebar-status-compact-label" aria-hidden="true">{compactCloudStatusLabel}</span>
            </div>
            <div className="sidebar-status-actions">
              <button
                type="button"
                className="sidebar-compact-btn"
                aria-label={scanActionAriaLabel}
                data-tooltip={scanActionTitle}
                disabled={busy.scan}
                aria-busy={busy.scan || undefined}
                onClick={onScan}
                title={scanActionTitle}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${busy.scan ? 'animate-spin' : ''}`} />
                <span>{scanActionLabel}</span>
              </button>
              <button
                type="button"
                className="sidebar-compact-btn"
                aria-label={syncActionAriaLabel}
                data-tooltip={syncActionTitle}
                disabled={syncDisabled}
                aria-busy={busy.sync || undefined}
                aria-describedby={syncRecoveryHint ? 'sidebar-sync-recovery-hint' : undefined}
                onClick={onSync}
                title={syncActionTitle}
              >
                <Cloud className={`h-3.5 w-3.5 ${busy.sync ? 'animate-spin' : ''}`} />
                <span>{syncActionLabel}</span>
              </button>
            </div>
            {syncRecoveryHint && (
              <>
                <span id="sidebar-sync-recovery-hint" className="sidebar-sync-recovery-hint">{syncRecoveryHint}</span>
                <button
                  className="sidebar-status-recovery"
                  type="button"
                  aria-label={syncRecoveryAriaLabel}
                  data-tooltip={syncRecoveryLabel}
                  title={syncRecoveryAriaLabel}
                  onClick={() => {
                    if (!cloudStatusKnown && onCheckCloudStatus) {
                      onCheckCloudStatus();
                    } else {
                      onTabChange('settings');
                    }
                  }}
                >
                  <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{syncRecoveryLabel}</span>
                </button>
              </>
            )}
          </div>

          <div className="sidebar-footer-version">
            <span>TokenLedger{appVersion ? ` v${appVersion}` : ''}</span>
          </div>
        </div>
      </div>
      {usageMenu}
    </aside>
  );
}

export default Sidebar;
