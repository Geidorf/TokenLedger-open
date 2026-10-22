import { describe, expect, it } from 'vitest';
import completeFixture from '../../fixtures/dashboard-stats-v2/complete-v2.json';
import dailyCostsFixture from '../../fixtures/dashboard-stats-v2/daily-costs-v2.json';
import type {
  ComparisonSeriesPoint,
  DailyCosts,
  RangeKey,
  StatsData,
  StatsQueryContext,
  Summary,
} from '../types';
import { parseStatsDataContract } from './contracts/statsQuery';
import {
  FORECAST_BASELINE_MAX_DAYS,
  FORECAST_NOMINAL_LEVEL,
  civilDaysBetween,
  describePeriodForecast,
  forecastFromStats,
  forecastInputFromStats,
  forecastPeriod,
  formatForecastUsd,
  formatUsdTriple,
  lag1Autocorrelation,
  monthBounds,
  tQuantile90,
  weekBounds,
  type ForecastCopy,
  type ForecastDay,
  type ForecastPeriodInput,
  type MetricForecast,
} from './forecast';

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** [tokens, cost, requests?]；requests 缺省时有 Token 记 1、无 Token 记 0。 */
type Row = [number, number, number?];
/** 引擎输入的一天：[tokens, cost]，null 表示未知。 */
type DayValues = [number | null, number | null];

function dailySeries(start: string, rows: Row[]): ComparisonSeriesPoint[] {
  return rows.map(([tokens, cost, requests], index) => ({
    bucket: addDays(start, index),
    tokens,
    cost,
    requests: requests ?? (tokens > 0 ? 1 : 0),
  }));
}

function repeatRow(count: number, row: Row): Row[] {
  return Array.from({ length: count }, () => [...row] as Row);
}

function repeatDay(count: number, value: DayValues): DayValues[] {
  return Array.from({ length: count }, () => [...value] as DayValues);
}

const EMPTY_SUMMARY: Summary = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalCost: 0,
  totalRequests: 0,
  avgTokensPerReq: 0,
};

interface StatsOptions {
  range: RangeKey;
  timeZone: string;
  currentStart: string;
  currentEnd: string;
  series: ComparisonSeriesPoint[];
  generatedAt?: string;
  windowTimeZone?: string;
  query?: Partial<StatsQueryContext>;
  dailyCosts?: DailyCosts;
}

function statsFor(options: StatsOptions): StatsData {
  return {
    summary: EMPTY_SUMMARY,
    tools: {},
    models: {},
    trends: [],
    heatmap: {},
    history: [],
    ...(options.dailyCosts ? { dailyCosts: options.dailyCosts } : {}),
    comparison: {
      window: {
        kind: options.range === 'week' ? 'weekOverWeek' : options.range === 'custom' ? 'periodOverPeriod' : 'monthOverMonth',
        timezone: options.windowTimeZone ?? options.timeZone,
        bucket: 'day',
        currentStart: options.currentStart,
        currentEnd: options.currentEnd,
        previousStart: options.currentStart,
        previousEnd: options.currentEnd,
        alignedThrough: '00:00',
      },
      current: { summary: EMPTY_SUMMARY, series: options.series },
      previous: { summary: EMPTY_SUMMARY, series: options.series },
      delta: {
        tokens: { absolute: 0, percent: null, direction: 'flat' },
        requests: { absolute: 0, percent: null, direction: 'flat' },
        cost: { absolute: 0, percent: null, direction: 'flat' },
      },
    },
    meta: {
      contractVersion: 2,
      generatedAt: options.generatedAt ?? options.currentEnd,
      timezone: options.timeZone,
      range: options.range,
      query: {
        range: options.range,
        timezone: options.timeZone,
        machines: [],
        tools: [],
        models: [],
        search: null,
        tokenMode: 'effective',
        ...options.query,
      },
    },
  };
}

/** 2026-09（30 天）：1–14 日每天 100 Token / $1，今天（15 日）已记录 30 Token / $0.3。 */
function steadySeptember(todayTokens = 30, todayCost = 0.3): StatsData {
  return statsFor({
    range: 'month',
    timeZone: 'Asia/Shanghai',
    currentStart: '2026-09-01T00:00:00+08:00',
    currentEnd: '2026-09-15T14:00:00+08:00',
    series: dailySeries('2026-09-01', [...repeatRow(14, [100, 1]), [todayTokens, todayCost]]),
  });
}

function input(days: ForecastDay[], overrides: Partial<ForecastPeriodInput> = {}): ForecastPeriodInput {
  return {
    kind: 'month',
    timeZone: 'UTC',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    cutoffDate: days[days.length - 1].date,
    cutoffDayComplete: false,
    days,
    ...overrides,
  };
}

function days(start: string, values: DayValues[]): ForecastDay[] {
  return values.map(([tokens, cost], index) => ({ date: addDays(start, index), tokens, cost }));
}

function expectMonotonicTrajectory(metric: MetricForecast) {
  for (let index = 1; index < metric.trajectory.length; index += 1) {
    const previous = metric.trajectory[index - 1];
    const current = metric.trajectory[index];
    expect(current.point).toBeGreaterThanOrEqual(previous.point);
    expect(current.low).toBeGreaterThanOrEqual(previous.low);
    expect(current.high).toBeGreaterThanOrEqual(previous.high);
  }
  for (const point of metric.trajectory) {
    expect(point.low).toBeLessThanOrEqual(point.point);
    expect(point.point).toBeLessThanOrEqual(point.high);
  }
}

describe('公历日期工具', () => {
  it('月界按公历计算，覆盖闰年与大小月', () => {
    expect(monthBounds('2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthBounds('2028-02-29')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(monthBounds('2026-04-30')).toEqual({ start: '2026-04-01', end: '2026-04-30' });
    expect(monthBounds('2026-12-31')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    expect(monthBounds('2026-02-30')).toBeNull();
  });

  it('自然周从周一开始，周日属于上一个周一', () => {
    expect(weekBounds('2026-09-24')).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(weekBounds('2026-09-21')).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(weekBounds('2026-09-27')).toEqual({ start: '2026-09-21', end: '2026-09-27' });
    expect(weekBounds('2026-10-01')).toEqual({ start: '2026-09-28', end: '2026-10-04' });
  });

  it('夏令时切换日仍算一天，天数与宿主时区无关', () => {
    expect(civilDaysBetween('2026-03-01', '2026-03-31')).toBe(30);
    expect(civilDaysBetween('2026-11-01', '2026-11-02')).toBe(1);
    expect(civilDaysBetween('2026-03-08', '2026-03-09')).toBe(1);
    expect(civilDaysBetween('2026-09-30', '2026-09-01')).toBe(-29);
    expect(civilDaysBetween('2026-09-31', '2026-10-01')).toBeNull();
  });

  it('t 分位取不大于自由度的最近一档，自由度不足时为 NaN', () => {
    expect(tQuantile90(2)).toBe(1.8856);
    expect(tQuantile90(13)).toBe(1.3502);
    expect(tQuantile90(35)).toBe(1.3104);
    expect(tQuantile90(1000)).toBe(1.2886);
    expect(tQuantile90(0)).toBeNaN();
  });

  it('相邻两天相关系数：少于 5 天、各天相同或负相关时为 0，按小样本偏差校正后封顶 0.8', () => {
    expect(lag1Autocorrelation([1, 2, 3, 4])).toBe(0);
    expect(lag1Autocorrelation([5, 5, 5, 5, 5])).toBe(0);
    expect(lag1Autocorrelation([1, 9, 1, 9, 1, 9])).toBe(0);
    expect(lag1Autocorrelation([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(0.8);
    // 原始相关系数 r ≈ 0.2，n = 10：校正后 (10 × r + 1) / 7 ≈ 0.43。
    const values = [4, 6, 5, 7, 3, 2, 4, 6, 7, 5];
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    let numerator = 0;
    let denominator = 0;
    values.forEach((value, index) => {
      denominator += (value - average) ** 2;
      if (index > 0) numerator += (value - average) * (values[index - 1] - average);
    });
    const raw = numerator / denominator;
    expect(raw).toBeCloseTo(0.2004, 4);
    expect(lag1Autocorrelation(values)).toBeCloseTo((10 * raw + 1) / 7, 12);
  });
});

describe('forecastPeriod：已完成日线性外推', () => {
  it('点预测 = 已完成合计 + 日均 × 剩余天数（含今天），区间按和式预测区间', () => {
    const forecast = forecastFromStats(steadySeptember(), 'month', { scope: 'local' });
    expect(forecast.kind).toBe('forecast');
    expect(forecast.status).toBe('ok');
    expect(forecast.period).toEqual({
      kind: 'month', start: '2026-09-01', end: '2026-09-30', days: 30, timeZone: 'Asia/Shanghai',
    });
    expect(forecast.cutoffDate).toBe('2026-09-15');
    expect(forecast.completedDays).toBe(14);
    expect(forecast.baselineDays).toBe(14);
    expect(forecast.remainingDays).toBe(16);

    // 14 天完全相同：样本标准差为 0，按日波动下限 0.5 × 日均 = 50 计。
    const halfWidth = 1.3502 * 50 * Math.sqrt(16 + (16 * 16) / 14);
    const tokens = forecast.tokens!;
    expect(tokens.status).toBe('ok');
    expect(tokens.completedTotal).toBe(1400);
    expect(tokens.inProgress).toBe(30);
    expect(tokens.typicalDaily).toBe(100);
    expect(tokens.projected).toBe(3000);
    expect(tokens.high).toBe(Math.round(3000 + halfWidth));
    expect(tokens.low).toBe(Math.round(3000 - halfWidth));
    expect(tokens.low).toBe(2605);
    expect(tokens.high).toBe(3395);

    const cost = forecast.cost!;
    expect(cost.status).toBe('ok');
    expect(cost.completedTotal).toBeCloseTo(14, 10);
    expect(cost.projected).toBeCloseTo(30, 10);
    expect(cost.high).toBeCloseTo(30 + halfWidth / 100, 10);
    expect(cost.low).toBeCloseTo(30 - halfWidth / 100, 10);
  });

  it('今天不参与速率：今天很重时只抬高今天，不改变典型日', () => {
    const light = forecastFromStats(steadySeptember(30, 0.3), 'month', { scope: 'local' });
    const heavy = forecastFromStats(steadySeptember(250, 2.5), 'month', { scope: 'local' });
    expect(heavy.tokens!.typicalDaily).toBe(light.tokens!.typicalDaily);
    // 今天按 max(已记录 250, 日均 100) 计：比常规多出 150。
    expect(heavy.tokens!.projected).toBe(3150);
    expect(heavy.tokens!.low! - light.tokens!.low!).toBe(150);
  });

  it('预测与区间下限永远不低于本期已经记录的量', () => {
    const forecast = forecastFromStats(steadySeptember(5000, 50), 'month', { scope: 'local' });
    const tokens = forecast.tokens!;
    expect(tokens.projected).toBe(1400 + 5000 + 15 * 100);
    expect(tokens.low).toBeGreaterThanOrEqual(1400 + 5000);
    expect(tokens.trajectory[0]).toMatchObject({ date: '2026-09-15', point: 6400, low: 6400 });
    expect(forecast.cost!.low).toBeGreaterThanOrEqual(14 + 50);
  });

  it('累计轨迹从今天到周期末单调不减，末点等于周期预测', () => {
    // 高波动：大多数天为 0，偶有尖峰，下限必须靠运行最大值保持单调。
    const values: Array<[number, number]> = [
      [0, 0], [900, 9], [0, 0], [0, 0], [40, 0.4], [0, 0], [0, 0], [1200, 12], [0, 0], [0, 0], [30, 0.3],
    ];
    const forecast = forecastPeriod(input(days('2026-09-01', values)));
    const tokens = forecast.tokens!;
    expect(tokens.status).toBe('ok');
    expect(tokens.trajectory).toHaveLength(forecast.remainingDays);
    expect(tokens.trajectory[0].date).toBe('2026-09-11');
    const last = tokens.trajectory[tokens.trajectory.length - 1];
    expect(last.date).toBe('2026-09-30');
    expect(last).toMatchObject({ point: tokens.projected, low: tokens.low, high: tokens.high });
    expectMonotonicTrajectory(tokens);
    expectMonotonicTrajectory(forecast.cost!);
    expect(tokens.low).toBeGreaterThanOrEqual(2140 + 30);
  });

  it('样本波动大于下限时使用样本标准差；上限同时覆盖按最近 7 天日均外推的结果', () => {
    const values: Array<[number, number]> = [
      [50, 1], [250, 1], [50, 1], [250, 1], [50, 1], [250, 1], [50, 1], [250, 1], [0, 0],
    ];
    const forecast = forecastPeriod(input(days('2026-09-01', values)));
    const tokens = forecast.tokens!;
    const mean = 150;
    const recent = 1150 / 7;
    const sd = Math.sqrt((8 * 100 * 100) / 7);
    const m = 22;
    const halfWidth = 1.4149 * sd * Math.sqrt(m + (m * m) / 8);
    expect(tokens.typicalDaily).toBe(mean);
    // 一高一低交替是负相关：不收窄，也不放宽。
    expect(tokens.autocorrelation).toBe(0);
    expect(tokens.recentDaily).toBe(Math.round(recent));
    expect(tokens.projected).toBe(1200 + m * mean);
    expect(tokens.low).toBe(Math.round(1200 + m * mean - halfWidth));
    expect(tokens.high).toBe(Math.round(1200 + m * recent + halfWidth));
    expect(tokens.peakShare).toBeCloseTo(250 / 1200, 10);
    expect(tokens.peakInfluence).toBeCloseTo((250 - 150) / (7 * 150), 10);
  });

  it('Token 结果取整，费用保留原始精度', () => {
    const values: DayValues[] = [
      ...repeatDay(7, [333, 0.123]), [10, 0.01],
    ];
    const forecast = forecastPeriod(input(days('2026-09-01', values)));
    expect(Number.isInteger(forecast.tokens!.projected)).toBe(true);
    expect(Number.isInteger(forecast.tokens!.low)).toBe(true);
    expect(forecast.cost!.projected).toBeCloseTo(0.123 * 7 + 0.123 * 23, 10);
  });

  it('少于最少完整日时整体 insufficient，并给出还差几天', () => {
    const six = forecastPeriod(input(days('2026-09-01', [...repeatDay(6, [100, 1]), [10, 0.1]])));
    expect(six.status).toBe('insufficient');
    expect(six.reason).toBe('too-few-completed-days');
    expect(six.completedDays).toBe(6);
    expect(six.requiredCompletedDays).toBe(7);
    expect(six.availableFrom).toBe('2026-09-08');
    expect(six.tokens).toBeNull();

    const seven = forecastPeriod(input(days('2026-09-01', [...repeatDay(7, [100, 1]), [10, 0.1]])));
    expect(seven.status).toBe('ok');
    expect(seven.availableFrom).toBe('2026-09-08');
    expect(seven.tokens!.status).toBe('ok');
  });

  it('最少完整日可以覆盖，但非有限值回落到默认门槛，且不低于两天', () => {
    const five = input(days('2026-09-01', [...repeatDay(5, [100, 1]), [10, 0.1]]), {
      kind: 'custom',
      periodEnd: '2026-09-20',
    });
    expect(forecastPeriod(five, { minCompletedDays: 5 }).status).toBe('ok');
    expect(forecastPeriod(five, { minCompletedDays: Number.NaN })).toMatchObject({
      status: 'insufficient', requiredCompletedDays: 7,
    });
    const one: DayValues[] = [[100, 1], [10, 0.1]];
    expect(forecastPeriod(input(days('2026-09-01', one)), { minCompletedDays: 0 })).toMatchObject({
      status: 'insufficient', requiredCompletedDays: 2,
    });
  });

  it('本月第一天没有任何完整日，不做任何外推', () => {
    const forecast = forecastPeriod(input(days('2026-09-01', [[500, 5]])));
    expect(forecast.status).toBe('insufficient');
    expect(forecast.completedDays).toBe(0);
    expect(forecast.remainingDays).toBe(30);
    expect(forecast.availableFrom).toBe('2026-09-08');
  });

  it('有消耗的天数不足两天时该口径 insufficient', () => {
    const values: Array<[number, number]> = [[0, 0], [0, 0], [700, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
    const forecast = forecastPeriod(input(days('2026-09-01', values)));
    expect(forecast.status).toBe('ok');
    expect(forecast.tokens).toMatchObject({ status: 'insufficient', reason: 'too-few-active-days', activeDays: 1 });
    // 费用全部是已知的 0（免费模型）：同样不足以确立速率，但不是“未知”。
    expect(forecast.cost).toMatchObject({ status: 'insufficient', reason: 'too-few-active-days', activeDays: 0 });
  });

  it('已完成日里有未知费用时费用预测不可得，Token 预测不受影响', () => {
    const values: DayValues[] = [
      [100, 1], [100, null], [100, 1], [100, 1], [100, null], [100, 1], [100, 1], [100, 1], [20, 0.2],
    ];
    const forecast = forecastPeriod(input(days('2026-09-01', values)));
    expect(forecast.cost).toMatchObject({
      status: 'unavailable', reason: 'unknown-values', unknownDays: 2, projected: null, completedTotal: null,
    });
    expect(forecast.tokens!.status).toBe('ok');
  });

  it('今天费用未知时标 partial：不设今天下限，也不把未知记成 0', () => {
    const values: DayValues[] = [...repeatDay(8, [100, 1]), [20, null]];
    const forecast = forecastPeriod(input(days('2026-09-01', values)));
    expect(forecast.cost).toMatchObject({ status: 'partial', reason: 'in-progress-unknown', inProgress: null });
    expect(forecast.cost!.projected).toBeCloseTo(8 + 22 * 1, 10);
    expect(forecast.tokens!.status).toBe('ok');
    const copy = describePeriodForecast(forecast, 'cost')!;
    expect(copy.value).toBe('≈$30');
    expect(copy.caveats).toContain('今天有费用未知的记录，今天按日均计入预测');
  });

  it('来源无法证明逐日费用时费用整体不可得', () => {
    const values: DayValues[] = [...repeatDay(8, [100, null]), [20, null]];
    const forecast = forecastPeriod(input(days('2026-09-01', values), { costUnavailableReason: 'cost-provenance-unavailable' }));
    expect(forecast.cost).toMatchObject({ status: 'unavailable', reason: 'cost-provenance-unavailable', unknownDays: 8 });
    expect(forecast.tokens!.status).toBe('ok');
  });

  it('稠密序列缺日、乱序或越界都判为 series-misaligned', () => {
    const complete = days('2026-09-01', repeatDay(9, [100, 1]));
    const missing = complete.filter((day) => day.date !== '2026-09-04');
    expect(forecastPeriod(input(missing, { cutoffDate: '2026-09-09' })).reason).toBe('series-misaligned');
    const swapped = [...complete];
    [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
    expect(forecastPeriod(input(swapped)).reason).toBe('series-misaligned');
    expect(forecastPeriod(input(complete, { cutoffDate: '2026-10-02', periodEnd: '2026-09-30' })).status).toBe('unavailable');
  });

  it('长自定义区间只用最近 31 个完整日作为基线，并拒绝远距离外推', () => {
    const early = repeatDay(9, [5000, 50]);
    const recent = repeatDay(FORECAST_BASELINE_MAX_DAYS, [100, 1]);
    const forecast = forecastPeriod(input(days('2026-08-01', [...early, ...recent, [10, 0.1]]), {
      kind: 'custom',
      periodStart: '2026-08-01',
      periodEnd: '2026-10-31',
    }));
    expect(forecast.status).toBe('ok');
    expect(forecast.completedDays).toBe(40);
    expect(forecast.baselineDays).toBe(31);
    expect(forecast.tokens!.typicalDaily).toBe(100);
    expect(forecast.tokens!.completedTotal).toBe(9 * 5000 + 31 * 100);

    const far = forecastPeriod(input(days('2026-08-01', [...repeatDay(8, [100, 1]), [10, 0.1]]), {
      kind: 'custom',
      periodStart: '2026-08-01',
      periodEnd: '2026-09-29',
    }));
    expect(far.status).toBe('insufficient');
    expect(far.reason).toBe('horizon-too-long');
    expect(far.remainingDays).toBe(52);
    // 8 月 13 日：已完成 12 天，剩 48 天 = 4 × 12。
    expect(far.availableFrom).toBe('2026-08-13');
  });

  it('周期已经结束时状态为 complete，不再预测', () => {
    const forecast = forecastPeriod(input(days('2026-08-01', repeatDay(31, [100, 1])), {
      kind: 'custom',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      cutoffDayComplete: true,
    }));
    expect(forecast.status).toBe('complete');
    expect(forecast.remainingDays).toBe(0);
    expect(forecast.tokens).toBeNull();
  });

  it('最早可预测日期同时满足完整日与外推距离两道门槛', () => {
    const custom = (start: string, end: string, values: DayValues[]) => forecastPeriod(input(days(start, values), {
      kind: 'custom', periodStart: start, periodEnd: end,
    }));
    // 9 月 20 日至次年 3 月 31 日：满 7 个完整日后仍离结束太远，要等到距结束不超过 4 × 31 天。
    const longEarly = custom('2026-09-20', '2027-03-31', [...repeatDay(2, [100, 1]), [10, 0.1]]);
    expect(longEarly).toMatchObject({ status: 'insufficient', reason: 'too-few-completed-days', availableFrom: '2026-11-28' });
    expect(civilDaysBetween('2026-11-28', '2027-03-31')! + 1).toBe(4 * FORECAST_BASELINE_MAX_DAYS);
    // 整年区间：基线最多 31 天，因此要等到距结束 124 天。
    const year = custom('2026-01-01', '2026-12-31', [...repeatDay(40, [100, 1]), [10, 0.1]]);
    expect(year).toMatchObject({ reason: 'horizon-too-long', availableFrom: '2026-08-30' });
    // 区间只有 5 天：永远凑不够 7 个完整日。
    const short = custom('2026-09-20', '2026-09-24', [...repeatDay(2, [100, 1]), [10, 0.1]]);
    expect(short).toMatchObject({ status: 'insufficient', availableFrom: null });
    // 本周周三：还差 1 个完整日。
    const wednesday = forecastPeriod(input(days('2026-09-21', [[100, 1], [300, 3], [10, 0.1]]), {
      kind: 'week', periodStart: '2026-09-21', periodEnd: '2026-09-27',
    }));
    expect(wednesday).toMatchObject({ status: 'insufficient', availableFrom: '2026-09-24' });
  });

  it('最近 7 天日均明显变化时，范围同时覆盖两种外推，并标出方向', () => {
    const rising = forecastPeriod(input(days('2026-09-01', [
      ...repeatDay(10, [100, 1]), ...repeatDay(7, [200, 2]), [50, 0.5],
    ])));
    const up = rising.tokens!;
    expect(up.recentDaily).toBe(200);
    expect(up.recentShift).toEqual({ direction: 'rising', ratio: 2 });
    expect(up.projected).toBe(Math.round(2400 + 13 * (2400 / 17)));
    // 若按最近 7 天的速度继续，期末是 2400 + 13 × 200 = 5000：上限必须高于它。
    expect(up.high).toBeGreaterThan(2400 + 13 * 200);
    expect(up.low).toBeLessThanOrEqual(up.projected!);

    const falling = forecastPeriod(input(days('2026-09-01', [
      ...repeatDay(10, [200, 2]), ...repeatDay(7, [100, 1]), [50, 0.5],
    ])));
    const down = falling.tokens!;
    expect(down.recentShift).toEqual({ direction: 'falling', ratio: 0.5 });
    // 若按最近 7 天的速度继续，期末是 2700 + 13 × 100 = 4000：下限必须不高于它。
    expect(down.low).toBeLessThanOrEqual(2700 + 13 * 100);
    expect(down.low).toBeGreaterThanOrEqual(2700 + 50);

    const fromZero = forecastPeriod(input(days('2026-09-01', [
      ...repeatDay(7, [0, 0]), ...repeatDay(7, [100, 1]), [50, 0.5],
    ])));
    expect(fromZero.tokens!.recentShift).toEqual({ direction: 'rising', ratio: null });

    // 不足 14 个完整日时不比较前后两段。
    const short = forecastPeriod(input(days('2026-09-01', [
      ...repeatDay(6, [100, 1]), ...repeatDay(6, [300, 3]), [50, 0.5],
    ])));
    expect(short.tokens!.recentShift).toBeNull();
    expect(short.tokens!.recentDaily).not.toBeNull();
  });

  it('用量成片高低时按相邻两天的相关程度放宽范围', () => {
    const streaky: DayValues[] = [
      [50, 1], [60, 1], [55, 1], [70, 1], [200, 1], [210, 1], [190, 1], [220, 1], [60, 1], [50, 1], [65, 1], [30, 0.3],
    ];
    const interleaved: DayValues[] = [
      [50, 1], [200, 1], [60, 1], [210, 1], [55, 1], [190, 1], [70, 1], [220, 1], [60, 1], [50, 1], [65, 1], [30, 0.3],
    ];
    const clustered = forecastPeriod(input(days('2026-09-01', streaky))).tokens!;
    const mixed = forecastPeriod(input(days('2026-09-01', interleaved))).tokens!;
    // 同样的 11 个数，只是顺序不同：点预测相同，成片的那一组范围更宽。
    expect(clustered.projected).toBe(mixed.projected);
    expect(clustered.autocorrelation).toBe(0.8);
    expect(mixed.autocorrelation).toBe(0);
    expect(clustered.high! - clustered.low!).toBeGreaterThan(2 * (mixed.high! - mixed.low!));
  });

  it('本周还没有周末时，周末不外推：下限按周末不用计算，上限仍按日均', () => {
    const week = (values: DayValues[]) => forecastPeriod(input(days('2026-09-21', values), {
      kind: 'week', periodStart: '2026-09-21', periodEnd: '2026-09-27',
    }));
    const thursday = week([[100, 1], [300, 3], [200, 2], [10, 0.1]]).tokens!;
    expect(thursday.unseenDayType).toBe('weekend');
    expect(thursday.weekdayMixRisk).toBe(true);
    expect(thursday.projected).toBe(600 + 4 * 200);
    const [thu, fri, sat, sun] = thursday.trajectory;
    expect(sat.low).toBe(fri.low);
    expect(sun.low).toBe(fri.low);
    expect(sun.high).toBeGreaterThan(sat.high);
    expect(thu.low).toBeGreaterThanOrEqual(600 + 10);
    // 周日时基线已含周六：不再有没见过的日子类型。
    const sunday = week([[100, 1], [300, 3], [200, 2], [200, 2], [200, 2], [50, 0.5], [10, 0.1]]).tokens!;
    expect(sunday.unseenDayType).toBeNull();
  });

  it('月内剩余天数的周末占比与基线不同、且工作日与周末用量差异明显时标出风险', () => {
    // 2026 年 6 月只在工作日使用，截止 6 月 13 日（周六）。
    const june: DayValues[] = [];
    for (let index = 0; index < 12; index += 1) {
      const weekday = new Date(Date.UTC(2026, 5, 1 + index)).getUTCDay();
      june.push(weekday === 0 || weekday === 6 ? [0, 0] : [1000, 1]);
    }
    june.push([0, 0]);
    const forecast = forecastPeriod(input(days('2026-06-01', june), { periodStart: '2026-06-01', periodEnd: '2026-06-30' }));
    expect(forecast.tokens!.weekdayMixRisk).toBe(true);
    expect(forecast.tokens!.unseenDayType).toBeNull();
    const steady = forecastFromStats(steadySeptember(), 'month', { scope: 'local' });
    expect(steady.tokens!.weekdayMixRisk).toBe(false);
  });

  it('方法如实声明未经校准：名义水平只是宽度刻度', () => {
    const forecast = forecastFromStats(steadySeptember(), 'month', { scope: 'local' });
    expect(forecast.method).toEqual({
      kind: 'linear-mean',
      nominalLevel: FORECAST_NOMINAL_LEVEL,
      calibrated: false,
      cvFloor: 0.5,
      autocorrelationMax: 0.8,
      recentDays: 7,
      minActiveDays: 2,
      baselineMaxDays: 31,
      maxHorizonRatio: 4,
    });
  });

  it('随机日序列下恒成立：下限 ≤ 预测 ≤ 上限、轨迹单调、不低于已记录量', () => {
    let seed = 20260924;
    const random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let value = seed;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
    let checked = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      const cutoff = 8 + Math.floor(random() * 23);
      const spiky = random() < 0.5;
      const values: DayValues[] = Array.from({ length: cutoff }, () => {
        const tokens = random() < 0.25 ? 0 : Math.round((spiky ? random() ** 3 : random()) * 50_000);
        return [tokens, tokens / 10_000];
      });
      const forecast = forecastPeriod(input(days('2026-09-01', values)));
      for (const metric of [forecast.tokens, forecast.cost]) {
        if (!metric || metric.status !== 'ok') continue;
        checked += 1;
        expect(metric.low!).toBeLessThanOrEqual(metric.projected!);
        expect(metric.projected!).toBeLessThanOrEqual(metric.high!);
        expect(metric.low! + 1e-9).toBeGreaterThanOrEqual(metric.completedTotal! + metric.inProgress!);
        expectMonotonicTrajectory(metric);
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe('forecastInputFromStats：只用契约日桶与截止点', () => {
  it('只支持本月、本周与多日自定义区间', () => {
    for (const range of ['today', 'year', 'all'] as const) {
      expect(forecastFromStats(steadySeptember(), range, { scope: 'local' })).toMatchObject({
        status: 'unsupported', reason: 'range-unsupported',
      });
    }
    const today = parseStatsDataContract(completeFixture);
    expect(forecastFromStats(today, 'today', { scope: 'local' }).status).toBe('unsupported');
  });

  it('单日自定义区间是小时桶，不支持', () => {
    const stats = steadySeptember();
    stats.comparison!.window.bucket = 'hour';
    expect(forecastFromStats(stats, 'custom', { scope: 'local' })).toMatchObject({
      status: 'unsupported', reason: 'bucket-unsupported',
    });
  });

  it('缺少同期对比时不可得（共享 fixture 的月范围没有 comparison）', () => {
    const stats = parseStatsDataContract(dailyCostsFixture);
    expect(forecastFromStats(stats, 'month', { scope: 'cloud', sourceIncomplete: false })).toMatchObject({
      status: 'unavailable', reason: 'comparison-missing',
    });
  });

  it('查询、对比与 meta 时区冲突时整体不可用', () => {
    const stats = statsFor({
      range: 'month',
      timeZone: 'Asia/Shanghai',
      windowTimeZone: 'UTC',
      currentStart: '2026-09-01T00:00:00+08:00',
      currentEnd: '2026-09-15T14:00:00+08:00',
      series: dailySeries('2026-09-01', repeatRow(15, [100, 1])),
    });
    expect(forecastFromStats(stats, 'month', { scope: 'local' })).toMatchObject({
      status: 'unavailable', reason: 'time-context-unavailable',
    });
  });

  it('调用方声明来源不完整（云端仍有待上传记录）时不预测', () => {
    expect(forecastFromStats(steadySeptember(), 'month', { scope: 'cloud', sourceIncomplete: true })).toMatchObject({
      status: 'unavailable', reason: 'source-incomplete',
    });
  });

  it('云端来源是否完整必须明确给出：漏传时编译失败，绕过类型检查也按不完整处理', () => {
    // @ts-expect-error 云端作用域必须给出 sourceIncomplete
    const unchecked = forecastFromStats(steadySeptember(), 'month', { scope: 'cloud' });
    expect(unchecked).toMatchObject({ status: 'unavailable', reason: 'source-incomplete' });
    expect(forecastFromStats(steadySeptember(), 'month', { scope: 'cloud', sourceIncomplete: false }).status).toBe('ok');
    // 本机作用域可以省略：本机账本就是完整来源。
    expect(forecastFromStats(steadySeptember(), 'month', { scope: 'local' }).status).toBe('ok');
  });

  it('“今天”取生成时刻：缺少生成时刻时不猜', () => {
    const stats = steadySeptember();
    stats.meta!.generatedAt = '';
    expect(forecastFromStats(stats, 'month', { scope: 'local' })).toMatchObject({
      status: 'unavailable', reason: 'time-context-unavailable',
    });
  });

  // 本机（Rust）按 aligned_day = min(今天, 上月天数) 截短本期窗口与序列；云端 SQL 的 least(...) 相同。
  // 触发日：非闰年 3/29–3/31、5/31、7/31、10/31、12/31；闰年 3/30、3/31 与后四个月末。
  const CLIPPED_DAYS = [
    '2026-03-29', '2026-03-30', '2026-03-31', '2026-05-31', '2026-07-31', '2026-10-31', '2026-12-31',
    '2028-03-30', '2028-03-31', '2028-05-31',
  ];

  function monthEndShape(today: string, zone = '+08:00'): { stats: StatsData; alignedDay: number; day: number } {
    const [year, month, day] = today.split('-').map(Number);
    const previousMonthDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
    const alignedDay = Math.min(day, previousMonthDays);
    const start = `${today.slice(0, 8)}01`;
    const aligned = `${today.slice(0, 8)}${String(alignedDay).padStart(2, '0')}`;
    const stats = statsFor({
      range: 'month',
      timeZone: 'Asia/Shanghai',
      currentStart: `${start}T00:00:00${zone}`,
      currentEnd: `${aligned}T14:00:00${zone}`,
      generatedAt: `${today}T14:00:00.123456789${zone}`,
      // 对齐日只含 14:00 之前的量：序列末项看起来像“进行中的今天”。
      series: dailySeries(start, [...repeatRow(alignedDay - 1, [100, 1]), [60, 0.6]]),
    });
    return { stats, alignedDay, day };
  }

  it.each(CLIPPED_DAYS)('月末同期截短（本机形状，%s）：不把截短的日子当成今天，整体不预测', (today) => {
    const { stats, alignedDay, day } = monthEndShape(today);
    expect(alignedDay).toBeLessThan(day);
    const forecast = forecastFromStats(stats, 'month', { scope: 'local' });
    expect(forecast).toMatchObject({ status: 'unavailable', reason: 'comparison-clipped', tokens: null, cost: null });
    expect(describePeriodForecast(forecast, 'tokens')).toBeNull();
    expect(describePeriodForecast(forecast, 'cost')).toBeNull();
  });

  it.each(['2026-03-31', '2026-12-31', '2028-03-30'])('月末同期截短（云端形状，%s）：UTC 偏移的截止点同样识别', (today) => {
    const [year, month, day] = today.split('-').map(Number);
    const alignedDay = Math.min(day, new Date(Date.UTC(year, month - 1, 0)).getUTCDate());
    const start = `${today.slice(0, 8)}01`;
    const aligned = `${today.slice(0, 8)}${String(alignedDay).padStart(2, '0')}`;
    const stats = statsFor({
      range: 'month',
      timeZone: 'Asia/Shanghai',
      currentStart: `${addDays(start, -1)}T16:00:00+00:00`,
      currentEnd: `${aligned}T06:00:00.123456+00:00`,
      generatedAt: `${today}T06:00:00.123456+00:00`,
      series: dailySeries(start, [...repeatRow(alignedDay - 1, [100, 1]), [60, 0.6]]),
      dailyCosts: {
        coverage: { start, end: today, timezone: 'Asia/Shanghai', state: 'complete' },
        days: [],
      },
    });
    const forecast = forecastFromStats(stats, 'month', { scope: 'cloud', sourceIncomplete: false });
    expect(forecast).toMatchObject({ status: 'unavailable', reason: 'comparison-clipped' });
    expect(describePeriodForecast(forecast, 'tokens')).toBeNull();
  });

  it.each([
    ['2026-03-28', 28, 4],
    ['2028-03-29', 29, 3],
    ['2026-04-30', 30, 1],
    ['2026-01-31', 31, 1],
  ] as const)('对照：上月天数不少于今天（%s）时照常预测到月末', (today, day, remaining) => {
    const { stats, alignedDay } = monthEndShape(today);
    expect(alignedDay).toBe(day);
    const forecast = forecastFromStats(stats, 'month', { scope: 'local' });
    expect(forecast).toMatchObject({ status: 'ok', cutoffDate: today, remainingDays: remaining });
    // 已完成 day − 1 天各 100，今天已记 60：预测不低于已记录量。
    expect(forecast.tokens!.low).toBeGreaterThanOrEqual((day - 1) * 100 + 60);
  });

  it('序列停在今天之前、但截止点不是截短形状时判为错位', () => {
    const stats = statsFor({
      range: 'month',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-01T00:00:00+08:00',
      currentEnd: '2026-09-15T14:00:00+08:00',
      series: dailySeries('2026-09-01', repeatRow(13, [100, 1])),
    });
    expect(forecastFromStats(stats, 'month', { scope: 'local' })).toMatchObject({
      status: 'unavailable', reason: 'series-misaligned',
    });
  });

  it('截止点按来源时区换算：UTC 表示的 Kiritimati 截止点已进入下个月', () => {
    const base = {
      range: 'month' as const,
      timeZone: 'Pacific/Kiritimati',
      currentStart: '2026-09-30T10:00:00Z',
      currentEnd: '2026-09-30T12:00:00Z',
    };
    const correct = forecastInputFromStats(statsFor({
      ...base,
      series: dailySeries('2026-10-01', [[100, 1]]),
    }), 'month', { scope: 'local' });
    expect(correct.ok).toBe(true);
    if (correct.ok) {
      expect(correct.input).toMatchObject({
        periodStart: '2026-10-01', periodEnd: '2026-10-31', cutoffDate: '2026-10-01', timeZone: 'Pacific/Kiritimati',
      });
    }
    // 若按 UTC 日期把今天当成 9 月 30 日，序列就对不上：必须失败而不是错月外推。
    const utcMisread = forecastInputFromStats(statsFor({
      ...base,
      series: dailySeries('2026-09-01', repeatRow(30, [100, 1])),
    }), 'month', { scope: 'local' });
    expect(utcMisread).toMatchObject({ ok: false, reason: 'series-misaligned' });
  });

  it('洛杉矶夏令时结束当月：UTC 次日凌晨仍属于本地前一天', () => {
    const stats = statsFor({
      range: 'month',
      timeZone: 'America/Los_Angeles',
      currentStart: '2026-11-01T07:00:00Z',
      currentEnd: '2026-11-11T05:00:00Z',
      series: dailySeries('2026-11-01', [...repeatRow(9, [100, 1]), [40, 0.4]]),
    });
    const forecast = forecastFromStats(stats, 'month', { scope: 'local' });
    expect(forecast.status).toBe('ok');
    expect(forecast.cutoffDate).toBe('2026-11-10');
    expect(forecast.period).toMatchObject({ start: '2026-11-01', end: '2026-11-30', days: 30 });
    expect(forecast.completedDays).toBe(9);
    expect(forecast.remainingDays).toBe(21);
    expect(forecast.tokens!.projected).toBe(900 + 21 * 100);
  });

  it('洛杉矶夏令时开始当月：本地偏移截止点直接取本地日期', () => {
    const stats = statsFor({
      range: 'month',
      timeZone: 'America/Los_Angeles',
      currentStart: '2026-03-01T00:00:00-08:00',
      currentEnd: '2026-03-20T10:00:00-07:00',
      series: dailySeries('2026-03-01', [...repeatRow(19, [100, 1]), [40, 0.4]]),
    });
    const forecast = forecastFromStats(stats, 'month', { scope: 'local' });
    expect(forecast.cutoffDate).toBe('2026-03-20');
    expect(forecast.period).toMatchObject({ days: 31 });
    expect(forecast.remainingDays).toBe(12);
    expect(forecast.tokens!.projected).toBe(1900 + 12 * 100);
  });

  it('本周：周四时有三个完整日，至周日还剩四天', () => {
    const stats = statsFor({
      range: 'week',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-21T00:00:00+08:00',
      currentEnd: '2026-09-24T09:00:00+08:00',
      series: dailySeries('2026-09-21', [[100, 1], [300, 3], [200, 2], [10, 0.1]]),
    });
    const forecast = forecastFromStats(stats, 'week', { scope: 'local' });
    expect(forecast.status).toBe('ok');
    expect(forecast.period).toMatchObject({ kind: 'week', start: '2026-09-21', end: '2026-09-27', days: 7 });
    expect(forecast.completedDays).toBe(3);
    expect(forecast.remainingDays).toBe(4);
    expect(forecast.tokens!.projected).toBe(600 + 4 * 200);

    const wednesday = statsFor({
      range: 'week',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-21T00:00:00+08:00',
      currentEnd: '2026-09-23T09:00:00+08:00',
      series: dailySeries('2026-09-21', [[100, 1], [300, 3], [10, 0.1]]),
    });
    expect(forecastFromStats(wednesday, 'week', { scope: 'local' })).toMatchObject({
      status: 'insufficient', reason: 'too-few-completed-days', requiredCompletedDays: 3,
    });
  });

  it('序列首日必须是周期首日：本周序列从周二开始时不可用', () => {
    const stats = statsFor({
      range: 'week',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-22T00:00:00+08:00',
      currentEnd: '2026-09-25T09:00:00+08:00',
      series: dailySeries('2026-09-22', [[100, 1], [300, 3], [200, 2], [10, 0.1]]),
    });
    expect(forecastFromStats(stats, 'week', { scope: 'local' })).toMatchObject({
      status: 'unavailable', reason: 'series-misaligned',
    });
  });

  it('进行中的自定义区间预测到区间末日', () => {
    const stats = statsFor({
      range: 'custom',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-10T00:00:00+08:00',
      currentEnd: '2026-09-24T09:00:00+08:00',
      series: dailySeries('2026-09-10', [...repeatRow(14, [100, 1]), [10, 0.1]]),
      query: { start: '2026-09-10', end: '2026-10-09' },
    });
    const forecast = forecastFromStats(stats, 'custom', { scope: 'local' });
    expect(forecast.status).toBe('ok');
    expect(forecast.period).toMatchObject({ kind: 'custom', start: '2026-09-10', end: '2026-10-09', days: 30 });
    expect(forecast.remainingDays).toBe(16);
    expect(describePeriodForecast(forecast, 'tokens')!.title).toBe('截至 10月9日 预测');
  });

  it('已结束的自定义区间窗口截到末日 23:59:59，状态为 complete', () => {
    const stats = statsFor({
      range: 'custom',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-08-01T00:00:00+08:00',
      currentEnd: '2026-08-31T23:59:59+08:00',
      generatedAt: '2026-09-24T10:00:00+08:00',
      series: dailySeries('2026-08-01', repeatRow(31, [100, 1])),
      query: { start: '2026-08-01', end: '2026-08-31' },
    });
    expect(forecastFromStats(stats, 'custom', { scope: 'local' }).status).toBe('complete');
  });

  it('以今天为末日的自定义区间仍在进行中，只剩今天', () => {
    const stats = statsFor({
      range: 'custom',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-10T00:00:00+08:00',
      currentEnd: '2026-09-24T09:00:00+08:00',
      series: dailySeries('2026-09-10', [...repeatRow(14, [100, 1]), [150, 1.5]]),
      query: { start: '2026-09-10', end: '2026-09-24' },
    });
    const forecast = forecastFromStats(stats, 'custom', { scope: 'local' });
    expect(forecast.status).toBe('ok');
    expect(forecast.remainingDays).toBe(1);
    expect(forecast.tokens!.projected).toBe(1400 + 150);
  });

  it('本机费用直接取日序列（每行已按价格表估算）', () => {
    const result = forecastInputFromStats(steadySeptember(), 'month', { scope: 'local' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.days[0]).toEqual({ date: '2026-09-01', tokens: 100, cost: 1 });
      expect(result.input.costUnavailableReason).toBeUndefined();
    }
  });

  it('云端日序列把未知费用合成 0，只信 dailyCosts；缺失时费用不可得', () => {
    const stats = steadySeptember();
    const result = forecastInputFromStats(stats, 'month', { scope: 'cloud', sourceIncomplete: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.costUnavailableReason).toBe('cost-provenance-unavailable');
      expect(result.input.days.every((day) => day.cost === null)).toBe(true);
    }
    const forecast = forecastFromStats(stats, 'month', { scope: 'cloud', sourceIncomplete: false });
    expect(forecast.cost).toMatchObject({ status: 'unavailable', reason: 'cost-provenance-unavailable' });
    expect(forecast.tokens!.status).toBe('ok');
  });

  it('云端 dailyCosts：已估算日取金额，不可得日为未知，缺行日只有无记录时才是 $0', () => {
    const series = dailySeries('2026-09-01', [
      [100, 1], [0, 0, 0], [0, 0.4, 2], [100, 0], [100, 1], [100, 1], [100, 1], [100, 1], [100, 1], [10, 0.1],
    ]);
    const dailyCosts: DailyCosts = {
      coverage: { start: '2026-09-01', end: '2026-09-10', timezone: 'Asia/Shanghai', state: 'complete' },
      days: [
        { date: '2026-09-01', amountUsd: 1.1, status: 'recorded-estimate' },
        { date: '2026-09-04', amountUsd: null, status: 'unavailable', reason: 'missing-cost' },
        ...['05', '06', '07', '08', '09', '10'].map((day) => ({
          date: `2026-09-${day}`, amountUsd: 1, status: 'recorded-estimate' as const,
        })),
      ],
    };
    const stats = statsFor({
      range: 'month',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-01T00:00:00+08:00',
      currentEnd: '2026-09-10T14:00:00+08:00',
      series,
      dailyCosts,
    });
    const result = forecastInputFromStats(stats, 'month', { scope: 'cloud', sourceIncomplete: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.days.map((day) => day.cost)).toEqual([1.1, 0, null, null, 1, 1, 1, 1, 1, 1]);
    const forecast = forecastPeriod(result.input);
    expect(forecast.cost).toMatchObject({ status: 'unavailable', reason: 'unknown-values', unknownDays: 2 });
  });

  it('云端 dailyCosts 覆盖为 partial 或与周期不一致时不采信', () => {
    const base = {
      range: 'month' as const,
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-01T00:00:00+08:00',
      currentEnd: '2026-09-10T14:00:00+08:00',
      series: dailySeries('2026-09-01', repeatRow(10, [100, 1])),
    };
    const partial = statsFor({
      ...base,
      dailyCosts: {
        coverage: { start: '2026-09-01', end: '2026-09-10', timezone: 'Asia/Shanghai', state: 'partial' },
        days: [],
      },
    });
    const shifted = statsFor({
      ...base,
      dailyCosts: {
        coverage: { start: '2026-09-02', end: '2026-09-10', timezone: 'Asia/Shanghai', state: 'complete' },
        days: [],
      },
    });
    for (const stats of [partial, shifted]) {
      const result = forecastInputFromStats(stats, 'month', { scope: 'cloud', sourceIncomplete: false });
      expect(result.ok && result.input.costUnavailableReason).toBe('cost-provenance-unavailable');
    }
  });

  it('完整的云端 dailyCosts 可以给出费用预测', () => {
    const series = dailySeries('2026-09-01', [...repeatRow(9, [100, 0]), [10, 0]]);
    const dailyCosts: DailyCosts = {
      coverage: { start: '2026-09-01', end: '2026-09-10', timezone: 'Asia/Shanghai', state: 'complete' },
      days: series.map((point) => ({ date: point.bucket, amountUsd: 2, status: 'recorded-estimate' as const })),
    };
    const forecast = forecastFromStats(statsFor({
      range: 'month',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-01T00:00:00+08:00',
      currentEnd: '2026-09-10T14:00:00+08:00',
      series,
      dailyCosts,
    }), 'month', { scope: 'cloud', sourceIncomplete: false });
    expect(forecast.cost!.status).toBe('ok');
    expect(forecast.cost!.projected).toBeCloseTo(18 + 21 * 2, 10);
  });
});

describe('describePeriodForecast：标签、方法与范围同时出现', () => {
  function copyText(copy: ForecastCopy): string {
    return [copy.tag, copy.title, copy.value, copy.interval, copy.method, copy.detail, ...copy.caveats, copy.ariaLabel].join(' ');
  }

  it('费用预测带「预测」标签、粗略范围、方法和非账单说明', () => {
    const copy = describePeriodForecast(forecastFromStats(steadySeptember(), 'month', { scope: 'local' }), 'cost')!;
    expect(copy.tag).toBe('预测');
    expect(copy.title).toBe('月末预测');
    expect(copy.metricLabel).toBe('预估费用');
    expect(copy.value).toBe('≈$30');
    expect(copy.interval).toBe('粗略范围 $26–$34');
    expect(copy.method).toBe('按已完成 14 天的日均外推；范围假设之后的用量与这些天相近');
    expect(copy.detail).toContain('典型日取本月已完成 14 天的算术平均，乘以剩余 16 天（含今天）');
    expect(copy.detail).toContain('范围是粗略范围，不是概率保证');
    expect(copy.detail).toContain('日波动不低于日均的一半（经验值）');
    expect(copy.detail).toContain('按价格表估算，非账单');
    expect(copy.detail).toContain('不进入同步、分享海报与导出');
    expect(copy.caveats).toEqual([]);
  });

  it('Token 预测写明「有效 Token」，与界面“含缓存”的显示偏好区分', () => {
    const copy = describePeriodForecast(forecastFromStats(steadySeptember(), 'month', { scope: 'local' }), 'tokens')!;
    expect(copy.metricLabel).toBe('有效 Token');
    expect(copy.value).toBe('3.0K 有效 Token');
    expect(copy.interval).toBe('粗略范围 2.6K–3.4K');
    expect(copy.detail).not.toContain('按价格表估算');
  });

  it('点值与范围同一单位、同一精度：范围不会显示成同一个数，999,600 进位到 M', () => {
    const million = statsFor({
      range: 'month',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-01T00:00:00+08:00',
      currentEnd: '2026-09-15T14:00:00+08:00',
      series: dailySeries('2026-09-01', [...repeatRow(14, [1_000_000, 1]), [10, 0.1]]),
    });
    const copy = describePeriodForecast(forecastFromStats(million, 'month', { scope: 'local' }), 'tokens')!;
    expect(copy.value).toBe('30.0M 有效 Token');
    expect(copy.interval).toMatch(/^粗略范围 \d+\.\dM–\d+\.\dM$/);

    const nearMillion = forecastPeriod(input(days('2026-09-01', [...repeatDay(14, [33_320, 1]), [10, 0.1]])));
    expect(nearMillion.tokens!.projected).toBe(999_600);
    const nearCopy = describePeriodForecast(nearMillion, 'tokens')!;
    expect(nearCopy.value).toBe('1.0M 有效 Token');
    expect(nearCopy.interval).toBe('粗略范围 0.9M–1.1M');

    const small = forecastPeriod(input(days('2026-09-01', [...repeatDay(14, [10, 0.01]), [1, 0.001]])));
    const smallCopy = describePeriodForecast(small, 'tokens')!;
    expect(smallCopy.value).toBe('300 有效 Token');
    expect(smallCopy.interval).toMatch(/^粗略范围 \d+–\d+$/);
  });

  it('数据不足时说明还差几天、哪天起给出预测，而不是给数字', () => {
    const forecast = forecastPeriod(input(days('2026-09-01', [...repeatDay(4, [100, 1]), [10, 0.1]])));
    const copy = describePeriodForecast(forecast, 'cost')!;
    expect(copy.value).toBeNull();
    expect(copy.interval).toBeNull();
    expect(copy.method).toBe('还需 3 个完整日（至少 7 天），9月8日 起给出预测');
    expect(copy.ariaLabel).toBe('预测：月末预测。还需 3 个完整日（至少 7 天），9月8日 起给出预测。');
  });

  it('长自定义区间给出真正能预测的日期，不会满 7 天后又改口', () => {
    const custom = (start: string, end: string, values: DayValues[]) => describePeriodForecast(forecastPeriod(input(days(start, values), {
      kind: 'custom', periodStart: start, periodEnd: end,
    })), 'tokens')!;
    expect(custom('2026-09-20', '2027-03-31', [...repeatDay(2, [100, 1]), [10, 0.1]]).method)
      .toBe('还需 67 个完整日（距结束太远），11月28日 起给出预测');
    expect(custom('2026-09-20', '2026-09-24', [...repeatDay(2, [100, 1]), [10, 0.1]]).method)
      .toBe('区间只有 5 天，不足以预测（至少要 7 个完整日）');
  });

  it('基线被 31 天上限截断时如实写“最近 N 个完整日”，外推过远时写清比较对象与日期', () => {
    const long = forecastPeriod(input(days('2026-08-01', [
      ...repeatDay(9, [5000, 50]), ...repeatDay(FORECAST_BASELINE_MAX_DAYS, [100, 1]), [10, 0.1],
    ]), { kind: 'custom', periodStart: '2026-08-01', periodEnd: '2026-10-31' }));
    const copy = describePeriodForecast(long, 'tokens')!;
    expect(copy.title).toBe('截至 10月31日 预测');
    expect(copy.method).toBe('按最近 31 个完整日的日均外推；范围假设之后的用量与这些天相近');
    expect(copy.detail).toContain('典型日取本区间最近 31 个完整日的算术平均');

    const near = forecastPeriod(input(days('2026-08-01', [...repeatDay(8, [100, 1]), [10, 0.1]]), {
      kind: 'custom', periodStart: '2026-08-01', periodEnd: '2026-09-29',
    }));
    expect(describePeriodForecast(near, 'cost')!.method)
      .toBe('距结束还有 52 天，超过已完成 8 天的 4 倍，8月13日 起给出预测');

    const year = forecastPeriod(input(days('2026-01-01', [...repeatDay(40, [100, 1]), [10, 0.1]]), {
      kind: 'custom', periodStart: '2026-01-01', periodEnd: '2026-12-31',
    }));
    expect(year.reason).toBe('horizon-too-long');
    expect(year.remainingDays).toBe(325);
    const yearCopy = describePeriodForecast(year, 'tokens')!;
    expect(yearCopy.value).toBeNull();
    expect(yearCopy.method).toBe('距结束还有 325 天，超过最近 31 个完整日的 4 倍，8月30日 起给出预测');
  });

  it('活跃日不足的说明按基线范围如实描述', () => {
    const early = forecastPeriod(input(days('2026-08-01', [
      ...repeatDay(9, [5000, 50]), [100, 1], ...repeatDay(30, [0, 0]), [10, 0.1],
    ]), { kind: 'custom', periodStart: '2026-08-01', periodEnd: '2026-10-31' }));
    expect(describePeriodForecast(early, 'tokens')!.method).toBe('最近 31 个完整日里有消耗的不足 2 天，暂不预测');
    const month = forecastPeriod(input(days('2026-09-01', [[0, 0], [0, 0], [700, 7], ...repeatDay(5, [0, 0])])));
    expect(describePeriodForecast(month, 'tokens')!.method).toBe('已完成的日子里有消耗的不足 2 天，暂不预测');
  });

  it('费用未知与来源缺失各有说明，Token 口径不受影响', () => {
    const unknown = forecastPeriod(input(days('2026-09-01', [
      ...repeatDay(7, [100, 1]), [100, null], [10, 0.1],
    ])));
    expect(describePeriodForecast(unknown, 'cost')!.method).toBe('费用预测不可得：本月有 1 天的费用未知');
    expect(describePeriodForecast(unknown, 'tokens')!.value).not.toBeNull();

    const cloud = forecastFromStats(steadySeptember(), 'month', { scope: 'cloud', sourceIncomplete: false });
    expect(describePeriodForecast(cloud, 'cost')!.method).toBe('费用预测不可得：数据源未提供可验证的逐日费用');
  });

  it('周预测提示未区分工作日与周末；单日高峰按对日均的影响提示', () => {
    const stats = statsFor({
      range: 'week',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-21T00:00:00+08:00',
      currentEnd: '2026-09-24T09:00:00+08:00',
      series: dailySeries('2026-09-21', [[100, 1], [900, 9], [100, 1], [10, 0.1]]),
    });
    const copy = describePeriodForecast(forecastFromStats(stats, 'week', { scope: 'local' }), 'tokens')!;
    expect(copy.title).toBe('本周预测（至周日）');
    expect(copy.caveats).toEqual([
      '未区分工作日与周末',
      '单日最高占已完成合计的 82%，去掉这一天日均会低 73%',
    ]);
    expect(copy.detail).toContain('已完成的日子里还没有周末，范围下限按这些天不用计算。');

    // 三天很平均：最高的一天只让日均高 11%，不提示。
    const flat = forecastPeriod(input(days('2026-09-21', [[100, 1], [150, 1], [120, 1], [10, 0.1]]), {
      kind: 'week', periodStart: '2026-09-21', periodEnd: '2026-09-27',
    }));
    expect(flat.tokens!.peakShare).toBeCloseTo(150 / 370, 10);
    expect(describePeriodForecast(flat, 'tokens')!.caveats).toEqual(['未区分工作日与周末']);
  });

  it('基线被截断时，单日高峰附注写明统计范围是最近 N 个完整日', () => {
    const truncated = forecastPeriod(input(days('2026-08-01', [
      ...repeatDay(9, [5000, 50]), [5000, 50], ...repeatDay(30, [100, 1]), [10, 0.1],
    ]), { kind: 'custom', periodStart: '2026-08-01', periodEnd: '2026-10-31' }));
    expect(describePeriodForecast(truncated, 'tokens')!.caveats)
      .toContain('单日最高占最近 31 个完整日合计的 63%，去掉这一天日均会低 61%');
  });

  it('月内只在工作日使用时附注未区分工作日与周末', () => {
    const june: DayValues[] = [];
    for (let index = 0; index < 12; index += 1) {
      const weekday = new Date(Date.UTC(2026, 5, 1 + index)).getUTCDay();
      june.push(weekday === 0 || weekday === 6 ? [0, 0] : [1000, 1]);
    }
    june.push([0, 0]);
    const forecast = forecastPeriod(input(days('2026-06-01', june), { periodStart: '2026-06-01', periodEnd: '2026-06-30' }));
    expect(describePeriodForecast(forecast, 'tokens')!.caveats).toEqual(['未区分工作日与周末']);
  });

  it('近期明显变化时如实附注方向，不改变点预测', () => {
    const rising = forecastPeriod(input(days('2026-09-01', [
      ...repeatDay(10, [100, 1]), ...repeatDay(7, [200, 2]), [50, 0.5],
    ])));
    expect(describePeriodForecast(rising, 'tokens')!.caveats)
      .toEqual(['最近 7 天日均比前 7 天高 100%；若持续，结果会高于预测']);
    expect(describePeriodForecast(rising, 'tokens')!.detail).toContain('同时覆盖按最近 7 天日均外推的结果');
    const falling = forecastPeriod(input(days('2026-09-01', [
      ...repeatDay(10, [200, 2]), ...repeatDay(7, [100, 1]), [50, 0.5],
    ])));
    expect(describePeriodForecast(falling, 'cost')!.caveats)
      .toEqual(['最近 7 天日均比前 7 天低 50%；若持续，结果会低于预测']);
    const fromZero = forecastPeriod(input(days('2026-09-01', [
      ...repeatDay(7, [0, 0]), ...repeatDay(7, [100, 1]), [50, 0.5],
    ])));
    expect(describePeriodForecast(fromZero, 'tokens')!.caveats)
      .toEqual(['前 7 天没有消耗，最近 7 天有消耗；若持续，结果会高于预测']);
  });

  it('不声称覆盖率：文案里没有百分比区间、置信或把握的说法', () => {
    const copies = [
      describePeriodForecast(forecastFromStats(steadySeptember(), 'month', { scope: 'local' }), 'cost')!,
      describePeriodForecast(forecastFromStats(steadySeptember(), 'month', { scope: 'local' }), 'tokens')!,
      describePeriodForecast(forecastPeriod(input(days('2026-09-01', [
        ...repeatDay(10, [100, 1]), ...repeatDay(7, [200, 2]), [50, 0.5],
      ]))), 'tokens')!,
    ];
    for (const copy of copies) {
      expect(copy.interval!.startsWith('粗略范围 ')).toBe(true);
      expect(copyText(copy)).not.toMatch(/80\s*%|约\s*\d+\s*%\s*区间|置信|把握|大概率/);
    }
  });

  it('读屏整句以「预测：」开头，含数值、范围、方法与附注', () => {
    const stats = statsFor({
      range: 'week',
      timeZone: 'Asia/Shanghai',
      currentStart: '2026-09-21T00:00:00+08:00',
      currentEnd: '2026-09-24T09:00:00+08:00',
      series: dailySeries('2026-09-21', [[100, 1], [300, 3], [200, 2], [10, 0.1]]),
    });
    const copy = describePeriodForecast(forecastFromStats(stats, 'week', { scope: 'local' }), 'cost')!;
    expect(copy.ariaLabel.startsWith('预测：本周预测（至周日） ≈$14，粗略范围 ')).toBe(true);
    expect(copy.ariaLabel).toContain(`${copy.interval}。${copy.method}。`);
    for (const caveat of copy.caveats) expect(copy.ariaLabel).toContain(caveat);
    expect(copy.ariaLabel.endsWith('。')).toBe(true);
  });

  it('周期结束、范围不支持或结构不可用时界面不显示', () => {
    expect(describePeriodForecast(forecastFromStats(steadySeptember(), 'today', { scope: 'local' }), 'cost')).toBeNull();
    expect(describePeriodForecast(forecastFromStats(steadySeptember(), 'month', {
      scope: 'cloud', sourceIncomplete: true,
    }), 'tokens')).toBeNull();
  });

  it('外推结果只叫「预测」：「预估」只作为被预测的指标名「预估费用」（T10.154）', () => {
    const cases: Array<[ForecastCopy, 'tokens' | 'cost']> = [
      [describePeriodForecast(forecastFromStats(steadySeptember(), 'month', { scope: 'local' }), 'cost')!, 'cost'],
      [describePeriodForecast(forecastFromStats(steadySeptember(), 'month', { scope: 'local' }), 'tokens')!, 'tokens'],
      [describePeriodForecast(forecastPeriod(input(days('2026-09-01', [...repeatDay(4, [100, 1]), [10, 0.1]]))), 'cost')!, 'cost'],
      [describePeriodForecast(forecastPeriod(input(days('2026-09-01', [...repeatDay(8, [100, 1]), [20, null]]))), 'cost')!, 'cost'],
    ];
    for (const [copy, metric] of cases) {
      expect(copy.tag).toBe('预测');
      expect(copy.metricLabel).toBe(metric === 'cost' ? '预估费用' : '有效 Token');
      // 唯一例外是说明被预测的量本身的 D1 短注“按价格表估算，非账单”，只出现在费用详情里。
      const text = copyText(copy);
      expect(text.includes('按价格表估算，非账单')).toBe(metric === 'cost' && copy.value !== null);
      expect(text.split('按价格表估算，非账单').join('')).not.toMatch(/预估|估算/);
    }
  });

  it('预测金额按量级取整，先舍入再判断量级', () => {
    expect(formatForecastUsd(4.26)).toBe('$4.3');
    expect(formatForecastUsd(9.96)).toBe('$10');
    expect(formatForecastUsd(26.4)).toBe('$26');
    expect(formatForecastUsd(1422.78)).toBe('$1,423');
  });

  it('金额区间非零下限不显示成 $0.0：两位小数仍是 0 时写 <$0.01，否则多保留一位，与 Token 区间同一保护（T10.153 复评 N-1）', () => {
    // 复现复评 N-1：9/1–9/7 费用 [0.03,0,0,0,0.01,0,0]，已记录 $0.04；旧版下限显示成「$0.0」。
    const lowBound = describePeriodForecast(
      forecastPeriod(input(
        days('2026-09-01', [[0, 0.03], [0, 0], [0, 0], [0, 0], [0, 0.01], [0, 0], [0, 0]]),
        { cutoffDayComplete: true },
      )),
      'cost',
    )!;
    expect(lowBound.interval).not.toMatch(/\$0\.0(?:\D|$)/);
    expect(lowBound.interval).toMatch(/^粗略范围 \$0\.0[1-9]/);

    // 同一形状按比例缩小 100 倍：下限仍不为 0（已记录 $0.0004），但两位小数已经四舍五入到 0，
    // 写「<$0.01」而不是「$0.00」（否则看起来比看板上已经显示的已记录金额还低）。
    const nearZero = describePeriodForecast(
      forecastPeriod(input(
        days('2026-09-01', [[0, 0.0003], [0, 0], [0, 0], [0, 0], [0, 0.0001], [0, 0], [0, 0]]),
        { cutoffDayComplete: true },
      )),
      'cost',
    )!;
    expect(nearZero.interval).toMatch(/^粗略范围 <\$0\.01–/);
  });

  it('formatUsdTriple：点值与上限也套「小于」保护，不止下限（T10.197 评审 P3-1，精确核对复查 §5.3 的两组数）', () => {
    // 三个值两位小数都还是 0：全部写 <$0.01，不出现「<$0.01–$0.00」这种下限比上限还大的写法。
    expect(formatUsdTriple(0.00171, 0.0004, 0.00341)).toEqual({
      point: '<$0.01',
      low: '<$0.01',
      high: '<$0.01',
    });
    // 上限两位小数是 $0.02（不落在零值写法上），保留真实值；点值、下限仍写 <$0.01。
    expect(formatUsdTriple(0.003, 0.001, 0.02)).toEqual({
      point: '<$0.01',
      low: '<$0.01',
      high: '$0.02',
    });
  });
});
