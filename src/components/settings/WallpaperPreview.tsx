import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { LiveWallpaperView } from '../LiveWallpaperView';

export interface WallpaperPreviewImage {
  dataUrl: string;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
}

export const WALLPAPER_PREVIEW_DEBOUNCE_MS = 400;
const FALLBACK_SCREEN = { width: 1440, height: 900 };

function primaryScreenSize(): { width: number; height: number } {
  const width = typeof window === 'undefined' ? 0 : window.screen?.width ?? 0;
  const height = typeof window === 'undefined' ? 0 : window.screen?.height ?? 0;
  return width >= 640 && height >= 400 ? { width, height } : FALLBACK_SCREEN;
}

/** True once the element has been on screen; the settings sections stay mounted while hidden. */
function useSeen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export interface WallpaperPreviewProps {
  dynamic: boolean;
  /** Changes whenever a setting that affects the rendered wallpaper changes. */
  refreshKey: string;
}

export function WallpaperPreview({ dynamic, refreshKey }: WallpaperPreviewProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const seen = useSeen(frameRef);
  const frameWidth = useWidth(frameRef);
  const [image, setImage] = useState<WallpaperPreviewImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [statsVersion, setStatsVersion] = useState(0);

  useEffect(() => {
    if (dynamic) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen('stats-updated', () => setStatsVersion((version) => version + 1))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => undefined);
    return () => { disposed = true; unlisten?.(); };
  }, [dynamic]);

  useEffect(() => {
    if (dynamic || !seen) return;
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      invoke<WallpaperPreviewImage>('preview_wallpaper')
        .then((next) => { if (!cancelled) { setImage(next); setFailed(false); } })
        .catch(() => { if (!cancelled) setFailed(true); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, WALLPAPER_PREVIEW_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [dynamic, seen, refreshKey, statsVersion]);

  const screen = dynamic
    ? primaryScreenSize()
    : image ? { width: image.screenWidth, height: image.screenHeight } : FALLBACK_SCREEN;
  const mode = dynamic ? '动态桌面' : '静态图片';
  const state = dynamic
    ? '背景为示意，实际保留原壁纸'
    : failed ? '生成失败，稍后会随数据更新重试' : loading ? '正在生成…' : null;
  const status = ['预览，未应用到桌面', mode, `${screen.width}×${screen.height}`, state].filter(Boolean).join(' · ');
  const scale = (frameWidth > 0 ? frameWidth : 480) / screen.width;

  return (
    <figure className="wallpaper-preview">
      <div
        ref={frameRef}
        className="wallpaper-preview-frame"
        style={{ aspectRatio: `${screen.width} / ${screen.height}` }}
        aria-busy={loading || undefined}
      >
        {dynamic ? (
          seen && (
            <div
              className="wallpaper-preview-stage"
              role="region"
              aria-label="动态桌面效果预览"
              style={{ width: screen.width, height: screen.height, transform: `scale(${scale})` }}
            >
              <LiveWallpaperView preview />
            </div>
          )
        ) : image ? (
          <img src={image.dataUrl} alt="静态壁纸效果预览" width={image.width} height={image.height} />
        ) : null}
      </div>
      <figcaption aria-live="polite">{status}</figcaption>
    </figure>
  );
}

export default WallpaperPreview;
