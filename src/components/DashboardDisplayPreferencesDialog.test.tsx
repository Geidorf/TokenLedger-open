import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardDisplayPreferencesDialog } from './DashboardDisplayPreferencesDialog';

describe('DashboardDisplayPreferencesDialog', () => {
  it('disables the final visible module switch and keeps move-button focus after an update', () => {
    const onModuleMove = vi.fn();
    render(<DashboardDisplayPreferencesDialog open modules={[{ id: 'metrics', label: '统计条', visible: true, width: 'full', widths: ['full', 'half'] }]}
      sources={[{ id: 'codex:consumer', label: 'Codex', visible: true }, { id: 'claude:consumer', label: 'Claude', visible: true }]}
      onClose={vi.fn()} onReset={vi.fn()} onModuleVisible={vi.fn()} onModuleMove={onModuleMove} onModuleWidth={vi.fn()}
      onSourceVisible={vi.fn()} onSourceMove={vi.fn()} />);
    expect(screen.getByRole('switch', { name: '至少保留一张卡片可见：统计条' })).toBeDisabled();
    const modulesTab = screen.getByRole('tab', { name: '首页卡片' });
    modulesTab.focus();
    fireEvent.keyDown(modulesTab, { key: 'ArrowRight' });
    const sourcesTab = screen.getByRole('tab', { name: '额度来源' });
    expect(sourcesTab).toHaveFocus();
    expect(sourcesTab).toHaveAttribute('aria-selected', 'true');
    const move = screen.getByRole('button', { name: '下移来源：Codex' });
    move.focus();
    fireEvent.click(move);
    expect(onModuleMove).not.toHaveBeenCalled();
    expect(move).toHaveFocus();
  });

  it('keeps width selects inside the focus trap for Shift+Tab', () => {
    render(<DashboardDisplayPreferencesDialog open
      modules={[{ id: 'metrics', label: '统计条', visible: true, width: 'full', widths: ['full', 'half'] },
        { id: 'trend', label: '趋势', visible: true, width: 'full', widths: ['full', 'half'] }]}
      sources={[]} onClose={vi.fn()} onReset={vi.fn()} onModuleVisible={vi.fn()} onModuleMove={vi.fn()} onModuleWidth={vi.fn()}
      onSourceVisible={vi.fn()} onSourceMove={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: '卡片宽度：趋势' });
    select.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    // 不是第一个可聚焦元素，陷阱不应把焦点绕到末尾的「完成」。
    expect(screen.getByRole('button', { name: '完成' })).not.toHaveFocus();
  });
});
