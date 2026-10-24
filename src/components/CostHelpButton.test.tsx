import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { CostHelpButton } from './CostHelpButton';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

/**
 * CostHelpButton 的打开聚焦、滚动收起、Shift+Tab 焦点与云端说明句
 * （T10.186 评审 P3-5、待定点 4；T10.197 评审 P2-1、P3-3、P3-4）。
 * 打开/关闭、Escape、点外部、弹层定位公式等既有覆盖在 MetricsGrid.test.tsx（渲染完整 KPI 卡）。
 */
describe('CostHelpButton：打开聚焦、滚动收起、Shift+Tab 与云端说明句', () => {
  const openPopover = () => {
    fireEvent.click(screen.getByRole('button', { name: '预估费用说明' }));
    return screen.getByRole('dialog', { name: '预估费用说明' });
  };

  it('打开后焦点移入弹层：聚焦时弹层已经可见（不是 visibility:hidden），且 document.activeElement 落在弹层里（T10.197 评审 P2-1）', () => {
    const originalFocus = HTMLElement.prototype.focus;
    const visibilityAtFocus: string[] = [];
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function focus(
      this: HTMLElement,
      ...args: Parameters<typeof HTMLElement.prototype.focus>
    ) {
      if (this.classList.contains('cost-help-popover')) visibilityAtFocus.push(this.style.visibility);
      originalFocus.apply(this, args);
    });

    render(<CostHelpButton />);
    const popover = openPopover();

    expect(visibilityAtFocus.length).toBeGreaterThan(0);
    expect(visibilityAtFocus).not.toContain('hidden');
    expect(popover.contains(document.activeElement)).toBe(true);

    focusSpy.mockRestore();
  });

  it('锚点完全滚出视口时收起弹层：焦点原本在弹层里就还给按钮，不钉在视口边缘也不掉到 body（T10.186 评审 P3-5；T10.197 评审 P3-3）', () => {
    render(<CostHelpButton />);
    const button = screen.getByRole('button', { name: '预估费用说明' });
    openPopover();
    // 打开后焦点已经在弹层里（P2-1 修复）。

    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      bottom: -20, top: -40, left: 100, right: 140, width: 40, height: 20, x: 100, y: -40,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.scroll(window);

    expect(screen.queryByRole('dialog', { name: '预估费用说明' })).not.toBeInTheDocument();
    // 焦点原本在弹层里：还给按钮（`preventScroll`，不会把页面拉回按钮），不留在已经移除的弹层
    // 上、也不掉到 body（T10.197 评审 P3-3）。
    expect(button).toHaveFocus();
  });

  it('锚点仍在视口内时滚动只重新定位，不关闭弹层', () => {
    render(<CostHelpButton />);
    const button = screen.getByRole('button', { name: '预估费用说明' });
    openPopover();

    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      bottom: 120, top: 100, left: 100, right: 140, width: 40, height: 20, x: 100, y: 100,
      toJSON: () => ({}),
    } as DOMRect);
    fireEvent.scroll(window);

    expect(screen.getByRole('dialog', { name: '预估费用说明' })).toBeInTheDocument();
  });

  it('Shift+Tab 离开弹层时事件被阻止、焦点停在按钮上，不再多跳一格到按钮之前的元素（T10.186 评审 P3-5；T10.197 评审 P3-4）', () => {
    render(
      <>
        <button>前一个按钮</button>
        <CostHelpButton />
      </>,
    );
    const button = screen.getByRole('button', { name: '预估费用说明' });
    const popover = openPopover();

    // fireEvent 返回 dispatchEvent 的结果：被 preventDefault 时为 false（与下面普通 Tab 断言的
    // true 对照）。只查弹层关闭与焦点落点锁不住 preventDefault 本身（T10.197 评审 P3-4）。
    const result = fireEvent.keyDown(popover, { key: 'Tab', shiftKey: true });
    expect(result).toBe(false);
    expect(screen.queryByRole('dialog', { name: '预估费用说明' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('普通 Tab 仍然先把焦点还给按钮、再交给浏览器默认动作（不 preventDefault）', () => {
    render(<CostHelpButton />);
    const popover = openPopover();
    const event = fireEvent.keyDown(popover, { key: 'Tab' });
    // React Testing Library 的 fireEvent 返回 dispatchEvent 的结果：未被 preventDefault 时为 true。
    expect(event).toBe(true);
    expect(screen.queryByRole('dialog', { name: '预估费用说明' })).not.toBeInTheDocument();
  });

  it('云端范围在说明末尾加一句零值合计提示，本机范围与未传都不显示（T10.186 评审待定点 4）', () => {
    const { rerender } = render(<CostHelpButton scope="local" />);
    let popover = openPopover();
    expect(popover).not.toHaveTextContent('按 0 计入');
    fireEvent.keyDown(popover, { key: 'Escape' });

    rerender(<CostHelpButton />);
    popover = openPopover();
    expect(popover).not.toHaveTextContent('按 0 计入');
    fireEvent.keyDown(popover, { key: 'Escape' });

    rerender(<CostHelpButton scope="cloud" />);
    popover = openPopover();
    expect(popover).toHaveTextContent('云端汇总把没有费用的记录按 0 计入。');
  });

  it('本机范围写出价格表出处，云端范围不写（金额按各设备上传时的价格表冻结）', async () => {
    vi.mocked(invoke).mockResolvedValue({
      source: 'bundled', revision: 2, verifiedAt: '2026-09-24', updatedAt: '2026-10-24',
      bundledRevision: 2, bundledVerifiedAt: '2026-09-24', fetchedAt: null, lastCheckedAt: null,
      lastError: null, autoUpdate: true, overrideModels: 1,
    });
    const { unmount } = render(<CostHelpButton scope="local" />);
    const popover = openPopover();
    expect(await screen.findByText('价格来源：内置价格表（第 2 版） · 官方价核验于 2026-09-24 · 1 个型号用自定义价格')).toBeInTheDocument();
    expect(popover).toHaveTextContent('调价前的记录仍按当时的价格估算');
    unmount();

    vi.mocked(invoke).mockClear();
    render(<CostHelpButton scope="cloud" />);
    openPopover();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByText(/^价格来源：/)).not.toBeInTheDocument();
  });
});

