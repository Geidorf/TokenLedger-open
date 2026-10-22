import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CacheSavings, StatsData, Summary } from '../types';
import fixture from '../../fixtures/dashboard-stats-v2/cache-savings-v2.json';
import { MetricsGrid } from '../components/MetricsGrid';
import { CacheFlowPanel } from '../components/CacheFlowPanel';
import { buildShareSummary } from './shareSummary';
import { generateVisualDigestHtml } from './reportExport';
import { formatCacheNetSavedUsd } from './cacheSavingsDisplay';
import { formatEstimatedUsd } from './format';

afterEach(cleanup);
describe('同一净节省fixture在看板、面板、分享和简报消费一致', () => {
  it.each(fixture.cases)('$name', ({ summary: source, expected }) => {
    const summary = source as Summary;
    const stats = { ...fixture.statsTemplate, summary } as StatsData;
    const grid = render(<MetricsGrid summary={summary} showTotalTokens={false} />);
    expect(grid.container.textContent).toContain(`缓存净节省 ${formatCacheNetSavedUsd(expected.netSavedUsd)}`);
    cleanup();
    const panel = render(<CacheFlowPanel summary={summary} />);
    expect(panel.container.textContent).toContain(formatCacheNetSavedUsd(expected.netSavedUsd));
    expect(panel.container.textContent).toContain(`缓存读取节省 ${formatEstimatedUsd(expected.readSavedUsd)}`);
    expect(panel.container.textContent).toContain(`缓存写入溢价 ${formatEstimatedUsd(expected.writePremiumUsd)}`);
    if (expected.netSavedUsd < 0) expect(panel.container.textContent).toContain('写入溢价高于读取节省');
    const fallback = expected.fallbackPricedReadTokens + expected.fallbackPricedWriteTokens > 0;
    if (fallback) expect(panel.container.textContent).toContain('含兜底单价');
    const share = buildShareSummary({ stats, range: 'month', scope: 'local', hideCosts: false });
    expect(share.cacheNetSavedUsd).toBe(expected.netSavedUsd > 0 && !fallback ? expected.netSavedUsd : null);
    expect(buildShareSummary({ stats, range: 'month', scope: 'local', hideCosts: true }).cacheNetSavedUsd).toBeNull();
    const report = generateVisualDigestHtml({ stats, range: 'month', scope: 'local', appVersion: 'test' });
    expect(report).toContain('缓存净节省');
    expect(report).toContain('缓存读取节省');
    expect(report).toContain('缓存写入溢价');
    const hidden = generateVisualDigestHtml({ stats, range: 'month', scope: 'local', appVersion: 'test', hideCosts: true });
    expect(hidden).not.toContain(formatCacheNetSavedUsd(expected.netSavedUsd));
  });
  it('旧毛值不会被当作净值，拆分不成立也不会泄漏金额', () => {
    const summary = { ...fixture.cases[0].summary, cacheSavings: undefined } as Summary;
    let grid = render(<MetricsGrid summary={summary} showTotalTokens={false} />);
    expect(grid.container.textContent).toContain('缓存净节省不可得');
    cleanup();
    grid = render(<CacheFlowPanel summary={{ ...summary, cacheSavings: fixture.cases[0].expected as CacheSavings, cacheReadTokens: undefined }} />);
    expect(grid.container.textContent).not.toContain(formatEstimatedUsd(summary.cacheSavedUsd!));
  });
});
