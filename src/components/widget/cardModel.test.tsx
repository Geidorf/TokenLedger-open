import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StatsData, Summary, ToolStat, UsageComparison } from '../../types';
import { toolColorMap } from '../../types';
import { formatTokens } from '../../utils/format';
import { quotaLevel, type QuotaWindowHighlight } from '../../utils/quotaOverview';
import { MetricsGrid, describeMetricChange } from '../MetricsGrid';
import {
  TOOL_COMPOSITION_TOP,
  buildCardModel,
  buildCardQuota,
  buildTools,
  buildTrend,
  describeQuotaItem,
  describeReset,
  describeWidgetChange,
  formatShare,
  hiddenQuotaHint,
  quotaStateTail,
  toolDisplayName,
  widgetCardSize,
  type CardQuotaItem,
  type CardTrend,
  type WidgetQuotaRead,
} from './cardModel';
import { trendGeometry, trendXs } from './TrendSpark';

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    totalTokens: 1_000,
    inputTokens: 600,
    outputTokens: 400,
    cachedTokens: 12_000,
    totalCost: 3.21,
    totalRequests: 42,
    avgTokensPerReq: 24,
    ...overrides,
  };
}

/** 与 `MetricsGrid.test.tsx` 同一份同期对比：看板 KPI 与挂件胶囊吃的是同一个字段。 */
function comparison(overrides: {
  kind?: UsageComparison['window']['kind'];
  bucket?: 'hour' | 'day';
  current?: number[];
  previous?: number[];
  labels?: string[];
  window?: Partial<UsageComparison['window']>;
  tokens?: UsageComparison['delta']['tokens'];
} = {}): UsageComparison {
  const current = overrides.current ?? [];
  const previous = overrides.previous ?? [];
  const labels = overrides.labels ?? current.map((_, index) => `b${index}`);
  return {
    window: {
      kind: overrides.kind ?? 'weekOverWeek',
      timezone: 'Asia/Shanghai',
      bucket: overrides.bucket ?? 'day',
      currentStart: '2026-09-21T00:00:00+08:00',
      currentEnd: '2026-09-24T14:00:00+08:00',
      previousStart: '2026-09-14T00:00:00+08:00',
      previousEnd: '2026-09-17T14:00:00+08:00',
      alignedThrough: '2026-09-24 14:00',
      ...overrides.window,
    },
    current: { summary: summary(), series: current.map((tokens, index) => ({ bucket: labels[index], tokens, requests: 1, cost: 0 })) },
    previous: { summary: summary({ totalTokens: 200, totalRequests: 8 }), series: previous.map((tokens, index) => ({ bucket: labels[index] ?? `p${index}`, tokens, requests: 1, cost: 0 })) },
    delta: {
      tokens: overrides.tokens ?? { absolute: 1_200_000, percent: 12.46, direction: 'up' },
      requests: { absolute: -3, percent: -4.2, direction: 'down' },
      cost: { absolute: 3.2, percent: 250, direction: 'up' },
    },
  };
}

function stats(overrides: Partial<StatsData> = {}): StatsData {
  return { summary: summary(), tools: {}, models: {}, trends: [], heatmap: {}, history: [], ...overrides };
}

const MARCH_META = (generatedAt: string): StatsData['meta'] => ({
  generatedAt,
  timezone: 'Asia/Shanghai',
  query: { range: 'month', timezone: 'Asia/Shanghai', machines: [], tools: [], models: [], search: null, tokenMode: 'effective' },
});

describe('较上期同期胶囊与看板 KPI 同源（T10.192 §6.4）', () => {
  it('变化来自 comparison.delta.tokens，经看板同一个 describeMetricChange 生成', () => {
    const data = comparison();
    const change = describeWidgetChange({ comparison: data }, 'week');
    expect(change).toEqual(describeMetricChange(data.delta.tokens, formatTokens, '较上周同期', '有效 Token'));
    expect(change).toMatchObject({ headline: '+12%', period: '较上周同期', direction: 'up' });
    expect(change?.description).toBe('有效 Token较上周同期增加 12%，绝对变化 +1.20M');
  });

  it('按窗口种类写对比口径：今日写「较昨日同期」', () => {
    expect(describeWidgetChange({ comparison: comparison({ kind: 'dayOverDay' }) }, 'today')?.period).toBe('较昨日同期');
    expect(describeWidgetChange({ comparison: comparison({ kind: 'monthOverMonth' }) }, 'month')?.period).toBe('较上月同期');
  });

  it('与看板渲染出来的同一张 KPI 逐字一致（T10.204 起两边都写「有效 Token」）', () => {
    const data = comparison({ kind: 'monthOverMonth', window: { currentEnd: '2026-03-28T14:00:00+08:00' } });
    const meta = MARCH_META('2026-03-31T14:00:00+08:00');
    const change = describeWidgetChange({ comparison: data, meta }, 'month');
    expect(change?.period).toBe('较上月同期（截至 3月28日）');
    render(<MetricsGrid summary={summary()} showTotalTokens={false} scope="local" comparison={data} meta={meta} range="month" />);
    const dashboard = document.querySelector('.metric-change .sr-only')?.textContent;
    expect(dashboard).toBe('有效 Token较上月同期（截至 3月28日）增加 12%，绝对变化 +1.20M');
    expect(change?.description).toBe(dashboard);
  });

  it('对比截止与生成在同一天时不写「截至」', () => {
    const data = comparison({ kind: 'monthOverMonth', window: { currentEnd: '2026-03-28T14:00:00+08:00' } });
    const change = describeWidgetChange({ comparison: data, meta: MARCH_META('2026-03-28T14:00:00+08:00') }, 'month');
    expect(change?.period).toBe('较上月同期');
  });

  it('上期为 0 写「新增」，没有变化写「持平」，没有对比就不画胶囊，从不写 0%', () => {
    expect(describeWidgetChange({ comparison: comparison({ tokens: { absolute: 5_000, percent: null, direction: 'new' } }) }, 'week'))
      .toMatchObject({ headline: '新增', direction: 'up' });
    expect(describeWidgetChange({ comparison: comparison({ tokens: { absolute: 0, percent: 0, direction: 'flat' } }) }, 'week'))
      .toMatchObject({ headline: '持平', direction: 'flat' });
    expect(describeWidgetChange({ comparison: null }, 'today')).toBeNull();
    expect(describeWidgetChange({}, 'today')).toBeNull();
  });
});

describe('走势数据', () => {
  it('今日按小时：横轴 24 桶，刻度 00/06/12/18/24，虚线是昨日同期', () => {
    const trend = buildTrend(comparison({ kind: 'dayOverDay', bucket: 'hour', current: [1, 2, 3], previous: [3, 2, 1] }), 'today');
    expect(trend).toMatchObject({ bucket: 'hour', slots: 24, current: [1, 2, 3], previous: [3, 2, 1], previousLabel: '昨日同期' });
    expect(trend?.ticks.map((tick) => tick.label)).toEqual(['00', '06', '12', '18', '24']);
    expect(trend?.ticks.map((tick) => tick.anchor)).toEqual(['start', 'middle', 'middle', 'middle', 'end']);
    expect(trend?.ticks.map((tick) => tick.at)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it('本周 7 天，刻度是周一到周日的桶中点', () => {
    const trend = buildTrend(comparison({ current: [5, 6] }), 'week');
    expect(trend?.slots).toBe(7);
    expect(trend?.previousLabel).toBe('上周同期');
    expect(trend?.ticks.map((tick) => tick.label)).toEqual(['一', '二', '三', '四', '五', '六', '日']);
    expect(trend?.ticks[0].at).toBeCloseTo(0.5 / 7);
  });

  it('本月按当月天数：二月 28 天，刻度只到 22 日', () => {
    const labels = Array.from({ length: 10 }, (_, index) => `2026-02-${String(index + 1).padStart(2, '0')}`);
    const trend = buildTrend(comparison({ kind: 'monthOverMonth', current: labels.map(() => 1), labels }), 'month');
    expect(trend?.slots).toBe(28);
    expect(trend?.ticks.map((tick) => tick.label)).toEqual(['1日', '8日', '15日', '22日']);
    expect(trend?.ticks[0]).toMatchObject({ at: 0, anchor: 'start' });
    expect(trend?.ticks[1].at).toBeCloseTo(7.5 / 28);
  });

  it('本期任何一桶不是有限非负数就整条不画，不拿 0 补洞；上期坏了只去掉虚线', () => {
    expect(buildTrend(comparison({ current: [1, Number.NaN, 3] }), 'week')).toBeNull();
    expect(buildTrend(comparison({ current: [1, -2, 3] }), 'week')).toBeNull();
    expect(buildTrend(comparison({ current: [] }), 'week')).toBeNull();
    expect(buildTrend(null, 'week')).toBeNull();
    expect(buildTrend(comparison({ current: [1, 2], previous: [1, Number.POSITIVE_INFINITY] }), 'week')?.previous).toEqual([]);
  });

  it('桶数多于横轴时横轴跟着放宽，不把点挤出画面', () => {
    const trend = buildTrend(comparison({ bucket: 'hour', current: Array.from({ length: 25 }, () => 1) }), 'today');
    expect(trend?.slots).toBe(25);
  });
});

describe('走势几何', () => {
  const base: CardTrend = {
    bucket: 'hour',
    slots: 24,
    current: Array.from({ length: 15 }, (_, index) => index),
    previous: [],
    labels: [],
    ticks: [],
    previousLabel: '昨日同期',
    window: { currentStart: '2026-07-15T00:00:00', currentEnd: '2026-07-15T14:30:00' },
  };

  it('已走完的桶画在桶中点，进行中的最后一桶画在“现在”（14:30）', () => {
    const xs = trendXs(base, 240);
    expect(xs[0]).toBeCloseTo(5);
    expect(xs[13]).toBeCloseTo(135);
    expect(xs[14]).toBeCloseTo(145);
  });

  it('“现在”夹在前一个点与本桶末尾之间；窗口读不到时退回桶中点', () => {
    expect(trendXs({ ...base, window: { ...base.window, currentEnd: '2026-07-15T13:12:00' } }, 240)[14]).toBeCloseTo(135.5);
    expect(trendXs({ ...base, window: { ...base.window, currentEnd: '2026-07-15T20:00:00' } }, 240)[14]).toBeCloseTo(150);
    expect(trendXs({ ...base, window: {} }, 240)[14]).toBeCloseTo(145);
    expect(trendXs({ ...base, window: { currentStart: 'x', currentEnd: 'y' } }, 240)[14]).toBeCloseTo(145);
  });

  it('峰值与零值都不被曲线画出界：所有点与控制点落在 [峰值线, 基线] 之内', () => {
    const trend: CardTrend = { ...base, current: [0, 0, 100, 0, 0, 50, 50, 0, 90, 5], previous: [10, 90, 0, 0, 0, 0, 0, 100, 0, 3], window: {} };
    const geometry = trendGeometry(trend, trendXs(trend, 328));
    expect(geometry).not.toBeNull();
    const top = 3 + 52 * (1 - 1 / 1.08);
    for (const path of [geometry!.line, geometry!.previous]) {
      const numbers = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const ys = numbers.filter((_, index) => index % 2 === 1);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(top - 0.05);
      expect(Math.max(...ys)).toBeLessThanOrEqual(55 + 0.05);
    }
    expect(geometry!.area.endsWith(`L${geometry!.end.x.toFixed(1)} 58 L${(0.5 / 24 * 328).toFixed(1)} 58 Z`)).toBe(true);
  });

  it('少于两个点或全为 0 时不画线', () => {
    expect(trendGeometry({ ...base, current: [5] }, [10])).toBeNull();
    expect(trendGeometry({ ...base, current: [0, 0, 0], previous: [0, 0, 0] }, [1, 2, 3])).toBeNull();
    expect(trendGeometry({ ...base, current: [1, 2], previous: [4] }, [1, 2])?.previous).toBe('');
  });
});

describe('工具构成', () => {
  function tool(name: string, input: number, output: number, cached = 0): ToolStat {
    return { name, input, output, cached, total: input + output + cached, cost: 0, requests: 1 };
  }

  const TOOLS: Record<string, ToolStat> = {
    // 缓存不算有效 Token：claude 的 total 最大，但有效 Token 排第二。
    claude: tool('claude', 300, 100, 9_000),
    codex: tool('codex', 500, 100),
    antigravity: tool('antigravity', 100, 50),
    opencode: tool('opencode', 40, 0),
    minimax: tool('minimax', 1, 0),
    idle: tool('idle', 0, 0),
  };

  it('按有效 Token 排名取前三，其余并成「其他」；份额写整数百分比', () => {
    const tools = buildTools(TOOLS, 'dark');
    expect(tools?.items.map((item) => [item.name, item.percent])).toEqual([['Codex', '50%'], ['Claude', '34%'], ['Antigravity', '13%']]);
    expect(tools?.items).toHaveLength(TOOL_COMPOSITION_TOP);
    expect(tools?.other?.percent).toBe('3%');
    expect(tools!.items.reduce((sum, item) => sum + item.share, 0) + tools!.other!.share).toBeCloseTo(1);
  });

  it('颜色走共用槽位表：与看板同一视图前三名同色，深浅色各取各的', () => {
    const dark = buildTools(TOOLS, 'dark')!;
    const light = buildTools(TOOLS, 'light')!;
    const dashboard = toolColorMap(['codex', 'claude', 'antigravity', 'opencode', 'minimax'], 'dark');
    expect(dark.items.map((item) => item.color)).toEqual(['codex', 'claude', 'antigravity'].map((id) => dashboard.get(id)));
    const dashboardLight = toolColorMap(['codex', 'claude', 'antigravity'], 'light');
    expect(light.items.map((item) => item.color)).toEqual(['codex', 'claude', 'antigravity'].map((id) => dashboardLight.get(id)));
    expect(light.items[0].color).not.toBe(dark.items[0].color);
  });

  it('有份额但四舍五入为 0 时写「<1%」；没有任何用量时不画', () => {
    expect(formatShare(0.004)).toBe('<1%');
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.444)).toBe('44%');
    const tiny = buildTools({ big: tool('codex', 100_000, 0), small: tool('claude', 1, 0) }, 'dark');
    expect(tiny?.items[1].percent).toBe('<1%');
    expect(buildTools({ idle: tool('idle', 0, 0) }, 'dark')).toBeNull();
    expect(buildTools(undefined, 'dark')).toBeNull();
    expect(buildTools({ bad: tool('codex', Number.NaN, 0) }, 'dark')).toBeNull();
  });

  it('同值保持原顺序（与看板排行同序）', () => {
    const tools = buildTools({ a: tool('claude', 10, 0), b: tool('codex', 10, 0) }, 'dark');
    expect(tools?.items.map((item) => item.id)).toEqual(['claude', 'codex']);
  });

  it('工具显示名：品牌大小写逐个写出，别名归一，其余首字母大写', () => {
    expect(toolDisplayName('opencode')).toBe('OpenCode');
    expect(toolDisplayName('KimiDesktop')).toBe('Kimi');
    expect(toolDisplayName(' codex ')).toBe('Codex');
    expect(toolDisplayName('')).toBe('未命名工具');
  });
});

describe('额度', () => {
  const NOW = new Date(2026, 6, 15, 14, 30).getTime();
  const minutes = (value: number) => new Date(NOW + value * 60_000).toISOString();

  function read(items: Array<[string, string, number, 'ok' | 'stale']>): WidgetQuotaRead {
    return {
      highlights: items.map(([providerId, windowId, remaining, status]): QuotaWindowHighlight => ({
        providerId,
        providerName: providerId === 'claude' ? 'Claude' : 'Codex',
        windowId,
        windowLabel: windowId === 'five-hour' ? '5 小时' : '每周',
        remaining,
        status,
        level: quotaLevel(remaining),
        resetsAt: minutes(38),
      })),
      names: new Map([['claude', 'Claude'], ['codex', 'Codex']]),
      parts: new Map([['claude:five-hour', { group: 'Claude Pro / Max', label: '5 小时', observedAt: minutes(-25) }]]),
    };
  }

  it('还没读到是「读取中」，钉住的来源读不到时写出它的名字，没有窗口是「空」', () => {
    expect(buildCardQuota(null, null)).toEqual({ kind: 'loading' });
    expect(buildCardQuota(read([['codex', 'weekly', 36, 'ok']]), 'claude')).toEqual({ kind: 'pinned-missing', name: 'Claude' });
    expect(buildCardQuota(read([]), 'gemini')).toEqual({ kind: 'pinned-missing', name: 'gemini' });
    expect(buildCardQuota(read([]), null)).toEqual({ kind: 'empty' });
  });

  it('窗口带分组与短名，读不到分组时退回整名；历史快照标记 stale', () => {
    const quota = buildCardQuota(read([['claude', 'five-hour', 14, 'stale'], ['codex', 'weekly', 36, 'ok']]), null);
    expect(quota.kind).toBe('ready');
    if (quota.kind !== 'ready') return;
    expect(quota.items[0]).toMatchObject({ provider: 'Claude', group: 'Claude Pro / Max', label: '5 小时', available: 14, level: 'critical', stale: true });
    expect(quota.items[1]).toMatchObject({ provider: 'Codex', group: '', label: '每周', window: '每周', stale: false });
  });

  it('重置时间：分钟、小时、天三档，已过重置时间写「待刷新」', () => {
    expect(describeReset(minutes(38), NOW)).toEqual({ long: '38 分钟后重置', short: '38 分钟后' });
    expect(describeReset(minutes(119), NOW)).toEqual({ long: '1 小时 59 分后重置', short: '1 小时 59 分后' });
    expect(describeReset(minutes(4_260), NOW)).toEqual({ long: '2 天 23 小时后重置', short: '2 天 23 小时后' });
    expect(describeReset(minutes(-3), NOW)).toEqual({ long: '已到重置时间，待刷新', short: '待刷新' });
    expect(describeReset(undefined, NOW)).toBeNull();
    expect(describeReset('not-a-date', NOW)).toBeNull();
  });

  it('圆环的文字替代：来源、窗口、可用百分比、档位与重置时间；历史快照写待刷新与观测时间', () => {
    const item: CardQuotaItem = {
      key: 'claude:five-hour', provider: 'Claude', group: '', label: '5 小时', window: '5 小时',
      available: 14, level: 'critical', stale: false, resetsAt: minutes(38),
    };
    expect(describeQuotaItem(item, NOW)).toBe('Claude · 5 小时，可用 14%，告急，38 分钟后重置');
    expect(quotaStateTail(item, NOW)).toBe('38 分钟后');
    const stale = { ...item, stale: true, observedAt: new Date(2026, 6, 15, 14, 5).toISOString() };
    expect(describeQuotaItem(stale, NOW)).toBe('Claude · 5 小时，可用 14%，告急，待刷新，观测于 7/15 14:05');
    expect(quotaStateTail(stale, NOW)).toBe('待刷新');
    expect(describeQuotaItem({ ...item, available: 55, level: 'ok', resetsAt: undefined }, NOW)).toBe('Claude · 5 小时，可用 55%，充足');
    expect(quotaStateTail({ ...item, resetsAt: undefined }, NOW)).toBeNull();
  });

  it('没画出来的窗口去哪看全：不超过 6 个换「额度总览」，超过 6 个去主窗口（R-52 P3-1）', () => {
    expect(hiddenQuotaHint(6)).toBe('换「额度总览」板式可看全部');
    expect(hiddenQuotaHint(7)).toBe('主窗口的额度看板可看全部');
  });
});

describe('整张卡的显示模型', () => {
  const base = { range: 'today' as const, error: '', quota: { kind: 'loading' as const }, theme: 'dark' as const };

  it('还没有统计时数字位全是「—」，不画 0', () => {
    const model = buildCardModel({ ...base, stats: null, loadedAt: null });
    expect(model).toMatchObject({
      loading: true, tokens: '—', cost: '—', records: '—', input: '—', output: '—', cache: '—',
      change: null, trend: null, tools: null, rangeLabel: '今日',
      status: { text: '正在读取…', error: false, notable: true },
    });
  });

  it('有效 Token = 输入 + 输出（缓存单列），预估费用与记录数照汇总格式', () => {
    const model = buildCardModel({ ...base, stats: stats({ summary: summary({ totalTokens: 99_999 }) }), loadedAt: new Date() });
    expect(model).toMatchObject({ loading: false, tokens: '1.0K', cost: '≈$3.21', records: '42', input: '600', output: '400', cache: '12.0K' });
    expect(model.status).toMatchObject({ error: false, notable: false });
    expect(model.status.text).toMatch(/^更新于 /);
  });

  it('读到了但不可证明的值写「不可得」或「—」，绝不写 $0 或 0', () => {
    const model = buildCardModel({
      ...base,
      stats: stats({ summary: summary({ totalCost: Number.NaN, inputTokens: Number.NaN, totalRequests: Number.NaN, cachedTokens: Number.NaN }) }),
      loadedAt: new Date(),
    });
    expect(model).toMatchObject({ tokens: '—', cost: '不可得', records: '—', input: '—', cache: '—' });
    expect(buildCardModel({ ...base, stats: stats({ summary: summary({ totalCost: -1 }) }), loadedAt: new Date() }).cost).toBe('不可得');
  });

  it('历史快照与读取失败写在「更新于」的位置，并标成需要写出来的状态', () => {
    const snapshot = buildCardModel({ ...base, stats: stats({ meta: { stale: true } }), loadedAt: new Date() });
    expect(snapshot.status.text).toMatch(/^历史快照 · 更新于 /);
    expect(snapshot.status.notable).toBe(true);
    const failed = buildCardModel({ ...base, stats: null, loadedAt: null, error: '读取失败：数据库忙' });
    expect(failed.status).toEqual({ text: '读取失败，请重试', error: true, notable: true });
  });
});

describe('方案 §6.4 尺寸', () => {
  it('桌面小组件 364 宽，四种板式各自的高；托盘挂件多 26px 顶栏', () => {
    expect(widgetCardSize('desktop', 'usage')).toEqual({ width: 364, height: 388 });
    expect(widgetCardSize('desktop', 'combo')).toEqual({ width: 364, height: 172 });
    expect(widgetCardSize('desktop', 'quota')).toEqual({ width: 364, height: 272 });
    expect(widgetCardSize('desktop', 'compact')).toEqual({ width: 364, height: 104 });
    expect(widgetCardSize('popover', 'usage')).toEqual({ width: 364, height: 414 });
    expect(widgetCardSize('popover', 'combo')).toEqual({ width: 364, height: 198 });
    expect(widgetCardSize('popover', 'quota')).toEqual({ width: 364, height: 298 });
    expect(widgetCardSize('popover', 'compact')).toEqual({ width: 364, height: 130 });
  });
});
