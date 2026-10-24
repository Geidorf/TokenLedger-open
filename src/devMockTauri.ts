import { emit } from '@tauri-apps/api/event';
import { mockIPC } from '@tauri-apps/api/mocks';
import packageJson from '../package.json';
import bundledPrices from '../src-tauri/prices.json';
import type { SessionAnalysis } from './types/sessionAnalysis';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type BehaviorProjectDimensionState,
  type BehaviorProjectRef,
  type BehaviorUnattributedReason,
  type BehaviorUnattributedReasonRow,
  type CustomQuotaEndpointView,
  type EntityDashboard,
  type EntitySelector,
  type PriceMigrationNotice,
  type QuotaBalanceSourceView,
  type QuotaExperimentalPlanView,
  type QuotaProviderEnvelope,
  type QuotaRelayBalanceConfig,
  type QuotaSyncStatus,
  type StatsData,
  type StatsQueryContext,
  type Summary,
  type UsageComparison,
  type UsageDetailsResponse,
} from './types';
import {
  isoCalendarDayValue,
  matchesLiteralQuerySearch,
  normalizeEntitySelector,
  normalizeStatsQuery,
  statsQueryKey,
} from './utils/frontendContracts';
import { BEHAVIOR_PROJECT_DIMENSION_DISABLED, BEHAVIOR_PROJECT_DIMENSION_UNAVAILABLE, BEHAVIOR_UNATTRIBUTED_FILTER_KEY } from './utils/contracts/behaviorProjects';
import type { CostProfile, CostProfileSaveResult } from './types';
import { handleGatewayMock, resetGatewayMockToFresh } from './features/gateway/devMock';
import { mockWallpaperPreview } from './devMockWallpaperPreview';
import { attachE2eHarness, resolveE2eOverride } from './devMockE2e';
import { COST_PROFILE_DEFAULT_CNY_PER_USD, checkCostProfileInput, isCostProfileCleared } from './utils/contracts/costProfile';

// Fixed local wall-clock time keeps visual review, range boundaries and screenshots deterministic.
const mockNow = new Date(2026, 6, 15, 14, 30, 0, 0);
const mockTimestamp = mockNow.toISOString();

function mockIsoAfter(milliseconds: number) {
  return new Date(mockNow.getTime() + milliseconds).toISOString();
}

const mockSources = [
  { tool: 'codex', model: 'gpt-5-codex', machineId: 'Studio-PC', input: 224_000, output: 156_000, cached: 72_000, requests: 780, cost: 6.4 },
  { tool: 'claude', model: 'claude-sonnet-4', machineId: 'Travel-Laptop', input: 166_000, output: 118_000, cached: 48_000, requests: 620, cost: 4.2 },
  { tool: 'antigravity', model: 'gemini-2.5-pro', machineId: 'Studio-PC', input: 112_000, output: 82_000, cached: 34_000, requests: 470, cost: 2.4 },
  { tool: 'minimax', model: 'minimax-m1', machineId: 'Travel-Laptop', input: 96_000, output: 68_000, cached: 28_000, requests: 390, cost: 2.1 },
] as const;

// Smaller daily models (T10.158). With the four sources above the preview
// ledger carries eleven models, so every model list runs past its default
// eight rows. claude-opus-4-1 is the smallest by effective tokens yet among
// the most expensive: the case a token-ranked top-8 cut used to drop from the
// cost report. These rows vary multiplicatively so low volumes never turn
// negative, and their ids and session IDs start at 1001 so they never collide
// with the daily sources above.
const mockSecondarySources = [
  { tool: 'opencode', model: 'deepseek-v3.1', machineId: 'Studio-PC', input: 74_000, output: 46_000, cached: 52_000, requests: 260, cost: 0.19, hour: 13, minute: 40 },
  { tool: 'kimi', model: 'kimi-k2', machineId: 'Travel-Laptop', input: 58_000, output: 38_000, cached: 30_000, requests: 210, cost: 0.36, hour: 12, minute: 50 },
  { tool: 'opencode', model: 'qwen3-coder', machineId: 'Studio-PC', input: 44_000, output: 28_000, cached: 26_000, requests: 170, cost: 0.24, hour: 11, minute: 35 },
  { tool: 'gemini', model: 'gemini-2.5-flash', machineId: 'Studio-PC', input: 38_000, output: 22_000, cached: 18_000, requests: 150, cost: 0.08, hour: 10, minute: 45 },
  { tool: 'grok', model: 'grok-code-fast-1', machineId: 'Travel-Laptop', input: 24_000, output: 16_000, cached: 12_000, requests: 110, cost: 0.11, hour: 9, minute: 55 },
  { tool: 'claude', model: 'claude-haiku-4-5', machineId: 'Travel-Laptop', input: 18_000, output: 12_000, cached: 9_000, requests: 90, cost: 0.1, hour: 9, minute: 10 },
  { tool: 'claude', model: 'claude-opus-4-1', machineId: 'Travel-Laptop', input: 7_000, output: 5_000, cached: 140_000, requests: 24, cost: 2.6, hour: 8, minute: 30 },
] as const;

function secondarySourceRows(daysAgo: number): StatsData['history'] {
  return mockSecondarySources.map((source, index) => {
    const date = new Date(mockNow);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(source.hour, source.minute, 0, 0);
    const factor = 1 + ((((daysAgo * 5 + index * 3) % 13) - 6) * 0.05);
    const cachedTokens = Math.round(source.cached * factor);
    const cacheWriteTokens = Math.round(cachedTokens * 0.25);
    const id = 1000 + daysAgo * mockSecondarySources.length + index + 1;
    return {
      id,
      tool: source.tool,
      model: source.model,
      inputTokens: Math.round(source.input * factor),
      outputTokens: Math.round(source.output * factor),
      cachedTokens,
      cacheWriteTokens,
      cacheReadTokens: cachedTokens - cacheWriteTokens,
      cost: Number((source.cost * factor).toFixed(4)),
      timestamp: date.toISOString(),
      sessionId: `session-${id}`,
      machineId: source.machineId,
      requests: Math.max(1, Math.round(source.requests * factor)),
      granularity: 'request' as const,
    };
  });
}

// Ninety days covers current and previous equal-progress month windows. Every
// dashboard surface is derived from these rows; no KPI or distribution has a
// separate hand-authored total.
const mockHistory: StatsData['history'] = Array.from({ length: 90 }, (_, daysAgo) => [
  ...mockSources.map((source, sourceIndex) => {
    const date = new Date(mockNow);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(14 - sourceIndex * 2, 5 + sourceIndex * 7, 0, 0);
    const phase = ((daysAgo * 7 + sourceIndex * 5) % 13) - 6;
    const sourceDrift = sourceIndex % 2 === 0 ? daysAgo * 190 : -daysAgo * 110;
    const inputTokens = source.input + phase * (2_200 + sourceIndex * 180) + sourceDrift;
    const outputTokens = source.output + phase * (1_500 + sourceIndex * 140) + Math.round(sourceDrift * 0.62);
    const cachedTokens = source.cached + phase * (620 + sourceIndex * 70);
    const cacheWriteTokens = Math.max(0, Math.round(cachedTokens * (0.18 + sourceIndex * 0.025)));
    return {
      id: daysAgo * mockSources.length + sourceIndex + 1,
      tool: source.tool,
      model: source.model,
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens,
      cacheReadTokens: cachedTokens - cacheWriteTokens,
      cost: Number((source.cost + phase * 0.075 + daysAgo * 0.004).toFixed(4)),
      timestamp: date.toISOString(),
      sessionId: `session-${String(daysAgo * mockSources.length + sourceIndex + 1).padStart(3, '0')}`,
      machineId: source.machineId,
      requests: source.requests + phase * (7 + sourceIndex),
      granularity: 'request' as const,
    };
  }),
  ...secondarySourceRows(daysAgo),
]).flat().sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id - left.id);

function emptySummary(): Summary {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheSavedUsd: 0,
    totalCost: 0,
    totalRequests: 0,
    avgTokensPerReq: 0,
  };
}

function summarize(items: StatsData['history']): Summary {
  const summary = items.reduce((result, item) => {
    result.inputTokens += item.inputTokens;
    result.outputTokens += item.outputTokens;
    result.cachedTokens += item.cachedTokens;
    result.cacheWriteTokens = (result.cacheWriteTokens || 0) + (item.cacheWriteTokens || 0);
    result.cacheReadTokens = (result.cacheReadTokens || 0) + Math.max(0, item.cachedTokens - (item.cacheWriteTokens || 0));
    result.totalCost += item.cost;
    result.totalRequests += item.requests || 1;
    return result;
  }, emptySummary());
  summary.totalTokens = summary.inputTokens + summary.outputTokens;
  summary.avgTokensPerReq = summary.totalRequests > 0 ? Math.round(summary.totalTokens / summary.totalRequests) : 0;
  summary.totalCost = Number(summary.totalCost.toFixed(4));
  summary.cacheSavedUsd = Number(((summary.cacheReadTokens || 0) / 1_000_000 * 1.25).toFixed(4));
  return summary;
}

type MockRange = 'today' | 'week' | 'month' | 'year' | 'all' | 'custom';

interface MockCustomBounds {
  /** 区间首日本地零点。 */
  start: Date;
  /** 区间末日 23:59:59.999；若晚于 mockNow 则截到 mockNow（进行中语义与 Rust 一致）。 */
  end: Date;
  /** 闭区间天数。 */
  days: number;
  /** 单日区间用小时桶。 */
  hourly: boolean;
}

function normalizeMockRange(rawRange: unknown): MockRange {
  return rawRange === 'week' || rawRange === 'month' || rawRange === 'year' || rawRange === 'all' || rawRange === 'custom'
    ? rawRange
    : 'today';
}

function parseMockIsoDay(value: unknown): Date | null {
  if (typeof value !== 'string' || isoCalendarDayValue(value) === null) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

// Mirrors Rust `StatsRange::Custom`: inclusive local dates, hour buckets for a single day.
function mockCustomBounds(raw: Record<string, unknown>): MockCustomBounds | null {
  const start = parseMockIsoDay(raw.start);
  const endDay = parseMockIsoDay(raw.end);
  if (!start || !endDay || endDay < start) return null;
  const endOfRange = new Date(endDay);
  endOfRange.setHours(23, 59, 59, 999);
  const end = endOfRange < mockNow ? endOfRange : new Date(mockNow);
  const days = calendarDayDistance(start, endDay) + 1;
  return { start, end, days, hourly: days === 1 };
}

function startOfLocalDay(value: Date) {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);
  return start;
}

function startOfMockRange(range: MockRange, bounds: MockCustomBounds | null = null) {
  if (range === 'custom') return bounds ? new Date(bounds.start) : null;
  const start = startOfLocalDay(mockNow);
  if (range === 'week') {
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
  } else if (range === 'month') {
    start.setDate(1);
  } else if (range === 'year') {
    start.setMonth(0, 1);
  } else if (range === 'all') {
    return null;
  }
  return start;
}

function formatDateBucket(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function formatAlignedThrough(value: Date) {
  return `${formatDateBucket(value)} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

function calendarDayDistance(start: Date, end: Date) {
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((endUtc - startUtc) / 86_400_000);
}

interface MockComparisonWindow {
  kind: UsageComparison['window']['kind'];
  bucket: UsageComparison['window']['bucket'];
  currentStart: Date;
  currentEnd: Date;
  previousStart: Date;
  previousEnd: Date;
}

type MockComparableRange = 'today' | 'week' | 'month' | 'custom';

function mockRangeComparable(range: MockRange): range is MockComparableRange {
  return range === 'today' || range === 'week' || range === 'month' || range === 'custom';
}

function comparisonWindow(range: MockComparableRange, bounds: MockCustomBounds | null = null): MockComparisonWindow {
  if (range === 'custom') {
    if (!bounds) throw new Error('custom range requires start and end');
    const currentStart = new Date(bounds.start);
    const currentEnd = new Date(bounds.end);
    const previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - bounds.days);
    const previousEnd = new Date(currentEnd);
    previousEnd.setDate(previousEnd.getDate() - bounds.days);
    return {
      kind: 'periodOverPeriod',
      bucket: bounds.hourly ? 'hour' : 'day',
      currentStart,
      currentEnd,
      previousStart,
      previousEnd,
    };
  }
  const currentStart = startOfMockRange(range)!;
  const previousStart = new Date(currentStart);
  const currentEnd = new Date(mockNow);
  const previousEnd = new Date(previousStart);
  if (range === 'today') {
    previousStart.setDate(previousStart.getDate() - 1);
    previousEnd.setTime(previousStart.getTime());
    previousEnd.setHours(mockNow.getHours(), mockNow.getMinutes(), mockNow.getSeconds(), mockNow.getMilliseconds());
    return { kind: 'dayOverDay', bucket: 'hour', currentStart, currentEnd, previousStart, previousEnd };
  }

  if (range === 'week') previousStart.setDate(previousStart.getDate() - 7);
  else previousStart.setMonth(previousStart.getMonth() - 1);
  previousEnd.setTime(previousStart.getTime());
  const rawElapsedDays = calendarDayDistance(currentStart, mockNow) + 1;
  const previousPeriodDays = range === 'month'
    ? new Date(previousStart.getFullYear(), previousStart.getMonth() + 1, 0).getDate()
    : rawElapsedDays;
  const elapsedDays = Math.min(rawElapsedDays, previousPeriodDays);
  currentEnd.setTime(currentStart.getTime());
  currentEnd.setDate(currentEnd.getDate() + elapsedDays - 1);
  currentEnd.setHours(mockNow.getHours(), mockNow.getMinutes(), mockNow.getSeconds(), mockNow.getMilliseconds());
  previousEnd.setDate(previousEnd.getDate() + elapsedDays - 1);
  previousEnd.setHours(mockNow.getHours(), mockNow.getMinutes(), mockNow.getSeconds(), mockNow.getMilliseconds());
  return {
    kind: range === 'week' ? 'weekOverWeek' : 'monthOverMonth',
    bucket: 'day',
    currentStart,
    currentEnd,
    previousStart,
    previousEnd,
  };
}

function rowsInWindow(start: Date, end: Date) {
  const startTime = start.getTime();
  const endTime = end.getTime();
  return mockHistory.filter((item) => {
    const timestamp = new Date(item.timestamp).getTime();
    return timestamp >= startTime && timestamp <= endTime;
  });
}

function historyForRange(range: MockRange, bounds: MockCustomBounds | null = null) {
  if (mockRangeComparable(range)) {
    const window = comparisonWindow(range, bounds);
    return rowsInWindow(window.currentStart, window.currentEnd);
  }
  const start = startOfMockRange(range, bounds);
  return start ? rowsInWindow(start, mockNow) : rowsInWindow(new Date(0), mockNow);
}

function comparisonSeries(
  rows: StatsData['history'],
  start: Date,
  end: Date,
  bucket: UsageComparison['window']['bucket'],
): UsageComparison['current']['series'] {
  const bucketCount = bucket === 'hour'
    ? end.getHours() - start.getHours() + 1
    : calendarDayDistance(start, end) + 1;
  const points = Array.from({ length: Math.max(1, bucketCount) }, (_, index) => {
    const pointDate = new Date(start);
    if (bucket === 'hour') pointDate.setHours(pointDate.getHours() + index);
    else pointDate.setDate(pointDate.getDate() + index);
    return {
      bucket: bucket === 'hour'
        ? `${String(pointDate.getHours()).padStart(2, '0')}:00`
        : formatDateBucket(pointDate),
      tokens: 0,
      requests: 0,
      cost: 0,
    };
  });
  rows.forEach((item) => {
    const timestamp = new Date(item.timestamp);
    const index = bucket === 'hour'
      ? timestamp.getHours() - start.getHours()
      : calendarDayDistance(start, timestamp);
    const point = points[index];
    if (!point) return;
    point.tokens += item.inputTokens + item.outputTokens;
    point.requests += item.requests || 1;
    point.cost = Number((point.cost + item.cost).toFixed(4));
  });
  return points;
}

function buildComparison(
  range: MockComparableRange,
  query: StatsQueryContext,
  bounds: MockCustomBounds | null = null,
): UsageComparison {
  const window = comparisonWindow(range, bounds);
  const currentRows = filterMockHistory(rowsInWindow(window.currentStart, window.currentEnd), query);
  const previousRows = filterMockHistory(rowsInWindow(window.previousStart, window.previousEnd), query);
  const currentSummary = summarize(currentRows);
  const previousSummary = summarize(previousRows);
  return {
    window: {
      kind: window.kind,
      timezone: currentTimezoneForMock(),
      bucket: window.bucket,
      currentStart: window.currentStart.toISOString(),
      currentEnd: window.currentEnd.toISOString(),
      previousStart: window.previousStart.toISOString(),
      previousEnd: window.previousEnd.toISOString(),
      alignedThrough: formatAlignedThrough(window.currentEnd),
    },
    current: {
      summary: currentSummary,
      series: comparisonSeries(currentRows, window.currentStart, window.currentEnd, window.bucket),
    },
    previous: {
      summary: previousSummary,
      series: comparisonSeries(previousRows, window.previousStart, window.previousEnd, window.bucket),
    },
    delta: {
      tokens: comparisonDelta(currentSummary.totalTokens, previousSummary.totalTokens),
      requests: comparisonDelta(currentSummary.totalRequests, previousSummary.totalRequests),
      cost: comparisonDelta(currentSummary.totalCost, previousSummary.totalCost),
    },
  };
}

function groupRows(items: StatsData['history'], key: 'tool' | 'model') {
  const groups = new Map<string, StatsData['history']>();
  items.forEach((item) => groups.set(item[key], [...(groups.get(item[key]) || []), item]));
  return groups;
}

function toolsFromRows(items: StatsData['history']): StatsData['tools'] {
  return Object.fromEntries([...groupRows(items, 'tool')].map(([name, rows]) => {
    const summary = summarize(rows);
    const models = Object.fromEntries([...groupRows(rows, 'model')].map(([model, modelRows]) => [
      model,
      summarize(modelRows).totalTokens,
    ]));
    return [name, {
      name,
      input: summary.inputTokens,
      output: summary.outputTokens,
      cached: summary.cachedTokens,
      cacheRead: summary.cacheReadTokens,
      cacheWrite: summary.cacheWriteTokens,
      total: summary.totalTokens + summary.cachedTokens,
      cost: summary.totalCost,
      requests: summary.totalRequests,
      models,
      heatmap: entityHeatmap(rows),
    }];
  }));
}

function modelsFromRows(items: StatsData['history']): StatsData['models'] {
  return Object.fromEntries([...groupRows(items, 'model')].map(([name, rows]) => {
    const summary = summarize(rows);
    return [name, {
      name,
      tool: rows[0]?.tool,
      input: summary.inputTokens,
      output: summary.outputTokens,
      cached: summary.cachedTokens,
      // Rust local models carry both halves of the cache split; without
      // cacheRead the preview could only ever show the combined fallback.
      cacheRead: summary.cacheReadTokens,
      cacheWrite: summary.cacheWriteTokens,
      total: summary.totalTokens + summary.cachedTokens,
      displayTotal: summary.totalTokens,
      requests: summary.totalRequests,
      cost: summary.totalCost,
      heatmap: entityHeatmap(rows),
    }];
  }));
}

function trendBucketKey(range: MockRange, localTimestamp: string, hourly = false): string {
  // Mirrors Rust `trend_key` (commands/mod.rs): today and single-day custom ranges →
  // `HH:00` hourly buckets, year → `YYYY-MM` monthly buckets, otherwise a local
  // `YYYY-MM-DD` day bucket. `localTimestamp` must already be local wall-clock
  // `YYYY-MM-DD HH:mm` (formatAlignedThrough); slicing raw ISO would drift with the timezone.
  if (range === 'today' || hourly) return `${localTimestamp.slice(11, 13)}:00`;
  if (range === 'year') return localTimestamp.slice(0, 7);
  return localTimestamp.slice(0, 10);
}

function emptyTrendBucket(key: string): StatsData['trends'][number] {
  return { date: key };
}

function seedTrendBuckets(
  range: MockRange,
  rows: StatsData['history'],
  bounds: MockCustomBounds | null = null,
): Map<string, StatsData['trends'][number]> {
  // Mirrors Rust `initial_trends_at`: pre-seed the full bucket skeleton so a
  // sparse window still renders zero buckets instead of collapsing the axis.
  const buckets = new Map<string, StatsData['trends'][number]>();
  if (range === 'custom' && bounds) {
    if (bounds.hourly) {
      for (let hour = 0; hour < 24; hour += 1) {
        const key = `${String(hour).padStart(2, '0')}:00`;
        buckets.set(key, emptyTrendBucket(key));
      }
      return buckets;
    }
    for (let offset = 0; offset < bounds.days; offset += 1) {
      const date = new Date(bounds.start);
      date.setDate(date.getDate() + offset);
      const key = formatDateBucket(date);
      buckets.set(key, emptyTrendBucket(key));
    }
    return buckets;
  }
  if (range === 'today') {
    for (let hour = 0; hour < 24; hour += 1) {
      const key = `${String(hour).padStart(2, '0')}:00`;
      buckets.set(key, emptyTrendBucket(key));
    }
    return buckets;
  }
  if (range === 'year') {
    for (let month = 1; month <= 12; month += 1) {
      const key = `${mockNow.getFullYear()}-${String(month).padStart(2, '0')}`;
      buckets.set(key, emptyTrendBucket(key));
    }
    return buckets;
  }
  if (range === 'week') {
    // Rust seeds Monday..Sunday of the current week; future days stay zero.
    const mondayOffset = (mockNow.getDay() + 6) % 7;
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(mockNow);
      date.setDate(date.getDate() - mondayOffset + day);
      const key = formatDateBucket(date);
      buckets.set(key, emptyTrendBucket(key));
    }
    return buckets;
  }
  if (range === 'month') {
    // Rust seeds every day of the current month.
    const lastDay = new Date(mockNow.getFullYear(), mockNow.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= lastDay; day += 1) {
      const key = `${mockNow.getFullYear()}-${String(mockNow.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      buckets.set(key, emptyTrendBucket(key));
    }
    return buckets;
  }
  rows.forEach((row) => {
    const key = trendBucketKey(range, formatAlignedThrough(new Date(row.timestamp)));
    if (!buckets.has(key)) buckets.set(key, emptyTrendBucket(key));
  });
  return buckets;
}

function trendsFromRows(
  items: StatsData['history'],
  range: MockRange,
  bounds: MockCustomBounds | null = null,
): StatsData['trends'] {
  const byDate = seedTrendBuckets(range, items, bounds);
  [...items].reverse().forEach((item) => {
    const local = formatAlignedThrough(new Date(item.timestamp));
    const date = trendBucketKey(range, local, bounds?.hourly ?? false);
    const point = byDate.get(date) || emptyTrendBucket(date);
    point[item.tool] = Number(point[item.tool] || 0) + item.inputTokens + item.outputTokens;
    byDate.set(date, point);
  });
  return [...byDate.values()].sort((left, right) => {
    if (range === 'year') return parseInt(left.date, 10) - parseInt(right.date, 10);
    return left.date.localeCompare(right.date);
  });
}

function queryEcho(query: StatsQueryContext) {
  return {
    ...query,
    ...(query.machines.length <= 1 ? { machine: query.machines[0] ?? null } : {}),
    ...(query.tools.length <= 1 ? { tool: query.tools[0] ?? null } : {}),
    ...(query.models.length <= 1 ? { model: query.models[0] ?? null } : {}),
  };
}

function statsForQuery(rawQuery: Record<string, unknown>): StatsData {
  const range = normalizeMockRange(rawQuery.range);
  // T10.185: the cloud v2 RPC mock now serves `custom` the same way local
  // does (Stats v2 has supported it since T10.113); this mock only ever
  // simulates a fully migrated server, so cloud custom always succeeds here.
  const bounds = range === 'custom' ? mockCustomBounds(rawQuery) : null;
  const query = normalizeStatsQuery({
    ...rawQuery,
    range,
    timezone: typeof rawQuery.timezone === 'string' ? rawQuery.timezone : currentTimezoneForMock(),
    machines: rawQuery.machines ?? (rawQuery.deviceFilter && rawQuery.deviceFilter !== 'all_cloud' ? [rawQuery.deviceFilter] : undefined),
    tokenMode: rawQuery.tokenMode ?? 'effective',
  });
  const rows = filterMockHistory(historyForRange(range, bounds), query);
  const comparison = mockRangeComparable(range)
    ? buildComparison(range, query, bounds)
    : null;
  const availableMachines = [...new Set(historyForRange(range, bounds).map((item) => item.machineId))].sort();
  return {
    summary: summarize(rows),
    tools: toolsFromRows(rows),
    models: modelsFromRows(rows),
    trends: trendsFromRows(rows, range, bounds),
    heatmap: entityHeatmap(rows),
    history: rows,
    machineDistribution: composition(rows, 'machineId'),
    machines: availableMachines,
    comparison,
    meta: {
      contractVersion: 2,
      generatedAt: mockTimestamp,
      lastRefreshedAt: mockTimestamp,
      timezone: currentTimezoneForMock(),
      range,
      machine: query.machines.length === 1 ? query.machines[0] : null,
      stale: false,
      query: queryEcho(query),
      capabilities: {
        comparison: comparison !== null,
        detailPagination: true,
        entityDashboard: true,
        multiFilterSearch: true,
        quotaSnapshots: false,
      },
    },
  };
}

// Mirrors Rust `behavior_session_id`: empty, blank and the scanner placeholder
// `unknown_session` are missing IDs, never one merged fake session.
const MOCK_UNKNOWN_SESSION_ID = 'unknown_session';

function mockBehaviorSessionId(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed && trimmed !== MOCK_UNKNOWN_SESSION_ID ? raw : null;
}

// Mirrors Rust `MAX_CUSTOM_RANGE_DAYS`: `all` only covers the latest 731 local days.
const MOCK_BEHAVIOR_RANGE_DAY_LIMIT = 731;

// The behavior mock works in the selected zone, like Rust `rows_in_timezone`:
// the shared mock ledger rows are instants (written in host-local wall time for
// the dashboard mock), and every date, hour and record time is read in
// `query.timezone`. With the host zone selected the result equals the host view.
interface MockWallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

const mockZoneFormatters = new Map<string, Intl.DateTimeFormat>();

function mockWallClock(value: Date, timeZone: string): MockWallClock {
  let formatter = mockZoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    mockZoneFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

function mockWallDay(clock: Pick<MockWallClock, 'year' | 'month' | 'day'>): string {
  return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`;
}

// Rust reports record times as wall-clock `YYYY-MM-DD HH:MM:SS` in the selected zone.
function formatMockWallTimestamp(clock: MockWallClock): string {
  const time = [clock.hour, clock.minute, clock.second].map((part) => String(part).padStart(2, '0')).join(':');
  return `${mockWallDay(clock)} ${time}`;
}

// Mirrors Rust `resolve_wall_time`: the instant at which `timeZone` shows the
// given local midnight. A second pass settles the offset on a DST-change day.
function mockZonedMidnight(calendarDayUtc: number, timeZone: string): Date {
  let instant = calendarDayUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = mockWallClock(new Date(instant), timeZone);
    instant += calendarDayUtc - Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
  }
  return new Date(instant);
}

const MOCK_DAY_MS = 86_400_000;

// Mirrors Rust `behavior_window` in the selected zone: presets are calendar
// windows up to "now" (request start/end ignored), custom is the inclusive
// local range cut at "now", and `all` is capped to the latest 731 local days.
// Calendar arithmetic runs on UTC day values, so it has no DST gaps.
function mockBehaviorWindow(range: MockRange, rawQuery: Record<string, unknown>, timeZone: string): { start: Date; end: Date; capped: boolean } {
  const now = new Date(mockNow);
  const clock = mockWallClock(mockNow, timeZone);
  const today = Date.UTC(clock.year, clock.month - 1, clock.day);
  const from = (startDay: number, capped = false) => ({ start: mockZonedMidnight(startDay, timeZone), end: now, capped });
  if (range === 'custom') {
    const startDay = isoCalendarDayValue(rawQuery.start) ?? today;
    const endDay = isoCalendarDayValue(rawQuery.end) ?? today;
    const endOfRange = new Date(mockZonedMidnight(endDay + MOCK_DAY_MS, timeZone).getTime() - 1);
    return { ...from(startDay), end: endOfRange < now ? endOfRange : now };
  }
  if (range === 'all') return from(today - (MOCK_BEHAVIOR_RANGE_DAY_LIMIT - 1) * MOCK_DAY_MS, true);
  if (range === 'week') return from(today - ((new Date(today).getUTCDay() + 6) % 7) * MOCK_DAY_MS);
  if (range === 'month') return from(Date.UTC(clock.year, clock.month - 1, 1));
  if (range === 'year') return from(Date.UTC(clock.year, 0, 1));
  return from(today);
}

// Rust sorts strings byte-wise; plain code-unit order matches it for ledger
// identifiers, unlike the locale-aware localeCompare.
function compareMockCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

// Mirrors Rust `build_request_size_bins`: one-thousand-token buckets, widened
// in one-thousand steps until at most 32 bins remain; the first bin starts at 0.
export function mockRequestSizeBins(values: number[]): Array<{ lower: number; upper: number; requests: number }> {
  if (values.length === 0) return [{ lower: 0, upper: 1000, requests: 0 }];
  const maxBins = 32;
  const max = values.reduce((peak, value) => Math.max(peak, value), -Infinity);
  const thousandBuckets = Math.floor(Math.max(0, max) / 1000) + 1;
  const width = Math.max(1, Math.ceil(thousandBuckets / maxBins)) * 1000;
  const binCount = Math.max(1, Math.floor(max / width) + 1);
  const counts = Array.from({ length: binCount }, () => 0);
  for (const value of values) counts[Math.min(binCount - 1, Math.max(0, Math.floor(value / width)))] += 1;
  return counts.map((requests, index) => ({ lower: index * width, upper: index * width + width, requests }));
}

// Mirrors Rust `percentile_nearest_rank` on an ascending array.
function mockPercentileNearestRank(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(sorted.length * percentile));
  return sorted[Math.min(rank, sorted.length) - 1];
}

// Mirrors Rust `BehaviorPricer::row_cost` + `add_behavior_cost`: a cost that is not a
// finite non-negative number is unavailable and makes the whole sum null.
function addMockBehaviorCost(total: number | null, cost: number): number | null {
  if (total === null || !Number.isFinite(cost) || cost < 0) return null;
  const sum = total + cost;
  return Number.isFinite(sum) ? sum : null;
}

interface MockBehaviorSession {
  id: string;
  tool: string;
  tokens: number;
  requests: number;
  cost: number | null;
  firstAt: string;
  lastAt: string;
  models: Map<string, { tokens: number; records: number }>;
  /** Project place while the project dimension collects (contract v1.2), else null. */
  place: MockProjectPlace | null;
}

// Mirrors Rust `BehaviorSession::top_model`: most tokens, then most records, then name.
function mockTopModel(models: MockBehaviorSession['models']): string | null {
  let best: [string, { tokens: number; records: number }] | null = null;
  for (const entry of models) {
    const [name, usage] = entry;
    if (!best
      || usage.tokens > best[1].tokens
      || (usage.tokens === best[1].tokens && (usage.records > best[1].records
        || (usage.records === best[1].records && compareMockCodeUnits(name, best[0]) < 0)))) {
      best = entry;
    }
  }
  return best ? best[0] : null;
}

/**
 * Behavior preview scenarios (T10.164). `default` analyses the shared mock
 * ledger as-is. `edge` is opt-in with `?behaviorMock=edge` and only changes
 * what the behavior command sees, so the page's honesty states can be
 * previewed: MiniMax rows carry the scanner's `unknown_session` placeholder
 * (as the real MiniMax scanner writes), the newest Antigravity row has a
 * corrupt stored cost (its session and the total become 「不可得」), and one
 * ledger row predates the 731-day `all` window (so `all` is truncated). The
 * details and dashboard mocks still show the original rows; this scenario is a
 * behavior-page preview, not another ledger.
 */
export type MockBehaviorScenario = 'default' | 'edge';

const MOCK_EDGE_CORRUPT_COST_ROW_ID = 3;

export function mockBehaviorLedger(scenario: MockBehaviorScenario): StatsData['history'] {
  if (scenario === 'default') return mockHistory;
  const archived = new Date(mockNow);
  archived.setDate(archived.getDate() - 800);
  const oldest = mockHistory[mockHistory.length - 1];
  return [
    ...mockHistory.map((row) => {
      if (row.tool === 'minimax') return { ...row, sessionId: MOCK_UNKNOWN_SESSION_ID };
      return row.id === MOCK_EDGE_CORRUPT_COST_ROW_ID ? { ...row, cost: Number.NaN } : row;
    }),
    { ...oldest, id: 100_000, timestamp: archived.toISOString(), sessionId: 'session-archived' },
  ];
}

/** A project-dimension preview state, or `unavailable`: the index cannot be read. */
type MockProjectPreviewState = BehaviorProjectDimensionState | 'unavailable';

const MOCK_PROJECT_DIMENSION_STATES: readonly MockProjectPreviewState[] = ['disabled', 'consent_required', 'indexing', 'ready', 'failed', 'unavailable'];

/** 预览里的本机开关。每次 install 都回到默认关闭，与新安装一致。 */
let mockProjectDimensionEnabled = false;
let mockProjectNamed = 0;
let mockProjectIndexed = 0;

function resetMockProjectDimension() {
  mockProjectDimensionEnabled = false;
  mockProjectNamed = 0;
  mockProjectIndexed = 0;
}

function mockProjectDimensionStatus(purge?: { removedSessions: number; walTruncated: boolean } | null) {
  const enabled = mockProjectDimensionEnabled;
  return {
    enabled,
    state: enabled ? 'ready' : 'disabled',
    consentVersion: enabled ? 1 : 0,
    requiredConsentVersion: 1,
    gitProbeEnabled: false,
    backfill: { status: enabled ? 'done' : 'idle', done: enabled ? mockProjectIndexed : 0, total: enabled ? mockProjectIndexed : 0 },
    indexedSessions: enabled ? mockProjectIndexed : 0,
    namedProjects: enabled ? mockProjectNamed : 0,
    unresolvedSessions: 0,
    lastFailure: null,
    ...(purge ? { purge } : {}),
  };
}

/**
 * Reads the opt-in preview scenario, reply delay (`?behaviorMockDelay=<ms>`,
 * at most 10 s) and project-dimension state (`?behaviorProjects=<state>`,
 * T10.182). The project dimension is off by default, like a fresh install.
 */
function mockBehaviorPreviewOptions(): { scenario: MockBehaviorScenario; delayMs: number; projectState: MockProjectPreviewState } {
  if (typeof window === 'undefined') return { scenario: 'default', delayMs: 0, projectState: 'disabled' };
  const params = new URLSearchParams(window.location.search);
  const delay = Number(params.get('behaviorMockDelay'));
  const projectState = params.get('behaviorProjects');
  return {
    scenario: params.get('behaviorMock') === 'edge' ? 'edge' : 'default',
    delayMs: Number.isFinite(delay) && delay > 0 ? Math.min(delay, 10_000) : 0,
    projectState: MOCK_PROJECT_DIMENSION_STATES.find((state) => state === projectState)
      ?? (mockProjectDimensionEnabled ? 'ready' : 'disabled'),
  };
}

// -----------------------------------------------------------------------------
// Project dimension preview (behavior contract v1.2, T10.182). The native
// command reads the local project index; this preview index is made up from
// the mock ledger with fictional folder names only, and the aggregation below
// follows the native rules (commands/mod.rs, project_index/behavior_view.rs).
// -----------------------------------------------------------------------------

/** One session's row in a preview project index: a folder name or a fixed group, never a path. */
export type MockIndexedSession =
  | { kind: 'named'; label: string }
  | { kind: 'home' | 'root' | 'temp' | 'managed' }
  | { kind: 'unresolved'; unsupportedSource: boolean };

export interface MockProjectIndex {
  state: BehaviorProjectDimensionState;
  /** Stored backfill failure code; the response reports a fixed code only in the `failed` state. */
  lastFailure: string | null;
  /** Rows keyed by `mockProjectIndexKey`; a session without a row is not indexed yet. */
  sessions: Map<string, MockIndexedSession>;
}

export function mockProjectIndexKey(tool: string, sessionId: string): string {
  return `${tool}\u0000${sessionId}`;
}

// Fictional folder names; `Demo-CLI` is also stored as `demo-cli` by a few sessions.
const MOCK_PROJECT_NAMES = ['sample-webapp', 'Demo-CLI', 'example-docs', 'toy-compiler', 'data-notebook'] as const;
// Sources whose logs record no working directory (Rust `SourceFamily::is_supported`).
const MOCK_UNSUPPORTED_PROJECT_SOURCES = new Set(['antigravity']);
// Mirrors the backfill codes `behavior_view` lets through; anything else is reported as null.
const MOCK_PROJECT_FAILURE_CODES = new Set(['database_error', 'internal_error']);

/** FNV-1a over the session identity: a stable, evenly spread preview assignment. */
function mockSessionHash(tool: string, sessionId: string): number {
  const text = `${tool}|${sessionId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

function mockIndexedSession(tool: string, hash: number): MockIndexedSession {
  if (MOCK_UNSUPPORTED_PROJECT_SOURCES.has(tool)) return { kind: 'unresolved', unsupportedSource: true };
  switch (hash % 24) {
    case 0:
    case 1: return { kind: 'unresolved', unsupportedSource: false };
    case 2: return { kind: 'home' };
    case 3: return { kind: 'managed' };
    case 4: return { kind: 'temp' };
    case 5: return { kind: 'root' };
    case 6: return { kind: 'named', label: 'demo-cli' };
    default: return { kind: 'named', label: MOCK_PROJECT_NAMES[Math.floor(hash / 24) % MOCK_PROJECT_NAMES.length] };
  }
}

/**
 * Preview project index over `ledger` in `state`. Switching the dimension off
 * purges the index, so `disabled` has no rows; `consent_required` keeps rows
 * that the command must not show. `ready` lacks only the sessions that started
 * within the last hour (after the latest pass); `indexing` and `failed` also
 * lack about a third of the older sessions, and `failed` stores a fixed code.
 */
export function mockProjectIndex(state: BehaviorProjectDimensionState, ledger: StatsData['history'] = mockHistory): MockProjectIndex {
  const sessions = new Map<string, MockIndexedSession>();
  const lastFailure = state === 'failed' ? 'database_error' : null;
  if (state === 'disabled') return { state, lastFailure, sessions };
  const firstSeen = new Map<string, { tool: string; sessionId: string; at: number }>();
  for (const row of ledger) {
    const sessionId = mockBehaviorSessionId(row.sessionId);
    if (!sessionId) continue;
    const key = mockProjectIndexKey(row.tool, sessionId);
    const at = new Date(row.timestamp).getTime();
    const seen = firstSeen.get(key);
    if (!seen || at < seen.at) firstSeen.set(key, { tool: row.tool, sessionId, at });
  }
  const lastPass = mockNow.getTime() - 3_600_000;
  for (const [key, { tool, sessionId, at }] of firstSeen) {
    const hash = mockSessionHash(tool, sessionId);
    const notReached = (state === 'indexing' || state === 'failed') && (hash >>> 8) % 3 === 0;
    if (at > lastPass || notReached) continue;
    sessions.set(key, mockIndexedSession(tool, hash));
  }
  return { state, lastFailure, sessions };
}

/** Where a record belongs: a project (named or fixed group) or an unattributed reason. */
type MockProjectPlace = { project: BehaviorProjectRef } | { reason: BehaviorUnattributedReason };

interface MockProjectView {
  state: 'indexing' | 'ready' | 'failed';
  lastFailure: string | null;
  /** A real session's place; a session without an index row is `pending`. */
  place: (tool: string, sessionId: string) => MockProjectPlace;
}

/** Mirrors `behavior_view::load`: nothing while the index does not collect; labels by majority spelling. */
function mockProjectView(index: MockProjectIndex): MockProjectView | null {
  const { state } = index;
  if (state !== 'indexing' && state !== 'ready' && state !== 'failed') return null;
  // `n:` + lower case of the stored name (Rust `project_key_for_label`).
  const keyOf = (label: string) => `n:${label.toLowerCase()}`;
  const spellings = new Map<string, Map<string, number>>();
  for (const entry of index.sessions.values()) {
    if (entry.kind !== 'named') continue;
    const counts = spellings.get(keyOf(entry.label)) ?? new Map<string, number>();
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
    spellings.set(keyOf(entry.label), counts);
  }
  // Rust `choose_display_label` over the whole index: most sessions, ties by code-point order.
  const named = new Map<string, BehaviorProjectRef>();
  for (const [key, counts] of spellings) {
    let best: [string, number] | null = null;
    for (const entry of counts) {
      if (!best || entry[1] > best[1] || (entry[1] === best[1] && compareMockCodeUnits(entry[0], best[0]) < 0)) best = entry;
    }
    if (best) named.set(key, { key, label: best[0], kind: 'named' });
  }
  return {
    state,
    lastFailure: state === 'failed' && index.lastFailure !== null && MOCK_PROJECT_FAILURE_CODES.has(index.lastFailure)
      ? index.lastFailure
      : null,
    place(tool, sessionId) {
      const entry = index.sessions.get(mockProjectIndexKey(tool, sessionId));
      if (!entry) return { reason: 'pending' };
      if (entry.kind === 'unresolved') return { reason: entry.unsupportedSource ? 'unsupported_source' : 'unresolved' };
      if (entry.kind === 'named') {
        const key = keyOf(entry.label);
        return { project: named.get(key) ?? { key, label: entry.label, kind: 'named' } };
      }
      return { project: { key: `@${entry.kind}`, label: null, kind: entry.kind } };
    },
  };
}

interface MockProjectFilter {
  /** Deduplicated, in code-point order, echoed as `meta.projectDimension.filter`. */
  keys: string[];
  matches: (place: MockProjectPlace) => boolean;
}

/** Mirrors `BehaviorProjectFilter::from_request`: a missing or empty filter selects everything. */
function mockProjectFilter(projects: unknown): MockProjectFilter | null {
  if (projects === undefined || projects === null) return null;
  if (!Array.isArray(projects) || projects.some((key) => typeof key !== 'string')) throw new Error('invalid projects filter');
  if (projects.length === 0) return null;
  const keys = [...new Set(projects as string[])].sort(compareMockCodeUnits);
  const unattributed = keys.includes(BEHAVIOR_UNATTRIBUTED_FILTER_KEY);
  return { keys, matches: (place) => ('project' in place ? keys.includes(place.project.key) : unattributed) };
}

// Mirrors Rust `BEHAVIOR_PROJECT_LIMIT` and the output order of `UnattributedReason::ALL`.
const MOCK_BEHAVIOR_PROJECT_LIMIT = 50;
const MOCK_UNATTRIBUTED_REASONS: readonly BehaviorUnattributedReason[] = ['unsupported_source', 'unresolved', 'pending', 'missing_session'];

interface MockProjectTotals {
  tokens: number;
  requests: number;
  sessionCount: number;
  /** Per-record estimates; any unavailable record makes it null (GLB-01). */
  cost: number | null;
  tools: Map<string, number>;
}

function emptyMockProjectTotals(): MockProjectTotals {
  return { tokens: 0, requests: 0, sessionCount: 0, cost: 0, tools: new Map() };
}

function addMockProjectRecord(totals: MockProjectTotals, tool: string, tokens: number, cost: number) {
  totals.tokens += tokens;
  totals.requests += 1;
  totals.cost = addMockBehaviorCost(totals.cost, cost);
  totals.tools.set(tool, (totals.tools.get(tool) ?? 0) + tokens);
}

/** Mirrors `BehaviorProjectTotals::absorb`: sums for the remainder and the unattributed total. */
function absorbMockProjectTotals(sum: MockProjectTotals, part: MockProjectTotals) {
  sum.tokens += part.tokens;
  sum.requests += part.requests;
  sum.sessionCount += part.sessionCount;
  sum.cost = part.cost === null ? null : addMockBehaviorCost(sum.cost, part.cost);
}

/** Mirrors `insert_behavior_projects`: shares over `summary.tokens`, unavailable (null) when it is 0. */
function mockProjectFields(
  projects: Map<string, { ref: BehaviorProjectRef; totals: MockProjectTotals }>,
  unattributed: Map<BehaviorUnattributedReason, MockProjectTotals>,
  totalTokens: number,
) {
  const share = (tokens: number) => (totalTokens > 0 ? tokens / totalTokens : null);
  const ranked = [...projects.values()].sort((a, b) => b.totals.tokens - a.totals.tokens || compareMockCodeUnits(a.ref.key, b.ref.key));
  const rest = ranked.slice(MOCK_BEHAVIOR_PROJECT_LIMIT);
  const remainder = emptyMockProjectTotals();
  for (const { totals } of rest) absorbMockProjectTotals(remainder, totals);
  const all = emptyMockProjectTotals();
  const reasons: BehaviorUnattributedReasonRow[] = [];
  for (const reason of MOCK_UNATTRIBUTED_REASONS) {
    const totals = unattributed.get(reason) ?? emptyMockProjectTotals();
    absorbMockProjectTotals(all, totals);
    if (totals.requests === 0) continue;
    reasons.push({
      reason,
      tokens: totals.tokens,
      requests: totals.requests,
      // Records without a session ID are no sessions: the count is unknown, never 0.
      sessionCount: reason === 'missing_session' ? null : totals.sessionCount,
      share: share(totals.tokens),
    });
  }
  return {
    projects: ranked.slice(0, MOCK_BEHAVIOR_PROJECT_LIMIT).map(({ ref, totals }) => ({
      ...ref,
      tokens: totals.tokens,
      requests: totals.requests,
      sessionCount: totals.sessionCount,
      cost: totals.cost,
      share: share(totals.tokens),
      tools: [...totals.tools].map(([id, tokens]) => ({ id, tokens }))
        .sort((a, b) => b.tokens - a.tokens || compareMockCodeUnits(a.id, b.id)),
    })),
    projectLimit: MOCK_BEHAVIOR_PROJECT_LIMIT,
    projectsTruncated: rest.length > 0,
    projectsRemainder: rest.length === 0 ? null : {
      tokens: remainder.tokens,
      requests: remainder.requests,
      sessionCount: remainder.sessionCount,
      cost: remainder.cost,
      share: share(remainder.tokens),
      projectCount: rest.length,
    },
    unattributed: {
      tokens: all.tokens,
      requests: all.requests,
      sessionCount: all.sessionCount,
      cost: all.cost,
      share: share(all.tokens),
      reasons,
    },
  };
}

/** Options of the behavior mock for the contract v1.2 project dimension. */
export interface MockBehaviorProjectOptions {
  /** Project index the command reads; without one the dimension is off (`disabled`). */
  index?: MockProjectIndex;
  /** The request's optional `projects` filter. */
  projects?: unknown;
  /**
   * The index cannot be read (R-32): the reply omits `meta.projectDimension`
   * and a filter fails with `project_dimension_unavailable`.
   */
  unreadable?: boolean;
}

// Browser preview uses the same mock ledger rows as the dashboard. The native
// implementation reads SQLite directly and is the source of truth in the app.
// `ledger` lets tests and preview scenarios analyse other rows (newest first,
// like `mockHistory`) with the same rules; `projectOptions` supplies the
// project index and the request's project filter (contract v1.2).
export function behaviorAnalysisForQuery(
  rawQuery: Record<string, unknown>,
  ledger: StatsData['history'] = mockHistory,
  projectOptions: MockBehaviorProjectOptions = {},
) {
  const range = normalizeMockRange(rawQuery.range);
  const bounds = range === 'custom' ? mockCustomBounds(rawQuery) : null;
  if (range === 'custom' && !bounds) throw new Error('custom range requires start and end');
  const query = normalizeStatsQuery({
    ...rawQuery,
    range,
    timezone: typeof rawQuery.timezone === 'string' ? rawQuery.timezone : currentTimezoneForMock(),
    tokenMode: rawQuery.tokenMode ?? 'effective',
  });
  const timeZone = query.timezone;
  const projectUnreadable = projectOptions.unreadable === true;
  const projectState = projectOptions.index?.state ?? 'disabled';
  const projectView = projectOptions.index && !projectUnreadable ? mockProjectView(projectOptions.index) : null;
  const projectFilter = mockProjectFilter(projectOptions.projects);
  // Like the native command: a filter the dimension cannot apply is an error, never an unfiltered answer.
  if (projectFilter && projectUnreadable) throw new Error(BEHAVIOR_PROJECT_DIMENSION_UNAVAILABLE);
  if (projectFilter && !projectView) throw new Error(BEHAVIOR_PROJECT_DIMENSION_DISABLED);
  const recordPlace = (view: MockProjectView, row: StatsData['history'][number]): MockProjectPlace => {
    const sessionId = mockBehaviorSessionId(row.sessionId);
    return sessionId ? view.place(row.tool, sessionId) : { reason: 'missing_session' };
  };
  const inProjectFilter = (row: StatsData['history'][number]) => (
    !projectFilter || !projectView || projectFilter.matches(recordPlace(projectView, row))
  );
  const window = mockBehaviorWindow(range, rawQuery, timeZone);
  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();
  const windowRows = filterMockHistory(ledger.filter((row) => {
    const timestamp = new Date(row.timestamp).getTime();
    return timestamp >= windowStart && timestamp <= windowEnd;
  }), query);
  // Coverage ignores the project filter; the filter then applies to every dimension.
  const coverage = { indexed: new Set<string>(), pending: new Set<string>() };
  if (projectView) {
    for (const row of windowRows) {
      const sessionId = mockBehaviorSessionId(row.sessionId);
      if (!sessionId) continue;
      const place = projectView.place(row.tool, sessionId);
      const pending = 'reason' in place && place.reason === 'pending';
      (pending ? coverage.pending : coverage.indexed).add(mockProjectIndexKey(row.tool, sessionId));
    }
  }
  const rows = projectFilter ? windowRows.filter(inProjectFilter) : windowRows;
  const rangeTruncated = window.capped
    && filterMockHistory(ledger, query).some((row) => new Date(row.timestamp).getTime() < windowStart && inProjectFilter(row));
  const oldestRow = rows[rows.length - 1];
  const newestRow = rows[0];
  const wallDay = (value: Date) => mockWallDay(mockWallClock(value, timeZone));
  const firstDay = range !== 'all' || rangeTruncated
    ? wallDay(window.start)
    : wallDay(oldestRow ? new Date(oldestRow.timestamp) : mockNow);
  // Rust keeps the end on or after the start (a custom range starting in the future).
  const endDay = wallDay(window.end);
  const lastDay = endDay < firstDay ? firstDay : endDay;
  const tools = new Map<string, { id: string; tokens: number; requests: number; sessions: Set<string>; unknownSessionRecords: number }>();
  const sessions = new Map<string, MockBehaviorSession>();
  const dayHours = new Map<string, { date: string; hour: number; tokens: number; requests: number }>();
  const modelHours = new Map<string, { hour: number; model: string; tokens: number; requests: number }>();
  const modelDays = new Map<string, { date: string; model: string; tokens: number; requests: number }>();
  const modelSizes = new Map<string, number[]>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let unknownSessionRecords = 0;
  let unknownSessionTokens = 0;
  let totalCost: number | null = 0;
  const activeDays = new Set<string>();
  const projectTotals = new Map<string, { ref: BehaviorProjectRef; totals: MockProjectTotals }>();
  const unattributedTotals = new Map(MOCK_UNATTRIBUTED_REASONS.map(
    (reason): [BehaviorUnattributedReason, MockProjectTotals] => [reason, emptyMockProjectTotals()],
  ));
  const totalsFor = (place: MockProjectPlace): MockProjectTotals => {
    if ('reason' in place) return unattributedTotals.get(place.reason) ?? emptyMockProjectTotals();
    const entry = projectTotals.get(place.project.key) ?? { ref: place.project, totals: emptyMockProjectTotals() };
    projectTotals.set(place.project.key, entry);
    return entry.totals;
  };
  for (const row of rows) {
    const clock = mockWallClock(new Date(row.timestamp), timeZone);
    const date = mockWallDay(clock);
    const wallTime = formatMockWallTimestamp(clock);
    const hour = clock.hour;
    const tokens = row.inputTokens + row.outputTokens;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    cachedTokens += row.cachedTokens;
    totalCost = addMockBehaviorCost(totalCost, row.cost);
    activeDays.add(date);
    const tool = tools.get(row.tool) ?? { id: row.tool, tokens: 0, requests: 0, sessions: new Set<string>(), unknownSessionRecords: 0 };
    tool.tokens += tokens;
    tool.requests += 1;
    const sessionId = mockBehaviorSessionId(row.sessionId);
    let place: MockProjectPlace | null = null;
    if (sessionId) {
      tool.sessions.add(sessionId);
      const sessionKey = `${row.tool}|${sessionId}`;
      const session = sessions.get(sessionKey)
        ?? { id: sessionId, tool: row.tool, tokens: 0, requests: 0, cost: 0, firstAt: wallTime, lastAt: wallTime, models: new Map(),
          place: projectView ? projectView.place(row.tool, sessionId) : null };
      session.tokens += tokens;
      session.requests += 1;
      session.cost = addMockBehaviorCost(session.cost, row.cost);
      if (wallTime < session.firstAt) session.firstAt = wallTime;
      if (wallTime > session.lastAt) session.lastAt = wallTime;
      const usage = session.models.get(row.model) ?? { tokens: 0, records: 0 };
      usage.tokens += tokens;
      usage.records += 1;
      session.models.set(row.model, usage);
      sessions.set(sessionKey, session);
      place = session.place;
    } else {
      tool.unknownSessionRecords += 1;
      unknownSessionRecords += 1;
      unknownSessionTokens += tokens;
      if (projectView) place = { reason: 'missing_session' };
    }
    if (place) addMockProjectRecord(totalsFor(place), row.tool, tokens, row.cost);
    tools.set(row.tool, tool);
    const dayHourKey = `${date}:${hour}`;
    const dayHour = dayHours.get(dayHourKey) ?? { date, hour, tokens: 0, requests: 0 };
    dayHour.tokens += tokens;
    dayHour.requests += 1;
    dayHours.set(dayHourKey, dayHour);
    const modelHourKey = `${row.model}:${hour}`;
    const modelHour = modelHours.get(modelHourKey) ?? { hour, model: row.model, tokens: 0, requests: 0 };
    modelHour.tokens += tokens;
    modelHour.requests += 1;
    modelHours.set(modelHourKey, modelHour);
    const modelDayKey = `${date}:${row.model}`;
    const modelDay = modelDays.get(modelDayKey) ?? { date, model: row.model, tokens: 0, requests: 0 };
    modelDay.tokens += tokens;
    modelDay.requests += 1;
    modelDays.set(modelDayKey, modelDay);
    const sizes = modelSizes.get(row.model) ?? [];
    sizes.push(tokens);
    modelSizes.set(row.model, sizes);
  }
  // Every real session belongs to exactly one project or unattributed reason.
  for (const session of sessions.values()) {
    if (session.place) totalsFor(session.place).sessionCount += 1;
  }
  const orderedSessions = [...sessions.values()].sort((a, b) => b.tokens - a.tokens
    || compareMockCodeUnits(a.tool, b.tool) || compareMockCodeUnits(a.id, b.id));
  const requestSizes = [...modelSizes.entries()].map(([model, values]) => {
    const sorted = values.sort((a, b) => a - b);
    return { model, requests: sorted.length,
      p50: mockPercentileNearestRank(sorted, 0.5), p90: mockPercentileNearestRank(sorted, 0.9),
      max: sorted[sorted.length - 1] ?? 0, bins: mockRequestSizeBins(sorted) };
  }).sort((a, b) => b.requests - a.requests || compareMockCodeUnits(a.model, b.model));
  // Contract v1.2: only the state while the dimension is off; coverage, filter and project fields while it collects;
  // no `projectDimension` at all when the index cannot be read (R-32), exactly like a v1.1 reply.
  const projectDimension = projectView
    ? { state: projectView.state, indexedSessions: coverage.indexed.size, pendingSessions: coverage.pending.size,
      filter: projectFilter?.keys ?? [], ...(projectView.state === 'failed' ? { lastFailure: projectView.lastFailure } : {}) }
    : { state: projectState };
  const sessionProject = (place: MockProjectPlace | null) => {
    if (!place) return {};
    return 'reason' in place ? { project: null, projectReason: place.reason } : { project: place.project };
  };
  return {
    meta: { source: 'local', complete: true, range, start: firstDay, end: lastDay,
      timezone: query.timezone, recordCount: rows.length,
      firstRecordAt: oldestRow ? formatMockWallTimestamp(mockWallClock(new Date(oldestRow.timestamp), timeZone)) : null,
      lastRecordAt: newestRow ? formatMockWallTimestamp(mockWallClock(new Date(newestRow.timestamp), timeZone)) : null,
      sessionLimit: 100, sessionsTruncated: orderedSessions.length > 100,
      rangeDayLimit: MOCK_BEHAVIOR_RANGE_DAY_LIMIT, rangeTruncated, ...(projectUnreadable ? {} : { projectDimension }) },
    summary: { tokens: inputTokens + outputTokens, inputTokens, outputTokens, cachedTokens,
      requests: rows.length, activeDays: activeDays.size, toolCount: tools.size,
      sessionCount: sessions.size, modelCount: modelSizes.size, unknownSessionRecords, unknownSessionTokens,
      totalCost, costComplete: totalCost !== null },
    tools: [...tools.values()].map(({ sessions: toolSessions, ...tool }) => ({ ...tool, sessionCount: toolSessions.size }))
      .sort((a, b) => b.tokens - a.tokens || compareMockCodeUnits(a.id, b.id)),
    sessions: orderedSessions.slice(0, 100).map(({ models, place, ...session }) => ({
      ...session, topModel: mockTopModel(models), ...sessionProject(place),
    })),
    dayHours: [...dayHours.values()].sort((a, b) => compareMockCodeUnits(a.date, b.date) || a.hour - b.hour),
    modelHours: [...modelHours.values()].sort((a, b) => a.hour - b.hour || compareMockCodeUnits(a.model, b.model)),
    modelDays: [...modelDays.values()].sort((a, b) => compareMockCodeUnits(a.date, b.date) || compareMockCodeUnits(a.model, b.model)),
    requestSizes,
    ...(projectView ? mockProjectFields(projectTotals, unattributedTotals, inputTokens + outputTokens) : {}),
  };
}

function facet(items: StatsData['history'], key: 'tool' | 'model' | 'machineId') {
  const counts = new Map<string, number>();
  items.forEach((item) => {
    const value = item[key] || 'localhost';
    counts.set(String(value), (counts.get(String(value)) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function filterMockHistory(items: StatsData['history'], query: StatsQueryContext) {
  return items.filter((item) =>
    (query.tools.length === 0 || query.tools.includes(item.tool))
    && (query.models.length === 0 || query.models.includes(item.model))
    && (query.machines.length === 0 || query.machines.includes(item.machineId))
    && matchesLiteralQuerySearch(query.search, [item.tool, item.model, item.machineId, item.sessionId]));
}

function mockQueryFingerprint(query: StatsQueryContext, entity?: EntitySelector) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(statsQueryKey(query, entity))) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function parseMockCursor(rawCursor: unknown, expectedFingerprint: string) {
  if (rawCursor === null || rawCursor === undefined || rawCursor === '') return 0;
  if (typeof rawCursor !== 'string' || !/^mock:[0-9a-f]{8}:(0|[1-9]\d*)$/.test(rawCursor)) {
    throw new Error('invalid mock cursor');
  }
  const [, fingerprint, offset] = rawCursor.split(':');
  if (fingerprint !== expectedFingerprint) throw new Error('mock cursor query mismatch');
  const parsed = Number(offset);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid mock cursor');
  return parsed;
}

function queryWithEntity(query: StatsQueryContext, entity?: EntitySelector): StatsQueryContext {
  if (!entity) return query;
  return entity.kind === 'tool'
    ? { ...query, tools: [entity.id] }
    : { ...query, models: [entity.id] };
}

function detailsResponse(query: Record<string, unknown> = {}, entity?: EntitySelector): UsageDetailsResponse {
  const range = normalizeMockRange(query.range);
  // T10.185: cloud custom is served like local custom (see `statsForQuery`).
  const bounds = range === 'custom' ? mockCustomBounds(query) : null;
  const canonicalQuery = normalizeStatsQuery({
    ...query,
    range,
    timezone: typeof query.timezone === 'string' ? query.timezone : currentTimezoneForMock(),
    tokenMode: query.tokenMode ?? 'effective',
  });
  const effectiveQuery = queryWithEntity(canonicalQuery, entity);
  const allInRange = historyForRange(range, bounds);
  const filtered = filterMockHistory(allInRange, effectiveQuery);
  const fingerprint = mockQueryFingerprint(canonicalQuery, entity);
  const cursorIndex = parseMockCursor(query.cursor, fingerprint);
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
  const items = filtered.slice(cursorIndex, cursorIndex + limit);
  const nextIndex = cursorIndex + items.length;
  const hasMore = nextIndex < filtered.length;
  return {
    items,
    nextCursor: hasMore ? `mock:${fingerprint}:${nextIndex}` : null,
    hasMore,
    totalCount: filtered.length,
    filteredSummary: summarize(filtered),
    availableFilters: {
      tools: facet(filterMockHistory(allInRange, queryWithEntity({ ...canonicalQuery, tools: [] }, entity)), 'tool'),
      models: facet(filterMockHistory(allInRange, queryWithEntity({ ...canonicalQuery, models: [] }, entity)), 'model'),
      machines: facet(filterMockHistory(allInRange, queryWithEntity({ ...canonicalQuery, machines: [] }, entity)), 'machineId'),
    },
    granularity: 'request',
    meta: {
      contractVersion: 2,
      generatedAt: mockTimestamp,
      timezone: currentTimezoneForMock(),
      query: queryEcho(canonicalQuery),
      ...(entity ? { entity } : {}),
    },
  };
}

function currentTimezoneForMock() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function composition(items: StatsData['history'], key: 'tool' | 'model' | 'machineId') {
  const groups = new Map<string, StatsData['history']>();
  items.forEach((item) => groups.set(item[key] || 'localhost', [...(groups.get(item[key] || 'localhost') || []), item]));
  return [...groups.entries()].map(([value, rows]) => {
    const summary = summarize(rows);
    return { value, tokens: summary.totalTokens, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens, cachedTokens: summary.cachedTokens, cacheWriteTokens: summary.cacheWriteTokens, requests: summary.totalRequests, cost: summary.totalCost };
  }).sort((a, b) => b.tokens - a.tokens);
}

function comparisonDelta(current: number, previous: number): UsageComparison['delta']['tokens'] {
  const absolute = Number((current - previous).toFixed(4));
  if (previous === 0) {
    return {
      absolute,
      percent: null,
      direction: current > 0 ? 'new' : 'flat',
    };
  }
  return {
    absolute,
    percent: Number((absolute / previous * 100).toFixed(2)),
    direction: absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat',
  };
}

function entityHeatmap(rows: StatsData['history']) {
  return rows.reduce<Record<string, number>>((result, item) => {
    const date = formatDateBucket(new Date(item.timestamp));
    result[date] = (result[date] || 0) + item.inputTokens + item.outputTokens;
    return result;
  }, {});
}

function entityActivity(rows: StatsData['history']) {
  const activeDates = [...new Set(rows.map((item) => formatDateBucket(new Date(item.timestamp))))].sort();
  const chronologicalRows = [...rows].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return {
    activeDays: activeDates.length,
    firstSeenAt: chronologicalRows[0]?.timestamp || null,
    lastSeenAt: chronologicalRows[chronologicalRows.length - 1]?.timestamp || null,
  };
}

function normalizeMockEntityRequest(query: Record<string, unknown>) {
  const queryInput = { ...query };
  if (query.entity !== undefined) {
    return { entity: normalizeEntitySelector(query.entity), queryInput };
  }
  const legacyModel = typeof query.model === 'string' && query.model ? query.model : null;
  const legacyTool = typeof query.tool === 'string' && query.tool ? query.tool : null;
  if (!legacyModel && !legacyTool) throw new Error('entity selector is required');
  if (legacyModel) {
    delete queryInput.model;
    delete queryInput.models;
    return { entity: normalizeEntitySelector({ kind: 'model', id: legacyModel }), queryInput };
  }
  delete queryInput.tool;
  delete queryInput.tools;
  return { entity: normalizeEntitySelector({ kind: 'tool', id: legacyTool }), queryInput };
}

function entityResponse(query: Record<string, unknown> = {}): EntityDashboard {
  const range = normalizeMockRange(query.range);
  // T10.185: cloud custom is served like local custom (see `statsForQuery`).
  const bounds = range === 'custom' ? mockCustomBounds(query) : null;
  const { entity, queryInput } = normalizeMockEntityRequest(query);
  const canonicalQuery = normalizeStatsQuery({
    ...queryInput,
    range,
    timezone: typeof query.timezone === 'string' ? query.timezone : currentTimezoneForMock(),
    tokenMode: query.tokenMode ?? 'effective',
  });
  if (entity.kind === 'tool' && canonicalQuery.tools.length > 0) throw new Error('tool entity cannot also filter tools');
  if (entity.kind === 'model' && canonicalQuery.models.length > 0) throw new Error('model entity cannot also filter models');
  const effectiveQuery = queryWithEntity(canonicalQuery, entity);
  const details = detailsResponse({ ...canonicalQuery, limit: 20, cursor: null }, entity);
  const tool = entity.kind === 'tool' ? entity.id : canonicalQuery.tools.length === 1 ? canonicalQuery.tools[0] : null;
  const model = entity.kind === 'model' ? entity.id : null;
  const rows = filterMockHistory(historyForRange(range, bounds), effectiveQuery);
  const yearRows = filterMockHistory(historyForRange('year'), effectiveQuery);
  const comparison = mockRangeComparable(range)
    ? buildComparison(range, effectiveQuery, bounds)
    : null;
  const scopedHeatmap = entityHeatmap(yearRows);
  const peakPoint = comparison?.current.series.reduce<UsageComparison['current']['series'][number] | null>(
    (peak, point) => !peak || point.tokens > peak.tokens ? point : peak,
    null,
  );
  return {
    entity: { kind: entity.kind, tool, model },
    summary: details.filteredSummary,
    comparison,
    composition: { tools: composition(rows, 'tool'), models: composition(rows, 'model'), machines: composition(rows, 'machineId') },
    heatmap: scopedHeatmap,
    peak: details.filteredSummary.totalTokens > 0 && peakPoint
      ? { bucket: peakPoint.bucket, tokens: peakPoint.tokens, requests: peakPoint.requests, cost: peakPoint.cost }
      : undefined,
    activity: entityActivity(rows),
    historyPage: details,
    granularity: 'request',
    meta: {
      contractVersion: 2,
      generatedAt: mockTimestamp,
      timezone: currentTimezoneForMock(),
      query: queryEcho(canonicalQuery),
      entity,
    },
  };
}

let mockCustomEndpoints: CustomQuotaEndpointView[] = [
  {
    id: '0123456789abcdef01234567',
    providerId: 'company-openapi-0123456789abcdef01234567',
    displayName: '研发账号额度',
    url: 'https://your-gateway.example.com/v1/me/quota',
    enabled: true,
    apiKeyConfigured: true,
    hasApiKey: true,
    schemaVerified: true,
  },
  {
    id: '89abcdef0123456789abcdef',
    providerId: 'company-openapi-89abcdef0123456789abcdef',
    displayName: '生产账号额度',
    url: 'https://quota.example.com/v1/me/quota',
    enabled: true,
    apiKeyConfigured: true,
    hasApiKey: true,
    schemaVerified: true,
  },
];

/**
 * 设置页额度来源状态卡预览（T10.283，`?quotaSources=<scenario>`）。默认三个来源都已安装；
 * `failing` 演示已连接、读取失败（保留旧值）与需在原应用登录；`missing` 演示未安装与待授权。
 */
type MockQuotaSourceScenario = 'default' | 'failing' | 'missing';

function mockQuotaSourceScenario(): MockQuotaSourceScenario {
  if (typeof window === 'undefined') return 'default';
  const value = new URLSearchParams(window.location.search).get('quotaSources');
  return value === 'failing' || value === 'missing' ? value : 'default';
}

/** 与 Rust `AppSettings::sanitized` 一致：两个旧 Claude 字段由总开关派生。 */
function normalizeMockClaudeToggles(settings: AppSettings): AppSettings {
  return {
    ...settings,
    quota_claude_statusline_enabled: settings.quota_claude_enabled,
    quota_claude_codexbar_enabled: settings.quota_claude_enabled && settings.quota_claude_codexbar_enabled,
  };
}

const MOCK_QUOTA_SOURCE_SETTINGS: Record<MockQuotaSourceScenario, Partial<AppSettings>> = {
  default: {},
  failing: { quota_codex_local_enabled: true, quota_claude_enabled: true, quota_antigravity_local_enabled: true },
  missing: { quota_claude_enabled: true },
};

let mockSettings: AppSettings = normalizeMockClaudeToggles({
  ...DEFAULT_SETTINGS,
  ...MOCK_QUOTA_SOURCE_SETTINGS[mockQuotaSourceScenario()],
  quota_custom_endpoints: mockCustomEndpoints.map(({ id, displayName, url, enabled, apiKeyConfigured }) => ({
    id,
    displayName,
    url,
    enabled,
    apiKeyConfigured,
  })),
  model_access_enabled: true,
  model_access_version: 1,
});
let mockQuotaSyncStatus: QuotaSyncStatus = { enabled: false, state: 'disabled' };
interface MockBudgetRule {
  id: string;
  enabled: boolean;
  period: 'day' | 'week' | 'month';
  metric: 'cost' | 'tokens';
  scopeKind: 'all' | 'tool' | 'model' | 'provider';
  scopeId: string;
  limit: number;
  warnPercent: number;
}
let mockBudgetSettings: { notify: boolean; rules: MockBudgetRule[] } = { notify: false, rules: [] };
let mockPeriodReportSettings = { weekly: true, monthly: false };

/** 与 `budget.rs` 同一读法：从同一份本机统计取今日 / 本周 / 本月的合计或分组行。 */
function mockBudgetStatus() {
  const range = { day: 'today', week: 'week', month: 'month' } as const;
  const snapshot = (period: MockBudgetRule['period']) => statsForQuery({ range: range[period], tokenMode: 'effective' }) as unknown as Record<string, unknown>;
  const month = snapshot('month');
  const group = (stats: Record<string, unknown>, key: string) =>
    (stats[key] && typeof stats[key] === 'object' ? stats[key] : null) as Record<string, { total?: number; cost?: number | null }> | null;
  const statuses = mockBudgetSettings.rules.filter((rule) => rule.enabled).map((rule) => {
    const stats = snapshot(rule.period);
    let used: number | null;
    if (rule.scopeKind === 'all') {
      const summary = stats.summary as { totalTokens?: number; totalCost?: number | null };
      used = rule.metric === 'cost' ? summary.totalCost ?? null : summary.totalTokens ?? null;
    } else {
      const rows = group(stats, rule.scopeKind === 'tool' ? 'tools' : rule.scopeKind === 'model' ? 'models' : 'providers');
      const row = rows?.[rule.scopeId];
      used = !rows ? null : !row ? 0 : rule.metric === 'cost' ? row.cost ?? null : row.total ?? null;
    }
    const percent = used === null ? null : Math.round((used / rule.limit) * 1000) / 10;
    const level = used === null ? 'unavailable' : used >= rule.limit ? 'over' : used * 100 >= rule.limit * rule.warnPercent ? 'warn' : 'ok';
    return { ruleId: rule.id, periodStart: '', used, limit: rule.limit, percent, level };
  });
  const keys = (key: string) => Object.keys(group(month, key) ?? {}).sort();
  return {
    generatedAt: new Date().toISOString(),
    statuses,
    choices: {
      tools: keys('tools'),
      models: keys('models'),
      providers: keys('providers'),
      providersAvailable: group(month, 'providers') !== null,
    },
  };
}

let mockQuotaAlertSettings = { enabled: false, thresholds: [20] as number[] };
let mockUnsyncedRecords = 12;
let mockCloudAuthenticated = true;
// `?fresh=1` previews a first launch: empty ledger, no cloud account and model
// access off. The first `refresh_scan` puts the sample ledger back, so the
// onboarding steps can be walked through end to end.
let mockFreshInstall = false;
let mockFreshLedger: StatsData['history'] = [];
// T10.282：Claude 一键接入默认停在「未接入」，写入后切到已接入并留下备份。
let mockClaudeStatuslineWired = false;
let mockClaudeBackup: { createdAt: string; originalExisted: boolean; restorableWithoutForce: boolean } | null = null;
const mockClaudeHelperCommand = "'/Applications/TokenLedger.app/Contents/MacOS/tokenledger' --claude-statusline";

function syncMockCustomSettings() {
  mockSettings = {
    ...mockSettings,
    quota_custom_endpoints: mockCustomEndpoints.map(({ id, displayName, url, enabled, apiKeyConfigured }) => ({
      id,
      displayName,
      url,
      enabled,
      apiKeyConfigured,
    })),
  };
}

// 订阅设置（T10.188）：与 mockSettings 分开存放，通用 save_settings 覆盖不了它；
// 校验用契约模块里 Rust 规则的前端镜像，「今天」取 mockNow；保存与删除全部都按 revision 条件执行。
function emptyMockCostProfile(): CostProfile {
  return { revision: 0, plans: [], toolBillingModes: {}, cnyPerUsd: COST_PROFILE_DEFAULT_CNY_PER_USD };
}

let mockCostProfile = emptyMockCostProfile();
let mockCostPlanSequence = 0;

/** 与 IPC 一样经过一次 JSON：NaN 变 null、值为 undefined 的字段消失，返回值也不与内部状态共享。 */
function mockIpcJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function nextMockCostPlanId(taken: Set<string | null>): string {
  let id = '';
  do {
    mockCostPlanSequence += 1;
    id = `sub-${mockCostPlanSequence.toString(16).padStart(16, '0')}`;
  } while (taken.has(id));
  taken.add(id);
  return id;
}

/** 与原生端一样，参数缺失或类型不对时整个调用失败（Tauri 的参数反序列化错误）。 */
function invalidMockArgs(command: string, name: string): Promise<never> {
  return Promise.reject(`invalid args \`${name}\` for command ${command}`);
}

function isMockRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 写入新的订阅设置（其 revision 忽略），revision 加一。 */
function storeMockCostProfile(next: CostProfile): CostProfileSaveResult {
  mockCostProfile = { ...next, revision: mockCostProfile.revision + 1 };
  return { status: 'saved', profile: mockIpcJson(mockCostProfile), cleared: isCostProfileCleared(mockCostProfile) };
}

function saveMockCostProfile(profile: unknown, expectedRevision: unknown): CostProfileSaveResult | Promise<never> {
  if (profile === undefined) return invalidMockArgs('save_cost_profile', 'profile');
  if (!isMockRevision(expectedRevision)) return invalidMockArgs('save_cost_profile', 'expectedRevision');
  if (expectedRevision !== mockCostProfile.revision) return { status: 'conflict', currentRevision: mockCostProfile.revision };
  // null 不是订阅设置：与原生端一样报 profile 的 required，不清空（删除全部走 clear_cost_profile）。
  const checked = checkCostProfileInput(mockIpcJson(profile), mockCostProfile, formatDateBucket(mockNow));
  if (!checked.profile) return { status: 'invalid', errors: checked.errors };
  const taken = new Set([...mockCostProfile.plans, ...checked.profile.plans].map((plan) => plan.id));
  const plans = checked.profile.plans.map((plan) => ({ ...plan, id: plan.id ?? nextMockCostPlanId(taken) }));
  return storeMockCostProfile({ ...checked.profile, revision: 0, plans });
}

function clearMockCostProfile(expectedRevision: unknown): CostProfileSaveResult | Promise<never> {
  if (!isMockRevision(expectedRevision)) return invalidMockArgs('clear_cost_profile', 'expectedRevision');
  if (expectedRevision !== mockCostProfile.revision) return { status: 'conflict', currentRevision: mockCostProfile.revision };
  return storeMockCostProfile(emptyMockCostProfile());
}

function mockCustomQuotaResponse(): QuotaProviderEnvelope[] {
  return mockCustomEndpoints
    .filter((endpoint) => endpoint.enabled)
    .map((endpoint, index) => {
      const usages = index === 0 ? [26, 41, 58] : [17, 34, 63];
      const windows = [
        { windowId: 'key-daily', windowLabel: 'Key 今日额度', used: usages[0], windowMinutes: 1_440 },
        { windowId: 'user-daily', windowLabel: '用户今日额度', used: usages[1], windowMinutes: 1_440 },
        { windowId: 'user-monthly', windowLabel: '用户本月额度', used: usages[2], windowMinutes: 43_200 },
      ];
      return {
        schemaVersion: 1,
        providerId: endpoint.providerId,
        displayName: endpoint.displayName,
        scope: 'api-organization',
        mode: 'automatic',
        capability: 'plan-dependent',
        status: 'ok',
        windows: windows.map((window) => ({
          providerId: endpoint.providerId,
          windowId: window.windowId,
          windowLabel: window.windowLabel,
          scope: 'api-organization',
          source: 'official-api',
          status: 'ok',
          used: window.used,
          limit: 100,
          remaining: 100 - window.used,
          unit: 'percent',
          windowMinutes: window.windowMinutes,
          observedAt: mockTimestamp,
          fetchedAt: mockTimestamp,
          staleAfterSeconds: 300,
        })),
      } satisfies QuotaProviderEnvelope;
    });
}

function quotaResponse(): QuotaProviderEnvelope[] {
  const codex: QuotaProviderEnvelope = mockSettings.quota_codex_local_enabled ? {
    schemaVersion: 1,
    providerId: 'openai-codex-local',
    displayName: 'Codex account usage',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'stable',
    status: 'ok',
    windows: [
      { providerId: 'openai-codex-local', windowId: 'codex:primary', windowLabel: '5 小时窗口', accountLabel: 'Plus', scope: 'consumer-subscription', source: 'local-authorized', status: 'ok', used: 38, limit: 100, remaining: 62, unit: 'percent', windowMinutes: 300, resetsAt: mockIsoAfter(7_200_000), observedAt: mockTimestamp, fetchedAt: mockTimestamp, staleAfterSeconds: 900 },
      { providerId: 'openai-codex-local', windowId: 'codex:secondary', windowLabel: '周窗口', accountLabel: 'Plus', scope: 'consumer-subscription', source: 'local-authorized', status: 'ok', used: 64, limit: 100, remaining: 36, unit: 'percent', windowMinutes: 10_080, resetsAt: mockIsoAfter(259_200_000), observedAt: mockTimestamp, fetchedAt: mockTimestamp, staleAfterSeconds: 900 },
      { providerId: 'openai-codex-local', windowId: 'codex:credits', windowLabel: 'Credits', accountLabel: 'Plus', scope: 'consumer-subscription', source: 'local-authorized', status: 'ok', remaining: 12.5, unit: 'credits', observedAt: mockTimestamp, fetchedAt: mockTimestamp, staleAfterSeconds: 900 },
    ],
  } : {
    schemaVersion: 1,
    providerId: 'openai-codex-local',
    displayName: 'Codex local usage',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'stable',
    status: 'auth-required',
    windows: [],
    reasonCode: 'local_authorization_required',
    action: { kind: 'open-settings', labelKey: 'quota.action.enableCodexLocal', value: 'codex-local' },
  };
  const claudeEnabled = mockSettings.quota_claude_enabled;
  const claude: QuotaProviderEnvelope = claudeEnabled ? {
    schemaVersion: 1,
    providerId: 'anthropic-claude-consumer',
    displayName: 'Claude consumer usage',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: mockSettings.quota_claude_codexbar_enabled ? 'experimental' : 'plan-dependent',
    status: 'ok',
    windows: [
      { providerId: 'anthropic-claude-consumer', windowId: 'five-hour', windowLabel: '5 小时窗口', accountLabel: 'Claude Pro / Max', scope: 'consumer-subscription', source: 'local-authorized', status: 'ok', used: 23.5, limit: 100, remaining: 76.5, unit: 'percent', windowMinutes: 300, resetsAt: mockIsoAfter(5_400_000), observedAt: mockTimestamp, fetchedAt: mockTimestamp, staleAfterSeconds: 900 },
      { providerId: 'anthropic-claude-consumer', windowId: 'seven-day', windowLabel: '7 天窗口', accountLabel: 'Claude Pro / Max', scope: 'consumer-subscription', source: 'local-authorized', status: 'ok', used: 41.2, limit: 100, remaining: 58.8, unit: 'percent', windowMinutes: 10_080, resetsAt: mockIsoAfter(259_200_000), observedAt: mockTimestamp, fetchedAt: mockTimestamp, staleAfterSeconds: 900 },
    ],
  } : {
    schemaVersion: 1,
    providerId: 'anthropic-claude-consumer',
    displayName: 'Claude consumer usage',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'plan-dependent',
    status: 'auth-required',
    windows: [],
    reasonCode: 'claude_local_authorization_required',
    action: { kind: 'open-settings', labelKey: 'quota.action.enableClaudeLocal', value: 'claude-local' },
  };
  const antigravity: QuotaProviderEnvelope = mockSettings.quota_antigravity_local_enabled ? {
    schemaVersion: 1,
    providerId: 'google-antigravity-consumer',
    displayName: 'Antigravity',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'experimental',
    status: 'ok',
    windows: [
      { providerId: 'google-antigravity-consumer', windowId: 'antigravity-gemini-five-hour', windowLabel: 'Gemini 5 小时额度', scope: 'consumer-subscription', source: 'local-authorized', status: 'ok', used: 18, limit: 100, remaining: 82, unit: 'percent', windowMinutes: 300, resetsAt: mockIsoAfter(7_200_000), observedAt: mockTimestamp, fetchedAt: mockTimestamp, staleAfterSeconds: 900 },
      { providerId: 'google-antigravity-consumer', windowId: 'antigravity-gemini-weekly', windowLabel: 'Gemini 每周额度', scope: 'consumer-subscription', source: 'local-authorized', status: 'ok', used: 32, limit: 100, remaining: 68, unit: 'percent', windowMinutes: 10_080, resetsAt: mockIsoAfter(259_200_000), observedAt: mockTimestamp, fetchedAt: mockTimestamp, staleAfterSeconds: 900 },
      { providerId: 'google-antigravity-consumer', windowId: 'antigravity-claude-gpt-five-hour', windowLabel: 'Claude / GPT 5 小时额度', scope: 'consumer-subscription', source: 'local-authorized', status: 'ok', used: 27, limit: 100, remaining: 73, unit: 'percent', windowMinutes: 300, resetsAt: mockIsoAfter(7_200_000), observedAt: mockTimestamp, fetchedAt: mockTimestamp, staleAfterSeconds: 900 },
      { providerId: 'google-antigravity-consumer', windowId: 'antigravity-claude-gpt-weekly', windowLabel: 'Claude / GPT 每周额度', scope: 'consumer-subscription', source: 'local-authorized', status: 'ok', used: 45, limit: 100, remaining: 55, unit: 'percent', windowMinutes: 10_080, resetsAt: mockIsoAfter(259_200_000), observedAt: mockTimestamp, fetchedAt: mockTimestamp, staleAfterSeconds: 900 },
    ],
  } : {
    schemaVersion: 1,
    providerId: 'google-antigravity-consumer',
    displayName: 'Antigravity',
    scope: 'consumer-subscription',
    mode: 'automatic',
    capability: 'experimental',
    status: 'auth-required',
    windows: [],
    reasonCode: 'antigravity_local_authorization_required',
    action: { kind: 'open-settings', labelKey: 'quota.action.enableAntigravityLocal', value: 'antigravity-local' },
  };
  return [...applyMockQuotaSourceScenario([codex, claude, antigravity]), ...mockCustomQuotaResponse(), ...mockBalanceResponse(), ...mockExperimentalPlanResponse()];
}

// 智谱默认关闭（演示风险弹窗）；MiniMax 已确认风险并开启（演示进度条）；Kimi Code 没有对应供应商。
const MOCK_EXPERIMENTAL_RISK_VERSION = 1;
let mockExperimentalPlans: QuotaExperimentalPlanView[] = [
  { providerId: 'zhipu-glm-plan', vendor: 'zhipu-glm', displayName: '智谱 GLM 套餐', enabled: false, consentCurrent: false, riskVersion: MOCK_EXPERIMENTAL_RISK_VERSION, gatewayProviderName: '智谱', host: 'open.bigmodel.cn' },
  { providerId: 'minimax-plan', vendor: 'minimax', displayName: 'MiniMax 套餐', enabled: true, consentCurrent: true, riskVersion: MOCK_EXPERIMENTAL_RISK_VERSION, gatewayProviderName: 'MiniMax', host: 'api.minimaxi.com' },
  { providerId: 'kimi-code-plan', vendor: 'kimi-code', displayName: 'Kimi Code 套餐', enabled: false, consentCurrent: false, riskVersion: MOCK_EXPERIMENTAL_RISK_VERSION, gatewayProviderName: null, host: null },
];

function setMockExperimentalPlan(input: { providerId?: string; enabled?: boolean; acceptRiskVersion?: number }) {
  const plan = mockExperimentalPlans.find((item) => item.providerId === input.providerId);
  if (!plan) throw new Error('未知的实验来源。');
  if (input.acceptRiskVersion !== undefined && input.acceptRiskVersion !== MOCK_EXPERIMENTAL_RISK_VERSION) {
    throw new Error('风险提示已更新，请重新阅读后再确认。');
  }
  const consentCurrent = plan.consentCurrent || input.acceptRiskVersion === MOCK_EXPERIMENTAL_RISK_VERSION;
  if (input.enabled && !consentCurrent) throw new Error('开启前需要先确认风险提示。');
  if (input.enabled && !plan.host) throw new Error('先在「供应商」页添加 Kimi Code 的官方地址并填入 API key。');
  mockExperimentalPlans = mockExperimentalPlans.map((item) => (
    item === plan ? { ...item, enabled: Boolean(input.enabled), consentCurrent } : item
  ));
  return mockExperimentalPlans;
}

function mockExperimentalPlanResponse(): QuotaProviderEnvelope[] {
  const observedAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const planWindow = (providerId: string, windowId: string, windowLabel: string, used: number, windowMinutes: number, resetAfterMs: number) => ({
    providerId,
    windowId,
    windowLabel,
    scope: 'consumer-subscription' as const,
    source: 'official-api' as const,
    status: 'ok' as const,
    used,
    limit: 100,
    remaining: 100 - used,
    unit: 'percent' as const,
    windowMinutes,
    resetsAt: new Date(Date.now() + resetAfterMs).toISOString(),
    observedAt,
    fetchedAt: observedAt,
    staleAfterSeconds: 900,
  });
  return mockExperimentalPlans.filter((plan) => plan.enabled).map((plan): QuotaProviderEnvelope => {
    const base = {
      schemaVersion: 1 as const,
      providerId: plan.providerId,
      displayName: plan.displayName,
      scope: 'consumer-subscription' as const,
      mode: 'automatic' as const,
      capability: 'experimental' as const,
    };
    if (!plan.consentCurrent) return { ...base, status: 'auth-required', windows: [], reasonCode: 'experimental_consent_required' };
    if (plan.vendor === 'minimax') {
      return { ...base, status: 'ok', windows: [
        planWindow(plan.providerId, 'minimax:MiniMax-M2:interval', 'MiniMax-M2 · 5 小时额度', 20, 300, 9_000_000),
        planWindow(plan.providerId, 'minimax:MiniMax-M2:weekly', 'MiniMax-M2 · 每周额度', 44.5, 10_080, 216_000_000),
      ] };
    }
    return { ...base, status: 'ok', windows: [planWindow(plan.providerId, 'glm:tokens:3-5', '5 小时额度', 12.5, 300, 10_800_000)] };
  });
}

// 与 features/gateway/devMock 的供应商一一对应；OpenAI、Ollama 没有官方余额接口，归为可配置的中转余额。
let mockBalanceSources: QuotaBalanceSourceView[] = [
  { gatewayProviderId: 'deepseek', gatewayProviderName: 'DeepSeek', host: 'api.deepseek.com', vendor: 'deepseek', providerId: 'balance-deepseek', enabled: true, relay: null },
  { gatewayProviderId: 'openrouter', gatewayProviderName: 'OpenRouter', host: 'openrouter.ai', vendor: 'openrouter', providerId: 'balance-openrouter', enabled: true, relay: null },
  { gatewayProviderId: 'openai', gatewayProviderName: 'OpenAI', host: 'api.openai.com', vendor: 'relay', providerId: 'balance-relay-openai', enabled: false, relay: null },
  { gatewayProviderId: 'ollama', gatewayProviderName: 'Ollama', host: '127.0.0.1', vendor: 'relay', providerId: 'balance-relay-ollama', enabled: false, relay: null },
];

function setMockBalanceSource(input: { gatewayProviderId?: string; enabled?: boolean; relay?: QuotaRelayBalanceConfig }) {
  const source = mockBalanceSources.find((item) => item.gatewayProviderId === input.gatewayProviderId);
  if (!source) throw new Error('要开启余额的供应商不存在，请先在「供应商」页添加。');
  const relay = source.vendor === 'relay' ? input.relay ?? source.relay : null;
  if (input.relay) {
    let url: URL;
    try {
      url = new URL(input.relay.balanceUrl);
    } catch {
      throw new Error('余额地址无效。');
    }
    if (url.hostname !== source.host || url.search || url.username) throw new Error(`余额地址必须与 ${source.host} 同源，且不能带 query 或账号。`);
    if (!/^[A-Z]{3}$/.test(input.relay.currency)) throw new Error('币种必须是三个大写字母的 ISO 4217 代码。');
  }
  if (input.enabled && source.vendor === 'relay' && !relay) throw new Error('中转余额需要先填写同源余额地址、取值路径和币种。');
  mockBalanceSources = mockBalanceSources.map((item) => (
    item === source ? { ...item, enabled: Boolean(input.enabled), relay } : item
  ));
  return mockBalanceSources;
}

function mockBalanceResponse(): QuotaProviderEnvelope[] {
  const observedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  const balanceWindow = (providerId: string, currency: string, remaining: number) => ({
    providerId,
    windowId: `balance-${currency.toLowerCase()}`,
    windowLabel: `余额（${currency}）`,
    scope: 'api-organization' as const,
    source: 'official-api' as const,
    status: 'ok' as const,
    remaining,
    unit: 'currency' as const,
    currency,
    observedAt,
    fetchedAt: observedAt,
    staleAfterSeconds: 3600,
  });
  return mockBalanceSources.filter((source) => source.enabled).map((source): QuotaProviderEnvelope => {
    const base = {
      schemaVersion: 1 as const,
      providerId: source.providerId,
      displayName: `${source.gatewayProviderName} 余额`,
      scope: 'api-organization' as const,
      mode: 'automatic' as const,
      capability: source.vendor === 'relay' ? 'plan-dependent' as const : 'stable' as const,
    };
    if (source.vendor === 'deepseek') {
      return { ...base, status: 'ok', windows: [balanceWindow(source.providerId, 'CNY', 1234.5), balanceWindow(source.providerId, 'USD', 5)] };
    }
    if (source.vendor === 'openrouter') {
      return { ...base, status: 'auth-required', windows: [], reasonCode: 'api_key_required' };
    }
    if (source.relay) {
      return { ...base, status: 'ok', windows: [balanceWindow(source.providerId, source.relay.currency, 7)] };
    }
    return { ...base, status: 'error', windows: [], reasonCode: 'balance_unavailable' };
  });
}

function applyMockQuotaSourceScenario(providers: QuotaProviderEnvelope[]): QuotaProviderEnvelope[] {
  const scenario = mockQuotaSourceScenario();
  if (scenario === 'default') return providers;
  // 预览固定在 mockNow，状态卡却按真实时间算「N 分钟前」；场景预览把窗口平移到 3 分钟前。
  const shift = Date.now() - 3 * 60_000 - mockNow.getTime();
  const rebase = (value: string | undefined) => (value ? new Date(Date.parse(value) + shift).toISOString() : value);
  return providers.map((current) => {
    const provider: QuotaProviderEnvelope = {
      ...current,
      windows: current.windows.map((window) => ({
        ...window,
        observedAt: rebase(window.observedAt) ?? window.observedAt,
        fetchedAt: rebase(window.fetchedAt) ?? window.fetchedAt,
        resetsAt: rebase(window.resetsAt),
      })),
    };
    const enabled = provider.status !== 'auth-required' || provider.reasonCode === undefined
      || !provider.reasonCode.endsWith('_local_authorization_required');
    if (!enabled) return provider;
    if (scenario === 'failing' && provider.providerId === 'anthropic-claude-consumer') {
      const observedAt = new Date(Date.now() - 90 * 60_000).toISOString();
      return {
        ...provider,
        status: 'stale',
        reasonCode: 'claude_native_timeout',
        windows: provider.windows.map((window) => ({
          ...window,
          status: 'stale',
          reasonCode: 'observation_stale',
          observedAt,
          fetchedAt: observedAt,
        })),
      };
    }
    if (scenario === 'failing' && provider.providerId === 'google-antigravity-consumer') {
      return { ...provider, status: 'auth-required', reasonCode: 'antigravity_native_authorization_required', windows: [] };
    }
    if (scenario === 'missing' && provider.providerId === 'anthropic-claude-consumer' && !mockClaudeStatuslineWired) {
      return { ...provider, status: 'error', reasonCode: 'claude_statusline_snapshot_missing', windows: [] };
    }
    return provider;
  });
}

function mockQuotaSourceDetections() {
  const missing = mockQuotaSourceScenario() === 'missing';
  return [
    { providerId: 'openai-codex-local', installed: !missing, candidatePaths: missing ? [] : ['/opt/homebrew/bin/codex'] },
    { providerId: 'anthropic-claude-consumer', installed: true, candidatePaths: ['/Users/demo/.local/bin/claude'] },
    { providerId: 'google-antigravity-consumer', installed: !missing, candidatePaths: missing ? [] : ['/Applications/Antigravity.app'] },
  ];
}

let prices: Record<string, unknown> = {
  ...bundledPrices,
  'dev-auto-discovered-preview': {
    input: 1,
    output: 3,
    cache_input: 0.1,
    cache_write: 1.25,
    _meta: {
      status: 'auto_discovered',
      price_source: 'tool_fallback',
      fallback_key: 'default',
      observed_model: 'dev-auto-discovered-preview',
      tools: ['dev'],
      first_seen_at: '2026-07-10 10:00:00',
      last_seen_at: '2026-07-10 10:00:00',
    },
  },
};

/**
 * Price override migration notice previews (T10.189). None by default, as on
 * a fresh install; `?priceMigrationNotice=changed` previews a cleanup that
 * changed prices, `=unchanged` one that only removed values equal to today's
 * prices. A dismissed notice stays away until the page reloads.
 */
const mockPriceMigrationNotices: Record<'changed' | 'unchanged', PriceMigrationNotice> = {
  changed: {
    id: 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    migratedAt: '2026-07-15T06:28:00Z',
    backupFile: 'prices.legacy-backup-a3f1c2d4e5b6.json',
    backupDir: 'C:\\Users\\demo\\AppData\\Roaming\\com.jeidorf.tokenledger',
    modelsCleared: 7,
    fieldsCleared: 16,
    cleared: [
      { model: 'claude-sonnet-4-2', fields: ['input', 'output'], wholeModel: true },
      { model: 'claude-sonnet-5', fields: ['input', 'output'], wholeModel: true },
      { model: 'default', fields: ['input', 'output'], wholeModel: true },
      { model: 'future-model-z', fields: ['input', 'output', 'cache_input', 'cache_write'], wholeModel: true },
      { model: 'gpt-4.1', fields: ['output', 'cache_write'], wholeModel: false },
      { model: 'grok-4.3', fields: ['cache_input'], wholeModel: true },
      { model: 'o3', fields: ['input', 'output', 'cache_write'], wholeModel: true },
    ],
    changed: [
      { model: 'claude-sonnet-4-2', field: 'input', previous: 3, current: null },
      { model: 'claude-sonnet-4-2', field: 'output', previous: 15, current: null },
      { model: 'claude-sonnet-5', field: 'input', previous: 3, current: 2 },
      { model: 'claude-sonnet-5', field: 'output', previous: 15, current: 10 },
      { model: 'grok-4.3', field: 'cache_input', previous: 0, current: 0.2 },
      { model: 'o3', field: 'input', previous: 10, current: 2 },
      { model: 'o3', field: 'output', previous: 40, current: 8 },
    ],
  },
  unchanged: {
    id: '5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829300',
    migratedAt: '2026-07-15T06:28:00Z',
    backupFile: 'prices.legacy-backup-5b6c7d8e9f0a.json',
    backupDir: 'C:\\Users\\demo\\AppData\\Roaming\\com.jeidorf.tokenledger',
    modelsCleared: 2,
    fieldsCleared: 3,
    cleared: [
      { model: 'default', fields: ['input', 'output'], wholeModel: true },
      { model: 'gpt-4.1', fields: ['output'], wholeModel: false },
    ],
    changed: [],
  },
};
const mockDismissedPriceMigrationNotices = new Set<string>();

function mockPriceMigrationNotice(): PriceMigrationNotice | null {
  if (typeof window === 'undefined') return null;
  const scenario = new URLSearchParams(window.location.search).get('priceMigrationNotice');
  if (scenario !== 'changed' && scenario !== 'unchanged') return null;
  const notice = mockPriceMigrationNotices[scenario];
  return mockDismissedPriceMigrationNotices.has(notice.id) ? null : notice;
}

const MOCK_MAGPIE_IMPORT = {
  importedAt: '2026-10-20T08:00:00Z',
  counts: { lines: 1280, imported: 1204, invalid: 0, zeroTokens: 70, rejected: 6, otherComputer: 0, repeated: 0 },
  earliest: '2026-08-01T02:10:00Z',
  latest: '2026-10-20T07:58:00Z',
  duplicateOfGateway: 0,
  matchedScans: 812,
  held: 3,
};
let mockMagpieImport: typeof MOCK_MAGPIE_IMPORT | null = null;

function mockMagpieImportStatus() {
  return {
    magpieFound: true,
    usageFound: true,
    usageBytes: 1_482_000,
    usageModifiedAt: '2026-10-20T07:58:00Z',
    imported: mockMagpieImport !== null,
    lastImport: mockMagpieImport,
  };
}

export function installDevMockTauri() {
  mockUnsyncedRecords = 12;
  mockCloudAuthenticated = true;
  // `?fresh=gateway` is the same first launch with model access already on.
  const fresh = typeof window === 'undefined' || !window.location ? null : new URLSearchParams(window.location.search).get('fresh');
  mockFreshInstall = fresh === '1' || fresh === 'gateway';
  if (mockFreshInstall) {
    mockFreshLedger = mockHistory.splice(0, mockHistory.length);
    mockUnsyncedRecords = 0;
    mockCloudAuthenticated = false;
    mockSettings = { ...mockSettings, model_access_enabled: fresh === 'gateway', routing_publish_enabled: false };
    resetGatewayMockToFresh();
  }
  mockCostProfile = emptyMockCostProfile();
  resetMockProjectDimension();
  attachE2eHarness();
  mockIPC((cmd, args) => {
    const e2e = resolveE2eOverride(cmd, args);
    if (e2e.hit) return e2e.value;
    const payload = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};
    switch (cmd) {
      case 'get_cloud_config':
        if (mockFreshInstall && !mockCloudAuthenticated) return { supabase_url: '', supabase_key: '' };
        return { supabase_url: 'https://demo.supabase.co', supabase_key: 'sb_publishable_demo' };
      case 'get_cloud_status':
        return {
          configured: true,
          authenticated: mockCloudAuthenticated,
          email: mockCloudAuthenticated ? 'z@tokenledger.local' : '',
          userId: mockCloudAuthenticated ? 'dev-user' : '',
        };
      case 'get_settings':
        return mockSettings;
      case 'save_settings':
        mockSettings = normalizeMockClaudeToggles({
          ...mockSettings,
          ...((payload.settings || {}) as Partial<AppSettings>),
          quota_custom_endpoints: mockSettings.quota_custom_endpoints,
          quota_snapshot_sync_enabled: mockSettings.quota_snapshot_sync_enabled,
          model_access_enabled: mockSettings.model_access_enabled,
        });
        return { message: '设置已保存', settings: mockSettings };
      case 'gateway_set_model_access':
        mockSettings = { ...mockSettings, model_access_enabled: Boolean(payload.enabled), model_access_version: 1 };
        return mockSettings;
      case 'get_cost_profile':
        return mockIpcJson(mockCostProfile);
      case 'validate_cost_profile': {
        if (payload.profile === undefined) return invalidMockArgs('validate_cost_profile', 'profile');
        const { errors } = checkCostProfileInput(mockIpcJson(payload.profile), mockCostProfile, formatDateBucket(mockNow));
        return { valid: errors.length === 0, errors };
      }
      case 'save_cost_profile':
        return saveMockCostProfile(payload.profile, payload.expectedRevision);
      case 'clear_cost_profile':
        return clearMockCostProfile(payload.expectedRevision);
      case 'list_custom_quota_endpoints':
        return mockCustomEndpoints;
      case 'upsert_custom_quota_endpoint': {
        const input = (payload.input || {}) as Record<string, unknown>;
        const existingId = typeof input.id === 'string' ? input.id : null;
        const existing = existingId
          ? mockCustomEndpoints.find((endpoint) => endpoint.id === existingId)
          : undefined;
        const id = existingId || `mock${String(mockCustomEndpoints.length + 1).padStart(20, '0')}`;
        const endpoint: CustomQuotaEndpointView = {
          id,
          providerId: `company-openapi-${id}`,
          displayName: typeof input.displayName === 'string' ? input.displayName : '公司额度',
          url: typeof input.url === 'string' ? input.url : 'https://your-gateway.example.com/v1/me/quota',
          enabled: input.enabled !== false,
          apiKeyConfigured: Boolean(input.apiKey) || existing?.apiKeyConfigured === true,
          hasApiKey: Boolean(input.apiKey) || existing?.hasApiKey === true,
          schemaVerified: true,
        };
        mockCustomEndpoints = existing
          ? mockCustomEndpoints.map((current) => current.id === existing.id ? endpoint : current)
          : [...mockCustomEndpoints, endpoint];
        syncMockCustomSettings();
        return mockCustomEndpoints;
      }
      case 'delete_custom_quota_endpoint': {
        const id = typeof payload.id === 'string' ? payload.id : '';
        mockCustomEndpoints = mockCustomEndpoints.filter((endpoint) => endpoint.id !== id);
        syncMockCustomSettings();
        return mockCustomEndpoints;
      }
      case 'get_budget_settings':
        return mockBudgetSettings;
      case 'set_budget_settings': {
        const next = (payload.settings ?? {}) as { notify?: unknown; rules?: unknown };
        mockBudgetSettings = {
          notify: next.notify === true,
          rules: Array.isArray(next.rules) ? next.rules.slice(0, 32) as MockBudgetRule[] : [],
        };
        return mockBudgetSettings;
      }
      case 'get_budget_status':
        return mockBudgetStatus();
      case 'get_period_report_settings':
        return mockPeriodReportSettings;
      case 'set_period_report_settings': {
        const next = (payload.settings ?? {}) as { weekly?: unknown; monthly?: unknown };
        mockPeriodReportSettings = { weekly: next.weekly === true, monthly: next.monthly === true };
        return mockPeriodReportSettings;
      }
      case 'get_quota_alert_settings':
        return mockQuotaAlertSettings;
      case 'set_quota_alert_settings': {
        const next = (payload.settings ?? {}) as { enabled?: unknown; thresholds?: unknown };
        const thresholds = Array.isArray(next.thresholds)
          ? [50, 20, 5].filter((value) => (next.thresholds as unknown[]).includes(value))
          : [];
        mockQuotaAlertSettings = { enabled: next.enabled === true, thresholds: thresholds.length > 0 ? thresholds : [20] };
        return mockQuotaAlertSettings;
      }
      case 'get_quota_snapshot_sync_status':
        return mockQuotaSyncStatus;
      case 'set_quota_snapshot_sync_enabled': {
        const enabled = payload.enabled === true;
        mockSettings = { ...mockSettings, quota_snapshot_sync_enabled: enabled };
        mockQuotaSyncStatus = enabled
          ? { enabled: true, state: 'active', lastSyncedAt: mockTimestamp }
          : { enabled: false, state: 'disabled' };
        return mockQuotaSyncStatus;
      }
      case 'sync_quota_snapshots_now':
        if (!mockSettings.quota_snapshot_sync_enabled) return { enabled: false, state: 'disabled' };
        mockQuotaSyncStatus = { enabled: true, state: 'active', lastSyncedAt: mockTimestamp };
        return mockQuotaSyncStatus;
      case 'delete_quota_snapshot_provider':
        mockQuotaSyncStatus = mockSettings.quota_snapshot_sync_enabled
          ? { enabled: true, state: 'active', lastSyncedAt: mockTimestamp }
          : { enabled: false, state: 'disabled' };
        return mockQuotaSyncStatus;
      case 'clear_quota_snapshots':
        mockSettings = { ...mockSettings, quota_snapshot_sync_enabled: false };
        mockQuotaSyncStatus = { enabled: false, state: 'disabled' };
        return mockQuotaSyncStatus;
      case 'supabase_sign_out':
        mockSettings = { ...mockSettings, quota_snapshot_sync_enabled: false };
        mockQuotaSyncStatus = { enabled: false, state: 'disabled' };
        mockCloudAuthenticated = false;
        return { success: true, message: '已退出并停止额度同步' };
      case 'get_prices':
        return prices;
      case 'search_models_dev_prices': {
        const request = args as Record<string, unknown>;
        const model = typeof request.model === 'string' ? request.model : 'dev-auto-discovered-preview';
        return {
          query: model,
          fetchedAt: new Date().toISOString(),
          cacheStatus: 'fresh',
          warning: null,
          candidates: [
            {
              providerId: 'openai',
              providerName: 'OpenAI',
              modelId: model,
              modelName: 'Development Preview Model',
              input: 2,
              output: 8,
              cacheInput: 0.5,
              cacheWrite: null,
              lastUpdated: '2026-07-13',
              status: null,
              hasTieredPricing: false,
              importable: true,
              matchReason: '模型 ID 完全一致',
            },
            {
              providerId: 'openrouter',
              providerName: 'OpenRouter',
              modelId: `openai/${model}`,
              modelName: 'Development Preview Model',
              input: 2.2,
              output: 8.8,
              cacheInput: 0.55,
              cacheWrite: 2.5,
              lastUpdated: '2026-07-12',
              status: null,
              hasTieredPricing: true,
              importable: true,
              matchReason: '去除供应商前缀后完全一致',
            },
          ],
        };
      }
      case 'save_prices': {
        const request = args as Record<string, unknown>;
        if (request.prices && typeof request.prices === 'object') {
          prices = request.prices as Record<string, unknown>;
        }
        return { message: '价格表保存成功', repriced: 12 };
      }
      case 'reset_prices':
        prices = { ...bundledPrices };
        return { message: '已恢复默认价格', prices, repriced: 12 };
      case 'get_price_migration_notice':
        return mockPriceMigrationNotice();
      case 'dismiss_price_migration_notice':
        if (typeof payload.id === 'string') mockDismissedPriceMigrationNotices.add(payload.id);
        return null;
      case 'get_db_info':
        return {
          path: 'dev/tokenledger.sqlite',
          totalRecords: mockHistory.length,
          unsyncedRecords: mockUnsyncedRecords,
          earliest: mockHistory[mockHistory.length - 1]?.timestamp || null,
          latest: mockHistory[0]?.timestamp || null,
          sizeBytes: 8_634_368,
          reclaimableBytes: 2_621_440,
          freelistPages: 640,
        };
      case 'get_app_version':
        return packageJson.version;
      case 'get_claude_statusline_command':
        return "\"command\": \"'/Applications/TokenLedger.app/Contents/MacOS/tokenledger' --claude-statusline\"";
      case 'detect_quota_sources':
        return mockQuotaSourceDetections();
      case 'list_quota_balance_sources':
        return mockBalanceSources;
      case 'set_quota_balance_source':
        return setMockBalanceSource((payload?.input ?? {}) as Parameters<typeof setMockBalanceSource>[0]);
      case 'list_quota_experimental_plans':
        return mockExperimentalPlans;
      case 'set_quota_experimental_plan':
        return setMockExperimentalPlan((payload?.input ?? {}) as Parameters<typeof setMockExperimentalPlan>[0]);
      case 'get_claude_quota_setup':
        // 默认演示「已配置 statusLine 但还没收到快照」这一档：它是真实安装里
        // 最常停留、也最需要界面说清楚的状态。
        return {
          settingsBlock: [
            '{',
            '  "statusLine": {',
            '    "type": "command",',
            '    "command": "\'/Applications/TokenLedger.app/Contents/MacOS/tokenledger\' --claude-statusline"',
            '  }',
            '}',
          ].join('\n'),
          commandProperty:
            "\"command\": \"'/Applications/TokenLedger.app/Contents/MacOS/tokenledger' --claude-statusline\"",
          settingsPath: '/Users/demo/.claude/settings.json',
          statusLineWired: mockClaudeStatuslineWired,
          snapshotPresent: false,
          cliCandidates: [
            '/Users/demo/.local/bin/claude',
            '/opt/homebrew/bin/claude',
          ],
          backup: mockClaudeBackup,
          chainPresent: mockClaudeBackup !== null,
        };
      case 'preview_claude_statusline_setup':
        return {
          settingsPath: '~/.claude/settings.json',
          fileExists: true,
          changed: !mockClaudeStatuslineWired,
          keepsOriginal: !mockClaudeStatuslineWired,
          beforeVersion: mockClaudeStatuslineWired ? 'mock-applied' : 'mock-original',
          diff: mockClaudeStatuslineWired ? '' : [
            '  {',
            '    "statusLine": {',
            '      "type": "command",',
            '-     "command": "~/.claude/statusline.sh",',
            `+     "command": ${JSON.stringify(mockClaudeHelperCommand)},`,
            '      "padding": 0',
            '    }',
            '  }',
          ].join('\n'),
        };
      case 'apply_claude_statusline_setup':
        if (!mockSettings.quota_claude_enabled) throw new Error('请先打开「读取 Claude 额度」，再一键接入。');
        if (payload?.expectedVersion !== (mockClaudeStatuslineWired ? 'mock-applied' : 'mock-original')) {
          throw new Error('Claude Code 配置在预览后被修改过，未做改动，请重新预览。');
        }
        mockClaudeStatuslineWired = true;
        mockClaudeBackup ??= { createdAt: new Date().toISOString(), originalExisted: true, restorableWithoutForce: true };
        return { changed: true, version: 'mock-applied', backupCreated: true };
      case 'restore_claude_statusline_setup':
        if (!mockClaudeBackup) throw new Error('没有可恢复的 Claude Code 配置备份。');
        mockClaudeStatuslineWired = false;
        mockClaudeBackup = null;
        return { removed: false, version: 'mock-original' };
      case 'get_cached_stats':
        return statsForQuery(payload);
      case 'get_local_behavior_analysis': {
        const { scenario, delayMs, projectState } = mockBehaviorPreviewOptions();
        const ledger = mockBehaviorLedger(scenario);
        let analysis: ReturnType<typeof behaviorAnalysisForQuery>;
        try {
          analysis = behaviorAnalysisForQuery((payload.query || {}) as Record<string, unknown>, ledger, {
            index: projectState === 'unavailable' ? undefined : mockProjectIndex(projectState, ledger),
            projects: payload.projects,
            unreadable: projectState === 'unavailable',
          });
        } catch (cause) {
          // The native command rejects with the bare error code.
          if (cause instanceof Error && (cause.message === BEHAVIOR_PROJECT_DIMENSION_DISABLED
            || cause.message === BEHAVIOR_PROJECT_DIMENSION_UNAVAILABLE)) return Promise.reject(cause.message);
          throw cause;
        }
        return delayMs > 0 ? new Promise((resolve) => { window.setTimeout(() => resolve(analysis), delayMs); }) : analysis;
      }
      case 'get_usage_details':
        return detailsResponse((payload.query || {}) as Record<string, unknown>);
      case 'cancel_local_session_analysis':
        return true;
      case 'get_local_session_analysis': {
        // Anonymous interaction fixture, independent of the aggregated mock ledger rows.
        // Production never derives turns by splitting a ledger row into equal portions.
        const record = mockHistory.find(row => row.id === payload.recordId);
        const supported = record && ['claude', 'codex'].includes(record.tool);
        const result: SessionAnalysis = {
          status: supported ? 'ready' : 'unavailable',
          reason: supported ? undefined : record ? 'unsupported_source' : 'record_not_found',
          recordId: Number(payload.recordId), sessionId: record?.sessionId || '', tool: record?.tool || '', observedAt: mockTimestamp,
          coverage: { complete: Boolean(supported), matchedRecord: Boolean(supported), toolCallsKnown: true },
          turns: supported ? [
            { id: 'fixture-user-1', ordinal: 1, startedAt: '2026-07-15T06:00:00Z', endedAt: '2026-07-15T06:02:00Z', status: 'complete', requestCount: 3, inputTokens: 4210, outputTokens: 1820, cachedTokens: 3200, cacheReadTokens: 2800, cacheWriteTokens: 400, models: [record.model], tools: [{ name: 'Read', count: 2 }, { name: 'Shell', count: 1 }] },
            { id: 'fixture-user-2', ordinal: 2, startedAt: '2026-07-15T06:03:00Z', endedAt: '2026-07-15T06:04:00Z', status: 'complete', requestCount: 1, inputTokens: 850, outputTokens: 1420, cachedTokens: 4020, cacheReadTokens: 4020, cacheWriteTokens: 0, models: [record.model], tools: [] },
            { id: 'fixture-user-3', ordinal: 3, startedAt: '2026-07-15T06:05:00Z', endedAt: null, status: 'unknown', requestCount: 2, inputTokens: 2650, outputTokens: 2160, cachedTokens: 5600, cacheReadTokens: 4800, cacheWriteTokens: 800, models: [record.model], tools: [{ name: 'Edit', count: 2 }] },
          ] : [],
        };
        return result;
      }
      case 'get_entity_dashboard':
        return entityResponse((payload.query || {}) as Record<string, unknown>);
      case 'get_quota_providers':
      case 'get_local_quota_providers':
      case 'retry_quota_providers':
      case 'retry_local_quota_providers':
        return mockFreshInstall ? [] : quotaResponse();
      case 'authorize_claude_native_quota':
        if (!mockSettings.quota_claude_codexbar_enabled) throw new Error('请先开启 Claude 内置额度读取');
        return 'Claude 内置 /usage 读取已启用，无需安装 CodexBar';
      case 'authorize_antigravity_quota':
        if (!mockSettings.quota_antigravity_local_enabled) throw new Error('请先开启 Antigravity 本地额度读取');
        return 'Antigravity 本地额度读取成功，共识别 4 个额度窗口';
      case 'refresh_scan':
        if (mockFreshInstall && mockHistory.length === 0 && mockFreshLedger.length > 0) {
          mockHistory.push(...mockFreshLedger);
          mockUnsyncedRecords = mockHistory.length;
          // The native scan announces new rows the same way.
          window.setTimeout(() => { void emit('stats-updated'); }, 0);
          return { message: `扫描完成，已发现 ${mockHistory.length} 条新记录` };
        }
        return { message: '扫描完成，已发现 6 条新记录' };
      case 'sync_to_supabase': {
        const syncedCount = mockUnsyncedRecords;
        mockUnsyncedRecords = 0;
        return {
          success: true,
          message: '同步完成',
          synced_count: syncedCount,
          purged_count: 0,
          summary_refreshed: true,
          warning: null,
        };
      }
      case 'update_wallpaper': {
        const target = typeof payload.target === 'string' ? payload.target : 'desktop';
        return { message: `壁纸已更新（${target}）` };
      }
      case 'save_cloud_config':
        return { message: 'Supabase 配置已保存' };
      case 'export_db_csv':
        return { message: '已导出 CSV', path: 'dev/tokenledger-export.csv' };
      case 'export_usage_csv': {
        const content = typeof payload.content === 'string' ? payload.content : '';
        const rows = Math.max(0, content.split('\n').filter(Boolean).length - 1);
        return { message: `已导出 ${rows} 条记录`, path: 'dev/tokenledger_requests.csv' };
      }
      case 'reset_local_sync':
        return { message: '同步状态已重置' };
      case 'cleanup_db': {
        const beforeDate = typeof payload.beforeDate === 'string' ? payload.beforeDate : '未知日期';
        return { message: `已清理 ${beforeDate} 之前的记录` };
      }
      case 'reclaim_db_space':
        return { message: '已回收 2.50 MB 磁盘空间', beforeBytes: 8_634_368, afterBytes: 6_012_928, freedBytes: 2_621_440 };
      case 'get_project_dimension_status':
        return mockProjectDimensionStatus();
      case 'set_project_dimension': {
        const enabled = payload.enabled === true;
        if (enabled && payload.consentVersion !== 1) return Promise.reject('consent_version_mismatch');
        if (enabled) {
          mockProjectDimensionEnabled = true;
          mockProjectNamed = 4;
          mockProjectIndexed = 12;
          return mockProjectDimensionStatus();
        }
        const removedSessions = mockProjectIndexed;
        resetMockProjectDimension();
        return mockProjectDimensionStatus({ removedSessions, walTruncated: true });
      }
      case 'rebuild_project_index':
        if (!mockProjectDimensionEnabled) return Promise.reject('project_dimension_disabled');
        return mockProjectDimensionStatus();
      case 'show_widget_window':
      case 'hide_widget_window':
      case 'toggle_widget_window':
      case 'widget_pointer_hover':
      case 'set_desktop_widget_enabled':
      case 'open_main_settings':
      case 'focus_main_window':
        return null;
      case 'cleanup_wallpaper':
        return { message: '壁纸残留已清理' };
      case 'preview_wallpaper':
        return mockWallpaperPreview(statsForQuery({
          range: 'today',
          deviceFilter: mockSettings.wallpaper_use_cloud ? mockSettings.wallpaper_device_filter : 'all_cloud',
        }), mockNow);
      case 'supabase_sign_in':
        mockCloudAuthenticated = true;
        return { message: '登录成功' };
      case 'supabase_sign_up':
        return { message: '注册成功，请查收验证邮件' };
      case 'magpie_import_status':
        return mockMagpieImportStatus();
      case 'magpie_import_run':
        mockMagpieImport = MOCK_MAGPIE_IMPORT;
        return MOCK_MAGPIE_IMPORT;
      case 'magpie_import_clear':
        mockMagpieImport = null;
        return null;
      case 'routing_publish_status':
        return { state: 'ok', lastPublishedAt: new Date(Date.now() - 4000).toISOString(), flows: 3, error: null };
      case 'peer_live_snapshot':
      case 'gateway_external_feed':
        if (mockFreshInstall) return { reachable: false, port: 3425, requests: 0, waiting: 0, tools: 0, active: [], recent: [] };
        return {
          reachable: true, port: 3425, requests: 2, waiting: 1, tools: 0,
          active: [
            { id: 7, agent: 'claude', model: 'claude-opus-5-5', provider: 'anthropic', started: new Date(Date.now() - 1200).toISOString(), ms: 1200, phase: 'upstream' },
            { id: 8, agent: 'codex', model: '', provider: '', started: new Date(Date.now() - 300).toISOString(), ms: 300, phase: 'slot' },
          ],
          recent: [
            {
              id: '9', agent: 'claude', model: 'claude-opus-5-5', ended: new Date(Date.now() - 4000).toISOString(),
              attempts: [
                { provider: 'relay', outcome: 'failed', status: 529 },
                { provider: 'anthropic', outcome: 'ok' },
              ],
            },
          ],
        };
      case 'peer_sync_get_config':
        return { url: '', user: '', hasPassword: false, hasPassphrase: false };
      case 'peer_sync_save_config': {
        const input = (payload.input ?? {}) as Record<string, unknown>;
        return { url: String(input.url ?? ''), user: String(input.user ?? ''), hasPassword: Boolean(input.password), hasPassphrase: Boolean(input.passphrase) };
      }
      case 'peer_sync_shared_list':
        return {
          computers: [
            { id: '3f9a1c0e5b7d2468', name: 'studio-mac', days: 41, latest: new Date().toISOString().slice(0, 10), enabled: false },
          ],
          last: null,
        };
      case 'peer_sync_shared_pull': {
        const ids = Array.isArray(payload.ids) ? (payload.ids as string[]) : [];
        return {
          pulledAt: new Date().toISOString(),
          computers: ids.map((id) => ({ id, name: 'studio-mac', days: 41, calls: 1280 })),
        };
      }
      case 'peer_sync_shared_clear':
        return null;
      default: {
        const gatewayResult = handleGatewayMock(cmd, payload);
        if (gatewayResult !== undefined) return gatewayResult;
        return { message: 'mock: 未实现的命令 ' + cmd };
      }
    }
  }, { shouldMockEvents: true });
}
