import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { StatsData } from '../types';
import { DashboardContextBar, dashboardSnapshotCopy, dashboardSourceLabel } from './DashboardContextBar';

const cloudMeta: StatsData['meta'] = {
  stale: false,
  generatedAt: '2026-09-30T09:00:00Z',
  lastRefreshedAt: '2026-09-30T09:05:00Z',
  timezone: 'UTC',
  query: {
    range: 'month',
    timezone: 'Asia/Shanghai',
    machines: ['studio', 'laptop'],
    tools: [],
    models: [],
    search: null,
    tokenMode: 'effective',
  },
};

describe('DashboardContextBar', () => {
  it('把来源、周期、契约回显时区与数据时间收在同一条上下文里', () => {
    render(
      <DashboardContextBar
        scope="cloud"
        range="month"
        meta={cloudMeta}
        refreshCompletedAt="2026-09-30T09:05:02Z"
      />,
    );

    const bar = screen.getByRole('region', { name: '当前看板上下文' });
    expect(bar).toHaveTextContent('云端 · 已选 2 台设备');
    expect(bar).toHaveTextContent('本月');
    expect(bar).toHaveTextContent('Asia/Shanghai');
    expect(bar).toHaveTextContent('当前快照');
    expect(bar).toHaveTextContent('数据刷新于');
    expect(bar).toHaveTextContent('界面刷新完成于');
  });

  it('优先显示旧范围快照，且不把界面完成时间冒充数据时间', () => {
    render(
      <DashboardContextBar
        scope="local"
        range="month"
        meta={{
          stale: true,
          query: { ...cloudMeta.query!, range: 'week', machines: [] },
        }}
        refreshCompletedAt="2026-09-30T09:05:02Z"
        heldRangeNotice="正在加载「本月」，下方暂为「本周」的数据"
      />,
    );

    const bar = screen.getByRole('region', { name: '当前看板上下文' });
    expect(bar).toHaveTextContent('本机账本');
    expect(bar).toHaveTextContent('统计周期本周');
    expect(bar).not.toHaveTextContent('统计周期本月');
    expect(bar).toHaveTextContent('Asia/Shanghai');
    expect(bar).toHaveTextContent('旧范围快照');
    expect(bar).toHaveTextContent('界面刷新完成于');
    expect(bar).toHaveTextContent('数据时间未提供');
  });

  it('旧快照没有 query 回显时，只把新周期称为当前选择，不冒充数据周期', () => {
    render(
      <DashboardContextBar
        scope="local"
        range="custom"
        customRange={{ start: '2026-09-01', end: '2026-09-07' }}
        meta={{ stale: true }}
        heldRangeNotice="正在加载「9月1日—9月7日」，下方暂为「本周」的数据"
      />,
    );
    const bar = screen.getByRole('region', { name: '当前看板上下文' });
    expect(bar).toHaveTextContent('当前选择9月1日—9月7日（数据未更新）');
    expect(bar).not.toHaveTextContent('统计周期9月1日—9月7日');
  });

  it('未回显 machines 时不冒充全部设备，失败时明确是最近可信快照', () => {
    expect(dashboardSourceLabel('cloud', { timezone: 'UTC' })).toBe('云端 · 设备范围未回显');
    expect(dashboardSourceLabel('cloud', { query: { ...cloudMeta.query!, machines: [] } })).toBe('云端 · 全部设备');
    expect(dashboardSnapshotCopy({ refreshError: true })).toMatchObject({
      label: '最近可信快照',
      tone: 'warning',
    });
  });
});
