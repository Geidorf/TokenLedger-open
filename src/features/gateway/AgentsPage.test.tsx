import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsPage } from './AgentsPage';
import { MANUAL_AGENTS, type AgentAdapter } from './agents';
import * as api from './api';
import type { AgentInspection } from './types';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, listProviders: vi.fn(), listRoutingGroups: vi.fn(), gatewayStatus: vi.fn(), revealLocalToken: vi.fn() };
});

function makeAdapter(inspection: AgentInspection): AgentAdapter {
  return {
    id: 'codex',
    name: 'Codex',
    icon: null,
    monogram: 'CX',
    inspect: vi.fn().mockResolvedValue(inspection),
    preview: vi.fn().mockResolvedValue({ configPath: '/tmp/.codex/config.toml', changed: true, beforeVersion: 'v1', diff: '-model = "a"\n+model = "group/coding"', warnings: ['示例警告'] }),
    apply: vi.fn().mockResolvedValue({ configPath: '/tmp/.codex/config.toml', changed: true, version: 'v2', backupCreated: true }),
    restore: vi.fn().mockResolvedValue({ configPath: '/tmp/.codex/config.toml', removed: false, version: 'v3' }),
  };
}

const base: AgentInspection = { configPath: '/tmp/.codex/config.toml', exists: true, version: 'v1', pointsToGateway: false, model: 'gpt-5-codex', backup: null, warnings: [] };

describe('AgentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.gatewayStatus).mockResolvedValue({ running: false, port: 3462, providerCount: 0, enabledCount: 0 });
    vi.mocked(api.listProviders).mockResolvedValue([{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wire: 'chat', models: ['deepseek-chat'], enabled: true, hasKey: true }]);
    vi.mocked(api.listRoutingGroups).mockResolvedValue([{ id: 'coding', name: '编码', strategy: 'failover', members: ['deepseek/deepseek-chat'], rules: [], sessionTtlSecs: 3600, enabled: true }]);
  });

  it('模型选择器列出 供应商/模型 与 group/<id>，预览 diff 后带版本写入', async () => {
    const adapter = makeAdapter(base);
    const notify = vi.fn();
    render(<AgentsPage onNotify={notify} onConfirm={vi.fn()} supported={[adapter]} pending={[]} />);
    expect(await screen.findByText(/未接入 · 当前 gpt-5-codex/)).toBeInTheDocument();
    await screen.findByText(/2 个可选模型/);
    fireEvent.click(screen.getByRole('button', { name: 'Codex 模型' }));
    const picker = screen.getByRole('dialog', { name: '为 Codex 选择模型' });
    expect(within(picker).getByText('deepseek/deepseek-chat')).toBeInTheDocument();
    fireEvent.click(within(picker).getByText('group/coding'));
    const sheet = await screen.findByRole('dialog', { name: 'Codex 配置改动' });
    expect(adapter.preview).toHaveBeenCalledWith('group/coding');
    expect(within(sheet).getByText('示例警告')).toBeInTheDocument();
    expect(within(sheet).getByText('+model = "group/coding"')).toHaveClass('is-add');
    fireEvent.click(within(sheet).getByRole('button', { name: '写入配置' }));
    await waitFor(() => expect(adapter.apply).toHaveBeenCalledWith('group/coding', 'v1'));
    expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('group/coding'));
    expect(adapter.inspect).toHaveBeenCalledTimes(2);
  });

  it('外部改动后恢复需确认并强制', async () => {
    const adapter = makeAdapter({ ...base, pointsToGateway: true, model: 'group/coding', backup: { createdAt: '2026-10-03T16:00:00Z', originalExisted: true, restorableWithoutForce: false } });
    const confirm = vi.fn().mockResolvedValue(true);
    render(<AgentsPage onNotify={vi.fn()} onConfirm={confirm} supported={[adapter]} pending={[]} />);
    expect(await screen.findByText('已接入网关')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /恢复/ }));
    await waitFor(() => expect(adapter.restore).toHaveBeenCalledWith(true));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }));
  });

  it('取消确认不恢复；未支持的 Agent 显示即将支持', async () => {
    const adapter = makeAdapter({ ...base, backup: { createdAt: 'x', originalExisted: true, restorableWithoutForce: true } });
    render(<AgentsPage onNotify={vi.fn()} onConfirm={vi.fn().mockResolvedValue(false)} supported={[adapter]} pending={[{ id: 'gemini-cli', name: 'Gemini CLI', icon: null, monogram: 'GM', note: '' }]} />);
    fireEvent.click(await screen.findByRole('button', { name: /恢复/ }));
    await waitFor(() => expect(adapter.restore).not.toHaveBeenCalled());
    expect(screen.getByText('即将支持')).toBeInTheDocument();
  });

  it('Cline 手动配置：列出网关地址与模型，token 只在点击时读取进剪贴板', async () => {
    const token = 'tl-secret-token-1234';
    vi.mocked(api.gatewayStatus).mockResolvedValue({ running: true, port: 3999, baseUrl: 'http://127.0.0.1:3999/v1', tokenHint: '…1234', providerCount: 1, enabledCount: 1 });
    vi.mocked(api.revealLocalToken).mockResolvedValue(token);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AgentsPage onNotify={vi.fn()} onConfirm={vi.fn()} supported={[]} manual={MANUAL_AGENTS.filter((agent) => agent.id === 'cline')} pending={[]} />);
    expect(await screen.findByText('手动配置')).toBeInTheDocument();
    await screen.findByText(/2 个可选模型/);
    fireEvent.click(screen.getByRole('button', { name: /配置步骤/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Cline 手动配置' });
    expect(within(sheet).getByText('OpenAI Compatible')).toBeInTheDocument();
    expect(await within(sheet).findByText('http://127.0.0.1:3999/v1')).toBeInTheDocument();
    expect(within(sheet).getByRole('combobox', { name: 'Cline 模型' })).toHaveValue('group/coding');
    expect(api.revealLocalToken).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: /复制 API Key/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
    expect(sheet).not.toHaveTextContent(token);
  });

  it('Claude Desktop 手动配置：列出步骤、根地址与局限，token 走命令复制且不显示', async () => {
    const token = 'tl-secret-token-5678';
    vi.mocked(api.gatewayStatus).mockResolvedValue({ running: true, port: 3999, baseUrl: 'http://127.0.0.1:3999/v1', tokenHint: '…5678', providerCount: 1, enabledCount: 1 });
    vi.mocked(api.revealLocalToken).mockResolvedValue(token);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AgentsPage onNotify={vi.fn()} onConfirm={vi.fn()} supported={[]} pending={[]} />);
    await screen.findByText(/2 个可选模型/);
    const row = screen.getByText('Claude Desktop').closest('.mw-agent') as HTMLElement;
    expect(within(row).getByText('手动配置')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /配置步骤/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Claude Desktop 手动配置' });
    const steps = within(sheet).getByRole('list', { name: 'Claude Desktop 配置步骤' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(5);
    expect(steps).toHaveTextContent('Help → Troubleshooting → Enable Developer Mode');
    expect(steps).toHaveTextContent('Developer → Configure Third-Party Inference…');
    expect(within(sheet).getByText('Gateway')).toBeInTheDocument();
    expect(within(sheet).getByText('Bearer')).toBeInTheDocument();
    expect(await within(sheet).findByText('http://127.0.0.1:3999')).toBeInTheDocument();
    expect(sheet).not.toHaveTextContent('http://127.0.0.1:3999/v1');
    expect(within(sheet).getByRole('combobox', { name: 'Claude Desktop 模型' })).toHaveValue('group/coding');
    expect(sheet).toHaveTextContent('不使用 Claude 订阅账号');
    expect(sheet).toHaveTextContent('托管配置，它会覆盖本地表单');
    fireEvent.click(within(sheet).getByRole('button', { name: /复制 Gateway base URL/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:3999'));
    expect(api.revealLocalToken).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: /复制 Gateway API key/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
    expect(api.revealLocalToken).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveTextContent(token);
  });
});
