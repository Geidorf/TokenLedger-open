import type { StatsData, Summary } from '../../types';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statsVisualPayload(stats: StatsData) {
  // generatedAt participates in the visual snapshot: when comparison is absent,
  // time-based insights use it as the completed/in-progress bucket cutoff. Keeping
  // an older React object across an hour/day boundary would otherwise leave those
  // insights stale even though a fresh response has arrived.
  const { lastRefreshedAt: _lastRefreshedAt, ...semanticMeta } = stats.meta || {};
  const { meta: _meta, ...businessPayload } = stats;
  return [businessPayload, semanticMeta];
}

export function sameStatsSnapshot(previous: StatsData | null, next: StatsData): boolean {
  if (!previous) return false;
  return JSON.stringify(statsVisualPayload(previous)) === JSON.stringify(statsVisualPayload(next));
}

export type CacheEfficiencyInsight =
  | {
      kind: 'split';
      cacheRatioPercent: number;
      totalSavedUsd: number | null;
      hasCachedData: boolean;
    }
  | {
      kind: 'unavailable';
      totalSavedUsd: number | null;
    };

export function calculateCacheEfficiency(summary: Summary | null | undefined): CacheEfficiencyInsight {
  if (!summary) {
    return { kind: 'unavailable', totalSavedUsd: null };
  }
  const totalSavedUsd = typeof summary.cacheSavedUsd === 'number'
    && Number.isFinite(summary.cacheSavedUsd)
    && summary.cacheSavedUsd >= 0
    ? summary.cacheSavedUsd
    : null;
  const cacheRead = summary.cacheReadTokens;
  const cacheWrite = summary.cacheWriteTokens;
  const splitIsProven = typeof cacheRead === 'number'
    && Number.isFinite(cacheRead)
    && cacheRead >= 0
    && typeof cacheWrite === 'number'
    && Number.isFinite(cacheWrite)
    && cacheWrite >= 0
    && cacheRead + cacheWrite === summary.cachedTokens;
  if (!splitIsProven) return { kind: 'unavailable', totalSavedUsd };

  const input = summary.inputTokens || 0;
  // 复用率基于可证明的读缓存：写入缓存是新写入而非“复用”，不得并入复用口径。
  const provenRead = cacheRead as number;
  const denominator = input + provenRead;
  const cacheRatioPercent = denominator > 0 ? (provenRead / denominator) * 100 : 0;

  const roundedRatio = Math.round(cacheRatioPercent * 10) / 10;

  return {
    kind: 'split',
    cacheRatioPercent: roundedRatio,
    totalSavedUsd,
    hasCachedData: provenRead > 0,
  };
}
