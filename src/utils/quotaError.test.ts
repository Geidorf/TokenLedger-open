import { describe, expect, it } from 'vitest';
import { formatQuotaLoadError } from './quotaError';

describe('formatQuotaLoadError', () => {
  it('将内部契约错误翻译为可行动的用户文案', () => {
    expect(formatQuotaLoadError(new Error('额度 Provider 契约无效'))).toBe('来源数据格式暂时无法识别。');
  });

  it('保留授权和超时错误的产品语义，但不暴露原始错误串', () => {
    expect(formatQuotaLoadError('unauthorized provider response')).toBe('额度来源需要重新授权。');
    expect(formatQuotaLoadError(new Error('request timeout'))).toBe('额度来源响应超时，已保留最近可用快照。');
  });

  it('对未知错误使用稳定的通用恢复文案', () => {
    expect(formatQuotaLoadError({ unexpected: true })).toBe('额度来源暂时无法读取。');
  });
});
