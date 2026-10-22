import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type BusyState } from '../../types';
import { WallpaperSection } from './WallpaperSection';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

function busyState(settings = false): BusyState {
  return {
    scan: false,
    sync: false,
    wallpaper: false,
    auth: false,
    config: false,
    settings,
    prices: false,
    db: false,
  };
}

function appSettings(consentVersion = 1): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    scan_interval_secs: 900,
    scan_policy_version: 1,
    desktop_interval_secs: 60,
    lockscreen_interval_secs: 60,
    wallpaper_desktop_enabled: true,
    wallpaper_lockscreen_enabled: false,
    wallpaper_consent_version: consentVersion,
    autostart_enabled: false,
    start_minimized: false,
    widget_open_at_startup: false,
    tray_text_enabled: false,
    tray_hover_widget_enabled: true,
    desktop_widget_enabled: false,
    desktop_widget_position: null,
    wallpaper_use_cloud: false,
    wallpaper_device_filter: 'all_cloud',
    wallpaper_dynamic_bg_enabled: false,
    quota_codex_local_enabled: false,
    quota_claude_statusline_enabled: false,
    quota_claude_codexbar_enabled: false,
    quota_antigravity_local_enabled: false,
    quota_antigravity_codexbar_enabled: false,
    quota_custom_endpoints: [],
    quota_snapshot_sync_enabled: false,
  };
}

function renderSection(overrides: Partial<React.ComponentProps<typeof WallpaperSection>> = {}) {
  return render(
    <WallpaperSection
      appSettings={appSettings()}
      busy={busyState()}
      deviceList={[]}
      showDynamicBackgroundControls={false}
      showLockscreenControls={false}
      cloudWallpaperReady={false}
      cloudWallpaperHint="先完成云端验证"
      onSettingChange={vi.fn()}
      onSettingChangeDebounced={vi.fn()}
      onFlushSettingChange={vi.fn()}
      onConsentDecision={vi.fn(async () => undefined)}
      onCleanupWallpaper={vi.fn(async () => undefined)}
      {...overrides}
    />,
  );
}

describe('WallpaperSection', () => {
  it('授权决策期间显示动作反馈并锁定重复操作', async () => {
    let resolve: (() => void) | undefined;
    const onConsentDecision = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    renderSection({ appSettings: appSettings(0), onConsentDecision });

    fireEvent.click(screen.getByRole('button', { name: '确认并保留原设置' }));

    const action = screen.getByRole('button', { name: '正在确认并恢复历史壁纸设置' });
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('aria-busy', 'true');
    expect(action).toHaveTextContent('确认中…');
    expect(screen.getByRole('button', { name: '全部保持关闭' })).toBeDisabled();

    resolve?.();
  });

  it('清理壁纸期间显示清理中并保持危险区动作锁定', () => {
    let resolve: (() => void) | undefined;
    const onCleanupWallpaper = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const view = renderSection({ onCleanupWallpaper });

    fireEvent.click(screen.getByRole('button', { name: '清理历史壁纸' }));

    const action = screen.getByRole('button', { name: '等待确认清理历史壁纸' });
    expect(action).toBeDisabled();
    expect(action).not.toHaveAttribute('aria-busy', 'true');
    expect(action).toHaveTextContent('等待确认…');

    view.rerender(
      <WallpaperSection
        appSettings={appSettings()}
        busy={busyState(true)}
        deviceList={[]}
        showDynamicBackgroundControls={false}
        showLockscreenControls={false}
        cloudWallpaperReady={false}
        cloudWallpaperHint="先完成云端验证"
        onSettingChange={vi.fn()}
        onSettingChangeDebounced={vi.fn()}
        onFlushSettingChange={vi.fn()}
        onConsentDecision={vi.fn(async () => undefined)}
        onCleanupWallpaper={onCleanupWallpaper}
      />,
    );
    const running = screen.getByRole('button', { name: '正在清理历史壁纸' });
    expect(running).toBeDisabled();
    expect(running).toHaveAttribute('aria-busy', 'true');
    expect(running).toHaveTextContent('清理中…');

    resolve?.();
  });
});


describe('壁纸模式与恢复路径', () => {
  it('总开关关闭时明确暂停，不把动态偏好误报为运行', () => {
    renderSection({ appSettings: { ...appSettings(), wallpaper_desktop_enabled: false, wallpaper_dynamic_bg_enabled: true }, showDynamicBackgroundControls: true, onRefreshWallpaper: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('已暂停');
    expect(screen.getByRole('status')).toHaveTextContent('动态桌面偏好已保留');
    expect(screen.getByRole('radio', { name: /动态桌面/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: '启用桌面壁纸' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '立即应用' })).toBeDisabled();
    expect(screen.queryByRole('spinbutton', { name: '桌面壁纸刷新间隔（秒）' })).toBeNull();
  });
  it('选择模式只修改模式偏好，不隐式开启总开关', () => {
    const onSettingChange = vi.fn();
    renderSection({ appSettings: { ...appSettings(), wallpaper_desktop_enabled: false }, showDynamicBackgroundControls: true, onSettingChange });
    fireEvent.click(screen.getByRole('radio', { name: /动态桌面/ }));
    expect(onSettingChange).toHaveBeenCalledExactlyOnceWith('wallpaper_dynamic_bg_enabled', true);
  });
  it('云端不可用时仍允许明确切回本机，不把当前云端偏好悄悄改掉', () => {
    const onSettingChange = vi.fn();
    renderSection({ appSettings: { ...appSettings(), wallpaper_use_cloud: true }, onSettingChange });
    expect(screen.getByRole('combobox', { name: '壁纸用量来源' })).toHaveValue('cloud');
    expect(screen.getByText(/当前仍选择云端/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '壁纸用量来源' }), { target: { value: 'local' } });
    expect(onSettingChange).toHaveBeenCalledExactlyOnceWith('wallpaper_use_cloud', false);
  });
  it('预览随呈现方式切换，复用主窗口读取且不触发系统写入', async () => {
    vi.mocked(invoke).mockClear();
    const onSettingChange = vi.fn(), onRefreshWallpaper = vi.fn();
    const view = renderSection({ showDynamicBackgroundControls: true, onSettingChange, onRefreshWallpaper });
    expect(screen.getByText(/预览，未应用到桌面 · 静态图片/)).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('preview_wallpaper'));
    view.rerender(
      <WallpaperSection
        appSettings={{ ...appSettings(), wallpaper_dynamic_bg_enabled: true }}
        busy={busyState()}
        deviceList={[]}
        showDynamicBackgroundControls
        showLockscreenControls={false}
        cloudWallpaperReady={false}
        cloudWallpaperHint="先完成云端验证"
        onSettingChange={onSettingChange}
        onSettingChangeDebounced={vi.fn()}
        onFlushSettingChange={vi.fn()}
        onConsentDecision={vi.fn(async () => undefined)}
        onCleanupWallpaper={vi.fn(async () => undefined)}
        onRefreshWallpaper={onRefreshWallpaper}
      />,
    );
    expect(screen.getByRole('region', { name: '动态桌面效果预览' })).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_settings'));
    expect(vi.mocked(invoke).mock.calls.every(([command]) => ['preview_wallpaper', 'get_settings', 'get_cached_stats'].includes(command))).toBe(true);
    expect(document.querySelector('iframe')).toBeNull();
    expect(onSettingChange).not.toHaveBeenCalled(); expect(onRefreshWallpaper).not.toHaveBeenCalled();
  });
  it('关闭失败时优先呈现失败，不误报暂停或指向禁用的重试按钮', () => {
    renderSection({ appSettings: { ...appSettings(), wallpaper_desktop_enabled: false }, wallpaperError: '关闭窗口失败', onRefreshWallpaper: vi.fn() });
    expect(screen.getByRole('status')).toHaveTextContent('桌面应用失败');
    expect(screen.getByRole('alert')).toHaveTextContent('退出并重新打开');
    expect(screen.getByRole('alert')).not.toHaveTextContent('立即应用');
  });
  it('应用错误持续可见且保留重试入口', () => {
    const onRefreshWallpaper = vi.fn();
    renderSection({ wallpaperError: '窗口创建失败', onRefreshWallpaper });
    expect(screen.getByRole('alert')).toHaveTextContent('窗口创建失败');
    fireEvent.click(screen.getByRole('button', { name: '立即应用' }));
    expect(onRefreshWallpaper).toHaveBeenCalledOnce();
  });
});
