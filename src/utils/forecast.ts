/**
 * 周期末预测的纯规则层（T10.153，用户决定 D2）。无 React 依赖，看板趋势卡与后续
 * Android 移植共用同一套判定；规格与取舍见 docs/design/forecast-and-pace-v1.md。
 *
 * 术语（T10.154）：「预估」只指按价格表估算的费用，外推结果一律叫「预测」。
 *
 * 诚实边界：
 * - “今天”取 `meta.generatedAt` 在来源时区的日期，不取同期对比的截止点：月末几天后端把本期
 *   对比窗口截到上月的天数（例如 3 月 29–31 日截到 28 日），序列不含真实的今天。此时整体
 *   不预测（`comparison-clipped`），绝不把截短的日子当成今天。
 * - 速率只来自已完成的日桶。进行中的今天不参与速率，只作为“今天最终值不低于已记录量”
 *   的下限，因此预测永远不低于本期已经记录的量。
 * - 点预测 = 已完成日合计 + 典型日 × 剩余天数（含今天），典型日取基线完整日的算术平均：
 *   预测的是总量，平均数才是日总量的无偏估计，中位数在右偏分布下会系统性低估。
 * - 范围是粗略范围，不是经过校准的概率区间。宽度 = t(0.9, n−1) × 日波动 × √(m + m²/n)
 *   （各天独立、日均不变时名义上约 80%）；日波动不低于日均的一半（经验值），再按相邻两天的
 *   相关程度放宽，并同时覆盖按最近 7 天日均外推的结果。按审计的 7 种日用量模型模拟过覆盖率
 *   （规格 §2.4）：用量成片升降时仍可能偏低，用量持续上升时明显偏低，因此只写“粗略范围”。
 * - 剩余天数里有、基线里却没有的日子类型（本周的周四至周六还没有周末）无从外推：下限按
 *   这些天不用计算，上限仍按日均。
 * - 未知值从不按 0：已完成日中有未知费用时费用预测不可得；今天费用未知时标 partial。
 * - 结果带 `kind: 'forecast'` 品牌，只供看板展示；不得进入同步、海报、简报与导出。
 */
import type { DataScope, RangeKey, StatsData } from '../types';
import { isoCalendarDayValue } from './contracts/statsQuery';
import { deriveInsightTimeContext } from './insightRules';

export type ForecastPeriodKind = 'month' | 'week' | 'custom';
export type ForecastMetricKey = 'tokens' | 'cost';

/** 一天的观测。`null` 表示未知，绝不等同于 0。 */
export interface ForecastDay {
  /** 来源时区的公历日期 `YYYY-MM-DD`，与 Stats v2 日桶键相同。 */
  date: string;
  /** 有效 Token（输入 + 输出）；缓存不计入。 */
  tokens: number | null;
  /** 按价格表估算的美元金额。 */
  cost: number | null;
}

export interface ForecastPeriodInput {
  kind: ForecastPeriodKind;
  timeZone: string;
  /** 周期首日（含）。 */
  periodStart: string;
  /** 周期末日（含）。 */
  periodEnd: string;
  /** 数据截止点所在的来源时区日期，即“今天”。 */
  cutoffDate: string;
  /** 截止日本身是否已完整（只有已结束的自定义区间为 true）。 */
  cutoffDayComplete: boolean;
  /** 从 periodStart 到 cutoffDate 的稠密日序列，每天恰好一项。 */
  days: readonly ForecastDay[];
  /** 来源无法证明逐日费用时整体标注，费用预测直接不可得。 */
  costUnavailableReason?: 'cost-provenance-unavailable';
}

export type ForecastStatus = 'ok' | 'insufficient' | 'unavailable' | 'unsupported' | 'complete';

export type ForecastReason =
  | 'range-unsupported'
  | 'bucket-unsupported'
  | 'comparison-missing'
  /** 月末几天后端把本期对比窗口截到上月的天数，序列不含真实的今天。 */
  | 'comparison-clipped'
  | 'time-context-unavailable'
  | 'series-misaligned'
  | 'source-incomplete'
  | 'too-few-completed-days'
  | 'horizon-too-long';

export type MetricForecastStatus = 'ok' | 'partial' | 'insufficient' | 'unavailable';

export type MetricForecastReason =
  | 'too-few-active-days'
  | 'unknown-values'
  | 'cost-provenance-unavailable'
  | 'in-progress-unknown';

export interface ForecastTrajectoryPoint {
  /** 该日结束时的累计预测。 */
  date: string;
  point: number;
  low: number;
  high: number;
}

export interface ForecastRecentShift {
  direction: 'rising' | 'falling';
  /** 最近 7 个完整日的日均 ÷ 再往前 7 个完整日的日均；后者为 0 时为 null。 */
  ratio: number | null;
}

export interface MetricForecast {
  metric: ForecastMetricKey;
  status: MetricForecastStatus;
  reason: MetricForecastReason | null;
  /** 本期已完成日的合计；有未知日时为 null。 */
  completedTotal: number | null;
  /** 进行中的今天已记录的量；没有进行中日或未知时为 null。 */
  inProgress: number | null;
  /** 典型日：基线已完成日的算术平均。 */
  typicalDaily: number | null;
  /** 周期总量点预测。 */
  projected: number | null;
  /** 粗略范围的下限与上限；不是概率区间，见 `ForecastMethod.calibrated`。 */
  low: number | null;
  high: number | null;
  /** 从今天到周期末的累计预测轨迹，供累计图画扇形。 */
  trajectory: ForecastTrajectoryPoint[];
  /** 基线中大于 0 的天数。 */
  activeDays: number;
  /** 已完成日中值未知的天数。 */
  unknownDays: number;
  /** 基线中单日最大值占基线合计的比例。 */
  peakShare: number | null;
  /** 去掉基线中最高的一天后，典型日会下降的比例；用于判断单日高峰的影响。 */
  peakInfluence: number | null;
  /** 最近 7 个完整日的日均；基线不超过 7 天时为 null（此时与典型日相同）。 */
  recentDaily: number | null;
  /** 最近 7 天日均相对再往前 7 天明显变化（≥1.5 倍或 ≤1/1.5）时给出；基线少于 14 天时为 null。 */
  recentShift: ForecastRecentShift | null;
  /** 放宽范围所用的相邻两天相关系数（小样本偏差校正后截到 [0, 0.8]）。 */
  autocorrelation: number | null;
  /** 基线与剩余天数的周末占比明显不同，且工作日与周末用量不同或无从比较：预测未区分两者。 */
  weekdayMixRisk: boolean;
  /**
   * 剩余天数里有、基线里却没有的日子类型（例如周四时本周还没有周末）。这些天无从外推：
   * 下限按不用计算，上限仍按日均；没有时为 null。
   */
  unseenDayType: 'weekend' | 'weekday' | null;
}

export interface ForecastMethod {
  kind: 'linear-mean';
  /**
   * 宽度刻度的名义水平：只有各天互不相关、日均不变时才等于覆盖概率。
   * 没有用真实账本校准，界面不得把它显示成百分比或“把握”。
   */
  nominalLevel: number;
  calibrated: false;
  cvFloor: number;
  autocorrelationMax: number;
  recentDays: number;
  minActiveDays: number;
  baselineMaxDays: number;
  maxHorizonRatio: number;
}

export interface PeriodForecast {
  /** 品牌：预测只供看板展示，不进入同步、海报、简报与导出。 */
  kind: 'forecast';
  status: ForecastStatus;
  reason: ForecastReason | null;
  period: {
    kind: ForecastPeriodKind;
    start: string;
    end: string;
    days: number;
    timeZone: string;
  } | null;
  cutoffDate: string | null;
  /** 本期已完成的天数。 */
  completedDays: number;
  /** 参与速率估计的已完成天数（最近的至多 baselineMaxDays 天）。 */
  baselineDays: number;
  /** 仍需预测的天数，含进行中的今天。 */
  remainingDays: number;
  requiredCompletedDays: number;
  /**
   * 最早能给出预测的“今天”：ok 时就是截止日；insufficient 时是之后的日期（同时满足完整日与
   * 外推距离两道门槛）；周期内等不到时为 null。其它状态为 null。
   */
  availableFrom: string | null;
  method: ForecastMethod;
  tokens: MetricForecast | null;
  cost: MetricForecast | null;
}

export interface ForecastOptions {
  minCompletedDays?: number;
}

/** 宽度刻度：t 分布 0.9 分位（双侧名义 80%）。不是经过校准的覆盖率。 */
export const FORECAST_NOMINAL_LEVEL = 0.8;
/** 月与自定义至少一整周：任意连续 7 天恰好覆盖每个星期几一次；周最多只有 6 个完整日。 */
export const FORECAST_MIN_COMPLETED_DAYS: Readonly<Record<ForecastPeriodKind, number>> = {
  month: 7,
  week: 3,
  custom: 7,
};
/** 至少两天有消耗，单日活动无法确立速率。 */
export const FORECAST_MIN_ACTIVE_DAYS = 2;
/** 日波动下限（经验值）：样本标准差低于日均的一半时按一半计。 */
export const FORECAST_CV_FLOOR = 0.5;
/** 相邻两天相关系数的上限：放宽倍数 (1 + r)/(1 − r) 最多 9 倍方差，即 3 倍宽度。 */
export const FORECAST_AUTOCORRELATION_MAX = 0.8;
/** 近期日均的窗口：7 天恰好覆盖每个星期几一次，不受工作日与周末比例影响。 */
export const FORECAST_RECENT_DAYS = 7;
/** 最近 7 天日均相对此前变化到这个倍数（或其倒数）时附注。 */
export const FORECAST_RECENT_SHIFT_RATIO = 1.5;
/** 去掉最高一天后典型日至少下降这个比例时，附注单日高峰的影响。 */
export const FORECAST_PEAK_INFLUENCE = 0.25;
/** 速率只看最近 31 个已完成日，长自定义区间不被早期旧习惯拖住。 */
export const FORECAST_BASELINE_MAX_DAYS = 31;
/** 剩余天数不超过基线天数的 4 倍，不做远距离外推。 */
export const FORECAST_MAX_HORIZON_RATIO = 4;

/** 周末占比至少相差这么多，才可能因工作日与周末混合比例不同而偏差。 */
const WEEKDAY_MIX_SHARE_GAP = 0.1;
/** 工作日与周末日均相差这个倍数以上，视为有明显的工作日效应。 */
const WEEKDAY_EFFECT_RATIO = 1.5;
/** 相关系数的偏差校正至少需要这么多天；更少时不放宽。 */
const AUTOCORRELATION_MIN_DAYS = 5;

const DAY_MS = 86_400_000;

const FORECAST_METHOD: ForecastMethod = {
  kind: 'linear-mean',
  nominalLevel: FORECAST_NOMINAL_LEVEL,
  calibrated: false,
  cvFloor: FORECAST_CV_FLOOR,
  autocorrelationMax: FORECAST_AUTOCORRELATION_MAX,
  recentDays: FORECAST_RECENT_DAYS,
  minActiveDays: FORECAST_MIN_ACTIVE_DAYS,
  baselineMaxDays: FORECAST_BASELINE_MAX_DAYS,
  maxHorizonRatio: FORECAST_MAX_HORIZON_RATIO,
};

/** Student t 的 0.9 分位（双侧 80%）。表内取不大于 df 的最近一档，偏保守。 */
const T_QUANTILE_90: ReadonlyArray<readonly [number, number]> = [
  [1, 3.0777], [2, 1.8856], [3, 1.6377], [4, 1.5332], [5, 1.4759], [6, 1.4398],
  [7, 1.4149], [8, 1.3968], [9, 1.383], [10, 1.3722], [11, 1.3634], [12, 1.3562],
  [13, 1.3502], [14, 1.345], [15, 1.3406], [16, 1.3368], [17, 1.3334], [18, 1.3304],
  [19, 1.3277], [20, 1.3253], [21, 1.3232], [22, 1.3212], [23, 1.3195], [24, 1.3178],
  [25, 1.3163], [26, 1.315], [27, 1.3137], [28, 1.3125], [29, 1.3114], [30, 1.3104],
  [40, 1.3031], [60, 1.2958], [120, 1.2886],
];

export function tQuantile90(df: number): number {
  if (!Number.isFinite(df) || df < 1) return Number.NaN;
  let value = T_QUANTILE_90[0][1];
  for (const [tableDf, quantile] of T_QUANTILE_90) {
    if (tableDf > df) break;
    value = quantile;
  }
  return value;
}

function civilDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function addCivilDays(date: string, days: number): string | null {
  const value = isoCalendarDayValue(date);
  return value === null ? null : civilDate(value + days * DAY_MS);
}

/** 两个公历日期之间相差的天数；按 UTC 公历计算，与宿主时区和夏令时无关。 */
export function civilDaysBetween(from: string, to: string): number | null {
  const start = isoCalendarDayValue(from);
  const end = isoCalendarDayValue(to);
  if (start === null || end === null) return null;
  return Math.round((end - start) / DAY_MS);
}

export function monthBounds(date: string): { start: string; end: string } | null {
  const value = isoCalendarDayValue(date);
  if (value === null) return null;
  const probe = new Date(value);
  const year = probe.getUTCFullYear();
  const month = probe.getUTCMonth();
  return {
    start: civilDate(Date.UTC(year, month, 1)),
    end: civilDate(Date.UTC(year, month + 1, 0)),
  };
}

/** 周一开始的自然周（DESIGN §3）。 */
export function weekBounds(date: string): { start: string; end: string } | null {
  const value = isoCalendarDayValue(date);
  if (value === null) return null;
  const offset = (new Date(value).getUTCDay() + 6) % 7;
  const start = civilDate(value - offset * DAY_MS);
  return { start, end: civilDate(value + (6 - offset) * DAY_MS) };
}

function isWeekend(date: string): boolean {
  const value = isoCalendarDayValue(date);
  if (value === null) return false;
  const weekday = new Date(value).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 相邻两天用量的相关系数，按 AR(1) 的小样本偏差校正（E[r] ≈ ρ − (1 + 3ρ)/n，即
 * ρ ≈ (n·r + 1)/(n − 3)），截到 [0, 0.8]。少于 5 天、或各天完全相同时为 0（不放宽）。
 * 负相关不收窄范围：宁可偏宽。
 */
export function lag1Autocorrelation(values: readonly number[]): number {
  const n = values.length;
  if (n < AUTOCORRELATION_MIN_DAYS) return 0;
  const average = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const deviation = values[index] - average;
    denominator += deviation * deviation;
    if (index > 0) numerator += deviation * (values[index - 1] - average);
  }
  if (!(denominator > 0)) return 0;
  const corrected = (n * (numerator / denominator) + 1) / (n - 3);
  return Math.min(FORECAST_AUTOCORRELATION_MAX, Math.max(0, corrected));
}

function knownNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function emptyForecast(
  status: ForecastStatus,
  reason: ForecastReason | null,
  partial: Partial<PeriodForecast> = {},
): PeriodForecast {
  return {
    kind: 'forecast',
    status,
    reason,
    period: null,
    cutoffDate: null,
    completedDays: 0,
    baselineDays: 0,
    remainingDays: 0,
    requiredCompletedDays: 0,
    availableFrom: null,
    method: FORECAST_METHOD,
    tokens: null,
    cost: null,
    ...partial,
  };
}

function unavailableMetric(
  metric: ForecastMetricKey,
  status: 'insufficient' | 'unavailable',
  reason: MetricForecastReason,
  counts: { activeDays?: number; unknownDays?: number } = {},
): MetricForecast {
  return {
    metric,
    status,
    reason,
    completedTotal: null,
    inProgress: null,
    typicalDaily: null,
    projected: null,
    low: null,
    high: null,
    trajectory: [],
    activeDays: counts.activeDays ?? 0,
    unknownDays: counts.unknownDays ?? 0,
    peakShare: null,
    peakInfluence: null,
    recentDaily: null,
    recentShift: null,
    autocorrelation: null,
    weekdayMixRisk: false,
    unseenDayType: null,
  };
}

interface MetricContext {
  completed: readonly ForecastDay[];
  baseline: readonly ForecastDay[];
  inProgressDay: ForecastDay | null;
  /** 轨迹第一天：有进行中日时是今天，否则是明天。 */
  firstForecastDate: string;
  remainingDays: number;
  /** 剩余天数（含今天）中周末的占比。 */
  remainingWeekendShare: number;
  costUnavailableReason?: 'cost-provenance-unavailable';
}

/** 最近 7 天与再往前 7 天比较：两段都恰好含每个星期几一次，不受工作日与周末比例影响。 */
function recentShiftOf(values: readonly number[]): ForecastRecentShift | null {
  if (values.length < 2 * FORECAST_RECENT_DAYS) return null;
  const recent = mean(values.slice(-FORECAST_RECENT_DAYS));
  const earlier = mean(values.slice(-2 * FORECAST_RECENT_DAYS, -FORECAST_RECENT_DAYS));
  if (earlier <= 0) return recent > 0 ? { direction: 'rising', ratio: null } : null;
  const ratio = recent / earlier;
  if (ratio >= FORECAST_RECENT_SHIFT_RATIO) return { direction: 'rising', ratio };
  if (ratio <= 1 / FORECAST_RECENT_SHIFT_RATIO) return { direction: 'falling', ratio };
  return null;
}

function weekdayMixRiskOf(baseline: readonly ForecastDay[], values: readonly number[], remainingWeekendShare: number): boolean {
  const weekend = baseline.map((day) => isWeekend(day.date));
  const weekendShare = weekend.filter(Boolean).length / baseline.length;
  if (Math.abs(weekendShare - remainingWeekendShare) < WEEKDAY_MIX_SHARE_GAP) return false;
  const weekendValues = values.filter((_, index) => weekend[index]);
  const weekdayValues = values.filter((_, index) => !weekend[index]);
  // 基线只有一类日子时无从比较，混合比例又明显不同：按有风险处理。
  if (weekendValues.length === 0 || weekdayValues.length === 0) return true;
  const weekendMean = mean(weekendValues);
  const weekdayMean = mean(weekdayValues);
  const low = Math.min(weekendMean, weekdayMean);
  const high = Math.max(weekendMean, weekdayMean);
  if (high <= 0) return false;
  return low <= 0 || high / low >= WEEKDAY_EFFECT_RATIO;
}

function forecastMetric(metric: ForecastMetricKey, context: MetricContext): MetricForecast {
  const { completed, baseline, inProgressDay, remainingDays } = context;
  if (metric === 'cost' && context.costUnavailableReason) {
    return unavailableMetric(metric, 'unavailable', context.costUnavailableReason, {
      unknownDays: completed.length,
    });
  }
  const completedValues = completed.map((day) => knownNonNegative(day[metric]));
  const unknownDays = completedValues.filter((value) => value === null).length;
  if (unknownDays > 0) {
    return unavailableMetric(metric, 'unavailable', 'unknown-values', { unknownDays });
  }
  const baseValues = baseline.map((day) => knownNonNegative(day[metric]) as number);
  const activeDays = baseValues.filter((value) => value > 0).length;
  if (activeDays < FORECAST_MIN_ACTIVE_DAYS) {
    return unavailableMetric(metric, 'insufficient', 'too-few-active-days', { activeDays });
  }

  const completedTotal = (completedValues as number[]).reduce((sum, value) => sum + value, 0);
  const n = baseValues.length;
  const baseSum = baseValues.reduce((sum, value) => sum + value, 0);
  const average = baseSum / n;
  const variance = baseValues.reduce((sum, value) => sum + (value - average) ** 2, 0) / (n - 1);
  const dispersion = Math.max(Math.sqrt(variance), FORECAST_CV_FLOOR * average);
  const t = tQuantile90(n - 1);
  // 用量常成片高低：相邻两天正相关时，和的方差按 (1 + r)/(1 − r) 放大。
  const autocorrelation = lag1Autocorrelation(baseValues);
  const inflation = Math.sqrt((1 + autocorrelation) / (1 - autocorrelation));
  // 最近 7 天的日均作为第二种线性外推，范围同时覆盖两者。
  const recentDaily = n > FORECAST_RECENT_DAYS ? mean(baseValues.slice(-FORECAST_RECENT_DAYS)) : null;

  const inProgressValue = inProgressDay ? knownNonNegative(inProgressDay[metric]) : null;
  const inProgressUnknown = inProgressDay !== null && inProgressValue === null;
  // 今天最终值不低于已记录量；今天未知时不设下限，也不把未知当 0 记入已记录。
  const floor = inProgressValue ?? 0;
  // 下限按两种日均中较低的一种、上限按较高的一种外推（整体日均与最近 7 天日均）。
  const lowDaily = recentDaily === null ? average : Math.min(average, recentDaily);
  const highDaily = recentDaily === null ? average : Math.max(average, recentDaily);
  // 基线里没有的日子类型（例如周四时本周还没有周末）无从外推：下限按这些天不用计算。
  const baselineHasWeekend = baseline.some((day) => isWeekend(day.date));
  const baselineHasWeekday = baseline.some((day) => !isWeekend(day.date));
  let unseenDayType: 'weekend' | 'weekday' | null = null;

  const trajectory: ForecastTrajectoryPoint[] = [];
  let runningLow = completedTotal + floor;
  // 三条线逐日累加（今天取已记录量与日均的较大者），浮点下也保持 下限 ≤ 点预测 ≤ 上限。
  let pointCenter = 0;
  let lowCenter = 0;
  let highCenter = 0;
  for (let step = 1; step <= remainingDays; step += 1) {
    const date = addCivilDays(context.firstForecastDate, step - 1) as string;
    const weekend = isWeekend(date);
    const unseen = weekend ? !baselineHasWeekend : !baselineHasWeekday;
    if (unseen) unseenDayType = weekend ? 'weekend' : 'weekday';
    const lowDay = unseen ? 0 : lowDaily;
    const isToday = step === 1 && inProgressDay !== null;
    pointCenter += isToday ? Math.max(floor, average) : average;
    lowCenter += isToday ? Math.max(floor, lowDay) : lowDay;
    highCenter += isToday ? Math.max(floor, highDaily) : highDaily;
    const halfWidth = t * dispersion * inflation * Math.sqrt(step + (step * step) / n);
    // 累计量只增不减：下限取运行最大值，且不低于已记录量。
    runningLow = Math.max(runningLow, completedTotal + Math.max(floor, lowCenter - halfWidth));
    trajectory.push({
      date,
      point: completedTotal + pointCenter,
      low: runningLow,
      high: completedTotal + highCenter + halfWidth,
    });
  }
  const last = trajectory[trajectory.length - 1];
  const round = metric === 'tokens' ? Math.round : (value: number) => value;
  const peak = Math.max(...baseValues);

  return {
    metric,
    status: inProgressUnknown ? 'partial' : 'ok',
    reason: inProgressUnknown ? 'in-progress-unknown' : null,
    completedTotal: round(completedTotal),
    inProgress: inProgressValue === null ? null : round(inProgressValue),
    typicalDaily: round(average),
    projected: round(last.point),
    low: round(last.low),
    high: round(last.high),
    trajectory: trajectory.map((point) => ({
      date: point.date,
      point: round(point.point),
      low: round(point.low),
      high: round(point.high),
    })),
    activeDays,
    unknownDays: 0,
    peakShare: baseSum > 0 ? peak / baseSum : null,
    peakInfluence: baseSum > 0 ? (peak - average) / ((n - 1) * average) : null,
    recentDaily: recentDaily === null ? null : round(recentDaily),
    recentShift: recentShiftOf(baseValues),
    autocorrelation,
    weekdayMixRisk: unseenDayType !== null || weekdayMixRiskOf(baseline, baseValues, context.remainingWeekendShare),
    unseenDayType,
  };
}

/** 从今天起还要等几天才同时满足完整日与外推距离两道门槛；周期内等不到时为 null。 */
function daysUntilForecastable(completed: number, remaining: number, required: number): number | null {
  for (let wait = 0; wait < remaining; wait += 1) {
    const done = completed + wait;
    const left = remaining - wait;
    if (done >= required && left <= FORECAST_MAX_HORIZON_RATIO * Math.min(done, FORECAST_BASELINE_MAX_DAYS)) {
      return wait;
    }
  }
  return null;
}

/**
 * 按已完成日桶把本期外推到周期末。输入必须是 periodStart..cutoffDate 的稠密日序列；
 * 缺日、乱序或越界一律判为 `series-misaligned`，不猜补 0。
 */
export function forecastPeriod(input: ForecastPeriodInput, options: ForecastOptions = {}): PeriodForecast {
  const span = civilDaysBetween(input.periodStart, input.periodEnd);
  const elapsed = civilDaysBetween(input.periodStart, input.cutoffDate);
  if (span === null || elapsed === null || span < 0 || elapsed < 0 || elapsed > span) {
    return emptyForecast('unavailable', 'series-misaligned');
  }
  if (input.days.length !== elapsed + 1
    || input.days.some((day, index) => day.date !== addCivilDays(input.periodStart, index))) {
    return emptyForecast('unavailable', 'series-misaligned');
  }

  const period = {
    kind: input.kind,
    start: input.periodStart,
    end: input.periodEnd,
    days: span + 1,
    timeZone: input.timeZone,
  };
  const inProgressDay = input.cutoffDayComplete ? null : input.days[input.days.length - 1];
  const completed = input.cutoffDayComplete ? input.days : input.days.slice(0, -1);
  const futureDays = span - elapsed;
  const remainingDays = (inProgressDay ? 1 : 0) + futureDays;
  // 非有限的覆盖值不能让门槛变成 NaN 而被绕过；至少两天才有样本方差。
  const requested = options.minCompletedDays;
  const requiredCompletedDays = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.max(2, Math.floor(requested))
    : FORECAST_MIN_COMPLETED_DAYS[input.kind];
  const baseline = completed.slice(-FORECAST_BASELINE_MAX_DAYS);
  const shared = {
    period,
    cutoffDate: input.cutoffDate,
    completedDays: completed.length,
    baselineDays: baseline.length,
    remainingDays,
    requiredCompletedDays,
  };

  if (remainingDays === 0) return emptyForecast('complete', null, shared);
  const wait = daysUntilForecastable(completed.length, remainingDays, requiredCompletedDays);
  const availableFrom = wait === null ? null : addCivilDays(input.cutoffDate, wait);
  if (completed.length < requiredCompletedDays) {
    return emptyForecast('insufficient', 'too-few-completed-days', { ...shared, availableFrom });
  }
  if (remainingDays > FORECAST_MAX_HORIZON_RATIO * baseline.length) {
    return emptyForecast('insufficient', 'horizon-too-long', { ...shared, availableFrom });
  }

  const firstForecastDate = inProgressDay ? input.cutoffDate : addCivilDays(input.cutoffDate, 1) as string;
  let remainingWeekends = 0;
  for (let offset = 0; offset < remainingDays; offset += 1) {
    if (isWeekend(addCivilDays(firstForecastDate, offset) as string)) remainingWeekends += 1;
  }
  const context: MetricContext = {
    completed,
    baseline,
    inProgressDay,
    firstForecastDate,
    remainingDays,
    remainingWeekendShare: remainingWeekends / remainingDays,
    costUnavailableReason: input.costUnavailableReason,
  };
  return {
    ...emptyForecast('ok', null, { ...shared, availableFrom: input.cutoffDate }),
    tokens: forecastMetric('tokens', context),
    cost: forecastMetric('cost', context),
  };
}

export type ForecastInputResult =
  | { ok: true; input: ForecastPeriodInput }
  | { ok: false; status: 'unsupported' | 'unavailable'; reason: ForecastReason };

/**
 * 数据作用域与来源完整性。本机日序列费用逐行已估算；云端日序列把未知费用合成了 0，只能信
 * dailyCosts。云端调用必须明确给出 `sourceIncomplete`（本机仍有待上传记录时为 true），漏传
 * 直接编译失败，避免把少算的云端数据外推成偏低的预测。
 */
export type ForecastSourceOptions =
  | { scope: 'local'; sourceIncomplete?: boolean }
  | { scope: 'cloud'; sourceIncomplete: boolean };

function dayCostsFromDailyCosts(
  stats: StatsData,
  periodStart: string,
  cutoffDate: string,
  timeZone: string,
): Map<string, number | null> | null {
  const dailyCosts = stats.dailyCosts;
  if (!dailyCosts
    || dailyCosts.coverage.state !== 'complete'
    || dailyCosts.coverage.timezone !== timeZone
    || dailyCosts.coverage.start !== periodStart
    || dailyCosts.coverage.end !== cutoffDate) {
    return null;
  }
  const costs = new Map<string, number | null>();
  for (const day of dailyCosts.days) {
    costs.set(day.date, day.status === 'recorded-estimate' ? knownNonNegative(day.amountUsd) : null);
  }
  return costs;
}

function periodBoundsOf(
  stats: StatsData,
  range: ForecastPeriodKind,
  today: string,
): { start: string; end: string } | null {
  if (range === 'month') return monthBounds(today);
  if (range === 'week') return weekBounds(today);
  const start = stats.meta?.query?.start;
  const end = stats.meta?.query?.end;
  return typeof start === 'string' && typeof end === 'string'
    && isoCalendarDayValue(start) !== null && isoCalendarDayValue(end) !== null
    ? { start, end }
    : null;
}

/**
 * 从 Stats v2 响应构造预测输入：只用契约已有的日桶键与生成时刻。
 * - “今天”取 `meta.generatedAt` 在来源时区的日期；三处时区不一致即不可用；
 * - 日序列取 `comparison.current.series`，必须恰好覆盖周期首日到今天（自定义取末日与今天的较早者）；
 *   序列停在今天之前、且同期对比的截止点也在今天之前（月末截短）时返回 `comparison-clipped`；
 * - 本机费用取日序列（每行已按价格表估算）；云端费用只信 `dailyCosts`，缺失即不可得。
 */
export function forecastInputFromStats(
  stats: StatsData,
  range: RangeKey,
  options: ForecastSourceOptions,
): ForecastInputResult {
  if (range !== 'month' && range !== 'week' && range !== 'custom') {
    return { ok: false, status: 'unsupported', reason: 'range-unsupported' };
  }
  // 云端来源是否完整必须明确给出：绕过类型检查漏传时按不完整处理，不当作完整。
  if (options.sourceIncomplete === true
    || (options.scope === 'cloud' && typeof options.sourceIncomplete !== 'boolean')) {
    return { ok: false, status: 'unavailable', reason: 'source-incomplete' };
  }
  const comparison = stats.comparison;
  if (!comparison) return { ok: false, status: 'unavailable', reason: 'comparison-missing' };
  if (comparison.window.bucket !== 'day') {
    return { ok: false, status: 'unsupported', reason: 'bucket-unsupported' };
  }
  const scope: DataScope = options.scope;
  // 完整调用校验 meta、查询与对比三处时区；只带 meta 的调用只按生成时刻求“今天”。
  const context = deriveInsightTimeContext(stats, range, scope);
  const generated = deriveInsightTimeContext({ meta: stats.meta }, range, scope);
  if (!context || !generated) return { ok: false, status: 'unavailable', reason: 'time-context-unavailable' };
  const today = generated.cutoffDate;
  const bounds = periodBoundsOf(stats, range, today);
  if (!bounds) return { ok: false, status: 'unavailable', reason: 'series-misaligned' };
  // 自定义闭区间可在生成当天的23:59:59结束；沿用同一截止点判定，
  // 避免趋势已认末日完整、预测却仍丢掉末日并外推。中间日不能冒充区间末日。
  const cutoffDayComplete = today > bounds.end
    || (context.closedCustomEnd === true && context.cutoffDate === bounds.end);
  const cutoffDate = cutoffDayComplete ? bounds.end : today;
  const expectedLength = civilDaysBetween(bounds.start, cutoffDate);
  if (expectedLength === null || expectedLength < 0) {
    return { ok: false, status: 'unavailable', reason: 'series-misaligned' };
  }

  const series = comparison.current.series;
  const denseFromStart = series.every((point, index) => point.bucket === addCivilDays(bounds.start, index));
  if (!denseFromStart || series.length > expectedLength + 1) {
    return { ok: false, status: 'unavailable', reason: 'series-misaligned' };
  }
  if (series.length < expectedLength + 1) {
    // 月末几天：后端按上月天数对齐同期，本期序列和截止点都停在今天之前。
    const clipped = context.cutoffDate < cutoffDate && series.length > 0
      && series[series.length - 1].bucket === context.cutoffDate;
    return { ok: false, status: 'unavailable', reason: clipped ? 'comparison-clipped' : 'series-misaligned' };
  }

  const cloudCosts = scope === 'cloud'
    ? dayCostsFromDailyCosts(stats, bounds.start, cutoffDate, context.timeZone)
    : null;
  const costProvenanceMissing = scope === 'cloud' && cloudCosts === null;
  const days: ForecastDay[] = series.map((point) => {
    let cost: number | null;
    if (scope === 'local') {
      cost = knownNonNegative(point.cost);
    } else if (!cloudCosts) {
      cost = null;
    } else if (cloudCosts.has(point.bucket)) {
      cost = cloudCosts.get(point.bucket) ?? null;
    } else {
      // dailyCosts 只列有效 Token > 0 的活跃日：当天没有任何记录才是真实的 $0，
      // 有记录（例如只有缓存）却没有金额行时保持未知。
      cost = point.requests === 0 && point.tokens === 0 ? 0 : null;
    }
    return { date: point.bucket, tokens: knownNonNegative(point.tokens), cost };
  });

  return {
    ok: true,
    input: {
      kind: range,
      timeZone: context.timeZone,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      cutoffDate,
      cutoffDayComplete,
      days,
      ...(costProvenanceMissing ? { costUnavailableReason: 'cost-provenance-unavailable' as const } : {}),
    },
  };
}

/** 适配 + 预测一步完成；结构性问题直接落在 `status/reason`，不抛异常。 */
export function forecastFromStats(
  stats: StatsData,
  range: RangeKey,
  options: ForecastSourceOptions & ForecastOptions,
): PeriodForecast {
  const result = forecastInputFromStats(stats, range, options);
  if (!result.ok) return emptyForecast(result.status, result.reason);
  return forecastPeriod(result.input, options);
}

// ---------------------------------------------------------------------------
// 文案：标签、方法与范围必须同时出现（D2），因此由规则层一次性给出。

export interface ForecastCopy {
  tag: '预测';
  title: string;
  /** 被预测的量：有效 Token（输入 + 输出，不含缓存）或预估费用。 */
  metricLabel: '有效 Token' | '预估费用';
  /** 点预测；数据不足或不可得时为 null。Token 值自带“有效 Token”。 */
  value: string | null;
  /** 粗略范围；与 value 同时存在。 */
  interval: string | null;
  /** 常驻可见的方法与前提，或不预测的原因。 */
  method: string;
  /** 详情（tooltip / 展开区）里的完整说明。 */
  detail: string;
  caveats: string[];
  /** 读屏用的整句：以「预测：」开头，含数值、范围、方法与附注。 */
  ariaLabel: string;
}

interface ScaledUnit {
  divisor: number;
  suffix: string;
  decimals: number;
}

const TOKEN_UNITS: ReadonlyArray<ScaledUnit & { threshold: number }> = [
  { threshold: 999_500_000, divisor: 1_000_000_000, suffix: 'B', decimals: 1 },
  { threshold: 999_500, divisor: 1_000_000, suffix: 'M', decimals: 1 },
  { threshold: 999.5, divisor: 1_000, suffix: 'K', decimals: 0 },
];

interface FormattedTriple {
  point: string;
  low: string;
  high: string;
}

/**
 * 点值与上下限用同一单位、同一精度。单位按点值取（≥999,500 直接进位到 M，不写“1000K”）；
 * 上下限格式化后相同、或非零下限显示成 0 时多保留一位，最多两位小数。
 */
function formatTokenTriple(point: number, low: number, high: number): FormattedTriple {
  const unit: ScaledUnit = TOKEN_UNITS.find((candidate) => point >= candidate.threshold)
    ?? { divisor: 1, suffix: '', decimals: 0 };
  let decimals = unit.decimals;
  const format = (value: number) => `${(value / unit.divisor).toFixed(decimals)}${unit.suffix}`;
  const collapsed = () => format(low) === format(high)
    || (low > 0 && Number((low / unit.divisor).toFixed(decimals)) === 0);
  while (unit.divisor > 1 && decimals < 2 && collapsed()) decimals += 1;
  return { point: format(point), low: format(low), high: format(high) };
}

const USD_FORMATS = [0, 1, 2].map((digits) => new Intl.NumberFormat('en-US', {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}));

/** 先按一位小数舍入再判断量级：9.96 显示为 $10，而不是 $10.0。 */
function usdDecimals(value: number): number {
  return Math.round(value * 10) / 10 < 10 ? 1 : 0;
}

/** 预测金额不显示到分：≥$10 取整，<$10 保留一位小数。 */
export function formatForecastUsd(value: number): string {
  return `$${USD_FORMATS[usdDecimals(value)].format(value)}`;
}

/**
 * 点值与上下限同单位、同精度，与 `formatTokenTriple` 同一条规则（T10.153 复评 N-1，T10.186
 * 评审待定点 5 附带）：上下限格式化后相同、或有值显示成 0 时多保留一位，最多两位小数；三个值
 * 里任何一个两位小数仍是 0 的正数都改写「<$0.01」，不再显示成 $0.0（不把正数显示成 0）——
 * 点值与上限之前没有这层保护，会出现「<$0.01–$0.00」这种下限比上限还大的自相矛盾（T10.197
 * 评审 P3-1）。点值写成 `<$0.01` 时调用方不再加 `≈`（`describePeriodForecast` 与
 * `TrendPanel.formatForecastTriple` 共用这条规则，见下方导出）。
 */
export function formatUsdTriple(point: number, low: number, high: number): FormattedTriple {
  let decimals = usdDecimals(point);
  const format = (value: number) => `$${USD_FORMATS[decimals].format(value)}`;
  const shownAsZero = (value: number) => value > 0 && /^\$0(?:\.0+)?$/.test(format(value));
  const collapsed = () => format(low) === format(high) || shownAsZero(low) || shownAsZero(point);
  while (decimals < 2 && collapsed()) decimals += 1;
  const show = (value: number) => (shownAsZero(value) ? '<$0.01' : format(value));
  return { point: show(point), low: show(low), high: show(high) };
}

function monthDay(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${month}月${day}日`;
}

function forecastTitle(forecast: PeriodForecast): string {
  const period = forecast.period;
  if (!period) return '预测';
  if (period.kind === 'month') return '月末预测';
  if (period.kind === 'week') return '本周预测（至周日）';
  return `截至 ${monthDay(period.end)} 预测`;
}

function periodWord(kind: ForecastPeriodKind): string {
  if (kind === 'month') return '本月';
  if (kind === 'week') return '本周';
  return '本区间';
}

function baselineTruncated(forecast: PeriodForecast): boolean {
  return forecast.baselineDays < forecast.completedDays;
}

/** 基线的如实说法：基线即全部已完成日时写“已完成 N 天”，被 31 天上限截断时写“最近 N 个完整日”。 */
function baselinePhrase(forecast: PeriodForecast): string {
  return baselineTruncated(forecast)
    ? `最近 ${forecast.baselineDays} 个完整日`
    : `已完成 ${forecast.baselineDays} 天`;
}

function percent(value: number): number {
  return Math.round(value * 100);
}

function insufficientMethod(forecast: PeriodForecast): { method: string; detail: string } {
  const required = forecast.requiredCompletedDays;
  const from = forecast.availableFrom;
  if (from === null || forecast.cutoffDate === null) {
    return {
      method: `区间只有 ${forecast.period?.days ?? 0} 天，不足以预测（至少要 ${required} 个完整日）`,
      detail: '区间太短，完整日不足以确立日均。',
    };
  }
  const wait = civilDaysBetween(forecast.cutoffDate, from) ?? 0;
  const when = `${monthDay(from)} 起给出预测`;
  if (forecast.reason === 'horizon-too-long') {
    return {
      method: `距结束还有 ${forecast.remainingDays} 天，超过${baselinePhrase(forecast)}的 ${FORECAST_MAX_HORIZON_RATIO} 倍，${when}`,
      detail: '外推距离过远时误差会失控，等已完成的天数更多、离结束更近后再给出预测。',
    };
  }
  const missing = required - forecast.completedDays;
  return {
    method: wait === missing
      ? `还需 ${missing} 个完整日（至少 ${required} 天），${when}`
      : `还需 ${wait} 个完整日（距结束太远），${when}`,
    detail: '进行中的今天不计入；只有已经结束的日子才用来计算日均。',
  };
}

function ariaLabelOf(title: string, value: string | null, interval: string | null, method: string, caveats: string[]): string {
  const head = value === null
    ? `预测：${title}`
    : `预测：${title} ${value}${interval ? `，${interval}` : ''}`;
  return `${[head, method, ...caveats].join('。')}。`;
}

/**
 * 生成趋势卡上的预测文案。周期已结束、范围不支持或结构不可用（含月末截短）时返回 null
 * （界面不显示）；数据不足与费用未知时返回原因，界面仍需让用户知道为什么没有数字。
 */
export function describePeriodForecast(
  forecast: PeriodForecast,
  metric: ForecastMetricKey,
): ForecastCopy | null {
  if (forecast.status === 'unsupported' || forecast.status === 'complete' || forecast.status === 'unavailable') {
    return null;
  }
  const title = forecastTitle(forecast);
  const kind = forecast.period?.kind ?? 'month';
  const metricLabel = metric === 'tokens' ? '有效 Token' as const : '预估费用' as const;
  const withoutNumber = (method: string, detail: string): ForecastCopy => ({
    tag: '预测',
    title,
    metricLabel,
    value: null,
    interval: null,
    method,
    detail,
    caveats: [],
    ariaLabel: ariaLabelOf(title, null, null, method, []),
  });

  if (forecast.status === 'insufficient') {
    const { method, detail } = insufficientMethod(forecast);
    return withoutNumber(method, detail);
  }

  const result = metric === 'tokens' ? forecast.tokens : forecast.cost;
  if (!result) return null;
  if (result.status === 'insufficient') {
    const scope = baselineTruncated(forecast) ? `最近 ${forecast.baselineDays} 个完整日里` : '已完成的日子里';
    return withoutNumber(
      `${scope}有消耗的不足 ${FORECAST_MIN_ACTIVE_DAYS} 天，暂不预测`,
      '只有一天或没有消耗时无法确立速率。',
    );
  }
  if (result.status === 'unavailable') {
    const method = result.reason === 'cost-provenance-unavailable'
      ? '费用预测不可得：数据源未提供可验证的逐日费用'
      : metric === 'cost'
        ? `费用预测不可得：${periodWord(kind)}有 ${result.unknownDays} 天的费用未知`
        : `有效 Token 预测不可得：${periodWord(kind)}有 ${result.unknownDays} 天的数据未知`;
    return withoutNumber(method, '未知不按 0 计算，因此不给出可能偏低的预测。');
  }

  const caveats: string[] = [];
  if (result.status === 'partial') caveats.push('今天有费用未知的记录，今天按日均计入预测');
  if (kind === 'week' || result.weekdayMixRisk) caveats.push('未区分工作日与周末');
  const shift = result.recentShift;
  if (shift?.direction === 'rising') {
    caveats.push(shift.ratio === null
      ? '前 7 天没有消耗，最近 7 天有消耗；若持续，结果会高于预测'
      : `最近 7 天日均比前 7 天高 ${percent(shift.ratio - 1)}%；若持续，结果会高于预测`);
  } else if (shift?.direction === 'falling' && shift.ratio !== null) {
    caveats.push(`最近 7 天日均比前 7 天低 ${percent(1 - shift.ratio)}%；若持续，结果会低于预测`);
  }
  if (result.peakInfluence !== null && result.peakShare !== null && result.peakInfluence >= FORECAST_PEAK_INFLUENCE) {
    const basis = baselineTruncated(forecast) ? `最近 ${forecast.baselineDays} 个完整日合计` : '已完成合计';
    caveats.push(`单日最高占${basis}的 ${percent(result.peakShare)}%，去掉这一天日均会低 ${percent(result.peakInfluence)}%`);
  }

  const formatted = metric === 'tokens'
    ? formatTokenTriple(result.projected as number, result.low as number, result.high as number)
    : formatUsdTriple(result.projected as number, result.low as number, result.high as number);
  // 点值写成 <$0.01 时不再加 ≈（T10.197 评审 P3-1）：已经是「小于」的写法，≈ 会变成双重模糊。
  const value = metric === 'tokens'
    ? `${formatted.point} 有效 Token`
    : (formatted.point.startsWith('<') ? formatted.point : `≈${formatted.point}`);
  const interval = `粗略范围 ${formatted.low}–${formatted.high}`;
  const method = `按${baselinePhrase(forecast)}的日均外推；范围假设之后的用量与这些天相近`;
  const lines = [
    `典型日取${periodWord(kind)}${baselinePhrase(forecast)}的算术平均，乘以剩余 ${forecast.remainingDays} 天（含今天）。`,
    `范围是粗略范围，不是概率保证：按日波动与样本量计算，日波动不低于日均的一半（经验值），并按相邻两天的相关程度放宽${result.recentDaily === null ? '' : `，同时覆盖按最近 ${FORECAST_RECENT_DAYS} 天日均外推的结果`}。`,
    ...(result.unseenDayType === null
      ? []
      : [`已完成的日子里还没有${result.unseenDayType === 'weekend' ? '周末' : '工作日'}，范围下限按这些天不用计算。`]),
    '它假设之后的用量与已完成的日子相近；用量持续上升或下降时，实际可能超出范围。',
    '进行中的今天不参与日均计算，只保证预测不低于已记录的量。',
  ];
  if (metric === 'cost') lines.push('按价格表估算，非账单。');
  lines.push('预测不进入同步、分享海报与导出。');
  return {
    tag: '预测',
    title,
    metricLabel,
    value,
    interval,
    method,
    detail: lines.join(''),
    caveats,
    ariaLabel: ariaLabelOf(title, value, interval, method, caveats),
  };
}
