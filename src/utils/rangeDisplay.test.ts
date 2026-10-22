import { describe, expect, it } from 'vitest';
import { formatCustomRangeLabel, rangeDisplayName } from './rangeDisplay';

describe('rangeDisplayName 自定义区间（T10.108）', () => {
  it('预设范围保持既有文案，custom 无日期时给出通用名', () => {
    expect(rangeDisplayName('week')).toBe('本周');
    expect(rangeDisplayName('custom')).toBe('自定义区间');
    expect(rangeDisplayName('custom', null)).toBe('自定义区间');
  });

  it('有日期时按单日 / 同年 / 跨年三种形态压缩', () => {
    expect(formatCustomRangeLabel('2026-08-02', '2026-08-02')).toBe('2026年8月2日');
    expect(formatCustomRangeLabel('2026-08-01', '2026-08-31')).toBe('8月1日—8月31日');
    expect(formatCustomRangeLabel('2025-12-01', '2026-01-31')).toBe('2025年12月1日—2026年1月31日');
    expect(rangeDisplayName('custom', { start: '2026-08-01', end: '2026-08-31' })).toBe('8月1日—8月31日');
    expect(formatCustomRangeLabel('bad', '2026-08-31')).toBe('自定义区间');
  });
});
