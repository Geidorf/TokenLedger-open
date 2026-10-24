import { describe, expect, it } from 'vitest';
import { describePriceTableCheck, describePriceTableSource, parsePriceTableStatus } from './priceTableStatus';

const bundled = {
  source: 'bundled',
  revision: 2,
  verifiedAt: '2026-09-24',
  updatedAt: '2026-10-24',
  bundledRevision: 2,
  bundledVerifiedAt: '2026-09-24',
  fetchedAt: null,
  lastCheckedAt: null,
  lastError: null,
  autoUpdate: true,
  overrideModels: 0,
};

describe('价格表出处', () => {
  it('内置表写出修订与核验日期', () => {
    const status = parsePriceTableStatus(bundled)!;
    expect(describePriceTableSource(status)).toBe('内置价格表（第 2 版） · 官方价核验于 2026-09-24');
    expect(describePriceTableCheck(status)).toBe('尚未检查在线更新');
  });

  it('在线表写出下载时间，并带上自定义价格的型号数', () => {
    const status = parsePriceTableStatus({
      ...bundled,
      source: 'online',
      revision: 3,
      verifiedAt: '2026-10-20',
      fetchedAt: '2026-10-24T04:00:00Z',
      lastCheckedAt: '2026-10-24T04:00:00Z',
      overrideModels: 2,
    })!;
    const text = describePriceTableSource(status);
    expect(text).toMatch(/^在线更新的价格表（第 3 版） · 官方价核验于 2026-10-20 · .+ 下载 · 2 个型号用自定义价格$/);
    expect(describePriceTableCheck(status)).toMatch(/检查过，已是最新$/);
  });

  it('检查失败时给出原因；关闭自动更新且没检查过时如实说明', () => {
    expect(describePriceTableCheck(parsePriceTableStatus({
      ...bundled, lastCheckedAt: '2026-10-24T04:00:00Z', lastError: '网络请求失败',
    })!)).toMatch(/检查失败：网络请求失败$/);
    expect(describePriceTableCheck(parsePriceTableStatus({ ...bundled, autoUpdate: false })!)).toBe('自动更新已关闭');
  });

  it('形状不对时当作不可得', () => {
    expect(parsePriceTableStatus(null)).toBeNull();
    expect(parsePriceTableStatus({ ...bundled, source: 'cloud' })).toBeNull();
    expect(parsePriceTableStatus({ ...bundled, revision: -1 })).toBeNull();
    expect(parsePriceTableStatus({ ...bundled, verifiedAt: 20260924 })).toBeNull();
    expect(parsePriceTableStatus({ ...bundled, autoUpdate: 'yes' })).toBeNull();
  });
});
