import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { WallpaperPreview } from './WallpaperPreview';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

const preview = {
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  width: 960,
  height: 540,
  screenWidth: 1920,
  screenHeight: 1080,
};

function commands(): string[] {
  return vi.mocked(invoke).mock.calls.map(([command]) => command);
}

describe('WallpaperPreview', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command: string) => (command === 'preview_wallpaper' ? preview : null));
  });

  it('静态模式显示原生渲染缩略图、屏幕比例与「未应用到桌面」', async () => {
    render(<WallpaperPreview dynamic={false} refreshKey="local" />);
    const image = await screen.findByRole('img', { name: '静态壁纸效果预览' });
    expect(image).toHaveAttribute('src', preview.dataUrl);
    expect(screen.getByText('预览，未应用到桌面 · 静态图片 · 1920×1080')).toBeInTheDocument();
    expect(image.parentElement).toHaveStyle({ aspectRatio: '1920 / 1080' });
    expect(commands()).toEqual(['preview_wallpaper']);
  });

  it('设置连续变化时防抖，只按最后一次设置重新生成', async () => {
    const view = render(<WallpaperPreview dynamic={false} refreshKey="a" />);
    view.rerender(<WallpaperPreview dynamic={false} refreshKey="b" />);
    view.rerender(<WallpaperPreview dynamic={false} refreshKey="c" />);
    await screen.findByRole('img', { name: '静态壁纸效果预览' });
    expect(commands()).toEqual(['preview_wallpaper']);
    view.rerender(<WallpaperPreview dynamic={false} refreshKey="d" />);
    expect(screen.getByText(/正在生成/)).toBeInTheDocument();
    await waitFor(() => expect(commands()).toEqual(['preview_wallpaper', 'preview_wallpaper']));
    await waitFor(() => expect(screen.queryByText(/正在生成/)).toBeNull());
  });

  it('生成失败时只给一行状态，不写系统壁纸', async () => {
    vi.mocked(invoke).mockRejectedValue('render failed');
    render(<WallpaperPreview dynamic={false} refreshKey="local" />);
    expect(await screen.findByText(/生成失败/)).toBeInTheDocument();
    expect(commands().every((command) => command === 'preview_wallpaper')).toBe(true);
  });

  it('动态模式内嵌缩小的动态桌面，只读统计，不调用静态渲染', async () => {
    render(<WallpaperPreview dynamic refreshKey="local" />);
    expect(screen.getByRole('region', { name: '动态桌面效果预览' })).toBeInTheDocument();
    expect(screen.getByText(/预览，未应用到桌面 · 动态桌面 · \d+×\d+ · 背景为示意/)).toBeInTheDocument();
    await waitFor(() => expect(commands()).toContain('get_settings'));
    expect(commands().every((command) => ['get_settings', 'get_cached_stats'].includes(command))).toBe(true);
  });
});
