import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardTab } from './DashboardTab';
import type { CustomDateRange, RangeKey, StatsData } from '../types';

// T10.161 P2-4：DashboardTab 把 range / customRange / 快照截止点交给年度日历这一行，在与 T10.158 合并时
// 必然冲突。只替身重图表，日历三层（DashboardTab → HeatmapSection → YearHeatmap）全用真实实现；
// 解冲突时漏掉任何一个参数，下面的断言都会失败（HeatmapSection 的三个参数也已改为必填，tsc 同样会报错）。
vi.mock('./MetricsGrid', () => ({ MetricsGrid: () => <div data-testid="metrics-grid" /> }));
vi.mock('./TrendPanel', () => ({ TrendPanel: () => <div data-testid="trend-panel" /> }));

// 上海时间 2026-09-24 20:00；快照时区显式给出，结果不随宿主时区变化。
const NOW = new Date('2026-09-24T12:00:00Z');

function statsFor(range: RangeKey, generatedAt: string, heatmap: Record<string, number>, customRange?: CustomDateRange): StatsData {
  return {
    summary: { totalTokens: 10000, inputTokens: 6000, outputTokens: 4000, cachedTokens: 2000, totalCost: 0.5, totalRequests: 20, avgTokensPerReq: 500 },
    tools: { codex: { name: 'codex', input: 6000, output: 4000, cached: 2000, total: 10000, cost: 0.5, requests: 20 } },
    models: { 'gpt-5': { name: 'gpt-5', input: 6000, output: 4000, cached: 2000, total: 10000, cost: 0.5, requests: 20 } },
    trends: [],
    heatmap,
    history: [],
    meta: {
      contractVersion: 2,
      generatedAt,
      timezone: 'Asia/Shanghai',
      query: {
        range,
        timezone: 'Asia/Shanghai',
        machines: [],
        tools: [],
        models: [],
        search: null,
        tokenMode: 'effective',
        ...(customRange ? { start: customRange.start, end: customRange.end } : {}),
      },
    },
  };
}

function renderDashboard(range: RangeKey, stats: StatsData, customRange: CustomDateRange | null = null) {
  const view = render(
    <DashboardTab
      stats={stats}
      statsLoading={false}
      statsError=""
      statsErrorAction={null}
      scanBusy={false}
      syncBusy={false}
      activeTools={Object.values(stats.tools)}
      topModels={Object.values(stats.models)}
      showTotalTokens={false}
      scope="local"
      range={range}
      customRange={customRange}
      cloudAuthenticated={true}
      cloudCapabilityVerified={true}
      quotaProviders={[]}
      quotaLoading={false}
      quotaError=""
      quotaSyncStatus={{ enabled: true, state: 'active' }}
      onQuotaSyncNow={vi.fn()}
      unsyncedRecords={0}
      onScan={vi.fn()}
      onSync={vi.fn()}
      onOpenCloudSettings={vi.fn()}
      onRetryStats={vi.fn()}
      onRelogin={vi.fn()}
      onViewLocal={vi.fn()}
      onRefreshQuotas={vi.fn()}
      onOpenQuotaSettings={vi.fn()}
      onQuotaNotify={vi.fn()}
      onSelectDate={vi.fn()}
      refreshCompletedAt="2026-09-24T20:00:00+08:00"
    />,
  );
  const panel = view.container.querySelector<HTMLElement>('.heatmap-panel');
  if (!panel) throw new Error('年度日历没有渲染');
  const dayCell = (date: string) => within(panel).getByLabelText(new RegExp(`^${date}:`));
  return { panel, dayCell };
}

describe('DashboardTab → 年度日历接线（T10.161）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('往年自定义区间：画那一年，区间外是未查询，区间内没有记录的日期是 0', () => {
    const customRange = { start: '2025-10-01', end: '2025-12-31' };
    const { dayCell } = renderDashboard(
      'custom',
      statsFor('custom', '2026-01-05T10:00:00+08:00', { '2025-11-02': 5_000 }, customRange),
      customRange,
    );

    expect(screen.getByText('2025 年 Token 消耗日历')).toBeInTheDocument();
    expect(dayCell('2025-03-01')).toHaveAttribute('aria-label', '2025-03-01: 未查询');
    expect(dayCell('2025-10-05')).toHaveAttribute('aria-label', '2025-10-05: 0 Tokens');
    expect(dayCell('2025-11-02')).toHaveAttribute('data-level', '5');
  });

  it('今年范围沿用旧快照：快照生成日之后是未查询，之前没有记录的日期是 0', () => {
    const { panel, dayCell } = renderDashboard('year', statsFor('year', '2026-07-15T14:30:00+08:00', { '2026-07-15': 3_000 }));

    expect(within(panel).getByText('本年度 Token 消耗日历')).toBeInTheDocument();
    expect(within(panel).getByText('只查询了 2026-01-01 至 2026-07-15，其余日期未查询，不代表没有用量。')).toBeInTheDocument();
    expect(dayCell('2026-07-10')).toHaveAttribute('aria-label', '2026-07-10: 0 Tokens');
    expect(dayCell('2026-08-01')).toHaveAttribute('aria-label', '2026-08-01: 未查询');
  });
});
