import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import type { StatsData } from '../../types';
import { isEstimatedLogItem } from '../../types';
import { UsagePage, usageSubForTab, usageSubLabelForTab, type UsageSub } from './UsagePage';
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

function renderPage(sub: UsageSub, toolbar?: ReactNode) {
  return render(
    <UsagePage
      sub={sub}
      stats={stats}
      range="month"
      customRange={null}
      toolbar={toolbar}
      overview={<div>旧总览模块</div>}
      requests={<div>请求列表</div>}
      sessions={<div>旧行为分析</div>}
      allowances={<div>额度详情</div>}
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
    expect(screen.getByRole('region', { name: '会话' })).toHaveTextContent('旧行为分析');
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

  it('请求与额度子页的可访问名称随子页变化', () => {
    renderPage('requests');
    expect(screen.getByRole('region', { name: '请求' })).toHaveTextContent('请求列表');
    expect(screen.queryByText('额度详情')).not.toBeInTheDocument();
  });

  it('额度子页只渲染额度详情', () => {
    renderPage('allowances');
    expect(screen.getByRole('region', { name: '额度' })).toHaveTextContent('额度详情');
    expect(screen.queryByTestId('usage-conclusion')).not.toBeInTheDocument();
  });

  it('面包屑子页名称与侧栏同名，非用量页不给', () => {
    expect(usageSubLabelForTab('dashboard')).toBe('概览');
    expect(usageSubLabelForTab('logs')).toBe('请求');
    expect(usageSubLabelForTab('behavior')).toBe('会话');
    expect(usageSubLabelForTab('allowances')).toBe('额度');
    expect(usageSubLabelForTab('settings')).toBeNull();
    expect(usageSubForTab('gateway')).toBeNull();
  });

  it('读写拆分不可证明时复用率不可得，不显示 0', () => {
    expect(summaryCacheReuse({ ...stats.summary, cacheReadTokens: undefined })).toBeNull();
  });
});

describe('请求明细的来源与估算标记', () => {
  it('来源标签函数遵守契约 §2.5', () => {
    expect(recordSourceLabel({})).toBe('日志扫描');
    expect(recordSourceLabel({ source: 'scan' })).toBe('日志扫描');
    expect(recordSourceLabel({ source: 'gateway' })).toBe('网关');
    expect(recordSourceLabel({ source: 'imported-magpie' })).toBe('magpie 导入');
    expect(recordSourceLabel({ source: 'x' })).toBe('未知来源');
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
