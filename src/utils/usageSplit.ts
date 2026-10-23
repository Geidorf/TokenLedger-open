import type { StatsData } from '../types';
import { effectiveTokens } from '../types';
import { splitModelCacheRead } from './modelDistribution';

/**
 * 统一「Split by」（对齐 magpie Usage 页）：同一份 StatsData 按 Agent、模型或设备拆分，
 * 选中一项后其他维度随之收窄。只用契约已有字段，不推断：
 * - Agent × 模型的交叉只有 `tools[].models` 里的有效 Token，没有记录数与费用；
 * - 设备只有 `machineDistribution` 的整体构成，不能与 Agent、模型交叉。
 * 交叉取不到的指标标为不可得，不按 0 显示。
 */
export type SplitDimension = 'agent' | 'model' | 'device';
export type SplitMetric = 'tokens' | 'requests' | 'cost';

export interface SplitFocus {
  dimension: SplitDimension;
  id: string;
}

export interface SplitRow {
  id: string;
  /** 当前指标的值；交叉取不到时为 null。 */
  value: number | null;
  /** 占当前列表合计的比例；value 为 null 时为 null。 */
  share: number | null;
  tokens: number;
  requests: number | null;
  cost: number | null;
  /** 缓存命中率 = 缓存读 ÷（输入 + 缓存读）；读写拆分不可证明或是交叉行时为 null。 */
  cacheHit: number | null;
}

export interface SplitResult {
  rows: SplitRow[];
  /** 当前维度与焦点下可用的指标；其余指标在界面上禁用并说明原因。 */
  metrics: SplitMetric[];
  /** 焦点存在但当前维度不能随之收窄（设备 × 其他维度）。 */
  focusIgnored: boolean;
}

export const SPLIT_DIMENSIONS: { id: SplitDimension; label: string }[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'model', label: '模型' },
  { id: 'device', label: '设备' },
];

export const SPLIT_METRICS: { id: SplitMetric; label: string }[] = [
  { id: 'tokens', label: 'Token' },
  { id: 'requests', label: '记录数' },
  { id: 'cost', label: '费用' },
];

const ALL_METRICS: SplitMetric[] = ['tokens', 'requests', 'cost'];

export function cacheHitRate(input: number | undefined, cacheRead: number | undefined): number | null {
  if (typeof cacheRead !== 'number' || !Number.isFinite(cacheRead)) return null;
  const denominator = (input || 0) + cacheRead;
  return denominator > 0 ? cacheRead / denominator : null;
}

/** 只有缓存读写之和等于缓存合计（拆分可证明）时才给命中率，与模型分布的口径一致。 */
function provenCacheHit(source: { input?: number; cached?: number; cacheRead?: number; cacheWrite?: number }): number | null {
  const { cacheRead } = splitModelCacheRead({ cached: source.cached ?? 0, cacheRead: source.cacheRead, cacheWrite: source.cacheWrite });
  return cacheRead === null ? null : cacheHitRate(source.input, cacheRead);
}

function metricValue(row: Omit<SplitRow, 'value' | 'share'>, metric: SplitMetric): number | null {
  if (metric === 'tokens') return row.tokens;
  if (metric === 'requests') return row.requests;
  return row.cost;
}

/**
 * `costTotal`：费用占比的分母用同范围汇总的总费用（与模型费用分布一致），
 * 有费用没落到任何一行时，已知行不会被放大成 100%。
 */
function finish(rows: Omit<SplitRow, 'value' | 'share'>[], metric: SplitMetric, metrics: SplitMetric[], focusIgnored: boolean, costTotal = 0): SplitResult {
  const effectiveMetric = metrics.includes(metric) ? metric : 'tokens';
  const valued = rows
    .map((row) => ({ ...row, value: metricValue(row, effectiveMetric) }))
    .filter((row) => row.tokens > 0 || (row.value ?? 0) > 0)
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.tokens - a.tokens || a.id.localeCompare(b.id));
  const rowTotal = valued.reduce((sum, row) => sum + (row.value ?? 0), 0);
  const total = effectiveMetric === 'cost' ? Math.max(rowTotal, costTotal) : rowTotal;
  return {
    rows: valued.map((row) => ({ ...row, share: row.value === null ? null : total > 0 ? row.value / total : 0 })),
    metrics,
    focusIgnored,
  };
}

function agentRows(stats: StatsData, withCache: boolean) {
  return Object.values(stats.tools || {}).map((tool) => ({
    id: tool.name,
    tokens: effectiveTokens(tool) + (withCache ? tool.cached || 0 : 0),
    requests: tool.requests,
    cost: tool.cost,
    cacheHit: provenCacheHit(tool),
  }));
}

function modelRows(stats: StatsData, withCache: boolean) {
  return Object.values(stats.models || {}).map((model) => ({
    id: model.name,
    tokens: (model.input || 0) + (model.output || 0) + (withCache ? model.cached || 0 : 0),
    requests: model.requests,
    cost: typeof model.cost === 'number' ? model.cost : null,
    cacheHit: provenCacheHit(model),
  }));
}

function deviceRows(stats: StatsData, withCache: boolean) {
  return (stats.machineDistribution || []).map((machine) => ({
    id: machine.value,
    tokens: machine.tokens + (withCache ? machine.cachedTokens || 0 : 0),
    requests: machine.requests,
    cost: machine.cost,
    cacheHit: null,
  }));
}

/**
 * `withCache` 跟随概览的「概览有效 / 概览含缓存」口径（与原模型排行一致）；
 * Agent × 模型交叉只有有效 Token，交叉时始终是有效口径，界面会写明。
 */
export function splitUsage(stats: StatsData, dimension: SplitDimension, metric: SplitMetric, focus: SplitFocus | null, withCache = false): SplitResult {
  const crossFocus = focus && focus.dimension !== dimension ? focus : null;
  const costTotal = stats.summary?.totalCost || 0;
  if (dimension === 'device') return finish(deviceRows(stats, withCache), metric, ALL_METRICS, Boolean(crossFocus), costTotal);
  if (crossFocus?.dimension === 'device') {
    return finish(dimension === 'agent' ? agentRows(stats, withCache) : modelRows(stats, withCache), metric, ALL_METRICS, true, costTotal);
  }
  if (dimension === 'model' && crossFocus?.dimension === 'agent') {
    const models = stats.tools?.[crossFocus.id]?.models || {};
    return finish(Object.entries(models).map(([id, tokens]) => ({ id, tokens, requests: null, cost: null, cacheHit: null })), metric, ['tokens'], false);
  }
  if (dimension === 'agent' && crossFocus?.dimension === 'model') {
    const rows = Object.values(stats.tools || {})
      .map((tool) => ({ id: tool.name, tokens: tool.models?.[crossFocus.id] ?? 0, requests: null, cost: null, cacheHit: null }))
      .filter((row) => row.tokens > 0);
    return finish(rows, metric, ['tokens'], false);
  }
  return finish(dimension === 'agent' ? agentRows(stats, withCache) : modelRows(stats, withCache), metric, ALL_METRICS, false, costTotal);
}

/**
 * 热力图跟随焦点：选中 Agent 或模型时用它自己的逐日有效 Token；
 * 设备没有逐日数据，来源也可能不带实体热力图，这两种情况返回 null，由调用方退回整体热力图并说明。
 */
export function splitHeatmap(stats: StatsData, focus: SplitFocus | null): Record<string, number> | null {
  if (!focus) return stats.heatmap;
  if (focus.dimension === 'agent') return stats.tools?.[focus.id]?.heatmap ?? null;
  if (focus.dimension === 'model') return stats.models?.[focus.id]?.heatmap ?? null;
  return null;
}
