import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UsageDetailsResponse } from '../types';
import { LogsTable } from './LogsTable';

// 每行画一个品牌图标：数它被渲染了几次，就知道哪些行重新渲染了。
const brandRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('./brand/BrandIcon', () => ({
  BrandIcon: () => {
    brandRenders.count += 1;
    return null;
  },
}));

function detailsWith(count: number): UsageDetailsResponse {
  return {
    status: 'ok',
    items: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      tool: index % 2 ? 'claude' : 'codex',
      model: 'gpt-5-codex',
      inputTokens: 100 + index,
      outputTokens: 50,
      cachedTokens: 0,
      cost: 0.01,
      timestamp: `2026-08-21T06:${String(index % 60).padStart(2, '0')}:00.000Z`,
      sessionId: `session-${index}`,
      machineId: index % 3 ? 'Studio-PC' : 'Laptop',
      requests: 1,
      granularity: 'request' as const,
    })),
    nextCursor: null,
    hasMore: false,
    totalCount: count,
    filteredSummary: {
      totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      cacheSavedUsd: 0, totalCost: 0, totalRequests: count, avgTokensPerReq: 0,
    },
    availableFilters: { tools: [], models: [], machines: [] },
    granularity: 'request',
  };
}

function renderTable(details: UsageDetailsResponse, onFilterChange = vi.fn(), onOpenEntity = vi.fn()) {
  const props = {
    filters: { tools: [], models: [], machines: [], search: '' },
    loading: false,
    loadingMore: false,
    error: '',
    scope: 'local' as const,
    range: 'today' as const,
    onFilterChange,
    onClearFilters: vi.fn(),
    onRetry: vi.fn(),
    onLoadMore: vi.fn(),
    onOpenEntity,
  };
  const view = render(<LogsTable {...props} details={details} />);
  return { ...view, rerenderWith: (next: UsageDetailsResponse) => view.rerender(<LogsTable {...props} details={next} />) };
}

describe('LogsTable 行渲染开销', () => {
  it('在搜索框打字、展开一行时，其他行不重新渲染', () => {
    renderTable(detailsWith(40));
    expect(brandRenders.count).toBe(40);

    brandRenders.count = 0;
    fireEvent.change(screen.getByLabelText('搜索工具、模型、设备或 Session'), { target: { value: 'cla' } });
    expect(brandRenders.count).toBe(0);

    fireEvent.click(screen.getAllByRole('button', { name: '展开此记录详情' })[5]);
    // 只有被展开的那一行重画。
    expect(brandRenders.count).toBe(1);
    expect(screen.getAllByRole('button', { name: '收起此记录详情' })).toHaveLength(1);
  });

  it('加载更多只渲染新追加的行', () => {
    const first = detailsWith(50);
    const { rerenderWith } = renderTable(first);
    brandRenders.count = 0;
    const more = detailsWith(100);
    rerenderWith({ ...more, items: [...first.items, ...more.items.slice(50)] });
    expect(brandRenders.count).toBe(50);
  });

  it('行内的设备筛选与看板入口仍拿到最新的筛选与回调', () => {
    const onFilterChange = vi.fn();
    const onOpenEntity = vi.fn();
    renderTable(detailsWith(3), onFilterChange, onOpenEntity);
    fireEvent.click(screen.getAllByRole('button', { name: '按设备筛选 Laptop' })[0]);
    expect(onFilterChange).toHaveBeenCalledWith('machines', ['Laptop']);
    fireEvent.click(screen.getAllByTitle('打开 gpt-5-codex 专属看板')[0]);
    expect(onOpenEntity).toHaveBeenCalledWith('model', 'gpt-5-codex', 'codex');
  });

  it('展开列的表头有读屏可读的名称', () => {
    renderTable(detailsWith(1));
    expect(screen.getByRole('columnheader', { name: '展开详情' })).toBeInTheDocument();
  });
});
