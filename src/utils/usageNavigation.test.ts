import { describe, expect, it } from 'vitest';
import { USAGE_SUB_TABS, usageTabFromHash } from './usageNavigation';

describe('usageTabFromHash', () => {
  it('旧锚点 #behavior 与新别名直达会话子页（U-100）', () => {
    expect(usageTabFromHash('#behavior')).toBe('behavior');
    expect(usageTabFromHash('behavior')).toBe('behavior');
    expect(usageTabFromHash('#sessions')).toBe('behavior');
    expect(usageTabFromHash('#behavior-analysis')).toBe('behavior');
    expect(usageTabFromHash(USAGE_SUB_TABS.sessions)).toBe('behavior');
  });

  it('合并前「记录」「活动明细」的锚点都落到请求子页', () => {
    expect(usageTabFromHash('#requests')).toBe('logs');
    expect(usageTabFromHash('#records')).toBe('logs');
    expect(usageTabFromHash('#usage-records')).toBe('logs');
    expect(usageTabFromHash('#logs')).toBe('logs');
    expect(USAGE_SUB_TABS.requests).toBe('logs');
  });

  it('额度子页有锚点', () => {
    expect(usageTabFromHash('#allowances')).toBe('allowances');
    expect(usageTabFromHash('#quota')).toBe('allowances');
    expect(USAGE_SUB_TABS.allowances).toBe('allowances');
  });

  it('概览也有锚点，其他锚点不归用量页', () => {
    expect(usageTabFromHash('#dashboard')).toBe('dashboard');
    expect(usageTabFromHash('#overview')).toBe('dashboard');
    expect(usageTabFromHash('#gateway')).toBeNull();
    expect(usageTabFromHash('#settings-cloud')).toBeNull();
    expect(usageTabFromHash('#constructor')).toBeNull();
    expect(usageTabFromHash('')).toBeNull();
    expect(usageTabFromHash(null)).toBeNull();
  });
});
