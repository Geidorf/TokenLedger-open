import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonSeriesPoint, ToolStat, TrendPoint, UsageComparison } from '../types';
import {
  formatBucketLabel,
  getWeekdayName,
  isCloudComparisonBaselineUnverified,
  trendPresentationLabels,
  TrendPanel,
} from './TrendPanel';

// Mock EChart to inspect passed option and ariaLabel
vi.mock('./EChart', () => ({
  EChart: ({ option, ariaLabel }: { option: any; ariaLabel?: string }) => (
    <div data-testid="echart-mock" data-aria-label={ariaLabel} data-option={JSON.stringify(option)}>
      Chart Mock
    </div>
  ),
  default: ({ option, ariaLabel }: { option: any; ariaLabel?: string }) => (
    <div data-testid="echart-mock" data-aria-label={ariaLabel} data-option={JSON.stringify(option)}>
      Chart Mock
    </div>
  ),
}));

function createTodayComparison(): UsageComparison {
  const currentSeries: ComparisonSeriesPoint[] = Array.from({ length: 24 }, (_, i) => {
    const hour = (i < 10 ? '0' : '') + i + ':00';
    // 14:00 is peak (150K tokens, $0.50), 04:00 is valley (1K tokens, $0.005)
    let tokens = 10_000 + i * 2_000;
    let cost = 0.03 + i * 0.01;
    if (i === 14) {
      tokens = 150_000;
      cost = 0.50;
    } else if (i === 4) {
      tokens = 1_000;
      cost = 0.005;
    }
    return {
      bucket: hour,
      tokens,
      requests: Math.max(1, Math.round(tokens / 5000)),
      cost,
    };
  });

  const previousSeries: ComparisonSeriesPoint[] = Array.from({ length: 24 }, (_, i) => {
    const hour = (i < 10 ? '0' : '') + i + ':00';
    // Yesterday peak was at 11:00
    let tokens = 8_000 + i * 1_500;
    let cost = 0.02 + i * 0.008;
    if (i === 11) {
      tokens = 120_000;
      cost = 0.40;
    }
    return {
      bucket: hour,
      tokens,
      requests: Math.max(1, Math.round(tokens / 5000)),
      cost,
    };
  });

  const currentTotalTokens = currentSeries.reduce((sum, p) => sum + p.tokens, 0);
  const currentTotalCost = currentSeries.reduce((sum, p) => sum + p.cost, 0);
  const currentTotalReqs = currentSeries.reduce((sum, p) => sum + p.requests, 0);

  const prevTotalTokens = previousSeries.reduce((sum, p) => sum + p.tokens, 0);
  const prevTotalCost = previousSeries.reduce((sum, p) => sum + p.cost, 0);
  const prevTotalReqs = previousSeries.reduce((sum, p) => sum + p.requests, 0);

  return {
    window: {
      kind: 'dayOverDay',
      timezone: 'Asia/Shanghai',
      bucket: 'hour',
      currentStart: '2026-09-02T00:00:00+08:00',
      currentEnd: '2026-09-02T23:59:59+08:00',
      previousStart: '2026-09-01T00:00:00+08:00',
      previousEnd: '2026-09-01T23:59:59+08:00',
      alignedThrough: '18:00',
    },
    current: {
      summary: {
        totalTokens: currentTotalTokens,
        inputTokens: Math.round(currentTotalTokens * 0.7),
        outputTokens: Math.round(currentTotalTokens * 0.3),
        cachedTokens: 50_000,
        cacheReadTokens: 40_000,
        cacheWriteTokens: 10_000,
        totalCost: currentTotalCost,
        totalRequests: currentTotalReqs,
        avgTokensPerReq: Math.round(currentTotalTokens / currentTotalReqs),
      },
      series: currentSeries,
    },
    previous: {
      summary: {
        totalTokens: prevTotalTokens,
        inputTokens: Math.round(prevTotalTokens * 0.7),
        outputTokens: Math.round(prevTotalTokens * 0.3),
        cachedTokens: 40_000,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 10_000,
        totalCost: prevTotalCost,
        totalRequests: prevTotalReqs,
        avgTokensPerReq: Math.round(prevTotalTokens / prevTotalReqs),
      },
      series: previousSeries,
    },
    delta: {
      tokens: {
        absolute: currentTotalTokens - prevTotalTokens,
        percent: ((currentTotalTokens - prevTotalTokens) / prevTotalTokens) * 100,
        direction: 'up',
      },
      requests: {
        absolute: currentTotalReqs - prevTotalReqs,
        percent: ((currentTotalReqs - prevTotalReqs) / prevTotalReqs) * 100,
        direction: 'up',
      },
      cost: {
        absolute: currentTotalCost - prevTotalCost,
        percent: ((currentTotalCost - prevTotalCost) / prevTotalCost) * 100,
        direction: 'up',
      },
    },
  };
}

function createWeekComparison(): UsageComparison {
  // 2026-08-31 (Mon) to 2026-09-06 (Sun)
  const days = [
    '2026-08-31', // Mon
    '2026-09-01', // Tue
    '2026-09-02', // Wed
    '2026-09-03', // Thu
    '2026-09-04', // Fri
    '2026-09-05', // Sat
    '2026-09-06', // Sun
  ];

  const prevDays = [
    '2026-08-24',
    '2026-08-25',
    '2026-08-26',
    '2026-08-27',
    '2026-08-28',
    '2026-08-29',
    '2026-08-30',
  ];

  const currentSeries: ComparisonSeriesPoint[] = days.map((bucket, i) => ({
    bucket,
    tokens: i >= 5 ? 50_000 : 200_000, // Weekend lower than weekday
    requests: i >= 5 ? 20 : 80,
    cost: i >= 5 ? 0.20 : 0.80,
  }));

  const previousSeries: ComparisonSeriesPoint[] = prevDays.map((bucket, i) => ({
    bucket,
    tokens: i >= 5 ? 40_000 : 180_000,
    requests: i >= 5 ? 15 : 70,
    cost: i >= 5 ? 0.15 : 0.70,
  }));

  const currentTotalTokens = currentSeries.reduce((sum, p) => sum + p.tokens, 0);
  const currentTotalCost = currentSeries.reduce((sum, p) => sum + p.cost, 0);
  const currentTotalReqs = currentSeries.reduce((sum, p) => sum + p.requests, 0);

  const prevTotalTokens = previousSeries.reduce((sum, p) => sum + p.tokens, 0);
  const prevTotalCost = previousSeries.reduce((sum, p) => sum + p.cost, 0);
  const prevTotalReqs = previousSeries.reduce((sum, p) => sum + p.requests, 0);

  return {
    window: {
      kind: 'weekOverWeek',
      timezone: 'Asia/Shanghai',
      bucket: 'day',
      currentStart: '2026-08-31T00:00:00+08:00',
      currentEnd: '2026-09-06T23:59:59+08:00',
      previousStart: '2026-08-24T00:00:00+08:00',
      previousEnd: '2026-08-30T23:59:59+08:00',
      alignedThrough: '第 7 日',
    },
    current: {
      summary: {
        totalTokens: currentTotalTokens,
        inputTokens: currentTotalTokens * 0.7,
        outputTokens: currentTotalTokens * 0.3,
        cachedTokens: 100_000,
        totalCost: currentTotalCost,
        totalRequests: currentTotalReqs,
        avgTokensPerReq: Math.round(currentTotalTokens / currentTotalReqs),
      },
      series: currentSeries,
    },
    previous: {
      summary: {
        totalTokens: prevTotalTokens,
        inputTokens: prevTotalTokens * 0.7,
        outputTokens: prevTotalTokens * 0.3,
        cachedTokens: 90_000,
        totalCost: prevTotalCost,
        totalRequests: prevTotalReqs,
        avgTokensPerReq: Math.round(prevTotalTokens / prevTotalReqs),
      },
      series: previousSeries,
    },
    delta: {
      tokens: { absolute: currentTotalTokens - prevTotalTokens, percent: 12.5, direction: 'up' },
      requests: { absolute: currentTotalReqs - prevTotalReqs, percent: 14.3, direction: 'up' },
      cost: { absolute: currentTotalCost - prevTotalCost, percent: 11.2, direction: 'up' },
    },
  };
}

function createMonthComparison(): UsageComparison {
  const currentSeries: ComparisonSeriesPoint[] = Array.from({ length: 30 }, (_, i) => {
    const day = (i + 1 < 10 ? '0' : '') + (i + 1);
    const date = `2026-09-${day}`;
    // Day 15 is a spike day (300K tokens, $1.20 vs regular 50K tokens, $0.18)
    const isSpike = i === 14;
    return {
      bucket: date,
      tokens: isSpike ? 300_000 : 50_000,
      requests: isSpike ? 100 : 20,
      cost: isSpike ? 1.20 : 0.18,
    };
  });

  const previousSeries: ComparisonSeriesPoint[] = Array.from({ length: 30 }, (_, i) => {
    const day = (i + 1 < 10 ? '0' : '') + (i + 1);
    const date = `2026-08-${day}`;
    return {
      bucket: date,
      tokens: 45_000,
      requests: 18,
      cost: 0.16,
    };
  });

  const currentTotalTokens = currentSeries.reduce((sum, p) => sum + p.tokens, 0);
  const currentTotalCost = currentSeries.reduce((sum, p) => sum + p.cost, 0);
  const currentTotalReqs = currentSeries.reduce((sum, p) => sum + p.requests, 0);

  const prevTotalTokens = previousSeries.reduce((sum, p) => sum + p.tokens, 0);
  const prevTotalCost = previousSeries.reduce((sum, p) => sum + p.cost, 0);
  const prevTotalReqs = previousSeries.reduce((sum, p) => sum + p.requests, 0);

  return {
    window: {
      kind: 'monthOverMonth',
      timezone: 'Asia/Shanghai',
      bucket: 'day',
      currentStart: '2026-09-01T00:00:00+08:00',
      currentEnd: '2026-09-30T23:59:59+08:00',
      previousStart: '2026-08-01T00:00:00+08:00',
      previousEnd: '2026-08-30T23:59:59+08:00',
      alignedThrough: '第 30 日',
    },
    current: {
      summary: {
        totalTokens: currentTotalTokens,
        inputTokens: currentTotalTokens * 0.7,
        outputTokens: currentTotalTokens * 0.3,
        cachedTokens: 200_000,
        totalCost: currentTotalCost,
        totalRequests: currentTotalReqs,
        avgTokensPerReq: Math.round(currentTotalTokens / currentTotalReqs),
      },
      series: currentSeries,
    },
    previous: {
      summary: {
        totalTokens: prevTotalTokens,
        inputTokens: prevTotalTokens * 0.7,
        outputTokens: prevTotalTokens * 0.3,
        cachedTokens: 180_000,
        totalCost: prevTotalCost,
        totalRequests: prevTotalReqs,
        avgTokensPerReq: Math.round(prevTotalTokens / prevTotalReqs),
      },
      series: previousSeries,
    },
    delta: {
      tokens: { absolute: currentTotalTokens - prevTotalTokens, percent: 28.5, direction: 'up' },
      requests: { absolute: currentTotalReqs - prevTotalReqs, percent: 25.0, direction: 'up' },
      cost: { absolute: currentTotalCost - prevTotalCost, percent: 30.1, direction: 'up' },
    },
  };
}

const mockActiveTools: ToolStat[] = [
  { name: 'claude', input: 100_000, output: 40_000, cached: 30_000, total: 140_000, cost: 0.55, requests: 50 },
  { name: 'codex', input: 80_000, output: 30_000, cached: 20_000, total: 110_000, cost: 0.35, requests: 40 },
];

const mockTrends: TrendPoint[] = [
  { date: '2026-09-01', claude: 140_000, codex: 110_000 },
  { date: '2026-09-02', claude: 160_000, codex: 120_000 },
];

describe('TrendPanel Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Helper Functions', () => {
    it('formatBucketLabel formats hourly, daily, and monthly formats correctly', () => {
      expect(formatBucketLabel('14:00')).toBe('14:00');
      expect(formatBucketLabel('2026-09-02')).toBe('09-02');
      expect(formatBucketLabel('2026-09')).toBe('9月');
      expect(formatBucketLabel('custom-bucket')).toBe('custom-bucket');
    });

    it('getWeekdayName returns correct Chinese weekday name', () => {
      expect(getWeekdayName('2026-08-31')).toBe('周一');
      expect(getWeekdayName('2026-09-01')).toBe('周二');
      expect(getWeekdayName('2026-09-02')).toBe('周三');
      expect(getWeekdayName('2026-09-03')).toBe('周四');
      expect(getWeekdayName('2026-09-04')).toBe('周五');
      expect(getWeekdayName('2026-09-05')).toBe('周六');
      expect(getWeekdayName('2026-09-06')).toBe('周日');
      expect(getWeekdayName('invalid-date')).toBe('');
    });

    it('isCloudComparisonBaselineUnverified identifies unverified cloud baseline', () => {
      const emptyPrevComparison: UsageComparison = {
        ...createTodayComparison(),
        previous: {
          ...createTodayComparison().previous,
          summary: {
            ...createTodayComparison().previous.summary,
            totalRequests: 0,
            totalTokens: 0,
          },
        },
      };
      expect(isCloudComparisonBaselineUnverified('cloud', emptyPrevComparison)).toBe(true);
      expect(isCloudComparisonBaselineUnverified('local', emptyPrevComparison)).toBe(false);
      expect(isCloudComparisonBaselineUnverified('cloud', createTodayComparison())).toBe(false);
      expect(isCloudComparisonBaselineUnverified('cloud', null)).toBe(false);
    });

    it('把指标与逐日/累计方式分开命名', () => {
      expect(trendPresentationLabels('tokens', 'daily', 'day')).toEqual({ metric: '有效 Token', shape: '逐日值' });
      expect(trendPresentationLabels('cost', 'cumulative', 'day')).toEqual({ metric: '预估费用 · USD', shape: '累计总量' });
      expect(trendPresentationLabels('dual', 'daily', 'hour')).toEqual({ metric: 'Token + 费用 · 双轴', shape: '逐小时值' });
    });
  });

  describe('Track View Mode Switching', () => {
    it('renders Track View toggle buttons and defaults to Token View', () => {
      const comparison = createTodayComparison();
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="today"
          scope="local"
        />,
      );

      const tokenBtn = screen.getByRole('button', { name: /Token 视角/i });
      const costBtn = screen.getByRole('button', { name: /费用视角/i });
      const dualBtn = screen.getByRole('button', { name: /双轨对比/i });

      expect(tokenBtn).toBeInTheDocument();
      expect(costBtn).toBeInTheDocument();
      expect(dualBtn).toBeInTheDocument();

      expect(tokenBtn).toHaveAttribute('aria-pressed', 'true');
      expect(costBtn).toHaveAttribute('aria-pressed', 'false');
      expect(dualBtn).toHaveAttribute('aria-pressed', 'false');

      // Default badge reflects Token 视角
      expect(screen.getAllByText('Token 视角').length).toBeGreaterThanOrEqual(1);
      const presentation = screen.getByLabelText('当前趋势呈现方式');
      expect(presentation).toHaveTextContent('指标：有效 Token');
      expect(presentation).toHaveTextContent('方式：逐小时值');
      const basis = screen.getByLabelText('趋势比较口径');
      expect(screen.getByText(/按相同进度对齐 · 截止 18:00/)).toBeInTheDocument();
      expect(basis).toHaveTextContent('进行中的当前小时不计入');
    });

    it('switches to Cost View when clicking 费用视角 (T10.154 D05–D07, D25)', () => {
      const comparison = createTodayComparison();
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="today"
          scope="local"
        />,
      );

      expect(screen.getByText('有效 Token 与预估费用趋势')).toBeInTheDocument();
      expect(screen.getByText('Token 口径为输入 + 输出，不含缓存读写；预估费用按价格表估算，含缓存读写费用，非账单。')).toBeInTheDocument();
      const costBtn = screen.getByRole('button', { name: '切换至费用视角' });
      expect(costBtn).toHaveTextContent('费用视角');
      fireEvent.click(costBtn);

      expect(costBtn).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('费用视角 · USD')).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/金额视角|金额趋势|金额消耗/);
      // D08：图表读屏名同样换成新叫法，两期金额写 ≈$（或 <$0.01），不再写不带 ≈ 的 $x。
      const chartLabel = screen.getAllByTestId('echart-mock')
        .map((node) => node.getAttribute('data-aria-label') ?? '')
        .find((label) => label.startsWith('费用视角'));
      expect(chartLabel).toMatch(/^费用视角有效 Token 与预估费用趋势。/);
      expect(chartLabel).toMatch(/\((?:≈|<)\$[\d,.]+\)/);
      expect(chartLabel).not.toMatch(/金额|\(\$/);
      // T10.159（审计 Q3）：总量与总量变化只留在上方 KPI 卡；趋势卡只回答均值与单位费用。
      expect(screen.getByText('小时均预估费用')).toBeInTheDocument();
      expect(screen.getByText('单位费用')).toBeInTheDocument();
      expect(screen.queryByText('请求次数')).not.toBeInTheDocument();
    });

    it('switches to Dual-Track View when clicking 双轨对比', () => {
      const comparison = createTodayComparison();
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="today"
          scope="local"
        />,
      );

      const dualBtn = screen.getByRole('button', { name: /双轨对比/i });
      fireEvent.click(dualBtn);

      expect(dualBtn).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getAllByText('双轨对比').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('小时均有效 Token')).toBeInTheDocument();
      expect(screen.getByText('小时均预估费用')).toBeInTheDocument();
      expect(screen.getByText('单位费用')).toBeInTheDocument();
      expect(screen.queryByText('成本密度')).not.toBeInTheDocument();
    });
  });

  describe('Single Day (24h Today): one answer per question (T10.159, audit Q4)', () => {
    it('drops the peak / valley / running-total strip; the hourly rhythm panel answers "when"', () => {
      const comparison = createTodayComparison();
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="today"
          scope="local"
        />,
      );

      expect(screen.queryByText(/活跃波峰/)).not.toBeInTheDocument();
      expect(screen.queryByText(/活跃波谷/)).not.toBeInTheDocument();
      expect(screen.queryByText(/当日累计/)).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: /单日 24 小时活跃洞察/ })).not.toBeInTheDocument();
      // 小时桶没有累计走势与预测，也就没有那一条说明行。
      expect(screen.queryByRole('group', { name: '逐日与累计走势切换' })).not.toBeInTheDocument();
    });

    it('averages only finished hours; the in-progress hour does not drag the mean down', () => {
      const comparison = createTodayComparison();
      comparison.window.currentEnd = '2026-09-02T14:30:00+08:00';
      comparison.current.series = comparison.current.series.slice(0, 15);
      comparison.previous.series = comparison.previous.series.slice(0, 15);
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="today"
          scope="local"
        />,
      );

      // 00:00–13:00 已结束：10K + 2K·i（i=0..13），其中 04:00 为 1K → 合计 305K，均值 ≈21.8K。
      expect(screen.getByText('小时均有效 Token')).toBeInTheDocument();
      expect(screen.getByText('21.8K')).toBeInTheDocument();
      expect(screen.getByText(/^按已完成 14 小时 · 昨日同期/)).toBeInTheDocument();
    });

    it('says there is no finished hour yet instead of showing 0', () => {
      const comparison = createTodayComparison();
      comparison.window.currentEnd = '2026-09-02T00:20:00+08:00';
      comparison.current.series = comparison.current.series.slice(0, 1);
      comparison.previous.series = comparison.previous.series.slice(0, 1);
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="today"
          scope="local"
        />,
      );

      const region = screen.getByRole('region', { name: '趋势对比摘要' });
      expect(region).toHaveTextContent('小时均有效 Token—');
      expect(region).toHaveTextContent('还没有完整的一小时');
      expect(region.textContent).not.toMatch(/(^|[^\d.])0%|∞|NaN/);
    });
  });

  describe('Single Week (7d Week)', () => {
    it('drops the weekday/weekend strip (one observation per weekday) and offers the cumulative view', () => {
      const comparison = createWeekComparison();
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="week"
          scope="local"
        />,
      );

      expect(screen.queryByText(/工作日 \(周一至五\)/)).not.toBeInTheDocument();
      expect(screen.queryByText(/周末 \(周六日\)/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '累计走势' }));
      const option = JSON.parse(screen.getByTestId('echart-mock').getAttribute('data-option') || '{}');
      expect(option.series[0].name).toBe('本周（累计）');
      expect(option.series[0].data[6]).toBe(1_100_000);
    });
  });

  describe('Single Month (30d Month)', () => {
    it('uses completed days only for 日均 and its dotted baseline, and never flags a 1.8× spike', () => {
      const comparison = createMonthComparison();
      // 截止到 30 日 10:00：30 日进行中，只平均 1–29 日；15 日的 300K 仍在其中。
      comparison.window.currentEnd = '2026-09-30T10:00:00+08:00';
      comparison.current.series[29] = { bucket: '2026-09-30', tokens: 5_000, requests: 2, cost: 0.02 };
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="month"
          scope="local"
        />,
      );

      // (28 × 50K + 300K) / 29 = 58,620.7 → 58.6K；把进行中的 5K 算进去会得到 56.8K。
      expect(screen.getByText('日均有效 Token')).toBeInTheDocument();
      expect(screen.getByText('58.6K')).toBeInTheDocument();
      expect(screen.getByText(/^按已完成 29 天 · 上月同期 45\.0K$/)).toBeInTheDocument();
      expect(screen.queryByText(/尖峰日/)).not.toBeInTheDocument();
      expect(screen.queryByText(/月度日均基准/)).not.toBeInTheDocument();

      const option = JSON.parse(screen.getByTestId('echart-mock').getAttribute('data-option') || '{}');
      const baseline = option.series.find((series: { name: string }) => series.name === '日均基准（有效 Token）');
      expect(baseline.data[0]).toBe(58_621);
      expect(baseline.data).toHaveLength(30);
    });

    it('toggles between 逐日走势 and 累计走势 sub-views', () => {
      const comparison = createMonthComparison();
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="month"
          scope="local"
        />,
      );

      const dailyBtn = screen.getByRole('button', { name: '逐日走势' });
      const cumulativeBtn = screen.getByRole('button', { name: '累计走势' });

      expect(screen.getByRole('group', { name: '逐日与累计走势切换' })).toBeInTheDocument();
      expect(dailyBtn).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(cumulativeBtn);
      expect(cumulativeBtn).toHaveAttribute('aria-pressed', 'true');
      expect(dailyBtn).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByText(/累积燃烧|Burn-up/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('当前趋势呈现方式')).toHaveTextContent('方式：累计总量');
      expect(screen.getByLabelText('趋势比较口径')).toHaveTextContent('日均只计已完成');
    });
  });

  describe('Custom multi-day range (audit Q5)', () => {
    it('the cumulative toggle actually switches the chart for a custom day range', () => {
      const comparison = { ...createWeekComparison(), window: { ...createWeekComparison().window, kind: 'periodOverPeriod' as const } };
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="custom"
          scope="local"
        />,
      );

      const readOption = () => JSON.parse(screen.getByTestId('echart-mock').getAttribute('data-option') || '{}');
      expect(readOption().series[0].data[1]).toBe(200_000);
      fireEvent.click(screen.getByRole('button', { name: '累计走势' }));
      expect(readOption().series[0].name).toBe('所选区间（累计）');
      expect(readOption().series[0].data[1]).toBe(400_000);
      expect(readOption().series[1].data[6]).toBe(980_000);
    });
  });

  describe('Cloud Unverified Baseline Handling', () => {
    it('displays 基线缺失 when cloud baseline is unverified and avoids fake 0 calculations', () => {
      const emptyPrevComparison: UsageComparison = {
        ...createTodayComparison(),
        previous: {
          ...createTodayComparison().previous,
          summary: {
            ...createTodayComparison().previous.summary,
            totalRequests: 0,
            totalTokens: 0,
            totalCost: 0,
          },
        },
      };

      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={emptyPrevComparison}
          range="today"
          scope="cloud"
        />,
      );

      const baselineCues = screen.getAllByText('基线缺失');
      expect(baselineCues.length).toBeGreaterThan(0);
      expect(screen.getByText(/云端未返回昨日同期的可验证记录/i)).toBeInTheDocument();
      expect(screen.getByText(/—（未验证）/i)).toBeInTheDocument();
      expect(screen.getByText(/基线缺失 · 不按 0 计算/)).toBeInTheDocument();
      expect(screen.getByLabelText('趋势比较口径')).toHaveTextContent('上一周期基线未验证：不计算变化，图中不按 0 补齐');
      expect(screen.getByRole('region', { name: '趋势对比摘要' }).textContent).not.toMatch(/新增|%/);
    });
  });

  describe('Current-Only View (Year / All Ranges)', () => {
    it('renders current-only tool breakdown trend when comparison is absent', () => {
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          range="year"
          scope="local"
        />,
      );

      expect(screen.getByText(/当前范围展示绝对趋势/i)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: /单日 24 小时活跃洞察/i })).not.toBeInTheDocument();
      // 没有对比时图表只按工具画 Token：不放一个点了也不起作用的视角开关（审计 Q5）。
      expect(screen.queryByRole('group', { name: '趋势呈现视角' })).not.toBeInTheDocument();
      expect(screen.getByText('有效 Token 趋势')).toBeInTheDocument();
      const option = JSON.parse(screen.getByTestId('echart-mock').getAttribute('data-option') || '{}');
      expect(option.series.map((series: { name: string }) => series.name)).toEqual(['Claude', 'Codex']);
      expect(option.series[0].data).toEqual([140_000, 160_000]);
    });

    it('专属看板的模型序列保持模型 id，工具序列改用显示名', () => {
      const { rerender } = render(
        <TrendPanel
          trends={[{ date: '2026-09-01', 'gpt-5-codex': 10 }]}
          activeTools={[]}
          range="today"
          scope="local"
          currentSeriesName="gpt-5-codex"
        />,
      );
      const readNames = () => {
        const option = JSON.parse(screen.getByTestId('echart-mock').getAttribute('data-option') || '{}');
        return option.series.map((series: { name: string; data: number[] }) => [series.name, series.data]);
      };
      expect(readNames()).toEqual([['gpt-5-codex', [10]]]);

      rerender(
        <TrendPanel
          trends={[{ date: '2026-09-01', claude: 10 }]}
          activeTools={[]}
          range="today"
          scope="local"
          currentSeriesName="claude"
          currentSeriesIsTool
        />,
      );
      expect(readNames()).toEqual([['Claude', [10]]]);
    });

    it('labels the overview local 「全部」 chart as the last 31 days, and cloud as full history', () => {
      const overview = { summary: createTodayComparison().current.summary, tools: {}, models: {}, trends: mockTrends, heatmap: {}, history: [] };
      const { rerender } = render(
        <TrendPanel trends={mockTrends} activeTools={mockActiveTools} range="all" scope="local" overviewStats={overview} pendingUploads={0} />,
      );
      expect(screen.getByText(/^本机“全部”仅显示最近 31 天走势；/)).toBeInTheDocument();
      expect(screen.getByTestId('echart-mock').getAttribute('data-aria-label')).toContain('最近 31 天');

      rerender(<TrendPanel trends={mockTrends} activeTools={mockActiveTools} range="all" scope="cloud" overviewStats={overview} pendingUploads={0} />);
      expect(screen.getByText(/^云端“全部”按全部历史逐日绘制走势/)).toBeInTheDocument();

      // 专属看板的趋势来自实体热力，不套用总览的观察窗说明。
      rerender(<TrendPanel trends={mockTrends} activeTools={mockActiveTools} range="all" scope="local" />);
      expect(screen.queryByText(/最近 31 天/)).not.toBeInTheDocument();
      expect(screen.getByText('当前范围展示绝对趋势；全部范围不自动推断对比周期。')).toBeInTheDocument();
    });

    it('renders custom currentOnlyNote if provided', () => {
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          range="all"
          scope="local"
          currentOnlyNote="自定义全量说明"
        />,
      );

      expect(screen.getByText('自定义全量说明')).toBeInTheDocument();
    });
  });

  describe('Accessibility and ARIA Compliance', () => {
    it('renders accessible container with proper region role and aria labels', () => {
      const comparison = createTodayComparison();
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="today"
          scope="local"
        />,
      );

      expect(screen.getByRole('region', { name: '趋势与对比看板' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: '趋势呈现视角' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: '趋势对比摘要' })).toBeInTheDocument();
    });
  });

  describe('ECharts Option Structure and Tooltip Formatting', () => {
    it('generates dual Y-axis configuration when in dual mode', () => {
      const comparison = createTodayComparison();
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="today"
          scope="local"
          initialTrack="dual"
        />,
      );

      const chartMock = screen.getByTestId('echart-mock');
      const option = JSON.parse(chartMock.getAttribute('data-option') || '{}');

      expect(Array.isArray(option.yAxis)).toBe(true);
      expect(option.yAxis).toHaveLength(2);
      expect(option.yAxis[0].name).toBe('有效 Token');
      // T10.154 D15：轴名写单位，系列名不再写「费用 ($)」。
      expect(option.yAxis[1].name).toBe('预估费用（USD）');
      expect(option.series).toHaveLength(4);
      expect(option.series[1].name).toBe('今日 预估费用');
      expect(option.series[3].name).toBe('昨日同期 预估费用');
      expect(option.series[0].yAxisIndex).toBe(0);
      expect(option.series[1].yAxisIndex).toBe(1);
      expect(option.series[2].yAxisIndex).toBe(0);
      expect(option.series[3].yAxisIndex).toBe(1);
    });

    it('generates cumulative series when in the month cumulative view', () => {
      const comparison = createMonthComparison();
      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={comparison}
          range="month"
          scope="local"
        />,
      );

      // Switch to the cumulative view
      fireEvent.click(screen.getByRole('button', { name: '累计走势' }));

      const chartMock = screen.getByTestId('echart-mock');
      const option = JSON.parse(chartMock.getAttribute('data-option') || '{}');

      expect(option.series[0].name).toContain('（累计）');
      const data: number[] = option.series[0].data;
      expect(data).toHaveLength(30);
      // Verify accumulation
      expect(data[29]).toBeGreaterThan(data[0]);
      expect(data[1]).toBeGreaterThanOrEqual(data[0]);
    });

    it('handles all-zero usage gracefully without errors or NaNs', () => {
      const zeroComparison: UsageComparison = {
        ...createTodayComparison(),
        current: {
          ...createTodayComparison().current,
          summary: {
            ...createTodayComparison().current.summary,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            totalCost: 0,
            totalRequests: 0,
          },
          series: Array.from({ length: 24 }, (_, i) => ({
            bucket: `${i < 10 ? '0' : ''}${i}:00`,
            tokens: 0,
            requests: 0,
            cost: 0,
          })),
        },
        previous: {
          ...createTodayComparison().previous,
          summary: {
            ...createTodayComparison().previous.summary,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            totalCost: 0,
            totalRequests: 0,
          },
          series: Array.from({ length: 24 }, (_, i) => ({
            bucket: `${i < 10 ? '0' : ''}${i}:00`,
            tokens: 0,
            requests: 0,
            cost: 0,
          })),
        },
        delta: {
          tokens: { absolute: 0, percent: null, direction: 'flat' },
          requests: { absolute: 0, percent: null, direction: 'flat' },
          cost: { absolute: 0, percent: null, direction: 'flat' },
        },
      };

      render(
        <TrendPanel
          trends={mockTrends}
          activeTools={mockActiveTools}
          comparison={zeroComparison}
          range="today"
          scope="local"
        />,
      );

      expect(screen.getByText(/今日与昨日同期均无 Token 消耗/i)).toBeInTheDocument();
      expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    });
  });
});
