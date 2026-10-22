// 桌面看板的动效策略（DESIGN §4.4）：
// - 数值只在真实变化时做一次有限时长的补间，从不凭空"跳动"；
// - 揭示类动画只在挂载时播放一次，数据刷新不重播；
// - 系统 reduced-motion 关闭全部非必要动画（CSS 层由全局 1ms 覆盖兜底，
//   JS 层由 prefersReducedMotion() 直接短路）。

export const MOTION_COUNT_UP_MS = 720;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 标准缓出：起步快、落点稳，适合数值补间与扫入。 */
export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - (1 - clamped) ** 3;
}

/** 按缓出曲线在 from→to 之间取插值；progress 超出 [0, 1] 会被钳制。 */
export function tweenValue(from: number, to: number, progress: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return to;
  return from + (to - from) * easeOutCubic(progress);
}
