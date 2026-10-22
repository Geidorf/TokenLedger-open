import { describe, expect, it } from 'vitest';
import { formatAxisTokens, formatTokens } from './format';

// T10.179（T10.164 评审 N3）：坐标轴沿用 formatTokens 的 K/M/B 阶梯与进位，只把尾随 0 去掉。
describe('formatAxisTokens', () => {
  it('labels billions with B, never as thousands of millions', () => {
    expect(formatAxisTokens(2_000_000_000)).toBe('2B');
    // The tooltip of the same value, for comparison.
    expect(formatTokens(2_000_000_000)).toBe('2.00B');
    expect(formatAxisTokens(1_000_000_000)).toBe('1B');
    expect(formatAxisTokens(1_500_000_000)).toBe('1.5B');
  });

  it('keeps the trimmed axis style of K and M ticks', () => {
    expect(formatAxisTokens(0)).toBe('0');
    expect(formatAxisTokens(300)).toBe('300');
    expect(formatAxisTokens(0.5)).toBe('0.5');
    expect(formatAxisTokens(1_000)).toBe('1K');
    expect(formatAxisTokens(1_200)).toBe('1.2K');
    expect(formatAxisTokens(900_000)).toBe('900K');
    expect(formatAxisTokens(1_000_000)).toBe('1M');
    expect(formatAxisTokens(1_500_000)).toBe('1.5M');
    expect(formatAxisTokens(12_000_000)).toBe('12M');
  });

  it('carries to the next unit like formatTokens instead of printing 1000K or 1000M', () => {
    expect(formatAxisTokens(999_949)).toBe('999.9K');
    expect(formatAxisTokens(999_950)).toBe('1M');
    expect(formatAxisTokens(999_999_999)).toBe('1B');
  });

  it('never turns an unknown value into a number (GLB-01)', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatAxisTokens(value)).toBe('—');
    }
  });
});
