import type { LogHistoryItem, StatsData, Summary } from '../../types';
import { summaryEffectiveTokens } from '../../types';
import { projectActiveTools } from '../../hooks/useStats';

/** 缓存复用率 = 缓存读 ÷（未命中输入 + 缓存读）；来源不能证明读写拆分时不可得，不按 0 显示。 */
export function summaryCacheReuse(summary: Summary): number | null {
  const read = summary.cacheReadTokens;
  if (typeof read !== 'number' || !Number.isFinite(read)) return null;
  const denominator = summary.inputTokens + read;
  return denominator > 0 ? read / denominator : null;
}

export interface UsageConclusion {
  effectiveTokens: number;
  /** 与上期同进度相比的有效 Token 变化；无基线时为 null。 */
  deltaPercent: number | null;
  deltaDirection: 'up' | 'down' | 'flat' | 'new' | null;
  leadTool: { name: string; share: number } | null;
  cacheReuse: number | null;
}

export function usageConclusion(stats: StatsData): UsageConclusion {
  const effective = summaryEffectiveTokens(stats.summary);
  const delta = stats.comparison?.delta.tokens ?? null;
  const [lead] = projectActiveTools(stats, false);
  const leadEffective = lead ? (lead.input || 0) + (lead.output || 0) : 0;
  return {
    effectiveTokens: effective,
    deltaPercent: delta?.percent ?? null,
    deltaDirection: delta?.direction ?? null,
    leadTool: lead && effective > 0 ? { name: lead.name, share: leadEffective / effective } : null,
    cacheReuse: summaryCacheReuse(stats.summary),
  };
}

export type RecordSourceLabel = '网关' | '日志扫描' | '未知来源';

/** 契约 §2.5：缺失按扫描理解；未知取值照常显示该行，只标未知来源。 */
export function recordSourceLabel(item: Pick<LogHistoryItem, 'source'>): RecordSourceLabel {
  if (item.source === undefined || item.source === 'scan') return '日志扫描';
  if (item.source === 'gateway') return '网关';
  return '未知来源';
}
