import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DataScope } from '../../types';
import { UsageToolbar } from './UsageToolbar';

function renderToolbar(variant: 'overview' | 'records', dataScope: DataScope = 'local') {
  const onRangeChange = vi.fn();
  const onOpenShareCard = vi.fn();
  render(
    <UsageToolbar
      variant={variant}
      dataScope={dataScope}
      range="today"
      customRange={null}
      onRangeChange={onRangeChange}
      deviceFilter="all_cloud"
      deviceList={['mac-mini']}
      onDeviceFilterChange={vi.fn()}
      showTotalTokens={false}
      onToggleTokenMode={vi.fn()}
      cachedTokens={10}
      onOpenShareCard={onOpenShareCard}
    />,
  );
  return { onRangeChange, onOpenShareCard };
}

describe('UsageToolbar', () => {
  it('概览工具行带全局范围、口径与战报，操作写回全局范围', () => {
    const { onRangeChange, onOpenShareCard } = renderToolbar('overview');
    expect(screen.getByRole('group', { name: '概览范围与口径' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '本月' }));
    expect(onRangeChange).toHaveBeenCalledWith('month');
    expect(screen.getByRole('group', { name: '概览 Token 口径' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成并分享数据战报图片' }));
    expect(onOpenShareCard).toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: '云端设备筛选' })).not.toBeInTheDocument();
  });

  it('记录工具行只有同一全局范围；云端汇总时多出设备筛选', () => {
    renderToolbar('records', 'cloud');
    expect(screen.getByRole('group', { name: '记录范围' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '统计时间范围' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '云端设备筛选' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '概览 Token 口径' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成并分享数据战报图片' })).not.toBeInTheDocument();
  });
});
