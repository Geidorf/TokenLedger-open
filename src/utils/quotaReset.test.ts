import { describe, expect, it } from 'vitest';
import type { QuotaProviderEnvelope } from '../types';
import { QUOTA_RESET_REFRESH_GRACE_MS, quotaResetSchedules } from './quotaReset';

const provider = (resetsAt?: string): QuotaProviderEnvelope => ({
  schemaVersion: 1,
  providerId: 'openai-codex-local',
  displayName: 'Codex',
  scope: 'consumer-subscription',
  mode: 'automatic',
  capability: 'stable',
  status: 'ok',
  windows: [{
    providerId: 'openai-codex-local',
    windowId: 'five-hour',
    windowLabel: '5 小时额度',
    scope: 'consumer-subscription',
    source: 'local-authorized',
    status: 'ok',
    used: 20,
    limit: 100,
    remaining: 80,
    unit: 'percent',
    resetsAt,
    observedAt: '2030-01-01T00:00:00Z',
    fetchedAt: '2030-01-01T00:00:00Z',
    staleAfterSeconds: 900,
  }],
});

describe('quotaReset', () => {
  it('以 provider/scope/window/reset 组成稳定边界，并在 reset 后保留缓冲', () => {
    const resetsAt = '2030-01-01T00:10:00Z';
    const schedules = quotaResetSchedules([provider(resetsAt), provider(resetsAt)]);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      key: JSON.stringify(['openai-codex-local', 'consumer-subscription', 'five-hour', resetsAt]),
      resetAt: Date.parse(resetsAt),
      refreshAt: Date.parse(resetsAt) + QUOTA_RESET_REFRESH_GRACE_MS,
    });
  });

  it('忽略缺失和无效的 reset 时间', () => {
    expect(quotaResetSchedules([provider(), provider('2030-02-30T00:00:00Z')])).toEqual([]);
  });
});
