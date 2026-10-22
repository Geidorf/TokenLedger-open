import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DEFAULT_SETTINGS, type AppSettings, type StatsData } from '../types';
import { LiveWallpaperView } from './LiveWallpaperView';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

const localSettings: AppSettings = { ...DEFAULT_SETTINGS, scan_interval_secs: 900, scan_policy_version: 1, desktop_interval_secs: 60, lockscreen_interval_secs: 300, wallpaper_desktop_enabled: false, wallpaper_lockscreen_enabled: false, wallpaper_consent_version: 1, autostart_enabled: false, start_minimized: false, widget_open_at_startup: false, tray_text_enabled: false, tray_hover_widget_enabled: true, desktop_widget_enabled: false, desktop_widget_position: null, wallpaper_use_cloud: false, wallpaper_device_filter: 'all_cloud', wallpaper_dynamic_bg_enabled: false, quota_codex_local_enabled: false, quota_claude_statusline_enabled: false, quota_claude_codexbar_enabled: false, quota_antigravity_local_enabled: false, quota_antigravity_codexbar_enabled: false, quota_custom_endpoints: [], quota_snapshot_sync_enabled: false };
const stats = (tokens: number, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'): StatsData => ({ summary: { totalTokens: tokens, inputTokens: tokens / 2, outputTokens: tokens / 2, cachedTokens: 0, totalCost: 1, totalRequests: 1, avgTokensPerReq: tokens }, tools: {}, models: {}, trends: [], heatmap: {}, history: [], meta: { generatedAt: new Date().toISOString(), timezone, query: { range: 'today', timezone, machines: [], tools: [], models: [], search: null, tokenMode: 'effective' } } });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

describe('LiveWallpaperView', () => {
  const listeners = new Map<string, () => void>();
  beforeEach(() => {
    listeners.clear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    listenMock.mockImplementation(async (event, callback) => { listeners.set(event, callback as () => void); return () => undefined; });
    invokeMock.mockImplementation(async (command: string) => command === 'get_settings' ? localSettings : stats(100));
  });
  afterEach(() => vi.restoreAllMocks());

  it('设置切到云端而读取失败时不继续显示旧本机统计', async () => {
    let settings = localSettings;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_settings') return settings;
      if (command === 'get_cached_stats') {
        if (settings.wallpaper_use_cloud) throw new Error('cloud offline');
        return stats(100);
      }
      return null;
    });
    render(<LiveWallpaperView />);
    await screen.findByText('100');
    settings = { ...localSettings, wallpaper_use_cloud: true };
    await act(async () => listeners.get('settings-updated')?.());
    await screen.findByText('统计读取失败，请稍后再试。');
    expect(screen.queryByText('100')).not.toBeInTheDocument();
  });

  it('迟到的旧请求不能覆盖新数据，卸载后也不会写回', async () => {
    const local = deferred<StatsData>();
    const cloud = deferred<StatsData>();
    let settings = localSettings;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_settings') return settings;
      return settings.wallpaper_use_cloud ? cloud.promise : local.promise;
    });
    const view = render(<LiveWallpaperView />);
    await waitFor(() => expect(listeners.get('settings-updated')).toBeTypeOf('function'));
    settings = { ...localSettings, wallpaper_use_cloud: true };
    await act(async () => listeners.get('settings-updated')?.());
    await act(async () => cloud.resolve(stats(200)));
    expect(await screen.findByText('200')).toBeInTheDocument();
    await act(async () => local.resolve(stats(100)));
    expect(screen.queryByText('100')).not.toBeInTheDocument();
    view.unmount();
    await act(async () => local.resolve(stats(300)));
  });

  it('单个监听注册失败仍会释放另一个成功监听', async () => {
    const release = vi.fn();
    listenMock.mockImplementation(async (event, callback) => {
      if (event === 'stats-updated') throw new Error('listen failed');
      listeners.set(event, callback as () => void);
      return release;
    });
    const view = render(<LiveWallpaperView />);
    await screen.findByText('100');
    view.unmount();
    expect(release).toHaveBeenCalledOnce();
  });

  it('监听安装前错过的更新会在安装完成后重新读取', async () => {
    const registration = deferred<() => void>();
    let current = stats(100);
    listenMock.mockImplementation(() => registration.promise);
    invokeMock.mockImplementation(async (command: string) => command === 'get_settings' ? localSettings : current);
    render(<LiveWallpaperView />);
    await screen.findByText('100');
    current = stats(200);
    await act(async () => registration.resolve(() => undefined));
    expect(await screen.findByText('200')).toBeInTheDocument();
  });

  it('跨日后即使读取失败也不把昨天的快照标成今日', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T23:59:40'));
    try {
      render(<LiveWallpaperView />);
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(screen.getByLabelText('今日有效 Token')).toBeInTheDocument();
      invokeMock.mockRejectedValue(new Error('offline'));
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(screen.getByLabelText('历史有效 Token')).toBeInTheDocument();
      expect(screen.queryByLabelText('今日有效 Token')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('动态桌面的金额叫「预估费用」（T10.154 D53）', async () => {
    render(<LiveWallpaperView />);
    await screen.findByText('100');
    expect(screen.getByText('预估费用').nextElementSibling).toHaveTextContent(/^≈\$1\.00$/);
    expect(screen.queryByText('预估成本')).not.toBeInTheDocument();
  });

  it('隐藏时收到统计事件不会重复读取', async () => {
    render(<LiveWallpaperView />);
    await screen.findByText('100');
    const before = invokeMock.mock.calls.filter(([command]) => command === 'get_cached_stats').length;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => listeners.get('stats-updated')?.());
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const after = invokeMock.mock.calls.filter(([command]) => command === 'get_cached_stats').length;
    expect(after).toBe(before);
  });
});
