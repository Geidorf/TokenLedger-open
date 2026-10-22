import { describe, expect, it } from 'vitest';
import { beginProviderSave, clearProviderDraft, endProviderSave, readProviderDraft, writeProviderDraft } from './providerDrafts';

describe('供应商窗口草稿边界', () => {
  it('白名单只缓存非敏感字段，各编辑目标隔离，显式放弃可清除', () => {
    const source = { id: 'a', name: '草稿', baseUrl: 'https://example.com', wire: 'chat' as const, models: 'model', key: 'secret', token: 'secret' };
    writeProviderDraft('test:a', source);
    expect(readProviderDraft('test:a')).toEqual({ id: 'a', name: '草稿', baseUrl: 'https://example.com', wire: 'chat', models: 'model' });
    expect(readProviderDraft('test:b')).toBeUndefined();
    clearProviderDraft('test:a'); expect(readProviderDraft('test:a')).toBeUndefined();
  });
  it('保存锁跨组件生命周期，重复开始拒绝，其他目标有独立身份', () => {
    expect(beginProviderSave('test:a')).toBe(true);
    expect(beginProviderSave('test:a')).toBe(false);
    expect(beginProviderSave('test:b')).toBe(true);
    endProviderSave('test:a'); endProviderSave('test:b');
    expect(beginProviderSave('test:a')).toBe(true); endProviderSave('test:a');
  });
});
