import { act, renderHook } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportPeriod } from '../utils/periodReport';
import { RUNNING_REPORT_REFRESH_MS, usePeriodReport } from './usePeriodReport';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const statsCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_cached_stats').length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockRejectedValue(new Error('offline'));
  vi.mocked(listen).mockResolvedValue(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('usePeriodReport refresh', () => {
  it('re-reads a running period on a timer and on focus, since gateway writes send no event', async () => {
    const period = reportPeriod('week', 0, '2026-10-21');
    renderHook(() => usePeriodReport({ scope: 'local', period, timezone: 'UTC', active: true }));
    await act(async () => {});
    const first = statsCalls();
    expect(first).toBeGreaterThan(0);
    await act(async () => { vi.advanceTimersByTime(RUNNING_REPORT_REFRESH_MS); });
    expect(statsCalls()).toBeGreaterThan(first);
    const second = statsCalls();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(statsCalls()).toBeGreaterThan(second);
  });

  it('leaves a finished period alone', async () => {
    const period = reportPeriod('week', -1, '2026-10-21');
    renderHook(() => usePeriodReport({ scope: 'local', period, timezone: 'UTC', active: true }));
    await act(async () => {});
    const first = statsCalls();
    await act(async () => { vi.advanceTimersByTime(RUNNING_REPORT_REFRESH_MS * 2); window.dispatchEvent(new Event('focus')); });
    expect(statsCalls()).toBe(first);
  });
});
