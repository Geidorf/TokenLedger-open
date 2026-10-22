import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import planFixture from '../../../fixtures/quota-provider-v1/experimental-plans-v1.json';
import type { QuotaExperimentalPlanView, QuotaProviderEnvelope } from '../../types';
import { parseQuotaProviderEnvelopes } from '../../utils/contracts/quota';
import { experimentalPlanCardView, experimentalPlanReasonSentence, QuotaExperimentalPlansCard } from './QuotaSection';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const fixtureProviders = planFixture.providers as Array<{ envelope: QuotaProviderEnvelope; display: string[] }>;
const NOW = Date.parse('2026-10-04T12:00:00Z');

function plan(overrides: Partial<QuotaExperimentalPlanView> = {}): QuotaExperimentalPlanView {
  return {
    providerId: 'zhipu-glm-plan',
    vendor: 'zhipu-glm',
    displayName: '智谱 GLM 套餐',
    enabled: false,
    consentCurrent: false,
    riskVersion: 1,
    gatewayProviderName: '智谱',
    host: 'open.bigmodel.cn',
    ...overrides,
  };
}

async function openAdvanced() {
  const trigger = await screen.findByRole('button', { name: '编码套餐：高级' });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
}

describe('实验性套餐用量（REQ-QUOTA-11）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('共享 fixture 的 envelope 通过前端契约校验，窗口按百分比显示', () => {
    for (const { envelope, display } of fixtureProviders) {
      expect(parseQuotaProviderEnvelopes([envelope]), envelope.providerId).toHaveLength(1);
      const view = experimentalPlanCardView({ plan: { enabled: true, consentCurrent: true }, provider: envelope, now: NOW });
      expect(view.windows.map((window) => `${window.label} · 剩余 ${window.remaining}%`), envelope.providerId).toEqual(display);
    }
  });

  it('experimental_consent_required 有本地化，未确认或版本提升时显示「待确认风险」', () => {
    expect(experimentalPlanReasonSentence('experimental_consent_required')).toContain('重新确认');
    const consent = fixtureProviders.find(({ envelope }) => envelope.reasonCode === 'experimental_consent_required')!.envelope;
    expect(experimentalPlanCardView({ plan: { enabled: true, consentCurrent: true }, provider: consent, now: NOW }))
      .toMatchObject({ state: 'needs-authorization', label: '待确认风险', windows: [] });
    expect(experimentalPlanCardView({ plan: { enabled: true, consentCurrent: false }, provider: undefined, now: NOW }).label).toBe('待确认风险');
    const stale = fixtureProviders.find(({ envelope }) => envelope.status === 'stale')!.envelope;
    const staleView = experimentalPlanCardView({ plan: { enabled: true, consentCurrent: true }, provider: stale, now: NOW });
    expect(staleView).toMatchObject({ state: 'read-failed', label: '读取失败（保留旧值）' });
    expect(staleView.asOf).toBeTruthy();
    const key = fixtureProviders.find(({ envelope }) => envelope.reasonCode === 'api_key_required')!.envelope;
    expect(experimentalPlanCardView({ plan: { enabled: true, consentCurrent: true }, provider: key, now: NOW }).label).toBe('需要 API key');
  });

  it('收在「高级」里并标「实验性」，开启的来源显示状态卡和进度条', async () => {
    invokeMock.mockResolvedValueOnce([
      plan(),
      plan({ providerId: 'minimax-plan', vendor: 'minimax', displayName: 'MiniMax 套餐', enabled: true, consentCurrent: true, host: 'api.minimaxi.com' }),
      plan({ providerId: 'kimi-code-plan', vendor: 'kimi-code', displayName: 'Kimi Code 套餐', gatewayProviderName: null, host: null }),
    ]);
    const minimax = { ...fixtureProviders[1].envelope, status: 'ok' as const, reasonCode: undefined, windows: fixtureProviders[1].envelope.windows.map((window) => ({ ...window, status: 'ok' as const, reasonCode: undefined, observedAt: '2026-10-04T11:58:00.000Z' })) };
    render(<QuotaExperimentalPlansCard quotaProviders={[minimax]} now={NOW} disabled={false} onChanged={vi.fn()} />);
    expect(invokeMock).toHaveBeenCalledWith('list_quota_experimental_plans');
    await waitFor(() => expect(screen.getByRole('button', { name: '编码套餐：高级' })).toHaveAttribute('aria-expanded', 'true'));
    await openAdvanced();
    expect(screen.getByText('实验性')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'MiniMax 套餐 额度窗口' });
    expect(within(list).getByRole('progressbar', { name: /MiniMax-M2 · 每周额度/ })).toHaveAttribute('aria-valuenow', '55');
    expect(screen.getByRole('switch', { name: 'Kimi Code 套餐' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: '智谱 GLM 套餐' })).toHaveAttribute('aria-checked', 'false');
  });

  it('开启前弹风险确认；取消不发请求，确认时带上当前风险版本', async () => {
    const onChanged = vi.fn();
    invokeMock.mockResolvedValueOnce([plan()]);
    invokeMock.mockResolvedValueOnce([plan({ enabled: true, consentCurrent: true })]);
    render(<QuotaExperimentalPlansCard quotaProviders={[]} now={NOW} disabled={false} onChanged={onChanged} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('switch', { name: '智谱 GLM 套餐' })).toBeNull();
    await openAdvanced();
    fireEvent.click(await screen.findByRole('switch', { name: '智谱 GLM 套餐' }));
    let dialog = screen.getByRole('dialog', { name: '开启智谱 GLM 套餐？' });
    expect(within(dialog).getByText(/接口没有公开文档/)).toBeInTheDocument();
    expect(within(dialog).getByText(/只发往 open.bigmodel.cn/)).toBeInTheDocument();
    expect(within(dialog).getByText(/不读取订阅登录、Cookie 或 OAuth/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('switch', { name: '智谱 GLM 套餐' }));
    dialog = screen.getByRole('dialog', { name: '开启智谱 GLM 套餐？' });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认风险并开启' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenLastCalledWith('set_quota_experimental_plan', {
      input: { providerId: 'zhipu-glm-plan', enabled: true, acceptRiskVersion: 1 },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('已确认当前版本时直接开关，不再弹窗', async () => {
    invokeMock.mockResolvedValueOnce([plan({ consentCurrent: true })]);
    invokeMock.mockResolvedValueOnce([plan({ enabled: true, consentCurrent: true })]);
    render(<QuotaExperimentalPlansCard quotaProviders={[]} now={NOW} disabled={false} onChanged={vi.fn()} />);
    await openAdvanced();
    fireEvent.click(await screen.findByRole('switch', { name: '智谱 GLM 套餐' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith('set_quota_experimental_plan', {
      input: { providerId: 'zhipu-glm-plan', enabled: true },
    }));
  });
});
