import { Banknote, ChevronDown, ChevronRight, ChevronUp, LayoutDashboard } from 'lucide-react';
import { useId, useState } from 'react';
import type { ModelStat } from '../types';
import { formatEstimatedUsd, formatTokens, formatUsdApprox } from '../utils/format';
import { modelCacheBreakdown, modelCostDistribution, type ModelCostRow } from '../utils/modelDistribution';
import { InfoTip } from './InfoTip';
import '../styles/overviewDrill.css';

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
  if (knownRows.length === 0) return `其余 ${hiddenRows.length} 个模型预估费用不可得`;
  const knownCost = knownCostOf(knownRows);
  const share = denominator > 0 ? Math.round((knownCost / denominator) * 1000) / 10 : null;
  const amount = `${formatEstimatedUsd(knownCost)}${share === null ? '' : `（${share}%）`}`;
  return unknownCount === 0
    ? `其余 ${hiddenRows.length} 个模型合计 ${amount}`
    : `其余 ${hiddenRows.length} 个模型：已知合计 ${amount}，${unknownCount} 个不可得`;
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
    ? `另有 ${formatUsdApprox(remainder)} 无法归属到具体模型。`
    : `另有 ${formatUsdApprox(remainder)} 未能归属到已知费用的模型，可能来自 ${unknownCount} 个预估费用不可得的模型。`;
}

/** 模型费用分布报表（REQ-DRILL-04）：全部模型按预估费用降序，默认前 8 行，下钻展示单模型命中缓存消耗分布。 */
export function ModelCostDistributionPanel({ models, totalCost, onModelClick }: ModelCostDistributionPanelProps) {
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
    <section className="panel model-cost-panel" aria-label="模型费用分布">
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-icon tone-warning" aria-hidden="true"><Banknote className="h-4 w-4" /></span>
          <span>模型费用分布</span>
          <InfoTip label="模型费用分布说明">按预估费用排序 · 不可得的排在最后 · 展开行查看缓存构成</InfoTip>
        </div>
      </div>

      {showCoverageSummary && (
        <div className="model-cost-coverage-summary" aria-label="模型费用完整性">
          <span className="is-known">已知正费用 <strong>{coverage.known}</strong></span>
          <span className="is-zero">已知为 0 <strong>{coverage.zero}</strong></span>
          <span className="is-unavailable">费用不可得 <strong>{coverage.unavailable}</strong></span>
        </div>
      )}

      <div
        id={listId}
        className="model-cost-list"
        aria-label="按预估费用降序的模型费用列表"
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
                  title={`${open ? '收起' : '展开'} ${row.model.name} 命中缓存消耗分布`}
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
                    aria-label={`${row.model.name}预估费用：${costState === 'unavailable' ? '不可得' : costState === 'zero' ? '已知为 0' : formatEstimatedUsd(row.cost)}`}
                  >
                    <span className="sr-only">预估费用</span>
                    {costState === 'unavailable'
                      ? '不可得'
                      : costState === 'zero'
                        ? <><small>已知为 0</small><span>{formatEstimatedUsd(row.cost)}</span></>
                        : formatEstimatedUsd(row.cost)}
                  </span>
                  <span className="model-cost-share">
                    {row.costSharePercent === null ? '—' : `${row.costSharePercent}%`}
                  </span>

                  <span className="model-cost-badge">
                    {row.cacheReusePercent !== null
                      ? `复用率 ${row.cacheReusePercent}%`
                      : '缓存合计'}
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
                    title={`打开 ${row.model.name} 专属看板`}
                    aria-label={`打开 ${row.model.name} 专属看板`}
                  >
                    <LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="model-cost-drilldown-label">看板</span>
                  </button>
                )}
              </div>

              {open && (
                <div className="model-cache-drawer">
                  <div className="model-cache-drawer-header">
                    <span>
                      {row.model.name} · 预估费用 {formatEstimatedUsd(row.cost)} · 请求 {row.requests} 次
                      {row.requests > 0 && row.effectiveTokens !== null && ` (均耗 ≈${formatTokens(Math.round(row.effectiveTokens / row.requests))})`}
                    </span>
                    {breakdown.reusePercent !== null && (
                      <span className="text-success font-medium">
                        命中缓存复用率 {breakdown.reusePercent}%
                      </span>
                    )}
                  </div>

                  {breakdown.segments.map((segment) => (
                    <div key={segment.kind} className="model-cache-segment-row">
                      <span className="model-cache-segment-label">{segment.label}</span>
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
            {showAllRows ? '收起' : `展开全部（${rows.length}）`}
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
