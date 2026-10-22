import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatsData } from '../types';
import { ShareCardModal } from './ShareCardModal';
import { copyShareCardToClipboard, downloadShareCardImage, ensureShareCardAssetsReady, renderShareCardToCanvas } from '../utils/shareCardRenderer';
import { downloadVisualDigest } from '../utils/reportExport';

vi.mock('../utils/shareCardRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/shareCardRenderer')>();
  return {
    ...actual,
    ensureShareCardAssetsReady: vi.fn(async () => undefined),
    renderShareCardToCanvas: vi.fn(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1080;
      canvas.height = 1920;
      return canvas;
    }),
    copyShareCardToClipboard: vi.fn(async () => true),
    downloadShareCardImage: vi.fn(async () => undefined),
  };
});
vi.mock('../utils/reportExport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/reportExport')>();
  return {
    ...actual,
    downloadVisualDigest: vi.fn(() => true),
  };
});
const STATS: StatsData = {
  summary: { totalTokens: 120, inputTokens: 100, outputTokens: 20, cachedTokens: 30, totalCost: 1, totalRequests: 2, avgTokensPerReq: 60 },
  tools: {}, models: {}, trends: [], heatmap: {}, history: [],
};

describe('ShareCardModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureShareCardAssetsReady).mockResolvedValue(undefined);
  });

  const getPrivacySwitch = () => screen.getAllByRole('switch', { name: /隐藏费用/ })[0];

  it('提供五布局可访问单选和默认开启的「隐藏费用」（T10.154 D54）', async () => {
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" />);
    await waitFor(() => expect(ensureShareCardAssetsReady).toHaveBeenCalledWith('scorecard'));
    expect(vi.mocked(ensureShareCardAssetsReady).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(renderShareCardToCanvas).mock.invocationCallOrder[0]);
    const layouts = screen.getAllByRole('radio');
    expect(layouts).toHaveLength(5);
    expect(screen.getByRole('radio', { name: /编辑宣言/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /编辑宣言/ })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: /AI 搭子/ })).toHaveAttribute('tabindex', '-1');
    fireEvent.click(screen.getByRole('radio', { name: /月度通行证/ }));
    expect(screen.getByRole('radio', { name: /月度通行证/ })).toHaveAttribute('aria-checked', 'true');
    expect(getPrivacySwitch()).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(getPrivacySwitch());
    expect(getPrivacySwitch()).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(renderShareCardToCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ layout: 'receipt', hideCosts: false })));
  });

  it('用方向键在海报布局单选项间移动焦点并同步选择', async () => {
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" />);
    const first = screen.getByRole('radio', { name: /编辑宣言/ });
    first.focus();

    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const second = screen.getByRole('radio', { name: /AI 搭子/ });
    await waitFor(() => expect(second).toHaveFocus());
    expect(second).toHaveAttribute('aria-checked', 'true');
    expect(first).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(second, { key: 'End' });
    const last = screen.getByRole('radio', { name: /像素存档/ });
    await waitFor(() => expect(last).toHaveFocus());
    expect(last).toHaveAttribute('aria-checked', 'true');
  });

  it('为动态海报画布提供不泄露金额的可访问摘要（T10.154 D55）', async () => {
    const { container } = render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" />);

    await waitFor(() => expect(screen.getByRole('img', { name: /编辑宣言.*有效 Token 120.*2 条记录.*费用已隐藏/ })).toBeInTheDocument());
    const getCanvas = () => container.querySelector('canvas');
    expect(getCanvas()).toHaveAttribute('role', 'img');
    expect(getCanvas()).toHaveAttribute('aria-label', expect.not.stringContaining('$1.00'));
    expect(getCanvas()).toHaveAttribute('aria-label', expect.not.stringContaining('金额'));

    fireEvent.click(getPrivacySwitch());
    await waitFor(() => expect(screen.getByRole('img', { name: /预估费用 ≈\$1\.00/ })).toBeInTheDocument());
  });

  it('总费用不可得时可访问摘要写「预估费用不可得」，不落回 $0（T10.186 评审 P3-1，D55 补齐不可得用例）', async () => {
    const unknownCost: StatsData = {
      ...STATS,
      summary: { ...STATS.summary, totalCost: Number.NaN },
    };
    const { container } = render(<ShareCardModal isOpen onClose={vi.fn()} stats={unknownCost} range="week" scope="local" />);
    fireEvent.click(getPrivacySwitch());
    await waitFor(() => expect(screen.getByRole('img', { name: /预估费用不可得/ })).toBeInTheDocument());
    const canvas = container.querySelector('canvas');
    expect(canvas).toHaveAttribute('aria-label', expect.not.stringContaining('$0'));
    expect(canvas).toHaveAttribute('aria-label', expect.not.stringContaining('≈$'));
  });

  it('关闭「隐藏费用」时页脚按布局写明这张图包含哪些费用，简报另行说明（T10.154 D56）', async () => {
    const withSavings: StatsData = {
      ...STATS,
      summary: { ...STATS.summary, cachedTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 10, cacheSavedUsd: 0.5, cacheSavings: { readSavedUsd: 0.5, writePremiumUsd: 0.1, netSavedUsd: 0.4, fallbackPricedReadTokens: 0, fallbackPricedWriteTokens: 0, priceBasis: 'local-prices' } },
    };
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={withSavings} range="week" scope="local" />);
    const summary = document.getElementById('share-privacy-export-summary') as HTMLElement;
    expect(summary).toHaveTextContent('分享与导出前：费用已隐藏');
    fireEvent.click(getPrivacySwitch());
    // 编辑宣言只画有证明的正缓存净节省。
    expect(summary).toHaveTextContent('这张图包含：缓存净节省；HTML 简报包含预估费用');
    fireEvent.click(screen.getByRole('radio', { name: /像素存档/ }));
    expect(summary).toHaveTextContent('这张图不含费用；HTML 简报包含预估费用');
    expect(summary).not.toHaveTextContent('金额');
  });

  it('复制 PNG 使用当前布局和隐私设置，并保留保存图片恢复路径', async () => {
    const view = render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="month" scope="cloud" />);
    expect(view.container.querySelector('.share-modal-footer')).toBeInTheDocument();
    expect(view.container.querySelector('.share-modal-footer .share-modal-actions')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /像素存档/ }));
    fireEvent.click(screen.getByRole('button', { name: '复制图片' }));
    await waitFor(() => expect(copyShareCardToClipboard).toHaveBeenCalledWith(expect.objectContaining({ layout: 'signal', hideCosts: true })));
    expect(screen.getByRole('button', { name: /保存高清图片/ })).toBeEnabled();
  });

  it('导出进行中显示明确动作状态并锁定两个导出入口', async () => {
    let resolveCopy: (value: boolean) => void = () => undefined;
    vi.mocked(copyShareCardToClipboard).mockReturnValueOnce(new Promise<boolean>((resolve) => {
      resolveCopy = resolve;
    }));
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" />);

    fireEvent.click(screen.getByRole('button', { name: '复制图片' }));

    expect(screen.getByText('正在复制图片…', { selector: '.share-export-status' })).toHaveTextContent('正在复制图片…');
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '正在复制图片…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存高清图片' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /编辑宣言/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /月度通行证/ })).toBeDisabled();
    expect(getPrivacySwitch()).toBeDisabled();

    await act(async () => {
      resolveCopy(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '已复制到剪贴板' })).toBeEnabled();
      expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('radio', { name: /编辑宣言/ })).toBeEnabled();
      expect(getPrivacySwitch()).toBeEnabled();
    });
  });

  it('预览资源失败时在画布区域提供就地重试', async () => {
    const notify = vi.fn();
    vi.mocked(ensureShareCardAssetsReady)
      .mockRejectedValueOnce(new Error('font unavailable'))
      .mockResolvedValueOnce(undefined);
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" onNotify={notify} />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('海报预览暂不可用'));
    expect(notify).toHaveBeenCalledWith('error', '海报资源加载失败，请重试');

    fireEvent.click(screen.getByRole('button', { name: '重试生成预览' }));

    await waitFor(() => expect(renderShareCardToCanvas).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('液态底图失败后可切到纯 Canvas 模板，并可再次切回重试恢复', async () => {
    let liquidAttempts = 0;
    vi.mocked(ensureShareCardAssetsReady).mockImplementation(async (layout) => {
      if (layout === 'achievement' && liquidAttempts++ === 0) throw new Error('liquid unavailable');
    });
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="month" scope="local" />);
    await waitFor(() => expect(renderShareCardToCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ layout: 'scorecard' })));

    fireEvent.click(screen.getByRole('radio', { name: /流光档案/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('海报预览暂不可用'));
    fireEvent.click(screen.getByRole('radio', { name: /像素存档/ }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() => expect(renderShareCardToCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ layout: 'signal' })));

    fireEvent.click(screen.getByRole('radio', { name: /流光档案/ }));
    await waitFor(() => expect(renderShareCardToCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ layout: 'achievement' })));
    expect(ensureShareCardAssetsReady).toHaveBeenCalledWith('signal');
    expect(ensureShareCardAssetsReady).toHaveBeenLastCalledWith('achievement');
  });

  it.each([
    ['保存高清图片', '已发起高清周期总结 PNG 图片下载，请在下载文件夹确认'],
    ['导出 HTML 简报', '已发起 HTML 简报下载，请在下载文件夹确认'],
  ])('%s 只报告发起下载，不宣称文件已落盘', async (buttonName, message) => {
    const notify = vi.fn();
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" onNotify={notify} />);
    await waitFor(() => expect(renderShareCardToCanvas).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('success', message));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(message).not.toMatch(/已保存|已生成并下载|下载成功/);
  });

  it('导出失败后解除忙碌状态并保留布局与隐私选择', async () => {
    const notify = vi.fn();
    vi.mocked(downloadShareCardImage).mockRejectedValueOnce(new Error('canvas failed'));
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="month" scope="cloud" onNotify={notify} />);
    fireEvent.click(screen.getByRole('radio', { name: /月度通行证/ }));
    fireEvent.click(getPrivacySwitch());
    const save = screen.getByRole('button', { name: /保存高清图片/ });
    fireEvent.click(save);
    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', '图片生成失败，已保留当前选择，请重试'));
    expect(save).toBeEnabled();
    expect(screen.getByRole('radio', { name: /月度通行证/ })).toHaveAttribute('aria-checked', 'true');
    expect(getPrivacySwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('复制抛错后解除忙碌状态并允许原设置直接重试', async () => {
    const notify = vi.fn();
    vi.mocked(copyShareCardToClipboard).mockRejectedValueOnce(new Error('clipboard denied'));
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" onNotify={notify} />);
    fireEvent.click(screen.getByRole('radio', { name: /流光档案/ }));
    const copy = screen.getByRole('button', { name: '复制图片' });
    fireEvent.click(copy);
    await waitFor(() => expect(notify).toHaveBeenCalledWith('warning', '复制到剪贴板失败，请重试或保存图片'));
    expect(copy).toBeEnabled();
    expect(screen.getByRole('radio', { name: /流光档案/ })).toHaveAttribute('aria-checked', 'true');
    expect(getPrivacySwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('日报切换流光档案时把 today 与第三套布局交给同一高清渲染器', async () => {
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="today" scope="local" />);
    fireEvent.click(screen.getByRole('radio', { name: /流光档案/ }));
    await waitFor(() => expect(renderShareCardToCanvas).toHaveBeenLastCalledWith(expect.objectContaining({
      range: 'today',
      layout: 'achievement',
      hideCosts: true,
    })));
  });

  it('打开后聚焦关闭按钮，Escape 关闭并在卸载后恢复原焦点', async () => {
    const launcher = document.createElement('button');
    launcher.textContent = '打开海报';
    document.body.appendChild(launcher);
    launcher.focus();
    const onClose = vi.fn();
    const view = render(<ShareCardModal isOpen onClose={onClose} stats={STATS} range="week" scope="local" />);
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭弹窗' })).toHaveFocus());
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(screen.getByRole('radio', { name: /编辑宣言/ })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(launcher).toHaveFocus();
    launcher.remove();
  });

  it('键盘循环忽略桌面端隐藏的移动隐私开关并可到达导出操作', async () => {
    const getClientRects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function getClientRects(this: HTMLElement) {
      if (this.closest('.share-privacy-mobile')) return [] as unknown as DOMRectList;
      return [{ width: 1, height: 1 } as DOMRect] as unknown as DOMRectList;
    });

    try {
      render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" />);
      const close = screen.getByRole('button', { name: '关闭弹窗' });
      const layout = screen.getByRole('radio', { name: /编辑宣言/ });
      const privacy = getPrivacySwitch();
      const copy = screen.getByRole('button', { name: '复制图片' });
      const save = screen.getByRole('button', { name: '保存高清图片' });

      close.focus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(layout).toHaveFocus();
      for (let i = 0; i < 5; i += 1) fireEvent.keyDown(window, { key: 'Tab' });
      expect(privacy).toHaveFocus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(copy).toHaveFocus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(save).toHaveFocus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(screen.getByRole('button', { name: '导出 HTML 简报' })).toHaveFocus();
    } finally {
      getClientRects.mockRestore();
    }
  });

  it('分享弹窗提供导出 HTML 简报的第二入口，遵循当前 range/scope 与隐藏金额设置（T10.163）', async () => {
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" appVersion="9.9.9" onNotify={vi.fn()} />);
    await waitFor(() => expect(ensureShareCardAssetsReady).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '导出 HTML 简报' }));
    expect(downloadVisualDigest).toHaveBeenCalledWith(expect.objectContaining({
      stats: STATS,
      range: 'week',
      scope: 'local',
      appVersion: '9.9.9',
      hideCosts: true,
    }));

    fireEvent.click(getPrivacySwitch());
    fireEvent.click(screen.getByRole('button', { name: '导出 HTML 简报' }));
    expect(downloadVisualDigest).toHaveBeenLastCalledWith(expect.objectContaining({ hideCosts: false }));
  });

  it('分享弹窗提供”导出 HTML 简报”新入口（旧的”导出可视化简报”设置页入口的移除验证见 DataHelpSection.test.tsx，那个按钮从未存在于本组件，在这里断言它不存在没有约束力——复核修复 P3-6）', () => {
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" />);
    expect(screen.getByRole('button', { name: '导出 HTML 简报' })).toBeInTheDocument();
  });

  it('”导出 HTML 简报”按钮关联可见的金额披露摘要，不只依赖 title 提示（复核修复 P2-3）', () => {
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="week" scope="local" />);
    const digestButton = screen.getByRole('button', { name: '导出 HTML 简报' });
    expect(digestButton).toHaveAttribute('aria-describedby', 'share-privacy-export-summary');
    const summary = document.getElementById('share-privacy-export-summary');
    expect(summary).toHaveTextContent('分享与导出前：费用已隐藏');
  });
});

describe('T10.253 HTML 与当前海报同选', () => {
  it('五款样式与费用开关逐次传到离线HTML导出', async () => {
    render(<ShareCardModal isOpen onClose={vi.fn()} stats={STATS} range="custom" customRange={{ start: '2026-09-01', end: '2026-09-30' }} scope="local" />);
    for (const [name, layout] of [['编辑宣言', 'scorecard'], ['AI 搭子', 'journal'], ['流光档案', 'achievement'], ['月度通行证', 'receipt'], ['像素存档', 'signal']]) {
      fireEvent.click(screen.getByRole('radio', { name: new RegExp(name) }));
      fireEvent.click(screen.getByRole('button', { name: '导出 HTML 简报' }));
      expect(downloadVisualDigest).toHaveBeenLastCalledWith(expect.objectContaining({ layout, hideCosts: true, customRange: { start: '2026-09-01', end: '2026-09-30' } }));
    }
    fireEvent.click(screen.getAllByRole('switch', { name: /隐藏费用/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: '导出 HTML 简报' }));
    expect(downloadVisualDigest).toHaveBeenLastCalledWith(expect.objectContaining({ layout: 'signal', hideCosts: false }));
    await waitFor(() => expect(renderShareCardToCanvas).toHaveBeenLastCalledWith(expect.objectContaining({ layout: 'signal' })));
  });
});

it('T10.253 核心数据畸形时弹窗保留关闭/重试且不导出假0', async () => {
  vi.mocked(renderShareCardToCanvas).mockImplementationOnce(() => { throw new Error('分享数据不完整，无法生成海报，请刷新后重试'); });
  render(<ShareCardModal isOpen onClose={vi.fn()} stats={{ ...STATS, summary: { ...STATS.summary, inputTokens: Number.NaN } }} range="week" scope="local" />);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('分享数据不完整'));
  expect(screen.getByRole('button', { name: '复制图片' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '保存高清图片' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '导出 HTML 简报' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '关闭弹窗' })).toBeEnabled();
});
