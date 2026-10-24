import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PriceTableStatusRow } from './PriceTableStatusRow';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const status = (overrides: Record<string, unknown> = {}) => ({
  source: 'bundled',
  revision: 2,
  verifiedAt: '2026-09-24',
  updatedAt: '2026-10-24',
  bundledRevision: 2,
  bundledVerifiedAt: '2026-09-24',
  fetchedAt: null,
  lastCheckedAt: null,
  lastError: null,
  autoUpdate: true,
  overrideModels: 0,
  ...overrides,
});

describe('PriceTableStatusRow', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('显示价格表出处，手动检查后显示新修订（编辑框由 prices-updated 事件负责重新读取）', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'get_price_table_status') return status();
      if (command === 'check_price_table_update') {
        return status({ source: 'online', revision: 3, fetchedAt: '2026-10-24T04:00:00Z', lastCheckedAt: '2026-10-24T04:00:00Z' });
      }
      throw new Error(`unexpected ${String(command)}`);
    });
    render(<PriceTableStatusRow />);

    expect(await screen.findByText('内置价格表（第 2 版） · 官方价核验于 2026-09-24')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /检查更新/ }));
    expect(await screen.findByText(/^在线更新的价格表（第 3 版）/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('get_prices');
  });

  it('自动更新开关写回后端', async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => (
      command === 'set_price_table_auto_update'
        ? status({ autoUpdate: (args as { enabled: boolean }).enabled })
        : status()
    ));
    render(<PriceTableStatusRow />);
    const toggle = await screen.findByRole('switch', { name: '每天自动更新价格表' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_price_table_auto_update', { enabled: false }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '每天自动更新价格表' })).toHaveAttribute('aria-checked', 'false'));
  });

  it('编辑器保存或恢复默认后重读出处与覆盖数', async () => {
    let overrides = 0;
    vi.mocked(invoke).mockImplementation(async () => status({ overrideModels: overrides }));
    const { rerender } = render(<PriceTableStatusRow refreshKey="a" />);
    expect(await screen.findByText(/内置价格表（第 2 版）/)).toBeInTheDocument();
    overrides = 1;
    rerender(<PriceTableStatusRow refreshKey="b" />);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'get_price_table_status')).toHaveLength(2));
  });

  it('读不到状态时整块不显示', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('no backend'));
    const { container } = render(<PriceTableStatusRow />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
