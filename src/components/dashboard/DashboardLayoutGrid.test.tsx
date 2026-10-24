import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardLayoutGrid } from './DashboardLayoutGrid';
import { moveCardTo, type DashboardCardId, type DashboardLayoutCard } from '../../utils/dashboardLayout';

const START: DashboardLayoutCard[] = [
  { id: 'metrics', visible: true, width: 'full' },
  { id: 'trend', visible: true, width: 'full' },
  { id: 'heatmap', visible: true, width: 'full' },
  { id: 'tools', visible: false, width: 'full' },
];

function Harness({ editing = true, onWidth = vi.fn(), start = START, onEdit }: {
  editing?: boolean; onWidth?: (id: DashboardCardId, width: string) => void; start?: DashboardLayoutCard[]; onEdit?: () => void;
}) {
  const [cards, setCards] = useState(start);
  return <DashboardLayoutGrid
    cards={cards}
    editing={editing}
    renderCard={id => id === 'heatmap' ? null : <div data-testid={`card-${id}`}>{id}</div>}
    emptyNote={() => '当前范围不显示'}
    onMove={(id, index) => setCards(current => moveCardTo(current, id, index))}
    onVisible={(id, visible) => setCards(current => current.map(item => item.id === id ? { ...item, visible } : item))}
    onWidth={onWidth}
    onEdit={onEdit}
  />;
}

const order = () => Array.from(document.querySelectorAll<HTMLElement>('[data-layout-card]')).map(element => element.dataset.layoutCard);

describe('DashboardLayoutGrid', () => {
  it('shows only visible cards with content when not editing', () => {
    render(<Harness editing={false} />);
    expect(order()).toEqual(['metrics', 'trend']);
    expect(screen.queryByRole('button', { name: /移动卡片/ })).not.toBeInTheDocument();
  });

  it('moves a card with the keyboard, keeps focus on its handle, and announces the position', () => {
    render(<Harness />);
    expect(order()).toEqual(['metrics', 'trend', 'heatmap', 'tools']);
    const handle = screen.getByRole('button', { name: '移动卡片：趋势，第 2 张，共 4 张' });
    handle.focus();
    fireEvent.keyDown(handle, { key: ' ' });
    expect(handle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('已拿起趋势');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(order()).toEqual(['trend', 'metrics', 'heatmap', 'tools']);
    expect(screen.getByRole('button', { name: /移动卡片：趋势/ })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('趋势：第 1 张，共 4 张');
    fireEvent.keyDown(screen.getByRole('button', { name: /移动卡片：趋势/ }), { key: 'End' });
    expect(order()).toEqual(['metrics', 'heatmap', 'tools', 'trend']);
    fireEvent.keyDown(screen.getByRole('button', { name: /移动卡片：趋势/ }), { key: 'Enter' });
    expect(screen.getByRole('button', { name: /移动卡片：趋势/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('已放下趋势');
  });

  it('Escape puts a grabbed card back where it started', () => {
    render(<Harness />);
    const handle = screen.getByRole('button', { name: /移动卡片：统计条/ });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'Enter' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('button', { name: /移动卡片：统计条/ }), { key: 'ArrowDown' });
    expect(order()).toEqual(['trend', 'heatmap', 'metrics', 'tools']);
    fireEvent.keyDown(screen.getByRole('button', { name: /移动卡片：统计条/ }), { key: 'Escape' });
    expect(order()).toEqual(['metrics', 'trend', 'heatmap', 'tools']);
    expect(screen.getByRole('status')).toHaveTextContent('已取消移动');
  });

  it('arrow keys do nothing until the card is picked up', () => {
    render(<Harness />);
    const handle = screen.getByRole('button', { name: /移动卡片：趋势/ });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(order()).toEqual(['metrics', 'trend', 'heatmap', 'tools']);
  });

  it('edits width and visibility, shows hidden and empty cards as notes, and protects the last visible card', () => {
    const onWidth = vi.fn();
    render(<Harness onWidth={onWidth} />);
    fireEvent.click(within(screen.getByRole('group', { name: '趋势宽度' })).getByRole('button', { name: '半宽' }));
    expect(onWidth).toHaveBeenCalledWith('trend', 'half');
    // 统计条只有全宽，不显示宽度切换。
    expect(screen.queryByRole('group', { name: '统计条宽度' })).not.toBeInTheDocument();
    expect(screen.getByText('当前范围不显示')).toBeInTheDocument();
    expect(screen.getByText('已隐藏')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '显示卡片：Agent 用量' }));
    expect(screen.getByTestId('card-tools')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '隐藏卡片：趋势' }));
    fireEvent.click(screen.getByRole('button', { name: '隐藏卡片：热力图' }));
    fireEvent.click(screen.getByRole('button', { name: '隐藏卡片：Agent 用量' }));
    expect(screen.getByRole('button', { name: '至少保留一张卡片：统计条' })).toBeDisabled();
    // 编辑时卡片内容不可交互，Tab 只经过工具条。
    expect(screen.getByTestId('card-metrics').parentElement).toHaveAttribute('inert');
  });

  it('counts only cards with content when protecting the last one, and offers editing when nothing renders', () => {
    const onEdit = vi.fn();
    const onlyEmpty: DashboardLayoutCard[] = [
      { id: 'metrics', visible: false, width: 'full' },
      { id: 'heatmap', visible: true, width: 'full' },
      { id: 'trend', visible: true, width: 'full' },
    ];
    const { unmount } = render(<Harness start={onlyEmpty} />);
    // 热力图当前没有内容，趋势是唯一有内容的卡片：不能隐藏；热力图可以隐藏。
    expect(screen.getByRole('button', { name: '至少保留一张卡片：趋势' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '隐藏卡片：热力图' })).toBeEnabled();
    unmount();
    render(<Harness editing={false} start={[{ id: 'heatmap', visible: true, width: 'full' }, { id: 'trend', visible: false, width: 'full' }]} onEdit={onEdit} />);
    const empty = screen.getByRole('region', { name: '当前布局没有可显示的卡片' });
    fireEvent.click(within(empty).getByRole('button', { name: '编辑布局' }));
    expect(onEdit).toHaveBeenCalledOnce();
  });
});
