import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayPage } from './GatewayPage';
import * as api from './api';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    gatewayStatus: vi.fn(),
    listProviders: vi.fn(),
    listRoutingGroups: vi.fn(),
    recentRequests: vi.fn(),
    revealLocalToken: vi.fn(),
  };
});

describe('GatewayPage', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText } });
    vi.mocked(api.gatewayStatus).mockResolvedValue({ running: true, port: 3462, baseUrl: 'http://127.0.0.1:3462/v1', tokenHint: 'tl-…9e1a', error: null, providerCount: 1, enabledCount: 1 });
    vi.mocked(api.listProviders).mockResolvedValue([{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wire: 'chat', models: ['deepseek-chat'], enabled: true, hasKey: true }]);
    vi.mocked(api.listRoutingGroups).mockResolvedValue([{ id: 'coding', name: '编码', strategy: 'failover', members: ['deepseek/deepseek-chat'], rules: [], sessionTtlSecs: 3600, enabled: true }]);
    vi.mocked(api.recentRequests).mockResolvedValue([{ ts: '2026-10-03T16:00:00Z', requestId: 'r1', agent: 'codex', session: null, endpoint: '/v1/responses', provider: 'deepseek', requestedModel: 'group/coding', upstreamModel: 'deepseek-chat', wire: 'chat', stream: true, status: 200, ok: true, input: 1000, output: 500, cacheRead: 4000, cacheWrite: 0, latencyMs: 1200, group: 'coding', member: 'deepseek/deepseek-chat' }]);
  });

  it('显示运行状态、3462 地址与 token 尾号', async () => {
    render(<GatewayPage onOpenRouting={vi.fn()} />);
    expect((await screen.findAllByText('http://127.0.0.1:3462/v1')).length).toBeGreaterThan(0);
    expect(screen.getByText('运行中')).toBeInTheDocument();
    expect(screen.getByText('tl-…9e1a')).toBeInTheDocument();
  });

  it('复制示例代码只含占位符', async () => {
    render(<GatewayPage onOpenRouting={vi.fn()} />);
    await screen.findByText('运行中');
    fireEvent.click(screen.getByRole('button', { name: '复制示例代码' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain('$TOKENLEDGER_TOKEN');
    expect(copied).toContain('http://127.0.0.1:3462/v1/responses');
    expect(copied).toContain('group/coding');
  });

  it('点击「复制 token」才读取完整 token，写入剪贴板后提示已复制且不显示在页面', async () => {
    const token = 'tl-0123456789abcdef0123456789abcdef9e1a';
    vi.mocked(api.revealLocalToken).mockResolvedValue(token);
    render(<GatewayPage onOpenRouting={vi.fn()} />);
    await screen.findByText('运行中');
    expect(api.revealLocalToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '复制本地 token' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
    expect(api.revealLocalToken).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('已复制')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(token);
  });

  it('复制带 token 的完整示例：剪贴板含 token，页面示例仍只用占位符', async () => {
    const token = 'tl-0123456789abcdef0123456789abcdef9e1a';
    vi.mocked(api.revealLocalToken).mockResolvedValue(token);
    render(<GatewayPage onOpenRouting={vi.fn()} />);
    await screen.findByText('运行中');
    fireEvent.click(screen.getByRole('button', { name: '复制带 token 的完整示例' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain(`Bearer ${token}`);
    expect(copied).not.toContain('$TOKENLEDGER_TOKEN');
    expect(document.querySelector('pre')?.textContent).toContain('$TOKENLEDGER_TOKEN');
    expect(document.body.textContent).not.toContain(token);
  });

  it('读取 token 失败时提示原因、不写剪贴板', async () => {
    vi.mocked(api.revealLocalToken).mockRejectedValue('网关设置只允许主窗口调用。');
    render(<GatewayPage onOpenRouting={vi.fn()} />);
    await screen.findByText('运行中');
    fireEvent.click(screen.getByRole('button', { name: '复制本地 token' }));
    expect(await screen.findByText('复制失败：网关设置只允许主窗口调用。')).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('模型目录含路由组，最近请求有效 Token 只算输入加输出', async () => {
    render(<GatewayPage onOpenRouting={vi.fn()} />);
    const table = await screen.findByRole('table', { name: '最近请求' });
    await waitFor(() => expect(table.querySelectorAll('tbody tr')).toHaveLength(1));
    const cells = table.querySelectorAll('tbody td');
    expect(cells[5].textContent).toBe('1.5K');
    expect(screen.getAllByText('group/coding').length).toBeGreaterThan(0);
  });

  it('网关未运行时提示自动启动条件', async () => {
    vi.mocked(api.gatewayStatus).mockResolvedValue({ running: false, port: 3462, baseUrl: null, tokenHint: null, error: null, providerCount: 0, enabledCount: 0 });
    render(<GatewayPage onOpenRouting={vi.fn()} />);
    expect(await screen.findByText(/启用至少一个供应商后自动启动/)).toBeInTheDocument();
  });
});
