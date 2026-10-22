import type {
  CacheSavings,
  CacheSavingsPriceBasis,
  ComparisonDeltaMetric,
  ComparisonSeriesPoint,
  DailyCost,
  DailyCosts,
  DailyCostUnavailableReason,
  EntitySelector,
  StatsData,
  StatsQueryContext,
  UsageComparison,
  UsageDetailsResponse,
} from '../../types';
import { isRecord } from './internal';

type GenerationRef = { current: number };

export interface DerivedTrendAverage extends ComparisonDeltaMetric {
  unit: UsageComparison['window']['bucket'];
  bucketCount: number;
  current: number;
  previous: number;
}

export interface DerivedTrendPeakPoint {
  bucket: string;
  index: number;
  tokens: number;
}

export interface DerivedTrendPeakShift {
  current: DerivedTrendPeakPoint;
  previous: DerivedTrendPeakPoint;
  movement: 'earlier' | 'later' | 'same';
  offsetBuckets: number;
}

export interface DerivedTrendComparison {
  average: DerivedTrendAverage | null;
  peak: DerivedTrendPeakShift | null;
}

function validComparisonSeries(series: readonly ComparisonSeriesPoint[]): boolean {
  return series.every((point) => (
    typeof point.bucket === 'string'
    && point.bucket.length > 0
    && Number.isFinite(point.tokens)
    && point.tokens >= 0
  ));
}

function peakPoint(series: readonly ComparisonSeriesPoint[]): DerivedTrendPeakPoint {
  let peakIndex = 0;
  for (let index = 1; index < series.length; index += 1) {
    // Keep the earliest bucket when multiple buckets share the same maximum.
    if (series[index].tokens > series[peakIndex].tokens) peakIndex = index;
  }
  return {
    bucket: series[peakIndex].bucket,
    index: peakIndex,
    tokens: series[peakIndex].tokens,
  };
}

/**
 * Derive equal-progress insights without extending or guessing the backend
 * contract. Missing, invalid, or mismatched series deliberately return null.
 */
export function deriveTrendComparison(
  comparison: Pick<UsageComparison, 'window' | 'current' | 'previous'>,
): DerivedTrendComparison {
  const currentSeries = comparison.current.series;
  const previousSeries = comparison.previous.series;
  if (
    currentSeries.length === 0
    || currentSeries.length !== previousSeries.length
    || !validComparisonSeries(currentSeries)
    || !validComparisonSeries(previousSeries)
  ) {
    return { average: null, peak: null };
  }

  const bucketCount = currentSeries.length;
  const current = currentSeries.reduce((total, point) => total + point.tokens, 0) / bucketCount;
  const previous = previousSeries.reduce((total, point) => total + point.tokens, 0) / bucketCount;
  const rawAbsolute = current - previous;
  const absolute = Math.abs(rawAbsolute) < Number.EPSILON ? 0 : rawAbsolute;
  const direction: ComparisonDeltaMetric['direction'] = previous === 0 && current > 0
    ? 'new'
    : absolute === 0
      ? 'flat'
      : absolute > 0
        ? 'up'
        : 'down';
  const average: DerivedTrendAverage = {
    unit: comparison.window.bucket,
    bucketCount,
    current,
    previous,
    absolute,
    percent: previous === 0 ? null : (absolute / previous) * 100,
    direction,
  };

  const currentPeak = peakPoint(currentSeries);
  const previousPeak = peakPoint(previousSeries);
  // A zero-only period has no meaningful peak position to compare.
  if (currentPeak.tokens === 0 || previousPeak.tokens === 0) {
    return { average, peak: null };
  }
  const offsetBuckets = currentPeak.index - previousPeak.index;
  return {
    average,
    peak: {
      current: currentPeak,
      previous: previousPeak,
      movement: offsetBuckets < 0 ? 'earlier' : offsetBuckets > 0 ? 'later' : 'same',
      offsetBuckets,
    },
  };
}

export function describeTrendPeakShift(
  peak: DerivedTrendPeakShift | null,
  bucket: UsageComparison['window']['bucket'],
): string {
  if (!peak) return '';
  const position = (point: DerivedTrendPeakPoint) => (
    bucket === 'hour' ? point.bucket : `周期第${point.index + 1}日`
  );
  const currentPosition = position(peak.current);
  const previousPosition = position(peak.previous);
  if (peak.movement === 'same') {
    return bucket === 'hour'
      ? `峰值时段保持在${currentPosition}`
      : `峰值位置保持在${currentPosition}`;
  }
  return `峰值从${previousPosition}${peak.movement === 'earlier' ? '提前' : '延后'}到${currentPosition}`;
}

const REQUIRED_SUMMARY_FIELDS = [
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'totalCost',
  'totalRequests',
  'avgTokensPerReq',
] as const;


const QUERY_ARRAY_LIMIT = 32;
const QUERY_VALUE_UTF8_LIMIT = 256;
const ASCII_EDGE_WHITESPACE = /^[\u0009\u000a\u000d\u0020]+|[\u0009\u000a\u000d\u0020]+$/g;
const QUERY_RANGES = new Set(['today', 'week', 'month', 'year', 'all', 'custom']);
const ISO_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 与 Rust `MAX_CUSTOM_RANGE_DAYS` 一致：日桶轴最多 731 个，够复盘一整年并对比上一年。 */
export const MAX_CUSTOM_RANGE_DAYS = 731;
const utf8Encoder = new TextEncoder();

/** `YYYY-MM-DD` 且是真实存在的公历日期时返回其 UTC 零点毫秒数，否则 null。 */
export function isoCalendarDayValue(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DAY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const probe = new Date(time);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return time;
}

/** 闭区间天数（两端都算）；任一端无效或 end 早于 start 时返回 null。 */
export function customRangeSpanDays(start: unknown, end: unknown): number | null {
  const startValue = isoCalendarDayValue(start);
  const endValue = isoCalendarDayValue(end);
  if (startValue === null || endValue === null || endValue < startValue) return null;
  return Math.round((endValue - startValue) / 86_400_000) + 1;
}

function normalizeCustomBounds(value: Record<string, unknown>): { start: string; end: string } {
  const start = typeof value.start === 'string' ? trimAsciiQueryEdges(value.start) : '';
  const end = typeof value.end === 'string' ? trimAsciiQueryEdges(value.end) : '';
  if (!start || !end) queryFailure('invalid-custom-range', '自定义范围需要开始与结束日期');
  if (isoCalendarDayValue(start) === null || isoCalendarDayValue(end) === null) {
    queryFailure('invalid-custom-range', '自定义范围日期必须是有效的 YYYY-MM-DD');
  }
  const span = customRangeSpanDays(start, end);
  if (span === null) queryFailure('invalid-custom-range', '自定义范围的结束日期不能早于开始日期');
  if (span > MAX_CUSTOM_RANGE_DAYS) {
    queryFailure('invalid-custom-range', `自定义范围最多 ${MAX_CUSTOM_RANGE_DAYS} 天`);
  }
  return { start, end };
}

export class QueryContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'QueryContractError';
  }
}

function queryFailure(code: string, message: string): never {
  throw new QueryContractError(code, message);
}

function trimAsciiQueryEdges(value: string): string {
  return value.replace(ASCII_EDGE_WHITESPACE, '');
}

function compareUnsignedUtf8(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const commonLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function normalizeQueryValue(value: unknown, dimension: 'machine' | 'tool' | 'model' | 'entity'): string {
  if (typeof value !== 'string') queryFailure('invalid-item-type', `${dimension} 筛选项必须是字符串`);
  const normalized = trimAsciiQueryEdges(value);
  if (!normalized) queryFailure('empty-item', `${dimension} 筛选项不能为空`);
  if (utf8Encoder.encode(normalized).length > QUERY_VALUE_UTF8_LIMIT) {
    queryFailure('item-too-long', `${dimension} 筛选项超过 UTF-8 长度限制`);
  }
  return normalized;
}

function normalizeQueryArray(value: unknown, dimension: 'machine' | 'tool' | 'model'): string[] {
  if (!Array.isArray(value)) queryFailure('invalid-array-type', `${dimension} 筛选必须是数组`);
  if (value.length > QUERY_ARRAY_LIMIT) queryFailure('too-many-items', `${dimension} 筛选项超过数量限制`);
  const normalized = value.map((item) => normalizeQueryValue(item, dimension));
  if (dimension === 'machine' && normalized.some((item) => item === 'all' || item === 'all_cloud')) {
    queryFailure('illegal-machine-sentinel', 'machines[] 不能包含旧版全部设备哨兵');
  }
  return [...new Set(normalized)].sort(compareUnsignedUtf8);
}

function normalizeLegacySingle(value: unknown, dimension: 'machine' | 'tool' | 'model'): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string') queryFailure('invalid-item-type', `${dimension} 兼容筛选项必须是字符串或 null`);
  const trimmed = trimAsciiQueryEdges(value);
  if (!trimmed) return [];
  if (dimension === 'machine' && (trimmed === 'all' || trimmed === 'all_cloud')) return [];
  return [normalizeQueryValue(trimmed, dimension)];
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeDimension(
  input: Record<string, unknown>,
  plural: 'machines' | 'tools' | 'models',
  singular: 'machine' | 'tool' | 'model',
): string[] {
  const hasPlural = Object.prototype.hasOwnProperty.call(input, plural) && input[plural] !== undefined;
  const hasSingular = Object.prototype.hasOwnProperty.call(input, singular) && input[singular] !== undefined;
  const dimension = singular;
  const pluralValues = hasPlural ? normalizeQueryArray(input[plural], dimension) : null;
  const singularValues = hasSingular ? normalizeLegacySingle(input[singular], dimension) : null;
  if (pluralValues && singularValues && !sameStringArray(pluralValues, singularValues)) {
    queryFailure('singular-plural-conflict', `${plural} 与 ${singular} 不一致`);
  }
  return pluralValues ?? singularValues ?? [];
}

/**
 * Canonicalize the shared desktop/native/cloud query boundary. This accepts
 * singular aliases only for backwards-compatible readers; new producers use
 * the plural fields returned here.
 */
export function normalizeStatsQuery(value: unknown): StatsQueryContext {
  if (!isRecord(value)) queryFailure('invalid-query-type', '查询上下文必须是对象');
  if (typeof value.range !== 'string' || !QUERY_RANGES.has(value.range)) {
    queryFailure('invalid-range', '查询范围无效');
  }
  if (typeof value.timezone !== 'string' || !trimAsciiQueryEdges(value.timezone)) {
    queryFailure('invalid-timezone', '查询时区不能为空');
  }
  const tokenMode = value.tokenMode ?? 'effective';
  if (tokenMode !== 'effective') queryFailure('invalid-token-mode', '当前只支持 effective Token 口径');
  let search: string | null = null;
  if (value.search !== undefined && value.search !== null) {
    if (typeof value.search !== 'string') queryFailure('invalid-search-type', 'search 必须是字符串或 null');
    const normalizedSearch = trimAsciiQueryEdges(value.search);
    if (normalizedSearch) {
      if (utf8Encoder.encode(normalizedSearch).length > QUERY_VALUE_UTF8_LIMIT) {
        queryFailure('search-too-long', 'search 超过 UTF-8 长度限制');
      }
      search = normalizedSearch;
    }
  }
  // 自定义区间的日期是查询身份的一部分：进入 canonical 上下文、statsQueryKey 与 echo 比对；
  // 预设范围即使带了 start/end 也一律丢弃，避免同一预设生成两个缓存键。
  const customBounds = value.range === 'custom' ? normalizeCustomBounds(value) : null;
  return {
    range: value.range as StatsQueryContext['range'],
    timezone: trimAsciiQueryEdges(value.timezone),
    machines: normalizeDimension(value, 'machines', 'machine'),
    tools: normalizeDimension(value, 'tools', 'tool'),
    models: normalizeDimension(value, 'models', 'model'),
    search,
    tokenMode: 'effective',
    ...(customBounds ?? {}),
  };
}

export function normalizeEntitySelector(value: unknown): EntitySelector {
  if (!isRecord(value) || (value.kind !== 'tool' && value.kind !== 'model')) {
    queryFailure('invalid-entity-kind', '实体 kind 必须是 tool 或 model');
  }
  return { kind: value.kind, id: normalizeQueryValue(value.id, 'entity') };
}

export function statsQueryKey(query: StatsQueryContext, entity?: EntitySelector): string {
  return JSON.stringify(entity ? { query, entity } : { query });
}

export function queryEchoMatches(
  echo: unknown,
  expectedQuery: StatsQueryContext,
  echoEntity?: unknown,
  expectedEntity?: EntitySelector,
): boolean {
  try {
    const normalizedEcho = normalizeStatsQuery(echo);
    if (statsQueryKey(normalizedEcho) !== statsQueryKey(expectedQuery)) return false;
    if (!expectedEntity) return echoEntity === undefined || echoEntity === null;
    return statsQueryKey(normalizedEcho, normalizeEntitySelector(echoEntity))
      === statsQueryKey(expectedQuery, expectedEntity);
  } catch {
    return false;
  }
}

export interface EntityContextFilters {
  tools: string[];
  models: string[];
  machines: string[];
  search: string;
}

/**
 * Bind an explicit row/composition tool to a model drill-down. Keeping a
 * broader inherited tool array while showing one tool in the title would make
 * the visible entity identity disagree with the actual query.
 */
export function filtersForEntityDrilldown(
  filters: EntityContextFilters,
  kind: EntitySelector['kind'],
  explicitTool?: string,
): EntityContextFilters {
  const next: EntityContextFilters = {
    tools: [...filters.tools],
    models: [...filters.models],
    machines: [...filters.machines],
    search: filters.search,
  };
  if (kind === 'tool') {
    next.tools = [];
  } else {
    next.models = [];
    if (explicitTool) next.tools = [explicitTool];
  }
  return next;
}

/** Local scope has no header device control, so cloud-only device state must
 * never become a hidden local query filter. */
export function scopeMachineSelection(
  scope: 'local' | 'cloud',
  deviceFilter: string,
): { deviceFilter: string; machines: string[] } {
  const active = scope === 'cloud' && deviceFilter !== 'all_cloud'
    ? deviceFilter
    : 'all_cloud';
  return {
    deviceFilter: active,
    machines: active === 'all_cloud' ? [] : [active],
  };
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

export function matchesLiteralQuerySearch(search: string | null, candidates: readonly string[]): boolean {
  if (!search) return true;
  if (/^[\x00-\x7f]*$/.test(search)) {
    const needle = foldAsciiCase(search);
    return candidates.some((candidate) => foldAsciiCase(candidate).includes(needle));
  }
  return candidates.some((candidate) => candidate.includes(search));
}

const DAILY_COST_REASONS = new Set<DailyCostUnavailableReason>([
  'incomplete-coverage', 'missing-cost', 'invalid-cost', 'legacy-zero',
]);

/** Offset timestamps are converted; legacy local timestamps already use the declared zone. */
function dailyCostCutoffDate(value: unknown, timezone: string): string | null {
  if (typeof value !== 'string') return null;
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value);
  if (local) {
    return isoCalendarDayValue(local[1]) !== null
      && Number(local[2]) < 24 && Number(local[3]) < 60 && Number(local[4]) < 60 ? local[1] : null;
  }
  const zoned = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!zoned || isoCalendarDayValue(zoned[1]) === null
    || Number(zoned[2]) >= 24 || Number(zoned[3]) >= 60 || Number(zoned[4]) >= 60) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  return isoCalendarDayValue(date) === null ? null : date;
}

/** Invalid optional envelopes are discarded as a unit; the old core remains usable. */
function parseDailyCosts(value: unknown, stats: StatsData): DailyCosts | null {
  if (!isRecord(value) || !isRecord(value.coverage) || !Array.isArray(value.days)) return null;
  const coverage = value.coverage;
  const query = stats.meta?.query;
  if (!query || typeof coverage.timezone !== 'string'
    || coverage.timezone !== stats.meta?.timezone || coverage.timezone !== query.timezone
    || isoCalendarDayValue(coverage.end) === null
    || (coverage.start !== null && isoCalendarDayValue(coverage.start) === null)
    || (coverage.state !== 'complete' && coverage.state !== 'partial')) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: coverage.timezone }); } catch { return null; }
  const window = isRecord(stats.comparison) && isRecord(stats.comparison.window) ? stats.comparison.window : null;
  if (window?.timezone !== undefined && window.timezone !== coverage.timezone) return null;
  const cutoff = dailyCostCutoffDate(window?.currentEnd ?? stats.meta?.generatedAt, coverage.timezone);
  if (!cutoff) return null;
  const expectedEnd = query.range === 'custom' && query.end && query.end < cutoff ? query.end : cutoff;
  const day = new Date(isoCalendarDayValue(expectedEnd)!);
  let expectedStart: string | null;
  switch (query.range) {
    case 'all': expectedStart = null; break;
    case 'custom': expectedStart = query.start!; break;
    case 'today': expectedStart = expectedEnd; break;
    case 'week':
      day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
      expectedStart = day.toISOString().slice(0, 10); break;
    case 'month': expectedStart = `${expectedEnd.slice(0, 7)}-01`; break;
    case 'year': expectedStart = `${expectedEnd.slice(0, 4)}-01-01`; break;
  }
  if (coverage.start !== expectedStart || coverage.end !== expectedEnd
    || (expectedStart !== null && expectedStart > expectedEnd)) return null;

  const days: DailyCost[] = [];
  let previous = '';
  for (const item of value.days) {
    if (!isRecord(item) || typeof item.date !== 'string' || isoCalendarDayValue(item.date) === null
      || item.date <= previous || item.date > expectedEnd
      || (expectedStart !== null && item.date < expectedStart)) return null;
    previous = item.date;
    if (item.status === 'recorded-estimate') {
      if (coverage.state !== 'complete' || typeof item.amountUsd !== 'number'
        || !Number.isFinite(item.amountUsd) || item.amountUsd <= 0 || 'reason' in item) return null;
      days.push({ date: item.date, amountUsd: item.amountUsd, status: 'recorded-estimate' });
    } else if (item.status === 'unavailable') {
      if (item.amountUsd !== null || !DAILY_COST_REASONS.has(item.reason as DailyCostUnavailableReason)
        || (coverage.state === 'partial' && item.reason !== 'incomplete-coverage')) return null;
      days.push({ date: item.date, amountUsd: null, status: 'unavailable', reason: item.reason as DailyCostUnavailableReason });
    } else return null;
  }
  return { coverage: { start: expectedStart, end: expectedEnd, timezone: coverage.timezone, state: coverage.state }, days };
}

const CACHE_SAVINGS_PRICE_BASES = new Set<CacheSavingsPriceBasis>(['local-prices', 'uploaded-prices']);

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `summary.cacheSavings` — contract dashboard-stats-v2 §2.4 (T10.183). The object
 * is only meaningful next to a proven read/write split of the same summary, so
 * any broken rule drops it as a unit: the range then reads as unavailable,
 * never as a partial object or 0, and the summary core stays usable.
 */
export function parseCacheSavings(value: unknown, summary: unknown): CacheSavings | null {
  if (!isRecord(value) || !isRecord(summary)) return null;
  const { readSavedUsd, writePremiumUsd, netSavedUsd, priceBasis } = value;
  const { fallbackPricedReadTokens, fallbackPricedWriteTokens } = value;
  const { cachedTokens, cacheReadTokens, cacheWriteTokens, cacheSavedUsd } = summary;
  if (!finiteNonNegative(readSavedUsd) || !finiteNonNegative(writePremiumUsd)
    || typeof netSavedUsd !== 'number' || !Number.isFinite(netSavedUsd)) return null;
  // Producers subtract at full precision; the tolerance only absorbs float noise.
  const tolerance = 1e-6 * Math.max(1, readSavedUsd + writePremiumUsd);
  if (Math.abs(netSavedUsd - (readSavedUsd - writePremiumUsd)) > tolerance) return null;
  if (!tokenCount(cachedTokens) || !tokenCount(cacheReadTokens) || !tokenCount(cacheWriteTokens)
    || cacheReadTokens + cacheWriteTokens !== cachedTokens) return null;
  if (!tokenCount(fallbackPricedReadTokens) || fallbackPricedReadTokens > cacheReadTokens
    || !tokenCount(fallbackPricedWriteTokens) || fallbackPricedWriteTokens > cacheWriteTokens) return null;
  if (!CACHE_SAVINGS_PRICE_BASES.has(priceBasis as CacheSavingsPriceBasis)) return null;
  // The legacy gross field, when present, is the same read savings.
  if (cacheSavedUsd !== undefined && cacheSavedUsd !== null
    && (typeof cacheSavedUsd !== 'number' || !Number.isFinite(cacheSavedUsd)
      || Math.abs(cacheSavedUsd - readSavedUsd) > tolerance)) return null;
  return {
    readSavedUsd,
    writePremiumUsd,
    netSavedUsd,
    fallbackPricedReadTokens,
    fallbackPricedWriteTokens,
    priceBasis: priceBasis as CacheSavingsPriceBasis,
  };
}

/**
 * Validates `cacheSavings` on one summary-shaped object without mutating it:
 * a valid object is replaced by its clean copy, an invalid one is removed.
 * Stats responses go through this in `parseStatsDataContract`; details and
 * entity dashboards must call it before rendering the object.
 */
export function sanitizeSummaryCacheSavings<T>(summary: T): T {
  if (!isRecord(summary) || !('cacheSavings' in summary)) return summary;
  const cacheSavings = parseCacheSavings(summary.cacheSavings, summary);
  const result: Record<string, unknown> = { ...summary };
  if (cacheSavings) result.cacheSavings = cacheSavings;
  else delete result.cacheSavings;
  return result as T;
}

function withSanitizedSummaryAt<T>(holder: T, key: string): T {
  if (!isRecord(holder) || !isRecord(holder[key])) return holder;
  const summary = sanitizeSummaryCacheSavings(holder[key]);
  return summary === holder[key] ? holder : { ...holder, [key]: summary } as T;
}

/** Every summary a stats response carries: overview, both comparison periods, first details page. */
function withParsedCacheSavings(stats: StatsData): StatsData {
  let result = withSanitizedSummaryAt(stats, 'summary');
  const comparison = result.comparison;
  if (isRecord(comparison)) {
    const current = withSanitizedSummaryAt(comparison.current, 'summary');
    const previous = withSanitizedSummaryAt(comparison.previous, 'summary');
    if (current !== comparison.current || previous !== comparison.previous) {
      result = { ...result, comparison: { ...comparison, current, previous } };
    }
  }
  const historyPage = withSanitizedSummaryAt(result.historyPage, 'filteredSummary');
  return historyPage === result.historyPage ? result : { ...result, historyPage };
}

/**
 * Validate the runtime boundary before a native/cloud payload reaches React.
 * Optional v2 and additive fields remain forward compatible; malformed v1
 * core fields fail closed instead of crashing a metric component or becoming 0.
 */
export function parseStatsDataContract(value: unknown): StatsData {
  if (!isRecord(value)) throw new Error('统计数据契约必须是对象');
  const summary = value.summary;
  if (!isRecord(summary)) throw new Error('统计数据契约缺少 summary');
  for (const field of REQUIRED_SUMMARY_FIELDS) {
    const metric = summary[field];
    if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) {
      throw new Error(`统计数据契约的 summary.${field} 无效`);
    }
  }
  if (
    !isRecord(value.tools)
    || !isRecord(value.models)
    || !Array.isArray(value.trends)
    || !isRecord(value.heatmap)
    || !Array.isArray(value.history)
  ) {
    throw new Error('统计数据契约缺少 v1 核心集合');
  }
  // tools/models 逐条目的 input、output 存在时必须是有限非负数；否则整条响应判为 malformed，
  // 遵循 dashboard-stats-v2.md 对必填数值字段"缺失或非有限数值属于 malformed 响应"的原则
  // （此前只落实到 summary，未落实到逐条 tools/models，T10.169 复核 P2；T10.180 补齐）。
  for (const collectionName of ['tools', 'models'] as const) {
    const collection = value[collectionName] as Record<string, unknown>;
    for (const [key, entry] of Object.entries(collection)) {
      if (!isRecord(entry)) throw new Error(`统计数据契约的 ${collectionName}.${key} 不是对象`);
      for (const field of ['input', 'output'] as const) {
        const metric = entry[field];
        if (metric !== undefined && (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0)) {
          throw new Error(`统计数据契约的 ${collectionName}.${key}.${field} 无效`);
        }
      }
    }
  }
  if (value.machineDistribution !== undefined) {
    const distribution = value.machineDistribution;
    const valid = Array.isArray(distribution) && distribution.every((item) => {
      if (
        !isRecord(item)
        || typeof item.value !== 'string'
        || item.value.length === 0
      ) {
        return false;
      }
      for (const field of ['tokens', 'requests', 'cost'] as const) {
        const metric = item[field];
        if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) {
          return false;
        }
      }
      for (const field of ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens'] as const) {
        const metric = item[field];
        if (
          metric !== undefined
          && (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0)
        ) {
          return false;
        }
      }
      return true;
    });
    if (!valid) throw new Error('统计数据契约的 machineDistribution 无效');
  }
  const meta = isRecord(value.meta) ? value.meta : null;
  const capabilities = meta && isRecord(meta.capabilities) ? meta.capabilities : null;
  if (capabilities?.multiFilterSearch === true && !isRecord(meta?.query)) {
    throw new Error('统计数据声明多选能力但缺少 query echo');
  }
  const parsed = !meta?.query ? value as unknown as StatsData : {
    ...(value as unknown as StatsData),
    meta: {
      ...(meta as unknown as NonNullable<StatsData['meta']>),
      query: normalizeStatsQuery(meta.query),
    },
  };
  if (!('dailyCosts' in value)) return withParsedCacheSavings(parsed);
  const dailyCosts = parseDailyCosts(value.dailyCosts, parsed);
  const result = { ...parsed };
  if (dailyCosts) result.dailyCosts = dailyCosts;
  else delete result.dailyCosts;
  return withParsedCacheSavings(result);
}

// UI affordance only. The Rust cfg(target_os = "windows") guard remains the
// authoritative capability check for every command and scheduled update.
export function showsWindowsLockscreenControls(userAgent?: string): boolean {
  const resolvedUserAgent = userAgent
    ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return /\bWindows(?: NT)?\b/i.test(resolvedUserAgent);
}

// UI affordance only, symmetric with showsWindowsLockscreenControls. The Rust
// cfg(target_os = "macos") guard stays authoritative for wallpaper commands.
export function isMacPlatform(userAgent?: string): boolean {
  const resolvedUserAgent = userAgent
    ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return /Mac|iPhone|iPod|iPad/i.test(resolvedUserAgent);
}

// macOS dynamic desktop background is the only platform-conditional wallpaper
// control today, so it reduces to the shared macOS platform check.
export function showsMacDynamicBackgroundControls(userAgent?: string): boolean {
  return isMacPlatform(userAgent);
}

export function beginRequest(generation: GenerationRef): number {
  generation.current += 1;
  return generation.current;
}

export function invalidateRequest(generation: GenerationRef): void {
  generation.current += 1;
}

export function isCurrentRequest(generation: GenerationRef, requestId: number): boolean {
  return generation.current === requestId;
}

export function isUnavailableEnvelope(value: unknown): value is { status: 'unavailable' } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as { status?: unknown }).status === 'unavailable';
}

export function hasCloudCapability(
  stats: StatsData | null,
  capability: 'detailPagination' | 'entityDashboard' | 'multiFilterSearch',
): boolean {
  return stats?.meta?.contractVersion === 2 && stats.meta.capabilities?.[capability] === true;
}

export function mergeUsageDetails(
  previous: UsageDetailsResponse | null,
  next: UsageDetailsResponse,
  append: boolean,
): UsageDetailsResponse {
  if (!append || !previous) return next;
  return { ...next, items: [...previous.items, ...next.items] };
}
