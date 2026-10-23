import { Check, ChevronRight, Cloud, Smartphone, Sun, Moon, Circle } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useSegmentedIndicator } from '../hooks/useSegmentedIndicator';
import { isUsageTab, type CloudStatus, type DataScope, type Tab } from '../types';
import { focusAfterPopoverTrigger, useAnchoredPopover } from './anchoredPopover';
import { USAGE_SUB_OPTIONS, usageSubLabelForTab } from './usage/UsagePage';
import { USAGE_SUB_TABS } from '../utils/usageNavigation';

export type ThemeMode = 'auto' | 'light' | 'dark';

const THEME_LABELS: Record<ThemeMode, string> = {
  auto: '自动',
  light: '浅色',
  dark: '深色',
};

function scrollHeaderElement(element: HTMLElement, left: number, behavior: ScrollBehavior) {
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ left, behavior });
  } else {
    element.scrollLeft = left;
  }
}

export interface HeaderDataStatus {
  loading: boolean;
  stale: boolean;
  lastRefreshedAt?: string | null;
  /** 数据库信息未读到或读取失败时为 null（未知），不得显示为 0（GLB-01，T10.180）。 */
  unsyncedRecords: number | null;
  cloudCapabilityVerified: boolean;
  cloudFirstSyncCompleted: boolean;
}

interface AppHeaderProps {
  activeTab?: Tab;
  dataScope: DataScope;
  cloudStatus: CloudStatus;
  onScopeChange: (scope: DataScope) => void;
  onCloudScope: () => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  dataStatus: HeaderDataStatus;
  /** 用量子页的二级分段；不传时退回只读标题。 */
  onTabChange?: (tab: Tab) => void;
}

// This is the single window-drag contract for the desktop shell. Tauri's
// native drag-region listener must not be mixed with these handlers: the
// manual API is retained because it also works when the macOS window is
// already focused. Keep controls and scrollable areas inside an explicit
// block, while the remaining header/sidebar surface can initiate a drag.
const WINDOW_DRAG_BLOCK_SELECTOR = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[data-window-drag-block]',
  '.tl-scrollbar',
].join(',');

type WindowGestureEvent = Pick<
  ReactMouseEvent<HTMLElement>,
  'button' | 'currentTarget' | 'defaultPrevented' | 'detail' | 'target'
>;

/** Pure event guard exported so the drag/no-drag boundary can be unit tested. */
export function isWindowGesture(event: WindowGestureEvent, detail: 1 | 2): boolean {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.detail !== detail
    || typeof Element === 'undefined'
    || !(event.target instanceof Element)
    || !(event.currentTarget instanceof Element)
    || !event.currentTarget.contains(event.target)
  ) {
    return false;
  }

  return event.target.closest(WINDOW_DRAG_BLOCK_SELECTOR) === null;
}

export async function handleWindowDragMouseDown(event: ReactMouseEvent<HTMLElement>) {
  // The second press in a double-click is handled separately so one gesture
  // can never issue both startDragging and toggleMaximize.
  if (!isWindowGesture(event, 1)) return;

  event.preventDefault();
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startDragging();
  } catch (error) {
    console.error('Failed to start window dragging:', error);
  }
}

export async function handleWindowDragDoubleClick(event: ReactMouseEvent<HTMLElement>) {
  if (!isWindowGesture(event, 2)) return;

  event.preventDefault();
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().toggleMaximize();
  } catch (error) {
    console.error('Failed to toggle window maximize state:', error);
  }
}

/** Keep the cloud snapshot cutoff distinct from the local refresh timestamp. */
export function formatHeaderFreshnessLabel(
  dataScope: DataScope,
  refreshDate: string | null,
  refreshTime: string | null,
): string {
  if (!refreshDate || !refreshTime) {
    return dataScope === 'cloud' ? '数据时间未知' : '刷新时间未知';
  }
  return dataScope === 'cloud'
    ? `数据截至 ${refreshDate} ${refreshTime}`
    : `更新于 ${refreshDate} ${refreshTime}`;
}

export function AppHeader({
  activeTab = 'dashboard',
  dataScope,
  cloudStatus,
  onScopeChange,
  onCloudScope,
  themeMode,
  onThemeChange,
  dataStatus,
  onTabChange,
}: AppHeaderProps) {
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const themePopoverRef = useRef<HTMLDivElement>(null);
  const themeButtonRef = useRef<HTMLButtonElement>(null);
  const themeOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const headerControlsRef = useRef<HTMLDivElement>(null);
  const headerControlsCueRef = useRef<HTMLButtonElement>(null);
  const [hasMoreHeaderControls, setHasMoreHeaderControls] = useState(false);
  // One sliding selection pill per segmented group (T10.150); aria-pressed stays the source of truth.
  const scopeIndicatorRef = useSegmentedIndicator<HTMLDivElement>();
  const usageIndicatorRef = useSegmentedIndicator<HTMLElement>('[aria-current="page"]');
  const isSettingsSurface = activeTab === 'settings';
  const usageSurface = isUsageTab(activeTab);
  // 用量三个子页共用一个顶栏：元素、健康状态与命令不随子页变化（T10.276），标题是「用量 · 子页」
  // 面包屑（U-101，T10.277）。子页部分对读屏隐藏：内容区已用同一名称作可访问名称。
  const usageCrumb = usageSurface ? usageSubLabelForTab(activeTab) : null;
  const headerTitle = activeTab === 'settings' ? '设置与云端' : '用量';
  // 副标题只保留标题给不出的信息。原来三种取值分别是「连接、额度、壁纸与数据管理」
  // 「检索本地与云端的完整使用记录」「仅此电脑的使用记录」——都是把标题换句话再说一遍，
  // 叠在页内标题上就变成同一件事写四行。登录后的邮箱是标题里没有的，留下。
  const headerSubtitle = !isSettingsSurface && cloudStatus.authenticated
    ? cloudStatus.email
    : '';
  const headerControlsLabel = isSettingsSurface
    ? '主题设置'
    : '顶部控制器，可横向滚动查看更多命令';
  const themePopoverStyle = useAnchoredPopover(themeMenuOpen, themeButtonRef, themePopoverRef, 8, 164);

  useEffect(() => {
    if (!themeMenuOpen) return undefined;
    const closeFromOutside = (event: Event) => {
      if (
        event.target instanceof Node
        && !themeMenuRef.current?.contains(event.target)
        && !themePopoverRef.current?.contains(event.target)
      ) {
        setThemeMenuOpen(false);
      }
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setThemeMenuOpen(false);
      themeButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', closeFromOutside);
    document.addEventListener('focusin', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    return () => {
      document.removeEventListener('mousedown', closeFromOutside);
      document.removeEventListener('focusin', closeFromOutside);
      document.removeEventListener('keydown', closeFromEscape);
    };
  }, [themeMenuOpen]);

  useEffect(() => {
    if (!themeMenuOpen) return undefined;
    const selectedIndex = (Object.keys(THEME_LABELS) as ThemeMode[]).indexOf(themeMode);
    const frame = window.requestAnimationFrame(() => themeOptionRefs.current[selectedIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [themeMenuOpen, themeMode]);

  useEffect(() => {
    const controls = headerControlsRef.current;
    if (!controls) return;
    // Each surface has a different first-frame command priority. Do not carry
    // a previous surface's horizontal position into the next task.
    // jsdom and older embedded WebViews may expose scrollLeft without the
    // smooth scrolling helper. Reset the position without making a benign
    // surface switch crash the whole shell.
    scrollHeaderElement(controls, 0, 'auto');
  }, [activeTab]);

  useEffect(() => {
    const controls = headerControlsRef.current;
    if (!controls) return undefined;

    const updateScrollHint = () => {
      const hasMore = controls.scrollWidth - controls.clientWidth - controls.scrollLeft > 2;
      if (!hasMore && document.activeElement === headerControlsCueRef.current) {
        const focusable = [...controls.querySelectorAll<HTMLElement>(
          'button, select, input, textarea, a[href], [tabindex]:not([tabindex="-1"])',
        )];
        focusable[focusable.length - 1]?.focus();
      }
      setHasMoreHeaderControls(hasMore);
    };

    const keepFocusedControlVisible = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !controls.contains(target)) return;
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }
      updateScrollHint();
    };

    updateScrollHint();
    controls.addEventListener('scroll', updateScrollHint, { passive: true });
    controls.addEventListener('focusin', keepFocusedControlVisible);
    window.addEventListener('resize', updateScrollHint);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollHint);
    resizeObserver?.observe(controls);

    return () => {
      controls.removeEventListener('scroll', updateScrollHint);
      controls.removeEventListener('focusin', keepFocusedControlVisible);
      window.removeEventListener('resize', updateScrollHint);
      resizeObserver?.disconnect();
    };
  }, [activeTab, dataScope]);

  const scrollHeaderControlsForward = () => {
    const controls = headerControlsRef.current;
    if (!controls) return;
    const maxScrollLeft = Math.max(0, controls.scrollWidth - controls.clientWidth);
    const nextScrollLeft = Math.min(
      maxScrollLeft,
      controls.scrollLeft + Math.max(160, Math.round(controls.clientWidth * 0.72)),
    );
    scrollHeaderElement(
      controls,
      nextScrollLeft,
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    );
  };

  const handleHeaderControlsCueKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    scrollHeaderControlsForward();
  };

  const handleThemeMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = Object.keys(THEME_LABELS) as ThemeMode[];
    if (event.key === 'Tab') {
      event.preventDefault();
      setThemeMenuOpen(false);
      if (themeButtonRef.current) {
        if (event.shiftKey) themeButtonRef.current.focus();
        else focusAfterPopoverTrigger(themeButtonRef.current);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setThemeMenuOpen(false);
      themeButtonRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = themeOptionRefs.current.findIndex((option) => option === document.activeElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? keys.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1 + keys.length) % keys.length
          : (currentIndex - 1 + keys.length) % keys.length;
    themeOptionRefs.current[nextIndex]?.focus();
  };

  const refreshedAt = dataStatus.lastRefreshedAt ? new Date(dataStatus.lastRefreshedAt) : null;
  const hasRefreshTimestamp = refreshedAt && !Number.isNaN(refreshedAt.getTime());
  const refreshTime = hasRefreshTimestamp
    ? refreshedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : null;
  const refreshDate = hasRefreshTimestamp
    ? `${refreshedAt.getMonth() + 1}/${refreshedAt.getDate()}`
    : null;
  const refreshLabel = formatHeaderFreshnessLabel(dataScope, refreshDate, refreshTime);
  const staleLabel = hasRefreshTimestamp
    ? `最近可信 ${refreshDate} ${refreshTime}`
    : '显示最近可信数据';
  const healthLabel = dataStatus.loading
    ? '正在更新'
    : dataScope === 'cloud' && !dataStatus.cloudCapabilityVerified
      ? '待验证 Stats v2'
      : dataScope === 'cloud' && !dataStatus.cloudFirstSyncCompleted
        ? '待首次同步'
        : dataScope === 'cloud' && dataStatus.unsyncedRecords === null
          ? '待上传数未知'
          : dataScope === 'cloud' && dataStatus.unsyncedRecords !== null && dataStatus.unsyncedRecords > 0
            ? `${dataStatus.unsyncedRecords} 条待上传`
            : dataStatus.stale
              ? staleLabel
              : refreshLabel;
  const healthTone = dataStatus.loading
    || dataStatus.stale
    || (dataScope === 'cloud' && dataStatus.unsyncedRecords === null)
    || (dataStatus.unsyncedRecords !== null && dataStatus.unsyncedRecords > 0)
    ? 'is-warning'
    : dataScope === 'cloud' && (!dataStatus.cloudCapabilityVerified || !dataStatus.cloudFirstSyncCompleted)
      ? 'is-warning'
      : 'is-ready';
  const healthHasTimestamp = hasRefreshTimestamp && (healthLabel === refreshLabel || healthLabel === staleLabel);

  return (
    <header
      className="app-header window-drag-surface"
      data-surface={usageSurface ? 'usage' : activeTab}
      onMouseDown={handleWindowDragMouseDown}
      onDoubleClick={handleWindowDragDoubleClick}
    >
      <div className="toolbar-brand min-w-0">
        {usageSurface && onTabChange ? (
          <nav ref={usageIndicatorRef} className="usage-subnav tl-seg" data-window-drag-block aria-label="用量子页">
            {USAGE_SUB_OPTIONS.map((option) => {
              const tab = USAGE_SUB_TABS[option.id];
              const current = activeTab === tab;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={current ? 'active' : ''}
                  aria-current={current ? 'page' : undefined}
                  title={`用量 · ${option.label}`}
                  onClick={() => onTabChange(tab)}
                >
                  {option.label}
                </button>
              );
            })}
          </nav>
        ) : (
          <div className="toolbar-title truncate">
            {usageCrumb ? (
              <>
                <span className="toolbar-title-parent">{headerTitle}</span>
                <span className="toolbar-title-crumb" aria-hidden="true">
                  <span className="toolbar-title-sep"> · </span>{usageCrumb}
                </span>
              </>
            ) : headerTitle}
          </div>
        )}
        {headerSubtitle && (
          <div className="toolbar-subtitle truncate">
            {headerSubtitle}
          </div>
        )}
        {/* 数据新鲜度说的是看板/明细读到的那份统计数据，设置页没有这回事。行为分析结果自己的
            「正在刷新… / 更新于」仍只写在页内，顶栏这枚胶囊在三个子页一致（T10.276）。 */}
        {!isSettingsSurface && <div className={`toolbar-health ${healthTone}`} role="status" aria-live="polite" title={`${dataScope === 'cloud' ? '云端汇总' : '本机数据'} · ${healthLabel}`}>
          <span className={`toolbar-health-dot${dataStatus.loading ? ' tl-live-dot' : ''}`} aria-hidden="true" />
          <span>{dataScope === 'cloud' ? '云端汇总' : '本机数据'}</span>
          <span className="toolbar-health-label">
            {healthHasTimestamp ? (
              <time dateTime={dataStatus.lastRefreshedAt || undefined}>{healthLabel}</time>
            ) : healthLabel}
          </span>
        </div>}
      </div>

      <div className="header-controls-shell" data-window-drag-block>
        <div
          ref={headerControlsRef}
          id="header-controls"
          className="header-controls"
          role="group"
          aria-label={headerControlsLabel}
          data-window-drag-block
        >
        {!isSettingsSurface && <>
        <div ref={scopeIndicatorRef} className="segmented tl-seg" role="group" aria-label="数据范围">
          <button
            className={dataScope === 'local' ? 'active' : ''}
            aria-pressed={dataScope === 'local'}
            onClick={() => onScopeChange('local')}
          >
            <Smartphone className="h-3.5 w-3.5" />
            本地机器
          </button>
          <button
            className={dataScope === 'cloud' ? 'active' : ''}
            aria-pressed={dataScope === 'cloud'}
            onClick={onCloudScope}
          >
            <Cloud className="h-3.5 w-3.5" />
            云端汇总
          </button>
        </div>

        </>}

        <div className="theme-menu" ref={themeMenuRef}>
          <button
            ref={themeButtonRef}
            className="icon-command theme-toggle"
            title={`主题：${THEME_LABELS[themeMode]}`}
            aria-label={`主题：${THEME_LABELS[themeMode]}`}
            aria-haspopup="menu"
            aria-expanded={themeMenuOpen}
            onClick={() => setThemeMenuOpen((open) => !open)}
          >
            {themeMode === 'light' ? <Sun className="h-4 w-4" /> : themeMode === 'dark' ? <Moon className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
            <span>主题</span>
            <span className="theme-mode-label">{THEME_LABELS[themeMode]}</span>
          </button>
          {themeMenuOpen && createPortal(
            <div
              className="theme-menu-popover"
              data-header-popover
              ref={themePopoverRef}
              role="menu"
              aria-label="主题模式"
              style={themePopoverStyle}
              onKeyDown={handleThemeMenuKeyDown}
            >
              <div className="theme-menu-heading">主题模式</div>
              {(Object.keys(THEME_LABELS) as ThemeMode[]).map((mode) => (
                <button
                  key={mode}
                  ref={(element) => { themeOptionRefs.current[(Object.keys(THEME_LABELS) as ThemeMode[]).indexOf(mode)] = element; }}
                  className="theme-menu-option"
                  role="menuitemradio"
                  aria-checked={themeMode === mode}
                  tabIndex={themeMode === mode ? 0 : -1}
                  onClick={(event) => {
                    onThemeChange(mode);
                    setThemeMenuOpen(false);
                    themeButtonRef.current?.focus();
                    // Pointer users should return to the leading context controls
                    // after choosing a theme; keyboard users keep the focused
                    // trigger in view so the next Tab step remains predictable.
                    if (event.detail > 0) {
                      window.requestAnimationFrame(() => {
                        const controls = headerControlsRef.current;
                        if (controls) scrollHeaderElement(controls, 0, 'auto');
                      });
                    }
                  }}
                >
                  {mode === 'light' ? <Sun className="h-4 w-4" /> : mode === 'dark' ? <Moon className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                  <span>{THEME_LABELS[mode]}</span>
                  {themeMode === mode && <Check className="theme-menu-check h-4 w-4" aria-hidden="true" />}
                </button>
              ))}
            </div>,
            document.body,
          )}
        </div>
        </div>
        <button
          ref={headerControlsCueRef}
          className={`header-controls-scroll-cue${hasMoreHeaderControls ? ' is-visible' : ''}`}
          type="button"
          aria-label="向右查看更多顶部命令"
          title="向右查看更多顶部命令"
          aria-controls="header-controls"
          aria-hidden={!hasMoreHeaderControls}
          tabIndex={hasMoreHeaderControls ? 0 : -1}
          onClick={scrollHeaderControlsForward}
          onKeyDown={handleHeaderControlsCueKeyDown}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

export default AppHeader;
