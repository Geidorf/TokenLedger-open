import type { MessageKey } from '../i18n';

export interface CacheMetricSource {
  cachedTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type CacheBreakdown =
  | {
      kind: 'split';
      total: number;
      read: number;
      write: number;
    }
  | {
      kind: 'combined';
      total: number;
    };

export interface CacheDetailMetric {
  label: '缓存读取' | '缓存写入' | '缓存合计';
  tokens: number;
}

/** Message keys for `CacheDetailMetric.label`, which stays the stable Chinese id. */
export const CACHE_METRIC_LABEL_KEY = {
  '缓存读取': 'logs.cache.read',
  '缓存写入': 'logs.cache.write',
  '缓存合计': 'logs.cache.total',
} as const satisfies Record<CacheDetailMetric['label'], MessageKey>;

/**
 * Preserve unknown read/write provenance without turning it into an empty UI.
 * A split is displayable only when the response explicitly supplies both
 * optional fields; otherwise the historical combined cache value stays intact.
 */
export function resolveCacheBreakdown(source: CacheMetricSource): CacheBreakdown {
  const read = source.cacheReadTokens;
  const write = source.cacheWriteTokens;
  const splitIsProven = typeof read === 'number'
    && Number.isFinite(read)
    && read >= 0
    && typeof write === 'number'
    && Number.isFinite(write)
    && write >= 0
    && read + write === source.cachedTokens;
  if (splitIsProven) {
    return {
      kind: 'split',
      total: source.cachedTokens,
      read: read as number,
      write: write as number,
    };
  }

  return {
    kind: 'combined',
    total: source.cachedTokens,
  };
}

export function cacheDetailMetrics(source: CacheMetricSource): CacheDetailMetric[] {
  const breakdown = resolveCacheBreakdown(source);
  if (breakdown.kind === 'split') {
    return [
      { label: '缓存读取', tokens: breakdown.read },
      { label: '缓存写入', tokens: breakdown.write },
    ];
  }
  return [{ label: '缓存合计', tokens: breakdown.total }];
}
