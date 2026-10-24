import { Cloud, Image as ImageIcon, LoaderCircle, Monitor, RefreshCw, Settings, Share2 } from 'lucide-react';
import { useState } from 'react';
import { TokenLedgerIcon } from './brand/TokenLedgerIcon';
import type { Tab, CloudStatus } from '../types';
import { isUsageTab } from '../types';
import { showsWindowsLockscreenControls } from '../utils/frontendContracts';
import { useSegmentedIndicator } from '../hooks/useSegmentedIndicator';
import { handleWindowDragDoubleClick, handleWindowDragMouseDown } from './AppHeader';
import { t, useLang } from '../i18n';

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
    return { label: t('shell.cloud.unknown'), compactLabel: t('shell.cloud.unknownShort') };
  }
  if (!authenticated) {
    return { label: t('shell.cloud.signedOut'), compactLabel: t('shell.cloud.signedOutShort') };
  }
  if (!capabilityVerified) {
    return { label: t('shell.cloud.unverified'), compactLabel: t('shell.cloud.unverifiedShort') };
  }
  if (!ready) {
    return { label: t('shell.cloud.unsynced'), compactLabel: t('shell.cloud.unsyncedShort') };
  }
  if (pendingUploads === null) {
    return { label: t('shell.cloud.pendingUnknown'), compactLabel: t('shell.cloud.pendingUnknownShort') };
  }
  if (pendingUploads > 0) {
    return { label: t('shell.cloud.pending', { count: pendingUploads }), compactLabel: t('shell.cloud.pendingShort') };
  }
  return { label: t('shell.cloud.ready'), compactLabel: t('shell.cloud.readyShort') };
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
const USAGE_NAV_ITEM: NavItem = { id: 'dashboard', get label() { return t('shell.nav.usage'); }, matches: isUsageTab };

const MODEL_NAV_ITEMS: NavItem[] = [
  { id: 'agents', get label() { return t('shell.nav.agents'); }, matches: (tab) => tab === 'agents' },
  { id: 'providers', get label() { return t('shell.nav.providers'); }, matches: (tab) => tab === 'providers' },
  { id: 'gateway', get label() { return t('shell.nav.gateway'); }, matches: (tab) => tab === 'gateway' || tab === 'gatewaylog' },
  { id: 'routing', get label() { return t('shell.nav.routing'); }, matches: (tab) => tab === 'routing' },
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
  // Labels read the current language directly; subscribing re-renders the bar when it changes.
  useLang();

  const statusLive = busy.scan || busy.sync;
  const { label: cloudStatusLabel, compactLabel: compactCloudStatusLabel } = cloudSidebarStatusCopy({
    authenticated: cloudAuthenticated,
    capabilityVerified: cloudCapabilityVerified,
    ready: cloudReady,
    pendingUploads,
    statusKnown: cloudStatusKnown,
  });
  const syncDisabled = busy.sync || !cloudStatusKnown || !cloudAuthenticated || !cloudCapabilityVerified;
  const wallpaperActionTitle = wallpaperBusy ? t('shell.wallpaper.busy') : t('shell.wallpaper.desktop');
  const lockscreenWallpaperActionTitle = wallpaperBusy ? t('shell.wallpaper.busy') : t('shell.wallpaper.lockscreen');
  const scanActionAriaLabel = busy.scan ? t('shell.scan.busy') : t('shell.scan.aria');
  const scanActionTitle = busy.scan ? t('shell.scan.busy') : t('shell.scan.title');
  const syncActionAriaLabel = busy.sync
    ? t('shell.sync.busy')
    : !cloudStatusKnown
      ? t('shell.sync.checkFirst')
      : t('shell.sync.now');
  const syncActionTitle = busy.sync
    ? t('shell.sync.busy')
    : !cloudStatusKnown
      ? t('shell.sync.checkInSettings')
      : !cloudAuthenticated
      ? t('shell.sync.signInFirst')
      : !cloudCapabilityVerified
        ? t('shell.sync.verifyFirst')
        : t('shell.sync.nowTitle');
  const syncRecoveryHint = !busy.sync && !cloudStatusKnown
    ? t('shell.sync.hintCheck')
    : !busy.sync && !cloudAuthenticated
    ? t('shell.sync.hintSignIn')
    : !busy.sync && !cloudCapabilityVerified
      ? t('shell.sync.hintVerify')
      : null;
  const syncRecoveryAriaLabel = !cloudStatusKnown
    ? t('shell.sync.recoverCheck')
    : !cloudAuthenticated
    ? t('shell.sync.recoverSignIn')
    : t('shell.sync.recoverVerify');
  const syncRecoveryLabel = t(!cloudStatusKnown ? 'shell.sync.recoverCheckShort' : !cloudAuthenticated ? 'shell.sync.recoverSignInShort' : 'shell.sync.recoverVerifyShort');
  const settingsActive = activeTab === 'settings';
  const navItems = modelAccessEnabled ? [...MODEL_NAV_ITEMS, USAGE_NAV_ITEM] : [USAGE_NAV_ITEM];

  return (
    <header
      className="app-topbar window-drag-surface"
      data-vibrancy={nativeVibrancy ? 'native' : undefined}
      onMouseDown={handleWindowDragMouseDown}
      onDoubleClick={handleWindowDragDoubleClick}
    >
      <div className="topbar-brand" title={`TokenLedger${appVersion ? ` v${appVersion}` : ''} · ${t('shell.brand')}`}>
        <TokenLedgerIcon className="topbar-logo-mark" />
        <span className="topbar-title">TokenLedger</span>
      </div>

      <nav ref={navIndicatorRef} className="topbar-nav tl-seg" data-window-drag-block aria-label={t('shell.nav.aria')}>
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
        <div className="topbar-tools" role="group" aria-label={t('shell.tools')} aria-busy={wallpaperBusy || undefined}>
          {onOpenShareCard && (
            <button
              type="button"
              className="topbar-icon-btn"
              aria-label={t('shell.shareCard')}
              title={t('shell.shareCard')}
              onClick={onOpenShareCard}
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          {/* T10.123 删除了「桌面挂件」按钮：它与单击托盘图标完全等价；两块挂件的开关在设置 →「桌面挂件」分区。 */}
          <button
            type="button"
            className="topbar-icon-btn"
            aria-label={wallpaperBusy ? t('shell.wallpaper.desktopBusy') : t('shell.wallpaper.desktopAction')}
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
              aria-label={wallpaperBusy ? t('shell.wallpaper.lockscreenBusy') : t('shell.wallpaper.lockscreenAction')}
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
          aria-label={t('shell.settings')}
          aria-current={settingsActive ? 'page' : undefined}
          title={t('shell.settings')}
          onClick={() => onTabChange('settings')}
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

export default Sidebar;
