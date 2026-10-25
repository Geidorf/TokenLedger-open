import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetRule } from './useBudget';
import { useBudgetSettings, useBudgetStatus } from './useBudget';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const RULE: BudgetRule = {
  id: 'monthly',
  enabled: true,
  period: 'month',
  metric: 'cost',
  scopeKind: 'all',
  scopeId: '',
  limit: 50,
  warnPercent: 80,
};

function response(used: number, percent: number, level: 'ok' | 'warn' | 'over' = 'ok') {
  return {
    generatedAt: '2026-10-24T00:00:00Z',
    statuses: [{ ruleId: RULE.id, periodStart: '2026-10-01', used, limit: RULE.limit, percent, level }],
    choices: { tools: [], models: [], providers: [], providersAvailable: false },
    phoneSync: { state: 'off', lastPublishedAt: null, error: null },
  };
}

let listeners: Map<string, () => void>;
let unlisten = vi.fn<() => void>();
let settingsReply: () => Promise<unknown>;
let statusReply: () => Promise<unknown>;

beforeEach(() => {
  listeners = new Map();
  unlisten = vi.fn<() => void>();
  settingsReply = async () => ({ notify: false, syncToPhone: false, rules: [RULE] });
  statusReply = async () => response(10, 20);
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === 'get_budget_settings') return settingsReply();
    if (command === 'get_budget_status') return statusReply();
    return Promise.reject(new Error(`unexpected ${String(command)}`));
  });
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    listeners.set(event, handler as () => void);
    return unlisten;
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useBudgetSettings', () => {
  it('reports a read failure, can retry, and ignores a late first response', async () => {
    const first = deferred<unknown>();
    settingsReply = () => first.promise;
    const { result } = renderHook(() => useBudgetSettings());

    expect(result.current.loading).toBe(true);
    await act(async () => {
      first.reject(new Error('offline'));
      await first.promise.catch(() => undefined);
    });
    await waitFor(() => expect(result.current.error).toBe('读取预算设置失败'));
    expect(result.current.loaded).toBe(true);

    settingsReply = async () => ({ notify: false, syncToPhone: false, rules: [RULE] });
    await act(async () => result.current.reload());
    await waitFor(() => expect(result.current.settings.rules).toEqual([RULE]));
    expect(result.current.error).toBe('');
    expect(result.current.loaded).toBe(true);

    const stale = deferred<unknown>();
    const latest = deferred<unknown>();
    let call = 0;
    settingsReply = () => (++call === 1 ? stale.promise : latest.promise);
    act(() => { void result.current.reload(); });
    act(() => { void result.current.reload(); });
    await act(async () => {
      stale.resolve({ notify: true, syncToPhone: false, rules: [] });
      await stale.promise;
    });
    expect(result.current.settings.rules).toEqual([RULE]);
    await act(async () => {
      latest.resolve({ notify: true, syncToPhone: false, rules: [] });
      await latest.promise;
    });
    expect(result.current.settings.rules).toEqual([]);
  });
});

describe('useBudgetStatus', () => {
  it('exposes first load and refresh state, and ignores out-of-order responses', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    statusReply = () => first.promise;
    const revision = { rules: [RULE] };
    const { result } = renderHook(() => useBudgetStatus(revision));

    expect(result.current.loading).toBe(true);
    await act(async () => {
      first.resolve(response(10, 20));
      await first.promise;
    });
    await waitFor(() => expect(result.current.report?.statuses[0]?.used).toBe(10));
    expect(result.current.refreshing).toBe(false);

    statusReply = () => second.promise;
    await act(async () => { listeners.get('stats-updated')?.(); });
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      second.resolve(response(25, 50, 'warn'));
      await second.promise;
    });
    await waitFor(() => expect(result.current.report?.statuses[0]?.used).toBe(25));

    const stale = deferred<unknown>();
    const latest = deferred<unknown>();
    statusReply = () => stale.promise;
    act(() => { void result.current.reload(); });
    statusReply = () => latest.promise;
    act(() => { void result.current.reload(); });
    await act(async () => {
      stale.resolve(response(40, 80, 'warn'));
      await stale.promise;
    });
    expect(result.current.report?.statuses[0]?.used).toBe(25);
    await act(async () => {
      latest.resolve(response(5, 10));
      await latest.promise;
    });
    await waitFor(() => expect(result.current.report?.statuses[0]?.used).toBe(5));
  });

  it('clears the old report when a refresh fails', async () => {
    const revision = { rules: [RULE] };
    const { result } = renderHook(() => useBudgetStatus(revision));
    await waitFor(() => expect(result.current.report?.statuses[0]?.used).toBe(10));

    statusReply = async () => { throw new Error('offline'); };
    await act(async () => { await result.current.reload(); });
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBe('预算用量读取失败');
    expect(result.current.loading).toBe(false);
  });

  it('hides the previous report as soon as settings change and ignores its late response', async () => {
    const oldSettings = { rules: [RULE] };
    const newSettings = { rules: [{ ...RULE, period: 'week' as const }] };
    const oldResponse = deferred<unknown>();
    const newResponse = deferred<unknown>();
    const newRuleReadings: Array<number | undefined> = [];
    const { result, rerender } = renderHook(
      ({ revision }) => {
        const budget = useBudgetStatus(revision);
        if (revision === newSettings) newRuleReadings.push(budget.report?.statuses[0]?.used ?? undefined);
        return budget;
      },
      { initialProps: { revision: oldSettings } },
    );
    await waitFor(() => expect(result.current.report?.statuses[0]?.used).toBe(10));

    statusReply = () => oldResponse.promise;
    act(() => { result.current.reload(); });
    statusReply = () => newResponse.promise;
    rerender({ revision: newSettings });
    expect(result.current.report).toBeNull();
    expect(newRuleReadings.every(value => value === undefined)).toBe(true);
    await act(async () => {
      oldResponse.resolve(response(20, 40));
      await oldResponse.promise;
    });
    expect(result.current.report).toBeNull();

    await act(async () => {
      newResponse.resolve({
        ...response(1, 2),
        statuses: [{ ruleId: RULE.id, periodStart: '2026-10-19', used: 1, limit: 50, percent: 2, level: 'ok' }],
      });
      await newResponse.promise;
    });
    await waitFor(() => expect(result.current.report?.statuses[0]?.used).toBe(1));
  });

  it('unsubscribes and ignores a response that arrives after unmount', async () => {
    const pending = deferred<unknown>();
    statusReply = () => pending.promise;
    const revision = { rules: [RULE] };
    const { result, unmount } = renderHook(() => useBudgetStatus(revision));
    await waitFor(() => expect(listen).toHaveBeenCalled());
    expect(result.current.loading).toBe(true);
    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalled());
    await act(async () => {
      pending.resolve(response(20, 40));
      await pending.promise;
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it('cleans up a late subscription and ignores events after unmount', async () => {
    const subscription = deferred<() => void>();
    vi.mocked(listen).mockReturnValue(subscription.promise);
    const revision = { rules: [RULE] };
    const { result, unmount } = renderHook(() => useBudgetStatus(revision));
    await waitFor(() => expect(result.current.report).not.toBeNull());
    const handler = vi.mocked(listen).mock.calls[0][1];
    unmount();
    await act(async () => {
      subscription.resolve(unlisten);
      await subscription.promise;
      handler({ event: 'stats-updated', id: 1, payload: undefined });
    });
    expect(unlisten).toHaveBeenCalledOnce();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it('refreshes on a new local day, every five minutes, and when visible again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 24, 23, 59));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const revision = { rules: [RULE] };
    const { unmount } = renderHook(() => useBudgetStatus(revision));
    await act(async () => {});
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000); });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(3);

    visibility.mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(3);
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(4);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(4);
  });
});
