import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerSharedUsageCard, type PeerSharedListing } from './PeerSharedUsageCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const listing: PeerSharedListing = {
  computers: [
    { id: 'aa', name: 'studio', days: 12, latest: '2026-10-22', enabled: false },
    { id: 'bb', name: '', days: 3, latest: '2026-10-21', enabled: true },
  ],
  last: { pulledAt: '2026-10-22T08:00:00Z', computers: [{ id: 'bb', name: 'bb', days: 3, calls: 9 }] },
};

describe('PeerSharedUsageCard', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('打开时不访问服务器；列出电脑时只勾选已在统计的', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'peer_sync_shared_list') return listing;
      return undefined;
    });
    render(<PeerSharedUsageCard />);
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查看共享用量的电脑' }));
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).toBeChecked();
    expect(screen.getByText('studio')).toBeInTheDocument();
    expect(screen.getByText(/已统计 1 台电脑的 9 次调用/)).toBeInTheDocument();
  });

  it('统计勾选的电脑，并能停止统计', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'peer_sync_shared_list') return listing;
      if (cmd === 'peer_sync_shared_pull') {
        return { pulledAt: '2026-10-23T08:00:00Z', computers: [{ id: 'aa', name: 'studio', days: 12, calls: 40 }, { id: 'bb', name: 'bb', days: 3, calls: 9 }] };
      }
      return undefined;
    });
    render(<PeerSharedUsageCard />);
    fireEvent.click(screen.getByRole('button', { name: '查看共享用量的电脑' }));
    const boxes = await screen.findAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(screen.getByRole('button', { name: '统计选中的 2 台电脑' }));
    expect(await screen.findByText(/已统计 2 台电脑的 49 次调用/)).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('peer_sync_shared_pull', { ids: ['bb', 'aa'] });

    fireEvent.click(screen.getByRole('button', { name: '停止统计并清除' }));
    expect(await screen.findByText(/已停止统计其他电脑的用量/)).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('peer_sync_shared_clear');
    await waitFor(() => expect(screen.getByRole('button', { name: '不统计任何电脑' })).toBeInTheDocument());
  });

  it('不连服务器也能停止统计', async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    render(<PeerSharedUsageCard />);
    fireEvent.click(screen.getByRole('button', { name: '停止统计并清除' }));
    expect(await screen.findByText(/已停止统计其他电脑的用量/)).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('peer_sync_shared_clear');
  });

  it('显示服务器错误', async () => {
    vi.mocked(invoke).mockRejectedValue('请先填写 WebDAV 地址。');
    render(<PeerSharedUsageCard />);
    fireEvent.click(screen.getByRole('button', { name: '查看共享用量的电脑' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请先填写 WebDAV 地址。');
  });
});
