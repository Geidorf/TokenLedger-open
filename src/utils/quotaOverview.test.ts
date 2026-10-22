import { describe, expect, it } from 'vitest';
import type { QuotaProviderEnvelope, QuotaWindowSnapshot } from '../types';
import {
  collectQuotaHighlights,
  quotaLevel,
  readQuotaWindow,
  summarizeQuotaHighlights,
} from './quotaOverview';

const NOW = Date.parse('2026-09-04T10:00:00Z');

function window(overrides: Partial<QuotaWindowSnapshot> = {}): QuotaWindowSnapshot {
  return {
    providerId: 'openai-codex-local',
    windowId: 'codex:primary',
    windowLabel: '5 小时窗口',
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    used: 38,
    limit: 100,
    remaining: 62,
    unit: 'percent',
    windowMinutes: 300,
    resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
    observedAt: new Date(NOW - 60_000).toISOString(),
    fetchedAt: new Date(NOW - 60_000).toISOString(),
    staleAfterSeconds: 900,
    ...overrides,
  };
}

function provider(overrides: Partial<QuotaProviderEnvelope> = {}): QuotaProviderEnvelope {
  return {
    schemaVersion: 1,
    providerId: 'openai-codex-local',
    displayName: 'Codex',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'stable',
    status: 'ok',
    windows: [window()],
    ...overrides,
  };
}

const labels = {
  providerName: (p: QuotaProviderEnvelope) => p.displayName,
  windowLabel: (w: QuotaWindowSnapshot) => w.windowLabel,
};

describe('quotaLevel', () => {
  it('把 20% 以下视为紧张、50% 以下视为提醒', () => {
    expect(quotaLevel(80)).toBe('ok');
    expect(quotaLevel(50)).toBe('ok');
    expect(quotaLevel(49)).toBe('warn');
    expect(quotaLevel(20)).toBe('warn');
    expect(quotaLevel(19)).toBe('critical');
    expect(quotaLevel(Number.NaN)).toBe('critical');
  });
});

describe('readQuotaWindow', () => {
  it('只读取来源直接给出的百分比窗口', () => {
    expect(readQuotaWindow(window(), NOW)).toEqual({
      remaining: 62,
      status: 'ok',
      resetsAt: window().resetsAt,
    });
    expect(readQuotaWindow(window({ unit: 'credits', used: undefined, limit: undefined, remaining: 12.5 }), NOW)).toBeNull();
    expect(readQuotaWindow(window({ status: 'auth-required' }), NOW)).toBeNull();
  });

  it('按观测年龄与重置时间推导历史状态，不改变数值', () => {
    const aged = window({ observedAt: new Date(NOW - 3_600_000).toISOString() });
    expect(readQuotaWindow(aged, NOW)).toMatchObject({ remaining: 62, status: 'stale' });
    const reset = window({ resetsAt: new Date(NOW - 1_000).toISOString() });
    expect(readQuotaWindow(reset, NOW)).toMatchObject({ status: 'stale' });
  });
});

describe('collectQuotaHighlights', () => {
  it('按可用比例升序，同比例时重置更早者优先，首项即最紧额度', () => {
    const providers = [
      provider(),
      provider({
        providerId: 'anthropic-claude-consumer',
        displayName: 'Claude',
        windows: [
          window({ providerId: 'anthropic-claude-consumer', windowId: 'five-hour', windowLabel: '5 小时额度', used: 82, remaining: 18 }),
          window({
            providerId: 'anthropic-claude-consumer',
            windowId: 'seven-day',
            windowLabel: '每周额度',
            used: 62,
            remaining: 38,
            resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
          }),
        ],
      }),
      provider({
        providerId: 'google-antigravity-consumer',
        displayName: 'Antigravity',
        windows: [
          window({
            providerId: 'google-antigravity-consumer',
            windowId: 'weekly',
            windowLabel: 'Gemini 每周额度',
            used: 62,
            remaining: 38,
            resetsAt: new Date(NOW + 86_400_000).toISOString(),
          }),
        ],
      }),
    ];
    const highlights = collectQuotaHighlights(providers, NOW, labels);
    expect(highlights.map((item) => `${item.providerName}:${item.remaining}`)).toEqual([
      'Claude:18',
      'Antigravity:38',
      'Claude:38',
      'Codex:62',
    ]);
    expect(highlights[0]).toMatchObject({ level: 'critical', windowLabel: '5 小时额度', status: 'ok' });
    expect(summarizeQuotaHighlights(highlights)).toEqual({
      count: 4,
      averageRemaining: 39,
      critical: 1,
      stale: 0,
    });
  });

  it('跳过不可读的 Provider、窗口与没有标签的窗口', () => {
    const providers = [
      provider({ status: 'auth-required', windows: [] }),
      provider({
        providerId: 'company-openapi-abc',
        displayName: '公司额度',
        windows: [window({ providerId: 'company-openapi-abc', windowId: 'key-daily', used: 10, remaining: 90 })],
      }),
    ];
    expect(collectQuotaHighlights(providers, NOW, { ...labels, windowLabel: () => null })).toEqual([]);
    expect(summarizeQuotaHighlights([])).toEqual({ count: 0, averageRemaining: null, critical: 0, stale: 0 });
  });
});
