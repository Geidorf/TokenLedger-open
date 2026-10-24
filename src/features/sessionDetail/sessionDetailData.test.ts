import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { BehaviorAnalysisResponse, LogHistoryItem } from '../../types';
import {
  buildTimeline,
  contextSeries,
  loadSessionRequests,
  localDay,
  peerAverage,
  peerWindow,
  ratioToAverage,
  SESSION_DETAIL_MAX_PAGES,
  summarizeSession,
  topExpensive,
} from './sessionDetailData';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function row(id: number, patch: Partial<LogHistoryItem> = {}): LogHistoryItem {
  return {
    id,
    tool: 'claude',
    model: 'model-a',
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 300,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    cost: 0.1,
    timestamp: `2026-07-15T06:${String(id).padStart(2, '0')}:00.000Z`,
    sessionId: 'sess-1',
    machineId: 'pc',
    granularity: 'request',
    ...patch,
  };
}

function page(items: LogHistoryItem[], nextCursor: string | null = null) {
  return { items, hasMore: nextCursor !== null, nextCursor, totalCount: items.length, filteredSummary: {}, availableFilters: { tools: [], models: [], machines: [] }, granularity: 'request' };
}

describe('loadSessionRequests', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('只保留会话 ID 与工具完全相同的记录，按时间正序', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(page([row(3), row(9, { sessionId: 'sess-10' }), row(2, { tool: 'codex' })], 'c1'))
      .mockResolvedValueOnce(page([row(1)]));
    const result = await loadSessionRequests({ sessionId: 'sess-1', tool: 'Claude' }, 'Asia/Shanghai');
    expect(result?.items.map(item => item.id)).toEqual([1, 3]);
    expect(result?.truncated).toBe(false);
    const first = vi.mocked(invoke).mock.calls[0][1] as { query: Record<string, unknown> };
    expect(first.query).toMatchObject({ scope: 'local', range: 'all', tools: ['Claude'], search: 'sess-1', limit: 100, cursor: null });
    const second = vi.mocked(invoke).mock.calls[1][1] as { query: Record<string, unknown> };
    expect(second.query.cursor).toBe('c1');
  });

  it('未指定工具时不按工具过滤', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(page([row(1), row(2, { tool: 'codex' })]));
    const result = await loadSessionRequests({ sessionId: 'sess-1', tool: null }, 'UTC');
    expect(result?.items).toHaveLength(2);
    expect((vi.mocked(invoke).mock.calls[0][1] as { query: { tools: string[] } }).query.tools).toEqual([]);
  });

  it('读满上限时标记截断', async () => {
    vi.mocked(invoke).mockImplementation(async () => page([row(1)], 'more'));
    const result = await loadSessionRequests({ sessionId: 'sess-1', tool: 'claude' }, 'UTC');
    expect(invoke).toHaveBeenCalledTimes(SESSION_DETAIL_MAX_PAGES);
    expect(result?.truncated).toBe(true);
  });

  it('后端不可用时返回 null', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ status: 'unavailable', items: [] });
    expect(await loadSessionRequests({ sessionId: 'sess-1', tool: 'claude' }, 'UTC')).toBeNull();
  });
});

describe('时间线与概要', () => {
  const items = [
    row(1, { cost: 0.2, latencyMs: 1000 }),
    row(2, { model: 'model-b', cost: Number.NaN }),
    row(3, { model: 'model-b', cost: 0.5, latencyMs: 3000, requests: 4, granularity: 'hour' }),
    row(4, { model: 'model-a', cost: 0.1, cacheReadTokens: undefined, cacheWriteTokens: undefined, latencyMs: 2000 }),
  ];
  const timeline = buildTimeline(items);

  it('标出模型切换并只累加已知费用', () => {
    expect(timeline.map(entry => entry.switchedFrom)).toEqual([null, 'model-a', null, 'model-b']);
    expect(timeline.map(entry => Number(entry.cumulativeCost.toFixed(2)))).toEqual([0.2, 0.2, 0.7, 0.8]);
    expect(timeline[3].cacheHit).toBeNull();
    expect(timeline[0].cacheHit).toBeCloseTo(200 / 300);
  });

  it('概要是逐行求和，费用有缺失时合计为 null', () => {
    const summary = summarizeSession(timeline);
    expect(summary.rows).toBe(4);
    expect(summary.requests).toBeNull();
    expect(summarizeSession(buildTimeline([row(1, { requests: 3 }), row(2, { requests: 2 })])).requests).toBe(5);
    expect(summary.effectiveTokens).toBe(600);
    expect(summary.cost).toBeNull();
    expect(summary.knownCost).toBeCloseTo(0.8);
    expect(summary.unknownCostRows).toBe(1);
    expect(summary.modelSwitches).toBe(2);
    expect(summary.models).toEqual(['model-a', 'model-b']);
    expect(summary.latencyMedianMs).toBe(2000);
    expect(summary.latencyTotalMs).toBe(6000);
    expect(summary.cacheHit).toBeCloseTo(600 / 900);
    expect(summary.durationMs).toBe(3 * 60_000);
  });

  it('最贵的请求按已知费用倒序', () => {
    expect(topExpensive(timeline, 2).map(entry => entry.ordinal)).toEqual([3, 1]);
  });

  it('Context 序列只含带构成的行', () => {
    const withContext = buildTimeline([
      row(1),
      row(2, { inputTokens: 100, cachedTokens: 300, context: { systemBytes: 100, toolsBytes: 100, historyBytes: 200, toolResultsBytes: 0, attachmentsBytes: 0, messages: 3, toolResults: 0, attachments: 0 } }),
    ]);
    const series = contextSeries(withContext);
    expect(series).toHaveLength(1);
    expect(series[0].ordinal).toBe(2);
    expect(series[0].segments).toMatchObject({ systemBytes: 100, toolsBytes: 100, historyBytes: 200, toolResultsBytes: 0 });
  });
});

describe('同类会话平均', () => {
  const response = {
    meta: { start: '2026-06-16', end: '2026-07-15', sessionsTruncated: false },
    sessions: [
      { id: 'sess-1', tool: 'claude', tokens: 9000, requests: 9, cost: 9 },
      { id: 'sess-2', tool: 'claude', tokens: 1000, requests: 2, cost: 1 },
      { id: 'sess-3', tool: 'Claude', tokens: 3000, requests: 4, cost: 3 },
      { id: 'sess-4', tool: 'codex', tokens: 5000, requests: 5, cost: 5 },
    ],
  } as unknown as BehaviorAnalysisResponse;

  it('只平均同一工具的其他会话', () => {
    expect(peerAverage(response, { sessionId: 'sess-1', tool: 'claude' })).toMatchObject({ sessions: 2, tokens: 2000, rows: 3, cost: 2, windowStart: '2026-06-16' });
  });

  it('有会话费用不可得时平均费用不可得；没有其他会话时为 null', () => {
    const partial = { ...response, sessions: [...response.sessions, { id: 'sess-5', tool: 'claude', tokens: 2000, requests: 3, cost: null }] } as BehaviorAnalysisResponse;
    expect(peerAverage(partial, { sessionId: 'sess-1', tool: 'claude' })?.cost).toBeNull();
    expect(peerAverage(response, { sessionId: 'sess-4', tool: 'codex' })).toBeNull();
  });

  it('窗口与倍数', () => {
    expect(peerWindow('2026-03-01')).toEqual({ start: '2026-01-31', end: '2026-03-01' });
    expect(localDay('2026-07-15T17:00:00Z', 'Asia/Shanghai')).toBe('2026-07-16');
    expect(ratioToAverage(6, 2)).toBe(3);
    expect(ratioToAverage(6, 0)).toBeNull();
    expect(ratioToAverage(null, 2)).toBeNull();
  });
});
