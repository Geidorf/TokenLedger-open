import { Banknote, ChevronDown, ChevronRight, ChevronUp, LayoutDashboard } from 'lucide-react';
import { useId, useState } from 'react';
import type { ModelStat } from '../types';
import { formatEstimatedUsd, formatTokens, formatUsdApprox } from '../utils/format';
import { modelCacheBreakdown, modelCostDistribution, type ModelCostRow } from '../utils/modelDistribution';
import { InfoTip } from './InfoTip';
import '../styles/overviewDrill.css';
import { localized, t, useLang } from '../i18n';

interface ModelCostDistributionPanelProps {
  /** 本期全部模型（不是 Token 前 8）：金额排序与“无法归属”都以全集为准。 */
  models: ModelStat[];
  totalCost?: number;
  onModelClick?: (model: ModelStat) => void;
}

/** 默认显示的行数；其余行由“展开全部”原位展开。 */
export const MODEL_COST_DEFAULT_ROWS = 8;

/** 已知行合计与汇总费用相差不足 1 美分时视为舍入误差，不提示无法归属。 */
const UNATTRIBUTED_MIN_USD = 0.01;

export type ModelCostState = 'known' | 'zero' | 'unavailable';

export function modelCostState(cost: number | null): ModelCostState {
  if (cost === null) return 'unavailable';
  return cost === 0 ? 'zero' : 'known';
}

export function modelCostCoverageSummary(rows: ModelCostRow[]): {
  known: number;
  zero: number;
  unavailable: number;
} {
  return rows.reduce((summary, row) => {
    const state = modelCostState(row.cost);
    summary[state] += 1;
    return summary;
  }, { known: 0, zero: 0, unavailable: 0 });
}

function knownCostOf(rows: ModelCostRow[]) {
  return rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
}

/** 与 `modelCostDistribution` 的占比同一分母：汇总费用不小于已知合计时用汇总，否则用已知合计。 */
function shareDenominator(rows: ModelCostRow[], totalCost: number | undefined): number {
  const known = knownCostOf(rows);
  return typeof totalCost === 'number' && Number.isFinite(totalCost) && totalCost >= known ? totalCost : known;
}

/**
 * 默认行之外的模型摘要。只合计已知费用，费用不可得的模型单独计数，不按 0 并入。
 */
export function hiddenRowsSummary(hiddenRows: ModelCostRow[], denominator: number): string {
  const knownRows = hiddenRows.filter((row) => row.cost !== null);
  const unknownCount = hiddenRows.length - knownRows.length;
  if (knownRows.length === 0) return t('modelCost.hidden.allUnknown', { n: hiddenRows.length });
  const knownCost = knownCostOf(knownRows);
  const share = denominator > 0 ? Math.round((knownCost / denominator) * 1000) / 10 : null;
  const amount = share === null ? formatEstimatedUsd(knownCost) : t('modelCost.hidden.share', { amount: formatEstimatedUsd(knownCost), share });
  return unknownCount === 0
    ? t('modelCost.hidden.total', { n: hiddenRows.length, amount })
    : t('modelCost.hidden.partial', { n: hiddenRows.length, amount, unknown: unknownCount });
}

/**
 * 真正无法归属到任何模型的费用：汇总费用减去全部模型行的已知费用。
 * 有模型费用不可得时，这部分余额可能属于它们，文案须如实说明。
 */
export function unattributedCostNote(rows: ModelCostRow[], totalCost: number | undefined): string | null {
  if (typeof totalCost !== 'number' || !Number.isFinite(totalCost)) return null;
  const remainder = totalCost - knownCostOf(rows);
  if (remainder < UNATTRIBUTED_MIN_USD) return null;
  const unknownCount = rows.filter((row) => row.cost === null).length;
  return unknownCount === 0
    ? t('modelCost.unattributed', { amount: formatUsdApprox(remainder) })
    : t('modelCost.unattributedUnknown', { amount: formatUsdApprox(remainder), n: unknownCount });
}

// 缓存构成各段的显示名；`modelCacheBreakdown` 自带的中文标签留给导出报告。
const SEGMENT_LABELS = localized<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cacheCombined'>({
  input: 'modelCost.segment.input',
  output: 'modelCost.segment.output',
  cacheRead: 'modelCost.segment.cacheRead',
  cacheWrite: 'modelCost.segment.cacheWrite',
  cacheCombined: 'modelCost.cacheTotal',
});

/** 模型费用分布报表（REQ-DRILL-04）：全部模型按预估费用降序，默认前 8 行，下钻展示单模型命中缓存消耗分布。 */
export function ModelCostDistributionPanel({ models, totalCost, onModelClick }: ModelCostDistributionPanelProps) {
  useLang();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAllRows, setShowAllRows] = useState(false);
  const listId = useId();
  const rows = modelCostDistribution(models, totalCost);
  const collapsible = rows.length > MODEL_COST_DEFAULT_ROWS;
  const visibleRows = collapsible && !showAllRows ? rows.slice(0, MODEL_COST_DEFAULT_ROWS) : rows;
  const hiddenRows = rows.slice(MODEL_COST_DEFAULT_ROWS);
  // 数据条按全部行的最大值归一，展开后已显示的行宽度不跳。
  const maxCost = rows.reduce((max, row) => Math.max(max, row.cost ?? 0), 0);
  const unattributedNote = unattributedCostNote(rows, totalCost);
  const coverage = modelCostCoverageSummary(rows);
  const showCoverageSummary = coverage.zero > 0 || coverage.unavailable > 0;

  if (rows.length === 0) return null;

  return (
    <section className="panel model-cost-panel" aria-label={t('modelCost.title')}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon tone-warning" aria-hidden="true"><Banknote className="h-4 w-4" /></span>
          <span>{t('modelCost.title')}</span>
          <InfoTip label={t('modelCost.infoLabel')}>{t('modelCost.info')}</InfoTip>
        </div>
      </div>

      {showCoverageSummary && (
        <div className="model-cost-coverage-summary" aria-label={t('modelCost.coverageAria')}>
          <span className="is-known">{t('modelCost.knownPositive')} <strong>{coverage.known}</strong></span>
          <span className="is-zero">{t('modelCost.knownZero')} <strong>{coverage.zero}</strong></span>
          <span className="is-unavailable">{t('modelCost.unavailable')} <strong>{coverage.unavailable}</strong></span>
        </div>
      )}

      <div
        id={listId}
        className="model-cost-list"
        aria-label={t('modelCost.listAria')}
      >
        {visibleRows.map((row, index) => {
          const breakdown = modelCacheBreakdown(row.model);
          const open = expanded === row.model.name;
          const costState = modelCostState(row.cost);
          return (
            <div key={row.model.name} className="model-cost-item">
              <div className="model-cost-row-wrapper">
                <button
                  type="button"
                  className="model-cost-row-btn"
                  onClick={() => setExpanded(open ? null : row.model.name)}
                  aria-expanded={open}
                  title={t(open ? 'modelCost.collapseRow' : 'modelCost.expandRow', { model: row.model.name })}
                >
                  {/* Unknown cost is not $0 (GLB-01): no cost rank and no zero-width
                      bar, only a dashed empty slot next to 「不可得」. */}
                  <span className="model-cost-rank" aria-hidden={row.cost === null || undefined}>
                    {row.cost === null ? '—' : index + 1}
                  </span>
                  <span className="model-cost-name">{row.model.name}</span>

                  {costState === 'unavailable' ? (
                    <span className="model-cost-meter is-unavailable" aria-hidden="true" />
                  ) : (
                    <span className={`model-cost-meter${costState === 'zero' ? ' is-zero' : ''}`} aria-hidden="true">
                      <i
                        className="model-cost-meter-fill"
                        style={{ width: `${row.cost !== null && maxCost > 0 ? (row.cost / maxCost) * 100 : 0}%` }}
                      />
                    </span>
                  )}

                  <span
                    className={`model-cost-amount is-${costState}`}
                    aria-label={t('modelCost.amountAria', { model: row.model.name, value: costState === 'unavailable' ? t('modelCost.na') : costState === 'zero' ? t('modelCost.knownZero') : formatEstimatedUsd(row.cost) })}
                  >
                    <span className="sr-only">{t('modelCost.costSr')}</span>
                    {costState === 'unavailable'
                      ? t('modelCost.na')
                      : costState === 'zero'
                        ? <><small>{t('modelCost.knownZero')}</small><span>{formatEstimatedUsd(row.cost)}</span></>
                        : formatEstimatedUsd(row.cost)}
                  </span>
                  <span className="model-cost-share">
                    {row.costSharePercent === null ? '—' : `${row.costSharePercent}%`}
                  </span>

                  <span className="model-cost-badge">
                    {row.cacheReusePercent !== null
                      ? t('modelCost.reuse', { pct: row.cacheReusePercent })
                      : t('modelCost.cacheTotal')}
                  </span>

                  {open ? (
                    <ChevronDown className="h-3.5 w-3.5 text-faint flex-none" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-faint flex-none" />
                  )}
                </button>

                {onModelClick && (
                  <button
                    type="button"
                    className="model-cost-drilldown-btn"
                    onClick={() => onModelClick(row.model)}
                    title={t('modelCost.openDashboard', { model: row.model.name })}
                    aria-label={t('modelCost.openDashboard', { model: row.model.name })}
                  >
                    <LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="model-cost-drilldown-label">{t('modelCost.dashboard')}</span>
                  </button>
                )}
              </div>

              {open && (
                <div className="model-cache-drawer">
                  <div className="model-cache-drawer-header">
                    <span>
                      {t('modelCost.drawerHead', { model: row.model.name, cost: formatEstimatedUsd(row.cost), n: row.requests })}
                      {row.requests > 0 && row.effectiveTokens !== null && t('modelCost.drawerAvg', { tokens: formatTokens(Math.round(row.effectiveTokens / row.requests)) })}
                    </span>
                    {breakdown.reusePercent !== null && (
                      <span className="text-success font-medium">
                        {t('modelCost.cacheReuse', { pct: breakdown.reusePercent })}
                      </span>
                    )}
                  </div>

                  {breakdown.segments.map((segment) => (
                    <div key={segment.kind} className="model-cache-segment-row">
                      <span className="model-cache-segment-label">{SEGMENT_LABELS[segment.kind]}</span>
                      <span className="model-cache-segment-meter" aria-hidden="true">
                        <i
                          className={`model-cache-segment-fill kind-${segment.kind}`}
                          style={{
                            width: `${breakdown.totalTokens > 0 ? (segment.tokens / breakdown.totalTokens) * 100 : 0}%`,
                          }}
                        />
                      </span>
                      <strong className="model-cache-segment-tokens">
                        {formatTokens(segment.tokens)}
                      </strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {collapsible && (
        <div className="model-cost-more">
          <button
            type="button"
            className="ghost-inline model-cost-more-toggle"
            onClick={() => setShowAllRows((current) => !current)}
            aria-expanded={showAllRows}
            aria-controls={listId}
          >
            {showAllRows
              ? <ChevronUp className="h-4 w-4" aria-hidden="true" />
              : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
            {showAllRows ? t('modelCost.collapse') : t('modelCost.showAll', { n: rows.length })}
          </button>
          {!showAllRows && (
            <span className="model-cost-more-summary">{hiddenRowsSummary(hiddenRows, shareDenominator(rows, totalCost))}</span>
          )}
        </div>
      )}
      {unattributedNote && (
        <p className="model-cost-coverage-note">{unattributedNote}</p>
      )}
    </section>
  );
}

export default ModelCostDistributionPanel;
