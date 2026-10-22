import { act, renderHook, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { DataScope, RangeKey, StatsData } from '../types';
import { useUsageDetails } from './useUsageDetails';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = invoke as unknown as Mock;

function cloudCapableStats(): StatsData {
  return {
    meta: { contractVersion: 2, capabilities: { detailPagination: true } },
  } as unknown as StatsData;
}

/** 已到达但确实不支持明细分页的云端契约（旧版）——与「stats 尚未到达」是两回事（T10.180）。 */
function cloudLegacyStats(): StatsData {
  return {
    meta: { contractVersion: 2, capabilities: { detailPagination: false } },
  } as unknown as StatsData;
}

const cloudMonthProps = {
  dataScope: 'cloud' as DataScope,
  range: 'month' as RangeKey,
  deviceFilter: 'all_cloud',
  stats: cloudCapableStats(),
  statsError: '',
  currentTimezone: () => 'Asia/Shanghai',
};

function lastQuery() {
  const call = invokeMock.mock.calls[invokeMock.mock.calls.length - 1];
  expect(call?.[0]).toBe('get_usage_details');
  return (call?.[1] as { query: Record<string, unknown> }).query;
}

describe('useUsageDetails 查询上下文桥接（T10.60 回归）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error('network unavailable'));
  });

  it('loadDetails 使用传入的 scope 与 range，而非固定 local/today', async () => {
    const { result } = renderHook((props) => useUsageDetails(props), {
      initialProps: cloudMonthProps,
    });
    await act(async () => {
      await result.current.loadDetails();
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(lastQuery()).toMatchObject({ scope: 'cloud', range: 'month' });
  });

  it('自定义区间把 start/end 一起送进明细查询（T10.108）', async () => {
    const { result } = renderHook((props) => useUsageDetails(props), {
      initialProps: {
        ...cloudMonthProps,
        dataScope: 'local' as DataScope,
        range: 'custom' as RangeKey,
        customRange: { start: '2026-08-01', end: '2026-08-31' },
        stats: null as StatsData | null,
      },
    });
    await act(async () => {
      await result.current.loadDetails();
    });
    expect(lastQuery()).toMatchObject({ scope: 'local', range: 'custom', start: '2026-08-01', end: '2026-08-31' });
  });

  it('查询上下文 props 变化后，下一次 loadDetails 携带新的 scope/range', async () => {
    const { result, rerender } = renderHook((props) => useUsageDetails(props), {
      initialProps: {
        ...cloudMonthProps,
        dataScope: 'local' as DataScope,
        range: 'today' as RangeKey,
        stats: null as StatsData | null,
      },
    });
    await act(async () => {
      await result.current.loadDetails();
    });
    expect(lastQuery()).toMatchObject({ scope: 'local', range: 'today' });

    rerender({ ...cloudMonthProps });
    await act(async () => {
      await result.current.loadDetails();
    });
    expect(lastQuery()).toMatchObject({ scope: 'cloud', range: 'month' });
  });

  it('筛选更新会重建 loadDetails 并把筛选写入查询', async () => {
    const { result } = renderHook((props) => useUsageDetails(props), {
      initialProps: cloudMonthProps,
    });
    const staleLoadDetails = result.current.loadDetails;
    act(() => {
      result.current.updateDetailFilter('tools', ['codex']);
    });
    expect(result.current.loadDetails).not.toBe(staleLoadDetails);
    await act(async () => {
      await result.current.loadDetails();
    });
    expect(lastQuery()).toMatchObject({ tools: ['codex'] });
  });

  it('云端缺少 detailPagination 能力时不发请求并提示入口停用', async () => {
    const { result } = renderHook((props) => useUsageDetails(props), {
      initialProps: { ...cloudMonthProps, stats: cloudLegacyStats() },
    });
    await act(async () => {
      await result.current.loadDetails();
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.detailsError).toContain('旧版统计契约');
  });

  it('云端 stats 尚未到达且未失败时按加载中处理，不诊断为旧版契约（T10.180）', async () => {
    const { result } = renderHook((props) => useUsageDetails(props), {
      initialProps: { ...cloudMonthProps, stats: null as StatsData | null, statsError: '' },
    });
    await act(async () => {
      await result.current.loadDetails();
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.detailsLoading).toBe(true);
    expect(result.current.detailsError).toBe('');
  });

  it('云端 stats 已失败时转述真实原因，不诊断为旧版契约（T10.180）', async () => {
    const { result } = renderHook((props) => useUsageDetails(props), {
      initialProps: {
        ...cloudMonthProps,
        stats: null as StatsData | null,
        statsError: '云端服务暂不可用：网络连接中断',
      },
    });
    await act(async () => {
      await result.current.loadDetails();
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.current.detailsLoading).toBe(false);
    expect(result.current.detailsError).toBe('云端服务暂不可用：网络连接中断');
  });
});

describe('云端 stats 失败后明细追上真实错误并可重试（T10.180 独立评审 P2-1）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error('network unavailable'));
  });

  /**
   * src/App.tsx 里调用 loadDetails() 的 useEffect 的最小复现：真实 hook + 同款
   * 「有意不穷举」依赖数组（该处带 eslint-disable-next-line react-hooks/exhaustive-deps）。
   * 复现的正是独立评审指出的缺口——`statsError` 不在依赖数组里时，云端 stats
   * 从「未到达」转为「失败」不会重新触发 loadDetails()，明细会卡在「读取中」，
   * 不会显示真实错误，也就没有重试入口（LogsTable.tsx 的 `error && !details`
   * 分支才会渲染重试按钮）。这里的依赖数组必须与 src/App.tsx 当前实际列出的
   * 依赖保持同步；App.tsx 侧改动见该文件里 usageDetails.loadDetails() 的 useEffect。
   */
  function useAppLikeCloudDetails(statsError: string) {
    const details = useUsageDetails({
      dataScope: 'cloud',
      range: 'month',
      deviceFilter: 'all_cloud',
      stats: null,
      statsError,
      currentTimezone: () => 'Asia/Shanghai',
    });
    useEffect(() => {
      void details.loadDetails();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [statsError]);
    return details;
  }

  it('云端 stats 从加载中转为失败后，明细显示真实错误；stats 恢复后自动重试', async () => {
    const { result, rerender } = renderHook(
      (props: { statsError: string }) => useAppLikeCloudDetails(props.statsError),
      { initialProps: { statsError: '' } },
    );
    await waitFor(() => expect(result.current.detailsLoading).toBe(true));
    expect(result.current.detailsError).toBe('');

    rerender({ statsError: '云端连接已过期，请重新登录。' });
    await waitFor(() => expect(result.current.detailsLoading).toBe(false));
    expect(result.current.detailsError).toBe('云端连接已过期，请重新登录。');

    // 重试：一旦上层重新拿到 stats（statsError 清空），同一个 effect 会再次触发，
    // 不需要用户手动做任何别的操作。
    rerender({ statsError: '' });
    await waitFor(() => expect(result.current.detailsLoading).toBe(true));
    expect(result.current.detailsError).toBe('');
  });
});
