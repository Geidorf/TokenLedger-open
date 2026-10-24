import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePeriodReportSettings } from './usePeriodReport';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('usePeriodReportSettings', () => {
  it('refuses to save defaults before the stored settings are read', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => usePeriodReportSettings());
    await waitFor(() => expect(result.current.error).toBe('读取报告提醒设置失败'));
    expect(result.current.loaded).toBe(false);
    await act(() => result.current.save({ weekly: true, monthly: false }));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('saves on top of the stored settings once they are read', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ weekly: false, monthly: true })
      .mockImplementationOnce(async (_command, args) => (args as { settings: unknown }).settings);
    const { result } = renderHook(() => usePeriodReportSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(() => result.current.save({ ...result.current.settings, weekly: true }));
    expect(invoke).toHaveBeenLastCalledWith('set_period_report_settings', { settings: { weekly: true, monthly: true } });
    expect(result.current.settings).toEqual({ weekly: true, monthly: true });
  });
});
