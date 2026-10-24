import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import type { LogHistoryItem } from '../../types';
import SessionDetailPage from './SessionDetailPage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../components/EChart', () => ({
  EChart: ({ ariaLabel }: { ariaLabel?: string }) => <div data-testid={`echart-${ariaLabel}`} />,
}));

function row(id: number, patch: Partial<LogHistoryItem> = {}): LogHistoryItem {
  return {
    id, tool: 'claude', model: 'model-a', inputTokens: 1000, outputTokens: 500, cachedTokens: 0, cost: 0.1,
    timestamp: `2026-07-15T06:${String(id).padStart(2, '0')}:00.000Z`, sessionId: 'sess-1', machineId: 'pc', granularity: 'request', ...patch,
  };
}

const rows = [row(1), row(2, { model: 'model-b', cost: 0.9, latencyMs: 2000 }), row(3, { cost: 0.3 })];

function mockBackend(peerSessions: unknown[] = [{ id: 'sess-2', tool: 'claude', tokens: 1500, requests: 1, cost: 0.5 }]) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'get_usage_details') return { items: [...rows].reverse(), hasMore: false, nextCursor: null, totalCount: rows.length, filteredSummary: {}, availableFilters: { tools: [], models: [], machines: [] }, granularity: 'request' };
    if (cmd === 'get_local_behavior_analysis') return { meta: { start: '2026-06-16', end: '2026-07-15', sessionsTruncated: false }, sessions: peerSessions };
    return undefined;
  });
}

describe('SessionDetailPage', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('显示概要、同类对比、最贵请求与时间线', async () => {
    mockBackend();
    const onOpenRequests = vi.fn();
    render(<SessionDetailPage sessionRef={{ sessionId: 'sess-1', tool: 'claude' }} timezone="Asia/Shanghai" onBack={vi.fn()} onOpenRequests={onOpenRequests} />);
    expect(await screen.findByText('逐条时间线')).toBeTruthy();
    expect(screen.getAllByText('≈$1.30').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('×2.6')).toBeTruthy());
    expect(screen.getAllByText('切换')).toHaveLength(2);
    const top = screen.getByRole('heading', { name: /费用最高的记录/ }).closest('section')!;
    expect(top.querySelector('.session-detail-top button')?.textContent).toContain('≈$0.9000');
    fireEvent.click(screen.getByRole('button', { name: /在请求明细中查看/ }));
    expect(onOpenRequests).toHaveBeenCalledWith({ sessionId: 'sess-1', tool: 'claude', range: { start: '2026-07-15', end: '2026-07-15' } });
    expect(screen.getByText(/没有经过本机网关的请求/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /逐轮分析/ })).toBeTruthy();
  });

  it('没有同类会话时说明原因', async () => {
    mockBackend([]);
    render(<SessionDetailPage sessionRef={{ sessionId: 'sess-1', tool: 'claude' }} timezone="UTC" onBack={vi.fn()} onOpenRequests={vi.fn()} />);
    expect(await screen.findByText('这段时间没有同一工具的其他会话可比。')).toBeTruthy();
  });

  it('找不到会话时显示空状态，返回按钮可用', async () => {
    vi.mocked(invoke).mockResolvedValue({ items: [], hasMore: false, nextCursor: null, totalCount: 0, filteredSummary: {}, availableFilters: { tools: [], models: [], machines: [] }, granularity: 'request' });
    const onBack = vi.fn();
    render(<SessionDetailPage sessionRef={{ sessionId: 'gone', tool: null }} timezone="UTC" onBack={onBack} onOpenRequests={vi.fn()} />);
    expect(await screen.findByText('找不到这个会话')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /返回会话列表/ }));
    expect(onBack).toHaveBeenCalled();
  });

  it('读取失败时可重新读取', async () => {
    mockBackend();
    vi.mocked(invoke).mockRejectedValueOnce(new Error('boom'));
    render(<SessionDetailPage sessionRef={{ sessionId: 'sess-1', tool: 'claude' }} timezone="UTC" onBack={vi.fn()} onOpenRequests={vi.fn()} />);
    expect(await screen.findByText('读取会话失败')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重新读取/ }));
    expect(await screen.findByText('逐条时间线')).toBeTruthy();
  });
});
