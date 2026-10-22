import { act, renderHook } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogHistoryItem, UsageDetailsResponse } from '../types';
import {
  BEHAVIOR_SESSION_LOOKUP_PAGES,
  behaviorDrillRange,
  behaviorSessionDetailFilters,
  findBehaviorSessionRecord,
  supportsBehaviorSessionAnalysis,
  useBehaviorSessionAnalysis,
  type BehaviorAnalysedWindow,
} from './useBehaviorAnalysisSession';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

function row(id: number, sessionId: string, tool = 'codex'): LogHistoryItem {
  return {
    id, tool, model: 'gpt-5-codex', inputTokens: 10, outputTokens: 5, cachedTokens: 0, cost: 0.01,
    timestamp: '2026-09-24T10:00:00+08:00', sessionId, machineId: 'Studio-PC',
  };
}

function page(items: LogHistoryItem[], nextCursor: string | null = null): UsageDetailsResponse {
  return {
    status: 'ok', items, nextCursor, hasMore: nextCursor !== null, totalCount: items.length,
    filteredSummary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 },
    availableFilters: { tools: [], models: [], machines: [] }, granularity: 'request',
  };
}

// The analysed window of a 本周 result (meta.range/start/end/timezone).
const WEEK: BehaviorAnalysedWindow = { range: 'week', start: '2026-09-21', end: '2026-09-24', timezone: 'Asia/Shanghai' };

describe('supportsBehaviorSessionAnalysis', () => {
  it('offers per-turn analysis only for Claude and Codex, like the details table', () => {
    expect(supportsBehaviorSessionAnalysis('claude')).toBe(true);
    expect(supportsBehaviorSessionAnalysis('Codex')).toBe(true);
    expect(supportsBehaviorSessionAnalysis('minimax')).toBe(false);
    expect(supportsBehaviorSessionAnalysis('antigravity')).toBe(false);
  });
});

describe('findBehaviorSessionRecord', () => {
  it('asks the local details for that tool and session over the analysed dates and timezone', async () => {
    vi.mocked(invoke).mockResolvedValue(page([row(41, 'sess-1')]));
    const found = await findBehaviorSessionRecord({ id: 'sess-1', tool: 'codex' }, { start: '2026-09-01', end: '2026-09-23', timezone: 'America/Los_Angeles' });
    expect(found).toEqual({ id: 41, sessionId: 'sess-1', tool: 'codex' });
    expect(invoke).toHaveBeenCalledWith('get_usage_details', {
      query: expect.objectContaining({
        scope: 'local', range: 'custom', start: '2026-09-01', end: '2026-09-23', timezone: 'America/Los_Angeles',
        tools: ['codex'], models: [], machines: [], search: 'sess-1', cursor: null, limit: 50,
      }),
    });
  });

  it('looks a preset result up by its analysed dates, never by re-resolving the preset (review F2)', async () => {
    vi.mocked(invoke).mockResolvedValue(page([row(41, 'sess-1')]));
    // A 今日 result computed before midnight: the lookup still reads that day.
    await findBehaviorSessionRecord({ id: 'sess-1', tool: 'codex' }, { start: '2026-09-23', end: '2026-09-23', timezone: 'Asia/Shanghai' });
    const query = vi.mocked(invoke).mock.calls[0][1] as { query: Record<string, unknown> };
    expect(query.query).toMatchObject({ range: 'custom', start: '2026-09-23', end: '2026-09-23' });
  });

  it('accepts only an exact session and tool match, because details search is a substring match', async () => {
    vi.mocked(invoke).mockResolvedValue(page([row(7, 'sess-10'), row(8, 'sess-1', 'claude'), row(9, 'sess-1')]));
    expect(await findBehaviorSessionRecord({ id: 'sess-1', tool: 'codex' }, WEEK)).toEqual({ id: 9, sessionId: 'sess-1', tool: 'codex' });
  });

  it('follows the details cursor for a bounded number of pages', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(page([row(1, 'sess-10')], 'c1'))
      .mockResolvedValueOnce(page([row(2, 'sess-1')], null));
    expect(await findBehaviorSessionRecord({ id: 'sess-1', tool: 'codex' }, WEEK)).toMatchObject({ id: 2 });
    expect(invoke).toHaveBeenLastCalledWith('get_usage_details', { query: expect.objectContaining({ cursor: 'c1' }) });

    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(page([row(3, 'sess-10')], 'more'));
    expect(await findBehaviorSessionRecord({ id: 'sess-1', tool: 'codex' }, WEEK)).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(BEHAVIOR_SESSION_LOOKUP_PAGES);
  });

  it('returns null for an unavailable envelope or when the session is gone', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ status: 'unavailable', reasonCode: 'x' });
    expect(await findBehaviorSessionRecord({ id: 'sess-1', tool: 'codex' }, WEEK)).toBeNull();
    vi.mocked(invoke).mockResolvedValueOnce(page([]));
    expect(await findBehaviorSessionRecord({ id: 'sess-1', tool: 'codex' }, WEEK)).toBeNull();
  });
});

describe('behaviorDrillRange (review F2)', () => {
  // Instants given with an explicit offset, so every case holds in any host TZ.
  const at = (iso: string) => new Date(iso);
  const today = (day: string, timezone = 'Asia/Shanghai'): BehaviorAnalysedWindow => ({ range: 'today', start: day, end: day, timezone });

  it('keeps the current range while the preset still covers the analysed window', () => {
    expect(behaviorDrillRange(today('2026-09-23'), at('2026-09-23T23:59:00+08:00'))).toBeNull();
    expect(behaviorDrillRange(WEEK, at('2026-09-27T23:00:00+08:00'))).toBeNull();
    expect(behaviorDrillRange({ range: 'month', start: '2026-09-01', end: '2026-09-24', timezone: 'Asia/Shanghai' }, at('2026-09-30T12:00:00+08:00'))).toBeNull();
    expect(behaviorDrillRange({ range: 'year', start: '2026-01-01', end: '2026-09-24', timezone: 'Asia/Shanghai' }, at('2026-12-31T12:00:00+08:00'))).toBeNull();
  });

  it('hands over the analysed dates once the calendar has moved past the preset', () => {
    expect(behaviorDrillRange(today('2026-09-23'), at('2026-09-24T00:05:00+08:00'))).toEqual({ start: '2026-09-23', end: '2026-09-23' });
    // Monday 09-28 starts a new week.
    expect(behaviorDrillRange(WEEK, at('2026-09-28T08:00:00+08:00'))).toEqual({ start: '2026-09-21', end: '2026-09-24' });
    expect(behaviorDrillRange({ range: 'month', start: '2026-09-01', end: '2026-09-30', timezone: 'Asia/Shanghai' }, at('2026-10-01T00:00:00+08:00'))).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(behaviorDrillRange({ range: 'year', start: '2026-01-01', end: '2026-12-31', timezone: 'Asia/Shanghai' }, at('2027-01-01T09:00:00+08:00'))).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('reads the calendar of the analysed timezone', () => {
    // 2026-09-24 02:00 in Shanghai is still 2026-09-23 in Los Angeles.
    const instant = at('2026-09-24T02:00:00+08:00');
    expect(behaviorDrillRange(today('2026-09-23', 'America/Los_Angeles'), instant)).toBeNull();
    expect(behaviorDrillRange(today('2026-09-23', 'Asia/Shanghai'), instant)).toEqual({ start: '2026-09-23', end: '2026-09-23' });
  });

  it('keeps 全部 and custom ranges, which still contain the analysed window elsewhere', () => {
    const later = at('2027-03-01T12:00:00+08:00');
    expect(behaviorDrillRange({ range: 'all', start: '2024-09-25', end: '2026-09-24', timezone: 'Asia/Shanghai' }, later)).toBeNull();
    expect(behaviorDrillRange({ range: 'custom', start: '2026-09-01', end: '2026-09-10', timezone: 'Asia/Shanghai' }, later)).toBeNull();
    expect(behaviorDrillRange({ range: 'today', start: 'not-a-day', end: '2026-09-23', timezone: 'Asia/Shanghai' }, later)).toBeNull();
  });
});

describe('behaviorSessionDetailFilters', () => {
  it('searches the session ID within its own tool and clears every other filter', () => {
    expect(behaviorSessionDetailFilters({ id: 'sess-1', tool: 'codex' })).toEqual({ tools: ['codex'], models: [], machines: [], search: 'sess-1' });
  });
});

describe('useBehaviorSessionAnalysis', () => {
  it('shows the locating state, then hands the found record to the drawer until closed', async () => {
    let resolve!: (value: UsageDetailsResponse) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise<UsageDetailsResponse>((finish) => { resolve = finish; }));
    const { result } = renderHook(() => useBehaviorSessionAnalysis(WEEK));
    act(() => { void result.current.open({ id: 'sess-1', tool: 'codex' }); });
    expect(result.current.locatingKey).toBe('codex|sess-1');
    expect(result.current.record).toBeNull();
    await act(async () => { resolve(page([row(5, 'sess-1')])); });
    expect(result.current.locatingKey).toBeNull();
    expect(result.current.record).toEqual({ id: 5, sessionId: 'sess-1', tool: 'codex' });
    act(() => { result.current.close(); });
    expect(result.current.record).toBeNull();
  });

  it('explains when no record of the session can be found or read, naming the session', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(page([]));
    const { result } = renderHook(() => useBehaviorSessionAnalysis(WEEK));
    await act(async () => { await result.current.open({ id: 'sess-1', tool: 'codex' }); });
    expect(result.current.record).toBeNull();
    expect(result.current.failure).toBe('本次分析的区间（2026-09-21 至 2026-09-24）内已找不到会话 sess-1 的明细记录，可能已被清理，暂时无法逐轮分析。');

    vi.mocked(invoke).mockRejectedValueOnce(new Error('database is locked'));
    await act(async () => { await result.current.open({ id: 'sess-2', tool: 'codex' }); });
    expect(result.current.failure).toBe('暂时无法读取本机明细来定位会话 sess-2，请稍后重试。');
    expect(result.current.locatingKey).toBeNull();
  });

  it('does nothing without an analysed window', async () => {
    const { result } = renderHook(() => useBehaviorSessionAnalysis(null));
    await act(async () => { await result.current.open({ id: 'sess-1', tool: 'codex' }); });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.locatingKey).toBeNull();
  });

  it('drops a lookup that finishes after the analysed window changed', async () => {
    let resolve!: (value: UsageDetailsResponse) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise<UsageDetailsResponse>((finish) => { resolve = finish; }));
    const { result, rerender } = renderHook(({ analysed }: { analysed: BehaviorAnalysedWindow | null }) => useBehaviorSessionAnalysis(analysed), { initialProps: { analysed: WEEK as BehaviorAnalysedWindow | null } });
    act(() => { void result.current.open({ id: 'sess-1', tool: 'codex' }); });
    // A query change first clears the result, then a new window arrives.
    rerender({ analysed: null });
    rerender({ analysed: { ...WEEK, range: 'month', start: '2026-09-01' } });
    expect(result.current.locatingKey).toBeNull();
    await act(async () => { resolve(page([row(5, 'sess-1')])); });
    expect(result.current.record).toBeNull();
    expect(result.current.failure).toBe('');
  });

  it('closes an open drawer as soon as the analysed window changes', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(page([row(5, 'sess-1')]));
    const { result, rerender } = renderHook(
      ({ analysed }: { analysed: BehaviorAnalysedWindow }) => useBehaviorSessionAnalysis(analysed),
      { initialProps: { analysed: WEEK } },
    );
    await act(async () => { await result.current.open({ id: 'sess-1', tool: 'codex' }); });
    expect(result.current.record).toEqual({ id: 5, sessionId: 'sess-1', tool: 'codex' });

    rerender({ analysed: { ...WEEK, range: 'month', start: '2026-09-01' } });
    expect(result.current.record).toBeNull();
    expect(result.current.locatingKey).toBeNull();
    expect(result.current.failure).toBe('');
  });

  it('keeps an open drawer across a refresh of the same analysed window', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(page([row(5, 'sess-1')]));
    const { result, rerender } = renderHook(
      ({ analysed }: { analysed: BehaviorAnalysedWindow }) => useBehaviorSessionAnalysis(analysed),
      { initialProps: { analysed: WEEK } },
    );
    await act(async () => { await result.current.open({ id: 'sess-1', tool: 'codex' }); });

    rerender({ analysed: { ...WEEK } });
    expect(result.current.record).toEqual({ id: 5, sessionId: 'sess-1', tool: 'codex' });
  });

  it('keeps a lookup across a refresh of the same analysed window', async () => {
    let resolve!: (value: UsageDetailsResponse) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise<UsageDetailsResponse>((finish) => { resolve = finish; }));
    const { result, rerender } = renderHook(({ analysed }: { analysed: BehaviorAnalysedWindow }) => useBehaviorSessionAnalysis(analysed), { initialProps: { analysed: WEEK } });
    act(() => { void result.current.open({ id: 'sess-1', tool: 'codex' }); });
    // A refreshed result of the same query: a new object with the same dates.
    rerender({ analysed: { ...WEEK } });
    expect(result.current.locatingKey).toBe('codex|sess-1');
    await act(async () => { resolve(page([row(5, 'sess-1')])); });
    expect(result.current.record).toEqual({ id: 5, sessionId: 'sess-1', tool: 'codex' });
  });
});
