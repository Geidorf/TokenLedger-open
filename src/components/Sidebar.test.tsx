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

const baseProps = {
  busy: idleBusy(), cloudAuthenticated: true, cloudCapabilityVerified: true, cloudReady: true, pendingUploads: 0,
  cloudStatus, onScan: vi.fn(), onSync: vi.fn(), onWallpaper: vi.fn(), wallpaperBusy: false, appVersion: '1.2.72',
};

describe('Sidebar（顶栏）', () => {
  it('一级分段顺序：Agent、供应商、网关、路由、用量；设置在右侧齿轮', () => {
    const onTabChange = vi.fn();
    render(<Sidebar {...baseProps} activeTab="gateway" onTabChange={onTabChange} />);
    const nav = screen.getByRole('navigation', { name: '主要页面导航' });
    const labels = Array.from(nav.querySelectorAll('button')).map((button) => button.textContent);
    expect(labels).toEqual(['Agent', '供应商', '网关', '路由', '用量']);
    expect(screen.getByRole('button', { name: '网关' })).toHaveAttribute('aria-current', 'page');
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '路由' }));
    expect(onTabChange).toHaveBeenCalledWith('routing');
    const settings = screen.getByRole('button', { name: '设置与云端' });
    expect(nav).not.toContainElement(settings);
    fireEvent.click(settings);
    expect(onTabChange).toHaveBeenLastCalledWith('settings');
  });

  it('模型接入关闭时只剩「用量」一段（U-112）', () => {
    render(<Sidebar {...baseProps} activeTab="dashboard" onTabChange={vi.fn()} modelAccessEnabled={false} />);
    const nav = screen.getByRole('navigation', { name: '主要页面导航' });
    expect(Array.from(nav.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['用量']);
    for (const name of ['Agent', '供应商', '网关', '路由']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByRole('button', { name: '设置与云端' })).toBeInTheDocument();
  });

  it('四个用量子页都高亮「用量」；在用量页再点不换子页，从别处点回到概览', () => {
    const onTabChange = vi.fn();
    const { rerender } = render(<Sidebar {...baseProps} activeTab="behavior" onTabChange={onTabChange} />);
    for (const tab of ['dashboard', 'logs', 'behavior', 'allowances'] as const) {
      rerender(<Sidebar {...baseProps} activeTab={tab} onTabChange={onTabChange} />);
      expect(screen.getByRole('button', { name: '用量' })).toHaveAttribute('aria-current', 'page');
    }
    fireEvent.click(screen.getByRole('button', { name: '用量' }));
    expect(onTabChange).toHaveBeenLastCalledWith('allowances');
    rerender(<Sidebar {...baseProps} activeTab="agents" onTabChange={onTabChange} />);
    expect(screen.getByRole('button', { name: '用量' })).not.toHaveAttribute('aria-current');
    fireEvent.click(screen.getByRole('button', { name: '用量' }));
    expect(onTabChange).toHaveBeenLastCalledWith('dashboard');
  });

  it('设置页时齿轮标为当前页', () => {
    render(<Sidebar {...baseProps} activeTab="settings" onTabChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: '设置与云端' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('navigation', { name: '主要页面导航' }).querySelector('[aria-current]')).toBeNull();
  });

  it('品牌使用随主题着色的装饰性矢量，不依赖固定颜色的应用位图', () => {
    const { container } = renderSidebar();
    const mark = container.querySelector('.topbar-brand svg');
    expect(mark).toHaveAttribute('stroke', 'currentColor');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('focusable', 'false');
    expect(container.querySelector('.topbar-brand img')).toBeNull();
    expect(container.querySelector('.topbar-brand')).toHaveAttribute('title', expect.stringContaining('v1.2.72'));
  });

  it('扫描进行中显示动作级反馈并锁定重复入口', () => {
    render(<Sidebar {...baseProps} busy={{ ...idleBusy(), scan: true }} activeTab="dashboard" onTabChange={vi.fn()} />);
    const scan = screen.getByRole('button', { name: '正在扫描本地各 AI 工具日志' });
    expect(scan).toBeDisabled();
    expect(scan).toHaveAttribute('aria-busy', 'true');
    expect(scan).toHaveAttribute('title', '正在扫描本地各 AI 工具日志');
    expect(scan).toHaveAttribute('data-tooltip', '正在扫描本地各 AI 工具日志');
    expect(scan.querySelector('.animate-spin')).toBeTruthy();
  });

  it('壁纸写入进行中显示动作级反馈并锁定快捷入口', () => {
    renderSidebar(true);
    const desktop = screen.getByRole('button', { name: '正在设置桌面壁纸' });
    expect(desktop).toBeDisabled();
    expect(desktop).toHaveAttribute('title', '正在写入系统壁纸');
    expect(desktop.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.getByRole('group', { name: '快捷工具与战报' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: '一键设置桌面壁纸' })).not.toBeInTheDocument();
  });

  it('壁纸空闲时保留桌面壁纸入口并传递目标', () => {
    const onWallpaper = vi.fn();
    render(<Sidebar {...baseProps} onWallpaper={onWallpaper} activeTab="dashboard" onTabChange={vi.fn()} />);
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
    expect(sync.querySelector('.animate-spin')).toBeTruthy();
  });

  it('同步被云端门槛阻断时提供直接恢复入口并关联原因', () => {
    const onTabChange = vi.fn();
    render(<Sidebar {...baseProps} cloudCapabilityVerified={false} cloudReady={false} pendingUploads={12} activeTab="dashboard" onTabChange={onTabChange} />);
    const sync = screen.getByRole('button', { name: '立即同步云端' });
    expect(sync).toBeDisabled();
    expect(sync).toHaveAttribute('aria-describedby', 'sidebar-sync-recovery-hint');
    expect(sync).toHaveAttribute('data-tooltip', '请先在设置与云端中验证 Stats v2');
    expect(screen.getByText('同步暂不可用：请先在设置与云端完成 Stats v2 验证。')).toHaveAttribute('id', 'sidebar-sync-recovery-hint');
    const recovery = screen.getByRole('button', { name: '去设置与云端验证 Stats v2' });
    expect(recovery).toHaveTextContent('去验证');
    fireEvent.click(recovery);
    expect(onTabChange).toHaveBeenCalledWith('settings');
  });

  it('云端状态未知时恢复入口去检查状态', () => {
    const onCheckCloudStatus = vi.fn();
    render(<Sidebar {...baseProps} cloudStatusKnown={false} onCheckCloudStatus={onCheckCloudStatus} activeTab="dashboard" onTabChange={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('本地就绪 · 云端状态待检查');
    fireEvent.click(screen.getByRole('button', { name: '去设置与云端检查云端状态' }));
    expect(onCheckCloudStatus).toHaveBeenCalled();
  });

  it('战报与壁纸是只有图标的按钮，读屏名称与 title 完整', () => {
    render(<Sidebar {...baseProps} onOpenShareCard={vi.fn()} activeTab="dashboard" onTabChange={vi.fn()} />);
    const share = screen.getByRole('button', { name: '生成数据战报卡片' });
    expect(share).toHaveAttribute('title', '生成数据战报卡片');
    expect(share).toHaveTextContent('');
    expect(screen.getByRole('button', { name: '一键设置桌面壁纸' })).toHaveAttribute('title', '设置桌面壁纸');
  });

  it('浏览器里不标记原生毛玻璃，顶栏用不透明底色', () => {
    const { container } = renderSidebar();
    expect(container.querySelector('header.app-topbar')).not.toHaveAttribute('data-vibrancy');
  });

  it('待上传数未知（数据库信息未读到或读取失败）时显示「待上传数未知」，不当作 0（GLB-01，T10.180）', () => {
    render(<Sidebar {...baseProps} pendingUploads={null} activeTab="dashboard" onTabChange={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('云端可用 · 待上传数未知');
    expect(screen.queryByText(/0 条待上传/)).not.toBeInTheDocument();
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
