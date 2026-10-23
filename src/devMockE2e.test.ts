import { afterEach, describe, expect, it } from 'vitest';
import { resolveE2eOverride } from './devMockE2e';

describe('resolveE2eOverride', () => {
  afterEach(() => {
    delete window.__TOKENLEDGER_E2E__;
  });

  it('没有 E2E 接缝时不记录也不覆盖', () => {
    expect(resolveE2eOverride('get_settings', {})).toEqual({ hit: false });
  });

  it('记录每次调用，未覆盖的命令落回内置 mock', () => {
    window.__TOKENLEDGER_E2E__ = {};
    expect(resolveE2eOverride('refresh_scan', { force: true })).toEqual({ hit: false });
    expect(window.__TOKENLEDGER_E2E__.calls).toEqual([{ cmd: 'refresh_scan', args: { force: true } }]);
  });

  it('value 覆盖每次返回独立副本', () => {
    window.__TOKENLEDGER_E2E__ = { overrides: { get_settings: { value: { theme: 'dark' } } } };
    const first = resolveE2eOverride('get_settings', undefined);
    expect(first).toEqual({ hit: true, value: { theme: 'dark' } });
    if (first.hit) (first.value as { theme: string }).theme = 'light';
    expect(resolveE2eOverride('get_settings', undefined)).toEqual({ hit: true, value: { theme: 'dark' } });
  });

  it('error 覆盖让调用以该字符串失败', () => {
    window.__TOKENLEDGER_E2E__ = { overrides: { get_cached_stats: { error: '数据库被占用' } } };
    expect(() => resolveE2eOverride('get_cached_stats', {})).toThrow('数据库被占用');
  });
});
