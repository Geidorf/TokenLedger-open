import { invoke } from '@tauri-apps/api/core';
import type { BehaviorAnalysisResponse, LogHistoryItem, UsageDetailsEnvelope } from '../../types';
import { isUnavailableEnvelope, normalizeStatsQuery } from '../../utils/frontendContracts';
import { resolveCacheBreakdown } from '../../utils/cacheDisplay';
import { cacheHitRate } from '../../utils/usageSplit';
import { contextComposition, CONTEXT_SEGMENTS, type ContextSegmentKey } from '../../utils/contextComposition';
import { isKnownCost } from '../../utils/format';
import type { SessionDetailRef } from './sessionDetailRoute';

/**
 * 会话详情只读现有的本机明细（`get_usage_details`，与「请求」子页同一去重与计价）
 * 和行为分析（`get_local_behavior_analysis`，与会话排行同一口径），不新增统计口径：
 * 这里的合计、累计与平均都是对这两份结果的逐行求和或相除。
 */

/** 明细每页上限（后端会把更大的值压到 100）。 */
export const SESSION_DETAIL_PAGE_SIZE = 100;
/** 一个会话最多读取的明细页数；超出时只展示最新的这部分并注明。 */
export const SESSION_DETAIL_MAX_PAGES = 30;
/** 同类会话对比窗口：截至会话最后一天的最近 30 个本地日历日。 */
export const PEER_WINDOW_DAYS = 30;
export const TOP_EXPENSIVE_LIMIT = 5;

export interface SessionRequestsResult {
  /** 按时间正序（最早在前）。 */
  items: LogHistoryItem[];
  /** 达到读取上限，较早的记录没有读到。 */
  truncated: boolean;
}

function matchesSession(item: LogHistoryItem, ref: SessionDetailRef): boolean {
  if (item.sessionId !== ref.sessionId) return false;
  return !ref.tool || item.tool.toLowerCase() === ref.tool.toLowerCase();
}

function timeOf(item: LogHistoryItem): number {
  const value = Date.parse(item.timestamp);
  return Number.isFinite(value) ? value : 0;
}

export function chronological(items: LogHistoryItem[]): LogHistoryItem[] {
  return [...items].sort((left, right) => timeOf(left) - timeOf(right) || left.id - right.id);
}

/**
 * 读出一个会话的全部本机明细。明细搜索是子串匹配，这里只保留会话 ID 完全相同
 * （且工具相同，未指定工具时不限）的记录。
 */
export async function loadSessionRequests(ref: SessionDetailRef, timezone: string): Promise<SessionRequestsResult | null> {
  const canonical = normalizeStatsQuery({
    range: 'all',
    timezone,
    machines: [],
    tools: ref.tool ? [ref.tool] : [],
    models: [],
    search: ref.sessionId,
    tokenMode: 'effective',
  });
  const items: LogHistoryItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SESSION_DETAIL_MAX_PAGES; page += 1) {
    const response: UsageDetailsEnvelope = await invoke<UsageDetailsEnvelope>('get_usage_details', {
      query: { scope: 'local', ...canonical, cursor, limit: SESSION_DETAIL_PAGE_SIZE },
    });
    if (isUnavailableEnvelope(response)) return null;
    items.push(...response.items.filter(item => matchesSession(item, ref)));
    if (!response.hasMore || !response.nextCursor) return { items: chronological(items), truncated: false };
    cursor = response.nextCursor;
  }
  return { items: chronological(items), truncated: true };
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** 一行明细代表的请求数：小时聚合行带 `requests`，逐请求行为 1。 */
export function requestCount(item: LogHistoryItem): number {
  return Math.max(1, Math.round(num(item.requests) || 1));
}

export function effectiveTokens(item: Pick<LogHistoryItem, 'inputTokens' | 'outputTokens'>): number {
  return num(item.inputTokens) + num(item.outputTokens);
}

/** 只在读写拆分可证明时给命中率，与「请求」子页的展开行一致。 */
export function rowCacheHit(item: LogHistoryItem): number | null {
  const split = resolveCacheBreakdown(item);
  return split.kind === 'split' ? cacheHitRate(item.inputTokens, split.read) : null;
}

export interface TimelineEntry {
  item: LogHistoryItem;
  /** 会话内第几行（从 1 起）。 */
  ordinal: number;
  /** 换了模型：前一行的模型；没换为 null。 */
  switchedFrom: string | null;
  cacheHit: number | null;
  /** 截至这一行的累计费用；只累加已知费用。 */
  cumulativeCost: number;
}

export interface SessionSummary {
  tool: string;
  tools: string[];
  models: string[];
  firstAt: string | null;
  lastAt: string | null;
  durationMs: number | null;
  rows: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  effectiveTokens: number;
  /** 所有行费用都已知时的合计；有未知费用时为 null。 */
  cost: number | null;
  knownCost: number;
  unknownCostRows: number;
  /** 可证明拆分的行上的命中率；没有这样的行为 null。 */
  cacheHit: number | null;
  modelSwitches: number;
  /** 带耗时的行（网关记录）的耗时合计与中位数。 */
  latencyRows: number;
  latencyTotalMs: number | null;
  latencyMedianMs: number | null;
  contextRows: number;
}

export function buildTimeline(items: LogHistoryItem[]): TimelineEntry[] {
  let running = 0;
  let previousModel: string | null = null;
  return items.map((item, index) => {
    if (isKnownCost(item.cost)) running += item.cost;
    const switchedFrom = previousModel !== null && item.model !== previousModel ? previousModel : null;
    previousModel = item.model;
    return { item, ordinal: index + 1, switchedFrom, cacheHit: rowCacheHit(item), cumulativeCost: running };
  });
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeSession(timeline: TimelineEntry[]): SessionSummary {
  const items = timeline.map(entry => entry.item);
  const tools = [...new Set(items.map(item => item.tool))];
  const models: string[] = [];
  for (const item of items) if (!models.includes(item.model)) models.push(item.model);
  const firstAt = items[0]?.timestamp ?? null;
  const lastAt = items[items.length - 1]?.timestamp ?? null;
  const first = firstAt ? Date.parse(firstAt) : NaN;
  const last = lastAt ? Date.parse(lastAt) : NaN;
  let hitInput = 0;
  let hitRead = 0;
  let hitRows = 0;
  for (const item of items) {
    const split = resolveCacheBreakdown(item);
    if (split.kind !== 'split') continue;
    hitInput += num(item.inputTokens);
    hitRead += split.read;
    hitRows += 1;
  }
  const latencies = items.map(item => item.latencyMs).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const unknownCostRows = items.filter(item => !isKnownCost(item.cost)).length;
  const knownCost = items.reduce((sum, item) => sum + (isKnownCost(item.cost) ? item.cost : 0), 0);
  return {
    tool: tools[0] ?? '',
    tools,
    models,
    firstAt,
    lastAt,
    durationMs: Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : null,
    rows: items.length,
    requests: items.reduce((sum, item) => sum + requestCount(item), 0),
    inputTokens: items.reduce((sum, item) => sum + num(item.inputTokens), 0),
    outputTokens: items.reduce((sum, item) => sum + num(item.outputTokens), 0),
    cachedTokens: items.reduce((sum, item) => sum + num(item.cachedTokens), 0),
    effectiveTokens: items.reduce((sum, item) => sum + effectiveTokens(item), 0),
    cost: unknownCostRows === 0 ? knownCost : null,
    knownCost,
    unknownCostRows,
    cacheHit: hitRows > 0 ? cacheHitRate(hitInput, hitRead) : null,
    modelSwitches: timeline.filter(entry => entry.switchedFrom !== null).length,
    latencyRows: latencies.length,
    latencyTotalMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) : null,
    latencyMedianMs: median(latencies),
    contextRows: items.filter(item => item.context).length,
  };
}

/** 费用最高的几行（只看已知费用，同价按时间先后）。 */
export function topExpensive(timeline: TimelineEntry[], limit = TOP_EXPENSIVE_LIMIT): TimelineEntry[] {
  return timeline
    .filter(entry => isKnownCost(entry.item.cost) && entry.item.cost > 0)
    .sort((left, right) => (right.item.cost - left.item.cost) || left.ordinal - right.ordinal)
    .slice(0, limit);
}

export interface ContextPoint {
  timestamp: string;
  ordinal: number;
  /** 各分段的估算 Token（按字节占比分摊这次请求的输入 + 缓存）。 */
  segments: Record<ContextSegmentKey, number>;
}

/** 网关记下构成的行，按时间排列；没有时为空数组。 */
export function contextSeries(timeline: TimelineEntry[]): ContextPoint[] {
  return timeline.flatMap(entry => {
    const segments = contextComposition(entry.item.context, num(entry.item.inputTokens) + num(entry.item.cachedTokens));
    if (!segments) return [];
    const values = Object.fromEntries(CONTEXT_SEGMENTS.map(({ key }) => [key, 0])) as Record<ContextSegmentKey, number>;
    for (const segment of segments) values[segment.key] = segment.estimatedTokens ?? 0;
    return [{ timestamp: entry.item.timestamp, ordinal: entry.ordinal, segments: values }];
  });
}

export interface PeerAverage {
  tool: string;
  windowStart: string;
  windowEnd: string;
  /** 参与平均的其他会话数。 */
  sessions: number;
  /** 行为分析只返回前若干会话时为 true：平均只覆盖这些会话。 */
  topOnly: boolean;
  tokens: number;
  rows: number;
  /** 参与平均的会话都有可用费用时的平均费用。 */
  cost: number | null;
}

const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 会话最后一条记录在 `timezone` 的本地日期。 */
export function localDay(timestamp: string, timezone: string): string | null {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
    return LOCAL_DAY.test(parts) ? parts : null;
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

export function peerWindow(lastDay: string, days = PEER_WINDOW_DAYS): { start: string; end: string } {
  const end = Date.UTC(Number(lastDay.slice(0, 4)), Number(lastDay.slice(5, 7)) - 1, Number(lastDay.slice(8, 10)));
  return { start: new Date(end - (days - 1) * 86_400_000).toISOString().slice(0, 10), end: lastDay };
}

/** 同一工具其他会话的平均值；当前会话不计入。没有其他会话时为 null。 */
export function peerAverage(response: BehaviorAnalysisResponse, self: { sessionId: string; tool: string }): PeerAverage | null {
  const tool = self.tool.toLowerCase();
  const others = response.sessions.filter(session => session.tool.toLowerCase() === tool && session.id !== self.sessionId);
  if (!others.length) return null;
  const costs = others.map(session => session.cost);
  const allCosts = costs.every(isKnownCost);
  return {
    tool: self.tool,
    windowStart: response.meta.start,
    windowEnd: response.meta.end,
    sessions: others.length,
    topOnly: response.meta.sessionsTruncated,
    tokens: others.reduce((sum, session) => sum + num(session.tokens), 0) / others.length,
    rows: others.reduce((sum, session) => sum + num(session.requests), 0) / others.length,
    cost: allCosts ? (costs as number[]).reduce((sum, value) => sum + value, 0) / others.length : null,
  };
}

export async function loadPeerAverage(self: { sessionId: string; tool: string; lastAt: string }, timezone: string): Promise<PeerAverage | null> {
  const lastDay = localDay(self.lastAt, timezone);
  if (!lastDay) return null;
  const window = peerWindow(lastDay);
  const response = await invoke<BehaviorAnalysisResponse>('get_local_behavior_analysis', {
    query: {
      range: 'custom',
      start: window.start,
      end: window.end,
      timezone,
      machines: [],
      tools: [self.tool],
      models: [],
      search: null,
      tokenMode: 'effective',
    },
  });
  return peerAverage(response, self);
}

/** 当前值相对平均值的倍数；平均为 0 或不可得时为 null。 */
export function ratioToAverage(value: number | null, average: number | null): number | null {
  if (value === null || average === null || !Number.isFinite(value) || !Number.isFinite(average) || average <= 0) return null;
  return value / average;
}
