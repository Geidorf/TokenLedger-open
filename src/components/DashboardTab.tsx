import { useCallback, useMemo, useRef, useState } from 'react';
import { Cloud, FolderSearch, RefreshCw, Settings, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { CacheFlowPanel } from './CacheFlowPanel';
import { CostEfficiencyQuadrantPanel } from './CostEfficiencyQuadrantPanel';
import { HeatmapSection } from './HeatmapSection';
import { UsageSplitPanel } from './usage/UsageSplitPanel';
import { splitHeatmapView, type SplitDimension, type SplitFocus, type SplitMetric } from '../utils/usageSplit';
import { LoadingSkeleton, MetricsSkeleton } from './LoadingSkeleton';
import { MetricsGrid } from './MetricsGrid';
import { ModelCostDistributionPanel } from './ModelCostDistributionPanel';
import { ToolStrip } from './ToolStrip';
import { TemporalInsightsSection } from './TemporalInsightsSection';
import { TrendPanel } from './TrendPanel';
import { QuotaPanel } from './QuotaPanel';
import { QuotaHighlights } from './QuotaHighlights';
import { providerDisplayName } from '../utils/quotaOverview';
import { DashboardDisplayPreferencesDialog } from './DashboardDisplayPreferencesDialog';
import { DashboardContextBar } from './DashboardContextBar';
import type { DayDrillUnavailable } from '../hooks/useDayDrill';
import { projectActiveTools, projectAllModels, projectTopModels } from '../hooks/useStats';
import type { CustomDateRange, ModelStat, QuotaProviderEnvelope, QuotaSyncStatus, RangeKey, StatsData, StatsErrorAction, ToolStat } from '../types';
import { summaryEffectiveTokens, toolColorMap } from '../types';
import { formatLocalDateTime, formatNum, formatTokens } from '../utils/format';
import { deriveInsightTimeContext } from '../utils/insightRules';
import { classifyCloudFailure, customRangeSpanDays, type CloudFailureKind } from '../utils/frontendContracts';
import { formatCustomRangeLabel } from '../utils/rangeDisplay';
import { useTheme } from '../utils/useTheme';
import { effectiveVisibleQuotaSourceKeys, orderQuotaSourceKeys, quotaSourceKey, useDashboardDisplayPreferences, type DashboardModuleId } from '../utils/useDashboardDisplayPreferences';

interface DashboardTabProps {
  /** 用量外壳已提供页面标题。 */
  hasPageTitle?: boolean;
  stats: StatsData | null;
  statsLoading: boolean;
  statsError: string;
  statsErrorAction: StatsErrorAction | null;
  scanBusy: boolean;
  syncBusy: boolean;
  activeTools: ToolStat[];
  /** Token 排行图用的前 8 个模型。 */
  topModels: ModelStat[];
  /** 本期全部模型：金额分布与用量/费用分布必须用全集（审计 P0-2）。缺省时取 stats.models。 */
  allModels?: ModelStat[];
  showTotalTokens: boolean;
  range: RangeKey;
  /** range === 'custom' 时的日期闭区间，用于决定是否展示日历热力。 */
  customRange?: CustomDateRange | null;
  scope: 'local' | 'cloud';
  /**
   * 范围以外的查询身份键（口径 + 设备 + 云端账户，由 App 拼好传入）。切到未缓存的范围时只在同一身份下
   * 保留上一帧，身份一变就不带旧数据（T10.181 R-46 P3-4）。缺省时只按 scope 判断。
   */
  queryIdentity?: string;
  cloudAuthenticated: boolean;
  cloudCapabilityVerified: boolean;
  quotaProviders: QuotaProviderEnvelope[];
  quotaLoading: boolean;
  quotaError: string;
  quotaSyncStatus: QuotaSyncStatus;
  onQuotaSyncNow: () => void;
  /**
   * 本机待上传记录数；null 表示未知（数据库信息尚未读取或读取失败）。未知不当作 0：横幅只在明确 > 0 时
   * 出现，云端预测把未知与 > 0 一样按来源不完整处理（T10.159 P2-1）。
   */
  unsyncedRecords: number | null;
  onToolClick?: (tool: ToolStat) => void;
  onModelClick?: (model: ModelStat) => void;
  onScan?: () => void;
  onSync: () => void;
  onOpenCloudSettings: () => void;
  onRetryStats: () => void;
  onRelogin: () => void;
  onViewLocal: () => void;
  onRefreshQuotas: () => void;
  onOpenQuotaSettings: () => void;
  onQuotaNotify: (message: string) => void;
  refreshCompletedAt: string;
  /** 日期下钻：进入该日的单日复盘（审计 P0-1）。 */
  /** `entity` 只在热力图只看某个 Agent 或模型时传：单日明细同时按它筛选。 */
  onSelectDate?: (date: string, entity?: { tools: string[]; models: string[] }) => void;
  /** 当前作用域做不了单日复盘时（桌面云端）的说明；入口显示为不可用，绝不跳到空结果。 */
  dateDrillUnavailable?: DayDrillUnavailable | null;
  /**
   * 额度详情在用量 · 额度子页时给出：概览只留额度要点，点开跳过去，
   * 不再在概览里重复渲染完整额度面板与恢复入口。
   */
  onOpenAllowances?: () => void;
}

export function cloudSyncRecoveryCopy(setup: {
  authenticated: boolean;
  capabilityVerified: boolean;
}): { title: string; description: string } | null {
  if (!setup.authenticated) {
    return {
      title: '先登录云端账户，再同步本机数据',
      description: '当前设备尚未建立云端会话，请先在设置中登录。',
    };
  }
  if (!setup.capabilityVerified) {
    return {
      title: '先验证 Stats v2，再同步本机数据',
      description: '云端能力尚未确认，请先完成设置中的验证步骤。',
    };
  }
  return null;
}

export function cloudSyncDisabledReason(setup: {
  authenticated: boolean;
  capabilityVerified: boolean;
  busy: boolean;
}): string | null {
  if (setup.busy) return null;
  if (!setup.authenticated) return '请先在设置与云端登录云端账户';
  if (!setup.capabilityVerified) return '请先在设置与云端完成 Stats v2 验证';
  return null;
}

export function statsErrorRecoveryCopy(
  scope: 'local' | 'cloud',
  error: string,
  action: StatsErrorAction = 'load',
): { title: string; description: string } | null {
  if (!error.trim()) return null;
  return {
    title: scope === 'cloud'
      ? '云端刷新失败，仍在显示当前范围最后一次可信数据'
      : action === 'scan'
        ? '本地扫描失败，仍在显示最近一次可信数据'
        : '本地刷新失败，仍在显示最近一次可信数据',
    description: error,
  };
}

/** 看板取数失败的种类（T10.200，T10.185 评审 P3-5）：本机读取、本机扫描，以及 classifyCloudFailure 的云端种类。 */
export type StatsFailureKind = 'local-read' | 'local-scan' | CloudFailureKind;

export function statsFailureKind(
  scope: 'local' | 'cloud',
  error: string,
  action: StatsErrorAction | null,
): StatsFailureKind | null {
  if (!error.trim()) return null;
  if (action === 'scan') return 'local-scan';
  if (scope === 'local') return 'local-read';
  // useStats 写进来的是「标签：原文」，classifyCloudFailure 认得自己的标签，得到的就是 useStats 当时的归类。
  return classifyCloudFailure(error).kind;
}

export type StatsRecoveryAction =
  | 'retry-load'
  | 'retry-scan'
  | 'relogin'
  | 'choose-preset'
  | 'open-cloud-settings'
  | 'view-local';

/**
 * 每种失败给的恢复动作，第一个是主动作（T10.200）。只给这一类失败真正用得上的动作：云端范围受限时
 * 重试必然再失败、重新登录也无关；会话失效时重试没用；云端版本不兼容或权限不足时要去设置里验证。
 * 措辞沿用界面已有的写法（重试加载、重试扫描、重新登录、去设置、临时查看本机）；「选择预设范围」取自
 * 云端范围受限的原文「请切换到“本地机器”或选择预设范围」。
 */
export function statsRecoveryActions(kind: StatsFailureKind): StatsRecoveryAction[] {
  switch (kind) {
    case 'local-scan':
      return ['retry-scan'];
    case 'local-read':
      return ['retry-load'];
    case 'range-unsupported':
      return ['choose-preset', 'view-local'];
    case 'session-expired':
      return ['relogin', 'view-local'];
    case 'capability-missing':
    case 'permission':
      return ['open-cloud-settings', 'view-local'];
    case 'offline':
    case 'service':
      return ['retry-load', 'view-local'];
  }
}

/** 范围控件（RangeControl）的无障碍名称；「选择预设范围」把焦点移到这一组的第一个预设上。 */
const RANGE_CONTROL_GROUP_SELECTOR = '[role="group"][aria-label="统计时间范围"]';

function focusRangePresets() {
  document.querySelector<HTMLElement>(RANGE_CONTROL_GROUP_SELECTOR)?.querySelector<HTMLButtonElement>('button')?.focus();
}

/**
 * 范围以外的查询身份（T10.181 R-46 P3-4 定义，T10.200 由 App 接线）：口径 + 设备 + 云端账户。本机口径只有
 * 一种身份；云端口径下账户键为空（未登录或身份未确认）也是一种身份，登录或换账户后就不再相同。
 */
export function dashboardQueryIdentity(
  scope: 'local' | 'cloud',
  deviceFilter: string,
  cloudIdentity: string | null,
): string {
  if (scope === 'local') return 'local';
  return `cloud\u001e${cloudIdentity ?? ''}\u001e${deviceFilter}`;
}

export interface DashboardRefreshCopy {
  busy: boolean;
  label: string;
  ariaLabel: string;
}

export function dashboardRefreshCopy({
  scope,
  statsLoading,
  scanBusy,
  syncBusy,
}: {
  scope: 'local' | 'cloud';
  statsLoading: boolean;
  scanBusy: boolean;
  syncBusy: boolean;
}): DashboardRefreshCopy {
  if (scope === 'cloud') {
    if (syncBusy) {
      return { busy: true, label: '同步中…', ariaLabel: '正在同步并刷新云端看板' };
    }
    if (statsLoading) {
      return { busy: true, label: '加载中…', ariaLabel: '正在加载云端看板' };
    }
    return { busy: false, label: '同步并刷新', ariaLabel: '同步并刷新云端看板' };
  }
  if (scanBusy) {
    return { busy: true, label: '扫描中…', ariaLabel: '正在扫描本地日志并刷新看板' };
  }
  if (statsLoading) {
    return { busy: true, label: '加载中…', ariaLabel: '正在加载本机看板' };
  }
  return { busy: false, label: '刷新扫描', ariaLabel: '刷新并扫描本地日志' };
}

export function shouldShowDeviceDistribution(
  scope: 'local' | 'cloud',
  stats: StatsData,
) {
  return scope === 'cloud'
    && (stats.meta?.query?.machines?.length || 0) === 0
    && Array.isArray(stats.machineDistribution)
    && stats.machineDistribution.filter((machine) => machine.tokens > 0).length > 1;
}

/** 最近一次真正显示过的看板数据（T10.181：切到未缓存的范围时留着它，标成加载中）。 */
interface DashboardFrame {
  stats: StatsData;
  activeTools: ToolStat[];
  topModels: ModelStat[];
  allModels?: ModelStat[];
  range: RangeKey;
  customRange: CustomDateRange | null;
  scope: 'local' | 'cloud';
  queryIdentity: string | undefined;
  /**
   * 排行与分布的 displayTotal 是按哪种 Token 口径算的（R-46 P3-2）。口径变了，旧帧用同一份 stats 按新口径
   * 重排后再显示（T10.200），不会拿旧口径的排行配新口径的 KPI。
   */
  showTotalTokens: boolean;
}

function sameBounds(left: CustomDateRange | null, right: CustomDateRange | null) {
  return left?.start === right?.start && left?.end === right?.end;
}

/** 顶栏范围控件上的写法（AppHeader 的 RANGE_OPTIONS 与自定义按钮文字）；frontend-contracts 逐项比对。 */
const RANGE_CONTROL_LABELS: Record<Exclude<RangeKey, 'custom'>, string> = {
  today: '今日',
  week: '本周',
  month: '本月',
  year: '今年',
  all: '总计',
};

export function rangeControlLabel(range: RangeKey, customRange: CustomDateRange | null): string {
  if (range !== 'custom') return RANGE_CONTROL_LABELS[range];
  return customRange ? formatCustomRangeLabel(customRange.start, customRange.end) : '自定义';
}

/** 保留旧画面时页头标题下的那一行（T10.181 R-46，GLB-01）：正在加载哪一段，下方仍是哪一段。 */
export function heldRangeNoticeCopy(loadingLabel: string, shownLabel: string): string {
  return `正在加载「${loadingLabel}」，下方暂为「${shownLabel}」的数据`;
}

function QuotaRecoveryCue({
  busy,
  onRefresh,
  onOpenSettings,
}: {
  busy: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div
      className="quota-recovery-cue cloud-recovery-banner"
      role="region"
      aria-label="额度失败恢复入口"
      aria-busy={busy || undefined}
    >
      <div>
        <strong>额度暂时无法更新</strong>
        <span>详细额度区位于下方；可以直接重新读取，或检查来源配置。</span>
      </div>
      <div className="cloud-recovery-actions">
        <button
          className="secondary-inline"
          type="button"
          onClick={onRefresh}
          disabled={busy}
          aria-label={busy ? '正在重新读取额度' : '重新读取额度'}
          title={busy ? '正在重新读取额度' : '重新读取额度'}
          aria-busy={busy || undefined}
        >
          {busy ? '读取中…' : '重新读取额度'}
        </button>
        <button className="ghost-inline" type="button" onClick={onOpenSettings} disabled={busy}>
          检查额度来源
        </button>
      </div>
    </div>
  );
}

export function DashboardTab({
  hasPageTitle = false,
  stats: statsProp,
  statsLoading: statsRequestLoading,
  statsError,
  statsErrorAction,
  scanBusy,
  syncBusy,
  activeTools: activeToolsProp,
  topModels: topModelsProp,
  allModels: allModelsProp,
  showTotalTokens,
  range: rangeProp,
  customRange: customRangeProp = null,
  scope,
  queryIdentity,
  cloudAuthenticated,
  cloudCapabilityVerified,
  quotaProviders = [],
  quotaLoading,
  quotaError,
  quotaSyncStatus,
  onQuotaSyncNow,
  unsyncedRecords,
  onToolClick,
  onModelClick,
  onScan,
  onSync,
  onOpenCloudSettings,
  onRetryStats,
  onRelogin,
  onViewLocal,
  onRefreshQuotas,
  onOpenQuotaSettings,
  onQuotaNotify,
  refreshCompletedAt,
  onSelectDate,
  dateDrillUnavailable = null,
  onOpenAllowances,
}: DashboardTabProps) {
  const quotaSectionRef = useRef<HTMLDivElement>(null);
  // 用量拆分（Split by）的维度、指标与焦点：焦点同时决定热力图画哪一项。
  const [splitDimension, setSplitDimension] = useState<SplitDimension>('agent');
  const [splitMetric, setSplitMetric] = useState<SplitMetric>('tokens');
  const [splitFocus, setSplitFocus] = useState<SplitFocus | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const closePreferences = useCallback(() => setPreferencesOpen(false), []);
  const openPreferences = useCallback(() => setPreferencesOpen(true), []);
  const displayPreferences = useDashboardDisplayPreferences();
  const { effective } = useTheme(); // Screen-wide tool colour assignment below must recompute on theme toggle.
  // 首屏揭示（指标上浮、条形生长）只属于切页（DESIGN §4.4）。切换口径时 stats 先清空，
  // 内容卸载后再挂载；切到未缓存的范围时内容虽然留着（见下），之后新挂载的行也不该再播揭示。
  // stats 清空过一次之后内容带 data-entrance="settled"，由 motion.css 关掉这几条入场（T10.150 QA F7）。
  const [entrance, setEntrance] = useState<'pending' | 'shown' | 'settled'>('pending');
  if (statsProp && entrance === 'pending') setEntrance('shown');
  if (!statsProp && entrance === 'shown') setEntrance('settled');
  // T10.181：切到未缓存的范围时，useStats 把 stats 清空、开始加载。原来图表实例会全部卸载重建。
  // 现在留住刚才显示的那一帧：页头写明正在加载哪一段、下方仍是哪一段（R-46），整页标 aria-busy，
  // 刷新按钮显示「加载中…」，等新范围的数据或真正的错误到来。旧帧里的数据和范围标签一起留着，不给旧数字
  // 配新范围的名字。只认同一口径、同一查询身份（设备、账户）下的范围变化；其中任一项变了就丢掉旧帧走骨架，
  // 不把上一查询的数据标成当前的（R-46 P3-4）。Token 口径不在查询里：持有期间换口径，旧帧按新口径重排后
  // 继续留着（T10.200），不丢帧、不走骨架。
  const currentFrame = useMemo<DashboardFrame | null>(() => (statsProp ? {
    stats: statsProp,
    activeTools: activeToolsProp,
    topModels: topModelsProp,
    allModels: allModelsProp,
    range: rangeProp,
    customRange: customRangeProp,
    scope,
    queryIdentity,
    showTotalTokens,
  } : null), [statsProp, activeToolsProp, topModelsProp, allModelsProp, rangeProp, customRangeProp, scope, queryIdentity, showTotalTokens]);
  const [shownFrame, setShownFrame] = useState<DashboardFrame | null>(null);
  const rangeSwitchPending = !currentFrame
    && !statsError
    && shownFrame !== null
    && shownFrame.scope === scope
    && shownFrame.queryIdentity === queryIdentity
    && (shownFrame.range !== rangeProp || !sameBounds(shownFrame.customRange, customRangeProp));
  const heldFrame = rangeSwitchPending ? shownFrame : null;
  // 与 useStats 同一套 project* 算法：同一份旧 stats 按当前 Token 口径重排，排行、分布与 KPI 口径一致。
  const reprojectedHeldFrame = useMemo<DashboardFrame | null>(() => {
    if (!heldFrame || heldFrame.showTotalTokens === showTotalTokens) return heldFrame;
    const allModels = projectAllModels(heldFrame.stats, showTotalTokens);
    return {
      ...heldFrame,
      activeTools: projectActiveTools(heldFrame.stats, showTotalTokens),
      topModels: projectTopModels(allModels),
      allModels,
      showTotalTokens,
    };
  }, [heldFrame, showTotalTokens]);
  const frame = currentFrame ?? reprojectedHeldFrame;
  if (frame !== shownFrame) setShownFrame(frame);
  const stats = frame ? frame.stats : null;
  const activeTools = frame ? frame.activeTools : activeToolsProp;
  const topModels = frame ? frame.topModels : topModelsProp;
  const allModels = frame ? frame.allModels : allModelsProp;
  const range = frame ? frame.range : rangeProp;
  const customRange = frame ? frame.customRange : customRangeProp;
  const statsLoading = statsRequestLoading || rangeSwitchPending;
  // R-46（GLB-01）：留着旧帧时，页头标题旁写明正在加载哪一段、下方仍是哪一段，写法与顶栏范围控件相同。
  // 旧的一段取自旧帧本身，与下面各面板收到的范围是同一个值。这一行放在常驻的 role="status" 里，出现与
  // 改写（持有期间再换范围）都会播报；到数、出错或丢帧时随持有态一起消失。它和标题同一行、按基线对齐，
  // 用的是页头右侧按钮已经撑出的高度，出现与消失都不推动下方内容（T10.200，原来标题下另起一行下移约 6.3px）；
  // 窄到放不下时才折到标题下方。
  const heldRangeNotice = rangeSwitchPending
    ? heldRangeNoticeCopy(rangeControlLabel(rangeProp, customRangeProp), rangeControlLabel(range, customRange))
    : '';
  const cloudSyncDisabled = syncBusy || !cloudAuthenticated || !cloudCapabilityVerified;
  const cloudSyncDisabledReasonText = scope === 'cloud'
    ? cloudSyncDisabledReason({
      authenticated: cloudAuthenticated,
      capabilityVerified: cloudCapabilityVerified,
      busy: syncBusy,
    })
    : null;
  const cloudSyncDescriptionId = cloudSyncDisabledReasonText ? 'cloud-sync-recovery' : undefined;
  const statsRecovery = statsErrorRecoveryCopy(scope, statsError, statsErrorAction || 'load');
  const onStatsRecoveryRetry = statsErrorAction === 'scan' && onScan ? onScan : onRetryStats;
  const statsRecoveryLabel = statsErrorAction === 'scan' ? '重试扫描' : '重试加载';
  const statsRecoveryBusy = statsErrorAction === 'scan' ? scanBusy : statsLoading;
  const statsRecoveryButtonLabel = statsRecoveryBusy
    ? statsErrorAction === 'scan' ? '扫描中…' : '加载中…'
    : statsRecoveryLabel;
  const statsRecoveryButtonAriaLabel = statsRecoveryBusy
    ? statsErrorAction === 'scan' ? '正在扫描本地日志' : '正在加载统计数据'
    : statsRecoveryLabel;
  // 按失败种类给恢复动作（T10.200，T10.185 评审 P3-5）。没有错误文字却也没有数据时（理论上不再出现），
  // 按一般的云端或本机读取失败处理，至少留一个重试。
  const statsRecoveryActionIds = statsRecoveryActions(
    statsFailureKind(scope, statsError, statsErrorAction) ?? (scope === 'cloud' ? 'service' : 'local-read'),
  );
  const statsRecoveryLinks: Record<Exclude<StatsRecoveryAction, 'retry-load' | 'retry-scan'>, { label: string; onClick: () => void }> = {
    relogin: { label: '重新登录', onClick: onRelogin },
    'choose-preset': { label: '选择预设范围', onClick: focusRangePresets },
    'open-cloud-settings': { label: '去设置', onClick: onOpenCloudSettings },
    'view-local': { label: '临时查看本机', onClick: onViewLocal },
  };
  const renderStatsRecoveryActions = (variant: 'panel' | 'banner') => (
    <div className="cloud-recovery-actions">
      {statsRecoveryActionIds.map((action, index) => {
        const className = index === 0
          ? variant === 'panel' ? 'primary-inline' : 'secondary-inline'
          : action === 'view-local' ? 'ghost-inline' : 'secondary-inline';
        if (action === 'retry-load' || action === 'retry-scan') {
          return (
            <button
              key={action}
              className={className}
              type="button"
              onClick={onStatsRecoveryRetry}
              disabled={statsRecoveryBusy}
              aria-label={statsRecoveryButtonAriaLabel}
              title={statsRecoveryButtonAriaLabel}
              aria-busy={statsRecoveryBusy || undefined}
            >
              {variant === 'panel' && <RefreshCw className={`h-4 w-4 ${statsRecoveryBusy ? 'animate-spin' : ''}`} />}
              {statsRecoveryButtonLabel}
            </button>
          );
        }
        const link = statsRecoveryLinks[action];
        return <button key={action} className={className} type="button" onClick={link.onClick}>{link.label}</button>;
      })}
    </div>
  );
  const cloudSyncButtonLabel = syncBusy ? '同步中…' : '立即同步';
  const cloudSyncButtonAriaLabel = syncBusy ? '正在同步本机数据到云端' : '立即同步本机数据到云端';
  const cloudSyncButtonTitle = syncBusy
    ? '正在同步本机数据到云端'
    : cloudSyncDisabledReasonText || '立即同步本机数据到云端';
  const emptyActionBusy = scope === 'cloud' ? syncBusy : scanBusy;
  const emptyActionLabel = scope === 'cloud'
    ? syncBusy ? '同步中…' : '同步本机数据'
    : scanBusy ? '扫描中…' : '扫描本地日志';
  const emptyActionAriaLabel = scope === 'cloud'
    ? cloudSyncButtonAriaLabel
    : scanBusy ? '正在扫描本地日志' : '扫描本地日志';
  const dashboardRefresh = dashboardRefreshCopy({ scope, statsLoading, scanBusy, syncBusy });
  const quotaRecoveryBusy = quotaLoading || quotaSyncStatus.state === 'syncing';
  // The visible freshness source moved into DashboardContextBar; keep one
  // local formatted value for the footer title so the established full-date
  // contract remains inspectable without duplicating another visible label.
  const lastUpdated = useMemo(
    () => {
      if (!stats) return '时间不可得';
      const value = stats.meta?.lastRefreshedAt || stats.meta?.generatedAt;
      return value ? formatLocalDateTime(value) : '时间不可得';
    },
    [stats],
  );
  const insightTimeContext = useMemo(
    () => (stats ? deriveInsightTimeContext(stats, range, scope) : null),
    [stats, range, scope],
  );
  // 长自定义区间（> 31 天）也值得看日历热力；短区间用趋势与节奏即可。
  const showHeatmap = range === 'year'
    || range === 'all'
    || (range === 'custom' && (customRangeSpanDays(customRange?.start, customRange?.end) ?? 0) > 31);
  const sourceOptions = useMemo(() => {
    const byKey = new Map(quotaProviders.map(provider => [quotaSourceKey(provider), provider]));
    const orderedKeys = orderQuotaSourceKeys([...byKey.keys()], displayPreferences.preferences);
    const effectiveVisible = new Set(effectiveVisibleQuotaSourceKeys(orderedKeys, displayPreferences.preferences));
    return orderedKeys.map(id => {
      const provider = byKey.get(id)!;
      return {
        id,
        label: `${providerDisplayName(provider)} · ${provider.scope === 'consumer-subscription' ? '订阅' : provider.scope === 'api-organization' ? 'API 组织' : '手工预算'}`,
        visible: effectiveVisible.has(id),
      };
    });
  }, [quotaProviders, displayPreferences.preferences]);
  const moduleOptions = displayPreferences.preferences.moduleOrder.map(id => ({
    id,
    label: ({ kpi: '核心指标', trend: '趋势', quota: '订阅额度', distribution: '工具与模型分布', insights: '消费洞察' } as Record<DashboardModuleId, string>)[id],
    visible: !displayPreferences.preferences.hiddenModuleIds.includes(id),
  }));
  const moduleVisible = (id: DashboardModuleId) => !displayPreferences.preferences.hiddenModuleIds.includes(id);
  const preferencesDialog = <DashboardDisplayPreferencesDialog
    open={preferencesOpen}
    modules={moduleOptions}
    sources={sourceOptions}
    onClose={closePreferences}
    onReset={displayPreferences.reset}
    onModuleVisible={(id, visible) => displayPreferences.setModuleVisible(id, visible)}
    onModuleMove={(id, direction) => displayPreferences.moveModule(id, direction)}
    onSourceVisible={(id, visible) => displayPreferences.setQuotaSourceVisible(id, visible, sourceOptions.map(source => source.id))}
    onSourceMove={(id, direction) => displayPreferences.moveQuotaSource(id, direction, sourceOptions.map(source => source.id))}
  />;
  const heldRangeStatus = (
    <div role="status">
      {heldRangeNotice ? <p className="page-subtitle">{heldRangeNotice}</p> : null}
    </div>
  );

  if (statsLoading && !stats) {
    return (
      <div className="content-stack" role="status" aria-label="正在加载看板" aria-busy="true">
        <MetricsSkeleton />
        <LoadingSkeleton className="h-64" />
        <LoadingSkeleton className="h-64" />
      </div>
    );
  }
  if (!stats) {
    // Every state keeps the same .content-stack root (T10.150 QA F7): a <section>
    // root here made React swap the page root twice and replay the page entrance
    // (tl-enter-up) that belongs to tab switches only. Scope, device and account
    // switches now enter loading in the same render (useStats, T10.200) and a
    // range switch keeps the shown frame (T10.181), so only a real failure lands
    // here; its actions depend on the failure kind (statsRecoveryActions).
    return (
      <div className="content-stack">
        <section className="panel empty-panel details-state-error" role="alert" aria-busy={statsRecoveryBusy}>
          <div className="empty-icon"><TriangleAlert className="h-5 w-5" /></div>
          <div>
            <h2>看板数据暂时不可用</h2>
            <p>{statsError || '统计服务没有返回数据，请重试。'}</p>
          </div>
          {renderStatsRecoveryActions('panel')}
        </section>
      </div>
    );
  }

  const activeToolsList = activeTools || Object.values(stats.tools || {});
  // One tool -> colour assignment for the whole screen, computed from the
  // same rank-ordered list that feeds ToolStrip/TrendPanel, so a
  // tool reads the same colour in every panel on this tab instead of each
  // panel resolving same-slot collisions from its own, differently-ordered
  // model/point list (T10.178 review P1-1: this was the actual cause of the
  // reported "gemini is cyan in one panel, blue in another" mismatch, not
  // just a missing shift inside a single panel).
  const toolColors = toolColorMap(activeToolsList.map((tool) => tool.name), effective);
  const topModelsList = topModels || Object.values(stats.models || {});
  const allModelsList = allModels || Object.values(stats.models || {});
  const isEmpty =
    stats.summary.totalRequests <= 0 &&
    activeToolsList.length === 0 &&
    topModelsList.length === 0 &&
    (stats.history?.length || 0) === 0;
  const showDeviceDistribution = shouldShowDeviceDistribution(scope, stats);
  // 换了范围或口径后焦点项可能已不在数据里：不存在就当没有焦点，不显示一个空列表。
  const activeSplitFocus = splitFocus && (
    splitFocus.dimension === 'agent' ? Boolean(stats.tools?.[splitFocus.id])
      : splitFocus.dimension === 'model' ? Boolean(stats.models?.[splitFocus.id])
        : showDeviceDistribution && (stats.machineDistribution || []).some((machine) => machine.value === splitFocus.id)
  ) ? splitFocus : null;
  const heatmapView = splitHeatmapView(stats, activeSplitFocus, splitMetric);
  const cloudRecovery = scope === 'cloud'
    ? cloudSyncRecoveryCopy({ authenticated: cloudAuthenticated, capabilityVerified: cloudCapabilityVerified })
    : null;
  if (isEmpty) {
    return (
      <div className="content-stack" aria-busy={rangeSwitchPending || undefined}>
        <div className="page-heading">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3">
              {!hasPageTitle && <h1 className="sr-only">Token 使用看板</h1>}
              <DashboardContextBar
                scope={scope}
                range={rangeProp}
                customRange={customRangeProp}
                meta={stats.meta}
                refreshCompletedAt={refreshCompletedAt}
                heldRangeNotice={heldRangeNotice}
                refreshError={Boolean(statsError)}
              />
              {heldRangeStatus}
            </div>
          </div>
          <button className="ghost-inline" type="button" onClick={openPreferences}><SlidersHorizontal className="h-4 w-4" />调整显示</button>
        </div>
        {cloudRecovery && (
          <div className="cloud-recovery-banner" id="cloud-sync-recovery" role="status">
            <div>
              <strong>{cloudRecovery.title}</strong>
              <span>{cloudRecovery.description}</span>
            </div>
            <button className="secondary-inline" type="button" onClick={onOpenCloudSettings}>去设置</button>
          </div>
        )}
        {scope === 'cloud' && unsyncedRecords !== null && unsyncedRecords > 0 && (
          <div className="data-coverage-banner" role="status">
            <TriangleAlert className="h-4 w-4" />
            <span>本机仍有 {formatNum(unsyncedRecords)} 条记录待上传；云端趋势暂不视为完整数据。</span>
            <button
              type="button"
              onClick={onSync}
              disabled={cloudSyncDisabled}
              aria-label={cloudSyncButtonAriaLabel}
              title={cloudSyncButtonTitle}
              aria-describedby={cloudSyncDescriptionId}
              aria-busy={syncBusy || undefined}
            >
              {cloudSyncButtonLabel}
            </button>
          </div>
        )}
        {statsRecovery && (
          <div className="cloud-recovery-banner" role="alert" aria-busy={statsRecoveryBusy}>
            <div>
              <strong>{statsRecovery.title}</strong>
              <span>{statsError}</span>
            </div>
            {renderStatsRecoveryActions('banner')}
          </div>
        )}
        {moduleVisible('quota') && !onOpenAllowances && quotaError && (
          <QuotaRecoveryCue
            busy={quotaRecoveryBusy}
            onRefresh={onRefreshQuotas}
            onOpenSettings={onOpenQuotaSettings}
          />
        )}
        {moduleVisible('quota') && !onOpenAllowances && <QuotaPanel
          providers={quotaProviders}
          loading={quotaLoading}
          error={quotaError}
          showRecoveryActions={false}
          quotaSyncStatus={quotaSyncStatus}
          onRefresh={onRefreshQuotas}
          onSyncNow={onQuotaSyncNow}
          onOpenSettings={onOpenQuotaSettings}
          onNotify={onQuotaNotify}
          sourceOrder={displayPreferences.preferences.quotaSourceOrder}
          hiddenSourceIds={displayPreferences.preferences.hiddenQuotaSourceIds}
        />
        }
        <section className="panel empty-panel" aria-label="暂无数据看板">
          <div className="empty-icon">
            {scope === 'cloud' ? <Cloud className="h-5 w-5" /> : <RefreshCw className="h-5 w-5" />}
          </div>
          <div>
            <h2>{scope === 'cloud' ? '云端暂无 Token 记录' : '暂无 Token 记录'}</h2>
            <p>{scope === 'cloud' ? '将本机数据同步到云端，或切换设备范围。' : '先扫描本地日志，生成第一份使用看板。'}</p>
          </div>
          <button
            className="primary-inline"
            type="button"
            onClick={scope === 'cloud' ? onSync : onScan}
            disabled={scope === 'cloud' ? cloudSyncDisabled : scanBusy}
            aria-label={emptyActionAriaLabel}
            title={scope === 'cloud' ? cloudSyncButtonTitle : emptyActionAriaLabel}
            aria-describedby={scope === 'cloud' ? cloudSyncDescriptionId : undefined}
            aria-busy={emptyActionBusy || undefined}
          >
            {scope === 'cloud'
              ? <Cloud className={`h-4 w-4 ${syncBusy ? 'animate-pulse' : ''}`} />
              : <RefreshCw className={`h-4 w-4 ${scanBusy ? 'animate-spin' : ''}`} />}
            {emptyActionLabel}
          </button>

          {scope === 'local' && (
            <div className="zero-data-diagnostics" role="region" aria-label="本地日志扫描诊断与支持目录">
              <div className="zero-data-diagnostics-head">
                <FolderSearch className="h-4 w-4 text-primary" />
                <span>自动扫描的本地工具与默认日志路径</span>
              </div>
              <div className="zero-data-paths-grid">
                <div className="zero-data-path-chip">
                  <strong>Claude Code</strong>
                  <code>~/.claude</code>
                </div>
                <div className="zero-data-path-chip">
                  <strong>Codex CLI</strong>
                  <code>~/.codex</code>
                </div>
                <div className="zero-data-path-chip">
                  <strong>Trae</strong>
                  <code>~/.trae</code>
                </div>
                <div className="zero-data-path-chip">
                  <strong>Antigravity</strong>
                  <code>~/.antigravity</code>
                </div>
                <div className="zero-data-path-chip">
                  <strong>OpenCode</strong>
                  <code>~/.opencode</code>
                </div>
                <div className="zero-data-path-chip">
                  <strong>Kimi / Desktop</strong>
                  <code>~/.kimi</code>
                </div>
                <div className="zero-data-path-chip">
                  <strong>MiniMax</strong>
                  <code>~/.minimax</code>
                </div>
              </div>
              <p className="zero-data-diagnostics-tips">
                TokenLedger 自动解析上述目录中的日志与会话记录。若刚安装工具或尚未产生对话，请在对应工具中发起一次对话调用后点击“扫描本地日志”。
              </p>
              <div className="zero-data-diagnostics-actions">
                <button className="secondary-inline" type="button" onClick={onScan} disabled={scanBusy}>
                  <RefreshCw className={`h-3.5 w-3.5 ${scanBusy ? 'animate-spin' : ''}`} />
                  立即扫描
                </button>
                <button className="ghost-inline" type="button" onClick={onOpenQuotaSettings}>
                  <Settings className="h-3.5 w-3.5" />
                  配置额度与来源
                </button>
                <button className="ghost-inline" type="button" onClick={onOpenCloudSettings}>
                  云端与常规设置
                </button>
              </div>
            </div>
          )}
        </section>
        {preferencesDialog}
      </div>
    );
  }

  return (
    <div className="content-stack dashboard-stack" data-entrance={entrance === 'settled' ? 'settled' : undefined} aria-busy={rangeSwitchPending || undefined}>
      <div className="page-heading">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
          {!hasPageTitle && <h1 className="sr-only">Token 使用看板</h1>}
          <DashboardContextBar
            scope={scope}
            range={rangeProp}
            customRange={customRangeProp}
            meta={stats.meta}
            refreshCompletedAt={refreshCompletedAt}
            heldRangeNotice={heldRangeNotice}
            refreshError={Boolean(statsError)}
          />
          {heldRangeStatus}
        </div>
        <div className="dashboard-refresh-status">
          <button className="ghost-inline" type="button" onClick={openPreferences}><SlidersHorizontal className="h-4 w-4" />调整显示</button>
          <button
            className="secondary-inline"
            type="button"
            onClick={scope === 'cloud' ? onSync : onScan}
            disabled={dashboardRefresh.busy || (scope === 'cloud' && cloudSyncDisabled)}
            aria-label={dashboardRefresh.ariaLabel}
            title={scope === 'cloud' ? cloudSyncButtonTitle : dashboardRefresh.ariaLabel}
            aria-describedby={scope === 'cloud' ? cloudSyncDescriptionId : undefined}
            aria-busy={dashboardRefresh.busy || undefined}
          >
            <RefreshCw className={`h-4 w-4 ${dashboardRefresh.busy ? 'animate-spin' : ''}`} />
            {dashboardRefresh.label}
          </button>
          {refreshCompletedAt && (
            <time className="sr-only" dateTime={refreshCompletedAt}>
              完成于 {formatLocalDateTime(refreshCompletedAt)}
            </time>
          )}
        </div>
      </div>

      {cloudRecovery && (
        <div className="cloud-recovery-banner" id="cloud-sync-recovery" role="status">
          <div>
            <strong>{cloudRecovery.title}</strong>
            <span>{cloudRecovery.description}</span>
          </div>
          <button className="secondary-inline" type="button" onClick={onOpenCloudSettings}>去设置</button>
        </div>
      )}

      {scope === 'cloud' && unsyncedRecords !== null && unsyncedRecords > 0 && (
        <div className="data-coverage-banner" role="status">
          <TriangleAlert className="h-4 w-4" />
          <span>本机仍有 {formatNum(unsyncedRecords)} 条记录待上传；云端趋势和“上一周期”基线可能不完整。</span>
          <button
            type="button"
            onClick={onSync}
            disabled={cloudSyncDisabled}
            aria-label={cloudSyncButtonAriaLabel}
            title={cloudSyncButtonTitle}
            aria-describedby={cloudSyncDescriptionId}
            aria-busy={syncBusy || undefined}
          >
            {cloudSyncButtonLabel}
          </button>
        </div>
      )}
      {statsRecovery && (
        <div className="cloud-recovery-banner" role="alert" aria-busy={statsRecoveryBusy}>
          <div>
            <strong>{statsRecovery.title}</strong>
            <span>{statsRecovery.description}</span>
          </div>
          {renderStatsRecoveryActions('banner')}
        </div>
      )}

      {displayPreferences.preferences.moduleOrder.filter(moduleVisible).map((module) => {
        if (module === 'kpi') return <div key={module} className="dashboard-preference-module">
          <MetricsGrid summary={stats.summary} showTotalTokens={showTotalTokens} comparison={stats.comparison} meta={stats.meta} range={range} scope={scope} />
          {moduleVisible('quota') && <QuotaHighlights
            providers={quotaProviders.filter(provider => sourceOptions.some(source => source.id === quotaSourceKey(provider) && source.visible))}
            refreshFailed={Boolean(quotaError)}
            onOpen={onOpenAllowances ?? (() => {
              quotaSectionRef.current?.focus({ preventScroll: true });
              quotaSectionRef.current?.scrollIntoView({ block: 'start' });
            })} />}
        </div>;
        if (module === 'trend') return <TrendPanel key={module} trends={stats.trends} activeTools={activeToolsList} comparison={stats.comparison} range={range} scope={scope}
          overviewStats={stats} pendingUploads={unsyncedRecords} />;
        if (module === 'quota') return onOpenAllowances ? null : <div key={module} ref={quotaSectionRef} tabIndex={-1} aria-label="订阅额度详情" className="dashboard-preference-module quota-details-anchor">
          {quotaError && <QuotaRecoveryCue busy={quotaRecoveryBusy} onRefresh={onRefreshQuotas} onOpenSettings={onOpenQuotaSettings} />}
          <QuotaPanel providers={quotaProviders} loading={quotaLoading} error={quotaError} showRecoveryActions={false}
            quotaSyncStatus={quotaSyncStatus} onRefresh={onRefreshQuotas} onSyncNow={onQuotaSyncNow}
            onOpenSettings={onOpenQuotaSettings} onNotify={onQuotaNotify}
            sourceOrder={displayPreferences.preferences.quotaSourceOrder} hiddenSourceIds={displayPreferences.preferences.hiddenQuotaSourceIds} />
        </div>;
        if (module === 'distribution') return <UsageSplitPanel key={module} stats={stats}
          dimension={splitDimension === 'device' && !showDeviceDistribution ? 'agent' : splitDimension}
          metric={splitMetric} focus={activeSplitFocus}
          deviceAvailable={showDeviceDistribution} showTotalTokens={showTotalTokens}
          onDimensionChange={setSplitDimension} onMetricChange={setSplitMetric} onFocusChange={setSplitFocus}
          onOpenEntity={(kind, id) => {
            if (kind === 'tool') { const tool = stats.tools[id]; if (tool) onToolClick?.(tool); }
            else { const model = allModelsList.find((item) => item.name === id); if (model) onModelClick?.(model); }
          }} />;
        return <section key={module} className="dashboard-preference-module" aria-labelledby="dashboard-insights-title">
          <h2 id="dashboard-insights-title" className="insight-group-title">消费洞察 · 缓存与模型经济</h2>
          <CacheFlowPanel summary={stats.summary} />
          <ModelCostDistributionPanel models={allModelsList} totalCost={stats.summary.totalCost} onModelClick={onModelClick} />
          {allModelsList.length > 1 && <CostEfficiencyQuadrantPanel models={allModelsList} onModelClick={onModelClick} toolColors={toolColors} />}
          <TemporalInsightsSection trends={stats.trends} context={insightTimeContext} comparison={stats.comparison ?? null} onSelectDate={onSelectDate} dateDrillUnavailable={dateDrillUnavailable} />
          {/* Cloud scope cannot open a single day: calendar cells stay static
              (the reason text there is still open, see T10.158 log). */}
          {showHeatmap && <HeatmapSection heatmap={heatmapView.heatmap} subject={heatmapView.focused && activeSplitFocus ? activeSplitFocus.id : undefined}
            subjectUnavailable={activeSplitFocus && !heatmapView.focused ? activeSplitFocus.id : undefined}
            metric={heatmapView.metric} metricFallback={heatmapView.metricFallback}
            onSelectDate={dateDrillUnavailable || !onSelectDate ? undefined : (date) => (heatmapView.focused && activeSplitFocus
              ? onSelectDate(date, { tools: activeSplitFocus.dimension === 'agent' ? [activeSplitFocus.id] : [], models: activeSplitFocus.dimension === 'model' ? [activeSplitFocus.id] : [] })
              : onSelectDate(date))} range={range} customRange={customRange} timeContext={insightTimeContext} />}
          <ToolStrip activeTools={activeToolsList} onToolClick={onToolClick} showTotalTokens={showTotalTokens} />
        </section>;
      })}

      <p className="text-xs text-faint" title={`数据时间 ${lastUpdated}`}>
        当前显示：{showTotalTokens ? `总计 ${formatTokens(summaryEffectiveTokens(stats.summary) + stats.summary.cachedTokens)}` : `有效 ${formatTokens(summaryEffectiveTokens(stats.summary))}`} Tokens
        {showTotalTokens ? '（包含缓存）' : ` · 缓存 ${formatTokens(stats.summary.cachedTokens)}`}
      </p>
      {preferencesDialog}
    </div>
  );
}

export default DashboardTab;
