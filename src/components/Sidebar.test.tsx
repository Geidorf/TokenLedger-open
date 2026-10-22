import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BusyState, CloudStatus } from '../types';
import { cloudSidebarStatusCopy, Sidebar } from './Sidebar';

function idleBusy(wallpaper = false): BusyState {
  return {
    scan: false,
    sync: false,
    wallpaper,
    auth: false,
    config: false,
    settings: false,
    prices: false,
    db: false,
  };
}

const cloudStatus: CloudStatus = {
  configured: true,
  authenticated: true,
  email: 'test@example.com',
  userId: 'user-1',
};

function renderSidebar(wallpaperBusy = false, syncBusy = false) {
  return render(
    <Sidebar
      activeTab="dashboard"
      onTabChange={vi.fn()}
      busy={{ ...idleBusy(wallpaperBusy), sync: syncBusy }}
      cloudAuthenticated
      cloudCapabilityVerified
      cloudReady
      pendingUploads={0}
      cloudStatus={cloudStatus}
      onScan={vi.fn()}
      onSync={vi.fn()}
      onWallpaper={vi.fn()}
      wallpaperBusy={wallpaperBusy}
      appVersion="1.2.72"
    />,
  );
}

describe('Sidebar', () => {
  it('模型接入的 Agent、供应商、网关、路由是一级入口', () => {
    const onTabChange = vi.fn();
    render(
      <Sidebar
        activeTab="gateway"
        onTabChange={onTabChange}
        busy={idleBusy()}
        cloudAuthenticated
        cloudCapabilityVerified
        cloudReady
        pendingUploads={0}
        cloudStatus={cloudStatus}
        onScan={vi.fn()}
        onSync={vi.fn()}
        onWallpaper={vi.fn()}
        wallpaperBusy={false}
        appVersion="1.2.72"
      />,
    );
    const nav = screen.getByRole('navigation', { name: '主要页面导航' });
    const labels = Array.from(nav.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['概览', '记录', '行为分析', '活动明细', 'Agent', '供应商', '网关', '路由', '设置与云端']);
    expect(screen.getByRole('button', { name: '网关' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '路由' }));
    expect(onTabChange).toHaveBeenCalledWith('routing');
  });

  it('模型接入关闭时不显示 Agent、供应商、网关、路由与分组标题（U-112）', () => {
    render(
      <Sidebar activeTab="dashboard" onTabChange={vi.fn()} busy={idleBusy()} cloudAuthenticated cloudCapabilityVerified cloudReady
        pendingUploads={0} cloudStatus={cloudStatus} onScan={vi.fn()} onSync={vi.fn()} onWallpaper={vi.fn()} wallpaperBusy={false}
        appVersion="1.2.72" modelAccessEnabled={false} />,
    );
    const nav = screen.getByRole('navigation', { name: '主要页面导航' });
    const labels = Array.from(nav.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['概览', '记录', '行为分析', '活动明细', '设置与云端']);
    expect(nav).not.toHaveTextContent('模型接入');
  });

  it('宽侧栏按分组直达页面，不再提供重复的用量父入口', () => {
    const onTabChange = vi.fn();
    render(<Sidebar activeTab="behavior" onTabChange={onTabChange} busy={idleBusy()} cloudAuthenticated cloudCapabilityVerified cloudReady
      pendingUploads={0} cloudStatus={cloudStatus} onScan={vi.fn()} onSync={vi.fn()} onWallpaper={vi.fn()} wallpaperBusy={false} appVersion="2.0.0" />);
    const nav = screen.getByRole('navigation', { name: '主要页面导航' });
    expect(screen.queryByRole('button', { name: '用量' })).not.toBeInTheDocument();
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '行为分析' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: '概览' }));
    expect(onTabChange).toHaveBeenLastCalledWith('dashboard');
    expect(screen.getByRole('button', { name: '概览' }).querySelector('svg')).not.toBeNull();
  });

  it('「用量」下的二级入口高亮当前子页，点击直接切到对应子页（U-100）', () => {
    const onTabChange = vi.fn();
    const props = {
      onTabChange, busy: idleBusy(), cloudAuthenticated: true, cloudCapabilityVerified: true, cloudReady: true, pendingUploads: 0,
      cloudStatus, onScan: vi.fn(), onSync: vi.fn(), onWallpaper: vi.fn(), wallpaperBusy: false, appVersion: '1.2.72',
    };
    const { rerender } = render(<Sidebar {...props} activeTab="behavior" />);
    const behavior = screen.getByRole('button', { name: '行为分析' });
    expect(behavior).toHaveAttribute('aria-current', 'page');
    expect(behavior).toHaveClass('nav-sub-item', 'nav-item-active');
    expect(screen.getByRole('button', { name: '概览' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: '记录' })).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('button', { name: '会话' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    expect(onTabChange).toHaveBeenLastCalledWith('records');
    fireEvent.click(screen.getByRole('button', { name: '概览' }));
    expect(onTabChange).toHaveBeenLastCalledWith('dashboard');

    rerender(<Sidebar {...props} activeTab="records" />);
    expect(screen.getByRole('button', { name: '记录' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: '行为分析' })).not.toHaveAttribute('aria-current');

    rerender(<Sidebar {...props} activeTab="gateway" />);
    for (const name of ['概览', '记录', '行为分析']) {
      expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-current');
    }
    fireEvent.click(screen.getByRole('button', { name: '行为分析' }));
    expect(onTabChange).toHaveBeenLastCalledWith('behavior');
  });

  it('品牌使用随主题着色的装饰性矢量，不依赖固定颜色的应用位图', () => {
    const { container } = renderSidebar();
    const mark = container.querySelector('.sidebar-logo svg');
    expect(mark).toHaveAttribute('stroke', 'currentColor');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('focusable', 'false');
    expect(container.querySelector('.sidebar-logo img')).toBeNull();
  });

  it('扫描进行中显示动作级反馈并锁定重复入口', () => {
    render(
      <Sidebar
        activeTab="dashboard"
        onTabChange={vi.fn()}
        busy={{ ...idleBusy(), scan: true }}
        cloudAuthenticated
        cloudCapabilityVerified
        cloudReady
        pendingUploads={0}
        cloudStatus={cloudStatus}
        onScan={vi.fn()}
        onSync={vi.fn()}
        onWallpaper={vi.fn()}
        wallpaperBusy={false}
        appVersion="1.2.72"
      />,
    );

    const scan = screen.getByRole('button', { name: '正在扫描本地各 AI 工具日志' });
    expect(scan).toBeDisabled();
    expect(scan).toHaveAttribute('aria-busy', 'true');
    expect(scan).toHaveAttribute('title', '正在扫描本地各 AI 工具日志');
    expect(scan).toHaveAttribute('data-tooltip', '正在扫描本地各 AI 工具日志');
    expect(scan).toHaveTextContent('扫描中…');
  });

  it('壁纸写入进行中显示动作级反馈并锁定快捷入口', () => {
    renderSidebar(true);

    const desktop = screen.getByRole('button', { name: '正在设置桌面壁纸' });
    expect(desktop).toBeDisabled();
    expect(desktop).toHaveAttribute('title', '正在写入系统壁纸');
    expect(desktop.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.getByRole('group', { name: '快捷设置壁纸' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: '一键设置桌面壁纸' })).not.toBeInTheDocument();
  });

  it('壁纸空闲时保留桌面壁纸入口并传递目标', () => {
    const onWallpaper = vi.fn();
    render(
      <Sidebar
        activeTab="dashboard"
        onTabChange={vi.fn()}
        busy={idleBusy()}
        cloudAuthenticated
        cloudCapabilityVerified
        cloudReady
        pendingUploads={0}
        cloudStatus={cloudStatus}
        onScan={vi.fn()}
        onSync={vi.fn()}
        onWallpaper={onWallpaper}
        wallpaperBusy={false}
        appVersion="1.2.72"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '一键设置桌面壁纸' }));
    expect(onWallpaper).toHaveBeenCalledWith('desktop');
    expect(screen.getByRole('button', { name: '一键设置桌面壁纸' })).toBeEnabled();
  });

  it('同步进行中显示动作级反馈并锁定重复入口', () => {
    renderSidebar(false, true);

    const sync = screen.getByRole('button', { name: '正在同步云端数据' });
    expect(sync).toBeDisabled();
    expect(sync).toHaveAttribute('aria-busy', 'true');
    expect(sync).toHaveAttribute('title', '正在同步云端数据');
    expect(sync).toHaveAttribute('data-tooltip', '正在同步云端数据');
    expect(sync).toHaveTextContent('同步中…');
    expect(sync.querySelector('.animate-spin')).toBeTruthy();
  });

  it('同步被云端门槛阻断时提供直接恢复入口并关联原因', () => {
    const onTabChange = vi.fn();
    render(
      <Sidebar
        activeTab="dashboard"
        onTabChange={onTabChange}
        busy={idleBusy()}
        cloudAuthenticated
        cloudCapabilityVerified={false}
        cloudReady={false}
        pendingUploads={12}
        cloudStatus={cloudStatus}
        onScan={vi.fn()}
        onSync={vi.fn()}
        onWallpaper={vi.fn()}
        wallpaperBusy={false}
        appVersion="1.2.72"
      />,
    );

    const sync = screen.getByRole('button', { name: '立即同步云端' });
    expect(sync).toBeDisabled();
    expect(sync).toHaveAttribute('aria-describedby', 'sidebar-sync-recovery-hint');
    expect(sync).toHaveAttribute('data-tooltip', '请先在设置与云端中验证 Stats v2');
    expect(screen.getByText('同步暂不可用：请先在设置与云端完成 Stats v2 验证。')).toBeInTheDocument();

    const recovery = screen.getByRole('button', { name: '去设置与云端验证 Stats v2' });
    expect(recovery).toHaveAttribute('data-tooltip', '去验证');
    fireEvent.click(recovery);
    expect(onTabChange).toHaveBeenCalledWith('settings');
  });

  it('快捷工具并排时只缩短可见文字，读屏名称与 title 不变（T10.275）', () => {
    render(
      <Sidebar activeTab="dashboard" onTabChange={vi.fn()} busy={idleBusy()} cloudAuthenticated cloudCapabilityVerified cloudReady
        pendingUploads={0} cloudStatus={cloudStatus} onScan={vi.fn()} onSync={vi.fn()} onWallpaper={vi.fn()} onOpenShareCard={vi.fn()}
        wallpaperBusy={false} appVersion="1.2.72" />,
    );
    const tools = screen.getByRole('group', { name: '快捷工具与战报' });
    expect(tools).toHaveAttribute('data-tool-count', '2');
    const share = screen.getByRole('button', { name: '生成数据战报卡片' });
    expect(share).toHaveTextContent('分享战报');
    expect(share).toHaveAttribute('title', '生成数据战报卡片');
    const desktop = screen.getByRole('button', { name: '一键设置桌面壁纸' });
    expect(desktop).toHaveTextContent('桌面壁纸');
    expect(desktop).toHaveAttribute('title', '设置桌面壁纸');
    expect(screen.getByRole('group', { name: '快捷设置壁纸' })).toHaveAttribute('data-tool-count', '1');
  });

  it('恢复原因仍在 DOM 中并关联到同步按钮，只是视觉上收起（T10.275）', () => {
    render(
      <Sidebar activeTab="dashboard" onTabChange={vi.fn()} busy={idleBusy()} cloudAuthenticated={false} cloudCapabilityVerified={false}
        cloudReady={false} pendingUploads={0} cloudStatus={cloudStatus} onScan={vi.fn()} onSync={vi.fn()} onWallpaper={vi.fn()}
        wallpaperBusy={false} appVersion="1.2.72" />,
    );
    const hint = screen.getByText('同步暂不可用：请先在设置与云端登录云端账户。');
    expect(hint).toHaveAttribute('id', 'sidebar-sync-recovery-hint');
    expect(screen.getByRole('button', { name: '立即同步云端' })).toHaveAttribute('aria-describedby', 'sidebar-sync-recovery-hint');
    expect(screen.getByRole('button', { name: '去设置与云端登录云端账户' })).toBeInTheDocument();
  });

  it('列表放得下时不标记溢出，也不在任何一端渐隐（T10.275、T10.277）', () => {
    const { container } = renderSidebar();
    const scroller = container.querySelector('.sidebar-scroll');
    expect(scroller).not.toHaveAttribute('data-overflow');
    expect(scroller).not.toHaveAttribute('data-fade-top');
    expect(scroller).not.toHaveAttribute('data-fade-bottom');
  });

  it('列表溢出时只在藏着行的一端渐隐，随滚动位置切换（T10.277）', () => {
    const { container } = renderSidebar();
    const scroller = container.querySelector<HTMLElement>('.sidebar-scroll')!;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(scroller).toHaveAttribute('data-overflow');
    expect(scroller).not.toHaveAttribute('data-fade-top');
    expect(scroller).toHaveAttribute('data-fade-bottom');
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(scroller).toHaveAttribute('data-fade-top');
    expect(scroller).toHaveAttribute('data-fade-bottom');
    scroller.scrollTop = 200;
    fireEvent.scroll(scroller);
    expect(scroller).toHaveAttribute('data-fade-top');
    expect(scroller).not.toHaveAttribute('data-fade-bottom');
  });

  it('分组标题共用一种样式，没有单独的分隔线与导引线元素（T10.277）', () => {
    const { container } = renderSidebar();
    const titles = Array.from(container.querySelectorAll('.sidebar-group-title'));
    expect(titles.map((title) => title.textContent)).toEqual(['用量', '模型接入', '快捷工具与战报']);
    for (const title of titles) expect(title).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.sidebar-divider, .sidebar-nav-section, .sidebar-section-title')).toBeNull();
  });

  it('浏览器里不标记原生毛玻璃，侧栏用不透明底色（T10.277）', () => {
    const { container } = renderSidebar();
    expect(container.querySelector('aside')).not.toHaveAttribute('data-vibrancy');
  });

  it('待上传数未知（数据库信息未读到或读取失败）时显示「待上传数未知」，不当作 0（GLB-01，T10.180）', () => {
    render(
      <Sidebar
        activeTab="dashboard"
        onTabChange={vi.fn()}
        busy={idleBusy()}
        cloudAuthenticated
        cloudCapabilityVerified
        cloudReady
        pendingUploads={null}
        cloudStatus={cloudStatus}
        onScan={vi.fn()}
        onSync={vi.fn()}
        onWallpaper={vi.fn()}
        wallpaperBusy={false}
        appVersion="1.2.72"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('云端可用 · 待上传数未知');
    expect(screen.queryByText(/0 条待上传/)).not.toBeInTheDocument();
  });
});

describe('窄栏「用量」菜单（U-101，T10.277）', () => {
  function mockNarrowRail(matches: boolean) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 860px)' ? matches : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    return () => { window.matchMedia = original; };
  }

  function renderRail(activeTab: 'behavior' | 'gateway' = 'behavior') {
    const onTabChange = vi.fn();
    render(
      <Sidebar activeTab={activeTab} onTabChange={onTabChange} busy={idleBusy()} cloudAuthenticated cloudCapabilityVerified cloudReady
        pendingUploads={0} cloudStatus={cloudStatus} onScan={vi.fn()} onSync={vi.fn()} onWallpaper={vi.fn()} wallpaperBusy={false} appVersion="1.2.72" />,
    );
    return onTabChange;
  }

  it('窄栏同样隐藏模型接入的四个图标（U-112）', () => {
    const restore = mockNarrowRail(true);
    try {
      render(
        <Sidebar activeTab="dashboard" onTabChange={vi.fn()} busy={idleBusy()} cloudAuthenticated cloudCapabilityVerified cloudReady
          pendingUploads={0} cloudStatus={cloudStatus} onScan={vi.fn()} onSync={vi.fn()} onWallpaper={vi.fn()} wallpaperBusy={false}
          appVersion="1.2.72" modelAccessEnabled={false} />,
      );
      for (const name of ['Agent', '供应商', '网关', '路由']) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
      expect(screen.getByRole('button', { name: '设置与云端' })).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('点「用量」图标弹出三项菜单，焦点落在当前子页并带选中标记', () => {
    const restore = mockNarrowRail(true);
    try {
      const onTabChange = renderRail('behavior');
      const usage = screen.getByRole('button', { name: '用量' });
      expect(usage).toHaveAttribute('aria-haspopup', 'menu');
      expect(usage).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(usage);
      expect(onTabChange).not.toHaveBeenCalled();
      expect(usage).toHaveAttribute('aria-expanded', 'true');
      const menu = screen.getByRole('menu', { name: '用量子页' });
      expect(usage).toHaveAttribute('aria-controls', menu.id);
      const items = screen.getAllByRole('menuitemradio');
      expect(items.map((item) => item.textContent)).toEqual(['概览', '记录', '行为分析']);
      expect(items[2]).toHaveAttribute('aria-checked', 'true');
      expect(items[0]).toHaveAttribute('aria-checked', 'false');
      expect(items[2].querySelector('svg')).not.toBeNull();
      expect(items[2]).toHaveFocus();
    } finally {
      restore();
    }
  });

  it('方向键循环移动焦点，选择后切页、关闭并把焦点还给图标', () => {
    const restore = mockNarrowRail(true);
    try {
      const onTabChange = renderRail('behavior');
      const usage = screen.getByRole('button', { name: '用量' });
      fireEvent.click(usage);
      const menu = screen.getByRole('menu');
      const items = screen.getAllByRole('menuitemradio');
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(items[0]).toHaveFocus();
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      expect(items[2]).toHaveFocus();
      fireEvent.keyDown(menu, { key: 'Home' });
      expect(items[0]).toHaveFocus();
      fireEvent.keyDown(menu, { key: 'End' });
      expect(items[2]).toHaveFocus();
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      expect(items[1]).toHaveFocus();
      fireEvent.click(items[1]);
      expect(onTabChange).toHaveBeenCalledWith('records');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(usage).toHaveFocus();
    } finally {
      restore();
    }
  });

  it('Esc 关闭并还焦点；点外部也关闭', () => {
    const restore = mockNarrowRail(true);
    try {
      renderRail('gateway');
      const usage = screen.getByRole('button', { name: '用量' });
      fireEvent.click(usage);
      // 不在用量页时没有选中项，焦点落在第一项。
      expect(screen.getAllByRole('menuitemradio')[0]).toHaveFocus();
      expect(screen.getAllByRole('menuitemradio').every((item) => item.getAttribute('aria-checked') === 'false')).toBe(true);
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(usage).toHaveFocus();

      fireEvent.click(usage);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(usage).toHaveAttribute('aria-expanded', 'false');
    } finally {
      restore();
    }
  });

  it('宽栏从概览直接进入，不提供用量菜单按钮', () => {
    const restore = mockNarrowRail(false);
    try {
      const onTabChange = renderRail('gateway');
      expect(screen.queryByRole('button', { name: '用量' })).not.toBeInTheDocument();
      const usage = screen.getByRole('button', { name: '概览' });
      expect(usage).not.toHaveAttribute('aria-haspopup');
      expect(usage).not.toHaveAttribute('aria-expanded');
      fireEvent.click(usage);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(onTabChange).toHaveBeenCalledWith('dashboard');
    } finally {
      restore();
    }
  });
});

describe('cloudSidebarStatusCopy 待上传数未知（GLB-01，T10.180）', () => {
  it('待上传数为 null 时显示「待上传数未知」，不落到 0 条或已就绪文案', () => {
    expect(cloudSidebarStatusCopy({
      authenticated: true, capabilityVerified: true, ready: true, pendingUploads: null,
    })).toEqual({ label: '云端可用 · 待上传数未知', compactLabel: '待确认' });
  });

  it('待上传数已知为 0 时仍显示已就绪文案，与未知区分开', () => {
    expect(cloudSidebarStatusCopy({
      authenticated: true, capabilityVerified: true, ready: true, pendingUploads: 0,
    })).toEqual({ label: '本地就绪 · 云端可用', compactLabel: '云端可用' });
  });
});
