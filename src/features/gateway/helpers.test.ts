import { describe, expect, it } from 'vitest';
import {
  codeSample,
  DEFAULT_BASE_URL,
  diffLineClass,
  effectiveTokens,
  modelOptions,
  parseModels,
  ruleSummary,
  slugId,
  TOKEN_PLACEHOLDER,
} from './helpers';
import { presetFor } from './presets';
import type { ProviderView, RoutingGroup } from './types';

const providers: ProviderView[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wire: 'chat', models: ['deepseek-chat'], enabled: true, hasKey: true },
  { id: 'off', name: 'Off', baseUrl: 'https://off.example.com/v1', wire: 'chat', models: ['x'], enabled: false, hasKey: false },
];
const groups: RoutingGroup[] = [
  { id: 'coding', name: '编码', strategy: 'failover', members: ['deepseek/deepseek-chat'], rules: [], sessionTtlSecs: 3600, enabled: true },
  { id: 'paused', name: '暂停', strategy: 'failover', members: ['deepseek/deepseek-chat'], rules: [], sessionTtlSecs: 3600, enabled: false },
];

describe('gateway helpers', () => {
  it('网关默认端口为 3462', () => {
    expect(DEFAULT_BASE_URL).toBe('http://127.0.0.1:3462/v1');
  });

  it('模型选项列出启用的路由组与启用供应商的 供应商/模型', () => {
    expect(modelOptions(providers, groups).map((option) => option.value)).toEqual(['group/coding', 'deepseek/deepseek-chat']);
  });

  it('示例代码只用 token 占位符', () => {
    for (const lang of ['curl', 'python', 'node'] as const) {
      for (const api of ['responses', 'chat'] as const) {
        const text = codeSample(api, lang, DEFAULT_BASE_URL, 'group/coding');
        expect(text).toContain('TOKENLEDGER_TOKEN');
        expect(text).not.toMatch(/tl-[a-z0-9]{8,}/i);
      }
    }
    expect(codeSample('chat', 'curl', DEFAULT_BASE_URL, 'm')).toContain(`Bearer ${TOKEN_PLACEHOLDER}`);
  });

  it('只有显式传入 token 时示例才内联完整 token', () => {
    const token = 'tl-0123456789abcdef0123456789abcdef9e1a';
    for (const api of ['responses', 'chat'] as const) {
      for (const lang of ['curl', 'python', 'node'] as const) {
        const text = codeSample(api, lang, DEFAULT_BASE_URL, 'group/coding', token);
        expect(text).toContain(token);
        expect(text).not.toContain('TOKENLEDGER_TOKEN');
      }
    }
    expect(codeSample('responses', 'python', DEFAULT_BASE_URL, 'm', token)).toContain(`api_key="${token}"`);
    expect(codeSample('responses', 'node', DEFAULT_BASE_URL, 'm', token)).toContain(`apiKey: '${token}'`);
  });

  it('模型列表去重并支持中英文逗号与换行', () => {
    expect(parseModels('a, b，c\n a  d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('生成后端可接受且不冲突的 ID', () => {
    expect(slugId('My Relay!')).toBe('my-relay');
    expect(slugId('deepseek', ['deepseek'])).toBe('deepseek-2');
    expect(slugId('中文')).toBe('provider');
  });

  it('有效 Token 只含输入与输出', () => {
    expect(effectiveTokens({ input: 10, output: 5 })).toBe(15);
  });

  it('规则摘要与 diff 行着色', () => {
    expect(ruleSummary({ kind: 'timeWindow', start: '09:00', end: '18:00' })).toBe('本地时间 09:00–18:00');
    expect(diffLineClass('+ a')).toBe('is-add');
    expect(diffLineClass('- a')).toBe('is-del');
    expect(diffLineClass('--- a')).toBe('is-ctx');
  });

  it('按 ID 或主机名匹配预设品牌', () => {
    expect(presetFor({ id: 'x1', baseUrl: 'https://api.deepseek.com/v1' })?.id).toBe('deepseek');
    expect(presetFor({ id: 'zzz', baseUrl: 'https://relay.example.com/v1' })).toBeNull();
  });
});
