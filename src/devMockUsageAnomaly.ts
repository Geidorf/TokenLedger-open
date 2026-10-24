/**
 * 浏览器预览与 E2E 用的用量异常读数（`get_usage_anomalies`）。只给几条有代表性的发现，
 * 让概览「用量异常」卡片可走查；真实判定在 `src-tauri/src/usage_anomaly.rs`。
 */
let mockAnomalySettings = { notify: false };

const isoDay = (offset: number, now: Date) => {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
};

export function mockUsageAnomalyReport(now: Date = new Date()) {
  const hour = String(Math.max(now.getHours() - 1, 0)).padStart(2, '0');
  const today = isoDay(0, now);
  const yesterday = isoDay(1, now);
  const base = { subject: null, tool: null, inProgress: false, sample: null };
  return {
    generatedAt: now.toISOString(),
    baselineDays: 14,
    recentDays: 7,
    recentHours: 24,
    findings: [
      { ...base, id: `tokenSpike:${today} ${hour}:00:`, kind: 'tokenSpike', granularity: 'hour', bucket: `${today} ${hour}:00`, value: 3_200_000, baseline: 420_000, ratio: 7.6, unit: 'tokens' },
      { ...base, id: `modelSurge:${yesterday}:claude-sonnet-4-5`, kind: 'modelSurge', granularity: 'day', bucket: yesterday, subject: 'claude-sonnet-4-5', value: 18_400_000, baseline: 4_100_000, ratio: 4.5, unit: 'tokens' },
      { ...base, id: `expensiveSession:codex:mock-session-7f3a`, kind: 'expensiveSession', granularity: 'session', bucket: yesterday, subject: 'mock-session-7f3a', tool: 'codex', value: 12.4, baseline: 1.1, ratio: 11.3, unit: 'usd' },
    ],
    checks: [
      { kind: 'tokenSpike', state: 'evaluated' },
      { kind: 'costSpike', state: 'evaluated' },
      { kind: 'cacheHitDrop', state: 'evaluated' },
      { kind: 'toolSurge', state: 'evaluated' },
      { kind: 'modelSurge', state: 'evaluated' },
      { kind: 'expensiveSession', state: 'evaluated' },
      { kind: 'gatewayErrors', state: 'unavailable' },
    ],
  };
}

export function mockUsageAnomalyCommand(cmd: string, payload: Record<string, unknown>): { handled: boolean; value?: unknown } {
  switch (cmd) {
    case 'get_usage_anomalies':
      return { handled: true, value: mockUsageAnomalyReport() };
    case 'get_usage_anomaly_settings':
      return { handled: true, value: mockAnomalySettings };
    case 'set_usage_anomaly_settings': {
      const next = (payload.settings ?? {}) as { notify?: unknown };
      mockAnomalySettings = { notify: next.notify === true };
      return { handled: true, value: mockAnomalySettings };
    }
    default:
      return { handled: false };
  }
}
