import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageComparison } from '../types';
import {
  isCloudComparisonBaselineUnverified,
  TrendPanel,
} from './TrendPanel';

// Mock EChart to capture the full configuration options and ariaLabel
let lastCapturedOption: any = null;

vi.mock('./EChart', () => ({
  EChart: ({ option, ariaLabel }: { option: any; ariaLabel?: string }) => {
    lastCapturedOption = option;
    return (
      <div data-testid="echart-mock" data-aria-label={ariaLabel} data-option={JSON.stringify(option)}>
        Chart Mock
      </div>
    );
  },
  default: ({ option, ariaLabel }: { option: any; ariaLabel?: string }) => {
    lastCapturedOption = option;
    return (
      <div data-testid="echart-mock" data-aria-label={ariaLabel} data-option={JSON.stringify(option)}>
        Chart Mock
      </div>
    );
  },
}));

describe('Empirical Adversarial Stress Tests for TrendPanel', () => {
  beforeEach(() => {
    lastCapturedOption = null;
    vi.clearAllMocks();
  });

  describe('Dimension 1: Zero-Data and Empty-Series Edge Cases', () => {
    it('handles completely empty series comparison without crashing across all track modes', () => {
      const emptyComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'Asia/Shanghai',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00+08:00',
          currentEnd: '2026-09-02T23:59:59+08:00',
          previousStart: '2026-09-01T00:00:00+08:00',
          previousEnd: '2026-09-01T23:59:59+08:00',
          alignedThrough: '00:00',
        },
        current: {
          summary: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalCost: 0,
            totalRequests: 0,
            avgTokensPerReq: 0,
          },
          series: [],
        },
        previous: {
          summary: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalCost: 0,
            totalRequests: 0,
            avgTokensPerReq: 0,
          },
          series: [],
        },
        delta: {
          tokens: { absolute: 0, percent: null, direction: 'flat' },
          requests: { absolute: 0, percent: null, direction: 'flat' },
          cost: { absolute: 0, percent: null, direction: 'flat' },
        },
      };

      const { rerender } = render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={emptyComparison}
          range="today"
          scope="local"
        />,
      );

      // Verify renders gracefully in default token mode
      expect(screen.getByRole('region', { name: '趋势与对比看板' })).toBeInTheDocument();
      expect(lastCapturedOption.xAxis.data).toEqual([]);
      expect(lastCapturedOption.series[0].data).toEqual([]);

      // Switch to Cost mode
      const costBtn = screen.getByRole('button', { name: /费用视角/i });
      fireEvent.click(costBtn);
      expect(lastCapturedOption.series[0].data).toEqual([]);

      // Switch to Dual mode
      const dualBtn = screen.getByRole('button', { name: /双轨对比/i });
      fireEvent.click(dualBtn);
      expect(lastCapturedOption.series[0].data).toEqual([]);
      expect(lastCapturedOption.series[1].data).toEqual([]);

      // Test week and month ranges with empty series
      rerender(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={emptyComparison}
          range="week"
          scope="local"
        />,
      );
      expect(screen.queryByRole('region', { name: /工作日与周末用量对比/i })).not.toBeInTheDocument();

      rerender(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={emptyComparison}
          range="month"
          scope="local"
        />,
      );
      expect(screen.queryByRole('region', { name: /月度燃烧与日均基准洞察/i })).not.toBeInTheDocument();
    });

    it('handles current-only view with empty trends and activeTools without throwing', () => {
      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          range="year"
          scope="local"
        />,
      );

      expect(screen.getByRole('region', { name: '趋势与对比看板' })).toBeInTheDocument();
      expect(lastCapturedOption.xAxis.data).toEqual([]);
      expect(lastCapturedOption.series).toEqual([]);
    });

    it('tooltip formatter handles missing/empty data index points gracefully', () => {
      const emptyComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'Asia/Shanghai',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00+08:00',
          currentEnd: '2026-09-02T23:59:59+08:00',
          previousStart: '2026-09-01T00:00:00+08:00',
          previousEnd: '2026-09-01T23:59:59+08:00',
          alignedThrough: '00:00',
        },
        current: {
          summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 },
          series: [],
        },
        previous: {
          summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 },
          series: [],
        },
        delta: {
          tokens: { absolute: 0, percent: null, direction: 'flat' },
          requests: { absolute: 0, percent: null, direction: 'flat' },
          cost: { absolute: 0, percent: null, direction: 'flat' },
        },
      };

      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={emptyComparison}
          range="today"
          scope="local"
        />,
      );

      expect(typeof lastCapturedOption.tooltip.formatter).toBe('function');
      const tooltipHtml = lastCapturedOption.tooltip.formatter([{ dataIndex: 99 }]);
      expect(tooltipHtml).toBeDefined();
      expect(tooltipHtml).toContain('有效 Token:');
      expect(tooltipHtml).toContain('预估费用:');
      expect(tooltipHtml).toContain('持平');
      expect(tooltipHtml).not.toContain('NaN');
      expect(tooltipHtml).not.toContain('undefined');
    });
  });

  describe('Dimension 2: Extreme Large Values & Negative/Zero Cost Deltas', () => {
    it('handles extreme large values (100 Billion Tokens, $1,000,000 cost)', () => {
      const hugeTokens = 100_000_000_000;
      const hugeCost = 1_000_000.00;
      const hugeReqs = 50_000_000;

      const extremeComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'Asia/Shanghai',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00+08:00',
          currentEnd: '2026-09-02T23:59:59+08:00',
          previousStart: '2026-09-01T00:00:00+08:00',
          previousEnd: '2026-09-01T23:59:59+08:00',
          alignedThrough: '12:00',
        },
        current: {
          summary: {
            totalTokens: hugeTokens,
            inputTokens: hugeTokens * 0.8,
            outputTokens: hugeTokens * 0.2,
            cachedTokens: 20_000_000_000,
            totalCost: hugeCost,
            totalRequests: hugeReqs,
            avgTokensPerReq: Math.round(hugeTokens / hugeReqs),
          },
          series: [
            { bucket: '12:00', tokens: hugeTokens, requests: hugeReqs, cost: hugeCost },
          ],
        },
        previous: {
          summary: {
            totalTokens: hugeTokens / 2,
            inputTokens: (hugeTokens / 2) * 0.8,
            outputTokens: (hugeTokens / 2) * 0.2,
            cachedTokens: 10_000_000_000,
            totalCost: hugeCost / 2,
            totalRequests: hugeReqs / 2,
            avgTokensPerReq: Math.round(hugeTokens / hugeReqs),
          },
          series: [
            { bucket: '12:00', tokens: hugeTokens / 2, requests: hugeReqs / 2, cost: hugeCost / 2 },
          ],
        },
        delta: {
          tokens: { absolute: hugeTokens / 2, percent: 100.0, direction: 'up' },
          requests: { absolute: hugeReqs / 2, percent: 100.0, direction: 'up' },
          cost: { absolute: hugeCost / 2, percent: 100.0, direction: 'up' },
        },
      };

      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={extremeComparison}
          range="today"
          scope="local"
          initialTrack="dual"
        />,
      );

      // Verify rendering of formatted numbers
      expect(screen.getAllByText('100.00B').length).toBeGreaterThanOrEqual(1);
      // T10.154 D23：两期摘要的金额是预估费用，写 ≈$。
      expect(screen.getAllByText('≈$1,000,000.00').length).toBeGreaterThanOrEqual(1);

      // Verify tooltip output
      const tooltipHtml = lastCapturedOption.tooltip.formatter([{ dataIndex: 0 }]);
      expect(tooltipHtml).toContain('100.00B');
      expect(tooltipHtml).toContain('$1,000,000.00');
      expect(tooltipHtml).not.toContain('NaN');
    });

    it('formats negative cost deltas and zero cost deltas correctly in tooltip', () => {
      const deltaComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'Asia/Shanghai',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00+08:00',
          currentEnd: '2026-09-02T23:59:59+08:00',
          previousStart: '2026-09-01T00:00:00+08:00',
          previousEnd: '2026-09-01T23:59:59+08:00',
          alignedThrough: '02:00',
        },
        current: {
          summary: { totalTokens: 15_000, inputTokens: 10_000, outputTokens: 5_000, cachedTokens: 0, totalCost: 1.05, totalRequests: 3, avgTokensPerReq: 5000 },
          series: [
            { bucket: '00:00', tokens: 5_000, requests: 1, cost: 0.05 }, // Dropped from $1.50 -> -96.7%
            { bucket: '01:00', tokens: 10_000, requests: 2, cost: 1.00 }, // Identical to $1.00 -> 0.0%
          ],
        },
        previous: {
          summary: { totalTokens: 30_000, inputTokens: 20_000, outputTokens: 10_000, cachedTokens: 0, totalCost: 2.50, totalRequests: 4, avgTokensPerReq: 7500 },
          series: [
            { bucket: '00:00', tokens: 20_000, requests: 2, cost: 1.50 },
            { bucket: '01:00', tokens: 10_000, requests: 2, cost: 1.00 },
          ],
        },
        delta: {
          tokens: { absolute: -15_000, percent: -50.0, direction: 'down' },
          requests: { absolute: -1, percent: -25.0, direction: 'down' },
          cost: { absolute: -1.45, percent: -58.0, direction: 'down' },
        },
      };

      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={deltaComparison}
          range="today"
          scope="local"
        />,
      );

      // Tooltip index 0: negative delta
      const dropTooltip = lastCapturedOption.tooltip.formatter([{ dataIndex: 0 }]);
      // T10.186 评审 P3-4：百分比与金额共用同一套有符号格式，负号统一用 U+2212，不再是
      // 百分比 ASCII 减号（-96.7%）、金额 U+2212（−$1.45）两种写法。
      expect(dropTooltip).toContain('−96.7%');
      expect(dropTooltip).not.toContain('-96.7%');
      expect(dropTooltip).toContain('(−$1.45)');
      expect(dropTooltip).not.toContain('$-1.45');
      expect(dropTooltip).toContain('≈$0.05');

      // Token 差值徽标括号里的绝对值同样要用 U+2212，不能让 `formatTokens` 自己签一次 ASCII
      // 减号（T10.197 评审 P3-5）：当前 5,000 对上期 20,000，差 -15,000（magnitude ≥ 1,000
      // 走 K 单位分支，`formatTokens` 曾经在这个分支里用 `val < 0 ? '-' : ''` 自己签名）。
      expect(dropTooltip).toContain('−75.0%');
      expect(dropTooltip).not.toContain('-75.0%');
      expect(dropTooltip).toContain('(−15.0K)');
      expect(dropTooltip).not.toContain('-15.0K');

      // Tooltip index 1: zero delta (equal cost)
      const flatTooltip = lastCapturedOption.tooltip.formatter([{ dataIndex: 1 }]);
      expect(flatTooltip).toContain('0.0%');
      expect(flatTooltip).toContain('($0.00)');
      // D12：截至此时累计同样是预估费用。
      expect(flatTooltip).toContain('≈$1.05');
    });

    it('总费用不可得（例如契约把 NaN/Infinity 转成的 null）时两期摘要与图表读屏名写「不可得」，不按 0 兜底显示（T10.186 评审 P3-2）', () => {
      // summary.totalCost 的 TS 类型是 number，但契约边界外的畸形响应可能在运行期夹带 null
      // （serde_json 把 ±inf/NaN 序列化成 null）；这里故意用 as unknown 注入这种情况。
      const unknownTotalComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'Asia/Shanghai',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00+08:00',
          currentEnd: '2026-09-02T23:59:59+08:00',
          previousStart: '2026-09-01T00:00:00+08:00',
          previousEnd: '2026-09-01T23:59:59+08:00',
          alignedThrough: '01:00',
        },
        current: {
          summary: {
            totalTokens: 15_000, inputTokens: 10_000, outputTokens: 5_000, cachedTokens: 0,
            totalCost: null as unknown as number, totalRequests: 3, avgTokensPerReq: 5000,
          },
          series: [{ bucket: '00:00', tokens: 15_000, requests: 3, cost: 1.05 }],
        },
        previous: {
          summary: { totalTokens: 30_000, inputTokens: 20_000, outputTokens: 10_000, cachedTokens: 0, totalCost: 2.50, totalRequests: 4, avgTokensPerReq: 7500 },
          series: [{ bucket: '00:00', tokens: 30_000, requests: 4, cost: 2.50 }],
        },
        delta: {
          tokens: { absolute: -15_000, percent: -50.0, direction: 'down' },
          requests: { absolute: -1, percent: -25.0, direction: 'down' },
          cost: { absolute: null as unknown as number, percent: null, direction: 'down' },
        },
      };

      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={unknownTotalComparison}
          range="today"
          scope="local"
        />,
      );

      expect(screen.getAllByText('不可得').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('≈$0.00')).not.toBeInTheDocument();
      const ariaLabel = screen.getByTestId('echart-mock').getAttribute('data-aria-label') || '';
      expect(ariaLabel).toContain('不可得');
      expect(ariaLabel).not.toContain('≈$0.00');
    });

    it('桶级费用任一端不可得时差值不画，只写「不可得」，不把 null 当 0 算出假的 -100%（T10.186 评审 P3-2）', () => {
      const bucketUnknownComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'Asia/Shanghai',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00+08:00',
          currentEnd: '2026-09-02T23:59:59+08:00',
          previousStart: '2026-09-01T00:00:00+08:00',
          previousEnd: '2026-09-01T23:59:59+08:00',
          alignedThrough: '01:00',
        },
        current: {
          summary: { totalTokens: 15_000, inputTokens: 10_000, outputTokens: 5_000, cachedTokens: 0, totalCost: 1.05, totalRequests: 3, avgTokensPerReq: 5000 },
          series: [{ bucket: '00:00', tokens: 15_000, requests: 3, cost: null as unknown as number }],
        },
        previous: {
          summary: { totalTokens: 30_000, inputTokens: 20_000, outputTokens: 10_000, cachedTokens: 0, totalCost: 2.50, totalRequests: 4, avgTokensPerReq: 7500 },
          series: [{ bucket: '00:00', tokens: 30_000, requests: 4, cost: 1.50 }],
        },
        delta: {
          tokens: { absolute: -15_000, percent: -50.0, direction: 'down' },
          requests: { absolute: -1, percent: -25.0, direction: 'down' },
          cost: { absolute: -0.45, percent: -30.0, direction: 'down' },
        },
      };

      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={bucketUnknownComparison}
          range="today"
          scope="local"
        />,
      );

      const tooltipHtml = lastCapturedOption.tooltip.formatter([{ dataIndex: 0 }]);
      // 值本身（预估费用：不可得）、单位费用（不可得）、截至此时累计（不可得，本桶费用未知，
      // 累计从这里起也不可得，T10.197 评审 P3-7）各贡献一次，正好三次——差值徽标改成不画
      // （空字符串，T10.197 评审 P3-9），不再额外贡献第四次；用精确的 3 次而不是 >=2，这样
      // 徽标不小心又画出文字时这里会先变红，不会被其余几处凑够阈值悄悄放过（T10.186 评审 P3-2
      // 补强的教训：原断言只查 ASCII 减号，计数阈值又恰好被凑够）。
      expect(tooltipHtml.match(/不可得/g)?.length ?? 0).toBe(3);
      expect(tooltipHtml).not.toContain('($');
      expect(tooltipHtml).not.toContain('NaN');
      // 差值徽标本身：两端有一端不可得时不画任何徽标文字（不是「不可得」三个字，也不是把 null
      // 当 0 算出来的假百分比）——直接锁定「预估费用」值那一行：不可得的 <strong> 后面紧跟着
      // 两层 </div> 收尾，中间只有空白，没有徽标的 <span>（T10.197 评审 P3-9，登记时的原方案）。
      expect(tooltipHtml).not.toMatch(/[−-]100\.0%/);
      expect(tooltipHtml).toMatch(/<strong[^>]*>不可得<\/strong>\s*<\/div>\s*<\/div>/);
    });

    it('累计走势中途出现不可得费用桶后，从那一桶起累计整体不可得、图上断线，不接着旧累计值画平线（T10.197 评审 P3-7）', () => {
      const cumulativeUnknownComparison: UsageComparison = {
        window: {
          kind: 'periodOverPeriod',
          timezone: 'Asia/Shanghai',
          bucket: 'day',
          currentStart: '2026-09-01T00:00:00+08:00',
          currentEnd: '2026-09-03T23:59:59+08:00',
          previousStart: '2026-08-01T00:00:00+08:00',
          previousEnd: '2026-08-03T23:59:59+08:00',
          alignedThrough: '第 3 日',
        },
        current: {
          summary: { totalTokens: 300, inputTokens: 200, outputTokens: 100, cachedTokens: 0, totalCost: 3.00, totalRequests: 6, avgTokensPerReq: 50 },
          series: [
            { bucket: '2026-09-01', tokens: 100, requests: 2, cost: 1.00 },
            // 中途一桶费用不可得（例如契约把 NaN/Infinity 转成的 null）：不是 0，从这一桶起
            // 累计不能再假装是真的累计数。
            { bucket: '2026-09-02', tokens: 100, requests: 2, cost: null as unknown as number },
            { bucket: '2026-09-03', tokens: 100, requests: 2, cost: 2.00 },
          ],
        },
        previous: {
          summary: { totalTokens: 300, inputTokens: 200, outputTokens: 100, cachedTokens: 0, totalCost: 3.00, totalRequests: 6, avgTokensPerReq: 50 },
          series: [
            { bucket: '2026-08-01', tokens: 100, requests: 2, cost: 1.00 },
            { bucket: '2026-08-02', tokens: 100, requests: 2, cost: 1.00 },
            { bucket: '2026-08-03', tokens: 100, requests: 2, cost: 1.00 },
          ],
        },
        delta: {
          tokens: { absolute: 0, percent: 0, direction: 'flat' },
          requests: { absolute: 0, percent: 0, direction: 'flat' },
          cost: { absolute: null as unknown as number, percent: null, direction: 'flat' },
        },
      };

      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={cumulativeUnknownComparison}
          range="custom"
          scope="local"
          initialTrack="cost"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: '累计走势' }));

      // 第三桶（9/3）的 tooltip：截至此时累计写「不可得」，不是把中途缺失的一桶当 0 继续加成 $3.00。
      const tooltipHtml = lastCapturedOption.tooltip.formatter([{ dataIndex: 2 }]);
      expect(tooltipHtml).toMatch(/截至此时累计:[\s\S]*不可得/);
      expect(tooltipHtml).not.toContain('≈$3.00');

      // 图上累计线：第二桶（不可得本身）与第三桶（其后）在 series data 里都是 null，ECharts
      // 原生断线；第一桶仍是真累计值 $1，不受影响。series[0] 固定是本期（累计）那条实线
      // （T10.153/T10.197：seriesList 里先推本期、再推上期，累计视图下日均基准线已停画）。
      expect(lastCapturedOption.series[0].name).toContain('累计');
      expect(lastCapturedOption.series[0].data).toEqual([1, null, null]);
    });
  });

  describe('Dimension 3: Dual Y-Axis Extreme Discrepancy Scaling', () => {
    it('configures independent zero-based axes for high-token vs fractional-cent cost', () => {
      const discrepancyComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'Asia/Shanghai',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00+08:00',
          currentEnd: '2026-09-02T23:59:59+08:00',
          previousStart: '2026-09-01T00:00:00+08:00',
          previousEnd: '2026-09-01T23:59:59+08:00',
          alignedThrough: '01:00',
        },
        current: {
          summary: {
            totalTokens: 500_000_000, // 500M tokens
            inputTokens: 400_000_000,
            outputTokens: 100_000_000,
            cachedTokens: 0,
            totalCost: 0.0005, // 0.05 cents
            totalRequests: 10,
            avgTokensPerReq: 50_000_000,
          },
          series: [
            { bucket: '00:00', tokens: 500_000_000, requests: 10, cost: 0.0005 },
          ],
        },
        previous: {
          summary: {
            totalTokens: 400_000_000,
            inputTokens: 300_000_000,
            outputTokens: 100_000_000,
            cachedTokens: 0,
            totalCost: 0.0004,
            totalRequests: 8,
            avgTokensPerReq: 50_000_000,
          },
          series: [
            { bucket: '00:00', tokens: 400_000_000, requests: 8, cost: 0.0004 },
          ],
        },
        delta: {
          tokens: { absolute: 100_000_000, percent: 25.0, direction: 'up' },
          requests: { absolute: 2, percent: 25.0, direction: 'up' },
          cost: { absolute: 0.0001, percent: 25.0, direction: 'up' },
        },
      };

      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={discrepancyComparison}
          range="today"
          scope="local"
          initialTrack="dual"
        />,
      );

      expect(lastCapturedOption.yAxis).toHaveLength(2);
      expect(lastCapturedOption.yAxis[0].min).toBe(0);
      expect(lastCapturedOption.yAxis[1].min).toBe(0);
      expect(lastCapturedOption.yAxis[0].name).toBe('有效 Token');
      expect(lastCapturedOption.yAxis[1].name).toBe('预估费用（USD）');

      // Test formatters
      // T10.201: axis-label formatters use formatAxisTokens (trims trailing
      // zeros), not formatTokens (fixed decimals) — 500.00M has none to show.
      expect(lastCapturedOption.yAxis[0].axisLabel.formatter(500_000_000)).toBe('500M');
      expect(lastCapturedOption.yAxis[1].axisLabel.formatter(0.0005)).toBe('$0.00');

      // Check unit cost calculation: ($0.0005 / 500M) * 1M = $0.000001 per million.
      // (T10.159: T10.154 glossary renames 成本密度 to 单位费用, ≈$x/百万 Token; the shared
      // utils/unitCost helper shows a positive value below $0.01 as <$0.01 instead of rounding it to $0.00).
      const tooltipHtml = lastCapturedOption.tooltip.formatter([{ dataIndex: 0 }]);
      expect(tooltipHtml).toContain('单位费用: &lt;$0.01/百万 Token');
      expect(tooltipHtml).not.toContain('$0.00/百万 Token');
    });
  });

  describe('Dimension 4: HTML Injection & Tooltip XSS Vulnerability Stress Test', () => {
    it('strictly sanitizes and escapes malicious script/HTML injection in bucket labels', () => {
      const maliciousBuckets = [
        '<script>alert("XSS_HEADER")</script>',
        '<img src=x onerror=alert("XSS_IMG")>',
        '" style="background:red" data-hack="xss',
        '"><svg onload=alert(1)>',
      ];

      const injectionComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'Asia/Shanghai',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00+08:00',
          currentEnd: '2026-09-02T23:59:59+08:00',
          previousStart: '2026-09-01T00:00:00+08:00',
          previousEnd: '2026-09-01T23:59:59+08:00',
          alignedThrough: 'all',
        },
        current: {
          summary: { totalTokens: 1000, inputTokens: 500, outputTokens: 500, cachedTokens: 0, totalCost: 0.01, totalRequests: 1, avgTokensPerReq: 1000 },
          series: maliciousBuckets.map((bucket) => ({
            bucket,
            tokens: 250,
            requests: 1,
            cost: 0.0025,
          })),
        },
        previous: {
          summary: { totalTokens: 800, inputTokens: 400, outputTokens: 400, cachedTokens: 0, totalCost: 0.008, totalRequests: 1, avgTokensPerReq: 800 },
          series: maliciousBuckets.map((bucket) => ({
            bucket: `prev-${bucket}`,
            tokens: 200,
            requests: 1,
            cost: 0.002,
          })),
        },
        delta: {
          tokens: { absolute: 200, percent: 25.0, direction: 'up' },
          requests: { absolute: 0, percent: 0, direction: 'flat' },
          cost: { absolute: 0.002, percent: 25.0, direction: 'up' },
        },
      };

      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={injectionComparison}
          range="today"
          scope="local"
        />,
      );

      // Verify each malicious bucket index in tooltip formatter
      for (let i = 0; i < maliciousBuckets.length; i += 1) {
        const tooltipHtml = lastCapturedOption.tooltip.formatter([{ dataIndex: i }]);

        // Must NOT contain raw unescaped script, img, or svg tags
        expect(tooltipHtml).not.toContain('<script>');
        expect(tooltipHtml).not.toContain('<img src=x');
        expect(tooltipHtml).not.toContain('<svg');

        // MUST contain sanitized/escaped entities
        if (i === 0) {
          expect(tooltipHtml).toContain('&lt;script&gt;alert(&quot;XSS_HEADER&quot;)&lt;/script&gt;');
        } else if (i === 1) {
          expect(tooltipHtml).toContain('&lt;img src=x onerror=alert(&quot;XSS_IMG&quot;)&gt;');
        } else if (i === 3) {
          expect(tooltipHtml).toContain('&quot;&gt;&lt;svg onload=alert(1)&gt;');
        }
      }
    });
  });

  describe('Dimension 5: Fail-Closed Cloud Baseline Invariant', () => {
    it('enforces fail-closed null series for cloud scope when previous summary has 0 tokens and requests', () => {
      const unverifiedCloudComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'UTC',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00Z',
          currentEnd: '2026-09-02T23:59:59Z',
          previousStart: '2026-09-01T00:00:00Z',
          previousEnd: '2026-09-01T23:59:59Z',
          alignedThrough: '12:00',
        },
        current: {
          summary: { totalTokens: 100_000, inputTokens: 70_000, outputTokens: 30_000, cachedTokens: 0, totalCost: 0.45, totalRequests: 20, avgTokensPerReq: 5000 },
          series: [
            { bucket: '10:00', tokens: 40_000, requests: 8, cost: 0.18 },
            { bucket: '11:00', tokens: 60_000, requests: 12, cost: 0.27 },
          ],
        },
        previous: {
          summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 },
          series: [
            { bucket: '10:00', tokens: 0, requests: 0, cost: 0 },
            { bucket: '11:00', tokens: 0, requests: 0, cost: 0 },
          ],
        },
        delta: {
          tokens: { absolute: 100_000, percent: null, direction: 'new' },
          requests: { absolute: 20, percent: null, direction: 'new' },
          cost: { absolute: 0.45, percent: null, direction: 'new' },
        },
      };

      // 1. Verify helper function
      expect(isCloudComparisonBaselineUnverified('cloud', unverifiedCloudComparison)).toBe(true);
      expect(isCloudComparisonBaselineUnverified('local', unverifiedCloudComparison)).toBe(false);

      // 2. Render under cloud scope
      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={unverifiedCloudComparison}
          range="today"
          scope="cloud"
          initialTrack="tokens"
        />,
      );

      // Verify previous series data is null (fail-closed, no fake 0 line drawn)
      expect(lastCapturedOption.series[1].data).toEqual([null, null]);

      // Verify badges show "基线缺失" and "不按 0 计算"
      expect(screen.getAllByText('基线缺失').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/不按 0 计算/).length).toBeGreaterThanOrEqual(1);

      // Verify tooltip shows "云端基线未验证" instead of "+100% (+100K Tokens)"
      const tooltipHtml = lastCapturedOption.tooltip.formatter([{ dataIndex: 0 }]);
      expect(tooltipHtml).toContain('云端基线未验证');
      expect(tooltipHtml).not.toContain('+100%');

      // 3. Switch to Cost view
      const costBtn = screen.getByRole('button', { name: /费用视角/i });
      fireEvent.click(costBtn);
      expect(lastCapturedOption.series[1].data).toEqual([null, null]);

      // 4. Switch to Dual view
      const dualBtn = screen.getByRole('button', { name: /双轨对比/i });
      fireEvent.click(dualBtn);
      // In dual view, series 2 and 3 are previous tokens and previous cost
      expect(lastCapturedOption.series[2].data).toEqual([null, null]);
      expect(lastCapturedOption.series[3].data).toEqual([null, null]);

      // 5. Switch back to Token view
      const tokenBtn = screen.getByRole('button', { name: /Token 视角/i });
      fireEvent.click(tokenBtn);
      expect(lastCapturedOption.series[1].data).toEqual([null, null]);
    });

    it('renders authentic 0-baseline when local scope has zero previous tokens', () => {
      const localZeroPrevComparison: UsageComparison = {
        window: {
          kind: 'dayOverDay',
          timezone: 'Asia/Shanghai',
          bucket: 'hour',
          currentStart: '2026-09-02T00:00:00+08:00',
          currentEnd: '2026-09-02T23:59:59+08:00',
          previousStart: '2026-09-01T00:00:00+08:00',
          previousEnd: '2026-09-01T23:59:59+08:00',
          alignedThrough: '12:00',
        },
        current: {
          summary: { totalTokens: 100_000, inputTokens: 70_000, outputTokens: 30_000, cachedTokens: 0, totalCost: 0.45, totalRequests: 20, avgTokensPerReq: 5000 },
          series: [
            { bucket: '10:00', tokens: 40_000, requests: 8, cost: 0.18 },
            { bucket: '11:00', tokens: 60_000, requests: 12, cost: 0.27 },
          ],
        },
        previous: {
          summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 },
          series: [
            { bucket: '10:00', tokens: 0, requests: 0, cost: 0 },
            { bucket: '11:00', tokens: 0, requests: 0, cost: 0 },
          ],
        },
        delta: {
          tokens: { absolute: 100_000, percent: null, direction: 'new' },
          requests: { absolute: 20, percent: null, direction: 'new' },
          cost: { absolute: 0.45, percent: null, direction: 'new' },
        },
      };

      render(
        <TrendPanel
          trends={[]}
          activeTools={[]}
          comparison={localZeroPrevComparison}
          range="today"
          scope="local"
          initialTrack="tokens"
        />,
      );

      // In local mode, previous series renders authentic [0, 0]
      expect(lastCapturedOption.series[1].data).toEqual([0, 0]);
      expect(screen.queryByText('基线缺失')).not.toBeInTheDocument();
    });
  });
});
