import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilterMultiSelect, getFilterPopoverPlacement, getFilterPopoverVerticalPlacement } from './FilterMultiSelect';

describe('FilterMultiSelect', () => {
  it('在窄内容轨道内将弹层宽度与左缘同时收口', () => {
    expect(getFilterPopoverPlacement({
      rootLeft: 111,
      rootWidth: 161,
      visibleLeft: 82,
      visibleRight: 312,
    })).toEqual({ width: 230, left: -29, alignEnd: true });
  });

  it('下方放得下时向下展开，高度只受 480 上限约束', () => {
    expect(getFilterPopoverVerticalPlacement({
      spaceAbove: 120,
      spaceBelow: 520,
      naturalHeight: 321,
      minimumHeight: 274,
    })).toEqual({ alignTop: false, maxHeight: 480, scrollBy: 0 });
  });

  it('翻到上方时高度不超过上方可视空间，不再按 180 下限塞进顶栏下面', () => {
    // 1280×480 的实测形态：下方几乎无空间、上方只有 159px，且滚动区已到底。
    const placement = getFilterPopoverVerticalPlacement({
      spaceAbove: 159,
      spaceBelow: 20,
      naturalHeight: 321,
      minimumHeight: 274,
    });
    expect(placement).toEqual({ alignTop: true, maxHeight: 159, scrollBy: 0 });
  });

  it('两侧都放不下 3 个候选时先滚动内容区，再向下展开', () => {
    // 640×520 的实测形态：下方 176px 只露 1 个候选，内容区还能向下滚。
    expect(getFilterPopoverVerticalPlacement({
      spaceAbove: 150,
      spaceBelow: 176,
      naturalHeight: 321,
      minimumHeight: 274,
      scrollRoomDown: 157,
      scrollRoomUp: 0,
    })).toEqual({ alignTop: false, maxHeight: 274, scrollBy: 98 });
  });

  it('向下滚不动时改为向上滚，并翻到上方展开', () => {
    expect(getFilterPopoverVerticalPlacement({
      spaceAbove: 200,
      spaceBelow: 20,
      naturalHeight: 321,
      minimumHeight: 274,
      scrollRoomDown: 0,
      scrollRoomUp: 150,
    })).toEqual({ alignTop: true, maxHeight: 274, scrollBy: -74 });
  });

  it('候选不足 3 个且无处可滚时，按较大一侧收口并在列表内滚动', () => {
    expect(getFilterPopoverVerticalPlacement({
      spaceAbove: 100,
      spaceBelow: 150,
      naturalHeight: 200,
      minimumHeight: 200,
    })).toEqual({ alignTop: false, maxHeight: 150, scrollBy: 0 });
  });

  it('先暂存多选，点击应用后才更新已应用值', () => {
    const onChange = vi.fn();
    render(
      <FilterMultiSelect
        label="工具"
        values={[]}
        options={[{ value: 'codex', count: 3 }, { value: 'claude', count: 2 }]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /全部工具/ }));
    const popover = screen.getByRole('dialog', { name: '工具多选' });
    expect(popover).toHaveAttribute('aria-describedby', expect.stringContaining('selection-summary'));
    expect(screen.getByRole('status')).toHaveTextContent('已选 0 项（上限 32）· 应用后生效');
    fireEvent.click(screen.getByRole('checkbox', { name: /codex/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('已选 1 项（上限 32）· 应用后生效');

    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(onChange).toHaveBeenCalledWith(['codex']);
  });

  it('取消会丢弃暂存选择并把焦点还给触发按钮', () => {
    const onChange = vi.fn();
    render(
      <FilterMultiSelect
        label="工具"
        values={['codex']}
        options={[{ value: 'codex', count: 3 }, { value: 'claude', count: 2 }]}
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole('button', { name: /codex/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('checkbox', { name: /claude/ }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('应用筛选后把焦点还给触发按钮，取数期间被禁用也要补回来', () => {
    // applyPopover 同步调了 focus()，但调用方随即用 disabled={loading} 禁用触发按钮，
    // 浏览器不让 disabled 元素持有焦点，焦点被退回 <body> 且不会自己回来（T10.128 P1）。
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = render(
      <FilterMultiSelect
        label="工具"
        values={[]}
        options={[{ value: 'codex', count: 3 }]}
        onChange={() => undefined}
      />,
      { container: host },
    );

    const trigger = screen.getByRole('button', { name: /全部工具/ });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('checkbox', { name: /codex/ }));
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }));

    // 取数开始：浏览器把焦点从即将禁用的按钮上打回 body（这里直接失焦，
    // 不依赖 jsdom 对 disabled 元素的失焦语义），随后按钮进入禁用态。
    expect(document.activeElement).toBe(trigger);
    trigger.blur();
    expect(document.activeElement).toBe(document.body);
    view.rerender(
      <FilterMultiSelect
        label="工具"
        values={['codex']}
        options={[{ value: 'codex', count: 3 }]}
        disabled
        onChange={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(document.body);

    // 取数结束：按钮恢复可用，焦点必须回到它身上。
    view.rerender(
      <FilterMultiSelect
        label="工具"
        values={['codex']}
        options={[{ value: 'codex', count: 3 }]}
        onChange={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /codex/ }),
    );
    host.remove();
  });

  it('已选值仍保留筛选字段上下文供读屏识别', () => {
    render(
      <FilterMultiSelect
        label="工具"
        values={['codex']}
        options={[{ value: 'codex', count: 3 }]}
        onChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: '工具：codex' });
    expect(trigger).toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('aria-controls');

    fireEvent.click(trigger);
    const popover = screen.getByRole('dialog', { name: '工具多选' });
    expect(trigger).toHaveAttribute('aria-controls', popover.id);
  });
});
