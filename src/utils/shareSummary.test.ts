import { describe, expect, it } from 'vitest';
import type { StatsData, UsageComparison } from '../types';
import { buildShareSummary, rankItems } from './shareSummary';

function comparison(kind: UsageComparison['window']['kind'] = 'weekOverWeek'): UsageComparison {
  return {
    window: {
      kind,
      timezone: 'Asia/Shanghai',
      bucket: kind === 'dayOverDay' ? 'hour' : 'day',
      currentStart: '2026-08-10T00:00:00+08:00',
      currentEnd: '2026-08-16T18:00:00+08:00',
      previousStart: '2026-08-03T00:00:00+08:00',
      previousEnd: '2026-08-09T18:00:00+08:00',
      alignedThrough: '18:00',
    },
    current: {
      summary: { totalTokens: 1_280_000, inputTokens: 900_000, outputTokens: 380_000, cachedTokens: 480_000, totalCost: 12, totalRequests: 90, avgTokensPerReq: 14_222 },
      series: [
        { bucket: '2026-08-10', tokens: 100_000, requests: 10, cost: 1 },
        { bucket: '2026-08-11', tokens: 220_000, requests: 14, cost: 2 },
        { bucket: '2026-08-12', tokens: 140_000, requests: 11, cost: 1.5 },
        { bucket: '2026-08-13', tokens: 180_000, requests: 12, cost: 1.8 },
        { bucket: '2026-08-14', tokens: 130_000, requests: 10, cost: 1.3 },
        { bucket: '2026-08-15', tokens: 208_000, requests: 15, cost: 2.1 },
        { bucket: '2026-08-16', tokens: 302_000, requests: 18, cost: 3.3 },
      ],
    },
    previous: {
      summary: { totalTokens: 1_138_790, inputTokens: 800_000, outputTokens: 338_790, cachedTokens: 300_000, totalCost: 10, totalRequests: 80, avgTokensPerReq: 14_235 },
      series: [],
    },
    delta: {
      tokens: { absolute: 141_210, percent: 12.4, direction: 'up' },
      requests: { absolute: 10, percent: 12.5, direction: 'up' },
      cost: { absolute: 2, percent: 20, direction: 'up' },
    },
  };
}

function stats(overrides: Partial<StatsData> = {}): StatsData {
  return {
    summary: {
      totalTokens: 9_999_999,
      inputTokens: 900_000,
      outputTokens: 380_000,
      cachedTokens: 480_000,
      cacheReadTokens: 460_000,
      cacheWriteTokens: 20_000,
      cacheSavedUsd: 32.6,
      cacheSavings: { readSavedUsd: 32.6, writePremiumUsd: 2.6, netSavedUsd: 30, fallbackPricedReadTokens: 0, fallbackPricedWriteTokens: 0, priceBasis: 'local-prices' },
      totalCost: 42.5,
      totalRequests: 90,
      avgTokensPerReq: 1,
    },
    tools: { codex: { name: 'Codex CLI', input: 600_000, output: 100_000, cached: 100_000, total: 800_000, cost: 20, requests: 45 } },
    models: { gpt: { name: 'GPT-5', input: 500_000, output: 90_000, total: 590_000, cached: 80_000, cost: 18, requests: 40 } },
    trends: [],
    heatmap: {
      '2026-08-10': 100_000,
      '2026-08-11': 220_000,
      '2026-08-12': 140_000,
      '2026-08-14': 130_000,
      '2026-08-15': 208_000,
      '2026-08-16': 302_000,
    },
    history: [],
    comparison: comparison(),
    meta: { generatedAt: '2026-08-16T18:30:00+08:00', timezone: 'Asia/Shanghai' },
    ...overrides,
  };
}

describe('buildShareSummary', () => {
  it('固定以输入加输出作为有效 Token，并让缓存保持单列', () => {
    const result = buildShareSummary({ stats: stats(), range: 'week', scope: 'local' });
    expect(result.effectiveTokens).toBe(1_280_000);
    expect(result.cachedTokens).toBe(480_000);
    expect(result.activeDays).toBe(6);
    expect(result.peak).toEqual({ label: '2026-08-16', tokens: 302_000, requests: 18 });
    expect(result.deltaPercent).toBe(12.4);
  });

  it('隐藏费用在摘要投影阶段移除金额，绘制器拿不到原始金额', () => {
    const hidden = buildShareSummary({ stats: stats(), range: 'week', scope: 'cloud', hideCosts: true });
    expect(hidden.totalCostUsd).toBeNull();
    expect(hidden.cacheNetSavedUsd).toBeNull();
    // T10.154 D57：状态统一叫「费用已隐藏」。
    expect(hidden.boundaryNotes).toContain('费用已隐藏');
    expect(hidden.boundaryNotes).not.toContain('金额已隐藏');

    const visible = buildShareSummary({ stats: stats(), range: 'week', scope: 'cloud', hideCosts: false });
    expect(visible.totalCostUsd).toBe(42.5);
    expect(visible.cacheNetSavedUsd).toBe(30);
  });

  it('缓存仅有合计时不推导复用率或节省金额', () => {
    const combined = stats();
    delete combined.summary.cacheReadTokens;
    delete combined.summary.cacheWriteTokens;
    const result = buildShareSummary({
      stats: combined,
      range: 'week',
      scope: 'local',
      hideCosts: false,
    });

    expect(result.cachedTokens).toBe(480_000);
    expect(result.cacheReusePercent).toBeNull();
    expect(result.cacheNetSavedUsd).toBeNull();
    expect(result.boundaryNotes).toContain('缓存读写未拆分');
  });

  it('year/all 不伪造同比，all 使用协作里程碑语义', () => {
    const year = buildShareSummary({ stats: stats(), range: 'year', scope: 'local' });
    const all = buildShareSummary({ stats: stats(), range: 'all', scope: 'local' });
    expect(year.deltaPercent).toBeNull();
    expect(year.longestStreakDays).toBe(3);
    expect(all.title).toBe('AI 协作里程碑');
    expect(all.deltaDirection).toBeNull();
  });

  it('自定义区间使用 periodOverPeriod 对比并把区间日期写进周期标签', () => {
    const custom = comparison('periodOverPeriod');
    custom.window.currentStart = '2026-08-01T00:00:00+08:00';
    custom.window.currentEnd = '2026-08-16T18:00:00+08:00';
    custom.window.previousStart = '2026-07-16T00:00:00+08:00';
    custom.window.previousEnd = '2026-07-31T18:00:00+08:00';
    const result = buildShareSummary({ stats: stats({ comparison: custom }), range: 'custom', scope: 'local' });
    expect(result.title).toBe('我的 AI 协作复盘');
    expect(result.periodLabel).toBe('2026年8月1日—2026年8月16日');
    expect(result.deltaPercent).toBe(12.4);
    expect(result.deltaDirection).toBe('up');
    expect(result.activeDays).toBe(6);
    expect(result.dailyAverageTokens).toBe(Math.round(1_280_000 / 6));
    expect(result.insight).toBe('这段区间里，我和 AI 协作了 6 天');
  });

  it('缺失可选字段时省略而不是补成 0 能力', () => {
    const fixture = stats({
      summary: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalCost: 0,
        totalRequests: 0,
        avgTokensPerReq: 0,
      },
      heatmap: {},
      comparison: null,
    });
    const result = buildShareSummary({ stats: fixture, range: 'month', scope: 'cloud', hideCosts: false });
    expect(result.activeDays).toBeNull();
    expect(result.dailyAverageTokens).toBeNull();
    expect(result.deltaPercent).toBeNull();
    expect(result.cacheReadTokens).toBeNull();
    expect(result.cacheWriteTokens).toBeNull();
    expect(result.cacheNetSavedUsd).toBeNull();
    expect(result.boundaryNotes).toContain('缓存读写未拆分');
  });

  it('只在 comparison kind 与周期匹配时接受分桶和同期变化', () => {
    const mismatched = buildShareSummary({ stats: stats(), range: 'today', scope: 'local' });
    expect(mismatched.series).toEqual([]);
    expect(mismatched.deltaPercent).toBeNull();
    expect(mismatched.peak).toBeNull();
    expect(mismatched.activeDays).toBe(1);
  });

  it('日报只从截止时间内的小时桶选峰值，不回退历史热力图', () => {
    const result = buildShareSummary({
      stats: stats({
        trends: [
          { date: '09:00', codex: 120_000 },
          { date: '18:00', codex: 80_000 },
          { date: '23:00', codex: 9_000_000 },
        ],
      }),
      range: 'today',
      scope: 'local',
    });

    expect(result.series.map((point) => point.label)).toEqual(['09:00', '18:00']);
    expect(result.peak).toEqual({ label: '09:00', tokens: 120_000, requests: undefined });
  });

  it('日报只按本期有效用量投影 1 或 0 个活跃日，不读取跨日 heatmap', () => {
    const used = buildShareSummary({ stats: stats(), range: 'today', scope: 'local' });
    const empty = buildShareSummary({
      stats: stats({
        summary: {
          totalTokens: 480_000,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 480_000,
          totalCost: 0,
          totalRequests: 0,
          avgTokensPerReq: 0,
        },
      }),
      range: 'today',
      scope: 'local',
    });
    expect(used.activeDays).toBe(1);
    expect(empty.activeDays).toBe(0);
    expect(empty.effectiveTokens).toBe(0);
  });

  it('今日跨 UTC 日界线仍只展示 comparison 时区下的单日', () => {
    const dayComparison = comparison('dayOverDay');
    dayComparison.window = {
      ...dayComparison.window,
      timezone: 'Asia/Shanghai',
      currentStart: '2026-07-14T16:00:00Z',
      currentEnd: '2026-07-15T06:30:00Z',
    };
    const result = buildShareSummary({
      stats: stats({ comparison: dayComparison }),
      range: 'today',
      scope: 'local',
      now: new Date('2026-07-15T08:00:00+08:00'),
    });
    expect(result.periodLabel).toBe('7月15日');
    expect(result.periodLabel).not.toContain('—');
  });

  it('周区间的 UTC 起点按 comparison 时区还原为周一', () => {
    const weekComparison = comparison('weekOverWeek');
    weekComparison.window = {
      ...weekComparison.window,
      timezone: 'Asia/Shanghai',
      currentStart: '2026-08-09T16:00:00Z',
      currentEnd: '2026-08-16T10:00:00Z',
    };
    const result = buildShareSummary({ stats: stats({ comparison: weekComparison }), range: 'week', scope: 'local' });
    expect(result.periodLabel).toBe('8月10日—8月16日');
  });

  it('月度分析隔离其他月份热力图数据，活跃天数不超过当月自然天数', () => {
    // 构造跨越 60 多天的历史热力图（包含 6 月、7 月、8 月）
    const multiMonthHeatmap: Record<string, number> = {};
    for (let day = 1; day <= 30; day += 1) {
      multiMonthHeatmap[`2026-06-${String(day).padStart(2, '0')}`] = 50_000;
    }
    for (let day = 1; day <= 31; day += 1) {
      multiMonthHeatmap[`2026-07-${String(day).padStart(2, '0')}`] = 60_000;
    }
    for (let day = 1; day <= 16; day += 1) {
      multiMonthHeatmap[`2026-08-${String(day).padStart(2, '0')}`] = 70_000;
    }

    const monthStats = stats({
      heatmap: multiMonthHeatmap,
      meta: { generatedAt: '2026-08-16T18:00:00+08:00', timezone: 'Asia/Shanghai' },
    });

    const monthResult = buildShareSummary({
      stats: monthStats,
      range: 'month',
      scope: 'local',
      now: new Date('2026-08-16T18:00:00+08:00'),
    });

    // 8 月只有 16 天活跃日，不应出现 77 天（30+31+16）
    expect(monthResult.activeDays).toBe(16);
    expect(monthResult.longestStreakDays).toBe(16);

    const allResult = buildShareSummary({
      stats: monthStats,
      range: 'all',
      scope: 'local',
      now: new Date('2026-08-16T18:00:00+08:00'),
    });
    // all 包含全部 77 天
    expect(allResult.activeDays).toBe(77);
  });

  it('海报按数据源时区选月份，并剔除截止日之后的热力图脏值', () => {
    const losAngelesMonth = buildShareSummary({
      stats: stats({
        comparison: null,
        heatmap: {
          '2026-08-15': 200_000,
          '2026-08-31': 300_000,
          '2026-09-01': 9_000_000,
        },
        meta: {
          generatedAt: '2026-09-01T06:30:00Z',
          timezone: 'America/Los_Angeles',
        },
      }),
      range: 'month',
      scope: 'local',
    });

    expect(losAngelesMonth.activeDays).toBe(2);
    expect(losAngelesMonth.peak).toEqual({ label: '2026-08-31', tokens: 300_000 });
    expect(losAngelesMonth.generatedLabel).toBe('2026.08.31');

    const losAngelesToday = buildShareSummary({
      stats: stats({
        comparison: null,
        meta: {
          generatedAt: '2026-09-01T06:30:00Z',
          timezone: 'America/Los_Angeles',
        },
      }),
      range: 'today',
      scope: 'local',
    });
    const losAngelesAll = buildShareSummary({
      stats: stats({
        comparison: null,
        meta: {
          generatedAt: '2026-09-01T06:30:00Z',
          timezone: 'America/Los_Angeles',
        },
      }),
      range: 'all',
      scope: 'local',
    });
    expect(losAngelesToday.periodLabel).toBe('8月31日');
    expect(losAngelesAll.periodLabel).toBe('截至 2026年8月31日');
    expect(losAngelesAll.generatedLabel).toBe('2026.08.31');

    const futureDay = buildShareSummary({
      stats: stats({
        comparison: null,
        heatmap: {
          '2026-08-15': 200_000,
          '2026-08-31': 9_000_000,
        },
        meta: { generatedAt: '2026-08-16T18:00:00+08:00', timezone: 'Asia/Shanghai' },
      }),
      range: 'month',
      scope: 'local',
    });

    expect(futureDay.activeDays).toBe(1);
    expect(futureDay.peak).toEqual({ label: '2026-08-15', tokens: 200_000 });
  });
});

// T10.169：`rankItems` 曾先把千分比截到 100 再除以 10，导致任何占比 ≥10% 的榜首
// 一律显示「占 10%」。以下直接对 `rankItems` 做边界测试（不经过 buildShareSummary
// 的数据整形），并在 `buildShareSummary` 层核对分子分母同为「输入+输出」口径。
describe('rankItems 占比取整与截断顺序（T10.169）', () => {
  type Item = { name: string; tokens: number };
  const tokensOf = (value: Item) => value.tokens;

  it('QA 复现场景：357.8K / 994.5K 有效 Token 四舍五入为 36%，不再腰斩成 10%', () => {
    const result = rankItems<Item>(
      [{ name: 'codex', tokens: 357_800 }, { name: 'gpt-5-codex', tokens: 200_000 }],
      tokensOf,
      994_500,
    );
    expect(result).toEqual({ name: 'codex', tokens: 357_800, sharePercent: 36 });
  });

  it('恰好 10% 仍显示 10（旧 bug 在此处巧合正确，不能靠这一个点判断修复是否生效）', () => {
    const result = rankItems<Item>([{ name: 'solo', tokens: 100_000 }], tokensOf, 1_000_000);
    expect(result?.sharePercent).toBe(10);
  });

  it('9.95% 按四舍五入进为 10.0', () => {
    const result = rankItems<Item>([{ name: 'solo', tokens: 199 }], tokensOf, 2_000);
    expect(result?.sharePercent).toBe(10);
  });

  it('9.94% 保持 9.9，证明 10% 边界两侧都按真实占比四舍五入，而不是被强制到 10', () => {
    const result = rankItems<Item>([{ name: 'solo', tokens: 994 }], tokensOf, 10_000);
    expect(result?.sharePercent).toBe(9.9);
  });

  it('单项占满全部有效 Token 时如实显示 100', () => {
    const result = rankItems<Item>([{ name: 'solo', tokens: 500_000 }], tokensOf, 500_000);
    expect(result?.sharePercent).toBe(100);
  });

  it('99.96% 四舍五入到 100，但 99.4% 必须停在 100 以下——旧 bug 会把两者都压成 10', () => {
    const high = rankItems<Item>([{ name: 'solo', tokens: 999_600 }], tokensOf, 1_000_000);
    const justUnder = rankItems<Item>([{ name: 'solo', tokens: 994_000 }], tokensOf, 1_000_000);
    expect(high?.sharePercent).toBe(100);
    expect(justUnder?.sharePercent).toBe(99.4);
  });

  it('Token 数并列时按名称字典序稳定选出榜首', () => {
    const result = rankItems<Item>(
      [{ name: 'zeta', tokens: 500_000 }, { name: 'alpha', tokens: 500_000 }],
      tokensOf,
      1_000_000,
    );
    expect(result).toEqual({ name: 'alpha', tokens: 500_000, sharePercent: 50 });
  });

  it('无候选项时返回 null', () => {
    expect(rankItems<Item>([], tokensOf, 1_000)).toBeNull();
  });

  it('有效 Token 非正、负数或非有限时占比为 null，不产出「占」文案——未知不得显示成 0%（GLB-01）', () => {
    const items: Item[] = [{ name: 'a', tokens: 10 }];
    expect(rankItems<Item>(items, tokensOf, 0)).toEqual({ name: 'a', tokens: 10, sharePercent: null });
    expect(rankItems<Item>(items, tokensOf, -5)).toEqual({ name: 'a', tokens: 10, sharePercent: null });
    expect(rankItems<Item>(items, tokensOf, Number.NaN)).toEqual({ name: 'a', tokens: 10, sharePercent: null });
    expect(rankItems<Item>(items, tokensOf, Number.POSITIVE_INFINITY)).toEqual({ name: 'a', tokens: 10, sharePercent: null });
  });

  it('全部候选项有效 Token 为 0 时被过滤，返回 null 而不是 0%', () => {
    const result = rankItems<Item>([{ name: 'a', tokens: 0 }, { name: 'b', tokens: 0 }], tokensOf, 1_000);
    expect(result).toBeNull();
  });
});

describe('buildShareSummary 榜首口径核对（T10.169）', () => {
  it('工具与模型榜首同以「输入+输出」为分子，和 effectiveTokens 分母保持同一口径', () => {
    const fixture = stats({
      summary: {
        totalTokens: 994_500,
        inputTokens: 700_000,
        outputTokens: 294_500,
        cachedTokens: 0,
        totalCost: 10,
        totalRequests: 50,
        avgTokensPerReq: 20,
      },
      tools: {
        codex: { name: 'codex', input: 300_000, output: 57_800, cached: 0, total: 357_800, cost: 5, requests: 30 },
        other: { name: 'other-cli', input: 200_000, output: 100_000, cached: 0, total: 300_000, cost: 3, requests: 15 },
      },
      models: {
        'gpt-5-codex': { name: 'gpt-5-codex', input: 250_000, output: 50_000, total: 300_000, cost: 4, requests: 25 },
        'other-model': { name: 'other-model', input: 100_000, output: 50_000, total: 150_000, cost: 1, requests: 5 },
      },
    });
    const result = buildShareSummary({ stats: fixture, range: 'week', scope: 'local' });

    expect(result.effectiveTokens).toBe(994_500);
    // codex：357,800 / 994,500 ≈ 35.98% → 36（QA 报告的原始场景，之前被腰斩成 10）。
    expect(result.topTool).toEqual({ name: 'codex', tokens: 357_800, sharePercent: 36 });
    // gpt-5-codex：300,000 / 994,500 ≈ 30.17% → 30.2；与 codex 的 36% 不同，
    // 证明修复前两者一起显示「占 10%」不是巧合正确。
    expect(result.topModel).toEqual({ name: 'gpt-5-codex', tokens: 300_000, sharePercent: 30.2 });
  });

  it('模型缺失 input/output 拆分时不用可能含缓存的 total/displayTotal 冒充有效 Token', () => {
    const fixture = stats({
      models: {
        // 旧契约遗留形状：只有合计 total，且明确包含缓存（cached 700K 里含在 900K 的 total 中）。
        legacy: { name: 'legacy-model', total: 900_000, displayTotal: 900_000, cached: 700_000, cost: 1, requests: 1 },
        modern: { name: 'modern-model', input: 100_000, output: 50_000, total: 150_000, cost: 1, requests: 1 },
      },
    });
    const result = buildShareSummary({ stats: fixture, range: 'week', scope: 'local' });

    // legacy 的 900K/994.5K 曾经是「9 成」量级的假占比来源；缺 input/output 时必须
    // 被当成 0 有效 Token 排除出榜单，而不是用 total 顶替，把 modern 挤下榜首。
    expect(result.topModel?.name).toBe('modern-model');
    expect(result.topModel?.tokens).toBe(150_000);
  });

  it('全部模型都缺 input/output 拆分时榜首为 null，不用旧总量拼凑排名', () => {
    const fixture = stats({
      models: {
        legacy: { name: 'legacy-model', total: 900_000, cached: 700_000, cost: 1, requests: 1 },
      },
    });
    const result = buildShareSummary({ stats: fixture, range: 'week', scope: 'local' });
    expect(result.topModel).toBeNull();
  });
});


describe('T10.253 分享数据边界', () => {
  function customStats(start = '2026-07-01', end = '2026-07-03'): StatsData {
    return stats({
      comparison: null,
      heatmap: { '2026-06-30': 9_000_000, '2026-07-01': 100, '2026-07-03': 200, '2026-07-04': 8_000_000 },
      meta: {
        generatedAt: '2026-08-16T18:00:00+08:00', timezone: 'Asia/Shanghai', range: 'custom',
        query: { range: 'custom', start, end, timezone: 'Asia/Shanghai', machines: [], tools: [], models: [], search: null, tokenMode: 'effective' },
      },
    });
  }

  it('无 comparison 的历史 custom 使用可信 query 日期，并剔除区间外热力图', () => {
    const result = buildShareSummary({ stats: customStats(), range: 'custom', scope: 'cloud', now: new Date('2030-01-01T00:00:00Z') });
    expect(result.periodLabel).toBe('2026年7月1日—2026年7月3日');
    expect(result.activeDays).toBe(2);
    expect(result.longestStreakDays).toBe(1);
    expect(result.peak).toEqual({ label: '2026-07-03', tokens: 200 });
    expect(result.deltaPercent).toBeNull();
    expect(result.deltaDirection).toBeNull();
  });

  it('单日 custom 保留单日期，未来结束日不让未来脏值进入事实', () => {
    const single = buildShareSummary({ stats: customStats('2026-07-01', '2026-07-01'), range: 'custom', scope: 'cloud' });
    expect(single.periodLabel).toBe('2026年7月1日');
    expect(single.activeDays).toBe(1);
    const future = customStats('2026-08-01', '2026-08-31');
    future.heatmap = { '2026-08-15': 100, '2026-08-17': 9_000_000 };
    expect(buildShareSummary({ stats: future, range: 'custom', scope: 'cloud' }).peak).toEqual({ label: '2026-08-15', tokens: 100 });
  });

  it.each([
    ['2026-07-04', '2026-07-01'], ['2026-02-30', '2026-03-01'], ['not-a-date', '2026-07-03'],
  ])('畸形 custom query %s / %s 不产生日期或活跃天', (start, end) => {
    const result = buildShareSummary({ stats: customStats(start, end), range: 'custom', scope: 'cloud' });
    expect(result.periodLabel).toBe('自定义区间（日期未提供）');
    expect(result.activeDays).toBeNull();
    expect(result.peak).toBeNull();
  });

  it('custom 缺 query 与 comparison 时不能把整张历史热力图当区间记录', () => {
    const result = buildShareSummary({ stats: stats({ comparison: null }), range: 'custom', scope: 'local' });
    expect(result.activeDays).toBeNull();
    expect(result.longestStreakDays).toBeNull();
    expect(result.peak).toBeNull();
    expect(result.insight).not.toContain('每天');
  });

  it.each(['today', 'week', 'month', 'year', 'all'] as const)('%s 无可信来源时间时不借当前日期伪造期间', (range) => {
    const result = buildShareSummary({ stats: stats({ meta: {}, comparison: null }), range, scope: 'cloud', now: new Date('2030-12-31T00:00:00Z') });
    expect(result.periodLabel).toBe('统计期间未提供');
    expect(result.generatedLabel).toBe('生成时间未提供');
    expect(result.activeDays).toBeNull();
    expect(result.peak).toBeNull();
    expect(JSON.stringify(result)).not.toContain('2030');
  });

  it('来源和query时区冲突时不使用custom日期、活跃天或同比', () => {
    const fixture = customStats();
    fixture.meta!.query!.timezone = 'America/Los_Angeles';
    const result = buildShareSummary({ stats: fixture, range: 'custom', scope: 'cloud' });
    expect(result.periodLabel).toBe('自定义区间（日期未提供）');
    expect(result.activeDays).toBeNull();
    expect(result.deltaPercent).toBeNull();
  });

  it('不匹配的comparison不污染期间截止点', () => {
    const oldComparison = comparison();
    oldComparison.window.currentEnd = '2025-01-01T00:00:00+08:00';
    const result = buildShareSummary({ stats: stats({ comparison: oldComparison }), range: 'today', scope: 'local' });
    expect(result.periodLabel).toBe('8月16日');
    expect(result.generatedLabel).toBe('2026.08.16');
    expect(result.deltaPercent).toBeNull();
  });

  it('云端零上期是缺失基线，本机可证明零上期仍显示新增', () => {
    const fixture = stats();
    fixture.comparison!.previous.summary = { ...fixture.summary, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalRequests: 0 };
    fixture.comparison!.delta.tokens = { absolute: 1_280_000, percent: null, direction: 'new' };
    expect(buildShareSummary({ stats: fixture, range: 'week', scope: 'cloud' }).deltaDirection).toBeNull();
    expect(buildShareSummary({ stats: fixture, range: 'week', scope: 'local' }).deltaDirection).toBe('new');
  });

  it.each(['inputTokens', 'outputTokens', 'cachedTokens', 'totalRequests'] as const)('核心字段 %s 未知或非法时拒绝导出，不静默写0', (field) => {
    for (const value of [undefined, null, Number.NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const fixture = stats();
      Object.assign(fixture.summary, { [field]: value });
      expect(() => buildShareSummary({ stats: fixture, range: 'week', scope: 'local' })).toThrow('分享数据不完整');
    }
  });

  it('有效Token加总超出安全整数时也拒绝导出', () => {
    const fixture = stats();
    fixture.summary.inputTokens = Number.MAX_SAFE_INTEGER;
    fixture.summary.outputTokens = 1;
    expect(() => buildShareSummary({ stats: fixture, range: 'week', scope: 'local' })).toThrow('分享数据不完整');
  });

  it('缺失一半输入输出的模型不以部分已知值冒充榜首', () => {
    const fixture = stats({ models: {
      partial: { name: 'partial', total: 9_000_000, input: 9_000_000, requests: 1 },
      complete: { name: 'complete', total: 100, input: 60, output: 40, requests: 1 },
    } });
    expect(buildShareSummary({ stats: fixture, range: 'week', scope: 'local' }).topModel?.name).toBe('complete');
  });

  it('小时键、月键和不存在的公历日不能计作活跃日', () => {
    const fixture = stats({ comparison: null, heatmap: { '2026-08-16': 100, '2026-08-15T00:00:00': 999, '2026-08': 999, '2026-02-30': 999 } });
    expect(buildShareSummary({ stats: fixture, range: 'all', scope: 'local' }).activeDays).toBe(1);
  });

  it('同期日桶超出currentStart/end时不得作为峰值', () => {
    const fixture = stats();
    fixture.comparison!.current.series.unshift({ bucket: '2026-08-09', tokens: 99_000_000, requests: 100, cost: 100 });
    expect(buildShareSummary({ stats: fixture, range: 'week', scope: 'local' }).peak?.label).toBe('2026-08-16');
  });

  it('仅可证明的正净节省可进入海报，旧毛值、负值、零、兜底和畸形对象都省略', () => {
    const fixture = stats();
    const options = { stats: fixture, range: 'week' as const, scope: 'local' as const, hideCosts: false };
    expect(buildShareSummary(options).cacheNetSavedUsd).toBe(30);
    const proven = fixture.summary.cacheSavings!;
    const cases = [
      undefined,
      { ...proven, writePremiumUsd: 32.6, netSavedUsd: 0 },
      { ...proven, writePremiumUsd: 33.6, netSavedUsd: -1 },
      { ...proven, fallbackPricedReadTokens: 1 },
      { ...proven, fallbackPricedWriteTokens: 1 },
      { ...proven, netSavedUsd: 32.6 },
      { ...proven, netSavedUsd: Number.NaN },
    ];
    for (const savings of cases) {
      fixture.summary.cacheSavings = savings;
      expect(buildShareSummary(options).cacheNetSavedUsd).toBeNull();
    }
    fixture.summary.cacheSavings = proven;
    fixture.summary.cacheReadTokens = undefined;
    expect(buildShareSummary(options).cacheNetSavedUsd).toBeNull();
  });
});


describe('T10.253 快照明确期间', () => {
  it.each([
    ['week', '2025年12月29日—2026年1月2日'],
    ['month', '2026年1月1日—2026年1月2日'],
  ] as const)('%s 无comparison时用来源时区日期推导自然起点和截止日期', (range, label) => {
    const fixture = stats({ comparison: null, meta: { generatedAt: '2026-01-03T02:00:00Z', timezone: 'America/Los_Angeles' } });
    const result = buildShareSummary({ stats: fixture, range, scope: 'cloud', now: new Date('2030-12-31T00:00:00Z') });
    expect(result.periodLabel).toBe(label);
    expect(result.periodLabel).not.toContain('目前');
  });
});
