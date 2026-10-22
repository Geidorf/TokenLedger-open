import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardDisplayPreferencesDialog } from './DashboardDisplayPreferencesDialog';

describe('DashboardDisplayPreferencesDialog', () => {
  it('disables the final visible module switch and keeps move-button focus after an update', () => {
    const onModuleMove = vi.fn();
    render(<DashboardDisplayPreferencesDialog open modules={[{ id: 'kpi', label: '核心指标', visible: true }]}
      sources={[{ id: 'codex:consumer', label: 'Codex', visible: true }, { id: 'claude:consumer', label: 'Claude', visible: true }]}
      onClose={vi.fn()} onReset={vi.fn()} onModuleVisible={vi.fn()} onModuleMove={onModuleMove}
      onSourceVisible={vi.fn()} onSourceMove={vi.fn()} />);
    expect(screen.getByRole('switch', { name: '至少保留一个模块可见：核心指标' })).toBeDisabled();
    const modulesTab = screen.getByRole('tab', { name: '首页模块' });
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
});
