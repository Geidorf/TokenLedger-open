import { formatCacheNetSavedUsd } from '../utils/cacheSavingsDisplay';
import { memo } from 'react';
import { ArrowRight, Database, PiggyBank, TriangleAlert } from 'lucide-react';
import type { CacheSavings, Summary } from '../types';
import { formatEstimatedUsd, formatTokens } from '../utils/format';
import { resolveCacheBreakdown } from '../utils/cacheDisplay';
import { estimatedCostNote } from '../utils/costCopy';
import { parseCacheSavings } from '../utils/contracts/statsQuery';
import { InfoTip } from './InfoTip';

interface CacheFlowPanelProps {
  summary: Summary;
}

function CacheSavingsCard({ savings }: { savings: CacheSavings | null }) {
  const savedUsd = savings?.netSavedUsd ?? null;
  return (
    <div className={`cache-flow-savings-card${savedUsd === null ? ' is-unavailable' : ''}`}>
      <div className="savings-title">缓存净节省（当前范围）</div>
      {savedUsd !== null ? (
        <>
          <div className="savings-value num">{formatCacheNetSavedUsd(savedUsd)}</div>
          {savings && <div className="savings-sub">缓存读取节省 {formatEstimatedUsd(savings.readSavedUsd)} · 缓存写入溢价 {formatEstimatedUsd(savings.writePremiumUsd)}</div>}
          <div className="savings-sub">各项分别四舍五入，合计可能相差 $0.01</div>
          {savedUsd < 0 && <div className="savings-sub">写入溢价高于读取节省</div>}
          {savings && (savings.fallbackPricedReadTokens > 0 || savings.fallbackPricedWriteTokens > 0) && <div className="savings-sub">含兜底单价 · 读取 {formatTokens(savings.fallbackPricedReadTokens)} / 写入 {formatTokens(savings.fallbackPricedWriteTokens)} Token</div>}
        </>
      ) : (
        <>
          <div className="savings-value num">不可得</div>
          <div className="savings-sub">
            <TriangleAlert className="h-3 w-3" />
            <span>缺少可用价格估算，不显示 0</span>
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
      label: '缓存命中读取',
      value: cacheValue,
      share: cacheShare,
    },
    {
      key: 'miss' as const,
      label: '未命中全价输入',
      value: inputTokens,
      share: inputShare,
    },
  ] : [];

  return (
    <section className="panel cache-flow-panel" aria-label="Prompt 缓存概览与节省">
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon tone-warning" aria-hidden="true"><PiggyBank className="h-4 w-4" /></span>
          <span>Prompt 缓存概览与节省</span>
          {isSplit && (
            <InfoTip label="缓存口径说明">
              <span>命中缓存在更低单价下复用前缀上下文，减少全价重算。</span>
              <span>复用率 = 命中读取 ÷（未命中输入 + 命中缓存读）；上下文输入总量 = 未命中输入 + 命中缓存读。</span>
              <span>缓存写入单列计费，不计入复用率分母。</span>
              <span>缓存净节省 = 缓存读取节省 − 缓存写入溢价；三项均{estimatedCostNote('zh')}。</span>
            </InfoTip>
          )}
        </div>
        {isSplit && (
          <span className="cache-flow-reuse num" title="缓存命中读取 ÷（未命中输入 + 命中缓存读）">
            复用率 {cacheShare.toFixed(1)}%
          </span>
        )}
      </div>

      {isSplit ? (
        <div className="cache-flow-visual">
        <div className="cache-flow-step">
          <div className="cache-flow-step-label">上下文输入总量</div>
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
              .map((segment) => `${segment.label} ${formatTokens(segment.value)}（${segment.share.toFixed(1)}%）`)
              .join('，')}
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
                  {segment.label}：<b className="num">{formatTokens(segment.value)}</b> ({segment.share.toFixed(1)}%)
                </span>
              </div>
            ))}
          </div>

          {writeTokens > 0 && (
            <div className="cache-flow-write-note">
              <Database className="h-3 w-3" />
              <span>缓存写入 {formatTokens(writeTokens)}</span>
            </div>
          )}
        </div>

        <div className="cache-flow-arrow" aria-hidden="true">
          <ArrowRight className="h-4 w-4 text-faint" />
        </div>

          <CacheSavingsCard savings={savings} />
        </div>
      ) : (
        <div className="cache-combined-summary" role="group" aria-label="缓存合计，读写未拆分">
          <div className="cache-flow-step">
            <div className="cache-flow-step-label">仅有缓存合计</div>
            <div className="cache-flow-step-value num">{formatTokens(cache.total)}</div>
          </div>
          <details className="text-xs text-muted">
            <summary className="min-h-11 cursor-pointer py-3">为什么无法计算复用与节省？</summary>
            <p>缺少可信的缓存读写拆分，无法计算流向、复用率或缓存净节省。</p>
          </details>
        </div>
      )}
    </section>
  );
}

export const CacheFlowPanel = memo(CacheFlowPanelComponent);
export default CacheFlowPanel;
