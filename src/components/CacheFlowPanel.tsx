import { formatCacheNetSavedUsd } from '../utils/cacheSavingsDisplay';
import { memo } from 'react';
import { ArrowRight, Database, PiggyBank, TriangleAlert } from 'lucide-react';
import type { CacheSavings, Summary } from '../types';
import { formatEstimatedUsd, formatTokens } from '../utils/format';
import { resolveCacheBreakdown } from '../utils/cacheDisplay';
import { estimatedCostNote } from '../utils/costCopy';
import { parseCacheSavings } from '../utils/contracts/statsQuery';
import { InfoTip } from './InfoTip';
import { t, useLang } from '../i18n';

interface CacheFlowPanelProps {
  summary: Summary;
}

function CacheSavingsCard({ savings }: { savings: CacheSavings | null }) {
  const savedUsd = savings?.netSavedUsd ?? null;
  return (
    <div className={`cache-flow-savings-card${savedUsd === null ? ' is-unavailable' : ''}`}>
      <div className="savings-title">{t('cacheFlow.savingsTitle')}</div>
      {savedUsd !== null ? (
        <>
          <div className="savings-value num">{formatCacheNetSavedUsd(savedUsd)}</div>
          {savings && <div className="savings-sub">{t('cacheFlow.savingsParts', { read: formatEstimatedUsd(savings.readSavedUsd), write: formatEstimatedUsd(savings.writePremiumUsd) })}</div>}
          <div className="savings-sub">{t('cacheFlow.rounding')}</div>
          {savedUsd < 0 && <div className="savings-sub">{t('cacheFlow.writePremium')}</div>}
          {savings && (savings.fallbackPricedReadTokens > 0 || savings.fallbackPricedWriteTokens > 0) && <div className="savings-sub">{t('cacheFlow.fallback', { read: formatTokens(savings.fallbackPricedReadTokens), write: formatTokens(savings.fallbackPricedWriteTokens) })}</div>}
        </>
      ) : (
        <>
          <div className="savings-value num">{t('cacheFlow.na')}</div>
          <div className="savings-sub">
            <TriangleAlert className="h-3 w-3" />
            <span>{t('cacheFlow.noPrice')}</span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Prompt Cache 流向面板（T10.86）。
 *
 * 诚实边界：
 * - 复用率只在来源显式提供读写拆分（`resolveCacheBreakdown().kind === 'split'`）时呈现；
 *   旧数据只有合计缓存时降级为「缓存合计」单段，不伪称命中。
 * - `cacheSavings` 是净节省估算对象：缺失时显示「不可得」，不按 0 处理（GLB-01）。
 * - 口径为「当前查询范围」，文案不得写成「累计」。
 */
function CacheFlowPanelComponent({ summary }: CacheFlowPanelProps) {
  useLang();
  const cache = resolveCacheBreakdown(summary);
  const inputTokens = Number.isFinite(summary.inputTokens) ? summary.inputTokens : 0;
  const writeTokens = cache.kind === 'split' ? cache.write : 0;
  const savings = parseCacheSavings(summary.cacheSavings, summary);

  if (inputTokens <= 0 && cache.total <= 0) return null;

  const isSplit = cache.kind === 'split';
  const cacheValue = isSplit ? cache.read : 0;
  const totalContext = inputTokens + cacheValue;
  const cacheShare = totalContext > 0 ? (cacheValue / totalContext) * 100 : 0;
  const inputShare = Math.max(0, 100 - cacheShare);

  const segments = isSplit ? [
    {
      key: 'hit' as const,
      label: t('cacheFlow.hit'),
      value: cacheValue,
      share: cacheShare,
    },
    {
      key: 'miss' as const,
      label: t('cacheFlow.miss'),
      value: inputTokens,
      share: inputShare,
    },
  ] : [];

  return (
    <section className="panel cache-flow-panel" aria-label={t('cacheFlow.title')}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon tone-warning" aria-hidden="true"><PiggyBank className="h-4 w-4" /></span>
          <span>{t('cacheFlow.title')}</span>
          {isSplit && (
            <InfoTip label={t('cacheFlow.infoLabel')}>
              <span>{t('cacheFlow.info1')}</span>
              <span>{t('cacheFlow.info2')}</span>
              <span>{t('cacheFlow.info3')}</span>
              <span>{t('cacheFlow.info4', { note: estimatedCostNote() })}</span>
            </InfoTip>
          )}
        </div>
        {isSplit && (
          <span className="cache-flow-reuse num" title={t('cacheFlow.reuseTitle')}>
            {t('cacheFlow.reuse', { pct: cacheShare.toFixed(1) })}
          </span>
        )}
      </div>

      {isSplit ? (
        <div className="cache-flow-visual">
        <div className="cache-flow-step">
          <div className="cache-flow-step-label">{t('cacheFlow.contextTotal')}</div>
          <div className="cache-flow-step-value num">{formatTokens(totalContext)}</div>
        </div>

        <div className="cache-flow-arrow" aria-hidden="true">
          <ArrowRight className="h-4 w-4 text-faint" />
        </div>

        <div className="cache-flow-bar-container">
          <div
            className="cache-flow-bar-meter"
            role="img"
            aria-label={segments
              .map((segment) => t('cacheFlow.segmentAria', { label: segment.label, tokens: formatTokens(segment.value), pct: segment.share.toFixed(1) }))
              .join(t('cacheFlow.segmentJoin'))}
          >
            {segments.map((segment) => (
              <div
                key={segment.key}
                className={`cache-flow-bar-fill ${segment.key}`}
                style={{ width: `${segment.share}%` }}
              />
            ))}
          </div>

          <div className="cache-flow-bar-legend">
            {segments.map((segment) => (
              <div key={segment.key} className={`legend-item ${segment.key}`}>
                <span className="legend-dot" />
                <span>
                  {segment.label}{t('cacheFlow.legendSep')}<b className="num">{formatTokens(segment.value)}</b> ({segment.share.toFixed(1)}%)
                </span>
              </div>
            ))}
          </div>

          {writeTokens > 0 && (
            <div className="cache-flow-write-note">
              <Database className="h-3 w-3" />
              <span>{t('cacheFlow.writes', { tokens: formatTokens(writeTokens) })}</span>
            </div>
          )}
        </div>

        <div className="cache-flow-arrow" aria-hidden="true">
          <ArrowRight className="h-4 w-4 text-faint" />
        </div>

          <CacheSavingsCard savings={savings} />
        </div>
      ) : (
        <div className="cache-combined-summary" role="group" aria-label={t('cacheFlow.combinedAria')}>
          <div className="cache-flow-step">
            <div className="cache-flow-step-label">{t('cacheFlow.combinedOnly')}</div>
            <div className="cache-flow-step-value num">{formatTokens(cache.total)}</div>
          </div>
          <details className="text-xs text-muted">
            <summary className="min-h-11 cursor-pointer py-3">{t('cacheFlow.whyTitle')}</summary>
            <p>{t('cacheFlow.whyBody')}</p>
          </details>
        </div>
      )}
    </section>
  );
}

export const CacheFlowPanel = memo(CacheFlowPanelComponent);
export default CacheFlowPanel;
