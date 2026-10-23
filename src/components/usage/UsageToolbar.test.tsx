import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DataScope } from '../../types';
import { UsageToolbar } from './UsageToolbar';

function renderToolbar(variant: 'overview' | 'requests', dataScope: DataScope = 'local', cachedTokens = 10) {
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
      cachedTokens={cachedTokens}
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

  it('请求工具行只有同一全局范围；云端汇总时多出设备筛选', () => {
    renderToolbar('requests', 'cloud');
    expect(screen.getByRole('group', { name: '请求范围' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '统计时间范围' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '云端设备筛选' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '概览 Token 口径' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成并分享数据战报图片' })).not.toBeInTheDocument();
  });

  it('当前周期没有缓存 Token 时，口径开关说明两种口径数值相同', () => {
    renderToolbar('overview', 'local', 0);
    expect(screen.getByRole('button', { name: '概览有效' })).toHaveAttribute('title', '当前周期未记录到缓存 Token；概览指标使用输入 + 输出 Token');
    expect(screen.getByRole('button', { name: '概览含缓存' })).toHaveAttribute('title', '当前周期未记录到缓存 Token，概览有效与含缓存数值相同');
  });
});
