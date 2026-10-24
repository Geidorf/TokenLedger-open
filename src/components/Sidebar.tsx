import { Cloud, Image as ImageIcon, LoaderCircle, Monitor, RefreshCw, Settings, Share2 } from 'lucide-react';
import { useState } from 'react';
import { TokenLedgerIcon } from './brand/TokenLedgerIcon';
import type { Tab, CloudStatus } from '../types';
import { isUsageTab } from '../types';
import { showsWindowsLockscreenControls } from '../utils/frontendContracts';
import { useSegmentedIndicator } from '../hooks/useSegmentedIndicator';
import { handleWindowDragDoubleClick, handleWindowDragMouseDown } from './AppHeader';

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
  matches: (tab: Tab) => boolean;
}

/**
 * 顶栏一级分段顺序：Agent、供应商、网关、路由、用量；设置收进右侧齿轮。
 * 用量的四个子页（概览、请求、会话、额度）由页头的二级分段切换（见 AppHeader）。
 */
const USAGE_NAV_ITEM: NavItem = { id: 'dashboard', label: '用量', matches: isUsageTab };

const MODEL_NAV_ITEMS: NavItem[] = [
  { id: 'agents', label: 'Agent', matches: (tab) => tab === 'agents' },
  { id: 'providers', label: '供应商', matches: (tab) => tab === 'providers' },
  { id: 'gateway', label: '网关', matches: (tab) => tab === 'gateway' || tab === 'gatewaylog' },
  { id: 'routing', label: '路由', matches: (tab) => tab === 'routing' },
];

/**
 * Only a real macOS Tauri window has the NSVisualEffectView behind the
 * webview. Browser fixtures (including mockIPC, which has no window
 * metadata) get the opaque bar instead of a translucent slab.
 */
function hasNativeVibrancy() {
  if (typeof window === 'undefined' || document.documentElement.dataset.platform !== 'macos') return false;
  const internals = (window as Window & { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
  return Boolean(internals?.metadata?.currentWindow?.label);
}

/**
 * 窗口顶栏：左侧品牌，中间一级页面分段，右侧扫描、同步、
 * 战报、壁纸与设置等图标动作。整条栏是窗口拖动区，控件除外。
 */
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
  // The active page's thumb slides between segments (T10.150); items keep aria-current.
  const navIndicatorRef = useSegmentedIndicator<HTMLElement>('[aria-current="page"]');
  const [nativeVibrancy] = useState(hasNativeVibrancy);

  const statusLive = busy.scan || busy.sync;
  const { label: cloudStatusLabel, compactLabel: compactCloudStatusLabel } = cloudSidebarStatusCopy({
    authenticated: cloudAuthenticated,
    capabilityVerified: cloudCapabilityVerified,
    ready: cloudReady,
    pendingUploads,
    statusKnown: cloudStatusKnown,
  });
  const syncDisabled = busy.sync || !cloudStatusKnown || !cloudAuthenticated || !cloudCapabilityVerified;
  const wallpaperActionTitle = wallpaperBusy ? '正在写入系统壁纸' : '设置桌面壁纸';
  const lockscreenWallpaperActionTitle = wallpaperBusy ? '正在写入系统壁纸' : '设置锁屏壁纸';
  const scanActionAriaLabel = busy.scan ? '正在扫描本地各 AI 工具日志' : '扫描本地日志';
  const scanActionTitle = busy.scan ? '正在扫描本地各 AI 工具日志' : '立即扫描本地各 AI 工具日志';
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
  const settingsActive = activeTab === 'settings';
  const navItems = modelAccessEnabled ? [...MODEL_NAV_ITEMS, USAGE_NAV_ITEM] : [USAGE_NAV_ITEM];

  return (
    <header
      className="app-topbar window-drag-surface"
      data-vibrancy={nativeVibrancy ? 'native' : undefined}
      onMouseDown={handleWindowDragMouseDown}
      onDoubleClick={handleWindowDragDoubleClick}
    >
      <div className="topbar-brand" title={`TokenLedger${appVersion ? ` v${appVersion}` : ''} · 个人 AI 用量账本`}>
        <TokenLedgerIcon className="topbar-logo-mark" />
        <span className="topbar-title">TokenLedger</span>
      </div>

      <nav ref={navIndicatorRef} className="topbar-nav tl-seg" data-window-drag-block aria-label="主要页面导航">
        {navItems.map((item) => {
          const current = item.matches(activeTab);
          return (
            <button
              key={item.id}
              type="button"
              className={`topbar-nav-item${current ? ' is-active' : ''}`}
              aria-current={current ? 'page' : undefined}
              onClick={() => onTabChange(current ? activeTab : item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="topbar-actions" data-window-drag-block>
        <div
          className="topbar-status"
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
          <span className="sr-only">{cloudStatusLabel}</span>
          <span className="topbar-status-label" aria-hidden="true">{compactCloudStatusLabel}</span>
        </div>
        {syncRecoveryHint && (
          <>
            <span id="sidebar-sync-recovery-hint" className="sr-only">{syncRecoveryHint}</span>
            <button
              className="topbar-text-btn"
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
              {syncRecoveryLabel}
            </button>
          </>
        )}
        <button
          type="button"
          className="topbar-icon-btn"
          aria-label={scanActionAriaLabel}
          data-tooltip={scanActionTitle}
          disabled={busy.scan}
          aria-busy={busy.scan || undefined}
          onClick={onScan}
          title={scanActionTitle}
        >
          <RefreshCw className={`h-4 w-4 ${busy.scan ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="topbar-icon-btn"
          aria-label={syncActionAriaLabel}
          data-tooltip={syncActionTitle}
          disabled={syncDisabled}
          aria-busy={busy.sync || undefined}
          aria-describedby={syncRecoveryHint ? 'sidebar-sync-recovery-hint' : undefined}
          onClick={onSync}
          title={syncActionTitle}
        >
          <Cloud className={`h-4 w-4 ${busy.sync ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
        <span className="topbar-divider" aria-hidden="true" />
        <div className="topbar-tools" role="group" aria-label="快捷工具与战报" aria-busy={wallpaperBusy || undefined}>
          {onOpenShareCard && (
            <button
              type="button"
              className="topbar-icon-btn"
              aria-label="生成数据战报卡片"
              title="生成数据战报卡片"
              onClick={onOpenShareCard}
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          {/* T10.123 删除了「桌面挂件」按钮：它与单击托盘图标完全等价；两块挂件的开关在设置 →「桌面挂件」分区。 */}
          <button
            type="button"
            className="topbar-icon-btn"
            aria-label={wallpaperBusy ? '正在设置桌面壁纸' : '一键设置桌面壁纸'}
            disabled={wallpaperBusy}
            title={wallpaperActionTitle}
            onClick={() => onWallpaper('desktop')}
          >
            {wallpaperBusy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ImageIcon className="h-4 w-4" aria-hidden="true" />}
          </button>
          {showLockscreenControls && (
            <button
              type="button"
              className="topbar-icon-btn"
              aria-label={wallpaperBusy ? '正在设置锁屏壁纸' : '一键设置锁屏壁纸'}
              disabled={wallpaperBusy}
              title={lockscreenWallpaperActionTitle}
              onClick={() => onWallpaper('lockscreen')}
            >
              {wallpaperBusy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Monitor className="h-4 w-4" aria-hidden="true" />}
            </button>
          )}
        </div>
        <button
          type="button"
          className={`topbar-icon-btn${settingsActive ? ' is-active' : ''}`}
          aria-label="设置与云端"
          aria-current={settingsActive ? 'page' : undefined}
          title="设置与云端"
          onClick={() => onTabChange('settings')}
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

export default Sidebar;
