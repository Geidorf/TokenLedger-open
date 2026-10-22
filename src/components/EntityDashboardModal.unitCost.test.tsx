// Both 单位费用 cells (the insight strip without a comparison, the TrendPanel cell with one) must
// format through utils/unitCost.ts, and exactly one of them shows at a time (T10.159 + T10.163 join).
// formatUnitCost is replaced by a sentinel, so a cell that still formats locally shows a real dollar
// string and fails.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityDashboard } from '../types';
import { EntityDashboardModal } from './EntityDashboardModal';

vi.mock('./EChart', () => ({ EChart: () => null, default: () => null }));
vi.mock('./YearHeatmap', () => ({ YearHeatmap: () => null }));
vi.mock('../utils/unitCost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/unitCost')>();
  return {
    ...actual,
    UNIT_COST_LABEL: '单位费用',
    formatUnitCost: (value: number | null | undefined) => `SENTINEL:${value}`,
  };
});

const SUMMARY = {
  totalTokens: 6_000_000,
  inputTokens: 3_000_000,
  outputTokens: 3_000_000,
  cachedTokens: 30,
  totalCost: 12,
  totalRequests: 2,
  avgTokensPerReq: 3_000_000,
};

const BASE: EntityDashboard = {
  status: 'ok',
  entity: { kind: 'model', model: 'gpt-5-codex' },
  summary: SUMMARY,
  comparison: null,
  composition: { tools: [], models: [], machines: [] },
  heatmap: {},
  peak: {},
  activity: { activeDays: 1, firstSeenAt: null, lastSeenAt: null },
  historyPage: {
    status: 'ok',
    items: [],
    nextCursor: null,
    hasMore: false,
    totalCount: 0,
    filteredSummary: SUMMARY,
    availableFilters: { tools: [], models: [], machines: [] },
    granularity: 'request',
  },
  granularity: 'request',
};

const day = (index: number, month: string) => `2026-${month}-${String(index + 1).padStart(2, '0')}`;

const COMPARISON: NonNullable<EntityDashboard['comparison']> = {
  window: {
    kind: 'monthOverMonth', timezone: 'Asia/Shanghai', bucket: 'day',
    currentStart: '2026-07-01T00:00:00+08:00', currentEnd: '2026-07-15T14:30:00+08:00',
    previousStart: '2026-06-01T00:00:00+08:00', previousEnd: '2026-06-15T14:30:00+08:00',
    alignedThrough: '2026-07-15 14:30',
  },
  current: { summary: SUMMARY, series: Array.from({ length: 15 }, (_, i) => ({ bucket: day(i, '07'), tokens: 400_000, requests: 1, cost: 0.8 })) },
  previous: { summary: SUMMARY, series: Array.from({ length: 15 }, (_, i) => ({ bucket: day(i, '06'), tokens: 400_000, requests: 1, cost: 0.8 })) },
  delta: {
    tokens: { absolute: 0, percent: 0, direction: 'flat' },
    requests: { absolute: 0, percent: 0, direction: 'flat' },
    cost: { absolute: 0, percent: 0, direction: 'flat' },
  },
};

function renderModal(data: EntityDashboard, range: 'month' | 'year') {
  return render(
    <EntityDashboardModal
      selection={{ kind: 'model', name: 'gpt-5-codex' }}
      range={range}
      scope="local"
      data={data}
      loading={false}
      error=""
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onOpenDetails={vi.fn()}
      onOpenEntity={vi.fn()}
    />,
  );
}

describe('both 单位费用 cells format through utils/unitCost and never show twice', () => {
  it('strip cell (no comparison)', () => {
    renderModal(BASE, 'year');
    expect(screen.getAllByText('单位费用')).toHaveLength(1);
    expect(screen.getByText('单位费用').parentElement).toHaveTextContent('SENTINEL:2');
  });

  it('TrendPanel cell (comparison)', () => {
    renderModal({ ...BASE, comparison: COMPARISON }, 'month');
    expect(screen.getAllByText('单位费用')).toHaveLength(1);
    expect(screen.getByText('单位费用').closest('.comparison-kpi')).toHaveTextContent('SENTINEL:2');
  });
});
