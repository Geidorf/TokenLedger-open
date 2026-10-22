import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import balanceFixture from '../../../fixtures/quota-provider-v1/balance-v1.json';
import type { QuotaBalanceSourceView, QuotaProviderEnvelope } from '../../types';
import { quotaReasonLabel } from '../QuotaPanel';
import { balanceAmounts, balanceCardView, formatBalanceAmount, QuotaBalanceCard } from './QuotaSection';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const fixtureProviders = balanceFixture.providers as Array<{ envelope: QuotaProviderEnvelope; display: string[] }>;
const NOW = Date.parse('2026-10-04T12:05:00+08:00');

function source(overrides: Partial<QuotaBalanceSourceView> = {}): QuotaBalanceSourceView {
  return {
    gatewayProviderId: 'deepseek',
    gatewayProviderName: 'DeepSeek',
    host: 'api.deepseek.com',
    vendor: 'deepseek',
    providerId: 'balance-deepseek',
    enabled: true,
    relay: null,
    ...overrides,
  };
}

describe('供应商余额展示（REQ-QUOTA-10）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('按共享 fixture 显示余额数值与币种，不换汇', () => {
    expect(formatBalanceAmount(12.34, 'CNY')).toBe('¥12.34');
    expect(formatBalanceAmount(5, 'USD')).toBe('$5.00');
    expect(formatBalanceAmount(7, 'EUR')).toBe('€7.00');
    expect(formatBalanceAmount(3, 'GBP')).toBe('£3.00');
    expect(formatBalanceAmount(100, 'JPY')).toBe('JP¥100');
    expect(formatBalanceAmount(8, 'HKD')).toBe('8.00 HKD');
    for (const { envelope, display } of fixtureProviders) {
      expect(balanceAmounts(envelope).map((amount) => amount.text), envelope.providerId).toEqual(display);
    }
  });

  it('失败与旧值保留：balance_unavailable 有本地化，旧值标「截至」', () => {
    expect(quotaReasonLabel('balance_unavailable', '')).toContain('余额');
    const stale = fixtureProviders.find(({ envelope }) => envelope.status === 'stale')!.envelope;
    const staleView = balanceCardView({ enabled: true, provider: stale, now: NOW });
    expect(staleView.state).toBe('read-failed');
    expect(staleView.label).toBe('读取失败（保留旧值）');
    expect(staleView.asOf).toBeTruthy();
    expect(staleView.detail).toContain('balance_unavailable');

    const failed = fixtureProviders.find(({ envelope }) => envelope.status === 'error')!.envelope;
    expect(balanceCardView({ enabled: true, provider: failed, now: NOW })).toMatchObject({ state: 'read-failed', label: '读取失败', amounts: [] });
    const auth = fixtureProviders.find(({ envelope }) => envelope.status === 'auth-required')!.envelope;
    expect(balanceCardView({ enabled: true, provider: auth, now: NOW }).state).toBe('key-required');
    expect(balanceCardView({ enabled: false, provider: undefined, now: NOW }).state).toBe('off');
    expect(balanceCardView({ enabled: true, provider: undefined, now: NOW }).state).toBe('waiting');
  });

  it('卡片列出供应商余额，只显示余额文本，没有进度条', async () => {
    invokeMock.mockResolvedValueOnce([source()]);
    render(<QuotaBalanceCard quotaProviders={[fixtureProviders[1].envelope]} now={NOW} disabled={false} onChanged={vi.fn()} />);
    const list = await screen.findByRole('list', { name: 'DeepSeek 余额' });
    expect(within(list).getByText('¥1,234.50')).toBeInTheDocument();
    expect(within(list).getByText('$5.00')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('list_quota_balance_sources');
  });

  it('切换开关调用 set_quota_balance_source 并刷新额度', async () => {
    const onChanged = vi.fn();
    invokeMock.mockResolvedValueOnce([source({ enabled: false })]);
    invokeMock.mockResolvedValueOnce([source({ enabled: true })]);
    render(<QuotaBalanceCard quotaProviders={[]} now={NOW} disabled={false} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('switch', { name: /DeepSeek 余额/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenLastCalledWith('set_quota_balance_source', {
      input: { gatewayProviderId: 'deepseek', enabled: true },
    });
  });

  it('中转余额必须先配置；保存时提交地址、取值路径与币种', async () => {
    const relaySource = source({
      gatewayProviderId: 'team-relay',
      gatewayProviderName: '团队中转',
      host: 'relay.example.com',
      vendor: 'relay',
      providerId: 'balance-relay-team-relay',
      enabled: false,
    });
    const configured = { balanceUrl: 'https://relay.example.com/api/balance', valuePath: 'data.balance', currency: 'EUR' };
    invokeMock.mockResolvedValueOnce([relaySource]);
    invokeMock.mockResolvedValueOnce([{ ...relaySource, enabled: true, relay: configured }]);
    render(<QuotaBalanceCard quotaProviders={[]} now={NOW} disabled={false} onChanged={vi.fn()} />);
    expect(await screen.findByRole('switch', { name: /团队中转 余额/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '配置 团队中转 的中转余额地址' }));
    fireEvent.change(screen.getByLabelText('团队中转 余额地址'), { target: { value: configured.balanceUrl } });
    fireEvent.change(screen.getByLabelText('团队中转 币种'), { target: { value: 'eur' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并开启' }));
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith('set_quota_balance_source', {
      input: { gatewayProviderId: 'team-relay', enabled: true, relay: configured },
    }));
  });
});
