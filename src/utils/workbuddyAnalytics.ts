import type { ModelStat } from '../types';

/**
 * 计算输入/输出比（I/O Ratio），如 "87:1" 或 "87.2:1"
 */
export function calculateIoRatio(inputTokens: number, outputTokens: number): string {
  const input = Math.max(0, inputTokens || 0);
  const output = Math.max(0, outputTokens || 0);
  if (input === 0 && output === 0) return '—';
  if (output === 0) return '纯输入';
  if (input === 0) return '纯输出';

  const ratio = input / output;
  if (ratio >= 100) {
    return `${Math.round(ratio)}:1`;
  }
  if (ratio >= 10) {
    return `${ratio.toFixed(1).replace(/\.0$/, '')}:1`;
  }
  return `${ratio.toFixed(1)}:1`;
}

/**
 * 只从与当前查询同范围的模型日桶计算活跃日均。
 * 顶层 heatmap 在云端是年度背景，不能充当筛选范围的分母。
 */
export function calculateActiveDaysDailyAvg(
  totalTokens: number,
  models?: Record<string, ModelStat>,
): { dailyAvg: number; activeDaysCount: number } | null {
  const entries = Object.values(models || {});
  if (entries.length === 0 || entries.some((model) => !model.heatmap)) return null;
  const dailyTotals = new Map<string, number>();
  for (const model of entries) {
    for (const [date, tokens] of Object.entries(model.heatmap || {})) {
      if (!Number.isFinite(tokens) || tokens < 0) return null;
      dailyTotals.set(date, (dailyTotals.get(date) || 0) + tokens);
    }
  }
  const activeDays = [...dailyTotals.values()].filter((tokens) => tokens > 0);
  const aggregateTotal = [...dailyTotals.values()].reduce((total, tokens) => total + tokens, 0);
  if (activeDays.length === 0 || aggregateTotal !== totalTokens) return null;
  return {
    dailyAvg: Math.round(totalTokens / activeDays.length),
    activeDaysCount: activeDays.length,
  };
}
