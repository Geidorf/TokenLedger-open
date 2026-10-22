import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BehaviorAnalysisResponse, CustomDateRange, DataScope, RangeKey } from '../types';
import { BEHAVIOR_REFRESH_DEBOUNCE_MS, behaviorRangeBounds, useBehaviorAnalysis } from './useBehaviorAnalysis';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const listeners = new Map<string, (event?: { payload?: { state?: string } }) => void>();
const unlisten = vi.fn();

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

beforeEach(() => {
  listeners.clear();
  // The previous test's hook unmounts (and unlistens) after afterEach cleared the mocks.
  unlisten.mockClear();
  setVisibility('visible');
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    listeners.set(event, handler as () => void);
    return unlisten;
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function response(tokens: number): BehaviorAnalysisResponse {
  return {
    meta: { source: 'local', complete: true, range: 'today', start: '2026-09-23', end: '2026-09-23', timezone: 'Asia/Shanghai', recordCount: 1, firstRecordAt: null, lastRecordAt: null, sessionLimit: 100, sessionsTruncated: false },
    summary: { tokens, inputTokens: tokens, outputTokens: 0, cachedTokens: 0, requests: 1, activeDays: 1, toolCount: 0, sessionCount: 0, modelCount: 0 },
    tools: [], sessions: [], dayHours: [], modelHours: [], modelDays: [], requestSizes: [],
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('behaviorRangeBounds', () => {
  // Presets mean the same calendar windows as the Stats v2 dashboard (this week
  // from Monday, this month from the 1st, ...) and are resolved by the backend
  // in the selected timezone. The client therefore sends no rolling "last N
  // days" bounds, which the backend ignored for presets anyway, and no local
  // date arithmetic can drift with the host TZ.
  it('leaves preset windows to the backend calendar semantics', () => {
    for (const range of ['today', 'week', 'month', 'year', 'all'] as const) {
      expect(behaviorRangeBounds(range, null)).toEqual({});
      expect(behaviorRangeBounds(range, { start: '2026-09-01', end: '2026-09-23' })).toEqual({});
    }
  });

  it('preserves explicit custom bounds and does not invent missing bounds', () => {
    expect(behaviorRangeBounds('custom', { start: '2026-09-01', end: '2026-09-23' })).toEqual({ start: '2026-09-01', end: '2026-09-23' });
    expect(behaviorRangeBounds('custom', null)).toEqual({});
  });
});

describe('useBehaviorAnalysis', () => {
  it('requests presets without bounds and custom ranges with their exact dates', async () => {
    vi.mocked(invoke).mockResolvedValue(response(1));
    const { rerender } = renderHook(
      ({ range, customRange }: { range: RangeKey; customRange: CustomDateRange | null }) => useBehaviorAnalysis({ scope: 'local', range, customRange, timezone: 'America/Los_Angeles' }),
      { initialProps: { range: 'week' as RangeKey, customRange: null as CustomDateRange | null } },
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenLastCalledWith('get_local_behavior_analysis', {
      query: expect.objectContaining({ range: 'week', start: null, end: null, timezone: 'America/Los_Angeles' }),
    });
    rerender({ range: 'custom', customRange: { start: '2026-09-01', end: '2026-09-23' } });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith('get_local_behavior_analysis', {
      query: expect.objectContaining({ range: 'custom', start: '2026-09-01', end: '2026-09-23' }),
    });
  });

  it('ignores a local response after switching to cloud scope', async () => {
    let resolve!: (value: BehaviorAnalysisResponse) => void;
    vi.mocked(invoke).mockImplementation(() => new Promise<BehaviorAnalysisResponse>(finish => { resolve = finish; }));
    const { result, rerender } = renderHook(({ scope }: { scope: DataScope }) => useBehaviorAnalysis({ scope, range: 'today', customRange: null, timezone: 'Asia/Shanghai' }), { initialProps: { scope: 'local' as DataScope } });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    rerender({ scope: 'cloud' });
    await act(async () => { resolve(response(42)); });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps only the newest range response', async () => {
    const pending: Array<(value: BehaviorAnalysisResponse) => void> = [];
    vi.mocked(invoke).mockImplementation(() => new Promise<BehaviorAnalysisResponse>(finish => { pending.push(finish); }));
    const { result, rerender } = renderHook(({ range }: { range: RangeKey }) => useBehaviorAnalysis({ scope: 'local', range, customRange: null, timezone: 'Asia/Shanghai' }), { initialProps: { range: 'today' as RangeKey } });
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender({ range: 'week' });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[0](response(1)); });
    expect(result.current.data).toBeNull();
    await act(async () => { pending[1](response(2)); });
    expect(result.current.data?.summary.tokens).toBe(2);
  });

  it('clears the previous result when a custom range has no dates', async () => {
    vi.mocked(invoke).mockResolvedValue(response(42));
    const { result, rerender } = renderHook(({ range }: { range: RangeKey }) => useBehaviorAnalysis({ scope: 'local', range, customRange: null, timezone: 'Asia/Shanghai' }), { initialProps: { range: 'today' as RangeKey } });
    await waitFor(() => expect(result.current.data?.summary.tokens).toBe(42));
    rerender({ range: 'custom' });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toContain('完整日期区间');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('sends a project filter only when one is set, and drops it when the index is turned off', async () => {
    vi.mocked(invoke).mockResolvedValue(response(1));
    const { result } = renderHook(() => useBehaviorAnalysis({ scope: 'local', range: 'week', customRange: null, timezone: 'Asia/Shanghai' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenLastCalledWith('get_local_behavior_analysis', {
      query: expect.objectContaining({ range: 'week' }),
    });

    act(() => { result.current.setProjectFilter(['n:sample-webapp']); });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith('get_local_behavior_analysis', {
      query: expect.objectContaining({ range: 'week' }),
      projects: ['n:sample-webapp'],
    });
    await waitFor(() => expect(listeners.has('project-index-updated')).toBe(true));

    await act(async () => {
      listeners.get('project-index-updated')?.({ payload: { state: 'disabled' } });
    });
    await waitFor(() => expect(result.current.projectFilter).toEqual([]));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('get_local_behavior_analysis', {
      query: expect.objectContaining({ range: 'week' }),
    }));
    const calls = vi.mocked(invoke).mock.calls;
    expect(calls[calls.length - 1]?.[1]).not.toHaveProperty('projects');
  });
});

describe('useBehaviorAnalysis refresh', () => {
  const pending: Array<Deferred<BehaviorAnalysisResponse>> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    pending.length = 0;
    vi.mocked(invoke).mockImplementation(() => {
      const request = deferred<BehaviorAnalysisResponse>();
      pending.push(request);
      return request.promise;
    });
  });

  const elapse = (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  const settle = (index: number, value: BehaviorAnalysisResponse) => act(async () => { pending[index].resolve(value); });
  const statsUpdated = () => act(async () => { listeners.get('stats-updated')?.(); });
  const visibilityChanged = (state: 'visible' | 'hidden') => act(async () => {
    setVisibility(state);
    document.dispatchEvent(new Event('visibilitychange'));
  });

  function renderLive(initial: { range?: RangeKey; scope?: DataScope; active?: boolean } = {}) {
    return renderHook(
      ({ range, scope, active }: { range: RangeKey; scope: DataScope; active: boolean }) => useBehaviorAnalysis({ scope, range, customRange: null, timezone: 'Asia/Shanghai', active }),
      { initialProps: { range: 'today' as RangeKey, scope: 'local' as DataScope, active: true, ...initial } },
    );
  }

  it('reloads the same query after stats-updated and keeps the shown result until the new one lands', async () => {
    const { result } = renderLive();
    await elapse(0);
    expect(listen).toHaveBeenCalledWith('stats-updated', expect.any(Function));
    expect(result.current.loading).toBe(true);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.updatedAt).toBeNull();
    await settle(0, response(1));
    const shown = result.current.data;
    const firstUpdate = result.current.updatedAt;
    expect(shown?.summary.tokens).toBe(1);
    expect(firstUpdate).not.toBeNull();
    expect(result.current.loading).toBe(false);

    await statsUpdated();
    expect(pending).toHaveLength(1);
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS);
    expect(pending).toHaveLength(2);
    expect(result.current.data).toBe(shown);
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);

    await settle(1, response(2));
    expect(result.current.data?.summary.tokens).toBe(2);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.updatedAt).not.toBe(firstUpdate);
  });

  it('coalesces a burst of updates into one reload', async () => {
    renderLive();
    await elapse(0);
    await settle(0, response(1));
    await statsUpdated();
    await statsUpdated();
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS / 2);
    await statsUpdated();
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS - 1);
    expect(pending).toHaveLength(1);
    await elapse(1);
    expect(pending).toHaveLength(2);
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 3);
    expect(pending).toHaveLength(2);
  });

  it('skips updates while the window is hidden and reloads once it is visible again', async () => {
    const { result } = renderLive();
    await elapse(0);
    await settle(0, response(1));
    const shown = result.current.data;
    await visibilityChanged('hidden');
    await statsUpdated();
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 2);
    expect(pending).toHaveLength(1);

    await visibilityChanged('visible');
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS);
    expect(pending).toHaveLength(2);
    expect(result.current.data).toBe(shown);
    expect(result.current.refreshing).toBe(true);
  });

  it('does not re-aggregate on a return to the window without an update or a new day', async () => {
    vi.setSystemTime(new Date('2026-09-24T12:00:00+08:00'));
    renderLive();
    await elapse(0);
    await settle(0, response(1));
    await visibilityChanged('hidden');
    await visibilityChanged('visible');
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 3);
    expect(pending).toHaveLength(1);

    // Past midnight in the selected zone (Asia/Shanghai) "today" is another window.
    await visibilityChanged('hidden');
    vi.setSystemTime(new Date('2026-09-25T00:30:00+08:00'));
    await visibilityChanged('visible');
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS);
    expect(pending).toHaveLength(2);
    await settle(1, response(2));
    await visibilityChanged('hidden');
    await visibilityChanged('visible');
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 3);
    expect(pending).toHaveLength(2);
  });

  it('runs one follow-up reload for updates that arrive while a reload is running', async () => {
    renderLive();
    await elapse(0);
    await settle(0, response(1));
    await statsUpdated();
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS);
    expect(pending).toHaveLength(2);

    await statsUpdated();
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS);
    await statsUpdated();
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 3);
    expect(pending).toHaveLength(2);

    await settle(1, response(2));
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS);
    expect(pending).toHaveLength(3);
    await settle(2, response(3));
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 3);
    expect(pending).toHaveLength(3);
  });

  it('drops a pending refresh when the query changes or the window hides', async () => {
    const { rerender } = renderLive();
    await elapse(0);
    await settle(0, response(1));
    await statsUpdated();
    // The new query reads after the update, and settles before the debounce
    // would have fired: no second aggregation of the new query follows.
    rerender({ range: 'week', scope: 'local', active: true });
    await elapse(0);
    expect(pending).toHaveLength(2);
    await settle(1, response(2));
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 3);
    expect(pending).toHaveLength(2);

    await statsUpdated();
    await visibilityChanged('hidden');
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 3);
    expect(pending).toHaveLength(2);
    await visibilityChanged('visible');
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS);
    expect(pending).toHaveLength(3);
  });

  it('reads the ledger only after the update listener is registered', async () => {
    const registration = deferred<() => void>();
    vi.mocked(listen).mockImplementationOnce(async (event, handler) => {
      listeners.set(event, handler as () => void);
      return registration.promise;
    });
    const { result } = renderLive();
    await elapse(0);
    expect(result.current.loading).toBe(true);
    expect(pending).toHaveLength(0);

    await act(async () => { registration.resolve(unlisten); });
    await elapse(0);
    expect(pending).toHaveLength(1);
  });

  it('falls back to a reload on every return to the window when the listener fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(listen).mockRejectedValueOnce(new Error('event bridge unavailable'));
    renderLive();
    await elapse(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
    await settle(0, response(1));

    await visibilityChanged('hidden');
    await visibilityChanged('visible');
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS);
    expect(pending).toHaveLength(2);
    await settle(1, response(1));
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 3);
    expect(pending).toHaveLength(2);
    warn.mockRestore();
  });

  it('does not listen or refresh while the view is inactive or in cloud scope', async () => {
    const { rerender } = renderLive({ active: false });
    await elapse(0);
    expect(listen).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);

    rerender({ range: 'today', scope: 'local', active: true });
    await elapse(0);
    expect(listen).toHaveBeenCalledWith('stats-updated', expect.any(Function));
    expect(listen).toHaveBeenCalledWith('project-index-updated', expect.any(Function));
    const staleHandler = listeners.get('stats-updated');
    await settle(0, response(1));

    rerender({ range: 'today', scope: 'cloud', active: true });
    await elapse(0);
    expect(unlisten).toHaveBeenCalledTimes(2);
    await act(async () => { staleHandler?.(); });
    await visibilityChanged('visible');
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS * 2);
    expect(pending).toHaveLength(1);
  });

  it('never lets a stale refresh overwrite a newer query', async () => {
    const { result, rerender } = renderLive();
    await elapse(0);
    await settle(0, response(1));
    await statsUpdated();
    await elapse(BEHAVIOR_REFRESH_DEBOUNCE_MS);
    expect(pending).toHaveLength(2);

    rerender({ range: 'week', scope: 'local', active: true });
    await elapse(0);
    expect(pending).toHaveLength(3);
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.refreshing).toBe(false);

    await settle(1, response(99));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    await settle(2, response(3));
    expect(result.current.data?.summary.tokens).toBe(3);
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(false);
  });

  it('keeps the same result object when a manual refresh returns identical content', async () => {
    const { result } = renderLive();
    await elapse(0);
    await settle(0, response(5));
    const shown = result.current.data;
    const firstUpdate = result.current.updatedAt;
    await elapse(1_000);

    await act(async () => { void result.current.reload(); });
    expect(pending).toHaveLength(2);
    expect(result.current.data).toBe(shown);
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);

    await settle(1, response(5));
    expect(result.current.data).toBe(shown);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.updatedAt).not.toBe(firstUpdate);
  });

  it('keeps the shown result through a manual refresh until the new one lands (T10.150 QA F9)', async () => {
    const { result } = renderLive();
    await elapse(0);
    await settle(0, response(1));
    const shown = result.current.data;

    await act(async () => { void result.current.reload(); });
    // Never cleared while the same query reloads, so the charts stay mounted.
    expect(result.current.data).toBe(shown);
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(true);

    await settle(1, response(2));
    expect(result.current.data).not.toBe(shown);
    expect(result.current.data?.summary.tokens).toBe(2);
    expect(result.current.refreshing).toBe(false);
  });

  it('reports a failed refresh until a later one succeeds, never dropping the shown result', async () => {
    const { result } = renderLive();
    await elapse(0);
    await settle(0, response(1));
    const shown = result.current.data;
    const firstUpdate = result.current.updatedAt;

    await act(async () => { void result.current.reload(); });
    await act(async () => { pending[1].reject(new Error('database is locked')); });
    expect(result.current.data).toBe(shown);
    expect(result.current.error).toBe('加载本机行为分析失败：Error: database is locked');
    expect(result.current.updatedAt).toBe(firstUpdate);

    // Retrying keeps both the old result and the error until the answer lands.
    await elapse(1_000);
    await act(async () => { void result.current.reload(); });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.data).toBe(shown);
    expect(result.current.error).not.toBe('');
    await settle(2, response(3));
    expect(result.current.error).toBe('');
    expect(result.current.data?.summary.tokens).toBe(3);
    expect(result.current.updatedAt).not.toBe(firstUpdate);
  });

  it('keeps the previous result and its time when a refresh fails', async () => {
    const { result } = renderLive();
    await elapse(0);
    await settle(0, response(1));
    const shown = result.current.data;
    const firstUpdate = result.current.updatedAt;

    await act(async () => { void result.current.reload(); });
    expect(result.current.refreshing).toBe(true);
    await act(async () => { pending[1].reject(new Error('database is locked')); });
    expect(result.current.data).toBe(shown);
    expect(result.current.error).toContain('加载本机行为分析失败');
    expect(result.current.updatedAt).toBe(firstUpdate);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.loading).toBe(false);
  });
});
