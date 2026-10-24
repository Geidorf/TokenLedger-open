import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AlertWebhookCard, endpointSummary, silentSources } from './AlertWebhookCard';
import { parseWebhookView, type WebhookEndpoint } from '../../hooks/useAlertWebhooks';
import { t } from '../../i18n';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const ENDPOINT = {
  id: 'wh-1',
  platform: 'dingtalk',
  name: '值班群',
  enabled: true,
  kinds: ['budget', 'anomaly'],
  includeCost: false,
  urlHint: 'oapi.dingtalk.com',
  hasSecret: true,
  lastResult: null,
};

let view: Record<string, unknown>;
let testResult: unknown;

beforeEach(() => {
  view = {
    enabled: false,
    endpoints: [],
    sources: { budget: true, quota: false, anomaly: false, periodReport: true },
    maxEndpoints: 8,
  };
  testResult = { ok: true, error: null };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case 'get_alert_webhooks':
        return view;
      case 'set_alert_webhooks_enabled':
        view = { ...view, enabled: payload.enabled };
        return view;
      case 'save_alert_webhook': {
        const input = payload.input as Record<string, unknown>;
        if (!input.url && !input.id) throw '请填写 Webhook 地址。';
        const saved = { ...ENDPOINT, ...input, id: input.id ?? 'wh-new', urlHint: 'open.feishu.cn', hasSecret: Boolean(input.secret) };
        delete (saved as Record<string, unknown>).url;
        delete (saved as Record<string, unknown>).secret;
        view = { ...view, endpoints: [saved] };
        return view;
      }
      case 'delete_alert_webhook':
        view = { ...view, endpoints: [] };
        return view;
      case 'test_alert_webhook':
        return testResult;
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe('parseWebhookView', () => {
  it('drops unknown platforms and kinds and keeps defaults off', () => {
    const parsed = parseWebhookView({
      enabled: true,
      endpoints: [ENDPOINT, { ...ENDPOINT, id: 'x', platform: 'teams' }, { ...ENDPOINT, id: 'y', kinds: ['quota', 'later'] }],
      sources: { budget: true },
    });
    expect(parsed.endpoints.map((endpoint) => endpoint.id)).toEqual(['wh-1', 'y']);
    expect(parsed.endpoints[1].kinds).toEqual(['quota']);
    expect(parsed.sources).toEqual({ budget: true, quota: false, anomaly: false, periodReport: null });
    expect(parseWebhookView(null).enabled).toBe(false);
  });
});

describe('endpointSummary', () => {
  it('shows platform, host, signing, kinds and the last failure without any address', () => {
    const endpoint = parseWebhookView({ endpoints: [{ ...ENDPOINT, includeCost: true, lastResult: { at: '2026-10-24T08:00:00Z', ok: false, error: 'HTTP 404', test: true } }] }).endpoints[0] as WebhookEndpoint;
    const text = endpointSummary(endpoint, (key, vars) => t(key, vars, 'zh'), 'zh');
    expect(text).toContain('钉钉 · oapi.dingtalk.com · 已签名 · 推送：预算、用量异常 · 带费用');
    expect(text).toContain('失败：HTTP 404');
  });
});

describe('silentSources', () => {
  it('lists wanted kinds whose own notification switch is off', () => {
    const parsed = parseWebhookView({ ...view, enabled: true, endpoints: [{ ...ENDPOINT, kinds: ['budget', 'anomaly', 'periodReport'] }] });
    expect(silentSources(parsed)).toEqual(['anomaly']);
  });
});

describe('AlertWebhookCard', () => {
  it('starts off, adds a signed Feishu webhook and never echoes the address', async () => {
    render(<AlertWebhookCard />);
    expect(await screen.findByText('还没有 Webhook')).toBeTruthy();
    expect(screen.getByRole('switch', { name: '推送提醒到 Webhook' }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: '添加 Webhook' }));
    expect((await screen.findByRole('alert')).textContent).toBe('请填写 Webhook 地址');

    fireEvent.change(screen.getByLabelText('Webhook 名称'), { target: { value: '值班群' } });
    fireEvent.change(screen.getByLabelText('Webhook 地址'), { target: { value: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret-token' } });
    fireEvent.change(screen.getByLabelText('签名密钥（可选）'), { target: { value: 'SEC123' } });
    fireEvent.click(screen.getByLabelText('周报月报'));
    fireEvent.click(screen.getByRole('button', { name: '添加 Webhook' }));

    await screen.findByText('值班群');
    const save = vi.mocked(invoke).mock.calls.find(([command]) => command === 'save_alert_webhook');
    expect(save?.[1]).toEqual({
      input: expect.objectContaining({
        platform: 'feishu',
        name: '值班群',
        url: 'https://open.feishu.cn/open-apis/bot/v2/hook/secret-token',
        secret: 'SEC123',
        includeCost: false,
        kinds: ['budget', 'quota', 'anomaly'],
      }),
    });
    expect(document.body.textContent).not.toContain('secret-token');
    expect(document.body.textContent).toContain('open.feishu.cn');
  });

  it('disables a reminder kind this build does not have', async () => {
    view = { ...view, sources: { budget: true, quota: true, anomaly: true, periodReport: null } };
    render(<AlertWebhookCard />);
    await screen.findByText('还没有 Webhook');
    expect((screen.getByLabelText('周报月报') as HTMLInputElement).disabled).toBe(true);
  });

  it('hides the secret field for unsigned platforms', async () => {
    render(<AlertWebhookCard />);
    await screen.findByText('还没有 Webhook');
    fireEvent.change(screen.getByLabelText('Webhook 平台'), { target: { value: 'wecom' } });
    expect(screen.queryByLabelText('签名密钥（可选）')).toBeNull();
  });

  it('sends a test message and shows the failure reason', async () => {
    view = { ...view, endpoints: [ENDPOINT] };
    testResult = { ok: false, error: 'HTTP 404，机器人可能已被删除' };
    render(<AlertWebhookCard />);
    fireEvent.click(await screen.findByRole('button', { name: '测试发送到 值班群' }));
    expect((await screen.findByRole('status')).textContent).toBe('测试失败：HTTP 404，机器人可能已被删除');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('test_alert_webhook', { id: 'wh-1' });
  });

  it('editing keeps the stored address unless a new one is typed', async () => {
    view = { ...view, enabled: true, endpoints: [ENDPOINT] };
    render(<AlertWebhookCard />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑 值班群' }));
    expect(screen.getByText('已保存（oapi.dingtalk.com）。留空保持不变，填写则替换。')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('消息里带上预估费用'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const saves = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_alert_webhook');
      expect(saves[saves.length - 1]?.[1]).toEqual({
        input: expect.objectContaining({ id: 'wh-1', platform: 'dingtalk', includeCost: true, url: undefined, secret: undefined, clearSecret: false }),
      });
    });
    expect(screen.getByRole('note').textContent).toContain('用量异常');
  });
});
