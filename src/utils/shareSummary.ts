import type { DataScope, RangeKey, StatsData, UsageComparison } from '../types';
import { resolveCacheBreakdown } from './cacheDisplay';
import { parseCacheSavings } from './contracts/statsQuery';
import { deriveInsightTimeContext, type InsightTimeContext } from './insightRules';
import { trendBucketKind, trendBucketTokens } from './trendsAggregate';

export type ShareLayoutKey = 'scorecard' | 'journal' | 'achievement' | 'receipt' | 'signal';

export interface ShareSeriesPoint {
  label: string;
  tokens: number;
  requests?: number;
}

export interface ShareRankedItem {
  name: string;
  tokens: number;
  sharePercent: number | null;
}

export interface ShareSummary {
  range: RangeKey;
  scope: DataScope;
  title: string;
  periodLabel: string;
  sourceLabel: string;
  generatedLabel: string;
  isStale: boolean;
  effectiveTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReusePercent: number | null;
  totalRequests: number;
  averageTokensPerRequest: number | null;
  activeDays: number | null;
  longestStreakDays: number | null;
  dailyAverageTokens: number | null;
  deltaPercent: number | null;
  deltaDirection: 'up' | 'down' | 'flat' | 'new' | null;
  peak: ShareSeriesPoint | null;
  series: ShareSeriesPoint[];
  topTool: ShareRankedItem | null;
  topModel: ShareRankedItem | null;
  totalCostUsd: number | null;
  cacheNetSavedUsd: number | null;
  costsHidden: boolean;
  boundaryNotes: string[];
  insight: string;
}

export interface BuildShareSummaryOptions {
  stats: StatsData;
  range: RangeKey;
  scope: DataScope;
  hideCosts?: boolean;
  now?: Date;
}

const RANGE_TITLE: Record<RangeKey, string> = {
  today: '我的 AI 协作日报',
  week: '我的 AI 协作周报',
  month: '我的 AI 协作月报',
  year: '我的 AI 协作年报',
  all: 'AI 协作里程碑',
  custom: '我的 AI 协作复盘',
};

const EXPECTED_COMPARISON: Partial<Record<RangeKey, UsageComparison['window']['kind']>> = {
  today: 'dayOverDay',
  week: 'weekOverWeek',
  month: 'monthOverMonth',
  custom: 'periodOverPeriod',
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function knownNonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function effectiveItemTokens(value: { input?: number; output?: number }): number {
  return knownNonNegative(value.input) && knownNonNegative(value.output)
    ? value.input + value.output
    : Number.NaN;
}

export const SHARE_DATA_UNAVAILABLE = '分享数据不完整，无法生成海报，请刷新后重试';

function requireTokenCount(value: unknown): number {
  if (!knownNonNegative(value) || !Number.isSafeInteger(value)) throw new Error(SHARE_DATA_UNAVAILABLE);
  return value;
}

function parseIsoDay(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const day = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  return day && trendBucketKind(day) === 'day' ? day : null;
}

function localDateFromIso(value: string): Date | null {
  const day = parseIsoDay(value);
  if (!day) return null;
  const parsed = new Date(`${day}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function localizedDateParts(value: string, timezone?: string): [number, number, number] | null {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(timestamp);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year && month && day) return [Number(year), Number(month), Number(day)];
  } catch {
    return null;
  }
  return null;
}

function zhDate(value: string, includeYear = false, timezone?: string): string | null {
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const parts = hasExplicitOffset
    ? localizedDateParts(value, timezone)
    : (() => {
        const day = parseIsoDay(value);
        return day ? day.split('-').map(Number) as [number, number, number] : null;
      })();
  if (!parts) return null;
  const [year, month, day] = parts;
  return includeYear ? `${year}年${month}月${day}日` : `${month}月${day}日`;
}

function customQueryWindow(stats: StatsData): { start: string; end: string } | null {
  const query = stats.meta?.query;
  if (query?.range !== 'custom' || (stats.meta?.range && stats.meta.range !== 'custom')
    || query.tokenMode !== 'effective' || !query.timezone
    || (stats.meta?.timezone && query.timezone !== stats.meta.timezone)
    || trendBucketKind(query.start) !== 'day' || trendBucketKind(query.end) !== 'day'
    || !query.start || !query.end || query.start > query.end) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: query.timezone }).format(new Date(0));
  } catch {
    return null;
  }
  return { start: query.start, end: query.end };
}

function periodLabel(range: RangeKey, stats: StatsData, context: InsightTimeContext | null): string {
  const comparison = stats.comparison;
  const expected = EXPECTED_COMPARISON[range];
  if (context && expected && comparison?.window.kind === expected) {
    const withYear = range === 'month' || range === 'custom';
    const start = zhDate(comparison.window.currentStart, withYear, context.timeZone);
    const end = zhDate(comparison.window.currentEnd, withYear, context.timeZone);
    if (start && end) return range === 'today' || start === end ? end : `${start}—${end}`;
  }
  if (range === 'custom') {
    const query = customQueryWindow(stats);
    if (!query) return '自定义区间（日期未提供）';
    const start = zhDate(query.start, true);
    const end = zhDate(query.end, true);
    return start === end ? start! : `${start}—${end}`;
  }
  // An export's wall clock cannot establish which period a snapshot describes.
  if (!context) return '统计期间未提供';
  const [year, month, day] = context.cutoffDate.split('-').map(Number);
  if (range === 'today') return `${month}月${day}日`;
  if (range === 'year') return `${year} 年`;
  if (range === 'all') return `截至 ${year}年${month}月${day}日`;
  const startDay = range === 'week' ? isoWeekStart(context.cutoffDate) : `${context.cutoffDate.slice(0, 7)}-01`;
  const start = startDay ? zhDate(startDay, true) : null;
  const end = zhDate(context.cutoffDate, true);
  return start && end ? (start === end ? end : `${start}—${end}`) : '统计期间未提供';
}

function civilDayInTimeZone(value: string, timezone: string): string | null {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return parseIsoDay(value);
  const parts = localizedDateParts(value, timezone);
  if (!parts) return null;
  const [year, month, day] = parts;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isoWeekStart(cutoffDate: string): string | null {
  const parts = cutoffDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (weekday - 1));
  return date.toISOString().slice(0, 10);
}

function activeIsoDays(
  stats: StatsData,
  range: RangeKey,
  context: InsightTimeContext,
): Array<[string, number]> {
  const allDays: Array<[string, number]> = [];
  Object.entries(stats.heatmap || {}).forEach(([date, tokens]) => {
    const day = trendBucketKind(date) === 'day' ? date : null;
    if (day && day <= context.cutoffDate && finite(tokens) && tokens > 0) allDays.push([day, tokens]);
  });
  allDays.sort(([left], [right]) => left.localeCompare(right));

  if (range === 'all') return allDays;

  const [targetYear, targetMonth] = context.cutoffDate.split('-');
  const yearPrefix = `${targetYear}-`;
  const monthPrefix = `${targetYear}-${targetMonth}-`;

  if (range === 'year') {
    return allDays.filter(([day]) => day.startsWith(yearPrefix));
  }

  if (range === 'month') {
    // If comparison series is present and matches monthOverMonth, prefer points or filter heatmap by current month
    const monthDays = allDays.filter(([day]) => day.startsWith(monthPrefix));
    return monthDays;
  }

  if (range === 'custom') {
    // The heatmap may include historical dates; only an explicit window bounds this range.
    const comparison = stats.comparison;
    if (comparison?.window.kind === 'periodOverPeriod' && comparison.window.currentStart && comparison.window.currentEnd) {
      const startDay = civilDayInTimeZone(comparison.window.currentStart, context.timeZone);
      const endDay = civilDayInTimeZone(comparison.window.currentEnd, context.timeZone);
      if (startDay && endDay) {
        return allDays.filter(([day]) => day >= startDay && day <= endDay && day <= context.cutoffDate);
      }
    }
    const query = customQueryWindow(stats);
    return query ? allDays.filter(([day]) => day >= query.start && day <= query.end) : [];
  }

  if (range === 'week') {
    const comparison = stats.comparison;
    if (comparison?.window.kind === 'weekOverWeek' && comparison.window.currentStart && comparison.window.currentEnd) {
      const startDay = civilDayInTimeZone(comparison.window.currentStart, context.timeZone);
      const endDay = civilDayInTimeZone(comparison.window.currentEnd, context.timeZone);
      if (startDay && endDay) {
        return allDays.filter(([day]) => day >= startDay && day <= endDay && day <= context.cutoffDate);
      }
    }
    const startDay = isoWeekStart(context.cutoffDate);
    return startDay
      ? allDays.filter(([day]) => day >= startDay && day <= context.cutoffDate)
      : [];
  }

  return allDays;
}

function longestStreak(days: ReadonlyArray<readonly [string, number]>): number | null {
  const unique = [...new Set(days.map(([day]) => day))].sort();
  if (unique.length === 0) return null;
  let best = 1;
  let current = 1;
  for (let index = 1; index < unique.length; index += 1) {
    const previous = localDateFromIso(unique[index - 1]);
    const next = localDateFromIso(unique[index]);
    if (previous && next && Math.round((next.getTime() - previous.getTime()) / 86_400_000) === 1) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 1;
    }
  }
  return best;
}

function currentSeries(
  stats: StatsData,
  range: RangeKey,
  context: InsightTimeContext | null,
): ShareSeriesPoint[] {
  if (!context) return [];
  const comparison = stats.comparison;
  const expected = EXPECTED_COMPARISON[range];
  const comparisonSeries = expected && comparison?.window.kind === expected
    ? comparison.current.series
    : [];
  const source: Array<{ bucket: string; tokens: number; requests?: number }> = range === 'today' && comparisonSeries.length === 0
    ? stats.trends.filter((point) => {
        const values = Object.entries(point).filter(([key]) => key !== 'date' && !key.startsWith('__')).map(([, value]) => value);
        return values.length > 0 && values.every(knownNonNegative);
      }).map((point) => ({ bucket: point.date, tokens: trendBucketTokens(point), requests: undefined }))
    : comparisonSeries;
  return source
    .filter((point) => typeof point.bucket === 'string' && finite(point.tokens) && point.tokens >= 0)
    .filter((point) => {
      const kind = trendBucketKind(point.bucket);
      if (kind === 'day' && expected && comparison?.window.kind === expected) {
        const start = civilDayInTimeZone(comparison.window.currentStart, context.timeZone);
        const end = civilDayInTimeZone(comparison.window.currentEnd, context.timeZone);
        if (!start || !end || point.bucket < start || point.bucket > end) return false;
      }
      if (range === 'today') return kind === 'hour' && Number(point.bucket.slice(0, 2)) <= context.cutoffHour;
      if (range === 'custom') {
        return (kind === 'day' && point.bucket <= context.cutoffDate)
          || (kind === 'hour' && Number(point.bucket.slice(0, 2)) <= context.cutoffHour);
      }
      if (range === 'week' || range === 'month' || range === 'all') {
        return kind === 'day' && point.bucket <= context.cutoffDate;
      }
      if (range === 'year') {
        return kind === 'month' && point.bucket <= context.cutoffDate.slice(0, 7);
      }
      return false;
    })
    .map((point) => ({
      label: point.bucket,
      tokens: point.tokens,
      requests: finite(point.requests) && point.requests >= 0 ? point.requests : undefined,
    }));
}

/**
 * Ranks values by token usage and attaches the leader's share of
 * `effectiveTokens` as a percentage. Exported (T10.169) so tests can probe
 * the rounding/clamping boundary and the null-on-unknown contract directly,
 * without needing to route contrived edge cases through `buildShareSummary`.
 */
export function rankItems<T extends { name: string }>(
  values: T[],
  tokensFor: (value: T) => number,
  effectiveTokens: number,
): ShareRankedItem | null {
  const ranked = values
    .map((value) => ({ name: value.name, tokens: tokensFor(value) }))
    .filter((value) => typeof value.name === 'string' && value.name.trim().length > 0 && finite(value.tokens) && value.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
  const first = ranked[0];
  if (!first) return null;
  // T10.169 fix: round the ratio to one decimal place first, THEN clamp to
  // 100. The previous order clamped the per-mille value to 100 before
  // dividing by 10, so any leader holding 10% or more of effective tokens —
  // right up to a genuine 100% — collapsed to a flat "占 10%". A value just
  // under 100 must stay under 100 unless rounding genuinely lands it there.
  // Non-finite inputs or a non-positive denominator must read as unknown
  // (null), never as a fabricated 0%/100% (GLB-01).
  const canShare = finite(effectiveTokens) && effectiveTokens > 0 && finite(first.tokens);
  return {
    ...first,
    sharePercent: canShare ? Math.min(100, Math.round((first.tokens / effectiveTokens) * 1000) / 10) : null,
  };
}

function deltaFor(stats: StatsData, range: RangeKey, scope: DataScope): Pick<ShareSummary, 'deltaPercent' | 'deltaDirection'> {
  const comparison = stats.comparison;
  const expected = EXPECTED_COMPARISON[range];
  if (!expected || comparison?.window.kind !== expected) {
    return { deltaPercent: null, deltaDirection: null };
  }
  if (scope === 'cloud' && comparison.previous.summary.totalRequests === 0
    && comparison.previous.summary.totalTokens === 0) {
    return { deltaPercent: null, deltaDirection: null };
  }
  const metric = comparison.delta.tokens;
  if (!finite(metric.percent) || !['up', 'down', 'flat'].includes(metric.direction)) {
    return { deltaPercent: null, deltaDirection: metric.direction === 'new' ? 'new' : null };
  }
  return { deltaPercent: Math.abs(Math.round(metric.percent * 10) / 10), deltaDirection: metric.direction };
}

function buildInsight(summary: Omit<ShareSummary, 'insight'>): string {
  if (summary.effectiveTokens <= 0) return '这段时间还没有可分享的协作记录';
  if (summary.range === 'today') {
    if (summary.peak) return `今天的协作峰值出现在 ${summary.peak.label}`;
    return `今天完成了 ${summary.totalRequests.toLocaleString('zh-CN')} 条 AI 协作记录`;
  }
  if (summary.range === 'week') {
    if (summary.activeDays !== null && summary.activeDays > 0) return `这周，我和 AI 并肩作战了 ${summary.activeDays} 天`;
    if (summary.peak) return `本周高光出现在 ${summary.peak.label}`;
  }
  if (summary.range === 'month') {
    if (summary.longestStreakDays !== null && summary.longestStreakDays > 3) {
      return `本月最长连续协作 ${summary.longestStreakDays} 天`;
    }
    if (summary.activeDays !== null && summary.activeDays > 0) {
      return `本月已经留下 ${summary.activeDays} 个协作日`;
    }
  }
  if (summary.range === 'year') {
    if (summary.longestStreakDays !== null && summary.longestStreakDays > 1) return `今年最长连续协作 ${summary.longestStreakDays} 天`;
    if (summary.activeDays !== null && summary.activeDays > 0) return `今年记录了 ${summary.activeDays} 个协作日`;
  }
  if (summary.range === 'all') {
    if (summary.longestStreakDays !== null && summary.longestStreakDays > 1) return `最长连续协作记录达 ${summary.longestStreakDays} 天`;
    return '每一次输入与输出，都是长期协作的刻度';
  }
  if (summary.range === 'custom') {
    if (summary.longestStreakDays !== null && summary.longestStreakDays > 3) {
      return `这段区间最长连续协作 ${summary.longestStreakDays} 天`;
    }
    if (summary.activeDays !== null && summary.activeDays > 0) {
      return `这段区间里，我和 AI 协作了 ${summary.activeDays} 天`;
    }
  }
  return '每一次输入与输出，都是协作的刻度';
}

/** 「隐藏费用」开启时的状态与边界说明（T10.154 §1、D57）。 */
export const COSTS_HIDDEN_NOTE = '费用已隐藏';

export function buildShareSummary({ stats, range, scope, hideCosts = true }: BuildShareSummaryOptions): ShareSummary {
  const inputTokens = requireTokenCount(stats.summary?.inputTokens);
  const outputTokens = requireTokenCount(stats.summary?.outputTokens);
  const effectiveTokens = requireTokenCount(inputTokens + outputTokens);
  const cachedTokens = requireTokenCount(stats.summary?.cachedTokens);
  const cache = resolveCacheBreakdown(stats.summary);
  const cacheReadTokens = cache.kind === 'split' ? cache.read : null;
  const cacheWriteTokens = cache.kind === 'split' ? cache.write : null;
  const cacheReuseBase = inputTokens + (cacheReadTokens ?? 0);
  const cacheReusePercent = cache.kind === 'split' && cacheReuseBase > 0
    ? Math.round(((cacheReadTokens ?? 0) / cacheReuseBase) * 1000) / 10
    : null;
  const totalRequests = requireTokenCount(stats.summary.totalRequests);
  const averageTokensPerRequest = totalRequests > 0 ? Math.round(effectiveTokens / totalRequests) : null;
  const matchingComparison = EXPECTED_COMPARISON[range] === stats.comparison?.window.kind ? stats.comparison : null;
  const timeContext = deriveInsightTimeContext({ meta: stats.meta, comparison: matchingComparison }, range, scope);
  const days = timeContext ? activeIsoDays(stats, range, timeContext) : null;
  const series = currentSeries(stats, range, timeContext);
  const fallbackDays = range === 'today' ? [] : (days ?? []);
  const peak = (series.length > 0 ? series : fallbackDays.map(([label, tokens]) => ({ label, tokens })))
    .reduce<ShareSeriesPoint | null>((current, point) => (
      point.tokens > 0 && (!current || point.tokens > current.tokens) ? point : current
    ), null);
  const activeDays = !timeContext
    ? null
    : range === 'today'
    ? (effectiveTokens > 0 ? 1 : 0)
    : !days || days.length === 0
      ? null
      : new Set(days.map(([day]) => day)).size;
  const dailyAverageTokens = ((range === 'month' || range === 'custom') && activeDays) ? Math.round(effectiveTokens / activeDays) : null;
  const notes: string[] = [];
  if (stats.meta?.stale) notes.push('数据为缓存快照');
  if (cache.kind !== 'split') notes.push('缓存读写未拆分');
  if (hideCosts) notes.push(COSTS_HIDDEN_NOTE);
  const delta = timeContext ? deltaFor(stats, range, scope) : { deltaPercent: null, deltaDirection: null };
  const netSavings = !hideCosts ? parseCacheSavings(stats.summary.cacheSavings, stats.summary) : null;

  const withoutInsight: Omit<ShareSummary, 'insight'> = {
    range,
    scope,
    title: RANGE_TITLE[range],
    periodLabel: periodLabel(range, stats, timeContext),
    sourceLabel: scope === 'cloud' ? '数据来自已同步账本' : '数据来自本机账本',
    generatedLabel: timeContext
      ? timeContext.cutoffDate.replace(/-/g, '.')
      : '生成时间未提供',
    isStale: Boolean(stats.meta?.stale),
    effectiveTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheReusePercent,
    totalRequests,
    averageTokensPerRequest,
    activeDays,
    longestStreakDays: days && days.length > 0 ? longestStreak(days) : null,
    dailyAverageTokens,
    ...delta,
    peak,
    series,
    topTool: rankItems(Object.values(stats.tools || {}), effectiveItemTokens, effectiveTokens),
    // Missing input/output is unknown, never a guessed partial value or cache-inclusive total.
    topModel: rankItems(Object.values(stats.models || {}), effectiveItemTokens, effectiveTokens),
    totalCostUsd: !hideCosts && knownNonNegative(stats.summary.totalCost) ? stats.summary.totalCost : null,
    cacheNetSavedUsd: netSavings && netSavings.netSavedUsd > 0
      && netSavings.fallbackPricedReadTokens === 0 && netSavings.fallbackPricedWriteTokens === 0
      ? netSavings.netSavedUsd : null,
    costsHidden: hideCosts,
    boundaryNotes: notes,
  };

  return { ...withoutInsight, insight: buildInsight(withoutInsight) };
}
