import { renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePeerLive } from './usePeerLive';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('usePeerLive', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

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
});
