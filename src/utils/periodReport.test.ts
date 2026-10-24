import { describe, expect, it } from 'vitest';
import type { BehaviorAnalysisResponse, StatsData } from '../types';
import type { BudgetRule } from '../hooks/useBudget';
import { buildPeriodReport, budgetUsed, compareValues, describeDelta, reportPeriod, reportPeriodOptions, weekStart } from './periodReport';
import { budgetPercentText, generatePeriodReportHtml } from './periodReportExport';

function stats(input: number, output: number, extra: Partial<StatsData> = {}): StatsData {
  return {
    summary: {
      totalTokens: input + output,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: 300,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      totalCost: 12.5,
      totalRequests: 40,
      avgTokensPerReq: 10,
    },
    tools: {
      codex: { name: 'codex', input: input * 0.75, output: output * 0.75, cached: 0, total: (input + output) * 0.75, cost: 9, requests: 30 },
      claude: { name: 'claude', input: input * 0.25, output: output * 0.25, cached: 0, total: (input + output) * 0.25, cost: 3.5, requests: 10 },
    },
    models: {
      'gpt-5-codex': { name: 'gpt-5-codex', total: input + output, requests: 40, input, output, cost: 12.5 },
    },
    trends: [],
    heatmap: { '2026-10-13': 100, '2026-10-15': input + output - 100, '2026-10-01': 999 },
    history: [],
    ...extra,
  };
}

const rule = (patch: Partial<BudgetRule>): BudgetRule => ({
  id: 'r', enabled: true, period: 'week', metric: 'cost', scopeKind: 'all', scopeId: '', limit: 10, warnPercent: 80, ...patch,
});

describe('reportPeriod', () => {
  it('uses Monday weeks and compares a finished week with the whole week before', () => {
    expect(weekStart('2026-10-24')).toBe('2026-10-19');
    const last = reportPeriod('week', -1, '2026-10-24');
    expect(last).toMatchObject({
      start: '2026-10-12', end: '2026-10-18', complete: true,
      previousStart: '2026-10-05', previousEnd: '2026-10-11', shortLabel: '上周', label: '10月12日—10月18日',
    });
  });

  it('compares a running period with the same number of days', () => {
    const week = reportPeriod('week', 0, '2026-10-21');
    expect(week).toMatchObject({ start: '2026-10-19', end: '2026-10-21', complete: false, previousStart: '2026-10-12', previousEnd: '2026-10-14' });
    const month = reportPeriod('month', 0, '2026-03-31');
    expect(month).toMatchObject({ start: '2026-03-01', end: '2026-03-31', previousStart: '2026-02-01', previousEnd: '2026-02-28' });
  });

  it('walks whole months across a year boundary', () => {
    const january = reportPeriod('month', -1, '2027-02-03');
    expect(january).toMatchObject({ start: '2027-01-01', end: '2027-01-31', previousStart: '2026-12-01', previousEnd: '2026-12-31', label: '2027年1月' });
    expect(reportPeriodOptions('month', '2027-02-03')).toHaveLength(6);
  });
});

describe('compareValues', () => {
  it('never invents a percentage without a baseline', () => {
    expect(compareValues(5, 0)).toEqual({ kind: 'new' });
    expect(compareValues(0, 0)).toEqual({ kind: 'flat' });
    expect(compareValues(null, 4)).toEqual({ kind: 'unavailable' });
    expect(describeDelta(compareValues(15, 10))).toBe('+50.0%');
    expect(describeDelta(compareValues(5, 10))).toBe('−50.0%');
  });
});

describe('buildPeriodReport', () => {
  const period = reportPeriod('week', -1, '2026-10-21');

  it('summarises the period against the previous one with the dashboard formulas', () => {
    const report = buildPeriodReport({ period, scope: 'local', current: stats(1500, 500), previous: stats(750, 250), now: new Date('2026-10-21T02:00:00Z') });
    expect(report.totals).toMatchObject({ effectiveTokens: 2000, requests: 40, cost: 12.5, activeDays: 2 });
    expect(report.totals.cacheReuse).toBeCloseTo(200 / 1700);
    expect(report.deltas.tokens).toEqual({ kind: 'change', percent: 100 });
    expect(report.deltas.cost).toEqual({ kind: 'flat' });
    expect(report.days).toHaveLength(7);
    expect(report.peakDay?.date).toBe('2026-10-15');
    expect(report.agents.map((row) => row.name)).toEqual(['Codex', 'Claude']);
    expect(report.agents[0].share).toBeCloseTo(0.75);
    expect(report.accounts).toBeNull();
    expect(report.highlights[0]).toContain('多 100%');
  });

  it('treats an empty cloud baseline as missing, not as a real zero', () => {
    const empty = stats(0, 0);
    empty.summary.totalRequests = 0;
    empty.tools = {};
    const cloud = buildPeriodReport({ period, scope: 'cloud', current: stats(10, 10), previous: empty });
    expect(cloud.deltas.tokens).toEqual({ kind: 'missing' });
    expect(describeDelta(cloud.deltas.tokens)).toBe('基线缺失');
    expect(cloud.previous).toBeNull();
    expect(cloud.agents[0].delta).toEqual({ kind: 'unavailable' });
    const local = buildPeriodReport({ period, scope: 'local', current: stats(10, 10), previous: empty });
    expect(local.deltas.tokens).toEqual({ kind: 'new' });
  });

  it('keeps a breakdown row without input or output as unknown, not zero', () => {
    const current = stats(1500, 500);
    current.tools.claude = { name: 'claude', cached: 0, total: 0, cost: 3.5, requests: 10 } as unknown as typeof current.tools.claude;
    const report = buildPeriodReport({ period, scope: 'local', current, previous: stats(750, 250) });
    const claude = report.agents.find((row) => row.id === 'claude');
    expect(claude).toMatchObject({ tokens: null, share: null, delta: { kind: 'unavailable' }, requests: 10 });
    expect(report.agents.map((row) => row.id)).toEqual(['codex', 'claude']);
    expect(report.highlights.join()).not.toContain('用量最多');
    expect(generatePeriodReportHtml(report)).toContain('不可得');
  });

  it('orders sessions by known cost and keeps unpriced ones last', () => {
    const behavior = {
      meta: { sessionsTruncated: false, sessionLimit: 100 },
      sessions: [
        { id: 'a', tool: 'codex', tokens: 900, requests: 3, cost: null },
        { id: 'b', tool: 'claude', tokens: 10, requests: 1, cost: 4 },
        { id: 'c', tool: 'codex', tokens: 50, requests: 2, cost: 7 },
      ],
    } as unknown as BehaviorAnalysisResponse;
    const report = buildPeriodReport({ period, scope: 'local', current: stats(10, 10), previous: null, behavior });
    expect(report.sessions?.map((session) => session.id)).toEqual(['c', 'b', 'a']);
    expect(report.deltas.tokens).toEqual({ kind: 'unavailable' });
    const cloud = buildPeriodReport({ period, scope: 'cloud', current: stats(10, 10), previous: null, behavior });
    expect(cloud.sessions).toBeNull();
    expect(cloud.sessionsNote).toContain('本机账本');
  });

  it('rechecks only budgets of the same period, like the backend', () => {
    const current = stats(1500, 500);
    const report = buildPeriodReport({
      period, scope: 'local', current, previous: null,
      budgetRules: [rule({ id: 'over', limit: 10 }), rule({ id: 'month', period: 'month' }), rule({ id: 'tool', metric: 'tokens', scopeKind: 'tool', scopeId: 'claude', limit: 1000 })],
    });
    expect(report.budgets.map((budget) => [budget.id, budget.level])).toEqual([['over', 'over'], ['tool', 'ok']]);
    expect(budgetUsed(rule({ scopeKind: 'provider', scopeId: 'x' }), current)).toBeNull();
    expect(budgetUsed(rule({ scopeKind: 'model', scopeId: 'missing' }), current)).toBe(0);
  });
});

describe('generatePeriodReportHtml', () => {
  const period = reportPeriod('week', -1, '2026-10-21');

  it('escapes names and leaves amounts out when costs are hidden', () => {
    const current = stats(100, 100);
    current.tools['<x>'] = { name: '<img src=x>', input: 5, output: 5, cached: 0, total: 10, cost: 1, requests: 1 };
    const report = buildPeriodReport({ period, scope: 'local', current, previous: stats(50, 50) });
    const hidden = generatePeriodReportHtml(report, { hideCosts: true });
    expect(hidden).not.toContain('<img src=x>');
    expect(hidden).toContain('&lt;img src=x&gt;');
    expect(hidden).not.toMatch(/\$\d/);
    expect(hidden).toContain('费用已隐藏');
    expect(generatePeriodReportHtml(report)).toContain('$12.50');
  });

  it('hides the spent ratio of cost budgets but not of token budgets', () => {
    const report = buildPeriodReport({
      period, scope: 'local', current: stats(100, 100), previous: null,
      budgetRules: [rule({ id: 'cost', limit: 25 }), rule({ id: 'tokens', metric: 'tokens', limit: 800 })],
    });
    expect(budgetPercentText(report.budgets[0], true)).toBe('已隐藏');
    expect(budgetPercentText(report.budgets[0], false)).toBe('50%');
    expect(budgetPercentText(report.budgets[1], true)).toBe('25%');
    expect(generatePeriodReportHtml(report, { hideCosts: true })).not.toContain('>50%<');
  });
});
