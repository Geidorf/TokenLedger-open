import { describe, expect, it } from 'vitest';
import type { ComparisonSeriesPoint, DailyCost, RangeKey, StatsData, TrendPoint, UsageComparison } from '../types';
import { forecastInputFromStats } from './forecast';
import {
  buildRhythm,
  cloudComparisonCostKnown,
  comparisonClip,
  completedBucketAverage,
  completedComparisonBucketCount,
  deriveInsightTimeContext,
  describeRhythmDelta,
  detectSpikes,
  rhythmLevel,
  type InsightTimeContext,
} from './insightRules';

function dayBuckets(values: Record<string, number>): TrendPoint[] {
  return Object.entries(values).map(([date, codex]) => ({ date, codex }));
}

/** 从 start 起连续 days 天的日桶，value(index) 给出当天用量。 */
function denseDays(start: string, days: number, value: (index: number) => number): Record<string, number> {
  const base = Date.parse(`${start}T00:00:00Z`);
  return Object.fromEntries(Array.from({ length: days }, (_, index) => [
    new Date(base + index * 86_400_000).toISOString().slice(0, 10),
    value(index),
  ]));
}

function statsMeta(range: RangeKey, extra: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-06-15T04:00:00Z',
    timezone: 'Asia/Shanghai',
    query: { range, timezone: 'Asia/Shanghai', ...extra } as NonNullable<StatsData['meta']>['query'],
  };
}

const monthContext: InsightTimeContext = {
  range: 'month',
  timeZone: 'Asia/Shanghai',
  cutoffDate: '2026-06-09',
  cutoffHour: 12,
  scope: 'local',
};

const todayContext: InsightTimeContext = {
  range: 'today',
  timeZone: 'Asia/Shanghai',
  cutoffDate: '2026-06-09',
  cutoffHour: 10,
  scope: 'local',
};

describe('deriveInsightTimeContext', () => {
  it('converts an instant with the query timezone instead of the host timezone', () => {
    const shanghai = deriveInsightTimeContext({
      meta: {
        generatedAt: '2026-06-01T00:30:00Z',
        timezone: 'Asia/Shanghai',
        query: { range: 'today', timezone: 'Asia/Shanghai' } as NonNullable<StatsData['meta']>['query'],
      },
    }, 'today');
    const losAngeles = deriveInsightTimeContext({
      meta: {
        generatedAt: '2026-06-01T00:30:00Z',
        timezone: 'America/Los_Angeles',
        query: { range: 'today', timezone: 'America/Los_Angeles' } as NonNullable<StatsData['meta']>['query'],
      },
    }, 'today');

    expect(shanghai).toMatchObject({
      timeZone: 'Asia/Shanghai',
      cutoffDate: '2026-06-01',
      cutoffHour: 8,
    });
    expect(losAngeles).toMatchObject({
      timeZone: 'America/Los_Angeles',
      cutoffDate: '2026-05-31',
      cutoffHour: 17,
    });
  });

  it('uses comparison.currentEnd as the snapshot cutoff before generatedAt', () => {
    const context = deriveInsightTimeContext({
      comparison: {
        window: {
          timezone: 'Asia/Shanghai',
          currentEnd: '2026-06-09T01:15:00Z',
        },
      } as StatsData['comparison'],
      meta: {
        generatedAt: '2026-06-09T10:45:00Z',
        timezone: 'Asia/Shanghai',
        query: { range: 'today', timezone: 'Asia/Shanghai' } as NonNullable<StatsData['meta']>['query'],
      },
    }, 'today');

    expect(context).toMatchObject({ cutoffDate: '2026-06-09', cutoffHour: 9 });
  });

  it('accepts a strict comparison civil timestamp only with matching source timezone proof', () => {
    const context = deriveInsightTimeContext({
      comparison: {
        window: {
          timezone: 'Asia/Shanghai',
          currentEnd: '2026-06-09 09:15:00.123456',
        },
      } as StatsData['comparison'],
      meta: {
        generatedAt: '2026-06-09T02:45:00Z',
        timezone: 'Asia/Shanghai',
        query: { range: 'today', timezone: 'Asia/Shanghai' } as NonNullable<StatsData['meta']>['query'],
      },
    }, 'today');

    expect(context).toMatchObject({ cutoffDate: '2026-06-09', cutoffHour: 9 });
  });

  it('rejects invalid civil minutes and falls back to a valid generatedAt instant', () => {
    const context = deriveInsightTimeContext({
      comparison: {
        window: {
          timezone: 'Asia/Shanghai',
          currentEnd: '2026-06-09 09:99:99',
        },
      } as StatsData['comparison'],
      meta: {
        generatedAt: '2026-06-09T04:45:00Z',
        timezone: 'Asia/Shanghai',
        query: { range: 'today', timezone: 'Asia/Shanghai' } as NonNullable<StatsData['meta']>['query'],
      },
    }, 'today');

    expect(context).toMatchObject({ cutoffDate: '2026-06-09', cutoffHour: 12 });
  });

  it('fails closed when query, comparison, and response timezones disagree', () => {
    expect(deriveInsightTimeContext({
      comparison: {
        window: { timezone: 'UTC', currentEnd: '2026-06-09T01:15:00Z' },
      } as StatsData['comparison'],
      meta: {
        generatedAt: '2026-06-09T01:15:00Z',
        timezone: 'Asia/Shanghai',
        query: { range: 'today', timezone: 'Asia/Shanghai' } as NonNullable<StatsData['meta']>['query'],
      },
    }, 'today')).toBeNull();
  });

  it('does not treat a bridge-only query timezone as source proof', () => {
    expect(deriveInsightTimeContext({
      meta: {
        generatedAt: '2026-06-09T01:15:00Z',
        query: { range: 'today', timezone: 'Asia/Shanghai' } as NonNullable<StatsData['meta']>['query'],
      },
    }, 'today')).toBeNull();
  });

  it('给日桶范围附上来源时区的日历窗口，小时桶与无边界范围不附', () => {
    // 2026-06-15 04:00Z = 上海 12:00，周一。
    expect(deriveInsightTimeContext({ meta: statsMeta('month') }, 'month')).toMatchObject({
      cutoffDate: '2026-06-15', windowStart: '2026-06-01', windowEnd: '2026-06-30',
    });
    expect(deriveInsightTimeContext({ meta: statsMeta('week') }, 'week')).toMatchObject({
      windowStart: '2026-06-15', windowEnd: '2026-06-21',
    });
    expect(deriveInsightTimeContext({ meta: statsMeta('custom', { start: '2026-05-20', end: '2026-06-18' }) }, 'custom'))
      .toMatchObject({ windowStart: '2026-05-20', windowEnd: '2026-06-18' });
    for (const context of [
      deriveInsightTimeContext({ meta: statsMeta('custom', { start: '2026-06-15', end: '2026-06-15' }) }, 'custom'),
      deriveInsightTimeContext({ meta: statsMeta('today') }, 'today'),
      deriveInsightTimeContext({ meta: statsMeta('all') }, 'all'),
    ]) {
      expect(context).not.toBeNull();
      expect(context?.windowStart).toBeUndefined();
      expect(context?.windowEnd).toBeUndefined();
    }
  });
});

describe('buildRhythm', () => {
  it('keeps the current hour as in-progress and excludes future-hour values', () => {
    const rhythm = buildRhythm([
      { date: '09:00', codex: 40_000, claude: 10_000 },
      { date: '10:00', codex: 5_000 },
      { date: '23:00', codex: 9_000_000 },
    ] as TrendPoint[], todayContext);

    expect(rhythm?.mode).toBe('hour');
    expect(rhythm?.cells.find((cell) => cell.key === '09:00')).toMatchObject({
      value: 50_000,
      state: 'complete',
    });
    expect(rhythm?.cells.find((cell) => cell.key === '10:00')).toMatchObject({
      value: 5_000,
      state: 'in-progress',
    });
    expect(rhythm?.cells.find((cell) => cell.key === '23:00')).toMatchObject({
      value: 0,
      state: 'future',
      title: '23:00 · 尚未开始',
    });
    expect(rhythm?.total).toBe(55_000);
    expect(rhythm?.summary).toContain('今日活跃峰值 09:00');
  });

  it('uses only completed days for weekday averages', () => {
    // 06-01 起连续 14 个完整日（每个星期几恰好 2 天）；06-15 是当前周一，06-22 是未来周一。
    const context: InsightTimeContext = { ...monthContext, cutoffDate: '2026-06-15' };
    const rhythm = buildRhythm(dayBuckets({
      ...denseDays('2026-06-01', 14, (index) => (index % 7 === 0 ? 300_000 : 40_000)),
      '2026-06-15': 8_000_000,
      '2026-06-22': 9_000_000,
    }), context);

    expect(rhythm?.mode).toBe('weekday');
    expect(rhythm?.withheld).toBeUndefined();
    expect(rhythm?.cells.find((cell) => cell.key === '周一')).toMatchObject({ value: 300_000, state: 'complete' });
    expect(rhythm?.cells.find((cell) => cell.key === '周二')?.value).toBe(40_000);
    expect(rhythm?.summary).toBe('按 14 个完整日聚合的日均消耗峰值在 周一（≈300.0K Tokens/天）');
  });

  it('任何一个星期几少于 2 个完整日时不画星期节奏，只说明原因', () => {
    // 06-01（周一）到 06-08 共 8 个完整日：只有周一有 2 天。
    const early = buildRhythm(dayBuckets(denseDays('2026-06-01', 9, () => 50_000)), monthContext);
    expect(early).toMatchObject({ mode: 'weekday', cells: [], withheld: true });
    expect(early?.summary).toBe(
      '已完成 8 天，其中周二、周三、周四、周五、周六、周日不足 2 天，暂不按星期聚合（每个星期几至少需要 2 个完整日）',
    );

    // 本周范围最多 6 个完整日，永远不按星期取日均。
    const week = buildRhythm(dayBuckets(denseDays('2026-06-08', 3, () => 10_000)), {
      ...monthContext, range: 'week', cutoffDate: '2026-06-10', windowStart: '2026-06-08', windowEnd: '2026-06-14',
    });
    expect(week?.withheld).toBe(true);
    expect(week?.summary).toBe('已完成 2 天，每个星期几都不足 2 天，暂不按星期聚合');

    // 月初第一天还没有完整日。
    const firstDay = buildRhythm(dayBuckets({ '2026-06-01': 9_000 }), {
      ...monthContext, cutoffDate: '2026-06-01', windowStart: '2026-06-01', windowEnd: '2026-06-30',
    });
    expect(firstDay?.withheld).toBe(true);
    expect(firstDay?.summary).toBe('还没有完整日，暂不按星期聚合（每个星期几至少需要 2 个完整日）');
  });

  it('云端只列有记录的日子，按日历窗口补齐零消耗日后与本机稠密日桶结论一致', () => {
    const context: InsightTimeContext = {
      ...monthContext, cutoffDate: '2026-06-17', windowStart: '2026-06-01', windowEnd: '2026-06-30', scope: 'cloud',
    };
    // 只在工作日使用：周末为 0。
    const dense = denseDays('2026-06-01', 17, (index) => ([5, 6].includes(index % 7) ? 0 : 120_000));
    const sparse = Object.fromEntries(Object.entries(dense).filter(([, value]) => value > 0));
    const local = buildRhythm(dayBuckets(dense), { ...context, scope: 'local' });
    const cloud = buildRhythm(dayBuckets(sparse), context);

    expect(cloud?.withheld).toBeUndefined();
    expect(cloud?.cells.map((cell) => cell.value)).toEqual(local?.cells.map((cell) => cell.value));
    expect(cloud?.cells.find((cell) => cell.key === '周六')).toMatchObject({ value: 0, title: '周六 · 日均 ≈0 Tokens（0/2 天有消耗）' });
    expect(cloud?.summary).toBe(local?.summary);
    expect(cloud?.summary).toContain('按 16 个完整日聚合');
  });

  it('attaches per-hour detail from the hourly comparison series and grades cells relative to the peak', () => {
    const summary = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 };
    const delta = { absolute: 0, percent: 0, direction: 'flat' as const };
    const rhythm = buildRhythm([
      { date: '09:00', codex: 40_000, claude: 10_000 },
      { date: '10:00', codex: 5_000 },
    ] as TrendPoint[], todayContext, {
      window: { kind: 'dayOverDay', timezone: 'Asia/Shanghai', bucket: 'hour', currentStart: '', currentEnd: '', previousStart: '', previousEnd: '', alignedThrough: '' },
      current: { summary, series: [{ bucket: '09:00', tokens: 50_000, requests: 12, cost: 0.4 }, { bucket: '10:00', tokens: 5_000, requests: 1, cost: 0.05 }] },
      previous: { summary, series: [{ bucket: '09:00', tokens: 25_000, requests: 6, cost: 0.2 }, { bucket: '10:00', tokens: 0, requests: 0, cost: 0 }] },
      delta: { tokens: delta, requests: delta, cost: delta },
    });

    expect(rhythm?.cells.find((cell) => cell.key === '09:00')?.detail).toMatchObject({
      range: '09:00 – 10:00',
      tokens: 50_000,
      shareLabel: '占今日',
      requests: 12,
      cost: 0.4,
      previousTokens: 25_000,
      previousLabel: '昨日同时段',
      topTool: { name: 'codex', share: 0.8 },
    });
    expect(rhythm?.cells.find((cell) => cell.key === '09:00')?.detail?.share).toBeCloseTo(50_000 / 55_000);
    // 无对比序列的小时仍给区间与占比，成本/请求/同期为 null 而不是 0。
    expect(rhythm?.cells.find((cell) => cell.key === '08:00')?.detail).toMatchObject({
      range: '08:00 – 09:00', tokens: 0, share: 0, requests: null, cost: null, previousTokens: null, topTool: null,
    });
    expect(rhythm?.cells.find((cell) => cell.key === '23:00')?.detail).toBeNull();
    expect(rhythm?.summary).toBe('今日活跃峰值 09:00，≈50.0K Tokens（占 91%） · ≈$0.40');

    expect(rhythmLevel(0, 50_000)).toBe(0);
    expect(rhythmLevel(5_000, 50_000)).toBe(1);
    expect(rhythmLevel(25_000, 50_000)).toBe(3);
    expect(rhythmLevel(50_000, 50_000)).toBe(5);
    expect(rhythmLevel(10, 0)).toBe(0);
    expect(describeRhythmDelta(50_000, 25_000)).toBe('+100.0%');
    expect(describeRhythmDelta(20_000, 25_000)).toBe('−20.0%');
    expect(describeRhythmDelta(5_000, 0)).toBe('新增');
    expect(describeRhythmDelta(0, 0)).toBe('持平');
    expect(describeRhythmDelta(1, null)).toBeNull();
  });

  it('gives weekday cells a daily-average detail with observation notes', () => {
    // 两个周一 100K 与 300K；周三一次 0、一次 70K；其余每天 40K。
    const values = denseDays('2026-06-01', 14, (index) => {
      if (index === 0) return 100_000;
      if (index === 7) return 300_000;
      if (index === 2) return 0;
      if (index === 9) return 70_000;
      return 40_000;
    });
    const rhythm = buildRhythm(dayBuckets(values), { ...monthContext, cutoffDate: '2026-06-15' });
    expect(rhythm?.cells.find((cell) => cell.key === '周一')?.detail).toMatchObject({
      range: '周一 · 日均', tokens: 200_000, shareLabel: '占各星期日均合计', note: '2/2 天有消耗', cost: null,
    });
    expect(rhythm?.cells.find((cell) => cell.key === '周三')?.detail).toMatchObject({ tokens: 35_000, note: '1/2 天有消耗' });
    const averageTotal = 200_000 + 40_000 + 35_000 + 40_000 * 4;
    expect(rhythm?.cells.find((cell) => cell.key === '周一')?.detail?.share).toBeCloseTo(200_000 / averageTotal);
  });

  it('rejects month-only buckets for the year range', () => {
    const context: InsightTimeContext = { ...monthContext, range: 'year' };
    expect(buildRhythm([
      { date: '3月', codex: 1 },
      { date: '4M', codex: 2 },
      { date: '2026-05', codex: 3 },
    ] as TrendPoint[], context)).toBeNull();
  });
});

describe('detectSpikes', () => {
  it('flags values beyond the completed-bucket median threshold', () => {
    const detection = detectSpikes(dayBuckets({
      '2026-06-01': 100_000,
      '2026-06-02': 110_000,
      '2026-06-03': 90_000,
      '2026-06-04': 105_000,
      '2026-06-05': 1_000_000,
    }), monthContext);
    expect(detection?.state).toBe('flagged');
    expect(detection?.spikes[0]).toMatchObject({
      date: '2026-06-05',
      ratio: 9.5,
      drillable: true,
      inProgress: false,
    });
  });

  it('ignores future zero placeholders when constructing the baseline', () => {
    const trends = dayBuckets({
      '2026-06-01': 100_000,
      '2026-06-02': 110_000,
      '2026-06-03': 90_000,
      '2026-06-04': 105_000,
      '2026-06-05': 1_000_000,
      '2026-06-10': 0,
      '2026-06-11': 0,
      '2026-06-12': 0,
      '2026-06-13': 0,
      '2026-06-14': 0,
      '2026-06-15': 0,
    });
    const detection = detectSpikes(trends, { ...monthContext, cutoffDate: '2026-06-06' });

    expect(detection?.state).toBe('flagged');
    expect(detection?.bucketCount).toBe(5);
    expect(detection?.spikes.map((spike) => spike.date)).toEqual(['2026-06-05']);
  });

  it('evaluates the current bucket as a candidate without letting it inflate the baseline', () => {
    const detection = detectSpikes(dayBuckets({
      '2026-06-01': 100_000,
      '2026-06-02': 110_000,
      '2026-06-03': 90_000,
      '2026-06-04': 105_000,
      '2026-06-05': 95_000,
      '2026-06-06': 1_000_000,
      '2026-06-07': 9_000_000,
    }), { ...monthContext, cutoffDate: '2026-06-06' });

    expect(detection).toMatchObject({ state: 'flagged', bucketCount: 5, median: 100_000 });
    expect(detection?.spikes).toEqual([
      expect.objectContaining({
        date: '2026-06-06',
        label: '2026-06-06（进行中）',
        inProgress: true,
      }),
    ]);
  });

  it('does not create a baseline from a non-zero current bucket', () => {
    const detection = detectSpikes(dayBuckets({
      '2026-06-01': 0,
      '2026-06-02': 0,
      '2026-06-03': 0,
      '2026-06-04': 0,
      '2026-06-05': 0,
      '2026-06-06': 500_000,
    }), { ...monthContext, cutoffDate: '2026-06-06' });

    expect(detection).toMatchObject({ state: 'sparse', bucketCount: 5, median: 0, spikes: [] });
  });

  it('returns null below five completed buckets even when current and future buckets exist', () => {
    expect(detectSpikes(dayBuckets({
      '2026-06-01': 1,
      '2026-06-02': 2,
      '2026-06-03': 3,
      '2026-06-04': 4,
      '2026-06-05': 500_000,
      '2026-06-06': 9_000_000,
    }), { ...monthContext, cutoffDate: '2026-06-05' })).toBeNull();
  });
});

describe('completedComparisonBucketCount', () => {
  const summary = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 };
  function comparison(
    bucket: 'hour' | 'day',
    currentEnd: string,
    buckets: string[],
    timezone = 'Asia/Shanghai',
  ): Pick<UsageComparison, 'window' | 'current'> {
    return {
      window: {
        kind: bucket === 'hour' ? 'dayOverDay' : 'monthOverMonth',
        timezone,
        bucket,
        currentStart: '',
        currentEnd,
        previousStart: '',
        previousEnd: '',
        alignedThrough: '',
      },
      current: { summary, series: buckets.map((key) => ({ bucket: key, tokens: 1, requests: 1, cost: 0 })) },
    };
  }

  it('截止点所在的小时或日按进行中处理，只数前面已经完整的桶', () => {
    expect(completedComparisonBucketCount(comparison('hour', '2026-06-09T02:15:00Z', ['08:00', '09:00', '10:00']))).toBe(2);
    expect(completedComparisonBucketCount(comparison('hour', '2026-06-09 10:15:00', ['08:00', '09:00', '10:00']))).toBe(2);
    expect(completedComparisonBucketCount(comparison('day', '2026-06-03T14:00:00+08:00', ['2026-06-01', '2026-06-02', '2026-06-03']))).toBe(2);
    // UTC 表示的截止点按来源时区换算：06-02T20:00Z 在上海已是 06-03。
    expect(completedComparisonBucketCount(comparison('day', '2026-06-02T20:00:00Z', ['2026-06-01', '2026-06-02', '2026-06-03']))).toBe(2);
  });

  it('截止点已是区间最后一秒（已结束的自定义区间）时末桶也算完整', () => {
    const daily = comparison('day', '2026-06-03 23:59:59', ['2026-06-01', '2026-06-02', '2026-06-03']);
    const hourly = comparison('hour', '2026-06-09T23:59:59+08:00', ['22:00', '23:00']);
    daily.window.kind = hourly.window.kind = 'periodOverPeriod';
    expect(completedComparisonBucketCount(daily)).toBe(3);
    expect(completedComparisonBucketCount(hourly)).toBe(2);
  });

  it('无法识别截止点或桶键时返回 null，不退回按全部桶平均', () => {
    expect(completedComparisonBucketCount(comparison('day', 'not-a-time', ['2026-06-01']))).toBeNull();
    expect(completedComparisonBucketCount(comparison('day', '2026-06-03 12:00:00', ['D01', 'D02']))).toBeNull();
    expect(completedComparisonBucketCount(comparison('day', '2026-06-03T12:00:00Z', ['2026-06-01'], 'Not/AZone'))).toBeNull();
    expect(completedComparisonBucketCount(comparison('day', '2026-06-03 12:00:00', []))).toBe(0);
  });
});

describe('completedBucketAverage', () => {
  const summary = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 };
  function comparison(
    currentEnd: string,
    current: Array<[string, number, number]>,
    previous: Array<[string, number, number]>,
  ): Pick<UsageComparison, 'window' | 'current' | 'previous'> {
    const series = (rows: Array<[string, number, number]>) => rows.map(([bucket, tokens, cost]) => ({ bucket, tokens, cost, requests: 1 }));
    return {
      window: {
        kind: 'monthOverMonth',
        timezone: 'Asia/Shanghai',
        bucket: 'day',
        currentStart: '',
        currentEnd,
        previousStart: '',
        previousEnd: '',
        alignedThrough: '',
      },
      current: { summary, series: series(current) },
      previous: { summary, series: series(previous) },
    };
  }

  it('只平均已结束的日子，上期取同进度对齐的同样多天', () => {
    const value = comparison(
      '2026-06-03T14:00:00+08:00',
      [['2026-06-01', 100, 1], ['2026-06-02', 300, 3], ['2026-06-03', 10, 0.1]],
      [['2026-05-01', 100, 1], ['2026-05-02', 100, 1], ['2026-05-03', 999, 9]],
    );
    expect(completedBucketAverage(value, 'tokens')).toEqual({
      unit: 'day',
      buckets: 2,
      current: 200,
      previous: 100,
      delta: { absolute: 100, percent: 100, direction: 'up' },
    });
    expect(completedBucketAverage(value, 'cost')?.current).toBe(2);
  });

  it('上期为 0 时给“新增”或“持平”，不给百分比', () => {
    const fresh = comparison('2026-06-02T08:00:00+08:00', [['2026-06-01', 50, 0], ['2026-06-02', 5, 0]], [['2026-05-01', 0, 0], ['2026-05-02', 0, 0]]);
    expect(completedBucketAverage(fresh, 'tokens')?.delta).toEqual({ absolute: 50, percent: null, direction: 'new' });
    expect(completedBucketAverage(fresh, 'cost')?.delta).toEqual({ absolute: 0, percent: null, direction: 'flat' });
  });

  it('还没有完整日时均值为空而不是 0；结构不明或含无效值时整体为 null', () => {
    expect(completedBucketAverage(comparison('2026-06-01T08:00:00+08:00', [['2026-06-01', 5, 0]], [['2026-05-01', 9, 0]]), 'tokens'))
      .toEqual({ unit: 'day', buckets: 0, current: null, previous: null, delta: null });
    expect(completedBucketAverage(comparison('not-a-time', [['2026-06-01', 5, 0]], []), 'tokens')).toBeNull();
    expect(completedBucketAverage(comparison('2026-06-03T08:00:00+08:00', [['2026-06-01', Number.NaN, 0], ['2026-06-02', 5, 0], ['2026-06-03', 5, 0]], []), 'tokens')).toBeNull();
    // 上期序列不够长：本期均值照常，只是不比较。
    expect(completedBucketAverage(comparison('2026-06-03T08:00:00+08:00', [['2026-06-01', 4, 0], ['2026-06-02', 6, 0], ['2026-06-03', 1, 0]], [['2026-05-01', 1, 0]]), 'tokens'))
      .toMatchObject({ buckets: 2, current: 5, previous: null, delta: null });
  });
});

const ZERO_SUMMARY = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 };
const FLAT_DELTA = { absolute: 0, percent: null, direction: 'flat' } as const;

function comparisonStats(options: {
  range: RangeKey;
  bucket?: 'hour' | 'day';
  currentEnd: string;
  generatedAt: string;
  series?: ComparisonSeriesPoint[];
  query?: Record<string, unknown>;
  timezone?: string;
  dailyCosts?: StatsData['dailyCosts'];
}): StatsData {
  const timezone = options.timezone ?? 'Asia/Shanghai';
  const kind = options.range === 'week'
    ? 'weekOverWeek'
    : options.range === 'custom'
      ? 'periodOverPeriod'
      : options.range === 'today'
        ? 'dayOverDay'
        : 'monthOverMonth';
  return {
    summary: ZERO_SUMMARY,
    tools: {},
    models: {},
    trends: [],
    heatmap: {},
    history: [],
    comparison: {
      window: {
        kind,
        timezone,
        bucket: options.bucket ?? 'day',
        currentStart: '',
        currentEnd: options.currentEnd,
        previousStart: '',
        previousEnd: '',
        alignedThrough: '',
      },
      current: { summary: ZERO_SUMMARY, series: options.series ?? [] },
      previous: { summary: ZERO_SUMMARY, series: [] },
      delta: { tokens: FLAT_DELTA, requests: FLAT_DELTA, cost: FLAT_DELTA },
    },
    ...(options.dailyCosts ? { dailyCosts: options.dailyCosts } : {}),
    meta: {
      generatedAt: options.generatedAt,
      timezone,
      query: { range: options.range, timezone, ...options.query } as NonNullable<StatsData['meta']>['query'],
    },
  };
}

describe('comparisonClip（T10.159 P2-2 月末同期截短）', () => {
  const marchClip = { date: '2026-03-28', note: '截至 3月28日' };

  it('3/31 生成、本期对比截到 3/28：给出截止日与统一说明', () => {
    const clipped = comparisonStats({ range: 'month', currentEnd: '2026-03-28T14:00:00+08:00', generatedAt: '2026-03-31T14:00:00+08:00' });
    expect(comparisonClip(clipped, 'month')).toEqual(marchClip);
    // 截止点写成 UTC 瞬间或来源时区的民用时刻，结论相同。
    const utc = comparisonStats({ range: 'month', currentEnd: '2026-03-28T06:00:00Z', generatedAt: '2026-03-31T06:00:00Z' });
    expect(comparisonClip(utc, 'month')).toEqual(marchClip);
    const civil = comparisonStats({ range: 'month', currentEnd: '2026-03-28 14:00:00', generatedAt: '2026-03-31T14:00:00+08:00' });
    expect(comparisonClip(civil, 'month')).toEqual(marchClip);
  });

  it('平日、已经结束或仍在进行的自定义区间都不算截短', () => {
    const july = comparisonStats({ range: 'month', currentEnd: '2026-07-15T14:30:00+08:00', generatedAt: '2026-07-15T14:30:00+08:00' });
    expect(comparisonClip(july, 'month')).toBeNull();
    const week = comparisonStats({ range: 'week', currentEnd: '2026-07-15T14:30:00+08:00', generatedAt: '2026-07-15T14:30:00+08:00' });
    expect(comparisonClip(week, 'week')).toBeNull();
    const ended = comparisonStats({
      range: 'custom',
      currentEnd: '2026-06-10 23:59:59',
      generatedAt: '2026-06-15T04:00:00Z',
      query: { start: '2026-06-01', end: '2026-06-10' },
    });
    expect(comparisonClip(ended, 'custom')).toBeNull();
    const ongoing = comparisonStats({
      range: 'custom',
      currentEnd: '2026-06-15T12:00:00+08:00',
      generatedAt: '2026-06-15T04:00:00Z',
      query: { start: '2026-06-01', end: '2026-06-30' },
    });
    expect(comparisonClip(ongoing, 'custom')).toBeNull();
  });

  it('小时桶、缺对比、范围不符或时区冲突时不下结论', () => {
    const hourly = comparisonStats({
      range: 'today',
      bucket: 'hour',
      currentEnd: '2026-03-28T14:00:00+08:00',
      generatedAt: '2026-03-31T14:00:00+08:00',
    });
    expect(comparisonClip(hourly, 'today')).toBeNull();
    const clipped = comparisonStats({ range: 'month', currentEnd: '2026-03-28T14:00:00+08:00', generatedAt: '2026-03-31T14:00:00+08:00' });
    expect(comparisonClip({ meta: clipped.meta }, 'month')).toBeNull();
    expect(comparisonClip(clipped, 'week')).toBeNull();
    const conflicting = {
      ...clipped,
      comparison: { ...clipped.comparison!, window: { ...clipped.comparison!.window, timezone: 'UTC' } },
    };
    expect(comparisonClip(conflicting, 'month')).toBeNull();
  });
});

describe('cloudComparisonCostKnown（T10.159 P3-2 云端逐日费用核实）', () => {
  const point = (bucket: string, tokens: number, requests: number): ComparisonSeriesPoint => ({ bucket, tokens, requests, cost: 0.1 });
  const recorded = (date: string): DailyCost => ({ date, amountUsd: 1, status: 'recorded-estimate' });
  const unavailable = (date: string): DailyCost => ({ date, amountUsd: null, status: 'unavailable', reason: 'missing-cost' });
  type Coverage = NonNullable<StatsData['dailyCosts']>['coverage'];
  const coverage = (start: string, end: string, extra: Partial<Coverage> = {}): Coverage => ({
    start,
    end,
    timezone: 'Asia/Shanghai',
    state: 'complete',
    ...extra,
  });
  const days = [
    point('2026-07-01', 100, 1), // 列为 recorded-estimate：可证
    point('2026-07-02', 100, 1), // 列为 unavailable：未知
    point('2026-07-03', 0, 0), // 没有任何记录：真实的 $0
    point('2026-07-04', 0, 2), // 只有缓存读写，没列出：未知
    point('2026-07-05', 50, 1), // 有效 Token > 0 却没列出：未知
  ];
  const july = (dailyCosts?: StatsData['dailyCosts']) => comparisonStats({
    range: 'month',
    currentEnd: '2026-07-05T14:30:00+08:00',
    generatedAt: '2026-07-05T14:30:00+08:00',
    series: days,
    dailyCosts,
  });
  const listed = [recorded('2026-07-01'), unavailable('2026-07-02')];

  it('按 dailyCosts 逐日核实：没列出的日子只有没有任何记录时才算 $0', () => {
    expect(cloudComparisonCostKnown(july({ coverage: coverage('2026-07-01', '2026-07-05'), days: listed })))
      .toEqual([true, false, true, false, false]);
    // 覆盖区间之外的日子无从核实。
    expect(cloudComparisonCostKnown(july({ coverage: coverage('2026-07-02', '2026-07-03'), days: [unavailable('2026-07-02')] })))
      .toEqual([false, false, true, false, false]);
  });

  it('dailyCosts 缺失、覆盖不完整或时区不一致时整体无从核实', () => {
    expect(cloudComparisonCostKnown(july())).toBeNull();
    expect(cloudComparisonCostKnown(july({ coverage: coverage('2026-07-01', '2026-07-05', { state: 'partial' }), days: [] }))).toBeNull();
    expect(cloudComparisonCostKnown(july({ coverage: coverage('2026-07-01', '2026-07-05', { timezone: 'UTC' }), days: [] }))).toBeNull();
  });

  it('小时桶沿用当天的状态，没有记录的小时是真实的 $0', () => {
    const today = (dayCosts: DailyCost[]) => comparisonStats({
      range: 'today',
      bucket: 'hour',
      currentEnd: '2026-07-15T14:30:00+08:00',
      generatedAt: '2026-07-15T14:30:00+08:00',
      series: [point('00:00', 0, 0), point('09:00', 10, 1), point('14:00', 5, 1)],
      dailyCosts: { coverage: coverage('2026-07-15', '2026-07-15'), days: dayCosts },
    });
    expect(cloudComparisonCostKnown(today([recorded('2026-07-15')]))).toEqual([true, true, true]);
    expect(cloudComparisonCostKnown(today([unavailable('2026-07-15')]))).toEqual([true, false, false]);
    expect(cloudComparisonCostKnown(today([]))).toEqual([true, false, false]);
  });

  it('与预测规则层的逐日费用映射一致', () => {
    const stats = july({ coverage: coverage('2026-07-01', '2026-07-05'), days: listed });
    const input = forecastInputFromStats(stats, 'month', { scope: 'cloud', sourceIncomplete: false });
    expect(input.ok).toBe(true);
    if (!input.ok) return;
    expect(cloudComparisonCostKnown(stats)).toEqual(input.input.days.map((day) => day.cost !== null));
  });
});

describe('T10.251 同一截止点的完整桶口径', () => {
  const hours = Array.from({ length: 13 }, (_, index) => `${String(index).padStart(2, '0')}:00`);
  const trends = hours.map(date => ({ date, codex: 100 }));
  function snapshot(end: string, kind: UsageComparison['window']['kind'] = 'dayOverDay', timezone = 'UTC'): StatsData {
    const range = kind === 'periodOverPeriod' ? 'custom' : 'today';
    const summary = { totalTokens: 1200, inputTokens: 1200, outputTokens: 0, cachedTokens: 0, totalCost: 1, totalRequests: 12, avgTokensPerReq: 100 };
    const series = hours.map(bucket => ({ bucket, tokens: 100, requests: 1, cost: 0.1 }));
    return {
      summary, tools: {}, models: {}, trends, heatmap: {}, history: [],
      comparison: {
        window: { kind, bucket: 'hour', timezone, currentStart: '2026-10-02T00:00:00Z', currentEnd: end, previousStart: '', previousEnd: '', alignedThrough: '' },
        current: { summary, series }, previous: { summary, series },
        delta: { tokens: { absolute: 0, percent: 0, direction: 'flat' }, requests: { absolute: 0, percent: 0, direction: 'flat' }, cost: { absolute: 0, percent: 0, direction: 'flat' } },
      },
      meta: { timezone, generatedAt: '2026-10-03T00:00:00Z', query: { range, timezone, machines: [], tools: [], models: [], search: null, tokenMode: 'effective', ...(range === 'custom' ? { start: '2026-10-02', end: '2026-10-02' } : {}) } },
    };
  }

  it.each([
    ['2026-10-02T11:59:58.999999Z', 11],
    ['2026-10-02T11:59:59Z', 11],
    ['2026-10-02T11:59:59.000001Z', 11],
    ['2026-10-02T11:59:59.999999Z', 11],
    ['2026-10-02T12:00:00Z', 12],
    ['2026-10-02 11:59:59.999999', 11],
  ] as const)('%s：趋势均值、节奏与突增使用同一组完整小时', (end, completed) => {
    const stats = snapshot(end);
    const context = deriveInsightTimeContext(stats, 'today', 'local')!;
    expect(completedComparisonBucketCount(stats.comparison!)).toBe(completed);
    expect(completedBucketAverage(stats.comparison!, 'tokens')?.buckets).toBe(completed);
    expect(buildRhythm(trends, context, stats.comparison)?.cells.filter(cell => cell.state === 'complete')).toHaveLength(completed);
    expect(detectSpikes(trends, context)?.bucketCount).toBe(completed);
  });

  it('来源时区的整点前一秒仍进行中，跨整点才成为完整小时', () => {
    const before = snapshot('2026-10-02T03:59:59.999999Z', 'dayOverDay', 'Asia/Shanghai');
    expect(completedComparisonBucketCount(before.comparison!)).toBe(11);
    expect(buildRhythm(trends, deriveInsightTimeContext(before, 'today')!)?.cells[11].state).toBe('in-progress');
    const after = snapshot('2026-10-02T04:00:00Z', 'dayOverDay', 'Asia/Shanghai');
    expect(completedComparisonBucketCount(after.comparison!)).toBe(12);
  });

  it('只有自定义区间的23:59:59闭区间标记可完成末桶，普通今日仍进行中', () => {
    const allHours = Array.from({ length: 24 }, (_, index) => ({ date: `${String(index).padStart(2, '0')}:00`, codex: 100 }));
    for (const kind of ['periodOverPeriod', 'dayOverDay'] as const) {
      const stats = snapshot('2026-10-02T23:59:59Z', kind);
      stats.comparison!.current.series = allHours.map(point => ({ bucket: point.date, tokens: 100, requests: 1, cost: 1 }));
      const expected = kind === 'periodOverPeriod' ? 24 : 23;
      const context = deriveInsightTimeContext(stats, kind === 'periodOverPeriod' ? 'custom' : 'today')!;
      expect(completedComparisonBucketCount(stats.comparison!)).toBe(expected);
      expect(buildRhythm(allHours, context)?.cells.filter(cell => cell.state === 'complete')).toHaveLength(expected);
      expect(detectSpikes(allHours, context)?.bucketCount).toBe(expected);
    }
  });
});

describe('T10.251 自定义闭区间标记精度', () => {
  it.each([
    ['2026-10-02T23:59:59Z', 'periodOverPeriod', 2],
    ['2026-10-02T23:59:59.000000Z', 'periodOverPeriod', 2],
    ['2026-10-02T23:59:59.000001Z', 'periodOverPeriod', 1],
    ['2026-10-02T23:59:59.999999Z', 'periodOverPeriod', 1],
    ['2026-10-02T23:59:59Z', 'monthOverMonth', 1],
    ['2026-10-02T23:59:59.999999Z', 'monthOverMonth', 1],
    ['2026-10-03T00:00:00Z', 'monthOverMonth', 2],
  ] as const)('%s %s 只使用契约允许的完整日', (currentEnd, kind, complete) => {
    const summary = { totalTokens: 1, inputTokens: 1, outputTokens: 0, cachedTokens: 0, totalCost: 1, totalRequests: 1, avgTokensPerReq: 1 };
    const comparison: Pick<UsageComparison, 'window' | 'current'> = {
      window: { kind, timezone: 'UTC', bucket: 'day', currentStart: '2026-10-01T00:00:00Z', currentEnd, previousStart: '', previousEnd: '', alignedThrough: '' },
      current: { summary, series: ['2026-10-01', '2026-10-02'].map(bucket => ({ bucket, tokens: 1, requests: 1, cost: 1 })) },
    };
    expect(completedComparisonBucketCount(comparison)).toBe(complete);
  });
});
