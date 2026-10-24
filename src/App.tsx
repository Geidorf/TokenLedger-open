import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from './utils/useTheme';
import { invoke } from '@tauri-apps/api/core';

import { AppHeader } from './components/AppHeader';
import { DashboardTab, dashboardQueryIdentity } from './components/DashboardTab';
import { BehaviorAnalysisView } from './components/BehaviorAnalysisView';
import { UsagePage, usageSubForTab } from './components/usage/UsagePage';
import { UsageAllowancesView } from './components/usage/UsageAllowancesView';
import { UsageToolbar } from './components/usage/UsageToolbar';
import { LoadingSkeleton } from './components/LoadingSkeleton';
import { Sidebar } from './components/Sidebar';
import { Toast } from './components/Toast';
import { ConfirmDialog } from './components/ConfirmDialog';
import { FirstRunGuide } from './features/onboarding/FirstRunGuide';
import {
  cloudStatsIdentity,
  clearCloudStatsSnapshots,
  hasCloudCapability,
  invalidateRequest,
} from './utils/frontendContracts';

import {
  AppSettings,
  BusyState,
  CloudConfig,
  isModelTab,
  Tab,
  ToastMessage,
  ToastType,
  UsageDetailsResponse,
  isUsageTab,
} from './types';
import type { DetailFilters } from './components/LogsTable';
import type { EntitySelection } from './hooks/useEntityDashboard';

import { readPersistedCloudSetup, useCloud } from './hooks/useCloud';
import { useQuota } from './hooks/useQuota';
import { useSettings } from './hooks/useSettings';
import { useModelAccessRedirect } from './features/gateway/useModelAccessRedirect';
import { EMPTY_DETAIL_FILTERS, useUsageDetails } from './hooks/useUsageDetails';
import { useEntityDashboard } from './hooks/useEntityDashboard';
import { useStats } from './hooks/useStats';
import { useBehaviorAnalysis } from './hooks/useBehaviorAnalysis';
import { useProjectDimension } from './hooks/useProjectDimension';
import { requestProjectDimensionFocus } from './utils/projectDimension';
import { legacySettingsRedirect } from './utils/settingsNavigation';
import { directTabFromHash, useHashNavigation } from './hooks/useHashNavigation';
import { dayDrillCopy, useDayDrill } from './hooks/useDayDrill';
import type { ConfirmationRequest, RequestConfirmation } from './utils/confirmation';

const AndroidDashboardPrototype = lazy(() => import('./prototypes/AndroidDashboardPrototype'));
const ModelWorkspacePrototype = lazy(() => import('./prototypes/ModelWorkspacePrototype'));
const EntityDashboardModal = lazy(() => import('./components/EntityDashboardModal'));
const LiveWallpaperView = lazy(() => import('./components/LiveWallpaperView').then((module) => ({ default: module.LiveWallpaperView })));
const LogsTable = lazy(() => import('./components/LogsTable'));
const ModelWorkspaceContent = lazy(() => import('./features/gateway/ModelWorkspace'));
const ModelWorkspaceHeader = lazy(() => import('./features/gateway/ModelWorkspace').then((module) => ({ default: module.ModelWorkspaceHeader })));
const SettingsTab = lazy(() => import('./components/SettingsTab'));
const ShareCardModal = lazy(() => import('./components/ShareCardModal'));
const WidgetView = lazy(() => import('./components/WidgetView'));

function currentTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function initialTabFromLocation(): Tab {
  const redirect = legacySettingsRedirect(window.location.hash);
  if (redirect) {
    window.history.replaceState(null, '', `#${redirect}`);
    return 'settings';
  }
  const directTab = directTabFromHash(window.location.hash);
  if (directTab) return directTab;
  return window.location.hash.startsWith('#settings-') ? 'settings' : 'dashboard';
}

function MainApp() {
  const theme = useTheme();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const installSingleInstanceRestore = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const cleanup = await listen('single-instance-restore', async () => {
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const window = getCurrentWindow();
            await window.show();
            await window.unminimize();
            await window.setFocus();
          } catch (error) {
            console.error('Failed to restore TokenLedger from a secondary launch:', error);
          }
        });
        if (cancelled) cleanup();
        else unlisten = cleanup;
      } catch {
        // Browser fixtures and non-Tauri previews do not expose the native
        // event bridge; the desktop runtime still installs it above.
      }
    };

    void installSingleInstanceRestore();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Tab & Scroll state
  const [activeTab, setActiveTab] = useState<Tab>(() => initialTabFromLocation());
  const contentRef = useRef<HTMLElement>(null);
  const tabScrollPositions = useRef<Record<Tab, number>>({ dashboard: 0, logs: 0, behavior: 0, allowances: 0, settings: 0, agents: 0, providers: 0, gateway: 0, routing: 0 });
  const [gatewayRefreshKey, setGatewayRefreshKey] = useState(0);
  const [settingsAnchor, setSettingsAnchor] = useState<string | null>(null);

  // UI feedback state
  const [busy, setBusy] = useState<BusyState>({
    scan: false, sync: false, wallpaper: false, auth: false,
    config: false, settings: false, prices: false, db: false,
  });
  const [shareCardOpen, setShareCardOpen] = useState(false);
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const confirmationResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const showMessage = useCallback((type: ToastType, text: string) => setMessage({ type, text }), []);
  const requestConfirmation = useCallback<RequestConfirmation>((request) => new Promise((resolve) => {
    confirmationResolverRef.current?.(false);
    confirmationResolverRef.current = resolve;
    setConfirmation(request);
  }), []);
  const settleConfirmation = useCallback((confirmed: boolean) => {
    const resolve = confirmationResolverRef.current;
    confirmationResolverRef.current = null;
    setConfirmation(null);
    resolve?.(confirmed);
  }, []);

  useEffect(() => () => {
    confirmationResolverRef.current?.(false);
    confirmationResolverRef.current = null;
  }, []);

  const changeTab = useCallback((next: Tab, reset = false) => {
    setActiveTab((currentTab) => {
      if (next === currentTab) {
        if (reset && contentRef.current) contentRef.current.scrollTop = 0;
        return currentTab;
      }
      if (contentRef.current) tabScrollPositions.current[currentTab] = contentRef.current.scrollTop;
      if (reset) tabScrollPositions.current[next] = 0;
      window.requestAnimationFrame(() => {
        if (contentRef.current) contentRef.current.scrollTop = tabScrollPositions.current[next];
      });
      return next;
    });
  }, []);

  // 挂件/桌面小组件里的“设置”：原生侧拉起主窗口后广播 `open-settings`，
  // 这里切到设置页并滚到对应分区（T10.110）。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const installOpenSettings = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const cleanup = await listen<{ anchor?: string }>('open-settings', (event) => {
          const redirect = legacySettingsRedirect(event.payload?.anchor);
          if (redirect) {
            setSettingsAnchor(redirect);
            changeTab('settings');
            return;
          }
          setSettingsAnchor(event.payload?.anchor || 'settings-scan');
          changeTab('settings');
        });
        if (cancelled) cleanup();
        else unlisten = cleanup;
      } catch {
        // 非 Tauri 环境没有事件桥；桌面运行时由原生侧发出该事件。
      }
    };

    void installOpenSettings();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [changeTab]);

  useHashNavigation(changeTab);

  // 1. Cloud Hook
  const clearCloudScopedState = useCallback(() => {
    invalidateRequest(statsRequestIdRef);
    invalidateRequest(detailRequestIdRef);
    invalidateRequest(entityRequestIdRef);
    if (lastTrustedStatsRef.current) {
      clearCloudStatsSnapshots(lastTrustedStatsRef.current);
    }
    setStatsState(null);
    setDeviceListState([]);
    setDetailsState(null);
    setEntitySelectionState(null);
    setEntityDashboardState(null);
    setStatsErrorState('');
    setStatsErrorActionState(null);
    setDetailsErrorState('');
    setEntityErrorState('');
    // 身份变化时清理统计快照；账户绑定的设置状态由 useCloud 独立恢复。
    // 此回调传给 useCloud，必须保持恒定身份。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cloud = useCloud({
    showMessage,
    onClearCloudScopedState: clearCloudScopedState,
    currentTimezone,
  });

  // 2. Settings Hook
  const settings = useSettings({
    showMessage,
    confirm: requestConfirmation,
    loadStats: () => statsHook.loadStats(),
    loadQuotas: () => quota.loadQuotas(),
    loadQuotaSyncStatus: () => quota.loadQuotaSyncStatus(),
    cloudStatus: cloud.cloudStatus,
    cloudSetup: cloud.cloudSetup,
    setSettingsAnchor,
    setBusy,
  });

  // 3. Quota Hook
  const quota = useQuota({
    showMessage,
    confirm: requestConfirmation,
    loadSettings: settings.loadSettings,
    saveAppSettings: settings.saveAppSettings,
    appSettings: settings.appSettings,
    setAppSettings: settings.setAppSettings,
    clearPendingSettings: settings.clearPendingSettings,
    setBusy,
  });

  // 4. Stats Hook. Declared before the detail hooks so they can consume its
  // real query context; the detail/entity callbacks useStats needs from them
  // are forwarded through refs to break the declaration cycle.
  const loadDetailsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const setDetailFiltersRef = useRef<React.Dispatch<React.SetStateAction<DetailFilters>>>(() => {});
  const setDetailsRef = useRef<React.Dispatch<React.SetStateAction<UsageDetailsResponse | null>>>(() => {});
  const setEntitySelectionRef = useRef<React.Dispatch<React.SetStateAction<EntitySelection | null>>>(() => {});
  const forwardLoadDetails = useCallback(() => loadDetailsRef.current(), []);
  const forwardSetDetailFilters = useCallback<React.Dispatch<React.SetStateAction<DetailFilters>>>(
    (value) => setDetailFiltersRef.current(value),
    [],
  );
  const forwardSetDetails = useCallback<React.Dispatch<React.SetStateAction<UsageDetailsResponse | null>>>(
    (value) => setDetailsRef.current(value),
    [],
  );
  const forwardSetEntitySelection = useCallback<React.Dispatch<React.SetStateAction<EntitySelection | null>>>(
    (value) => setEntitySelectionRef.current(value),
    [],
  );

  const statsHook = useStats({
    showMessage,
    activeCloudConfig: cloud.activeCloudConfig,
    cloudStatus: cloud.cloudStatus,
    cloudStatusKnown: cloud.cloudStatusKnown,
    appSettings: settings.appSettings,
    setCloudSetup: cloud.setCloudSetup,
    refreshCloudStatus: cloud.refreshCloudStatus,
    loadDbInfo: settings.loadDbInfo,
    loadQuotaSyncStatus: quota.loadQuotaSyncStatus,
    loadSettings: async () => { await settings.loadSettings(); },
    loadPrices: settings.loadPrices,
    pricesDirty: settings.pricesDirty,
    activeTab,
    loadDetails: forwardLoadDetails,
    setDetailFilters: forwardSetDetailFilters,
    setDetails: forwardSetDetails,
    setEntitySelection: forwardSetEntitySelection,
    showTotalTokens: settings.showTotalTokens,
    changeTab,
    setSettingsAnchor,
    setBusy,
    currentTimezone,
  });

  // T10.163 复核修复（P2-1/P2-2/R2-2）：EntityDashboardModal 的「占总预估
  // 费用」需要一个与实体查询同源的全局总数做分母；这里只搭桥传值（含
  // generatedAt），逐字段可比性判定与新鲜度比较都在 EntityDashboardModal
  // 内部（sameCostQueryScope / sameFreshnessWindow）完成。R2-2 更正：上一版
  // 这里写"Stats v2 契约没有给实体看板自身的新鲜度字段"不成立——本地与云端
  // 的实体看板响应都带 meta.generatedAt，详见本任务日志复核修复 R2-2 小节与
  // 组件内文档注释。
  const globalCostContext = useMemo(() => (
    statsHook.stats
      ? {
          totalCost: statsHook.stats.summary.totalCost,
          query: statsHook.stats.meta?.query ?? null,
          scope: statsHook.dataScope,
          stale: statsHook.stats.meta?.stale ?? false,
          generatedAt: statsHook.stats.meta?.generatedAt ?? null,
        }
      : null
  ), [statsHook.stats, statsHook.dataScope]);

  const behaviorAnalysis = useBehaviorAnalysis({
    scope: statsHook.dataScope,
    range: statsHook.range,
    customRange: statsHook.customRange,
    timezone: currentTimezone(),
    active: activeTab === 'behavior',
  });
  const projectDimension = useProjectDimension(activeTab === 'behavior');

  // react-hooks/exhaustive-deps 无法把 `statsHook.loadStats` 这类成员访问收窄成
  // 稳定引用，只会要求把整个 statsHook 放进依赖数组——而 hook 每次渲染都返回新
  // 对象，那等于让下面的 effect 每帧重跑。先解构出具体成员，依赖既精确又可被
  // 规则静态验证。
  const { loadStats, triggerSync } = statsHook;
  const { loadQuotas, loadQuotaSyncStatus } = quota;
  const { refreshCloudStatus } = cloud;

  // 5. Usage Details Hook, on the stats hook's real query context.
  const usageDetails = useUsageDetails({
    dataScope: statsHook.dataScope,
    range: statsHook.range,
    customRange: statsHook.customRange,
    deviceFilter: statsHook.deviceFilter,
    stats: statsHook.stats,
    statsError: statsHook.statsError,
    currentTimezone,
  });

  // 6. Entity Dashboard Hook
  const entityDashboard = useEntityDashboard({
    dataScope: statsHook.dataScope,
    range: statsHook.range,
    customRange: statsHook.customRange,
    deviceFilter: statsHook.deviceFilter,
    activeTab,
    detailFilters: usageDetails.detailFilters,
    setDetailFilters: usageDetails.setDetailFilters,
    stats: statsHook.stats,
    currentTimezone,
    setMessage,
    changeTab,
  });

  // 7. Overview day drill-down (audit P0-1): a single-day custom range with
  // cleared filters, plus the remembered origin behind the details page's
  // "return" chip. Disabled under cloud scope, where custom ranges are refused.
  const notifyDayDrillExit = useCallback((notice: string) => showMessage('info', notice), [showMessage]);
  const dayDrill = useDayDrill({
    scope: statsHook.dataScope,
    activeTab,
    range: statsHook.range,
    customRange: statsHook.customRange,
    filters: usageDetails.detailFilters,
    changeRange: statsHook.changeRange,
    setFilters: usageDetails.setDetailFilters,
    changeTab,
    onScopeExit: notifyDayDrillExit,
  });
  // Review P2-1: the review cannot follow into cloud scope. Leave it in the
  // same click, before the switch, so the first cloud request already uses the
  // origin range. Mirrors selectCloudScope's guard: when that only redirects to
  // settings, the review stays as it is.
  const { leaveForScope: leaveDayDrillForScope } = dayDrill;
  const { selectCloudScope: switchToCloudScope } = statsHook;
  const selectCloudScopeLeavingDayDrill = useCallback(() => {
    if (cloud.cloudStatusKnown && cloud.cloudStatus.authenticated) leaveDayDrillForScope('cloud');
    switchToCloudScope();
  }, [cloud.cloudStatus.authenticated, cloud.cloudStatusKnown, leaveDayDrillForScope, switchToCloudScope]);

  // Keep the forwarders pointed at the latest hook instances.
  useEffect(() => {
    loadDetailsRef.current = usageDetails.loadDetails;
    setDetailFiltersRef.current = usageDetails.setDetailFilters;
    setDetailsRef.current = usageDetails.setDetails;
    setEntitySelectionRef.current = entityDashboard.setEntitySelection;
  });

  // Update bridges for hooks referencing stats state
  const statsRequestIdRef = statsHook.statsRequestId;
  const detailRequestIdRef = usageDetails.detailRequestId;
  const entityRequestIdRef = entityDashboard.entityRequestId;
  const lastTrustedStatsRef = statsHook.lastTrustedStats;
  const setStatsState = statsHook.setStats;
  const setDeviceListState = statsHook.setDeviceList;
  const setDetailsState = usageDetails.setDetails;
  const setEntitySelectionState = entityDashboard.setEntitySelection;
  const setEntityDashboardState = entityDashboard.setEntityDashboard;
  const setStatsErrorState = statsHook.setStatsError;
  const setStatsErrorActionState = statsHook.setStatsErrorAction;
  const setDetailsErrorState = usageDetails.setDetailsError;
  const setEntityErrorState = entityDashboard.setEntityError;
  const quotaCloudLoadMode = useRef<'none' | 'local' | 'remote'>('none');
  const [initialCloudConfigSettled, setInitialCloudConfigSettled] = useState(false);
  const initialQuotaLoadStarted = useRef(false);
  const resetQuotaBinding = quota.resetQuotaBinding;

  // Cloud binding observation
  useEffect(() => {
    const nextBinding = {
      identity: cloud.cloudIdentity,
      publicKey: cloud.activeCloudConfig.supabase_key.trim(),
    };
    const previousBinding = cloud.observedCloudBinding.current;
    cloud.observedCloudBinding.current = nextBinding;
    if (!previousBinding) return;
    if (
      previousBinding.identity !== nextBinding.identity
      || previousBinding.publicKey !== nextBinding.publicKey
    ) {
      quotaCloudLoadMode.current = 'none';
      resetQuotaBinding();
      // setActiveCloudConfig 已在启动保存后的状态刷新前失效旧请求；状态身份变化
      // 也只会由共享代次中的当前请求写入。这里再次失效会在 React 批处理中
      // 取消刚启动的合法 refreshCloudStatus，令新配置继续显示旧登录状态。
      clearCloudScopedState();
      void loadStats();
      if (initialQuotaLoadStarted.current && activeTab !== 'settings') void loadQuotas(false);
    }
  }, [activeTab, clearCloudScopedState, cloud.activeCloudConfig.supabase_key, cloud.cloudIdentity, cloud.observedCloudBinding, loadQuotas, loadStats, resetQuotaBinding]);

  // Initial lifecycle load
  useEffect(() => {
    let cancelled = false;
    invoke<CloudConfig>('get_cloud_config')
      .then((config) => {
        if (cancelled) return;
        const normalizedConfig = {
          supabase_url: config.supabase_url || '',
          supabase_key: config.supabase_key || '',
        };
        cloud.setCloudConfig(normalizedConfig);
        cloud.setActiveCloudConfig(normalizedConfig);
      })
      .catch((err) => {
        if (!cancelled) showMessage('error', `读取 Supabase 配置失败: ${err}`);
      })
      .finally(() => {
        if (!cancelled) setInitialCloudConfigSettled(true);
      });
    void settings.loadSettings();
    void settings.loadPrices();
    void settings.loadDbInfo();
    invoke<string>('get_app_version')
      .then(settings.setAppVersion)
      .catch((err) => console.error('获取应用版本失败:', err));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hydrate the initial binding before the first quota read. Otherwise the
  // empty -> saved public key transition invalidates and repeats that read.
  // Settings owns its own initial load in the following effect; a failed config
  // read must still allow local quotas. Later binding changes keep their reset.
  useEffect(() => {
    if (!initialCloudConfigSettled || initialQuotaLoadStarted.current) return;
    initialQuotaLoadStarted.current = true;
    if (activeTab !== 'settings') void loadQuotas(false);
  }, [activeTab, initialCloudConfigSettled, loadQuotas]);

  // A local dashboard and a settings overview do not need a secure-session
  // read. The user must explicitly ask to inspect the cloud account before
  // macOS Keychain or remote quota snapshots are touched.
  useEffect(() => {
    if (activeTab !== 'settings') {
      quotaCloudLoadMode.current = 'none';
      return;
    }
    if (!initialCloudConfigSettled) return;
    const canReadRemote = cloud.cloudStatusKnown && cloud.cloudStatus.authenticated;
    const nextMode = canReadRemote ? 'remote' : 'local';
    if (quotaCloudLoadMode.current === nextMode) return;
    quotaCloudLoadMode.current = nextMode;
    if (canReadRemote) {
      void Promise.all([
        loadQuotas(true),
        loadQuotaSyncStatus(),
      ]);
    } else {
      void loadQuotas(false);
    }
  }, [
    activeTab,
    cloud.activeCloudConfig.supabase_key,
    cloud.cloudIdentity,
    cloud.cloudStatus.authenticated,
    cloud.cloudStatusKnown,
    initialCloudConfigSettled,
    loadQuotaSyncStatus,
    loadQuotas,
  ]);

  const checkCloudStatusAndOpenSettings = useCallback(() => {
    setSettingsAnchor('settings-cloud');
    changeTab('settings');
    void refreshCloudStatus();
  }, [changeTab, refreshCloudStatus, setSettingsAnchor]);

  // Tab-dependent loaders. Details reload whenever the query identity changes
  // (scope/range/device/filters/cloud capability); keyed on the capability bit
  // rather than the stats object so periodic stats refreshes don't reset the
  // user's pagination position.
  const cloudDetailsCapable = hasCloudCapability(statsHook.stats, 'detailPagination');
  useEffect(() => {
    if (activeTab !== 'logs') return;
    void usageDetails.loadDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab,
    statsHook.dataScope,
    statsHook.range,
    statsHook.customRange,
    statsHook.deviceFilter,
    usageDetails.detailFilters,
    cloudDetailsCapable,
    // 云端 stats 从「未到达」转为「失败」时 cloudDetailsCapable 两端都是 false，
    // 不会变化；没有这一项，明细会一直卡在“读取中”，看不到真实错误也没有重试
    // 入口（T10.180 独立评审 P2-1）。
    statsHook.statsError,
  ]);

  useEffect(() => {
    if (activeTab === 'settings' && !settings.pricesDirty) void settings.loadPrices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Toast message auto-clear
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 4200);
    return () => window.clearTimeout(t);
  }, [message]);

  const focusMainContent = () => {
    const content = contentRef.current;
    if (!content) return;
    content.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    content.focus({ preventScroll: true });
  };

  const handleSkipToMainContent = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    focusMainContent();
  };

  const handleSkipToMainContentKeyDown = (event: React.KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    focusMainContent();
  };

  const openQuotaSettings = useCallback(() => {
    setSettingsAnchor('settings-quota');
    changeTab('settings');
  }, [changeTab]);

  const handleOpenShareCard = useCallback(() => {
    if (statsHook.stats) {
      setShareCardOpen(true);
    } else {
      showMessage('warning', '当前暂无可用统计数据，请先刷新');
    }
  }, [showMessage, statsHook.stats]);

  const openCloudSettings = useCallback(() => {
    setSettingsAnchor('settings-cloud');
    changeTab('settings');
  }, [changeTab, setSettingsAnchor]);

  // 行为页排行下钻（T10.164，审计 Q9）：工具行打开该工具的专属看板；会话行进入明细，筛选由
  // 行为页给出（按会话 ID 搜索并限定该工具——同一会话 ID 在不同工具下是不同会话）。两者默认
  // 沿用全局时间范围；本次结果的预设窗口已被日历越过（如跨过午夜）时，行为页一并给出分析时的
  // 日期，这里先切成该自定义区间，打开的页面才含排行里计入的记录（评审 F2）。逐轮分析抽屉由
  // 行为页自己打开。
  const { openEntity } = entityDashboard;
  const { setDetailFilters } = usageDetails;
  const { changeRange } = statsHook;
  const openBehaviorTool = useCallback((tool: string, analysedRange: { start: string; end: string } | null) => {
    if (analysedRange) changeRange('custom', analysedRange);
    openEntity('tool', tool);
  }, [changeRange, openEntity]);
  const openBehaviorSessionDetails = useCallback((drill: { filters: DetailFilters; range: { start: string; end: string } | null }) => {
    if (drill.range) changeRange('custom', drill.range);
    setDetailFilters(drill.filters);
    changeTab('logs', true);
    // The pressed row unmounts with the behavior page; move focus to the details
    // heading once the lazy page mounts so keyboard users keep their place.
    let attempts = 0;
    const focusDetailsHeading = () => {
      const heading = document.getElementById('details-page-title');
      if (heading instanceof HTMLElement) heading.focus({ preventScroll: true });
      else if (attempts++ < 60) window.requestAnimationFrame(focusDetailsHeading);
    };
    window.requestAnimationFrame(focusDetailsHeading);
  }, [changeRange, changeTab, setDetailFilters]);

  const syncCloudStatus = cloud.cloudStatus;
  const syncCloudStatusKnown = cloud.cloudStatusKnown;
  const syncCloudSetup = cloud.cloudSetup;
  const syncCloudConfig = cloud.activeCloudConfig;
  const syncRefreshCloudStatus = cloud.refreshCloudStatus;
  const triggerCloudSync = useCallback(async () => {
    let currentStatus = syncCloudStatus;
    if (!syncCloudStatusKnown) {
      currentStatus = await syncRefreshCloudStatus(true);
    }
    if (!currentStatus.authenticated) {
      openCloudSettings();
      showMessage('info', '请先登录云端账户');
      return;
    }
    const capabilityVerified = syncCloudStatusKnown
      ? syncCloudSetup.capabilityVerified
      : readPersistedCloudSetup(cloudStatsIdentity(syncCloudConfig.supabase_url, currentStatus.userId)).capabilityVerified;
    if (!capabilityVerified) {
      openCloudSettings();
      showMessage('info', '请先验证 Stats v2');
      return;
    }
    void triggerSync();
  }, [syncCloudStatus, syncCloudStatusKnown, syncCloudSetup.capabilityVerified, syncCloudConfig.supabase_url, syncRefreshCloudStatus, openCloudSettings, showMessage, triggerSync]);

  const signOut = useCallback(async () => {
    setBusy((p) => ({ ...p, auth: true }));
    cloud.invalidateCloudRequests();
    invalidateRequest(statsHook.statsRequestId);
    invalidateRequest(usageDetails.detailRequestId);
    invalidateRequest(entityDashboard.entityRequestId);
    quota.invalidateQuotaRequests();
    try {
      const res = await invoke<{
        message: string;
        signedOut?: boolean;
        localSignOutError?: boolean;
        quotaCleanupPending?: boolean;
      }>('supabase_sign_out');
      if (res.localSignOutError || res.signedOut === false) {
        await Promise.all([cloud.refreshCloudStatus(true), settings.loadSettings(true), quota.loadQuotas(), quota.loadQuotaSyncStatus()]);
        showMessage('error', res.message);
        return;
      }
      showMessage(res.quotaCleanupPending ? 'info' : 'success', res.message);
      quota.resetQuotaBinding();
      clearCloudScopedState();
      statsHook.setDataScope('local');
      statsHook.setDeviceFilter('all_cloud');
      usageDetails.setDetails(null);
      usageDetails.setDetailFilters(EMPTY_DETAIL_FILTERS);
      entityDashboard.setEntitySelection(null);
      cloud.setCloudSetup({ capabilityVerified: false, firstSyncCompleted: false, validating: false, lastError: '' });
      await Promise.all([cloud.refreshCloudStatus(), settings.loadSettings(), quota.loadQuotas(), quota.loadQuotaSyncStatus()]);
    } catch (err) {
      showMessage('error', `退出失败: ${err}`);
    } finally {
      cloud.setAuthForm((previous) => ({ ...previous, password: '' }));
      cloud.setCloudAuthError('');
      setBusy((p) => ({ ...p, auth: false }));
    }
  }, [clearCloudScopedState, cloud, entityDashboard, quota, settings, showMessage, statsHook, usageDetails]);

  // 待上传数：数据库信息未读到或读取失败时为 null（未知），不得写成 0（GLB-01）。
  // 侧栏、顶栏与总览共用同一次计算，避免三处口径分叉（T10.180）。
  const pendingUploadCount = settings.dbInfo && !settings.dbInfoError ? settings.dbInfo.unsyncedRecords : null;
  // 本机账本行数；未读到或读取失败时为 null，空态与新手引导都不据此下结论。
  const localRecordCount = settings.dbInfo && !settings.dbInfoError ? settings.dbInfo.totalRecords : null;
  const localLedgerEmpty = localRecordCount === 0;
  // 模型接入总开关（U-112）；undefined 表示设置还没读到，不据此跳页。
  const modelAccessEnabled = settings.appSettings.model_access_enabled;
  const modelPageVisible = useModelAccessRedirect(activeTab, modelAccessEnabled, changeTab);
  const { setAppSettings } = settings;
  const handleModelAccessChanged = useCallback((next: AppSettings) => {
    setAppSettings((current) => ({
      ...current,
      model_access_enabled: next.model_access_enabled,
      model_access_version: next.model_access_version,
    }));
  }, [setAppSettings]);

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={handleSkipToMainContent}
        onKeyDown={handleSkipToMainContentKeyDown}
      >
        跳转到主要内容
      </a>
      <Sidebar
        activeTab={activeTab}
        onTabChange={changeTab}
        busy={busy}
        cloudAuthenticated={cloud.cloudStatus.authenticated}
        cloudStatusKnown={cloud.cloudStatusKnown}
        cloudCapabilityVerified={cloud.cloudSetup.capabilityVerified}
        cloudReady={cloud.cloudStatus.authenticated && cloud.cloudSetup.capabilityVerified && cloud.cloudSetup.firstSyncCompleted}
        pendingUploads={pendingUploadCount}
        cloudStatus={cloud.cloudStatus}
        onScan={statsHook.triggerScan}
        onSync={triggerCloudSync}
        onCheckCloudStatus={checkCloudStatusAndOpenSettings}
        onWallpaper={statsHook.triggerWallpaper}
        onOpenShareCard={handleOpenShareCard}
        wallpaperBusy={busy.wallpaper}
        appVersion={settings.appVersion}
        modelAccessEnabled={modelAccessEnabled === true}
      />
      <main className="app-main">
        {modelPageVisible && isModelTab(activeTab) ? (
          <Suspense fallback={null}>
            <ModelWorkspaceHeader page={activeTab} onOpenGateway={() => changeTab('gateway')} refreshKey={gatewayRefreshKey} />
          </Suspense>
        ) : <AppHeader
          activeTab={activeTab}
          dataScope={statsHook.dataScope}
          cloudStatus={cloud.cloudStatus}
          onScopeChange={statsHook.selectLocalScope}
          onCloudScope={selectCloudScopeLeavingDayDrill}
          themeMode={theme.mode}
          onThemeChange={theme.set}
          onTabChange={changeTab}
          dataStatus={{
            loading: statsHook.statsLoading || busy.scan || busy.sync,
            stale: Boolean(statsHook.stats?.meta?.stale),
            lastRefreshedAt: statsHook.stats?.meta?.lastRefreshedAt || statsHook.stats?.meta?.generatedAt || statsHook.refreshCompletedAt,
            unsyncedRecords: pendingUploadCount,
            cloudCapabilityVerified: cloud.cloudSetup.capabilityVerified,
            cloudFirstSyncCompleted: cloud.cloudSetup.firstSyncCompleted,
          }}
        />}
        <div className="toast-region" aria-live="polite" aria-atomic="true">
          {message && <Toast message={message} />}
        </div>
        <section id="main-content" ref={contentRef} className="app-content tl-scrollbar" tabIndex={-1} aria-label="主要内容">
          {isUsageTab(activeTab) && (
            <UsagePage
              sub={usageSubForTab(activeTab) ?? 'overview'}
              stats={statsHook.stats}
              range={statsHook.range}
              customRange={statsHook.customRange}
              toolbar={(activeTab === 'dashboard' || activeTab === 'logs') && (
                <UsageToolbar
                  variant={activeTab === 'logs' ? 'requests' : 'overview'}
                  dataScope={statsHook.dataScope}
                  range={statsHook.range}
                  customRange={statsHook.customRange}
                  onRangeChange={statsHook.changeRange}
                  deviceFilter={statsHook.deviceFilter}
                  deviceList={statsHook.deviceList}
                  onDeviceFilterChange={statsHook.changeHeaderDevice}
                  showTotalTokens={settings.showTotalTokens}
                  onToggleTokenMode={settings.toggleTokenMode}
                  cachedTokens={statsHook.stats?.summary.cachedTokens ?? 0}
                  onOpenShareCard={handleOpenShareCard}
                />
              )}
              overview={activeTab === 'dashboard' && (
                <DashboardTab
                  hasPageTitle
                  stats={statsHook.stats}
                  statsLoading={statsHook.statsLoading}
                  statsError={statsHook.statsError}
                  statsErrorAction={statsHook.statsErrorAction}
                  scanBusy={busy.scan}
                  syncBusy={busy.sync}
                  activeTools={statsHook.activeTools}
                  topModels={statsHook.topModels}
                  allModels={statsHook.allModels}
                  showTotalTokens={settings.showTotalTokens}
                  range={statsHook.range}
                  customRange={statsHook.customRange}
                  scope={statsHook.dataScope}
                  queryIdentity={dashboardQueryIdentity(statsHook.dataScope, statsHook.deviceFilter, cloud.cloudIdentity)}
                  cloudAuthenticated={cloud.cloudStatus.authenticated}
                  cloudCapabilityVerified={cloud.cloudSetup.capabilityVerified}
                  quotaProviders={quota.quotaProviders}
                  quotaLoading={quota.quotaLoading}
                  quotaError={quota.quotaError}
                  quotaSyncStatus={quota.quotaSyncStatus}
                  onQuotaSyncNow={() => void quota.syncQuotaSnapshotsNow()}
                  unsyncedRecords={pendingUploadCount}
                  onToolClick={entityDashboard.openToolEntity}
                  onModelClick={entityDashboard.openModelEntity}
                  onScan={statsHook.triggerScan}
                  onSync={triggerCloudSync}
                  onOpenCloudSettings={openCloudSettings}
                  onRetryStats={() => void statsHook.loadStats()}
                  onRelogin={() => void (async () => {
                    await signOut();
                    setSettingsAnchor('settings-cloud');
                    changeTab('settings');
                  })()}
                  onViewLocal={() => {
                    statsHook.selectLocalScope();
                    showMessage('info', '已临时切换到本机数据；云端恢复后可手动切回');
                  }}
                  onRefreshQuotas={() => void quota.loadQuotas(cloud.cloudStatusKnown && cloud.cloudStatus.authenticated, true)}
                  onOpenQuotaSettings={openQuotaSettings}
                  onQuotaNotify={(text) => showMessage('info', text)}
                  refreshCompletedAt={statsHook.refreshCompletedAt}
                  onSelectDate={dayDrill.drillIntoDay}
                  dateDrillUnavailable={dayDrill.dayDrillUnavailable}
                  onOpenAllowances={() => changeTab('allowances')}
                />
              )}
              requests={activeTab === 'logs' && (
                <Suspense fallback={<LoadingSkeleton className="h-64" />}>
                <LogsTable
                  details={usageDetails.details}
                  filters={usageDetails.detailFilters}
                  loading={usageDetails.detailsLoading}
                  loadingMore={usageDetails.detailsLoadingMore}
                  error={usageDetails.detailsError}
                  scope={statsHook.dataScope}
                  range={statsHook.range}
                  customRange={statsHook.customRange}
                  onFilterChange={usageDetails.updateDetailFilter}
                  onClearFilters={() => usageDetails.setDetailFilters(EMPTY_DETAIL_FILTERS)}
                  onRetry={() => void usageDetails.loadDetails()}
                  onLoadMore={() => void usageDetails.loadDetails(usageDetails.details?.nextCursor || null, true)}
                  onOpenEntity={entityDashboard.openEntity}
                  dayDrill={dayDrill.dayDrill ? dayDrillCopy(dayDrill.dayDrill) : null}
                  onReturnFromDayDrill={dayDrill.returnFromDayDrill}
                  hasPageTitle
                  ledgerEmpty={statsHook.dataScope === 'local' && localLedgerEmpty}
                  onScan={() => void statsHook.triggerScan()}
                  scanBusy={busy.scan}
                  exporting={usageDetails.detailsExporting}
                  onExportCsv={() => {
                    usageDetails.exportDetailsCsv()
                      .then((result) => showMessage('success', `${result.message} → ${result.path}`))
                      .catch((err) => showMessage('error', `导出失败：${err instanceof Error ? err.message : String(err)}`));
                  }}
                />
                </Suspense>
              )}
              sessions={activeTab === 'behavior' && (
                <BehaviorAnalysisView
                  hasPageTitle
                  data={behaviorAnalysis.data}
                  loading={behaviorAnalysis.loading}
                  refreshing={behaviorAnalysis.refreshing}
                  updatedAt={behaviorAnalysis.updatedAt}
                  onOpenTool={openBehaviorTool}
                  onOpenSession={openBehaviorSessionDetails}
                  error={behaviorAnalysis.error}
                  scope={statsHook.dataScope}
                  range={statsHook.range}
                  customRange={statsHook.customRange}
                  onRangeChange={statsHook.changeRange}
                  onRetry={() => void behaviorAnalysis.reload()}
                  onViewLocal={statsHook.selectLocalScope}
                  projectFilter={behaviorAnalysis.projectFilter}
                  onProjectFilterChange={behaviorAnalysis.setProjectFilter}
                  onOpenProjectSettings={() => {
                    requestProjectDimensionFocus();
                    setSettingsAnchor('settings-data');
                    changeTab('settings');
                  }}
                  onRebuildProjectIndex={() => { void projectDimension.rebuild(); }}
                  projectBackfill={projectDimension.status?.backfill ?? null}
                  onScan={() => void statsHook.triggerScan()}
                  scanBusy={busy.scan}
                  ledgerEmpty={localLedgerEmpty}
                  onSelectDate={(date) => {
                    statsHook.changeRange('custom', { start: date, end: date });
                    usageDetails.setDetailFilters(EMPTY_DETAIL_FILTERS);
                    changeTab('logs', true);
                  }}
                />
              )}
              allowances={activeTab === 'allowances' && (
                <UsageAllowancesView
                  providers={quota.quotaProviders}
                  loading={quota.quotaLoading}
                  error={quota.quotaError}
                  quotaSyncStatus={quota.quotaSyncStatus}
                  onRefresh={() => void quota.loadQuotas(cloud.cloudStatusKnown && cloud.cloudStatus.authenticated, true)}
                  onSyncNow={() => void quota.syncQuotaSnapshotsNow()}
                  onOpenSettings={openQuotaSettings}
                  onNotify={(text) => showMessage('info', text)}
                />
              )}
            />
          )}
          {modelPageVisible && isModelTab(activeTab) && (
            <Suspense fallback={<LoadingSkeleton className="h-64" />}>
              <ModelWorkspaceContent
                page={activeTab}
                onPage={changeTab}
                onNotify={showMessage}
                onConfirm={requestConfirmation}
                onChanged={() => setGatewayRefreshKey((value) => value + 1)}
              />
            </Suspense>
          )}
          {activeTab === 'settings' && (
            <Suspense fallback={<LoadingSkeleton className="h-64" />}>
              <SettingsTab
                modelAccess={{
                  enabled: modelAccessEnabled,
                  onChanged: handleModelAccessChanged,
                  onNotify: (text) => showMessage('error', text),
                }}
                settingsAnchor={settingsAnchor}
                onSettingsAnchorHandled={() => setSettingsAnchor(null)}
                cloud={{
                  cloudConfig: cloud.cloudConfig,
                  cloudStatus: cloud.cloudStatus,
                  statusKnown: cloud.cloudStatusKnown,
                  statusChecking: cloud.cloudStatusChecking,
                  statusError: cloud.cloudStatusError,
                  authForm: cloud.authForm,
                  busy,
                  onConfigChange: (config) => {
                    cloud.setCloudConfig(config);
                    cloud.setCloudConfigError('');
                  },
                  onAuthFormChange: (form) => {
                    cloud.setAuthForm(form);
                    cloud.setCloudAuthError('');
                  },
                  onClearPassword: cloud.clearAuthPassword,
                  onSaveConfig: (e) => cloud.saveConfig(e, setBusy),
                  onSync: triggerCloudSync,
                  onSignIn: () => cloud.submitAuth('signIn', setBusy, quota.loadQuotaSyncStatus),
                  onSignUp: () => cloud.submitAuth('signUp', setBusy, quota.loadQuotaSyncStatus),
                  onSignOut: signOut,
                  onCheckStatus: () => void cloud.refreshCloudStatus(),
                  configError: cloud.cloudConfigError,
                  authError: cloud.cloudAuthError,
                  setup: {
                    configured: Boolean(cloud.cloudConfig.supabase_url && cloud.cloudConfig.supabase_key),
                    authenticated: cloud.cloudStatus.authenticated,
                    capabilityVerified: cloud.cloudSetup.capabilityVerified,
                    firstSyncCompleted: cloud.cloudSetup.firstSyncCompleted,
                    validating: cloud.cloudSetup.validating,
                    lastError: cloud.cloudSetup.lastError,
                  },
                  onValidateCapability: () => void cloud.verifyCloudCapability(),
                }}
                quota={{
                  appSettings: settings.appSettings,
                  cloudStatus: cloud.cloudStatus,
                  quotaProviders: quota.quotaProviders,
                  quotaSyncStatus: quota.quotaSyncStatus,
                  busy,
                  onSettingChange: settings.updateSetting,
                  onClaudeNativeQuotaChange: (enabled) => void quota.changeClaudeNativeQuota(enabled),
                  onAntigravityLocalQuotaChange: (enabled) => void quota.changeAntigravityLocalQuota(enabled),
                  onAuthorizeClaudeNativeQuota: () => void quota.authorizeClaudeNativeQuota(),
                  onAuthorizeAntigravityQuota: () => void quota.authorizeAntigravityQuota(),
                  onQuotaSyncToggle: (enabled) => void quota.toggleQuotaSnapshotSync(enabled),
                  onQuotaSyncNow: () => void quota.syncQuotaSnapshotsNow(),
                  onDeleteQuotaProvider: (providerId, scope) => quota.deleteQuotaSnapshotProvider(providerId, scope),
                  onClearQuotaSnapshots: () => quota.clearQuotaSnapshots(),
                  onConfirm: requestConfirmation,
                  onCustomQuotaChanged: () => {
                    void Promise.all([settings.loadSettings(), quota.loadQuotas(), quota.loadQuotaSyncStatus()]);
                  },
                }}
                wallpaper={{
                  appSettings: settings.appSettings,
                  busy,
                  deviceList: statsHook.deviceList,
                  cloudWallpaperReady: cloud.cloudStatus.authenticated
                    && cloud.cloudSetup.capabilityVerified
                    && cloud.cloudSetup.firstSyncCompleted,
                  cloudWallpaperHint: !cloud.cloudStatus.authenticated
                    ? '请先检查云端账户并完成首次同步'
                    : !cloud.cloudSetup.capabilityVerified
                      ? '请先在云端账户页检查数据连接'
                      : '先完成首次同步，之后才可启用云端壁纸数据',
                  onSettingChange: settings.updateSetting,
                  onSettingChangeDebounced: settings.updateSettingDebounced,
                  onFlushSettingChange: settings.flushSettingsDebounced,
                  onConsentDecision: (restoreHistoricalChoices) => void settings.resolveWallpaperConsent(restoreHistoricalChoices),
                  onCleanupWallpaper: settings.cleanupWallpaper,
                  wallpaperError: settings.wallpaperError,
                  onOpenCloudSection: () => { window.location.hash = 'settings-cloud'; },
                  onRefreshWallpaper: settings.refreshWallpaper,
                }}
                scanStartup={{
                  appSettings: settings.appSettings,
                  busy,
                  onSettingChange: settings.updateSetting,
                  onSettingChangeDebounced: settings.updateSettingDebounced,
                  onFlushSettingChange: settings.flushSettingsDebounced,
                }}
                widget={{
                  appSettings: settings.appSettings,
                  busy,
                  quotaProviders: quota.quotaProviders,
                  onSettingChange: settings.updateSetting,
                }}
                pricing={{
                  pricesText: settings.pricesText,
                  pricesError: settings.pricesError,
                  pricesLoadError: settings.pricesLoadError,
                  pricesLoading: settings.pricesLoading,
                  pricesDirty: settings.pricesDirty,
                  busy,
                  onPricesChange: (text) => {
                    settings.setPricesText(text);
                    settings.setPricesError('');
                    settings.setPricesDirty(true);
                  },
                  onReloadPrices: settings.loadPrices,
                  onSavePrices: settings.savePrices,
                  onResetPrices: settings.resetPrices,
                  onImportModelsDevPrice: settings.importModelsDevPrice,
                }}
                dataHelp={{
                  dbInfo: settings.dbInfo,
                  dbInfoError: settings.dbInfoError,
                  cloudSetup: {
                    configured: cloud.cloudStatus.configured,
                    authenticated: cloud.cloudStatus.authenticated,
                    capabilityVerified: cloud.cloudSetup.capabilityVerified,
                    firstSyncCompleted: cloud.cloudSetup.firstSyncCompleted,
                  },
                  cleanupDate: settings.cleanupDate,
                  busy,
                  onExport: settings.exportCsv,
                  onReclaimSpace: settings.reclaimDbSpace,
                  onOpenShareCard: handleOpenShareCard,
                  onRefreshDb: settings.loadDbInfo,
                  onCleanupDateChange: settings.setCleanupDate,
                  onCleanup: settings.runCleanup,
                  onResetSync: settings.resetSyncStatus,
                }}
              />
            </Suspense>
          )}
        </section>
      </main>
      <Suspense fallback={null}>
        {entityDashboard.entitySelection && (
          <EntityDashboardModal
            selection={entityDashboard.entitySelection}
            range={statsHook.range}
            customRange={statsHook.customRange}
            scope={statsHook.dataScope}
            data={entityDashboard.entityDashboard}
            loading={entityDashboard.entityLoading}
            error={entityDashboard.entityError}
            onClose={() => entityDashboard.setEntitySelection(null)}
            onRetry={() => entityDashboard.setEntityRetryNonce((value) => value + 1)}
            onOpenDetails={entityDashboard.openEntityDetails}
            onOpenEntity={entityDashboard.openNestedEntity}
            globalCostContext={globalCostContext}
          />
        )}
        {shareCardOpen && statsHook.stats && (
          <ShareCardModal
            isOpen={shareCardOpen}
            onClose={() => setShareCardOpen(false)}
            stats={statsHook.stats}
            range={statsHook.range}
            scope={statsHook.dataScope}
            appVersion={settings.appVersion}
            onNotify={showMessage}
          />
        )}
      </Suspense>
      <FirstRunGuide
        facts={{
          totalRecords: localRecordCount,
          modelAccessEnabled,
          cloudAuthenticated: cloud.cloudStatusKnown && cloud.cloudStatus.authenticated,
          cloudCapabilityVerified: cloud.cloudSetup.capabilityVerified,
          cloudFirstSyncCompleted: cloud.cloudSetup.firstSyncCompleted,
          routingPublishEnabled: settings.appSettings.routing_publish_enabled === true,
        }}
        scanBusy={busy.scan}
        syncBusy={busy.sync}
        settingsBusy={busy.settings}
        gatewayRefreshKey={gatewayRefreshKey}
        onScan={() => void statsHook.triggerScan()}
        onSync={() => void triggerCloudSync()}
        onModelAccessChanged={handleModelAccessChanged}
        onEnablePhoneRouting={() => settings.updateSetting('routing_publish_enabled', true)}
        onOpenProviders={() => changeTab('providers')}
        onOpenGateway={() => changeTab('gateway')}
        latestError={message?.type === 'error' ? message.text : ''}
        onOpenCloudSettings={openCloudSettings}
        onNotify={(text) => showMessage('error', text)}
      />
      {confirmation && (
        <ConfirmDialog
          {...confirmation}
          onCancel={() => settleConfirmation(false)}
          onConfirm={() => settleConfirmation(true)}
        />
      )}
    </div>
  );
}

function WallpaperApp() {
  useEffect(() => {
    document.body.style.background = 'transparent';
    document.documentElement.style.background = 'transparent';
    const root = document.getElementById('root');
    if (root) root.style.background = 'transparent';
    document.body.className = '';
  }, []);

  return (
    <Suspense fallback={null}>
      <LiveWallpaperView />
    </Suspense>
  );
}

function App() {
  if (window.location.search.includes('view=widget')) {
    return (
      <Suspense fallback={null}>
        <WidgetView />
      </Suspense>
    );
  }
  if (window.location.search.includes('view=wallpaper')) return <WallpaperApp />;
  if (window.location.search.includes('view=android-prototype')) {
    return (
      <Suspense fallback={null}>
        <AndroidDashboardPrototype />
      </Suspense>
    );
  }
  if (window.location.search.includes('view=model-workspace-prototype')) {
    return (
      <Suspense fallback={null}>
        <ModelWorkspacePrototype />
      </Suspense>
    );
  }
  return <MainApp />;
}

export default App;
