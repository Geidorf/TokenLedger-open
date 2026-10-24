import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setLangPreference } from '../i18n';
import type { ComparisonSeriesPoint, DailyCost, DataScope, RangeKey, StatsData, Summary } from '../types';
import { describePeriodForecast, forecastFromStats, forecastInputFromStats, type MetricForecast } from '../utils/forecast';
import {
  buildForecastOverlay,
  formatForecastTriple,
  TrendPanel,
  trendForecast,
  withMetricLabel,
  type TrackViewMode,
} from './TrendPanel';

// 记录传给图表的完整配置（含 tooltip 函数），便于检查预测叠加层。
let lastOption: any = null;

vi.mock('./EChart', () => {
  const Mock = ({ option, ariaLabel }: { option: any; ariaLabel?: string }) => {
    lastOption = option;
    return <div data-testid="echart-mock" data-aria-label={ariaLabel} />;
  };
  return { EChart: Mock, default: Mock };
});

const TZ = 'Asia/Shanghai';

function summaryOf(series: ComparisonSeriesPoint[]): Summary {
  const tokens = series.reduce((sum, point) => sum + point.tokens, 0);
  const cost = series.reduce((sum, point) => sum + point.cost, 0);
  const requests = series.reduce((sum, point) => sum + point.requests, 0);
  const input = Math.round(tokens * 0.7);
  return {
    totalTokens: tokens,
    inputTokens: input,
    outputTokens: tokens - input,
    cachedTokens: 0,
    totalCost: cost,
    totalRequests: requests,
    avgTokensPerReq: requests > 0 ? Math.round(tokens / requests) : 0,
  };
}

function dates(first: string, count: number): string[] {
  const [year, month, day] = first.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => (
    new Date(Date.UTC(year, month - 1, day + index)).toISOString().slice(0, 10)
  ));
}

interface FixtureOptions {
  range: 'month' | 'week' | 'custom';
  current: ComparisonSeriesPoint[];
  previous: ComparisonSeriesPoint[];
  currentEnd: string;
  generatedAt?: string;
  stale?: boolean;
  query?: { start: string; end: string };
  dailyCosts?: StatsData['dailyCosts'];
}

function statsFor(options: FixtureOptions): StatsData {
  const currentStart = `${options.current[0].bucket}T00:00:00+08:00`;
  const previousStart = `${options.previous[0].bucket}T00:00:00+08:00`;
  const current = summaryOf(options.current);
  const previous = summaryOf(options.previous);
  return {
    summary: current,
    tools: {},
    models: {},
    trends: [],
    heatmap: {},
    history: [],
    ...(options.dailyCosts ? { dailyCosts: options.dailyCosts } : {}),
    comparison: {
      window: {
        kind: options.range === 'week' ? 'weekOverWeek' : options.range === 'custom' ? 'periodOverPeriod' : 'monthOverMonth',
        timezone: TZ,
        bucket: 'day',
        currentStart,
        currentEnd: options.currentEnd,
        previousStart,
        previousEnd: options.currentEnd.replace(options.current[0].bucket.slice(0, 7), options.previous[0].bucket.slice(0, 7)),
        alignedThrough: '同进度',
      },
      current: { summary: current, series: options.current },
      previous: { summary: previous, series: options.previous },
      delta: {
        tokens: { absolute: current.totalTokens - previous.totalTokens, percent: 10, direction: 'up' },
        requests: { absolute: current.totalRequests - previous.totalRequests, percent: 10, direction: 'up' },
        cost: { absolute: current.totalCost - previous.totalCost, percent: 10, direction: 'up' },
      },
    },
    meta: {
      contractVersion: 2,
      generatedAt: options.generatedAt ?? options.currentEnd,
      timezone: TZ,
      range: options.range,
      ...(options.stale ? { stale: true } : {}),
      query: {
        range: options.range,
        timezone: TZ,
        machines: [],
        tools: [],
        models: [],
        search: null,
        tokenMode: 'effective',
        ...(options.query ?? {}),
      },
    },
  } as StatsData;
}

/** 2026-07：1–14 日已完成（100K/110K/120K 循环，每天 $1），15 日 14:30 进行中，已记 40K / $0.40。 */
function julyStats(overrides: Partial<FixtureOptions> = {}): StatsData {
  const current = dates('2026-07-01', 15).map((bucket, index) => ({
    bucket,
    tokens: index === 14 ? 40_000 : 100_000 + (index % 3) * 10_000,
    requests: 10,
    cost: index === 14 ? 0.4 : 1,
  }));
  const previous = dates('2026-06-01', 15).map((bucket) => ({ bucket, tokens: 90_000, requests: 9, cost: 0.9 }));
  return statsFor({ range: 'month', current, previous, currentEnd: '2026-07-15T14:30:00+08:00', ...overrides });
}

/** 7 月云端 dailyCosts：逐日列出金额，`unknown` 里的日子标为 unavailable（费用未知）。 */
function julyDailyCosts(unknown: string[] = []): NonNullable<StatsData['dailyCosts']> {
  const days: DailyCost[] = julyStats().comparison!.current.series.map((point) => (
    unknown.includes(point.bucket)
      ? { date: point.bucket, amountUsd: null, status: 'unavailable', reason: 'missing-cost' }
      : { date: point.bucket, amountUsd: point.cost, status: 'recorded-estimate' }
  ));
  return { coverage: { start: '2026-07-01', end: '2026-07-15', timezone: TZ, state: 'complete' }, days };
}

/** 本周（2026-07-13 周一起）：周一、周二已完成，周三 14:30 进行中。 */
function weekStats(): StatsData {
  const current = dates('2026-07-13', 3).map((bucket, index) => ({ bucket, tokens: index === 2 ? 30_000 : 120_000, requests: 5, cost: 0.5 }));
  const previous = dates('2026-07-06', 3).map((bucket) => ({ bucket, tokens: 100_000, requests: 5, cost: 0.4 }));
  return statsFor({ range: 'week', current, previous, currentEnd: '2026-07-15T14:30:00+08:00' });
}

/** 3/31 14:00 生成的快照：本机把本期截到与 2/28 对齐的 3/28 14:00，序列只到 3/28（月末同期截短）。 */
function clippedMarchStats(): StatsData {
  const current = dates('2026-03-01', 28).map((bucket, index) => ({ bucket, tokens: index === 27 ? 60 : 100, requests: 1, cost: 0.01 }));
  const previous = dates('2026-02-01', 28).map((bucket) => ({ bucket, tokens: 100, requests: 1, cost: 0.01 }));
  return statsFor({
    range: 'month',
    current,
    previous,
    currentEnd: '2026-03-28T14:00:00+08:00',
    generatedAt: '2026-03-31T14:00:00+08:00',
  });
}

/** 7/1–7/10 的自定义区间，7/15 生成：区间已经结束，不需要预测。 */
function endedCustomStats(): StatsData {
  const current = dates('2026-07-01', 10).map((bucket) => ({ bucket, tokens: 100_000, requests: 10, cost: 1 }));
  const previous = dates('2026-06-21', 10).map((bucket) => ({ bucket, tokens: 90_000, requests: 9, cost: 0.9 }));
  return statsFor({
    range: 'custom',
    current,
    previous,
    currentEnd: '2026-07-10 23:59:59',
    generatedAt: '2026-07-15T14:30:00+08:00',
    query: { start: '2026-07-01', end: '2026-07-10' },
  });
}

interface TrendExtras {
  scope?: DataScope;
  initialTrack?: TrackViewMode;
}

/**
 * 总览渲染：待上传记录数是必填参数，每个用例都要明确给出（T10.159 P2-1），
 * 没有“不传就当作完整”的写法。
 */
function renderTrend(stats: StatsData, range: RangeKey, pendingUploads: number | null, extra: TrendExtras = {}) {
  return render(
    <TrendPanel
      trends={[]}
      activeTools={[]}
      comparison={stats.comparison}
      range={range}
      scope={extra.scope ?? 'local'}
      initialTrack={extra.initialTrack}
      overviewStats={stats}
      pendingUploads={pendingUploads}
    />,
  );
}

const seriesNamed = (name: string) => lastOption.series.find((series: { name: string }) => series.name === name);
const hasForecastSeries = () => lastOption.series.some((series: { name: string }) => String(series.name).startsWith('预测'));
const forecastLineOf = (title: string) => screen.getByText(title).closest('details') as HTMLElement;
/** 趋势卡小指标格：标签所在的 .comparison-kpi。 */
const kpiCellOf = (label: string) => screen.getByText(label).closest('.comparison-kpi') as HTMLElement;
/** 规格 §5.1：可见文字与读屏都不得出现百分比区间、“置信”“把握”或“大概率”。 */
const FORBIDDEN_FORECAST_WORDING = /\d+(?:\.\d+)?%\s*[–-]\s*\d+(?:\.\d+)?%|置信|把握|大概率|参考区间/;

const julyTokenCopy = () => describePeriodForecast(forecastFromStats(julyStats(), 'month', { scope: 'local' }), 'tokens')!;

describe('TrendPanel 周期末预测接入（T10.159 · T10.153 D2）', () => {
  beforeEach(() => {
    lastOption = null;
  });

  it('月末预测的标签、数值、粗略范围与方法同时可见，读屏读规则层整句', () => {
    renderTrend(julyStats(), 'month', 0);
    const copy = julyTokenCopy();
    const line = forecastLineOf('月末预测');
    expect(line).not.toBeNull();
    expect(within(line).getByText('预测')).toHaveClass('badge');
    // 已完成 1,530,000 + 17 天 × 日均 109,285.7 = 3,387,857 → 3.4M，数值自带“有效 Token”，不另写指标名。
    expect(copy.value).toBe('3.4M 有效 Token');
    expect(within(line).getByText('3.4M 有效 Token')).toBeInTheDocument();
    expect(within(line).queryByText('有效 Token')).not.toBeInTheDocument();
    expect(copy.interval).toMatch(/^粗略范围 [\d.]+M–[\d.]+M$/);
    expect(within(line).getByText(copy.interval!)).toBeInTheDocument();
    expect(within(line).getByText('按已完成 14 天的日均外推；范围假设之后的用量与这些天相近')).toBeInTheDocument();
    for (const caveat of copy.caveats) expect(within(line).getByText(caveat)).toBeInTheDocument();
    const summary = line.querySelector('summary') as HTMLElement;
    expect(summary).toHaveTextContent('计算方法');
    expect(summary).toHaveAttribute('aria-label', copy.ariaLabel);
    expect(copy.ariaLabel).toMatch(/^预测：月末预测 3\.4M 有效 Token，粗略范围 /);
    expect(line.querySelector('p')).toHaveTextContent(copy.detail);
    expect(copy.detail).toContain('范围是粗略范围，不是概率保证');
    expect(line.textContent).not.toMatch(FORBIDDEN_FORECAST_WORDING);
    expect(copy.ariaLabel).not.toMatch(FORBIDDEN_FORECAST_WORDING);
    expect(screen.getByTestId('echart-mock').getAttribute('data-aria-label')).toContain(copy.ariaLabel);
  });

  it('费用视角给费用预测，可见文字与读屏都写出指标名“预估费用”；双轨两行都显示', () => {
    const { unmount } = renderTrend(julyStats(), 'month', 0, { initialTrack: 'cost' });
    // 已完成 $14 + 17 天 × $1 = $31。
    const line = forecastLineOf('月末预测');
    expect(within(line).getByText('≈$31')).toBeInTheDocument();
    expect(within(line).getByText('预估费用')).toBeInTheDocument();
    expect(within(line).getByText(/^粗略范围 \$[\d.]+–\$[\d.]+$/)).toBeInTheDocument();
    // T10.159 P3-3：读屏整句在标题后补上指标名，与可见文字一致。
    expect(line.querySelector('summary')?.getAttribute('aria-label')).toMatch(/^预测：月末预测 预估费用 ≈\$31，粗略范围 /);
    expect(screen.getAllByText('月末预测')).toHaveLength(1);
    unmount();

    renderTrend(julyStats(), 'month', 0, { initialTrack: 'dual' });
    expect(screen.getAllByText('月末预测')).toHaveLength(2);
    expect(screen.getByText('3.4M 有效 Token')).toBeInTheDocument();
    expect(screen.getByText('≈$31')).toBeInTheDocument();
  });

  it('双轨两行并列时，没有数字的那行写明是哪个指标（T10.159 P3-3）', () => {
    // 费用只在 7/1 有消耗：费用活跃日不足 2 天，Token 照常预测。
    const stats = julyStats();
    stats.comparison!.current.series = stats.comparison!.current.series.map((point, index) => ({ ...point, cost: index === 0 ? 1 : 0 }));
    renderTrend(stats, 'month', 0, { initialTrack: 'dual' });
    const lines = screen.getAllByText('月末预测').map((title) => title.closest('details') as HTMLElement);
    expect(lines).toHaveLength(2);
    const costLine = lines[1];
    expect(within(costLine).getByText('预估费用')).toBeInTheDocument();
    expect(within(costLine).getByText('已完成的日子里有消耗的不足 2 天，暂不预测')).toBeInTheDocument();
    expect(costLine.querySelector('summary')).toHaveAttribute(
      'aria-label',
      '预测：月末预测 预估费用。已完成的日子里有消耗的不足 2 天，暂不预测。',
    );
    // Token 行的数值自带指标名，不重复。
    expect(within(lines[0]).queryByText('有效 Token')).not.toBeInTheDocument();
    // 规则层整句格式变了也不丢指标名。
    expect(withMetricLabel('其它格式', '月末预测', '预估费用')).toBe('预估费用：其它格式');
  });

  it('累计走势画从“截至昨天的累计”起步的预测虚线与粗略范围色带，逐日走势不画未来', () => {
    renderTrend(julyStats(), 'month', 0);
    expect(lastOption.xAxis.data).toHaveLength(15);
    expect(hasForecastSeries()).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '累计走势' }));
    expect(lastOption.xAxis.data).toHaveLength(31);
    expect(lastOption.xAxis.data[30]).toBe('2026-07-31');

    const actual = lastOption.series[0];
    expect(actual.data[14]).toBe(1_570_000);
    expect(actual.data[15]).toBeNull();
    expect(lastOption.series[1].data[15]).toBeNull();

    const centre = seriesNamed('预测');
    const low = seriesNamed('预测下限');
    const band = seriesNamed('预测（粗略范围）');
    expect(centre.lineStyle.type).toBe('dashed');
    expect(centre.data[12]).toBeNull();
    expect(centre.data[13]).toBe(1_530_000);
    expect(centre.data[30]).toBe(3_387_857);
    expect(low.stack).toBe(band.stack);
    expect(band.areaStyle).toBeTruthy();
    expect(band.data[13]).toBe(0);
    expect(low.data[30]).toBeLessThan(centre.data[30]);
    expect(low.data[30] + band.data[30]).toBeGreaterThan(centre.data[30]);
    // 预测永不低于已记录量：今天的下限不低于截至现在的累计。
    expect(low.data[14]).toBeGreaterThanOrEqual(1_570_000);
    expect(screen.getByText('预测（粗略范围）')).toBeInTheDocument();

    const future = lastOption.tooltip.formatter([{ dataIndex: 20 }]);
    expect(future).toContain('2026-07-21');
    expect(future).toContain('预测 · 尚未发生');
    expect(future).toContain('粗略范围');
    expect(future).toContain('不是实际记录');
    expect(future).not.toMatch(/80%|NaN|undefined|参考区间/);
    const today = lastOption.tooltip.formatter([{ dataIndex: 14 }]);
    expect(today).toContain('预测今日结束累计');
    expect(today).toContain('粗略范围');
    expect(lastOption.tooltip.formatter([{ dataIndex: 13 }])).not.toContain('预测');
  });

  it('图上逐日预测点与文字行用同一套数值格式（规格 §5.1）', () => {
    const forecast = forecastFromStats(julyStats(), 'month', { scope: 'local' });
    const tokens = forecast.tokens!;
    const copy = julyTokenCopy();
    const tokenTriple = formatForecastTriple('tokens', tokens.projected!, tokens.low!, tokens.high!);
    expect(`${tokenTriple.point} 有效 Token`).toBe(copy.value);
    expect(`粗略范围 ${tokenTriple.low}–${tokenTriple.high}`).toBe(copy.interval);
    const cost = forecast.cost!;
    const costCopy = describePeriodForecast(forecast, 'cost')!;
    const costTriple = formatForecastTriple('cost', cost.projected!, cost.low!, cost.high!);
    expect(costTriple.point).toBe(costCopy.value);
    expect(`粗略范围 ${costTriple.low}–${costTriple.high}`).toBe(costCopy.interval);
  });

  it('双轨的累计走势只给文字行，不叠加预测图形', () => {
    renderTrend(julyStats(), 'month', 0, { initialTrack: 'dual' });
    fireEvent.click(screen.getByRole('button', { name: '累计走势' }));
    expect(hasForecastSeries()).toBe(false);
    expect(lastOption.xAxis.data).toHaveLength(15);
    expect(screen.getAllByText('月末预测')).toHaveLength(2);
  });

  it('本周完整日不足时写明还差几天、哪天起给出预测，双轨只说一次，也不画叠加层', () => {
    const { unmount } = renderTrend(weekStats(), 'week', 0);
    const line = forecastLineOf('本周预测（至周日）');
    expect(within(line).getByText('还需 1 个完整日（至少 3 天），7月16日 起给出预测')).toBeInTheDocument();
    expect(line.querySelector('strong')).toBeNull();
    expect(line.querySelector('summary')).toHaveAttribute(
      'aria-label',
      '预测：本周预测（至周日）。还需 1 个完整日（至少 3 天），7月16日 起给出预测。',
    );
    fireEvent.click(screen.getByRole('button', { name: '累计走势' }));
    expect(hasForecastSeries()).toBe(false);
    unmount();

    renderTrend(weekStats(), 'week', 0, { initialTrack: 'dual' });
    expect(screen.getAllByText('本周预测（至周日）')).toHaveLength(1);
    // 两项原因相同、只说一次时，这一行说的是两项，不标某一个指标。
    expect(within(forecastLineOf('本周预测（至周日）')).queryByText('预估费用')).not.toBeInTheDocument();
  });

  it('月末几天本期被同期对齐截短：单独说明原因，日均与单位费用写明截止日，不给数字也不显示成 0', () => {
    const clipped = clippedMarchStats();
    const method = '月末与上月按同日对齐，本月只统计到 3月28日，暂不预测';
    expect(forecastFromStats(clipped, 'month', { scope: 'local' })).toMatchObject({ status: 'unavailable', reason: 'comparison-clipped' });
    const state = trendForecast(clipped, 'month', 'local', 0);
    expect(state.forecast).toBeNull();
    expect(state.notice).toMatchObject({ title: '月末预测', method });
    expect(state.notice?.detail).toContain('核心指标的同期变化和这里的日均、单位费用都截至这一天');

    renderTrend(clipped, 'month', 0, { initialTrack: 'dual' });
    // 双轨也只说一次原因。
    expect(screen.getAllByText('月末预测')).toHaveLength(1);
    const line = forecastLineOf('月末预测');
    expect(within(line).getByText('预测')).toHaveClass('badge');
    expect(within(line).getByText(method)).toBeInTheDocument();
    expect(line.querySelector('strong')).toBeNull();
    expect(line.textContent).not.toMatch(/粗略范围|≈\$|有效 Token|(?:^|[^\d])0(?:\.0+)?(?:[KMB]|\s*有效)|\$0/);
    expect(line.querySelector('summary')).toHaveAttribute('aria-label', `预测：月末预测。${method}。`);
    // T10.159 P2-2：日均与单位费用都只统计到对齐日，和核心指标的同期变化用同一句说明。
    for (const label of ['日均有效 Token', '日均预估费用', '单位费用']) {
      const cell = kpiCellOf(label);
      expect(within(cell).getByText('截至 3月28日')).toBeInTheDocument();
      expect(within(cell).getByText(label)).toHaveAttribute('title', expect.stringContaining('只统计到 3月28日'));
    }
    expect(screen.getByTestId('echart-mock').getAttribute('data-aria-label')).toContain('按已完成 27 天，截至 3月28日');
    fireEvent.click(screen.getByRole('button', { name: '累计走势' }));
    expect(hasForecastSeries()).toBe(false);
  });

  it('同一份数据下原地切换语言，截短说明、预测标题与截止日跟着换（#109 评审 P2）', () => {
    renderTrend(clippedMarchStats(), 'month', 0, { initialTrack: 'dual' });
    expect(screen.getAllByText('截至 3月28日').length).toBeGreaterThan(0);
    try {
      act(() => setLangPreference('en'));
      const line = forecastLineOf('Month-end forecast');
      expect(line.textContent).toContain('Month-end is aligned with last month by date');
      expect(line.textContent).not.toMatch(/[\u4e00-\u9fff]/);
      expect(screen.queryByText('截至 3月28日')).not.toBeInTheDocument();
    } finally {
      act(() => setLangPreference('zh'));
    }
  });

  it('平日不写截止日说明', () => {
    renderTrend(julyStats(), 'month', 0, { initialTrack: 'dual' });
    expect(screen.queryByText(/^截至 /)).not.toBeInTheDocument();
  });

  it('缓存快照只说明原因；已结束的区间、专属看板（不传总览快照）与今日范围都不预测', () => {
    const stale = trendForecast(julyStats({ stale: true }), 'month', 'local', 0);
    expect(stale.forecast).toBeNull();
    expect(stale.notice).toMatchObject({ title: '月末预测', method: '当前是缓存快照，生成那天可能已经过去，暂不预测' });
    const { unmount: unmountStale } = renderTrend(julyStats({ stale: true }), 'month', 0);
    const staleLine = forecastLineOf('月末预测');
    expect(staleLine.querySelector('strong')).toBeNull();
    expect(staleLine).not.toHaveTextContent('粗略范围');
    fireEvent.click(screen.getByRole('button', { name: '累计走势' }));
    expect(hasForecastSeries()).toBe(false);
    unmountStale();

    // 缓存快照遇上月末截短也说明原因，不再什么都不显示。
    expect(trendForecast({ ...clippedMarchStats(), meta: { ...clippedMarchStats().meta, stale: true } }, 'month', 'local', 0).notice)
      .toMatchObject({ title: '月末预测', method: '当前是缓存快照，生成那天可能已经过去，暂不预测' });
    expect(trendForecast(julyStats(), 'today', 'local', 0)).toEqual({ forecast: null, notice: null });
    expect(trendForecast(endedCustomStats(), 'custom', 'local', 0)).toEqual({ forecast: null, notice: null });

    const stats = julyStats();
    render(<TrendPanel trends={[]} activeTools={[]} comparison={stats.comparison} range="month" scope="local" />);
    expect(screen.queryByText('月末预测')).not.toBeInTheDocument();
    // 没有预测时仍然保留逐日/累计切换。
    expect(screen.getByRole('group', { name: '逐日与累计走势切换' })).toBeInTheDocument();
  });
});

describe('云端来源完整性（T10.159 P2-1：未知不是 0）', () => {
  const unknownMethod = '无法确认本机是否还有待上传的记录，云端数据可能不完整，暂不预测';

  beforeEach(() => {
    lastOption = null;
  });

  it('只有明确读到 0 条待上传记录才预测；未知与 > 0 都不给数字、说明原因', () => {
    expect(trendForecast(julyStats(), 'month', 'cloud', 0).forecast).toMatchObject({ status: 'ok' });

    const pending = trendForecast(julyStats(), 'month', 'cloud', 3);
    expect(pending.forecast).toBeNull();
    expect(pending.notice).toMatchObject({ title: '月末预测', method: '本机还有 3 条记录待上传，云端数据可能不完整，暂不预测' });

    const unknown = trendForecast(julyStats(), 'month', 'cloud', null);
    expect(unknown.forecast).toBeNull();
    expect(unknown.notice).toMatchObject({ title: '月末预测', method: unknownMethod });
    expect(unknown.notice?.detail).toContain('读不到不等于没有');
    // 运行期传来的非法数量同样按未知处理，不当作 0。
    expect(trendForecast(julyStats(), 'month', 'cloud', Number.NaN).notice?.method).toBe(unknownMethod);
    expect(trendForecast(julyStats(), 'month', 'cloud', -1).notice?.method).toBe(unknownMethod);

    // 本机作用域不看上传状态。
    expect(trendForecast(julyStats(), 'month', 'local', null).forecast).toMatchObject({ status: 'ok' });
    // 已结束的区间本来就不预测，也不因来源不完整多一行说明。
    expect(trendForecast(endedCustomStats(), 'custom', 'cloud', 3)).toEqual({ forecast: null, notice: null });
  });

  it('界面：待上传数未知时云端预测行只写原因，不画预测线', () => {
    renderTrend(julyStats(), 'month', null, { scope: 'cloud', initialTrack: 'dual' });
    expect(screen.getAllByText('月末预测')).toHaveLength(1);
    const line = forecastLineOf('月末预测');
    expect(within(line).getByText(unknownMethod)).toBeInTheDocument();
    expect(line.querySelector('strong')).toBeNull();
    expect(line).not.toHaveTextContent(/粗略范围|有效 Token|≈\$/);
    expect(line.querySelector('summary')).toHaveAttribute('aria-label', `预测：月末预测。${unknownMethod}。`);
    fireEvent.click(screen.getByRole('button', { name: '累计走势' }));
    expect(hasForecastSeries()).toBe(false);
  });

  it('界面：已知有待上传记录时写出条数', () => {
    renderTrend(julyStats(), 'month', 1234, { scope: 'cloud' });
    expect(within(forecastLineOf('月末预测')).getByText('本机还有 1,234 条记录待上传，云端数据可能不完整，暂不预测')).toBeInTheDocument();
  });

  it('总览漏传待上传数是编译错误；绕过类型检查时按未知处理，云端不预测', () => {
    const stats = julyStats();
    render(
      // @ts-expect-error 总览（传了 overviewStats）必须明确给出 pendingUploads，没有缺省值。
      <TrendPanel trends={[]} activeTools={[]} comparison={stats.comparison} range="month" scope="cloud" overviewStats={stats} />,
    );
    expect(within(forecastLineOf('月末预测')).getByText(unknownMethod)).toBeInTheDocument();
    expect(screen.queryByText('3.4M 有效 Token')).not.toBeInTheDocument();
  });
});

describe('云端费用格按逐日费用核实（T10.159 P3-2：未知费用不按 $0 计算）', () => {
  beforeEach(() => {
    lastOption = null;
  });

  it('没有逐日费用时费用预测与两个费用格都写“不可得”，Token 照常', () => {
    renderTrend(julyStats(), 'month', 0, { scope: 'cloud', initialTrack: 'dual' });
    expect(screen.getByText('3.4M 有效 Token')).toBeInTheDocument();
    expect(screen.getByText('费用预测不可得：数据源未提供可验证的逐日费用')).toBeInTheDocument();
    const average = kpiCellOf('日均预估费用');
    expect(within(average).getByText('不可得')).toBeInTheDocument();
    expect(within(average).getByText('云端未提供可验证的逐日费用，不按 $0 计算')).toBeInTheDocument();
    expect(average).not.toHaveTextContent('≈$');
    const unit = kpiCellOf('单位费用');
    expect(within(unit).getByText('不可得')).toBeInTheDocument();
    expect(unit).not.toHaveTextContent('≈$');
    // Token 日均不受影响。
    expect(within(kpiCellOf('日均有效 Token')).getByText('109.3K')).toBeInTheDocument();
  });

  it('已完成的日子里有费用未知时，日均预估费用与单位费用都不可得，并写明几天', () => {
    renderTrend(julyStats({ dailyCosts: julyDailyCosts(['2026-07-05']) }), 'month', 0, { scope: 'cloud', initialTrack: 'dual' });
    expect(screen.getByText('费用预测不可得：本月有 1 天的费用未知')).toBeInTheDocument();
    const average = kpiCellOf('日均预估费用');
    expect(within(average).getByText('不可得')).toBeInTheDocument();
    expect(within(average).getByText('有 1 天的费用未知，不按 $0 计算')).toBeInTheDocument();
    const unit = kpiCellOf('单位费用');
    expect(within(unit).getByText('不可得')).toBeInTheDocument();
    expect(within(unit).getByText('有 1 天的费用未知，不按 $0 计算')).toBeInTheDocument();
  });

  it('云端逐日费用判为不可得的桶在 tooltip 里写「不可得」、不算差值，累计从此中断（T10.197 评审 P3-8）', () => {
    renderTrend(julyStats({ dailyCosts: julyDailyCosts(['2026-07-05']) }), 'month', 0, { scope: 'cloud', initialTrack: 'dual' });
    const tooltip = (dataIndex: number) => lastOption.tooltip.formatter([{ dataIndex }]);
    const day5 = tooltip(4); // 2026-07-05：dailyCosts 判为不可得，序列里仍有数值也不当真。
    const day5Cost = day5.slice(day5.indexOf('预估费用:'), day5.indexOf('截至此时累计'));
    expect(day5Cost).toContain('不可得');
    expect(day5Cost).not.toContain('≈$1.00');
    expect(day5Cost).not.toContain('−100.0%'); // 复评探针 C 报的假跌幅。
    expect(day5.slice(day5.indexOf('截至此时累计'))).toContain('不可得'); // 累计从这一桶起中断。
    const day6 = tooltip(5); // 2026-07-06：自身费用未受影响，但累计仍延续中断。
    const day6Cost = day6.slice(day6.indexOf('预估费用:'), day6.indexOf('截至此时累计'));
    expect(day6Cost).toContain('≈$1.00');
    expect(day6.slice(day6.indexOf('截至此时累计'))).toContain('不可得');
  });

  it('只有进行中的今天费用未知：日均照常，单位费用含今天所以不可得', () => {
    renderTrend(julyStats({ dailyCosts: julyDailyCosts(['2026-07-15']) }), 'month', 0, { scope: 'cloud', initialTrack: 'dual' });
    expect(within(kpiCellOf('日均预估费用')).getByText('≈$1.00')).toBeInTheDocument();
    expect(within(kpiCellOf('单位费用')).getByText('不可得')).toBeInTheDocument();
  });

  it('逐日费用都可证时显示金额，与本机一致', () => {
    renderTrend(julyStats({ dailyCosts: julyDailyCosts() }), 'month', 0, { scope: 'cloud', initialTrack: 'dual' });
    expect(within(kpiCellOf('日均预估费用')).getByText('≈$1.00')).toBeInTheDocument();
    // $14.40 ÷ 1,570,000 有效 Token × 1,000,000 = $9.17。
    expect(within(kpiCellOf('单位费用')).getByText('≈$9.17/百万 Token')).toBeInTheDocument();
    expect(screen.getByText('≈$31')).toBeInTheDocument();
  });

  it('本机作用域逐行费用已估算，不需要逐日费用', () => {
    renderTrend(julyStats(), 'month', 0, { initialTrack: 'dual' });
    expect(within(kpiCellOf('日均预估费用')).getByText('≈$1.00')).toBeInTheDocument();
    expect(within(kpiCellOf('单位费用')).getByText('≈$9.17/百万 Token')).toBeInTheDocument();
  });
});

describe('formatForecastTriple（规格 §5.1 数值格式）', () => {
  it('Token 按点值取单位，上下限同单位同精度，塌缩时多保留一位', () => {
    expect(formatForecastTriple('tokens', 3_000, 2_605, 3_395)).toEqual({ point: '3.0K', low: '2.6K', high: '3.4K' });
    expect(formatForecastTriple('tokens', 999_600, 900_000, 1_100_000)).toEqual({ point: '1.0M', low: '0.9M', high: '1.1M' });
    expect(formatForecastTriple('tokens', 1_200_000_000, 1_000_000_000, 1_400_000_000)).toEqual({ point: '1.2B', low: '1.0B', high: '1.4B' });
    expect(formatForecastTriple('tokens', 500, 400, 600)).toEqual({ point: '500', low: '400', high: '600' });
  });

  it('金额先按一位小数舍入再判断量级，点值带 ≈，上下限相同也多保留一位', () => {
    expect(formatForecastTriple('cost', 9.96, 8, 12)).toEqual({ point: '≈$10', low: '$8', high: '$12' });
    expect(formatForecastTriple('cost', 4.24, 3.5, 5.1)).toEqual({ point: '≈$4.2', low: '$3.5', high: '$5.1' });
    expect(formatForecastTriple('cost', 31, 30.8, 31.2)).toEqual({ point: '≈$31.0', low: '$30.8', high: '$31.2' });
  });

  it('正的小额不显示成 $0：已记 $0.04 时下限写 $0.04，两位小数仍为 0 时写 <$0.01（T10.159 P3-4）', () => {
    expect(formatForecastTriple('cost', 0.3, 0.04, 0.6)).toEqual({ point: '≈$0.30', low: '$0.04', high: '$0.60' });
    expect(formatForecastTriple('cost', 0.01, 0.004, 0.02)).toEqual({ point: '≈$0.01', low: '<$0.01', high: '$0.02' });
    expect(formatForecastTriple('cost', 0.004, 0.002, 0.009)).toEqual({ point: '<$0.01', low: '<$0.01', high: '$0.01' });
    // 真实的 $0 仍写 $0.0，不写成 <$0.01。
    expect(formatForecastTriple('cost', 0.5, 0, 1)).toEqual({ point: '≈$0.5', low: '$0.0', high: '$1.0' });
  });
});

describe('buildForecastOverlay', () => {
  const metric = (overrides: Partial<MetricForecast> = {}): MetricForecast => ({
    metric: 'tokens',
    status: 'ok',
    reason: null,
    completedTotal: 200,
    inProgress: 10,
    typicalDaily: 100,
    projected: 500,
    low: 400,
    high: 600,
    trajectory: [
      { date: '2026-07-03', point: 300, low: 260, high: 340 },
      { date: '2026-07-04', point: 400, low: 330, high: 470 },
      { date: '2026-07-05', point: 500, low: 400, high: 600 },
    ],
    activeDays: 2,
    unknownDays: 0,
    peakShare: 0.5,
    peakInfluence: null,
    recentDaily: null,
    recentShift: null,
    autocorrelation: null,
    weekdayMixRisk: false,
    unseenDayType: null,
    ...overrides,
  });
  const buckets = ['2026-07-01', '2026-07-02', '2026-07-03'];

  it('从昨天的累计起步，今天之后追加未来日期，色带为上限减下限', () => {
    const overlay = buildForecastOverlay(metric(), buckets)!;
    expect(overlay.futureDates).toEqual(['2026-07-04', '2026-07-05']);
    expect(overlay.startIndex).toBe(2);
    expect(overlay.centre).toEqual([null, 200, 300, 400, 500]);
    expect(overlay.low).toEqual([null, 200, 260, 330, 400]);
    expect(overlay.band).toEqual([null, 0, 80, 140, 200]);
  });

  it('轨迹与本期末桶对不上、数据不足或只有一个桶时不画', () => {
    expect(buildForecastOverlay(metric(), ['2026-07-01', '2026-07-02'])).toBeNull();
    expect(buildForecastOverlay(metric({ status: 'insufficient' }), buckets)).toBeNull();
    expect(buildForecastOverlay(metric({ completedTotal: null }), buckets)).toBeNull();
    expect(buildForecastOverlay(metric(), ['2026-07-03'])).toBeNull();
    expect(buildForecastOverlay(null, buckets)).toBeNull();
    expect(buildForecastOverlay(metric({ status: 'partial' }), buckets)).not.toBeNull();
  });
});

describe('T10.251 PC统计视角连续切换与未知费用折线', () => {
  it.each(['cost', 'dual'] as const)('从%s切到无同期的今年，指标说明与实际Token图一致，回来保留偏好', (initialTrack) => {
    const stats = julyStats();
    const { rerender } = renderTrend(stats, 'month', 0, { initialTrack });
    rerender(<TrendPanel trends={[{date:'2026-07',codex:100}]} activeTools={[]} range="year" scope="local" />);
    const context = screen.getByLabelText('当前趋势呈现方式');
    expect(context).toHaveTextContent('指标：有效 Token');
    expect(context).not.toHaveTextContent(/USD|双轴/);
    expect(screen.queryByRole('group', { name: '趋势呈现视角' })).not.toBeInTheDocument();
    rerender(<TrendPanel trends={[]} activeTools={[]} range="month" scope="local" comparison={stats.comparison} overviewStats={stats} pendingUploads={0} />);
    expect(screen.getByRole('button', {name:initialTrack==='cost'?'切换至费用视角':'切换至双轨对比'})).toHaveAttribute('aria-pressed','true');
  });

  it.each(['cost', 'dual'] as const)('%s逐日费用图在未知桶断线，已知零仍保留0，累计从未知桶停止', (initialTrack) => {
    const stats = julyStats({dailyCosts:julyDailyCosts(['2026-07-05'])});
    Object.assign(stats.comparison!.current.series[3], {cost: 0, tokens: 0, requests: 0});
    // 完整覆盖内无记录的空桶才是可证明的云端零费用。
    stats.dailyCosts!.days = stats.dailyCosts!.days.filter(day => day.date !== '2026-07-04');
    stats.comparison!.current.series[4].cost = 0; // 云端未知费用的既有传输形式，不得当作已知零。
    renderTrend(stats, 'month', 0, {scope:'cloud',initialTrack});
    const costSeries = () => lastOption.series.find((item:{name:string})=>item.name.startsWith('本月 预估费用'));
    expect(costSeries().data[3]).toBe(0);
    expect(costSeries().data[4]).toBeNull();
    expect(costSeries().data[5]).toBe(1);
    expect(lastOption.series.some((item: {name: string}) => item.name === '日均基准（预估费用）')).toBe(false);
    fireEvent.click(screen.getByRole('button', {name:'累计走势'}));
    expect(costSeries().data[3]).toBe(3);
    expect(costSeries().data[4]).toBeNull();
    expect(costSeries().data[5]).toBeNull();
  });
});


describe('T10.251 费用折线的已知与未知边界', () => {
  it('本机合法零费用仍绘制零和零均线', () => {
    const stats = julyStats();
    stats.comparison!.current.series.forEach(point => { point.cost = 0; });
    stats.comparison!.current.summary.totalCost = 0;
    renderTrend(stats, 'month', 0, {initialTrack: 'cost'});
    expect(lastOption.series.find((item: {name: string}) => item.name === '本月 预估费用').data.every((value: unknown) => value === 0)).toBe(true);
    expect(lastOption.series.find((item: {name: string}) => item.name === '日均基准（预估费用）').data.every((value: unknown) => value === 0)).toBe(true);
  });

  it('仅进行中的当天费用未知，不撤掉已完成日的可信费用均线', () => {
    const stats = julyStats({dailyCosts: julyDailyCosts(['2026-07-15'])});
    renderTrend(stats, 'month', 0, {scope: 'cloud', initialTrack: 'cost'});
    const cost = lastOption.series.find((item: {name: string}) => item.name === '本月 预估费用');
    expect(cost.data[13]).toBe(1);
    expect(cost.data[14]).toBeNull();
    expect(lastOption.series.find((item: {name: string}) => item.name === '日均基准（预估费用）').data[0]).toBe(1);
  });
});


describe('T10.251 自定义闭区间末日的预测适配', () => {
  it.each(['2026-07-10T23:59:59+08:00', '2026-07-10T15:59:59Z'])('生成时刻%s恰等于闭区间末秒时，完整末日不再预测', (generatedAt) => {
    const stats = endedCustomStats();
    stats.meta!.generatedAt = generatedAt;
    const input = forecastInputFromStats(stats, 'custom', {scope: 'local'});
    expect(input.ok && input.input.cutoffDayComplete).toBe(true);
    expect(forecastFromStats(stats, 'custom', {scope: 'local'})).toMatchObject({status: 'complete', completedDays: 10, remainingDays: 0});
    renderTrend(stats, 'custom', 0);
    fireEvent.click(screen.getByRole('button', {name: '累计走势'}));
    expect(screen.getByLabelText('趋势比较口径')).toHaveTextContent('已完成 10 天');
    expect(screen.queryByText(/截至7月10日预测/)).not.toBeInTheDocument();
    expect(hasForecastSeries()).toBe(false);
    expect(trendForecast(stats, 'custom', 'local', 0)).toEqual({forecast: null, notice: null});
  });

  it('尚未到自定义区间结束日时，不把某个中间日的闭秒误作整个区间结束', () => {
    const stats = endedCustomStats();
    stats.meta!.generatedAt = '2026-07-10T23:59:59+08:00';
    stats.meta!.query!.end = '2026-07-20';
    expect(forecastFromStats(stats, 'custom', {scope: 'local'}).status).not.toBe('complete');
  });
});
