import { describe, expect, it } from 'vitest';
import { USAGE_SUB_TABS, usageTabFromHash } from './usageNavigation';

describe('usageTabFromHash', () => {
  it('旧锚点 #behavior 与新别名直达行为分析子页（U-100）', () => {
    expect(usageTabFromHash('#behavior')).toBe('behavior');
    expect(usageTabFromHash('behavior')).toBe('behavior');
    expect(usageTabFromHash('#sessions')).toBe('behavior');
    expect(usageTabFromHash('#behavior-analysis')).toBe('behavior');
    expect(usageTabFromHash(USAGE_SUB_TABS.sessions)).toBe('behavior');
  });

  it('概览与记录也有锚点，其他锚点不归用量页', () => {
    expect(usageTabFromHash('#dashboard')).toBe('dashboard');
    expect(usageTabFromHash('#overview')).toBe('dashboard');
    expect(usageTabFromHash('#records')).toBe('records');
    expect(usageTabFromHash('#gateway')).toBeNull();
    expect(usageTabFromHash('#settings-cloud')).toBeNull();
    expect(usageTabFromHash('#constructor')).toBeNull();
    expect(usageTabFromHash('')).toBeNull();
    expect(usageTabFromHash(null)).toBeNull();
  });
});
