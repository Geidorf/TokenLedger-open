import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { StatsData, UsageDetailsResponse } from '../../types';
import { isEstimatedLogItem } from '../../types';
import { UsagePage, usageSubLabelForTab } from './UsagePage';
import { UsageRecordsPanel } from './UsageRecordsPanel';
import { recordSourceLabel, summaryCacheReuse } from './usageSummary';

const stats = {
  summary: {
    totalTokens: 1000, inputTokens: 800, outputTokens: 200, cachedTokens: 3500,
    cacheReadTokens: 3200, cacheWriteTokens: 300, totalCost: 1.5, totalRequests: 10, avgTokensPerReq: 100,
  },
  tools: {
    codex: { name: 'codex', input: 600, output: 150, cached: 3000, total: 750, cost: 1, requests: 6 },
    claude: { name: 'claude', input: 200, output: 50, cached: 500, total: 250, cost: 0.5, requests: 4 },
  },
  models: {},
  trends: [],
  heatmap: {},
  history: [],
  comparison: { delta: { tokens: { absolute: 200, percent: 25, direction: 'up' } } },
} as unknown as StatsData;

function renderPage(sub: 'overview' | 'records' | 'sessions', toolbar?: ReactNode) {
  return render(
    <UsagePage
      sub={sub}
      stats={stats}
      range="month"
      customRange={null}
      toolbar={toolbar}
      overview={<div>旧总览模块</div>}
      records={<div>记录列表</div>}
      sessions={<div>旧行为分析</div>}
    />,
  );
}

describe('UsagePage', () => {
  it('概览显示有效 Token 结论，缓存单列不并入', () => {
    renderPage('overview');
    const conclusion = screen.getByTestId('usage-conclusion');
    expect(conclusion).toHaveTextContent('本月有效 Token');
    expect(conclusion).toHaveTextContent('+25.0%');
    expect(conclusion).toHaveTextContent('codex 占 75%');
    expect(conclusion).toHaveTextContent('缓存复用率 80.0%');
    expect(conclusion).toHaveTextContent('不计入有效 Token');
    expect(screen.getByText('旧总览模块')).toBeInTheDocument();
    expect(screen.queryByText('旧行为分析')).not.toBeInTheDocument();
    expect(screen.getByText('预估费用')).toBeInTheDocument();
  });

  it('页内没有子标签，只渲染当前子页；内容区以子页名称为可访问名称（U-101）', () => {
    renderPage('sessions');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '行为分析' })).toHaveTextContent('旧行为分析');
    expect(screen.queryByTestId('usage-conclusion')).not.toBeInTheDocument();
    expect(screen.queryByText('预估费用')).not.toBeInTheDocument();
  });

  it('子页工具行是内容区第一行，结论句与预估费用同一行紧随其后（T10.276、T10.277）', () => {
    renderPage('overview', <div data-testid="usage-toolbar">工具行</div>);
    const panel = screen.getByRole('region', { name: '概览' });
    expect(panel.firstElementChild).toBe(screen.getByTestId('usage-toolbar'));
    expect(panel.children[1]).toContainElement(screen.getByTestId('usage-conclusion'));
    expect(panel.children[1]).toHaveTextContent('预估费用');
    expect(panel.parentElement?.firstElementChild).toBe(screen.getByRole('heading', { level: 1, name: '概览' }));
  });

  it('记录子页的可访问名称随子页变化', () => {
    renderPage('records');
    expect(screen.getByRole('region', { name: '记录' })).toHaveTextContent('记录列表');
  });

  it('面包屑子页名称与侧栏同名，非用量页不给', () => {
    expect(usageSubLabelForTab('dashboard')).toBe('概览');
    expect(usageSubLabelForTab('records')).toBe('记录');
    expect(usageSubLabelForTab('behavior')).toBe('行为分析');
    expect(usageSubLabelForTab('logs')).toBeNull();
  });

  it('读写拆分不可证明时复用率不可得，不显示 0', () => {
    expect(summaryCacheReuse({ ...stats.summary, cacheReadTokens: undefined })).toBeNull();
  });
});

const details: UsageDetailsResponse = {
  status: 'ok',
  items: [
    { id: -42, tool: 'codex', model: 'gpt-5.5', inputTokens: 200, outputTokens: 80, cachedTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 0, cost: 0.002, timestamp: '2026-10-04T02:00:10Z', sessionId: 's1', machineId: 'mac', source: 'gateway', provider: 'openai' },
    { id: 7, tool: 'claude', model: 'claude-sonnet-4.5', inputTokens: 30, outputTokens: 6, cachedTokens: 0, cost: 0.0001, timestamp: '2026-10-04T01:00:00Z', sessionId: 'c1', machineId: 'mac' },
    { id: 8, tool: 'pi', model: 'x', inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0, timestamp: '2026-10-04T00:00:00Z', sessionId: 'p1', machineId: 'mac', source: 'future-source' },
  ],
  nextCursor: 'c', hasMore: true, totalCount: 3,
  filteredSummary: { totalTokens: 318, inputTokens: 231, outputTokens: 87, cachedTokens: 1000, totalCost: 0.0021, totalRequests: 3, avgTokensPerReq: 106 },
  availableFilters: { tools: [], models: [], machines: [] },
  granularity: 'request',
  meta: { capabilities: { gatewayLedger: true } },
};

describe('UsageRecordsPanel', () => {
  it('列出来源与供应商，缺失来源按日志扫描、未知来源照常显示', () => {
    const onLoadMore = vi.fn();
    const onOpenDetails = vi.fn();
    render(<UsageRecordsPanel details={details} loading={false} loadingMore={false} error="" filtered={false}
      onRetry={vi.fn()} onLoadMore={onLoadMore} onOpenDetails={onOpenDetails} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('网关');
    expect(rows[0]).toHaveTextContent('openai');
    expect(rows[1]).toHaveTextContent('日志扫描');
    expect(rows[1]).toHaveTextContent('—');
    expect(rows[2]).toHaveTextContent('未知来源');
    expect(screen.getByText(/以网关记录为准/)).toBeInTheDocument();
    expect(screen.getByText(/有效 Token 318/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(onLoadMore).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '筛选与搜索' }));
    expect(onOpenDetails).toHaveBeenCalled();
  });

  it('没有网关能力时不显示去重说明；错误给重试', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<UsageRecordsPanel details={{ ...details, meta: {} }} loading={false} loadingMore={false} error="" filtered
      onRetry={onRetry} onLoadMore={vi.fn()} onOpenDetails={vi.fn()} />);
    expect(screen.queryByText(/以网关记录为准/)).not.toBeInTheDocument();
    expect(screen.getByText('已按活动明细中的筛选显示')).toBeInTheDocument();
    rerender(<UsageRecordsPanel details={null} loading={false} loadingMore={false} error="网络断开" filtered={false}
      onRetry={onRetry} onLoadMore={vi.fn()} onOpenDetails={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('来源标签函数遵守契约 §2.5', () => {
    expect(recordSourceLabel({})).toBe('日志扫描');
    expect(recordSourceLabel({ source: 'scan' })).toBe('日志扫描');
    expect(recordSourceLabel({ source: 'gateway' })).toBe('网关');
    expect(recordSourceLabel({ source: 'imported-magpie' })).toBe('magpie 导入');
    expect(recordSourceLabel({ source: 'x' })).toBe('未知来源');
  });

  it('带激活筛选条件时显示具体筛选项并提供就地清除筛选动作', () => {
    const onClearFilters = vi.fn();
    render(
      <UsageRecordsPanel
        details={{ ...details, items: [], totalCount: 0 }}
        loading={false}
        loadingMore={false}
        error=""
        filtered
        filters={{ tools: ['antigravity'], models: ['gemini-2.5-pro'], machines: ['hz-pc'], search: 'sess-1' }}
        onClearFilters={onClearFilters}
        onRetry={vi.fn()}
        onLoadMore={vi.fn()}
        onOpenDetails={vi.fn()}
      />,
    );
    expect(
      screen.getByText('已按活动明细中的筛选显示（工具 antigravity · 模型 gemini-2.5-pro · 设备 hz-pc · 搜索 "sess-1"）'),
    ).toBeInTheDocument();
    expect(screen.getByText('当前筛选下没有匹配记录')).toBeInTheDocument();
    const clearButtons = screen.getAllByRole('button', { name: '清除筛选' });
    expect(clearButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(clearButtons[0]);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('按显式来源区分真实与估算行，零缓存真实行也不标约数', () => {
    expect(isEstimatedLogItem({ tool: 'antigravity', cachedTokens: 0, usageProvenance: 'reported' })).toBe(false);
    expect(isEstimatedLogItem({ tool: 'antigravity', cachedTokens: 1200, usageProvenance: 'estimated' })).toBe(true);
    expect(isEstimatedLogItem({ tool: 'antigravity', cachedTokens: 0, source: 'gateway' })).toBe(false);
  });

  it('兼容未提供来源字段的旧明细响应', () => {
    expect(isEstimatedLogItem({ tool: 'antigravity', cachedTokens: 0 })).toBe(true);
    expect(isEstimatedLogItem({ tool: 'antigravity', cachedTokens: 1200 })).toBe(false);
    expect(isEstimatedLogItem({ tool: 'Antigravity', cachedTokens: 0, cacheReadTokens: 450 })).toBe(false);
    expect(isEstimatedLogItem({ tool: 'trae', cachedTokens: 0 })).toBe(true);
    expect(isEstimatedLogItem({ tool: 'codex', cachedTokens: 0 })).toBe(false);
  });
});
