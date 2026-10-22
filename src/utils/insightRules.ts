/**
 * 时段节奏与突增侦测的纯规则层（T10.86）。
 * 无 React 依赖：组件与 HTML 简报共用同一判定，禁止两套实现漂移。
 * 诚实边界见各函数文档；输入均为 `trends[]` 契约桶（{date, [工具名]: tokens}）。
 */
import type { ComparisonDeltaMetric, ComparisonSeriesPoint, DataScope, RangeKey, StatsData, TrendPoint, UsageComparison } from '../types';
import { isoCalendarDayValue } from './contracts/statsQuery';
import { formatTokens, formatUsdApprox } from './format';
import { isDrillableDateBucket, trendBucketKind, trendBucketTokens, weekdayOfDateBucket } from './trendsAggregate';

/** 单个时段格子的悬浮详情（T10.111）。字段为 null 表示该来源没有数据，UI 不渲染那一行、不写 0。 */
export interface RhythmCellDetail {
  /** 时段区间文案，如 `08:00 – 09:00`、`周二 · 日均`。 */
  range: string;
  tokens: number;
  /** 占本期已观测总量的比例（0–1）；总量为 0 时为 null。 */
  share: number | null;
  shareLabel: string;
  requests: number | null;
  cost: number | null;
  /** 同期对比基线（昨日同时段 / 上一周期同位桶）的有效 Token；无对比数据为 null。 */
  previousTokens: number | null;
  previousLabel: string;
  /** 该时段贡献最多的工具及其占比（0–1）。 */
  topTool: { name: string; share: number } | null;
  /** 附注，如星期节奏的“3/4 天有消耗”。 */
  note: string | null;
}

export interface RhythmCell {
  key: string;
  label: string;
  value: number;
  title: string;
  state: 'complete' | 'in-progress' | 'future';
  detail?: RhythmCellDetail | null;
}

export interface Rhythm {
  mode: 'hour' | 'weekday';
  cells: RhythmCell[];
  total: number;
  summary: string;
  /**
   * 星期节奏观测不足（某个星期几少于 2 个完整日）时为 true：cells 为空，summary 说明原因。
   * 界面只显示这句说明，不画色阶（T10.159，审计 Q4）。
   */
  withheld?: boolean;
}

/** 按星期取日均至少需要每个星期几都有这么多个完整日（审计 Q4）。 */
export const RHYTHM_MIN_DAYS_PER_WEEKDAY = 2;

/** 本机“全部”范围的趋势与节奏只覆盖最近这么多个日桶（今天往前 30 天，DESIGN §4.8 观察窗）。 */
export const LOCAL_ALL_OBSERVATION_DAYS = 31;

/** 格子相对色阶：0 = 无消耗，1–5 按与本期峰值的比值均分（T10.111，取代按数量级跳色相）。 */
export function rhythmLevel(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(5, Math.max(1, Math.ceil((value / max) * 5)));
}

/** 与基线的变化文案：基线为 0 时只说“新增”，不伪造百分比。 */
export function describeRhythmDelta(current: number, previous: number | null): string | null {
  if (previous === null) return null;
  if (previous <= 0) return current > 0 ? '新增' : '持平';
  const percent = ((current - previous) / previous) * 100;
  if (Math.abs(percent) < 0.05) return '持平';
  return `${percent > 0 ? '+' : '−'}${Math.abs(percent).toFixed(1)}%`;
}

function topToolOf(tools: Map<string, number>, total: number): RhythmCellDetail['topTool'] {
  if (total <= 0) return null;
  let best: { name: string; tokens: number } | null = null;
  for (const [name, tokens] of tools) {
    if (tokens > 0 && (!best || tokens > best.tokens)) best = { name, tokens };
  }
  return best ? { name: best.name, share: best.tokens / total } : null;
}

export interface Spike {
  date: string;
  label: string;
  value: number;
  ratio: number;
  drillable: boolean;
  inProgress: boolean;
}

export interface Detection {
  state: 'flagged' | 'calm' | 'sparse' | 'empty';
  spikes: Spike[];
  bucketCount: number;
  median: number;
  /** 阈值/中位数的倍数，用于把判定规则如实写进界面文案。 */
  thresholdRatio: number;
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export interface InsightTimeContext {
  range: RangeKey;
  timeZone: string;
  cutoffDate: string;
  cutoffHour: number;
  /** 契约的已结束自定义区间以当地 23:59:59 为闭区间末尾；普通当前桶不适用。 */
  closedCustomEnd?: boolean;
  scope?: DataScope;
  /**
   * 日桶范围的日历窗口（来源时区公历日，含首尾）：本周、本月与多日自定义区间才有。
   * 云端 `trends[]` 只列有记录的日子，按这个窗口补齐“没有消耗的完整日”，与本机预置的
   * 稠密日桶得到同一个观测天数（T10.159）。
   */
  windowStart?: string;
  windowEnd?: string;
}

interface CivilCutoff {
  date: string;
  hour: number;
}

const DAY_MS = 86_400_000;

function civilDayFromValue(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function addCivilDays(date: string, days: number): string | null {
  const value = isoCalendarDayValue(date);
  return value === null ? null : civilDayFromValue(value + days * DAY_MS);
}

/** 截止日所在范围的日历窗口；只有日桶范围才有，今天、今年、全部与单日自定义返回 null。 */
function dayWindowOf(
  range: RangeKey,
  cutoffDate: string,
  query: { start?: string | null; end?: string | null } | undefined,
): { windowStart: string; windowEnd: string } | null {
  const cutoff = isoCalendarDayValue(cutoffDate);
  if (cutoff === null) return null;
  const probe = new Date(cutoff);
  if (range === 'week') {
    // 周一开始的自然周（DESIGN §3）。
    const offset = (probe.getUTCDay() + 6) % 7;
    return {
      windowStart: civilDayFromValue(cutoff - offset * DAY_MS),
      windowEnd: civilDayFromValue(cutoff + (6 - offset) * DAY_MS),
    };
  }
  if (range === 'month') {
    return {
      windowStart: civilDayFromValue(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), 1)),
      windowEnd: civilDayFromValue(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0)),
    };
  }
  if (range === 'custom') {
    const start = query?.start;
    const end = query?.end;
    if (typeof start !== 'string' || typeof end !== 'string') return null;
    const startValue = isoCalendarDayValue(start);
    const endValue = isoCalendarDayValue(end);
    if (startValue === null || endValue === null || startValue >= endValue) return null;
    return { windowStart: start, windowEnd: end };
  }
  return null;
}

type BucketObservationState = 'complete' | 'in-progress' | 'future';

function validateTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function civilCutoff(value: string | Date, timeZone: string): CivilCutoff | null {
  if (!validateTimeZone(timeZone)) return null;

  if (typeof value === 'string'
    && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) {
    return null;
  }

  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = Number(get('hour'));
  if (!year || !month || !day || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return { date: `${year}-${month}-${day}`, hour };
}

function comparisonCivilCutoff(value: string, timeZone: string): CivilCutoff | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    const date = `${year}-${month}-${day}`;
    const parsedHour = Number(hour);
    const parsedMinute = Number(minute);
    const parsedSecond = Number(second);
    if (trendBucketKind(date) === 'day'
      && parsedHour >= 0 && parsedHour <= 23
      && parsedMinute >= 0 && parsedMinute <= 59
      && parsedSecond >= 0 && parsedSecond <= 59) {
      return { date, hour: parsedHour };
    }
    return null;
  }
  return civilCutoff(value, timeZone);
}

/**
 * 从 Stats v2 的事实字段派生洞察截止点。查询、comparison 与 meta 的时区若冲突，
 * 直接返回 null；旧快照也按自己的 generatedAt 裁剪，绝不借用当前墙钟补未来桶。
 */
export function deriveInsightTimeContext(
  stats: Pick<StatsData, 'comparison' | 'meta'>,
  range: RangeKey,
  scope?: DataScope,
  fallbackCutoff?: string | Date,
): InsightTimeContext | null {
  const queryRange = stats.meta?.query?.range ?? stats.meta?.range;
  if (queryRange && queryRange !== range) return null;

  const sourceTimeZone = stats.meta?.timezone;
  if (typeof sourceTimeZone !== 'string'
    || sourceTimeZone.trim().length === 0
    || !validateTimeZone(sourceTimeZone)) {
    return null;
  }
  const assertedTimeZones = [
    stats.meta?.query?.timezone,
    stats.comparison?.window.timezone,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (assertedTimeZones.some((value) => value !== sourceTimeZone)) return null;

  const comparisonEnd = stats.comparison?.window.currentEnd;
  const cutoff = (typeof comparisonEnd === 'string'
    ? comparisonCivilCutoff(comparisonEnd, sourceTimeZone)
    : null)
    ?? (stats.meta?.generatedAt ? civilCutoff(stats.meta.generatedAt, sourceTimeZone) : null)
    ?? (fallbackCutoff ? civilCutoff(fallbackCutoff, sourceTimeZone) : null);
  if (!cutoff) return null;
  const window = dayWindowOf(range, cutoff.date, stats.meta?.query);
  return {
    range,
    timeZone: sourceTimeZone,
    cutoffDate: cutoff.date,
    cutoffHour: cutoff.hour,
    ...(range === 'custom' && stats.comparison && isClosedCustomEnd(stats.comparison.window)
      ? { closedCustomEnd: true }
      : {}),
    scope,
    ...(window ?? {}),
  };
}

interface CivilInstant {
  date: string;
  hour: number;
  minute: number;
  second: number;
}

/** comparison 截止点的来源时区时刻，精确到秒；只用于判断截止点是否已是桶的最后一秒。 */
function comparisonCivilInstant(value: string, timeZone: string): CivilInstant | null {
  const civil = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (civil) {
    const [, date, hour, minute, second] = civil;
    const parsed = { date, hour: Number(hour), minute: Number(minute), second: Number(second) };
    return trendBucketKind(date) === 'day' && parsed.hour <= 23 && parsed.minute <= 59 && parsed.second <= 59
      ? parsed
      : null;
  }
  if (!validateTimeZone(timeZone)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) {
    return null;
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  if (!year || !month || !day || ![hour, minute, second].every(Number.isInteger)) return null;
  return { date: `${year}-${month}-${day}`, hour, minute, second };
}

/** §3 的 custom 闭区间标记；实时查询的 xx:59:59 仍在该小时内，不能提前计为完整。 */
function isClosedCustomEnd(window: UsageComparison['window']): boolean {
  if (window.kind !== 'periodOverPeriod') return false;
  const value = String(window.currentEnd ?? '').trim();
  const cutoff = comparisonCivilInstant(value, window.timezone);
  // JS Date 会丢弃微秒；先检查原文，避免 .000001 被截成整秒后误认成闭区间标记。
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})?$/i)?.[1] ?? '';
  return cutoff?.hour === 23 && cutoff.minute === 59 && cutoff.second === 59 && !/[1-9]/.test(fraction);
}

/**
 * 同期对比中当前周期已经完整的前 k 个桶（T10.159，契约 §3）：截止点所在的桶按进行中处理，
 * 除非已结束的自定义区间携带契约定义的当地 23:59:59 闭区间末尾。只读 comparison 自带的
 * `window.currentEnd` 与 `window.timezone`，与宿主时区无关。桶键无法识别时返回 null，
 * 调用方不得退回“按全部桶平均”。
 */
export function completedComparisonBucketCount(
  comparison: Pick<UsageComparison, 'window' | 'current'>,
): number | null {
  const series = comparison.current.series;
  if (series.length === 0) return 0;
  const cutoff = comparisonCivilInstant(String(comparison.window.currentEnd ?? ''), comparison.window.timezone);
  if (!cutoff) return null;
  const hourly = comparison.window.bucket === 'hour';
  const cutoffBucketEnded = isClosedCustomEnd(comparison.window);
  let completed = 0;
  for (const point of series) {
    const bucket = typeof point.bucket === 'string' ? point.bucket : '';
    const kind = trendBucketKind(bucket);
    if (hourly ? kind !== 'hour' : kind !== 'day') return null;
    const complete = hourly
      ? Number(bucket.slice(0, 2)) < cutoff.hour || (Number(bucket.slice(0, 2)) === cutoff.hour && cutoffBucketEnded)
      : bucket < cutoff.date || (bucket === cutoff.date && cutoffBucketEnded);
    if (!complete) break;
    completed += 1;
  }
  return completed;
}

/** 已完成桶的均值与上期同段对照（T10.159，审计 Q4）。 */
export interface CompletedBucketAverage {
  unit: UsageComparison['window']['bucket'];
  /** 参与平均的已完成桶数；0 表示还没有完整的桶。 */
  buckets: number;
  /** 本期前 `buckets` 个桶的均值；`buckets` 为 0 时为 null。 */
  current: number | null;
  /** 上期前 `buckets` 个桶（同进度对齐的同一段）的均值；上期序列不够长或含无效值时为 null。 */
  previous: number | null;
  /** 与上期同段的差；上期为 0 时 percent 为 null，方向写 new / flat，绝不给 0% 或 ∞。 */
  delta: ComparisonDeltaMetric | null;
}

/**
 * 日均 / 小时均的唯一口径（T10.159，审计 Q4；契约 §3 不得把含未结束末桶的均值当完整速率）：
 * 只平均已经结束的桶，进行中的末桶与未来桶不计入；上期取同进度对齐的前同样多个桶。
 * 桶结构无法判定或本期含非有限、负值时返回 null，调用方显示“—”而不是退回全桶平均。
 */
export function completedBucketAverage(
  comparison: Pick<UsageComparison, 'window' | 'current' | 'previous'>,
  metric: 'tokens' | 'cost',
): CompletedBucketAverage | null {
  const buckets = completedComparisonBucketCount(comparison);
  if (buckets === null) return null;
  const unit = comparison.window.bucket;
  if (buckets === 0) return { unit, buckets, current: null, previous: null, delta: null };
  const mean = (series: readonly ComparisonSeriesPoint[]): number | null => {
    if (series.length < buckets) return null;
    let sum = 0;
    for (let index = 0; index < buckets; index += 1) {
      const value = series[index]?.[metric];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
      sum += value;
    }
    return sum / buckets;
  };
  const current = mean(comparison.current.series);
  if (current === null) return null;
  const previous = mean(comparison.previous.series);
  if (previous === null) return { unit, buckets, current, previous, delta: null };
  const raw = current - previous;
  const absolute = Math.abs(raw) < Number.EPSILON ? 0 : raw;
  return {
    unit,
    buckets,
    current,
    previous,
    delta: {
      absolute,
      percent: previous === 0 ? null : (absolute / previous) * 100,
      direction: previous === 0 && current > 0 ? 'new' : absolute === 0 ? 'flat' : absolute > 0 ? 'up' : 'down',
    },
  };
}

/** 月末同期截短（T10.159 P2-2）。 */
export interface ComparisonClip {
  /** 本期对比窗口实际截止的来源时区公历日 `YYYY-MM-DD`。 */
  date: string;
  /** KPI 变化、日均与单位费用共用的说明：`截至 3月28日`。 */
  note: string;
}

/**
 * 同期对比被截短时给出截止日（T10.159 P2-2）。月末几天后端按上月天数对齐同期（本机
 * `aligned_day = min(今天, 上月天数)`，云端 SQL 同理）：`comparison` 的本期窗口止于对齐日，
 * `summary` 与 KPI 主值却统计到现在，两者不是同一个窗口。判定与预测规则层的 `comparison-clipped`
 * 同一条件：对比截止日（`comparison.window.currentEnd` 的来源时区日期）早于“今天”（`meta.generatedAt`
 * 的来源时区日期；已经结束的自定义区间取区间末日）。平日、小时桶与时间上下文不可用时返回 null。
 */
export function comparisonClip(
  stats: Pick<StatsData, 'comparison' | 'meta'>,
  range: RangeKey,
): ComparisonClip | null {
  const comparison = stats.comparison;
  if (!comparison || comparison.window.bucket !== 'day') return null;
  const context = deriveInsightTimeContext(stats, range);
  const generated = deriveInsightTimeContext({ meta: stats.meta }, range);
  if (!context || !generated) return null;
  const queryEnd = range === 'custom' ? stats.meta?.query?.end : null;
  const periodEnd = typeof queryEnd === 'string'
    && isoCalendarDayValue(queryEnd) !== null
    && queryEnd < generated.cutoffDate
    ? queryEnd
    : generated.cutoffDate;
  if (context.cutoffDate >= periodEnd) return null;
  const [, month, day] = context.cutoffDate.split('-').map(Number);
  return { date: context.cutoffDate, note: `截至 ${month}月${day}日` };
}

/**
 * 云端本期对比序列逐桶的费用能否证明（T10.159 P3-2）。云端 `comparison` 的序列与汇总用
 * `coalesce(cost_usd, 0)` 把未知费用合成了 0，只有 `dailyCosts` 能证明金额（契约 dashboard-stats-v2），
 * 映射与预测规则层 `forecastInputFromStats` 相同：
 * - dailyCosts 只列有效 Token > 0 的日子：recorded-estimate 可证，unavailable 未知；
 * - 没列出的日子里，没有任何记录（请求与 Token 都为 0）才是真实的 $0，其余（例如只有缓存读写）未知；
 * - 小时桶：没有记录的小时是真实的 $0，其余沿用所在日期的状态。
 * 返回与 `comparison.current.series` 等长的数组（true 表示该桶费用可证）；dailyCosts 缺失、覆盖不是
 * complete、时区与对比不一致时返回 null，表示整体无从核实。覆盖区间外的桶按未知处理（规则层要求
 * 覆盖与本期首日、今天完全一致，否则整体不可得）。本机逐行费用已按价格表估算，不需要调用。
 */
export function cloudComparisonCostKnown(
  stats: Pick<StatsData, 'comparison' | 'dailyCosts'>,
): boolean[] | null {
  const comparison = stats.comparison;
  const dailyCosts = stats.dailyCosts;
  if (!comparison
    || !dailyCosts
    || dailyCosts.coverage.state !== 'complete'
    || dailyCosts.coverage.timezone !== comparison.window.timezone) {
    return null;
  }
  const { start, end } = dailyCosts.coverage;
  const covered = (date: string | null): date is string => date !== null
    && trendBucketKind(date) === 'day'
    && (start === null || date >= start)
    && date <= end;
  const provable = new Map(dailyCosts.days.map((day) => [day.date, day.status === 'recorded-estimate']));
  const hourly = comparison.window.bucket === 'hour';
  const hourDate = hourly
    ? comparisonCivilInstant(String(comparison.window.currentEnd ?? ''), comparison.window.timezone)?.date ?? null
    : null;
  return comparison.current.series.map((point) => {
    const empty = point.requests === 0 && point.tokens === 0;
    if (hourly) return empty || (covered(hourDate) && (provable.get(hourDate) ?? false));
    if (!covered(point.bucket)) return false;
    return provable.get(point.bucket) ?? empty;
  });
}

function monthBucketParts(date: string, cutoffYear: number): { year: number; month: number } | null {
  const localMatch = date.match(/^(\d{1,2})(?:月|M)$/);
  if (localMatch) return { year: cutoffYear, month: Number(localMatch[1]) };
  const cloudMatch = date.match(/^(\d{4})-(\d{2})$/);
  if (cloudMatch) return { year: Number(cloudMatch[1]), month: Number(cloudMatch[2]) };
  return null;
}

function bucketObservationState(date: string, context: InsightTimeContext): BucketObservationState | null {
  const kind = trendBucketKind(date);
  // 自定义单日区间与今日一样按小时桶观测；多日自定义区间走下面的日桶分支。
  if (context.range === 'today' || (context.range === 'custom' && kind === 'hour')) {
    if (kind !== 'hour') return null;
    const hour = Number(date.slice(0, 2));
    if (hour < context.cutoffHour) return 'complete';
    if (hour === context.cutoffHour) return context.closedCustomEnd ? 'complete' : 'in-progress';
    return 'future';
  }

  if (context.range === 'year') {
    if (kind !== 'month') return null;
    const [cutoffYear, cutoffMonth] = context.cutoffDate.split('-').map(Number);
    const bucket = monthBucketParts(date, cutoffYear);
    if (!bucket) return null;
    const bucketOrdinal = bucket.year * 12 + bucket.month;
    const cutoffOrdinal = cutoffYear * 12 + cutoffMonth;
    if (bucketOrdinal < cutoffOrdinal) return 'complete';
    if (bucketOrdinal === cutoffOrdinal) return 'in-progress';
    return 'future';
  }

  if (kind !== 'day') return null;
  if (date < context.cutoffDate) return 'complete';
  if (date === context.cutoffDate) return context.closedCustomEnd ? 'complete' : 'in-progress';
  return 'future';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

/**
 * 星期节奏的观测窗口：从范围首日（没有时取最早的完整日桶）到截止日前一天，逐个公历日
 * 计数。本机日桶是预置的稠密序列，云端只列有记录的日子；没有记录的完整日按 0 计入，
 * 两端因此得到同一个观测天数与同一个日均（T10.159）。
 */
function weekdayObservations(
  dayValues: ReadonlyMap<string, number>,
  context: InsightTimeContext,
): { days: number; buckets: Array<{ sum: number; observed: number; active: number }> } {
  const buckets = Array.from({ length: 7 }, () => ({ sum: 0, observed: 0, active: 0 }));
  const dates = [...dayValues.keys()].sort();
  const earliest = dates[0];
  const latest = dates[dates.length - 1];
  let start = context.windowStart ?? earliest;
  if (earliest && (!start || earliest < start)) start = earliest;
  const lastComplete = context.closedCustomEnd ? context.cutoffDate : addCivilDays(context.cutoffDate, -1);
  let end = context.windowEnd && lastComplete && context.windowEnd < lastComplete ? context.windowEnd : lastComplete;
  if (latest && (!end || latest > end)) end = latest;
  const startValue = start ? isoCalendarDayValue(start) : null;
  const endValue = end ? isoCalendarDayValue(end) : null;
  if (startValue === null || endValue === null || startValue > endValue) return { days: 0, buckets };
  let days = 0;
  for (let value = startValue; value <= endValue; value += DAY_MS) {
    const date = civilDayFromValue(value);
    const tokens = dayValues.get(date) ?? 0;
    const bucket = buckets[(new Date(value).getUTCDay() + 6) % 7];
    bucket.sum += tokens;
    bucket.observed += 1;
    if (tokens > 0) bucket.active += 1;
    days += 1;
  }
  return { days, buckets };
}

function rhythmScopePrefix(context: InsightTimeContext): string {
  if (context.range !== 'all') return '';
  if (context.scope === 'local') return `本机最近 ${LOCAL_ALL_OBSERVATION_DAYS} 日；`;
  if (context.scope === 'cloud') return '云端全部历史；';
  return '';
}

/** 观测不足时的一句说明：说清还差什么，而不是只说“暂无数据”。 */
function withheldWeekdayNote(days: number, shortWeekdays: string[]): string {
  if (days === 0) {
    return `还没有完整日，暂不按星期聚合（每个星期几至少需要 ${RHYTHM_MIN_DAYS_PER_WEEKDAY} 个完整日）`;
  }
  if (shortWeekdays.length === WEEKDAYS.length) {
    return `已完成 ${days} 天，每个星期几都不足 ${RHYTHM_MIN_DAYS_PER_WEEKDAY} 天，暂不按星期聚合`;
  }
  return `已完成 ${days} 天，其中${shortWeekdays.join('、')}不足 ${RHYTHM_MIN_DAYS_PER_WEEKDAY} 天，暂不按星期聚合（每个星期几至少需要 ${RHYTHM_MIN_DAYS_PER_WEEKDAY} 个完整日）`;
}

/**
 * 从 `trends[]` 桶派生消耗节奏。诚实边界：
 * - 只有真实存在的小时桶（range=today 或单日自定义区间）才画 24 小时节奏；
 * - 日桶（week/month/all/多日自定义）聚合为「星期节奏」，展示的是**日均**而非伪造的
 *   小时分布；只用完整日，按公历日计数（没有记录的完整日记 0），未来占位与进行中的
 *   今天不计入；
 * - 任何一个星期几少于 2 个完整日时不画色阶，只给一句原因（T10.159，审计 Q4）：
 *   单个样本的“日均”只是把趋势重画一遍；
 * - 月桶（year）没有时段语义，返回 null（面板/简报整体不呈现）；
 * - 全零是真实状态，色阶留空并明示，不隐藏也不编造。
 */
export function buildRhythm(
  trends: TrendPoint[],
  context: InsightTimeContext,
  comparison?: UsageComparison | null,
): Rhythm | null {
  if (context.range === 'year') return null;
  let hourCount = 0;
  let sawDayBucket = false;
  const hourSums = new Map<number, number>();
  const hourTools = new Map<number, Map<string, number>>();
  const dayValues = new Map<string, number>();

  for (const point of trends) {
    const date = typeof point.date === 'string' ? point.date : '';
    const kind = trendBucketKind(date);
    if (kind === 'day') sawDayBucket = true;
    const state = bucketObservationState(date, context);
    if (!state || state === 'future') continue;
    const value = trendBucketTokens(point);
    if (kind === 'hour') {
      hourCount += 1;
      const hour = Number(date.slice(0, 2));
      hourSums.set(hour, (hourSums.get(hour) || 0) + value);
      const tools = hourTools.get(hour) || new Map<string, number>();
      for (const [tool, tokens] of Object.entries(point)) {
        if (tool === 'date' || tool.startsWith('__') || typeof tokens !== 'number' || !Number.isFinite(tokens)) continue;
        tools.set(tool, (tools.get(tool) || 0) + tokens);
      }
      hourTools.set(hour, tools);
    } else if (kind === 'day' && state === 'complete' && weekdayOfDateBucket(date) !== null) {
      dayValues.set(date, (dayValues.get(date) || 0) + value);
    }
    // month 桶（`M月`）没有时段语义：不参与节奏，整体走 null 分支。
  }

  if ((context.range === 'today' || context.range === 'custom') && hourCount >= 2) {
    const cells: RhythmCell[] = [];
    let total = 0;
    // 同期序列只在小时桶对比（今日 / 单日自定义区间）时可用：按桶标签对齐当前值，
    // 按下标对齐上一周期（两条序列等长、同进度），拿到每小时的成本、请求与昨日同时段。
    const hourly = comparison && comparison.window.bucket === 'hour' ? comparison : null;
    const currentIndex = new Map<string, number>();
    hourly?.current.series.forEach((point, index) => currentIndex.set(point.bucket, index));
    const dayWord = context.range === 'today' ? '今日' : '当日';
    for (let hour = 0; hour < 24; hour += 1) {
      const value = hourSums.get(hour) || 0;
      const label = `${String(hour).padStart(2, '0')}:00`;
      const state = bucketObservationState(label, context)!;
      if (state !== 'future') total += value;
      cells.push({
        key: label,
        label: String(hour).padStart(2, '0'),
        value,
        title: state === 'future'
          ? `${label} · 尚未开始`
          : `${label} · ${formatTokens(value)} Tokens${state === 'in-progress' ? '（进行中）' : ''}`,
        state,
      });
    }
    for (const cell of cells) {
      if (cell.state === 'future') {
        cell.detail = null;
        continue;
      }
      const hour = Number(cell.key.slice(0, 2));
      const index = currentIndex.get(cell.key);
      const current = index === undefined ? undefined : hourly?.current.series[index];
      const previous = index === undefined ? undefined : hourly?.previous.series[index];
      cell.detail = {
        range: `${cell.key} – ${String((hour + 1) % 24).padStart(2, '0')}:00`,
        tokens: cell.value,
        share: total > 0 ? cell.value / total : null,
        shareLabel: `占${dayWord}`,
        requests: current ? current.requests : null,
        cost: current ? current.cost : null,
        previousTokens: previous ? previous.tokens : null,
        previousLabel: hourly?.window.kind === 'dayOverDay' ? '昨日同时段' : '上一周期同时段',
        topTool: topToolOf(hourTools.get(hour) || new Map(), cell.value),
        note: null,
      };
    }
    const peak = cells.reduce<RhythmCell | null>((best, cell) => (!best || cell.value > best.value ? cell : best), null);
    const usablePeak = peak && peak.value > 0 ? peak : null;
    const peakCost = usablePeak?.detail?.cost;
    return {
      mode: 'hour',
      cells,
      total,
      summary: usablePeak && total > 0
        ? `${dayWord}活跃峰值 ${usablePeak.key}，≈${formatTokens(usablePeak.value)} Tokens（占 ${Math.round((usablePeak.value / total) * 100)}%）${typeof peakCost === 'number' ? ` · ${formatUsdApprox(peakCost)}` : ''}`
        : '本期暂无消耗，色阶留空',
    };
  }

  // 小时桶范围（今日、单日自定义）不足两个小时桶时不退回星期节奏；
  // 只有日桶范围（或已知日历窗口）才按星期聚合。
  if (context.range === 'today' || (!sawDayBucket && context.windowStart === undefined)) return null;

  const { days, buckets } = weekdayObservations(dayValues, context);
  const total = buckets.reduce((sum, bucket) => sum + bucket.sum, 0);
  const shortWeekdays = WEEKDAYS.filter((_, index) => buckets[index].observed < RHYTHM_MIN_DAYS_PER_WEEKDAY);
  if (shortWeekdays.length > 0) {
    return {
      mode: 'weekday',
      cells: [],
      total,
      summary: `${rhythmScopePrefix(context)}${withheldWeekdayNote(days, shortWeekdays)}`,
      withheld: true,
    };
  }

  const cells: RhythmCell[] = buckets.map((bucket, index) => {
    const value = Math.round(bucket.sum / bucket.observed);
    const label = WEEKDAYS[index];
    return {
      key: label,
      label,
      value,
      title: `${label} · 日均 ≈${formatTokens(value)} Tokens（${bucket.active}/${bucket.observed} 天有消耗）`,
      state: 'complete',
      detail: {
        range: `${label} · 日均`,
        tokens: value,
        share: null,
        shareLabel: '占各星期日均合计',
        requests: null,
        cost: null,
        previousTokens: null,
        previousLabel: '',
        topTool: null,
        note: `${bucket.active}/${bucket.observed} 天有消耗`,
      },
    };
  });
  const averageTotal = cells.reduce((sum, cell) => sum + cell.value, 0);
  for (const cell of cells) {
    if (cell.detail) cell.detail.share = averageTotal > 0 ? cell.value / averageTotal : null;
  }
  const peak = cells.reduce<RhythmCell | null>((best, cell) => (!best || cell.value > best.value ? cell : best), null);
  const usablePeak = peak && peak.value > 0 ? peak : null;
  return {
    mode: 'weekday',
    cells,
    total,
    summary: usablePeak
      ? `${rhythmScopePrefix(context)}按 ${days} 个完整日聚合的日均消耗峰值在 ${usablePeak.key}（≈${formatTokens(usablePeak.value)} Tokens/天）`
      : '本期暂无消耗，色阶留空',
  };
}

/**
 * 突增侦测——确定性稳健统计，不调用生成式 AI：
 * - 以中位数（MAD 估计的稳健离散度）为基线，避免单个尖峰把自己的均值抬高后漏报；
 * - 阈值 = 中位数 + max(3×1.4826×MAD, 1.5×中位数)；
 * - 超过半数时段为零（中位数=0）时没有稳定基线，明确说「不评估」而不是谎报平稳；
 * - 只有完整 `YYYY-MM-DD` 日桶可下钻明细，小时/月桶不提供假链接。
 */
export function detectSpikes(trends: TrendPoint[], context: InsightTimeContext): Detection | null {
  if (context.range === 'year') return null;
  const observed = trends
    .map((point) => ({
      point,
      state: bucketObservationState(typeof point.date === 'string' ? point.date : '', context),
    }))
    .filter((item): item is { point: TrendPoint; state: 'complete' | 'in-progress' } => (
      item.state === 'complete' || item.state === 'in-progress'
    ));
  const baseline = observed.filter((item) => item.state === 'complete');
  if (baseline.length < 5) return null;

  const values = baseline.map(({ point }) => trendBucketTokens(point));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    const observedTotal = observed.reduce((sum, { point }) => sum + trendBucketTokens(point), 0);
    return {
      state: observedTotal > 0 ? 'sparse' : 'empty',
      spikes: [],
      bucketCount: baseline.length,
      median: 0,
      thresholdRatio: 0,
    };
  }

  const base = median(values);
  if (base <= 0) {
    return { state: 'sparse', spikes: [], bucketCount: baseline.length, median: 0, thresholdRatio: 0 };
  }

  const mad = median(values.map((value) => Math.abs(value - base)));
  const robustStd = 1.4826 * mad;
  const threshold = base + Math.max(robustStd * 3, base * 1.5);

  const spikes: Spike[] = observed
    .map(({ point, state }) => {
      const date = String(point.date);
      const value = trendBucketTokens(point);
      return {
        date,
        label: `${date}${state === 'in-progress' ? '（进行中）' : ''}`,
        value,
        ratio: Math.round((value / base) * 10) / 10,
        drillable: isDrillableDateBucket(date),
        inProgress: state === 'in-progress',
      };
    })
    .filter((spike) => spike.value > threshold)
    .sort((left, right) => right.value - left.value);

  return {
    state: spikes.length > 0 ? 'flagged' : 'calm',
    spikes,
    bucketCount: baseline.length,
    median: base,
    thresholdRatio: Math.round((threshold / base) * 10) / 10,
  };
}
