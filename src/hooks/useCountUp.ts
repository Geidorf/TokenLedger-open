import { useEffect, useRef, useState } from 'react';
import { MOTION_COUNT_UP_MS, prefersReducedMotion, tweenValue } from '../utils/motion';

/**
 * 数值补间：首次渲染直接显示真实值（不从 0 假装增长），之后只在目标值真实变化时
 * 用 requestAnimationFrame 从上一显示值平滑过渡到新值。reduced-motion、无 rAF
 * 环境（SSR / 部分测试环境）或非有限值时立即落到目标值。
 */
export function useCountUp(target: number, duration = MOTION_COUNT_UP_MS): number {
  const [displayed, setDisplayed] = useState(target);
  const previous = useRef(target);

  useEffect(() => {
    const from = previous.current;
    previous.current = target;
    if (from === target) return undefined;
    if (
      prefersReducedMotion()
      || typeof requestAnimationFrame !== 'function'
      || typeof performance === 'undefined'
      || !Number.isFinite(from)
      || !Number.isFinite(target)
    ) {
      setDisplayed(target);
      return undefined;
    }
    let frame = 0;
    const start = performance.now();
    // 用 performance.now() 而不是 rAF 回调参数计时：两者在部分环境（jsdom）
    // 不在同一时钟域，会让进度永远到不了 1。
    const step = () => {
      const progress = Math.min(1, (performance.now() - start) / duration);
      setDisplayed(progress >= 1 ? target : tweenValue(from, target, progress));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return displayed;
}
