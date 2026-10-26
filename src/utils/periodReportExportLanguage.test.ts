import { afterEach, describe, expect, it } from 'vitest';
import type { BudgetRule } from '../hooks/useBudget';
import { setLangPreference } from '../i18n';
import type { StatsData } from '../types';
import { buildPeriodReport, reportPeriod } from './periodReport';
import { generatePeriodReportHtml } from './periodReportExport';

function fixture(): StatsData {
  return {
    summary: {
      totalTokens: 300, inputTokens: 200, outputTokens: 100,
      cachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalCost: 5, totalRequests: 2, avgTokensPerReq: 150,
    },
    tools: {}, models: {}, trends: [], heatmap: {}, history: [],
  };
}

const budget: BudgetRule = {
  id: 'weekly-cost', enabled: true, period: 'week', metric: 'cost',
  scopeKind: 'all', scopeId: '', limit: 10, warnPercent: 80,
};

afterEach(() => setLangPreference('zh'));

describe('周期报告的导出语言边界', () => {
  it('界面切到英文不改变同一报告的中文导出与预算标签', () => {
    setLangPreference('zh');
    const report = buildPeriodReport({
      period: reportPeriod('week', -1, '2026-10-21'),
      scope: 'local', current: fixture(), previous: null,
      budgetRules: [budget],
      now: new Date('2026-10-21T08:00:00Z'),
    });
    const chinese = generatePeriodReportHtml(report);
    setLangPreference('en');
    expect(generatePeriodReportHtml(report)).toBe(chinese);
    expect(generatePeriodReportHtml(report, { hideCosts: true })).not.toMatch(/\$\d/);
  });

  it('英文界面下无显式语言的构建仍保留中文日期、亮点和标题', () => {
    setLangPreference('en');
    const report = buildPeriodReport({
      period: reportPeriod('week', -1, '2026-10-21'),
      scope: 'local', current: fixture(), previous: fixture(),
      now: new Date('2026-10-21T08:00:00Z'),
    });
    expect(report.period.label).toBe('10月12日—10月18日');
    expect(report.period.shortLabel).toBe('上周');
    expect(report.highlights.join(' ')).toContain('有效 Token');
    const exported = new DOMParser().parseFromString(generatePeriodReportHtml(report), 'text/html');
    expect(exported.documentElement.lang).toBe('zh-CN');
    expect(exported.querySelector('h1')?.textContent).toBe('用量周报 · 10月12日—10月18日');
  });
});
