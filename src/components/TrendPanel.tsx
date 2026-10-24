import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  ChevronDown,
  GitCompareArrows,
  Layers,
  Minus,
  TrendingUp,
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { EChart } from './EChart';
import { describeMetricChange, type MetricChange } from './MetricsGrid';
import {
  formatAxisTokens,
  formatEstimatedUsd,
  formatNum,
  formatSignedPercent,
  formatSignedUsd,
  formatTokens,
  formatUsd,
  formatUsdMagnitude,
  isKnownCost,
} from '../utils/format';
import type { DataScope, RangeKey, StatsData, ToolStat, TrendPoint, UsageComparison } from '../types';
import { colorsForToolsInView } from '../types';
import { useTheme } from '../utils/useTheme';
import { useSegmentedIndicator } from '../hooks/useSegmentedIndicator';
import {
  CHART_FONT_FAMILY,
  getChartAnimation,
  getChartGrid,
  getChartThemeTokens,
  getChartTooltip,
  lineAreaGradient,
} from '../utils/chartTheme';
import {
  deriveTrendComparison,
  describeTrendPeakShift,
  escapeHtml,
} from '../utils/frontendContracts';
import {
  cloudComparisonCostKnown,
  comparisonClip,
  completedBucketAverage,
  LOCAL_ALL_OBSERVATION_DAYS,
  type CompletedBucketAverage,
} from '../utils/insightRules';
import {
  describePeriodForecast,
  forecastFromStats,
  formatUsdTriple,
  type ForecastMetricKey,
  type MetricForecast,
  type PeriodForecast,
} from '../utils/forecast';
import { toolDisplayName } from '../utils/toolDisplayName';
import { computeUnitCostUsd, formatUnitCost, unitCostDescription, unitCostLabel, unitCostUnavailable } from '../utils/unitCost';
import { InfoTip } from './InfoTip';
import { getLang, t, useLang, type MessageKey } from '../i18n';

export type TrackViewMode = 'tokens' | 'cost' | 'dual';
/** 日桶对比的呈现方式：逐日走势或累计走势（T10.154 §4.4 把“累积燃烧”改名为“累计走势”）。 */
export type TrendViewMode = 'daily' | 'cumulative';

export function trendPresentationLabels(
  track: TrackViewMode,
  viewMode: TrendViewMode,
  bucket: UsageComparison['window']['bucket'] | null,
): { metric: string; shape: string } {
  const metric = track === 'tokens'
    ? t('trend.seriesTokens')
    : track === 'cost'
      ? t('trend.metric.costUsd')
      : t('trend.metric.dual');
  if (bucket === 'hour') return { metric, shape: t('trend.shape.hourly') };
  if (bucket === 'day') return { metric, shape: viewMode === 'cumulative' ? t('trend.shape.cumulative') : t('trend.shape.daily') };
  return { metric, shape: t('trend.shape.range') };
}

interface TrendPanelBaseProps {
  trends: TrendPoint[];
  activeTools: ToolStat[];
  comparison?: UsageComparison | null;
  range: RangeKey;
  scope?: DataScope;
  currentSeriesName?: string;
  /**
   * 专属看板把一条序列的键放在 `currentSeriesName`。工具用显示名，模型 id 保持原样
   * （TOKE-12）。总览有 `activeTools` 时忽略这个开关，序列一律按工具显示名画。
   */
  currentSeriesIsTool?: boolean;
  currentOnlyNote?: string;
  initialTrack?: TrackViewMode;
}

/** 专属看板：趋势来自实体数据，不预测，也不套用总览的观察窗、截短说明与逐日费用核实。 */
export interface TrendPanelEntityProps extends TrendPanelBaseProps {
  overviewStats?: undefined;
  pendingUploads?: undefined;
}

/**
 * 总览（T10.159）：传完整统计快照，用于周期末预测（T10.153 规则层）、“全部”范围的观察窗说明、
 * 月末截短说明与云端逐日费用核实。预测只在前端即时计算，不进同步、分享海报与导出。
 */
export interface TrendPanelOverviewProps extends TrendPanelBaseProps {
  overviewStats: StatsData | null;
  /**
   * 本机待上传记录数，必填、没有缺省值（T10.159 P2-1）。云端预测只在明确为 0 时才把来源当作完整；
   * null 表示未知（数据库信息尚未读取或读取失败），与 > 0 一样按来源不完整处理：不给数字，只说明原因。
   * 本机作用域不看上传状态。
   */
  pendingUploads: number | null;
}

export type TrendPanelProps = TrendPanelEntityProps | TrendPanelOverviewProps;

const RANGE_COMPARISON_LABELS: Partial<Record<RangeKey, [MessageKey, MessageKey]>> = {
  today: ['trend.label.today', 'trend.label.yesterday'],
  week: ['trend.label.week', 'trend.label.lastWeek'],
  month: ['trend.label.month', 'trend.label.lastMonth'],
  custom: ['trend.label.custom', 'trend.label.previousRange'],
};

const WEEKDAY_KEYS = ['trend.weekday.0', 'trend.weekday.1', 'trend.weekday.2', 'trend.weekday.3', 'trend.weekday.4', 'trend.weekday.5', 'trend.weekday.6'] as const;

export function isCloudComparisonBaselineUnverified(
  scope: DataScope,
  comparison?: UsageComparison | null,
): boolean {
  return scope === 'cloud'
    && !!comparison
    && comparison.previous.summary.totalRequests === 0
    && comparison.previous.summary.totalTokens === 0;
}

const AVERAGE_NUMBER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

function formatAverageTokens(value: number): string {
  return Math.abs(value) >= 1_000 ? formatTokens(value) : AVERAGE_NUMBER.format(value);
}

const FORECAST_TOKEN_UNITS = [
  { threshold: 999_500_000, divisor: 1_000_000_000, suffix: 'B', decimals: 1 },
  { threshold: 999_500, divisor: 1_000_000, suffix: 'M', decimals: 1 },
  { threshold: 999.5, divisor: 1_000, suffix: 'K', decimals: 0 },
] as const;

/**
 * 图上逐日预测点的格式，按 T10.153 规格 §5.1“数值格式”：点值与上下限同单位、同精度，Token 按点值
 * 取单位（≥999,500 进位到 M），金额三个值都走 `forecast.ts` 导出的 `formatUsdTriple`（T10.197 评审
 * P3-1）：文字行与图上提示不再各存一份算法，不会再互相漂移。点值落在 <$0.01 时不再加 ≈——已经是
 * 「小于」的写法，≈ 会变成双重模糊；其余情况仍加 ≈ 表示逐日预测本身就是估算。
 */
export function formatForecastTriple(
  metric: ForecastMetricKey,
  point: number,
  low: number,
  high: number,
): { point: string; low: string; high: string } {
  if (metric === 'cost') {
    const { point: pointText, low: lowText, high: highText } = formatUsdTriple(point, low, high);
    return { point: pointText.startsWith('<') ? pointText : `≈${pointText}`, low: lowText, high: highText };
  }
  const unit = FORECAST_TOKEN_UNITS.find((candidate) => point >= candidate.threshold)
    ?? { divisor: 1, suffix: '', decimals: 0 };
  let decimals: number = unit.decimals;
  const format = (value: number) => `${(value / unit.divisor).toFixed(decimals)}${unit.suffix}`;
  const collapsed = () => format(low) === format(high)
    || (low > 0 && Number((low / unit.divisor).toFixed(decimals)) === 0);
  while (unit.divisor > 1 && decimals < 2 && collapsed()) decimals += 1;
  return { point: format(point), low: format(low), high: format(high) };
}

export function formatBucketLabel(value: string): string {
  if (/^\d{2}:00$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(5);
  if (/^\d{4}-\d{2}$/.test(value)) {
    const month = Number(value.slice(5, 7));
    return getLang() === 'en'
      ? new Intl.DateTimeFormat('en-US', { month: 'short' }).format(new Date(2000, month - 1, 1))
      : t('trend.monthLabel', { month });
  }
  return value;
}

export function getWeekdayName(dateStr: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '';
  const key = WEEKDAY_KEYS[d.getDay()];
  return key ? t(key) : '';
}

/**
 * 总览趋势卡在“全部”范围的观察窗说明（T10.159，审计 Q5）：本机只预置最近 31 个日桶，
 * 云端逐日画全部历史。专属看板的趋势来自实体热力，不适用这句话，因此只由总览传入。
 */
export function overviewTrendWindowNote(range: RangeKey, scope: DataScope): string | undefined {
  if (range !== 'all') return undefined;
  if (scope === 'local') {
    return t('trend.windowNote.local', { days: LOCAL_ALL_OBSERVATION_DAYS });
  }
  return t('trend.windowNote.cloud');
}

/** 规则层不给数字、但界面仍需说明原因的状态（GLB-11：说明原因而不给数字）。 */
export interface ForecastNotice {
  title: string;
  method: string;
  detail: string;
}

export interface TrendForecast {
  forecast: PeriodForecast | null;
  notice: ForecastNotice | null;
}

function civilMonthDay(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return t('forecast.monthDay', { month, day });
}

/** 云端来源只在明确读到 0 条待上传记录时才算完整；未知（null）与 > 0 都不完整。本机作用域不看上传状态。 */
function cloudSourceIncomplete(scope: DataScope, pendingUploads: number | null): boolean {
  return scope === 'cloud' && pendingUploads !== 0;
}

function sourceIncompleteNotice(title: string, pendingUploads: number | null): ForecastNotice {
  if (typeof pendingUploads === 'number' && Number.isFinite(pendingUploads) && pendingUploads > 0) {
    return {
      title,
      method: t('trend.pending', { n: formatNum(pendingUploads) }),
      detail: t('trend.pending.detail'),
    };
  }
  return {
    title,
    method: t('trend.pendingUnknown'),
    detail: t('trend.pendingUnknown.detail'),
  };
}

function clippedNotice(title: string, range: RangeKey, through: string | undefined): ForecastNotice {
  const day = through ? civilMonthDay(through) : t('trend.lastDayOfLastMonth');
  const month = range === 'month';
  return {
    title,
    method: t(month ? 'trend.clipped.month' : 'trend.clipped.period', { day }),
    detail: t(month ? 'trend.clipped.month.detail' : 'trend.clipped.period.detail', { day }),
  };
}

/**
 * 趋势卡的周期末预测（T10.153 规则层，T10.159 接入）。“今天”、月末截短、区间结束与来源完整性都由
 * 规则层判定；界面只在规则层不给文案、但用户需要知道为什么没有数字时补一行不带数字的原因
 * （GLB-11），绝不显示成 0。先后次序：缓存快照、月末截短、云端来源不完整。
 * - 缓存快照（`meta.stale`）的生成日可能已经过去，与额度速度“不从历史快照外推”同一原则；
 * - 月末同期截短（`comparison-clipped`）时本期序列不含今天；
 * - 云端来源不完整（P2-1）：待上传记录数必须明确给出，未知与 > 0 都不预测。
 */
export function trendForecast(
  stats: StatsData,
  range: RangeKey,
  scope: DataScope,
  pendingUploads: number | null,
): TrendForecast {
  const none: TrendForecast = { forecast: null, notice: null };
  if (range !== 'month' && range !== 'week' && range !== 'custom') return none;
  const comparison = stats.comparison;
  if (!comparison || comparison.window.bucket !== 'day') return none;
  const sourceIncomplete = cloudSourceIncomplete(scope, pendingUploads);
  const forecast = scope === 'cloud'
    ? forecastFromStats(stats, range, { scope: 'cloud', sourceIncomplete })
    : forecastFromStats(stats, range, { scope: 'local' });
  // 来源不完整时规则层直接返回 source-incomplete，不再判断周期。按“来源完整”再求一次，只取周期状态
  // 与标题（区间是否已结束、月末是否截短），它的数字一律不显示。
  const shape = sourceIncomplete
    ? forecastFromStats(stats, range, { scope: 'cloud', sourceIncomplete: false })
    : forecast;
  const clipped = shape.status === 'unavailable' && shape.reason === 'comparison-clipped';
  const title = describePeriodForecast(shape, 'tokens')?.title
    ?? (clipped ? t(range === 'month' ? 'forecast.title.month' : 'forecast.tag') : null);
  // 周期已结束、范围不支持或结构不可用（月末截短除外）：本来就不预测，也不需要说明。
  if (title === null) return none;
  if (stats.meta?.stale) {
    return {
      forecast: null,
      notice: {
        title,
        method: t('trend.stale'),
        detail: t('trend.stale.detail'),
      },
    };
  }
  if (clipped) {
    const through = comparisonClip(stats, range)?.date
      ?? comparison.current.series[comparison.current.series.length - 1]?.bucket;
    return { forecast: null, notice: clippedNotice(title, range, through) };
  }
  if (sourceIncomplete) return { forecast: null, notice: sourceIncompleteNotice(title, pendingUploads) };
  return { forecast, notice: null };
}

/** 累计走势上的预测叠加层：与延长后的 x 轴等长，预测段之外为 null。 */
export interface ForecastOverlay {
  /** 本期最后一个桶之后追加到 x 轴的未来日期。 */
  futureDates: string[];
  /** 轨迹第一天（进行中的今天）在 x 轴上的下标；前一格是“截至昨天的累计”，预测线从那里起。 */
  startIndex: number;
  centre: Array<number | null>;
  low: Array<number | null>;
  /** 上限 − 下限，叠在下限之上画色带。 */
  band: Array<number | null>;
  points: MetricForecast['trajectory'];
}

/**
 * 把规则层的累计轨迹对齐到本期日桶（T10.153 §10 第 2 条）。轨迹必须从本期最后一个桶（进行中的
 * 今天）开始，且前面至少有一个已完成日；对不上就不画，绝不错位。
 */
export function buildForecastOverlay(
  metric: MetricForecast | null | undefined,
  buckets: readonly string[],
): ForecastOverlay | null {
  if (!metric || (metric.status !== 'ok' && metric.status !== 'partial')) return null;
  const pivot = metric.completedTotal;
  const points = metric.trajectory;
  if (pivot === null || points.length === 0 || buckets.length < 2) return null;
  const startIndex = buckets.length - 1;
  if (points[0].date !== buckets[startIndex]) return null;
  const futureDates = points.slice(1).map((point) => point.date);
  const length = buckets.length + futureDates.length;
  const centre = Array<number | null>(length).fill(null);
  const low = Array<number | null>(length).fill(null);
  const band = Array<number | null>(length).fill(null);
  centre[startIndex - 1] = pivot;
  low[startIndex - 1] = pivot;
  band[startIndex - 1] = 0;
  points.forEach((point, offset) => {
    const index = startIndex + offset;
    centre[index] = point.point;
    low[index] = point.low;
    band[index] = Math.max(0, point.high - point.low);
  });
  return { futureDates, startIndex, centre, low, band, points };
}

interface TrendKpiCellModel {
  key: string;
  label: string;
  title: string;
  value: string;
  change: MetricChange | null;
  note: string;
  /** 月末同期截短时的“截至 {对齐日}”（P2-2），单独一行，不被上一行的省略号截掉。 */
  clipNote: string | null;
}

function TrendKpiCell({ cell }: { cell: TrendKpiCellModel }) {
  const change = cell.change;
  const Icon = change?.direction === 'up' ? ArrowUpRight : change?.direction === 'down' ? ArrowDownRight : Minus;
  return (
    <div className="comparison-kpi">
      <span className="comparison-kpi-label" title={cell.title}>{cell.label}</span>
      <div className="comparison-kpi-main">
        <b>{cell.value}</b>
        {change && (
          // 变化胶囊保持中性色：箭头加正负号，不借红绿表达好坏（T10.154 / T10.156 草案）。
          <strong className="is-flat" title={change.description}>
            {change.direction !== null && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            <span className="sr-only">{change.description}</span>
            <span aria-hidden="true">{change.headline}</span>
          </strong>
        )}
      </div>
      <small title={cell.note}>{cell.note}</small>
      {cell.clipNote && <small title={cell.title}>{cell.clipNote}</small>}
    </div>
  );
}

/** 方法句已经点名指标时（“有效 Token 预测不可得”“费用预测不可得”）不再重复指标名。 */
function mentionsMetric(text: string, metric: ForecastMetricKey): boolean {
  return text.includes(t(metric === 'tokens' ? 'trend.mentions.tokens' : 'trend.mentions.cost'));
}

/**
 * 读屏整句在标题后补上指标名（T10.159 P3-3）：“预测：月末预测 预估费用 ≈$31，粗略范围 …”。
 * 规则层整句不是以“预测：{标题}”开头时，把指标名放在最前面，不丢信息。
 */
export function withMetricLabel(ariaLabel: string, title: string, metricLabel: string): string {
  const head = t('forecast.ariaHead', { title });
  return ariaLabel.startsWith(head)
    ? `${head} ${metricLabel}${ariaLabel.slice(head.length)}`
    : t('trend.metricPrefix', { metric: metricLabel, text: ariaLabel });
}

/** 一行预测：来自规则层 `describePeriodForecast`，或界面补的不带数字的原因。 */
interface ForecastLineModel {
  key: string;
  metric: ForecastMetricKey | null;
  title: string;
  /** 数值本身不含指标名时（费用），或双轨两行并列、没有数字的那行未点名指标时显示的指标名。 */
  metricLabel: string | null;
  value: string | null;
  interval: string | null;
  method: string;
  caveats: string[];
  detail: string;
  ariaLabel: string;
}

/** 一行周期末预测：“预测”标签、数值、粗略范围与方法同时可见（D2），计算细节在行内展开；读屏读规则层的整句。 */
function ForecastLine({ line }: { line: ForecastLineModel }) {
  return (
    <details className="trend-forecast group min-w-0 basis-full">
      <summary
        aria-label={line.ariaLabel}
        className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md text-xs text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden"
      >
        <span className="badge badge-subtle">{t('forecast.tag')}</span>
        <span className="font-medium">{line.title}</span>
        {line.metricLabel && <span>{line.metricLabel}</span>}
        {line.value && <strong className="font-semibold tabular-nums text-[var(--color-text-primary)]">{line.value}</strong>}
        {line.interval && <span className="tabular-nums">{line.interval}</span>}
        <span className="text-tertiary">{line.method}</span>
        {line.caveats.map((caveat) => <span key={caveat} className="text-tertiary">{caveat}</span>)}
        <span className="inline-flex items-center gap-0.5 text-tertiary underline decoration-dotted underline-offset-2">
          {t('trend.howCalculated')}
          <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <p className="mb-1 max-w-[72ch] text-xs leading-relaxed text-secondary">{line.detail}</p>
    </details>
  );
}

/**
 * 是否可信任 `comparison.current.series[index]` 的费用（T10.197 评审 P3-8，R-56）：云端把没有
 * 可验证费用的桶合成了 0，`isKnownCost` 认不出这种「假 0」，只有按 `dailyCosts` 逐桶核实的
 * `cloudCostKnown`（`cloudComparisonCostKnown`）能分辨。`undefined` 表示不需要核实（本机，或
 * 专属看板没有逐日费用来源，沿用原值）；`null` 表示云端想核实但拿不到可验证的逐日费用，整段都
 * 按不可得处理，与 KPI 单元格 `costUnknown()` 同一套判断；数组则按下标查——只核实当期
 * （`comparison.current.series`），上一期没有对应的核实来源，仍只看 `isKnownCost`。
 */
function cloudCostBucketKnown(cloudCostKnown: boolean[] | null | undefined, index: number): boolean {
  if (cloudCostKnown === undefined) return true;
  if (cloudCostKnown === null) return false;
  return cloudCostKnown[index] ?? false;
}

function TrendPanelComponent(props: TrendPanelProps) {
  const {
    trends,
    activeTools,
    comparison,
    range,
    scope = 'local',
    currentSeriesName,
    currentSeriesIsTool = false,
    currentOnlyNote,
    initialTrack = 'tokens',
  } = props;
  const overviewStats = props.overviewStats ?? null;
  // 待上传记录数没有缺省值（P2-1）：绕过类型漏传时运行期是 undefined，按“未知”处理，云端不预测。
  const pendingUploads = props.pendingUploads ?? null;
  const [track, setTrack] = useState<TrackViewMode>(initialTrack);
  const [viewMode, setViewMode] = useState<TrendViewMode>('daily');
  const { effective } = useTheme();
  const theme = getChartThemeTokens();
  const reduceMotion = theme.reduceMotion;
  const trackSegRef = useSegmentedIndicator<HTMLDivElement>();
  const viewSegRef = useSegmentedIndicator<HTMLDivElement>();
  const lang = useLang();
  const comparisonLabels = RANGE_COMPARISON_LABELS[range];
  const currentLabel = t(comparisonLabels?.[0] ?? 'trend.label.current');
  const previousLabel = t(comparisonLabels?.[1] ?? 'trend.label.previous');
  const hourBuckets = comparison?.window.bucket === 'hour';
  // 所有日桶对比（本周、本月、多日自定义）都能切到累计走势（审计 Q5：此前多日自定义的切换不生效）。
  const dayBuckets = comparison?.window.bucket === 'day';
  const isCumulative = dayBuckets && viewMode === 'cumulative';
  const unitWord = t(hourBuckets ? 'trend.unit.hour' : 'trend.unit.day');
  const averagePrefix = t(hourBuckets ? 'trend.prefix.hour' : 'trend.prefix.day');
  const currentTokens = comparison?.current.summary.totalTokens || 0;
  const previousTokens = comparison?.previous.summary.totalTokens || 0;
  // 未知费用不按 0 兜底（T10.186 评审 P3-2；GLB-01）：非有限或负值一律「不可得」，交给
  // formatEstimatedUsd / computeUnitCostUsd 处理，不能拿旧的 `|| 0` 冒充总额。
  const currentCostRaw = comparison?.current.summary.totalCost;
  const previousCostRaw = comparison?.previous.summary.totalCost;
  const currentCost = isKnownCost(currentCostRaw) ? currentCostRaw : null;
  const previousCost = isKnownCost(previousCostRaw) ? previousCostRaw : null;
  const cloudBaselineUnverified = isCloudComparisonBaselineUnverified(scope, comparison);
  const forecastColor = theme.seriesPalette[1] ?? theme.textTertiary;

  // 总览快照必须与本卡的 comparison 是同一份响应，才用它判断预测、截短与逐日费用。
  const overview = overviewStats && comparison && overviewStats.comparison === comparison ? overviewStats : null;
  // 月末同期截短（P2-2）：日均与单位费用只统计到对齐日，与核心指标的同期变化用同一句说明。
  const clip = useMemo(() => (overview ? comparisonClip(overview, range) : null), [overview, range]);
  // 云端 comparison 把未知费用合成了 0（P3-2）：总览按 dailyCosts 逐桶核实，undefined 表示不需要核实
  // （本机逐行费用已按价格表估算；专属看板没有逐日费用来源，与同一弹窗的核心指标费用一致，沿用原值）。
  const cloudCostKnown = useMemo(
    () => (scope === 'cloud' && overview ? cloudComparisonCostKnown(overview) : undefined),
    [scope, overview],
  );

  const currentSeries = useMemo(() => comparison?.current.series || [], [comparison]);
  const previousSeries = useMemo(() => comparison?.previous.series || [], [comparison]);

  // 从第一个不可得的桶开始，累计费用整体变成不可得（不是把它当 0 继续加）：一旦有一桶费用
  // 缺失，从那里往后的「累计」都不是真的累计数，不能装作没这回事继续往上加（T10.197 评审 P3-7）。
  // `formatEstimatedUsd` 遇到 null 已经写「不可得」、ECharts 折线遇到 null 天然断线，这里只需要
  // 把 null 一路往后传。云端合成的假 0 同样按 cloudCostBucketKnown 判定为不可得（T10.197 评审
  // P3-8，R-56），不当真 0 继续累计。
  const currentCumulative = useMemo(() => {
    let sumTokens = 0;
    let sumCost: number | null = 0;
    return currentSeries.map((p, index) => {
      sumTokens += p.tokens;
      const known = isKnownCost(p.cost) && cloudCostBucketKnown(cloudCostKnown, index);
      sumCost = sumCost !== null && known ? sumCost + p.cost : null;
      return { bucket: p.bucket, tokens: sumTokens, cost: sumCost, requests: p.requests };
    });
  }, [currentSeries, cloudCostKnown]);

  const previousCumulative = useMemo(() => {
    let sumTokens = 0;
    let sumCost: number | null = 0;
    return previousSeries.map((p) => {
      sumTokens += p.tokens;
      sumCost = sumCost !== null && isKnownCost(p.cost) ? sumCost + p.cost : null;
      return { bucket: p.bucket, tokens: sumTokens, cost: sumCost, requests: p.requests };
    });
  }, [previousSeries]);

  // 日均 / 小时均只平均已经结束的桶（审计 Q4）：与 KPI 单元格、日均基准虚线是同一个数。
  const tokenAverage = useMemo(() => (comparison ? completedBucketAverage(comparison, 'tokens') : null), [comparison]);
  const costAverage = useMemo(() => (comparison ? completedBucketAverage(comparison, 'cost') : null), [comparison]);

  const forecastState = useMemo(() => (
    overview ? trendForecast(overview, range, scope, pendingUploads) : null
  ), [overview, range, scope, pendingUploads]);
  const forecast = forecastState?.forecast ?? null;

  const forecastLines = useMemo<ForecastLineModel[]>(() => {
    const notice = forecastState?.notice;
    if (notice) {
      return [{
        key: 'notice',
        metric: null,
        title: notice.title,
        metricLabel: null,
        value: null,
        interval: null,
        method: notice.method,
        caveats: [],
        detail: notice.detail,
        ariaLabel: t('trend.noticeAria', { title: notice.title, method: notice.method }),
      }];
    }
    if (!forecast) return [];
    const metrics: ForecastMetricKey[] = track === 'tokens' ? ['tokens'] : track === 'cost' ? ['cost'] : ['tokens', 'cost'];
    const copies = metrics.flatMap((metric) => {
      const copy = describePeriodForecast(forecast, metric);
      return copy ? [{ metric, copy }] : [];
    });
    // 双轨时两项都没有数字、原因又相同（例如完整日不足）只说一次，这一行说的是两项，不标指标。
    const shared = copies.length === 2
      && copies.every(({ copy }) => copy.value === null)
      && copies[0].copy.method === copies[1].copy.method;
    const shown = shared ? copies.slice(0, 1) : copies;
    return shown.map(({ metric, copy }) => {
      // Token 数值自带“有效 Token”，金额只有“≈$x”，要补上指标名；两行并列时，没有数字的那行
      // 若没点名指标（例如“有消耗的不足 2 天”），同样写明是哪个指标（P3-3）。
      const metricLabel = copy.value !== null
        ? (copy.value.includes(copy.metricLabel) ? null : copy.metricLabel)
        : (shown.length > 1 && !mentionsMetric(copy.method, metric) ? copy.metricLabel : null);
      return {
        key: metric,
        metric,
        title: copy.title,
        metricLabel,
        value: copy.value,
        interval: copy.interval,
        method: copy.method,
        caveats: copy.caveats,
        detail: copy.detail,
        // 读屏整句与可见文字一致：补上的指标名也要读出来。
        ariaLabel: metricLabel ? withMetricLabel(copy.ariaLabel, copy.title, metricLabel) : copy.ariaLabel,
      };
    });
  // 文案随界面语言变化：`lang` 进依赖以便切换后重算。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecastState, forecast, track, lang]);

  // 预测线与色带只画在单指标的累计走势上；双轨与逐日走势只显示文字行（T10.153 §6、§10）。
  const overlay = useMemo(() => {
    if (!forecast || !isCumulative || track === 'dual') return null;
    return buildForecastOverlay(track === 'tokens' ? forecast.tokens : forecast.cost, currentSeries.map((point) => point.bucket));
  }, [forecast, isCumulative, track, currentSeries]);
  const overlayMethod = overlay
    ? forecastLines.find((line) => line.metric === track)?.method ?? t('trend.overlayDefault')
    : '';

  const derivedComparison = comparison ? deriveTrendComparison(comparison) : null;
  const peakInsight = comparison && !cloudBaselineUnverified
    ? describeTrendPeakShift(derivedComparison?.peak || null, comparison.window.bucket)
    : '';

  const tokenInsight = comparison
    ? cloudBaselineUnverified
      ? t('trend.insight.cloudUnverified', { previous: previousLabel })
      : comparison.delta.tokens.direction === 'new'
      ? t('trend.insight.new', { current: currentLabel, previous: previousLabel })
      : comparison.delta.tokens.direction === 'flat'
        ? currentTokens === 0 && previousTokens === 0
          ? t('trend.insight.bothZero', { current: currentLabel, previous: previousLabel })
          : t('trend.insight.flat', { current: currentLabel, previous: previousLabel })
        : comparison.delta.tokens.percent === null
          ? t('trend.insight.noBaseline', { current: currentLabel, previous: previousLabel })
          : t(comparison.delta.tokens.percent > 0 ? 'trend.insight.up' : 'trend.insight.down', { current: currentLabel, previous: previousLabel, pct: Math.abs(comparison.delta.tokens.percent).toFixed(1) })
    : '';

  const comparisonInsight = comparison
    ? t(peakInsight ? 'trend.insightWithPeak' : 'trend.insight', { token: tokenInsight, peak: peakInsight })
    : '';

  // 趋势卡只保留两个 KPI 没有回答的问题：日均（按已完成的桶）与单位费用（审计 Q3）。
  // 总量与总量变化只在上方 KPI 卡出现一次。
  const kpiCells = useMemo<TrendKpiCellModel[]>(() => {
    if (!comparison) return [];
    const clipNote = clip?.note ?? null;
    const clipTitle = clip ? t('trend.clipTitle', { date: civilMonthDay(clip.date) }) : '';
    // 云端费用无从核实时的原因（P3-2）；可证或不需要核实时为 null。`count` 只看前几个桶（已完成的日子）。
    const costUnknown = (count?: number): string | null => {
      if (cloudCostKnown === undefined) return null;
      if (cloudCostKnown === null) return t('trend.cloudCostUnverified');
      const unknown = cloudCostKnown.slice(0, count).filter((known) => !known).length;
      return unknown > 0 ? t('trend.costUnknownCount', { n: unknown, unit: unitWord }) : null;
    };
    const averageCell = (metric: 'tokens' | 'cost', average: CompletedBucketAverage | null): TrendKpiCellModel => {
      const label = t('trend.avgLabel', { prefix: averagePrefix, metric: t(metric === 'tokens' ? 'trend.seriesTokens' : 'trend.seriesCost') });
      const format = metric === 'tokens' ? formatAverageTokens : formatEstimatedUsd;
      const formatAbsolute = metric === 'tokens' ? formatAverageTokens : formatUsdMagnitude;
      const title = t(hourBuckets ? 'trend.avgTitle.hour' : 'trend.avgTitle.day', { label, clip: clipTitle });
      const base = { key: `average-${metric}`, label, title, clipNote };
      if (!average) {
        return { ...base, value: '—', change: null, note: t(hourBuckets ? 'trend.avgUnknown.hour' : 'trend.avgUnknown.day') };
      }
      if (average.buckets === 0 || average.current === null) {
        return { ...base, value: '—', change: null, note: t(hourBuckets ? 'trend.noFull.hour' : 'trend.noFull.day') };
      }
      const basis = t('trend.basis', { n: average.buckets, unit: unitWord });
      const unknownCost = metric === 'cost' ? costUnknown(average.buckets) : null;
      if (unknownCost) {
        return { ...base, title: t('trend.titleBasis', { title, basis }), value: unitCostUnavailable(), change: null, note: t('trend.notZero', { reason: unknownCost }) };
      }
      const value = format(average.current);
      if (cloudBaselineUnverified) {
        return {
          ...base,
          value,
          change: {
            direction: null,
            headline: t('trend.baselineMissing'),
            absolute: null,
            period: t('trend.vs', { label: previousLabel }),
            description: t('trend.baselineMissingDesc', { label, previous: previousLabel }),
          },
          note: t('trend.baselineMissingNote', { basis }),
        };
      }
      if (!average.delta || average.previous === null) {
        return { ...base, value, change: null, note: t('trend.notComparable', { basis, previous: previousLabel }) };
      }
      return {
        ...base,
        value,
        change: describeMetricChange(average.delta, formatAbsolute, t('trend.vs', { label: previousLabel }), label),
        note: `${basis} · ${previousLabel} ${format(average.previous)}`,
      };
    };
    // 单位费用的计算与显示保护统一在 utils/unitCost（与专属看板条带共用，T10.159 决定 d）。
    const unitUnknown = costUnknown();
    const previousUnitCost = cloudBaselineUnverified ? null : computeUnitCostUsd(previousCost, previousTokens);
    const unitCostCell: TrendKpiCellModel = {
      key: 'unit-cost',
      label: unitCostLabel(),
      title: t('trend.unitCostTitle', { label: unitCostLabel(), desc: unitCostDescription(), clip: clipTitle }),
      value: currentTokens > 0 ? formatUnitCost(unitUnknown ? null : computeUnitCostUsd(currentCost, currentTokens)) : '—',
      change: null,
      note: currentTokens <= 0
        ? t('trend.noTokens')
        : unitUnknown
          ? t('trend.notZero', { reason: unitUnknown })
          : previousUnitCost === null ? t('trend.perMillionHint') : `${previousLabel} ${formatUnitCost(previousUnitCost)}`,
      clipNote,
    };
    if (track === 'tokens') return [averageCell('tokens', tokenAverage), unitCostCell];
    if (track === 'cost') return [averageCell('cost', costAverage), unitCostCell];
    return [averageCell('tokens', tokenAverage), averageCell('cost', costAverage), unitCostCell];
  // 文案随界面语言变化：`lang` 进依赖以便切换后重算。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    comparison,
    track,
    tokenAverage,
    costAverage,
    averagePrefix,
    unitWord,
    cloudBaselineUnverified,
    previousLabel,
    currentTokens,
    currentCost,
    previousTokens,
    previousCost,
    clip,
    cloudCostKnown,
    hourBuckets,
    lang,
  ]);

  // ECharts Multi-Track Options
  const comparisonOption = useMemo(() => {
    if (!comparison) return null;

    // Tooltip 与累计已核实逐日费用；逐日折线也必须使用同一判定，
    // 避免云端为未知费用返回的占位 0 被画成真实零值。
    const activeCurrentSeries = isCumulative ? currentCumulative : currentSeries.map((point, index) => ({
      ...point,
      cost: isKnownCost(point.cost) && cloudCostBucketKnown(cloudCostKnown, index) ? point.cost : null,
    }));
    const activePreviousSeries = isCumulative ? previousCumulative : previousSeries;
    const axisBuckets = [...activeCurrentSeries.map((point) => point.bucket), ...(overlay?.futureDates ?? [])];
    // 预测把 x 轴延到期末；实际值与上期只画到各自有数据的位置，之后留空而不是补 0。
    const padToAxis = <T,>(values: T[]): Array<T | null> => (
      values.length >= axisBuckets.length
        ? values
        : [...values, ...Array<null>(axisBuckets.length - values.length).fill(null)]
    );
    const previousValues = (metric: 'tokens' | 'cost') => padToAxis(cloudBaselineUnverified
      ? activePreviousSeries.map(() => null)
      : activePreviousSeries.map((point) => point[metric]));
    const cumulativeSuffix = isCumulative ? t('trend.cumulativeSuffix') : '';

    const neutralDelta = (text: string) => `<span style="color: ${theme.textSecondary}; font-weight: 600;">${text}</span>`;
    const forecastMetric: ForecastMetricKey = track === 'cost' ? 'cost' : 'tokens';
    const formatForecastPoint = (point: { point: number; low: number; high: number }) => (
      formatForecastTriple(forecastMetric, point.point, point.low, point.high)
    );

    const forecastTooltipHtml = (index: number) => {
      const point = overlay?.points[index - (overlay?.startIndex ?? 0)];
      const bucket = axisBuckets[index] ?? '';
      if (!point) return '';
      const weekday = getWeekdayName(bucket);
      const formatted = formatForecastPoint(point);
      return `
        <div style="min-width: 220px; font-family: ${CHART_FONT_FAMILY}; font-size: 12px; line-height: 1.55;">
          <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; border-bottom: 1px solid ${theme.borderStrong}; padding-bottom: 4px;">
            <strong style="color: ${theme.textPrimary}; font-size: 13px;">${escapeHtml(`${bucket}${weekday ? ` (${weekday})` : ''}`)}</strong>
            <span style="color: ${theme.textTertiary}; font-size: 11px;">${t('trend.tip.notHappened')}</span>
          </div>
          <div style="display: flex; justify-content: space-between; gap: 12px; margin: 3px 0;">
            <span style="color: ${theme.textSecondary};">${t(track === 'cost' ? 'trend.tip.forecastCost' : 'trend.tip.forecastTokens')}:</span>
            <strong style="color: ${theme.textPrimary}; font-variant-numeric: tabular-nums;">${escapeHtml(formatted.point)}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; gap: 12px; margin: 3px 0;">
            <span style="color: ${theme.textSecondary};">${t('trend.tip.range')}:</span>
            <span style="color: ${theme.textPrimary}; font-variant-numeric: tabular-nums;">${escapeHtml(`${formatted.low}–${formatted.high}`)}</span>
          </div>
          <div style="color: ${theme.textTertiary}; font-size: 11px; margin-top: 4px;">${t('trend.tip.notActual', { method: escapeHtml(overlayMethod) })}</div>
        </div>
      `;
    };

    const formatTooltipHtml = (params: Array<{ dataIndex: number }> | { dataIndex: number }) => {
      const first = Array.isArray(params) ? params[0] : params;
      const index = first?.dataIndex ?? 0;
      if (overlay && index >= currentSeries.length) return forecastTooltipHtml(index);
      const currPoint = currentSeries[index] || { bucket: '', tokens: 0, requests: 0, cost: 0 };
      const prevPoint = previousSeries[index] || { bucket: '', tokens: 0, requests: 0, cost: 0 };
      const cumPoint = currentCumulative[index] || { tokens: 0, cost: 0 };

      const currBucket = currPoint.bucket;
      const prevBucket = prevPoint.bucket;

      const tokenDelta = currPoint.tokens - prevPoint.tokens;
      const tokenPercent = prevPoint.tokens > 0 ? (tokenDelta / prevPoint.tokens) * 100 : null;

      // 桶级费用差值只在两端都已知时计算；不可得不是 0，不能拿去算百分比或差额，
      // 也不能让另一端的真实数字被“按 0 算出的差值”带偏（T10.186 评审 P3-2）。当期还要核实
      // cloudCostKnown：云端把没有可验证费用的桶合成了 0，isKnownCost 认不出这种「假 0」
      // （T10.197 评审 P3-8，R-56）；上一期没有对应的核实来源，仍只看 isKnownCost。
      const currentCostKnown = isKnownCost(currPoint.cost) && cloudCostBucketKnown(cloudCostKnown, index);
      const costKnown = currentCostKnown && isKnownCost(prevPoint.cost);
      const costDeltaValue = currPoint.cost - prevPoint.cost;
      const costDelta = costKnown ? costDeltaValue : null;
      const costPercent = costKnown && prevPoint.cost > 0 ? (costDeltaValue / prevPoint.cost) * 100 : null;

      // 差值只陈述变化，不用红绿表达好坏（T10.154）；百分比与金额共用同一套带 U+2212 的
      // 有符号格式，不再是百分比 ASCII 减号、金额 U+2212 两种写法（T10.186 评审 P3-4）。Token
      // 括号里的绝对值同样不能混用 ASCII 减号：符号统一在这里按 U+2212 拼出来，`formatTokens`
      // 只吃绝对值、不再自己签一次名（T10.197 评审 P3-5）。
      const tokenDeltaBadge = cloudBaselineUnverified
        ? `<span style="color: ${theme.textTertiary};">${t('trend.tip.cloudUnverified')}</span>`
        : prevPoint.tokens === 0 && currPoint.tokens > 0
          ? neutralDelta(t('trend.new'))
          : prevPoint.tokens === 0 && currPoint.tokens === 0
            ? `<span style="color: ${theme.textTertiary};">${t('trend.flat')}</span>`
            : neutralDelta(`${formatSignedPercent(tokenPercent)} (${tokenDelta > 0 ? '+' : tokenDelta < 0 ? '−' : ''}${formatTokens(Math.abs(tokenDelta))})`);

      // 两端有一端不可得时不画徽标（空字符串），不写「不可得」三个字——不可得是「没有这个数」，
      // 不是「这个数是不可得」，徽标位置留空更不会被误读成一种特殊差值（T10.197 评审 P3-9，
      // 与登记时的原方案一致；`cloudBaselineUnverified` 那一支本来就是空字符串，这里对齐同一写法）。
      const costDeltaBadge = cloudBaselineUnverified || !costKnown
        ? ''
        : prevPoint.cost === 0 && currPoint.cost > 0
          ? neutralDelta(t('trend.new'))
          : prevPoint.cost === 0 && currPoint.cost === 0
            ? `<span style="color: ${theme.textTertiary};">${t('trend.flat')}</span>`
            : neutralDelta(`${formatSignedPercent(costPercent)} (${formatSignedUsd(costDelta)})`);

      let headerTitle = '';
      let headerSub = '';
      if (/^\d{2}:00$/.test(currBucket)) {
        const hour = parseInt(currBucket.slice(0, 2), 10);
        const nextH = (hour + 1) % 24;
        const nextStr = `${nextH < 10 ? '0' : ''}${nextH}:00`;
        headerTitle = `${currBucket} - ${nextStr}`;
        headerSub = t('trend.tip.yesterday', { bucket: prevBucket || '—' });
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(currBucket)) {
        const wk = getWeekdayName(currBucket);
        headerTitle = `${currBucket}${wk ? ` (${wk})` : ''}`;
        const prevWk = getWeekdayName(prevBucket);
        headerSub = prevBucket ? t('trend.tip.aligned', { bucket: `${prevBucket}${prevWk ? ` (${prevWk})` : ''}` }) : '';
      } else {
        headerTitle = formatBucketLabel(currBucket);
        headerSub = prevBucket ? t('trend.tip.previous', { bucket: formatBucketLabel(prevBucket) }) : '';
      }

      const reqs = currPoint.requests || 0;
      const avgReqTokens = reqs > 0 ? Math.round(currPoint.tokens / reqs) : 0;
      const unitCost = currPoint.tokens > 0 ? formatUnitCost(computeUnitCostUsd(currPoint.cost, currPoint.tokens)) : '—';

      // 累计走势上的今天：附上今天结束时的预测累计（中心与粗略范围）。
      const todayForecast = overlay && index === overlay.startIndex ? formatForecastPoint(overlay.points[0]) : null;
      const todayForecastRow = todayForecast
        ? `
          <div style="margin-top: 6px; border-top: 1px dashed ${theme.borderFaint}; padding-top: 4px; font-size: 11px; color: ${theme.textSecondary}; display: flex; justify-content: space-between; gap: 8px;">
            <span>${t('trend.tip.todayForecast')}:</span>
            <span><b style="color: ${theme.textPrimary};">${escapeHtml(todayForecast.point)}</b> · ${escapeHtml(t('forecast.interval', { low: todayForecast.low, high: todayForecast.high }))}</span>
          </div>
        `
        : '';

      return `
        <div style="min-width: 220px; font-family: ${CHART_FONT_FAMILY}; font-size: 12px; line-height: 1.55;">
          <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; border-bottom: 1px solid ${theme.borderStrong}; padding-bottom: 4px;">
            <strong style="color: ${theme.textPrimary}; font-size: 13px;">${escapeHtml(headerTitle)}</strong>
            <span style="color: ${theme.textTertiary}; font-size: 11px;">${escapeHtml(headerSub)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin: 3px 0;">
            <span style="color: ${theme.textSecondary};">${t('trend.seriesTokens')}:</span>
            <div style="display: flex; align-items: baseline; gap: 6px;">
              <strong style="color: ${theme.primary}; font-variant-numeric: tabular-nums;">${formatTokens(currPoint.tokens)}</strong>
              ${tokenDeltaBadge}
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin: 3px 0;">
            <span style="color: ${theme.textSecondary};">${t('trend.seriesCost')}:</span>
            <div style="display: flex; align-items: baseline; gap: 6px;">
              <strong style="color: ${theme.success}; font-variant-numeric: tabular-nums;">${formatEstimatedUsd(currentCostKnown ? currPoint.cost : null)}</strong>
              ${costDeltaBadge}
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; gap: 8px; color: ${theme.textTertiary}; font-size: 11px; margin-top: 4px;">
            <span>${t('trend.tip.requests', { n: formatNum(reqs) })}${reqs > 0 ? t('trend.tip.avgPerRequest', { tokens: formatTokens(avgReqTokens) }) : ''}</span>
            <span>${unitCostLabel()}: ${escapeHtml(unitCost)}</span>
          </div>
          <div style="margin-top: 6px; border-top: 1px dashed ${theme.borderFaint}; padding-top: 4px; font-size: 11px; color: ${theme.textSecondary}; display: flex; justify-content: space-between;">
            <span>${t('trend.tip.cumulativeSoFar')}:</span>
            <span><b>${formatTokens(cumPoint.tokens)}</b> · <b style="color: ${theme.success};">${formatEstimatedUsd(cumPoint.cost)}</b></span>
          </div>
          ${todayForecastRow}
        </div>
      `;
    };

    const commonXAxis = {
      type: 'category' as const,
      boundaryGap: false,
      data: axisBuckets,
      axisLabel: {
        color: theme.textTertiary,
        fontSize: 11,
        formatter: formatBucketLabel,
      },
      axisLine: { lineStyle: { color: theme.border } },
    };

    const forecastSeries = (): Array<Record<string, unknown>> => (overlay
      ? [
        {
          name: t('trend.forecastLow'),
          type: 'line',
          stack: 'forecast-band',
          smooth: false,
          symbol: 'none',
          silent: true,
          lineStyle: { width: 0, opacity: 0 },
          data: overlay.low,
        },
        {
          name: t('trend.forecastRange'),
          type: 'line',
          stack: 'forecast-band',
          smooth: false,
          symbol: 'none',
          silent: true,
          lineStyle: { width: 0, opacity: 0 },
          areaStyle: { color: forecastColor, opacity: 0.16 },
          data: overlay.band,
        },
        {
          name: t('forecast.tag'),
          type: 'line',
          smooth: false,
          symbol: 'none',
          silent: true,
          lineStyle: { width: 2, type: 'dashed', color: forecastColor },
          itemStyle: { color: forecastColor },
          data: overlay.centre,
        },
      ]
      : []);

    // 日均基准虚线 = 已完成日的均值，与 KPI 单元格同一个数；进行中的今天不拉低基准（审计 Q4）。
    const baselineSeries = (metric: 'tokens' | 'cost'): Array<Record<string, unknown>> => {
      const average = metric === 'tokens' ? tokenAverage : costAverage;
      if (!dayBuckets || isCumulative || !average || average.current === null) return [];
      if (metric === 'cost' && currentSeries.slice(0, average.buckets).some((_, index) => !cloudCostBucketKnown(cloudCostKnown, index))) return [];
      const value = metric === 'tokens' ? Math.round(average.current) : average.current;
      return [{
        name: t('trend.baselineSeries', { metric: t(metric === 'tokens' ? 'trend.seriesTokens' : 'trend.seriesCost') }),
        type: 'line',
        data: activeCurrentSeries.map(() => value),
        lineStyle: { type: 'dotted', color: theme.borderStrong, width: 1.5 },
        symbol: 'none',
        silent: true,
      }];
    };

    if (track === 'tokens' || track === 'cost') {
      const metric = track;
      const color = metric === 'tokens' ? theme.primary : theme.success;
      const seriesList: Array<Record<string, unknown>> = [
        {
          name: metric === 'tokens' ? `${currentLabel}${cumulativeSuffix}` : t('trend.costSeries', { label: currentLabel, suffix: cumulativeSuffix }),
          type: 'line',
          smooth: 0.35,
          showSymbol: true,
          symbol: 'circle',
          symbolSize: activeCurrentSeries.length <= 12 ? 6 : 4,
          lineStyle: {
            width: 2.25,
            color,
            shadowColor: metric === 'tokens' ? 'rgba(47, 154, 255, 0.3)' : 'rgba(48, 209, 88, 0.3)',
            shadowBlur: 8,
          },
          itemStyle: { color },
          areaStyle: { color: lineAreaGradient(color) },
          data: padToAxis(activeCurrentSeries.map((point) => point[metric])),
        },
        {
          name: metric === 'tokens' ? `${previousLabel}${cumulativeSuffix}` : t('trend.costSeries', { label: previousLabel, suffix: cumulativeSuffix }),
          type: 'line',
          smooth: 0.35,
          showSymbol: false,
          lineStyle: { width: 2, type: 'dashed', color: theme.textTertiary },
          itemStyle: { color: theme.textTertiary },
          data: previousValues(metric),
        },
        ...baselineSeries(metric),
        ...forecastSeries(),
      ];

      return {
        backgroundColor: 'transparent',
        ...getChartAnimation(reduceMotion),
        textStyle: { fontFamily: CHART_FONT_FAMILY },
        tooltip: {
          ...getChartTooltip(theme),
          trigger: 'axis',
          renderMode: 'html',
          formatter: formatTooltipHtml,
        },
        legend: {
          show: false,
          top: 0,
          itemWidth: 18,
          itemHeight: 3,
          textStyle: { color: theme.textSecondary, fontSize: 11 },
        },
        grid: getChartGrid({ left: 10, right: 18, top: 16, bottom: 8 }),
        xAxis: commonXAxis,
        yAxis: {
          type: 'value',
          min: 0,
          splitLine: { lineStyle: { color: theme.borderFaint } },
          axisLabel: {
            color: theme.textTertiary,
            formatter: (value: number) => (metric === 'tokens' ? formatAxisTokens(value) : formatUsd(value)),
          },
          axisLine: { lineStyle: { color: theme.border } },
        },
        series: seriesList,
      };
    }

    // Dual track mode
    return {
      backgroundColor: 'transparent',
      ...getChartAnimation(reduceMotion),
      textStyle: { fontFamily: CHART_FONT_FAMILY },
      tooltip: {
        ...getChartTooltip(theme),
        trigger: 'axis',
        renderMode: 'html',
        formatter: formatTooltipHtml,
      },
      legend: {
        top: 0,
        itemWidth: 18,
        itemHeight: 3,
        textStyle: { color: theme.textSecondary, fontSize: 11 },
      },
      grid: getChartGrid({ left: 10, right: 38, top: 38, bottom: 8 }),
      xAxis: commonXAxis,
      yAxis: [
        {
          name: t('trend.seriesTokens'),
          nameTextStyle: { color: theme.textTertiary, fontSize: 10 },
          type: 'value',
          min: 0,
          splitLine: { lineStyle: { color: theme.borderFaint } },
          axisLabel: { color: theme.textTertiary, formatter: (value: number) => formatAxisTokens(value) },
          axisLine: { lineStyle: { color: theme.border } },
        },
        {
          name: t('trend.costUsdAxis'),
          nameTextStyle: { color: theme.textTertiary, fontSize: 10 },
          type: 'value',
          min: 0,
          splitLine: { show: false },
          axisLabel: { color: theme.textTertiary, formatter: (value: number) => formatUsd(value) },
          axisLine: { lineStyle: { color: theme.border } },
        },
      ],
      series: [
        {
          name: `${currentLabel} Tokens${cumulativeSuffix}`,
          yAxisIndex: 0,
          type: 'line',
          smooth: 0.35,
          showSymbol: activeCurrentSeries.length <= 8,
          symbolSize: 5,
          lineStyle: { width: 2.25, color: theme.primary },
          itemStyle: { color: theme.primary },
          areaStyle: { color: lineAreaGradient(theme.primary) },
          data: activeCurrentSeries.map((p) => p.tokens),
        },
        {
          name: t('trend.costSeries', { label: currentLabel, suffix: cumulativeSuffix }),
          yAxisIndex: 1,
          type: 'line',
          smooth: 0.35,
          showSymbol: true,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { width: 2.25, color: theme.success, shadowColor: 'rgba(48, 209, 88, 0.3)', shadowBlur: 6 },
          itemStyle: { color: theme.success },
          data: activeCurrentSeries.map((p) => p.cost),
        },
        {
          name: `${previousLabel} Tokens${cumulativeSuffix}`,
          yAxisIndex: 0,
          type: 'line',
          smooth: 0.35,
          showSymbol: false,
          lineStyle: { width: 1.5, type: 'dashed', color: theme.textTertiary },
          itemStyle: { color: theme.textTertiary },
          data: previousValues('tokens'),
        },
        {
          name: t('trend.costSeries', { label: previousLabel, suffix: cumulativeSuffix }),
          yAxisIndex: 1,
          type: 'line',
          smooth: 0.35,
          showSymbol: false,
          lineStyle: { width: 1.5, type: 'dotted', color: theme.textTertiary },
          itemStyle: { color: theme.textTertiary },
          data: previousValues('cost'),
        },
      ],
    };
  }, [
    comparison,
    track,
    isCumulative,
    dayBuckets,
    currentCumulative,
    previousCumulative,
    currentSeries,
    previousSeries,
    currentLabel,
    previousLabel,
    cloudBaselineUnverified,
    cloudCostKnown,
    tokenAverage,
    costAverage,
    overlay,
    overlayMethod,
    forecastColor,
    reduceMotion,
    theme,
  ]);

  const currentOnlyOption = useMemo(() => {
    const tools = activeTools.length > 0
      ? activeTools.map((tool) => tool.name)
      : currentSeriesName
        ? [currentSeriesName]
        : [];
    const usesToolLabels = activeTools.length > 0 || currentSeriesIsTool;
    const seriesLabel = (id: string) => (usesToolLabels ? toolDisplayName(id) : id);
    // tools preserves activeTools' rank order (useStats sorts by displayed
    // tokens desc); resolve same-slot collisions once by that rank (T10.178).
    const toolColors = colorsForToolsInView(tools, effective);

    return {
      backgroundColor: 'transparent',
      ...getChartAnimation(reduceMotion),
      // No top-level palette here (review P2-5): every series below sets its
      // own lineStyle/itemStyle colour from toolColors, so a fallback
      // palette would only ever mislead a future reader into thinking the
      // legend/tooltip marker colour could still come from somewhere else.
      tooltip: {
        ...getChartTooltip(theme),
        trigger: 'axis',
        renderMode: 'richText',
      },
      legend: {
        top: 0,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: theme.textSecondary, fontSize: 11 },
      },
      // T10.178 review B1: the end-of-line tool name is drawn in the series'
      // own colour, so a right margin only wide enough for the axis label
      // (14px) clips it. Widened just for this chart; other charts' grids are
      // untouched (desktop-visual-refresh-v2.md 留白规则 — the margin still
      // scales with the content it has to fit, not a blanket increase).
      grid: getChartGrid({ left: 8, right: tools.length > 0 ? 78 : 14, top: 34, bottom: 6 }),
      xAxis: {
        type: 'category' as const,
        boundaryGap: false,
        data: trends.map((item) => item.date),
        axisLabel: {
          color: theme.textTertiary,
          fontSize: 11,
          formatter: formatBucketLabel,
        },
        axisLine: { lineStyle: { color: theme.border } },
      },
      yAxis: {
        type: 'value' as const,
        splitLine: { lineStyle: { color: theme.borderFaint } },
        axisLabel: { color: theme.textTertiary, formatter: (value: number) => formatAxisTokens(value) },
      },
      series: tools.map((tool, index) => {
        const color = toolColors[index];
        return {
          name: seriesLabel(tool),
          type: 'line',
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2.25, color },
          // Review P2-5: without this, ECharts falls back to the default
          // palette (getPalette) for the legend swatch and tooltip marker —
          // the one visible place two same-slot tools would go back to being
          // indistinguishable, since only lineStyle.color was set before.
          itemStyle: { color },
          areaStyle: { color: lineAreaGradient(color, 0.16) },
          // Review B1: colour is not the only cue identifying which line is
          // which tool — the line's own name sits at its end. `moveOverlap`
          // nudges apart end labels that would otherwise land on top of each
          // other when two tools' latest values are close.
          endLabel: {
            show: true,
            formatter: () => seriesLabel(tool),
            color,
            fontSize: 10,
            fontFamily: CHART_FONT_FAMILY,
            distance: 6,
          },
          labelLayout: { moveOverlap: 'shiftY' },
          data: trends.map((item) => Number(item[tool] || 0)),
        };
      }),
    };
  }, [trends, activeTools, currentSeriesName, currentSeriesIsTool, effective, reduceMotion, theme]);

  const windowNote = currentOnlyNote ?? (overviewStats ? overviewTrendWindowNote(range, scope) : undefined);
  const subtitle = comparison
    ? t('trend.subtitle', { insight: comparisonInsight, date: comparison.window.alignedThrough })
    : windowNote
      ? windowNote
      : range === 'year'
        ? t('trend.subtitle.year')
        : range === 'all'
          ? t('trend.subtitle.all')
          : t('trend.subtitle.none');

  const chartAriaLabel = useMemo(() => {
    if (comparison) {
      const modeDesc = t(track === 'tokens' ? 'trend.view.tokens' : track === 'cost' ? 'trend.view.cost' : 'trend.view.dualAria');
      const averageSentence = tokenAverage && tokenAverage.current !== null
        ? ` ${t('trend.aria.average', {
          prefix: averagePrefix,
          value: formatAverageTokens(tokenAverage.current),
          basis: `${t('trend.basis', { n: tokenAverage.buckets, unit: unitWord })}${clip ? t('trend.aria.clipSuffix', { note: clip.note }) : ''}`,
          previous: !cloudBaselineUnverified && tokenAverage.previous !== null ? t('trend.aria.previousAverage', { label: previousLabel, value: formatAverageTokens(tokenAverage.previous) }) : '',
        })}`
        : '';
      const forecastSentence = forecastLines.map((line) => ` ${line.ariaLabel}`).join('');
      const totals = t('trend.aria.totals', {
        current: currentLabel,
        currentValue: `${formatTokens(currentTokens)} (${formatEstimatedUsd(currentCost)})`,
        previous: previousLabel,
        previousValue: cloudBaselineUnverified ? t('trend.aria.baselineUnverified') : `${formatTokens(previousTokens)} (${formatEstimatedUsd(previousCost)})`,
      });
      return `${t('trend.aria.chart', { mode: modeDesc, cumulative: isCumulative ? t('trend.aria.cumulative') : '' })}${comparisonInsight} ${totals}${averageSentence}${forecastSentence}`;
    }
    return t('trend.aria.noComparison', { subtitle });
  // 文案随界面语言变化：`lang` 进依赖以便切换后重算。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    comparison,
    track,
    isCumulative,
    comparisonInsight,
    currentLabel,
    currentTokens,
    currentCost,
    previousLabel,
    cloudBaselineUnverified,
    previousTokens,
    previousCost,
    tokenAverage,
    averagePrefix,
    unitWord,
    clip,
    forecastLines,
    subtitle,
    lang,
  ]);

  const showViewToggle = !!comparison && dayBuckets;
  const showStrip = !!comparison && (showViewToggle || forecastLines.length > 0);
  // 没有同期对比时只绘制 Token；保留用户的对比视角偏好，但不把它写成当前图表指标。
  const presentationLabels = trendPresentationLabels(comparison ? track : 'tokens', viewMode, comparison?.window.bucket ?? null);
  const comparisonContextNotes = useMemo(() => {
    if (!comparison) return [];
    const notes: string[] = [];
    if (cloudBaselineUnverified) {
      notes.push(t('trend.note.baselineUnverified'));
    }
    if (clip) {
      notes.push(t('trend.note.clipped', { note: clip.note }));
    }
    if (tokenAverage) {
      notes.push(tokenAverage.buckets > 0
        ? t(hourBuckets ? 'trend.note.avgHour' : 'trend.note.avgDay', { prefix: averagePrefix, n: tokenAverage.buckets, unit: unitWord })
        : t(hourBuckets ? 'trend.note.noFullHour' : 'trend.note.noFullDay', { prefix: averagePrefix, unit: unitWord }));
    } else {
      notes.push(t('trend.note.unknown', { unit: unitWord, prefix: averagePrefix }));
    }
    return notes;
  // 文案随界面语言变化：`lang` 进依赖以便切换后重算。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparison, cloudBaselineUnverified, clip, tokenAverage, averagePrefix, unitWord, hourBuckets, lang]);
  // 基线未验证或同期截断会改变读数含义，这时比较口径留在卡面；常规口径只在 ⓘ 里。
  const contextNotesAlert = cloudBaselineUnverified || !!clip;

  return (
    <section className="panel trend-panel comparison-trend-panel" aria-label={t('trend.aria.panel')}>
      <div className="comparison-panel-head">
        <div>
          <div className="panel-title flex items-center gap-2">
            <span className="trend-icon-tile" aria-hidden="true">
              {comparison ? <GitCompareArrows className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
            </span>
            <span>{comparison ? t('trend.title.comparison') : t('trend.title')}</span>
            {/* U-102：副标题、呈现方式、常规比较口径与 Token 口径都收进 ⓘ，卡面只留标题与图。 */}
            <InfoTip label={t('trend.info')}>
              <span>{subtitle}</span>
              <span className="trend-presentation-context" aria-label={t('trend.presentationAria')}>
                {comparison && <span>{t('trend.viewLabel')}<strong>{t(track === 'tokens' ? 'trend.view.tokens' : track === 'cost' ? 'trend.view.costUsd' : 'trend.view.dual')}</strong></span>}
                <span>{t('trend.metricLabel')}<strong>{presentationLabels.metric}</strong></span>
                <span>{t('trend.shapeLabel')}<strong>{presentationLabels.shape}</strong></span>
              </span>
              {comparisonContextNotes.length > 0 && !contextNotesAlert && (
                <span className="trend-context-notes" aria-label={t('trend.contextAria')}>
                  <strong>{t('trend.contextTitle')}</strong> {comparisonContextNotes.join(' · ')}
                </span>
              )}
              <span className="trend-accounting-note">{t('trend.accounting')}</span>
            </InfoTip>
          </div>
        </div>

        {/* 视角切换只作用于对比图；没有对比时图表只按工具画 Token，不放一个无效的开关（审计 Q5）。 */}
        {comparison && (
          <div className="segmented tl-seg trend-track-control" role="group" aria-label={t('trend.trackAria')} ref={trackSegRef}>
            <button
              type="button"
              className={track === 'tokens' ? 'active' : ''}
              onClick={() => setTrack('tokens')}
              aria-pressed={track === 'tokens'}
              aria-label={t('trend.switchTokens')}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>{t('trend.view.tokens')}</span>
            </button>
            <button
              type="button"
              className={track === 'cost' ? 'active' : ''}
              onClick={() => setTrack('cost')}
              aria-pressed={track === 'cost'}
              aria-label={t('trend.switchCost')}
            >
              <Banknote className="h-3.5 w-3.5" />
              <span>{t('trend.view.cost')}</span>
            </button>
            <button
              type="button"
              className={track === 'dual' ? 'active' : ''}
              onClick={() => setTrack('dual')}
              aria-pressed={track === 'dual'}
              aria-label={t('trend.switchDual')}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>{t('trend.view.dual')}</span>
            </button>
          </div>
        )}
      </div>

      {comparison && (
        <div className={`comparison-kpis ${kpiCells.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} role="region" aria-label={t('trend.kpiAria')}>
          {kpiCells.map((cell) => <TrendKpiCell key={cell.key} cell={cell} />)}
        </div>
      )}

      {showStrip && (
        <div className="trend-insight-strip is-justified" role="region" aria-label={t('trend.stripAria')}>
          <div className="trend-insight-strip-group min-w-0 flex-1">
            {forecastLines.map((line) => <ForecastLine key={line.key} line={line} />)}
          </div>
          {showViewToggle && (
            // 预测详情展开时切换按钮留在首行，不随展开区上下跳动。
            <div className="segmented tl-seg trend-subtoggle self-start" role="group" aria-label={t('trend.viewModeAria')} ref={viewSegRef}>
              <button
                type="button"
                className={viewMode === 'daily' ? 'active' : ''}
                onClick={() => setViewMode('daily')}
                aria-pressed={viewMode === 'daily'}
              >
                {t('trend.daily')}
              </button>
              <button
                type="button"
                className={viewMode === 'cumulative' ? 'active' : ''}
                onClick={() => setViewMode('cumulative')}
                aria-pressed={viewMode === 'cumulative'}
              >
                {t('trend.cumulative')}
              </button>
            </div>
          )}
        </div>
      )}

      {comparisonContextNotes.length > 0 && contextNotesAlert && (
        <aside className="trend-context-notes" aria-label={t('trend.contextAria')}>
          <strong>{t('trend.contextTitle')}</strong>
          <span>{comparisonContextNotes.join(' · ')}</span>
        </aside>
      )}

      {comparison && (
        <div className="comparison-period-summary" aria-hidden="true">
          <span>
            <i className="current-line" style={track === 'cost' ? { borderTopColor: 'var(--color-success)' } : undefined} />
            {currentLabel}{isCumulative ? t('trend.cumulativeSuffix') : ''} <b className="font-semibold">{formatTokens(currentTokens)}</b> (<b className="font-semibold">{formatEstimatedUsd(currentCost)}</b>)
          </span>
          <span>
            <i className="previous-line" />
            {previousLabel} {cloudBaselineUnverified ? t('trend.unverifiedDash') : <><b className="font-semibold">{formatTokens(previousTokens)}</b> (<b className="font-semibold">{formatEstimatedUsd(previousCost)}</b>)</>}
          </span>
          {overlay && (
            <span>
              <i style={{ borderTopColor: forecastColor, borderTopStyle: 'dashed', borderTopWidth: 2 }} />
              {t('trend.forecastRange')}
            </span>
          )}
        </div>
      )}

      <div className="chart-fill">
        <EChart
          className="chart-canvas-fill"
          option={comparisonOption || currentOnlyOption}
          ariaLabel={chartAriaLabel}
        />
      </div>
    </section>
  );
}

export const TrendPanel = memo(TrendPanelComponent);

export default TrendPanel;
