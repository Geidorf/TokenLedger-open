import { describe, expect, it } from 'vitest';
import { easeOutCubic, prefersReducedMotion, tweenValue } from './motion';

describe('motion helpers', () => {
  it('缓出曲线两端钳制且单调递增', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(0.25)).toBeLessThan(easeOutCubic(0.75));
  });

  it('补间落点精确等于目标，非有限值直接返回目标', () => {
    expect(tweenValue(10, 20, 1)).toBe(20);
    expect(tweenValue(10, 20, 0)).toBe(10);
    expect(tweenValue(Number.NaN, 20, 0.5)).toBe(20);
    expect(tweenValue(10, Number.POSITIVE_INFINITY, 0.5)).toBe(Number.POSITIVE_INFINITY);
  });

  it('没有 matchMedia 时视为未开启 reduced-motion', () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    expect(prefersReducedMotion()).toBe(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: true }),
    });
    expect(prefersReducedMotion()).toBe(true);
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
  });
});
