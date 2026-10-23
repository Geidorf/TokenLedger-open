import { renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePeerLive } from './usePeerLive';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('usePeerLive', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('关闭时不读取', () => {
    renderHook(() => usePeerLive(false));
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it('开启后读取实时状态', async () => {
    vi.mocked(invoke).mockResolvedValue({ reachable: true, port: 3425, requests: 1, waiting: 0, tools: 0, active: [] });
    const { result } = renderHook(() => usePeerLive(true));
    await waitFor(() => expect(result.current.snapshot?.requests).toBe(1));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('peer_live_snapshot', {});
  });

  it('换端口时清空旧快照', async () => {
    vi.mocked(invoke).mockImplementation(async (_cmd, args) => ({
      reachable: true, port: 0, requests: (args as { port?: number })?.port === 4000 ? 2 : 1, waiting: 0, tools: 0, active: [], recent: [],
    }));
    const { result, rerender } = renderHook(({ port }) => usePeerLive(true, 1000, port), { initialProps: { port: 3425 } });
    await waitFor(() => expect(result.current.snapshot?.requests).toBe(1));
    rerender({ port: 4000 });
    expect(result.current.snapshot).toBeNull();
    await waitFor(() => expect(result.current.snapshot?.requests).toBe(2));
  });

  it('读取出错时保留上次快照并标记为过期，停用后清空', async () => {
    let calls = 0;
    vi.mocked(invoke).mockImplementation(async () => {
      calls += 1;
      if (calls > 1) throw '连接失败';
      return { reachable: true, port: 3425, requests: 1, waiting: 0, tools: 0, active: [], recent: [] };
    });
    const { result, rerender } = renderHook(({ on }) => usePeerLive(on), { initialProps: { on: true } });
    await waitFor(() => expect(result.current.snapshot?.requests).toBe(1));
    expect(result.current.stale).toBe(false);
    await waitFor(() => expect(result.current.stale).toBe(true), { timeout: 3000 });
    expect(result.current.snapshot?.requests).toBe(1);
    rerender({ on: false });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.stale).toBe(false);
  });
});
