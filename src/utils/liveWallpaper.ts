import type { StatsData } from '../types';
import { trendBucketTokens } from './trendsAggregate';

export interface WallpaperSnapshot { effectiveTokens: number; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number | null; requests: number; trend: number[]; tools: Array<{ name: string; effectiveTokens: number }>; }
const finiteNonNegative = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** 动态桌面只呈现既有 Stats 字段；成本未知时保持未知，不能显示为免费。 */
export function buildWallpaperSnapshot(stats: StatsData): WallpaperSnapshot {
  const inputTokens = finiteNonNegative(stats.summary.inputTokens);
  const outputTokens = finiteNonNegative(stats.summary.outputTokens);
  return {
    effectiveTokens: inputTokens + outputTokens, inputTokens, outputTokens,
    cachedTokens: finiteNonNegative(stats.summary.cachedTokens),
    cost: typeof stats.summary.totalCost === 'number' && Number.isFinite(stats.summary.totalCost) && stats.summary.totalCost >= 0 ? stats.summary.totalCost : null,
    requests: finiteNonNegative(stats.summary.totalRequests),
    trend: stats.trends.map((point) => Math.max(0, trendBucketTokens(point))),
    tools: Object.values(stats.tools).map((tool) => ({ name: tool.name, effectiveTokens: finiteNonNegative(tool.input) + finiteNonNegative(tool.output) })).filter((tool) => tool.effectiveTokens > 0).sort((left, right) => right.effectiveTokens - left.effectiveTokens || left.name.localeCompare(right.name, 'zh-CN')).slice(0, 3),
  };
}

/** 已知生成时间不属于当前查询日时，动态桌面必须明确把它视为历史快照。 */
export function isHistoricalWallpaperSnapshot(stats: StatsData, timezone: string, now = new Date()): boolean {
  if (stats.meta?.stale) return true;
  const generatedAt = stats.meta?.generatedAt;
  if (!generatedAt) return false;
  const generated = new Date(generatedAt);
  if (Number.isNaN(generated.getTime())) return true;
  const day = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  return day(generated) !== day(now);
}
