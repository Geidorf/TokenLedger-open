import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  beginRequest,
  classifyCloudFailure,
  isCurrentRequest,
  isStatsV2Capable,
  isSuccessfulCloudSyncResult,
  normalizeStatsQuery,
  parseStatsDataContract,
  queryEchoMatches,
  sameStatsSnapshot,
  scopeMachineSelection,
  statsSnapshotKey,
} from '../utils/frontendContracts';
import { formatLocalDateTime } from '../utils/format';
import { createVisibleStatsReconciler, subscribeThenReconcile } from '../utils/statsRefreshSubscription';
import {
  AppSettings,
  CloudConfig,
  CloudStatus,
  CustomDateRange,
  DataScope,
  effectiveTokens,
  ModelStat,
  RangeKey,
  StatsData,
  StatsErrorAction,
  Tab,
  ToastType,
  ToolStat,
} from '../types';

export interface UseStatsProps {
  showMessage: (type: ToastType, text: string) => void;
  activeCloudConfig: CloudConfig;
  cloudStatus: CloudStatus;
  cloudStatusKnown: boolean;
  appSettings: AppSettings;
  setCloudSetup: React.Dispatch<React.SetStateAction<{
    capabilityVerified: boolean;
    firstSyncCompleted: boolean;
    validating: boolean;
    lastError: string;
  }>>;
  refreshCloudStatus: () => Promise<CloudStatus>;
  loadDbInfo: () => Promise<void>;
  loadQuotaSyncStatus: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadPrices: () => Promise<void>;
  pricesDirty: boolean;
  activeTab: Tab;
  loadDetails: () => Promise<void>;
  setDetailFilters: React.Dispatch<React.SetStateAction<any>>;
  setDetails: (details: any) => void;
  setEntitySelection: (selection: any) => void;
  showTotalTokens: boolean;
  changeTab: (tab: Tab) => void;
  setSettingsAnchor: (anchor: string | null) => void;
  setBusy: React.Dispatch<React.SetStateAction<any>>;
  currentTimezone: () => string;
}

interface LoadStatsOptions {
  notifyOnError?: boolean;
}

/**
 * 快照键必须带上时区：同一个“本月”或同一对起止日期，在两个时区下是两段不同的绝对时间，
 * 失败时回落的“最近可信数据”不能拿另一个时区的那段冒充（T10.185 为 custom 加上时区；
 * T10.200 按 T10.185 评审 P3-3 给预设也加上）。自定义区间还没选日期时回退到 custom:unset。
 */
export function snapshotRangeKey(range: RangeKey, bounds: CustomDateRange | null, timezone: string): string {
  if (range !== 'custom') return `${range}::${timezone}`;
  return bounds ? `custom:${bounds.start}..${bounds.end}::${timezone}` : 'custom:unset';
}

/**
 * 按 Token 口径排好的工具列表：同一份统计换口径只需重新排序，不必重新请求（T10.200）。
 * useStats 与 DashboardTab 保留的旧画面共用这一份算法，两处不会各算各的。
 */
export function projectActiveTools(stats: StatsData | null, showTotalTokens: boolean): ToolStat[] {
  if (!stats) return [];
  const displayed = (tool: ToolStat) => (showTotalTokens
    ? (tool.input || 0) + (tool.output || 0) + (tool.cached || 0)
    : effectiveTokens(tool));
  return Object.values(stats.tools)
    .filter((tool) => effectiveTokens(tool) > 0 || tool.cached > 0)
    .sort((a, b) => displayed(b) - displayed(a));
}

/**
 * 本期全部模型，按当前 Token 口径的显示值排序并写好 displayTotal。金额分布与用量/费用分布
 * 必须看到全部模型（审计 P0-2）：用得少但单价高的模型按 Token 排在哪里都有可能。
 * 自己没有工具归属的模型，归到用它最多的那个工具。
 */
export function projectAllModels(stats: StatsData | null, showTotalTokens: boolean): ModelStat[] {
  if (!stats) return [];
  const toolByModel = new Map<string, string>();
  Object.values(stats.tools).forEach((tool) => {
    Object.entries(tool.models || {}).forEach(([model, tokens]) => {
      const currentTool = toolByModel.get(model);
      const currentTokens = currentTool ? (stats.tools[currentTool]?.models?.[model] || 0) : -1;
      if (!currentTool || tokens > currentTokens) {
        toolByModel.set(model, tool.name);
      }
    });
  });
  return Object.values(stats.models)
    .map((m) => {
      const input = m.input || 0;
      const output = m.output || 0;
      const cached = m.cached || 0;
      const displayTotal = showTotalTokens ? (input + output + cached) : (input + output);
      return { ...m, displayTotal, tool: m.tool || toolByModel.get(m.name) };
    })
    .sort((a, b) => b.displayTotal - a.displayTotal);
}

/** 只有 Token 排行图限前 8 个模型。 */
export function projectTopModels(allModels: ModelStat[]): ModelStat[] {
  return allModels.filter((m) => (m.displayTotal ?? 0) > 0).slice(0, 8);
}

function sameCustomRange(left: CustomDateRange | null, right: CustomDateRange | null): boolean {
  if (!left || !right) return left === right;
  return left.start === right.start && left.end === right.end;
}

export function useStats({
  showMessage,
  activeCloudConfig,
  cloudStatus,
  cloudStatusKnown,
  appSettings,
  setCloudSetup,
  refreshCloudStatus,
  loadDbInfo,
  loadQuotaSyncStatus,
  loadSettings,
  loadPrices,
  pricesDirty,
  activeTab,
  loadDetails,
  setDetailFilters,
  setDetails,
  setEntitySelection,
  showTotalTokens,
  changeTab,
  setSettingsAnchor,
  setBusy,
  currentTimezone,
}: UseStatsProps) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');
  const [statsErrorAction, setStatsErrorAction] = useState<StatsErrorAction | null>(null);
  const statsRequestId = useRef(0);
  const [range, setRange] = useState<RangeKey>('today');
  // 自定义日期区间只在 range === 'custom' 时有值；两者由 changeRange 同步更新（T10.108）。
  const [customRange, setCustomRange] = useState<CustomDateRange | null>(null);
  const [dataScope, setDataScope] = useState<DataScope>('local');
  const [deviceFilter, setDeviceFilter] = useState('all_cloud');
  const [deviceList, setDeviceList] = useState<string[]>([]);
  const [refreshCompletedAt, setRefreshCompletedAt] = useState('');
  const lastTrustedStats = useRef(new Map<string, StatsData>());
  const loadStatsRef = useRef<((options?: LoadStatsOptions) => Promise<void>) | null>(null);
  const loadedStatsQueryRef = useRef<((options?: LoadStatsOptions) => Promise<void>) | null>(null);

  const snapshotKeyFor = useCallback((
    scope: DataScope,
    selectedRange: RangeKey,
    selectedDevice: string,
    bounds: CustomDateRange | null = null,
  ) => statsSnapshotKey(
    scope,
    snapshotRangeKey(selectedRange, bounds, currentTimezone()),
    selectedDevice,
    activeCloudConfig.supabase_url,
    cloudStatus.userId,
  ), [activeCloudConfig.supabase_url, cloudStatus.userId, currentTimezone]);

  // 查询身份（口径、范围、自定义起止、设备、云端账户）一变，新请求要等这一轮渲染之后的 effect 才发出。
  // 中间这一次渲染里 stats 已清空、statsLoading 还是 false，看板会把「还没开始加载」画成失败（role=alert
  // 「看板数据暂时不可用」闪一下，T10.181 评审遗留 2）。所以「当前身份还没有请求认领」直接算加载中：切换口径、
  // 设备或账户在同一次渲染里进入加载态，只有真正失败才出错误面板（T10.200）。App 退出登录、换账户引起的身份
  // 变化走同一条路。这里只放 loadStats 依赖里的值：键一变 loadStats 必然换新，下面的 effect 必然发请求认领。
  const statsQueryKey = useMemo(
    () => [dataScope, range, customRange?.start ?? '', customRange?.end ?? '', deviceFilter, activeCloudConfig.supabase_url, cloudStatus.userId].join('\u001f'),
    [activeCloudConfig.supabase_url, cloudStatus.userId, customRange, dataScope, deviceFilter, range],
  );
  const [claimedStatsQueryKey, setClaimedStatsQueryKey] = useState<string | null>(null);
  const statsQueryPending = claimedStatsQueryKey !== statsQueryKey;

  const loadStats = useCallback(async ({ notifyOnError = true }: LoadStatsOptions = {}) => {
    setClaimedStatsQueryKey(statsQueryKey);
    const bounds = range === 'custom' ? customRange : null;
    if (range === 'custom' && !bounds) return;
    const requestId = beginRequest(statsRequestId);
    const statsKey = snapshotKeyFor(
      dataScope,
      range,
      dataScope === 'cloud' ? deviceFilter : 'all_cloud',
      bounds,
    );
    setStatsLoading(true);
    setStatsError('');
    setStatsErrorAction(null);
    try {
      const scopedMachine = scopeMachineSelection(dataScope, deviceFilter);
      const canonicalQuery = normalizeStatsQuery({
        range,
        start: bounds?.start,
        end: bounds?.end,
        timezone: currentTimezone(),
        machines: scopedMachine.machines,
        tools: [],
        models: [],
        search: null,
        tokenMode: 'effective',
      });
      const response = await invoke<unknown>('get_cached_stats', {
        scope: dataScope,
        range,
        start: canonicalQuery.start ?? null,
        end: canonicalQuery.end ?? null,
        deviceFilter: scopedMachine.deviceFilter,
        timezone: canonicalQuery.timezone,
        machines: canonicalQuery.machines,
        tools: canonicalQuery.tools,
        models: canonicalQuery.models,
        search: canonicalQuery.search,
        tokenMode: canonicalQuery.tokenMode,
      });
      const res = parseStatsDataContract(response);
      if (!isCurrentRequest(statsRequestId, requestId)) return;
      if (res.meta?.query && !queryEchoMatches(res.meta.query, canonicalQuery)) {
        throw new Error('统计响应与当前筛选不一致，请重试。');
      }
      setStats((previous) => (sameStatsSnapshot(previous, res) ? previous : res));
      if (statsKey) lastTrustedStats.current.set(statsKey, res);
      if (dataScope === 'cloud' && isStatsV2Capable(res)) {
        setCloudSetup((previous) => ({ ...previous, capabilityVerified: true, lastError: '' }));
      }
      setStatsError('');
      setStatsErrorAction(null);
      setDeviceList((previous) => {
        const next = res.machines || [];
        return previous.length === next.length && previous.every((machine, index) => machine === next[index]) ? previous : next;
      });
    } catch (err) {
      if (!isCurrentRequest(statsRequestId, requestId)) return;
      const failure = classifyCloudFailure(err);
      const errorMessage = dataScope === 'cloud'
        ? `${failure.label}：${failure.message || '请稍后重试'}`
        : `加载本地数据失败: ${err}`;
      setStatsError(errorMessage);
      setStatsErrorAction('load');
      if (notifyOnError) showMessage('error', errorMessage);
      const trusted = statsKey ? lastTrustedStats.current.get(statsKey) || null : null;
      setStats(trusted);
      setDeviceList(trusted?.machines || []);
      if (dataScope === 'cloud') {
        setCloudSetup((previous) => ({ ...previous, lastError: errorMessage }));
      }
    } finally {
      if (isCurrentRequest(statsRequestId, requestId)) setStatsLoading(false);
    }
  }, [currentTimezone, customRange, dataScope, deviceFilter, range, setCloudSetup, showMessage, snapshotKeyFor, statsQueryKey]);

  // Query identity changes should fetch the new frame without rebuilding the
  // long-lived event and visibility subscriptions around it. The first read
  // starts independently of event registration: a stalled listener must not
  // leave the primary dashboard in an endless loading state.
  useEffect(() => {
    loadStatsRef.current = loadStats;
    if (loadedStatsQueryRef.current === loadStats) return;
    loadedStatsQueryRef.current = loadStats;
    void loadStats();
  }, [loadStats]);

  // Token 口径只决定排序与 displayTotal，不改请求（tokenMode 固定 effective）：换口径只重排同一份
  // 统计，不清空、不重新请求（T10.200）。算法见上面的 project* 函数，DashboardTab 的旧画面共用它们。
  const activeTools = useMemo(() => projectActiveTools(stats, showTotalTokens), [stats, showTotalTokens]);
  const allModels = useMemo(() => projectAllModels(stats, showTotalTokens), [stats, showTotalTokens]);
  const topModels = useMemo(() => projectTopModels(allModels), [allModels]);

  const triggerScan = useCallback(async () => {
    setBusy((p: any) => ({ ...p, scan: true }));
    showMessage('info', '正在扫描本地日志');
    try {
      const res = await invoke<{ message: string }>('refresh_scan');
      const completedAt = new Date();
      setStatsError('');
      setStatsErrorAction(null);
      showMessage('success', `${res.message} · 完成于 ${formatLocalDateTime(completedAt)}`);
      setRefreshCompletedAt(completedAt.toISOString());
    } catch (err) {
      const errorMessage = `扫描失败: ${err}`;
      setStatsError(errorMessage);
      setStatsErrorAction('scan');
      showMessage('error', errorMessage);
    } finally {
      setBusy((p: any) => ({ ...p, scan: false }));
    }
  }, [setBusy, showMessage]);

  const triggerSync = useCallback(async () => {
    setBusy((p: any) => ({ ...p, sync: true }));
    showMessage('info', '正在同步到 Supabase');
    try {
      const res = await invoke<unknown>('sync_to_supabase');
      const uploadResult = res && typeof res === 'object'
        ? res as { success?: unknown; message?: unknown; warning?: unknown }
        : null;
      if (
        uploadResult?.success !== true
        || typeof uploadResult.message !== 'string'
        || uploadResult.message.trim().length === 0
        || !(
          uploadResult.warning === undefined
          || uploadResult.warning === null
          || typeof uploadResult.warning === 'string'
        )
      ) {
        const message = res && typeof res === 'object' && 'message' in res
          ? String(res.message)
          : '主同步未返回成功状态';
        throw new Error(message);
      }
      const warning = typeof uploadResult.warning === 'string' && uploadResult.warning.trim()
        ? uploadResult.warning
        : null;
      const completedAt = new Date();
      const completion = ` · 完成于 ${formatLocalDateTime(completedAt)}`;
      showMessage(
        warning ? 'warning' : 'success',
        warning
          ? `${uploadResult.message}；${warning}${completion}`
          : `${uploadResult.message}${completion}`,
      );
      setRefreshCompletedAt(completedAt.toISOString());
      const firstSyncCompleted = isSuccessfulCloudSyncResult(uploadResult);
      setCloudSetup((previous) => ({
        ...previous,
        firstSyncCompleted: previous.firstSyncCompleted || firstSyncCompleted,
        lastError: warning ? `首次同步尚未完整确认：${warning}` : '',
      }));
      await Promise.all([refreshCloudStatus(), loadDbInfo()]);
      await loadQuotaSyncStatus();
    } catch (err) {
      const failure = classifyCloudFailure(err);
      const text = `${failure.label}：${failure.message || '同步未完成'}`;
      setCloudSetup((previous) => ({ ...previous, lastError: text }));
      showMessage('error', `同步失败: ${failure.message || failure.label}`);
    } finally {
      setBusy((p: any) => ({ ...p, sync: false }));
    }
  }, [loadDbInfo, loadQuotaSyncStatus, refreshCloudStatus, setBusy, setCloudSetup, showMessage]);

  const triggerWallpaper = useCallback(async (target: 'desktop' | 'lockscreen' | 'both') => {
    if (appSettings.wallpaper_consent_version < 1) {
      setSettingsAnchor('settings-wallpaper');
      changeTab('settings');
      showMessage('warning', '请先确认历史壁纸授权，再执行系统壁纸写入');
      return;
    }
    setBusy((p: any) => ({ ...p, wallpaper: true }));
    showMessage('info', '正在渲染壁纸');
    try {
      const res = await invoke<{ message: string; desktop: boolean; lockscreen: boolean; path: string }>('update_wallpaper', { target });
      const applied = target === 'desktop'
        ? res.desktop
        : target === 'lockscreen'
          ? res.lockscreen
          : res.desktop && res.lockscreen;
      if (!applied) throw new Error(`系统未应用 ${target} 壁纸`);
      showMessage('success', res.message);
    } catch (err) {
      showMessage('error', `壁纸更新失败: ${err}`);
    } finally {
      setBusy((p: any) => ({ ...p, wallpaper: false }));
    }
  }, [appSettings.wallpaper_consent_version, changeTab, setBusy, setSettingsAnchor, showMessage]);

  const selectCloudScope = useCallback(() => {
    if (!cloudStatusKnown) {
      changeTab('settings');
      showMessage('info', '正在检查云端账户状态');
      return;
    }
    if (!cloudStatus.authenticated) {
      changeTab('settings');
      showMessage('info', '请先登录 Supabase');
      return;
    }
    // 已在「云端汇总 · 全部设备」时再点一次不是切换：查询身份不变就不会发新请求，这时清掉 stats 会停在
    // 没有请求、也没有错误的空帧上，看板只能把它画成失败（T10.200）。
    if (dataScope === 'cloud' && deviceFilter === 'all_cloud') return;
    const trusted = snapshotKeyFor('cloud', range, 'all_cloud', customRange);
    const snapshot = trusted ? lastTrustedStats.current.get(trusted) || null : null;
    setStats(snapshot);
    setDeviceList(snapshot?.machines || []);
    setStatsError('');
    setStatsErrorAction(null);
    setEntitySelection(null);
    setDataScope('cloud');
    setDeviceFilter('all_cloud');
    // 账号筛选只在本机有，切到云端时一并清掉。
    setDetailFilters((previous: any) => ({ ...previous, machines: [], providers: [] }));
  }, [changeTab, cloudStatus.authenticated, cloudStatusKnown, customRange, dataScope, deviceFilter, range, setDetailFilters, setEntitySelection, showMessage, snapshotKeyFor]);

  const selectLocalScope = useCallback(() => {
    // 同上：已在本机时再点一次什么都不做，不能清出一个没有请求的空帧。
    if (dataScope === 'local' && deviceFilter === 'all_cloud') return;
    const trusted = snapshotKeyFor('local', range, 'all_cloud', customRange);
    const snapshot = trusted ? lastTrustedStats.current.get(trusted) || null : null;
    setStats(snapshot);
    setDeviceList(snapshot?.machines || []);
    setStatsError('');
    setStatsErrorAction(null);
    setEntitySelection(null);
    setDeviceFilter('all_cloud');
    setDataScope('local');
    setDetailFilters((previous: any) => ({ ...previous, machines: [] }));
  }, [customRange, dataScope, deviceFilter, range, setDetailFilters, setEntitySelection, snapshotKeyFor]);

  const changeHeaderDevice = useCallback((value: string) => {
    if (value === deviceFilter) return;
    const trusted = snapshotKeyFor(
      dataScope,
      range,
      dataScope === 'cloud' ? value : 'all_cloud',
      customRange,
    );
    const snapshot = trusted ? lastTrustedStats.current.get(trusted) || null : null;
    setStats(snapshot);
    setDeviceList(snapshot?.machines || []);
    setStatsError('');
    setStatsErrorAction(null);
    setDetails(null);
    setEntitySelection(null);
    setDeviceFilter(value);
    setDetailFilters((previous: any) => ({ ...previous, machines: [] }));
  }, [customRange, dataScope, deviceFilter, range, setDetailFilters, setDetails, setEntitySelection, snapshotKeyFor]);

  const changeRange = useCallback((value: RangeKey, bounds: CustomDateRange | null = null) => {
    const nextBounds = value === 'custom' ? bounds : null;
    if (value === 'custom' && !nextBounds) return;
    if (nextBounds) {
      // T10.185 review P3-1: a custom range starting after "today" in the
      // request's time zone can never be satisfied locally or in the cloud
      // (Rust's `NormalizedStatsQuery::from_query` rejects it too — this is
      // the same rule, checked early enough to give a clear message instead
      // of a confusing round trip). `en-CA` formats as YYYY-MM-DD, matching
      // `bounds.start`'s shape exactly (same pattern as `liveWallpaper.ts`).
      const todayInTimezone = new Intl.DateTimeFormat('en-CA', {
        timeZone: currentTimezone(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      if (nextBounds.start > todayInTimezone) {
        showMessage(
          'error',
          `自定义范围的开始日期（${nextBounds.start}）晚于当前时区的今天（${todayInTimezone}），请重新选择。`,
        );
        return;
      }
    }
    if (value === range && sameCustomRange(nextBounds, customRange)) return;
    const trusted = snapshotKeyFor(
      dataScope,
      value,
      dataScope === 'cloud' ? deviceFilter : 'all_cloud',
      nextBounds,
    );
    const snapshot = trusted ? lastTrustedStats.current.get(trusted) || null : null;
    setStats(snapshot);
    setDeviceList(snapshot?.machines || []);
    setStatsError('');
    setStatsErrorAction(null);
    setDetails(null);
    setEntitySelection(null);
    setRange(value);
    setCustomRange(nextBounds);
  }, [
    currentTimezone,
    customRange,
    dataScope,
    deviceFilter,
    range,
    setDetails,
    setEntitySelection,
    showMessage,
    snapshotKeyFor,
  ]);

  // Focus & visibility reconciler
  useEffect(() => {
    const visibleReconciler = createVisibleStatsReconciler(
      () => document.visibilityState,
      () => { void loadStatsRef.current?.({ notifyOnError: false }); },
    );
    const reconcileVisibleStats = () => { visibleReconciler.request(); };
    const id = window.setInterval(() => {
      reconcileVisibleStats();
    }, 5 * 60_000);
    window.addEventListener('focus', reconcileVisibleStats);
    document.addEventListener('visibilitychange', reconcileVisibleStats);
    return () => {
      window.clearInterval(id);
      visibleReconciler.cancel();
      window.removeEventListener('focus', reconcileVisibleStats);
      document.removeEventListener('visibilitychange', reconcileVisibleStats);
    };
  }, []);

  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const loadDetailsRef = useRef(loadDetails);
  loadDetailsRef.current = loadDetails;
  const loadSettingsRef = useRef(loadSettings);
  loadSettingsRef.current = loadSettings;
  const loadQuotaSyncStatusRef = useRef(loadQuotaSyncStatus);
  loadQuotaSyncStatusRef.current = loadQuotaSyncStatus;
  const loadDbInfoRef = useRef(loadDbInfo);
  loadDbInfoRef.current = loadDbInfo;
  const showMessageRef = useRef(showMessage);
  showMessageRef.current = showMessage;

  // Event subscriptions
  useEffect(() => {
    let disposed = false;
    let unlistenStats: (() => void) | null = null;
    // 待上传记录数随扫描与同步变化，而 stats-updated 正是在扫描入库或同步之后发出：同一事件里一起重读，
    // 云端预测才不会拿过时的 0 当作来源完整（T10.159 P2-1）。
    const refreshAfterEvent = () => {
      void loadStatsRef.current?.({ notifyOnError: false });
      void loadDbInfoRef.current();
      if (activeTabRef.current === 'logs') void loadDetailsRef.current();
    };
    void subscribeThenReconcile(
      (onEvent) => listen('stats-updated', onEvent),
      refreshAfterEvent,
      () => {
        void loadStatsRef.current?.({ notifyOnError: false });
        void loadDbInfoRef.current();
      },
      () => disposed,
    ).then((unlisten) => {
      if (disposed) unlisten?.();
      else unlistenStats = unlisten;
    }).catch((error) => {
      console.error('统计刷新监听注册失败:', error);
      if (!disposed) void loadStatsRef.current?.({ notifyOnError: false });
    });
    const unlistenWallpaper = listen('wallpaper-updated', () => showMessageRef.current('success', '壁纸已更新'));
    const unlistenQuotaSync = listen<unknown>('quota-sync-updated', () => {
      void Promise.allSettled([
        Promise.resolve().then(() => loadSettingsRef.current()),
        Promise.resolve().then(() => loadQuotaSyncStatusRef.current()),
      ]);
    });
    return () => {
      disposed = true;
      unlistenStats?.();
      unlistenWallpaper.then((fn) => fn());
      unlistenQuotaSync.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlistenPrices = listen('prices-updated', () => {
      if (pricesDirty) {
        showMessage('info', '发现新的模型价格项；请先保存或重置当前未保存的价格修改');
        return;
      }
      loadPrices();
    });
    return () => {
      unlistenPrices.then((fn) => fn());
    };
  }, [loadPrices, pricesDirty, showMessage]);

  return {
    stats,
    setStats,
    statsLoading: statsLoading || statsQueryPending,
    statsError,
    statsErrorAction,
    setStatsError,
    setStatsErrorAction,
    statsRequestId,
    range,
    customRange,
    dataScope,
    setDataScope,
    deviceFilter,
    setDeviceFilter,
    deviceList,
    setDeviceList,
    refreshCompletedAt,
    lastTrustedStats,
    snapshotKeyFor,
    loadStats,
    activeTools,
    allModels,
    topModels,
    triggerScan,
    triggerSync,
    triggerWallpaper,
    selectCloudScope,
    selectLocalScope,
    changeHeaderDevice,
    changeRange,
  };
}
