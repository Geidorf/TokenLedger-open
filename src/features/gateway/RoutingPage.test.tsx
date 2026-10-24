import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutingPage } from './RoutingPage';
import * as api from './api';
import type { RoutingGroup } from './types';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    listRoutingGroups: vi.fn(),
    listProviders: vi.fn(),
    recentRouteDecisions: vi.fn(),
    upsertRoutingGroup: vi.fn(),
    deleteRoutingGroup: vi.fn(),
  };
});

const coding: RoutingGroup = {
  id: 'coding',
  name: '编码主力',
  strategy: 'failover',
  members: ['openai/gpt-5', 'deepseek/deepseek-chat'],
  rules: [{ condition: { kind: 'hasImage' }, member: 'openai/gpt-5' }],
  sessionTtlSecs: 3600,
  enabled: true,
};

describe('RoutingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listRoutingGroups).mockResolvedValue([coding]);
    vi.mocked(api.listProviders).mockResolvedValue([
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', wire: 'responses', models: ['gpt-5'], enabled: true, hasKey: true },
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wire: 'chat', models: ['deepseek-chat', 'deepseek-reasoner'], enabled: true, hasKey: true },
    ]);
    vi.mocked(api.recentRouteDecisions).mockResolvedValue([
      { ts: '2026-10-03T16:00:00Z', requestId: 'r1', group: 'coding', session: 's1', reason: 'failover', detail: '按顺序', chosen: 'deepseek/deepseek-chat', attempts: [{ member: 'openai/gpt-5', outcome: 'failed', status: 429 }, { member: 'deepseek/deepseek-chat', outcome: 'ok', status: 200 }], trace: [
        { member: 'openai/gpt-5', rank: 0, verdict: 'failed', reasons: ['strategy_first', 'rate_limited'], detail: '上游返回 429' },
        { member: 'deepseek/deepseek-chat', rank: 1, verdict: 'chosen', reasons: ['fallback', 'answered'] },
      ] },
    ]);
    vi.mocked(api.upsertRoutingGroup).mockImplementation(async (group) => [group]);
    vi.mocked(api.deleteRoutingGroup).mockResolvedValue([]);
  });

  it('展示组、规则、会话保持与最近决策', async () => {
    render(<RoutingPage onNotify={vi.fn()} onConfirm={vi.fn()} />);
    expect(await screen.findByText('编码主力')).toBeInTheDocument();
    expect(screen.getByText('请求带图片')).toBeInTheDocument();
    expect(screen.getByText('会话保持 1 小时')).toBeInTheDocument();
    const panel = screen.getByRole('complementary', { name: '最近路由决策' });
    await waitFor(() => expect(within(panel).getByText(/失败已切换 429/)).toBeInTheDocument());
  });

  it('最近决策可展开每个成员为何被选或被跳过', async () => {
    render(<RoutingPage onNotify={vi.fn()} onConfirm={vi.fn()} />);
    const panel = screen.getByRole('complementary', { name: '最近路由决策' });
    const toggle = await within(panel).findByText('为什么这样选（2 个成员）');
    fireEvent.click(toggle);
    const trace = within(panel).getByRole('list', { name: 'group/coding 成员决策' });
    expect(within(trace).getAllByRole('listitem')[0]).toHaveTextContent('策略首选 · 限流');
  });

  it('新建路由组：添加成员、规则与会话保持后提交', async () => {
    render(<RoutingPage onNotify={vi.fn()} onConfirm={vi.fn()} />);
    await screen.findByText('编码主力');
    fireEvent.click(screen.getByRole('button', { name: /新建路由组/ }));
    const dialog = screen.getByRole('dialog', { name: '新建路由组' });
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '便宜' } });
    fireEvent.change(within(dialog).getByLabelText(/^ID/), { target: { value: 'cheap' } });
    fireEvent.change(within(dialog).getByLabelText('选择成员'), { target: { value: 'deepseek/deepseek-chat' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /添加成员/ }));
    fireEvent.change(within(dialog).getByLabelText('选择成员'), { target: { value: 'deepseek/deepseek-reasoner' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /添加成员/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /添加规则/ }));
    fireEvent.change(within(dialog).getByLabelText('规则条件'), { target: { value: 'inputCharsOver' } });
    fireEvent.change(within(dialog).getByLabelText('规则成员'), { target: { value: 'deepseek/deepseek-reasoner' } });
    fireEvent.change(within(dialog).getByLabelText(/^会话保持/), { target: { value: '1800' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.upsertRoutingGroup).toHaveBeenCalledWith({
      id: 'cheap',
      name: '便宜',
      strategy: 'failover',
      members: ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'],
      manualMember: null,
      rules: [{ condition: { kind: 'inputCharsOver', chars: 60000 }, member: 'deepseek/deepseek-reasoner' }],
      sessionTtlSecs: 1800,
      enabled: true,
    }));
  });

  it('按权重：每个成员可设权重并显示占比，只提交非默认权重', async () => {
    render(<RoutingPage onNotify={vi.fn()} onConfirm={vi.fn()} />);
    await screen.findByText('编码主力');
    fireEvent.click(screen.getByRole('button', { name: /新建路由组/ }));
    const dialog = screen.getByRole('dialog', { name: '新建路由组' });
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '分流' } });
    fireEvent.change(within(dialog).getByLabelText(/^ID/), { target: { value: 'split' } });
    for (const member of ['openai/gpt-5', 'deepseek/deepseek-chat']) {
      fireEvent.change(within(dialog).getByLabelText('选择成员'), { target: { value: member } });
      fireEvent.click(within(dialog).getByRole('button', { name: /添加成员/ }));
    }
    fireEvent.change(within(dialog).getByLabelText(/^分配方式/), { target: { value: 'weighted' } });
    fireEvent.change(within(dialog).getByLabelText('openai/gpt-5 的权重'), { target: { value: '3' } });
    expect(within(dialog).getByText('75%')).toBeInTheDocument();
    expect(within(dialog).getByText('25%')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.upsertRoutingGroup).toHaveBeenCalledWith(expect.objectContaining({
      strategy: 'weighted',
      members: ['openai/gpt-5', 'deepseek/deepseek-chat'],
      weights: { 'openai/gpt-5': 3 },
    })));
  });

  it('固定一个时提交选定成员', async () => {
    render(<RoutingPage onNotify={vi.fn()} onConfirm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑 编码主力' }));
    const dialog = screen.getByRole('dialog', { name: '编码主力' });
    fireEvent.change(within(dialog).getByLabelText(/^分配方式/), { target: { value: 'manual' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: '只用 deepseek/deepseek-chat' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.upsertRoutingGroup).toHaveBeenCalledWith(expect.objectContaining({ strategy: 'manual', manualMember: 'deepseek/deepseek-chat' })));
  });

  it('移除成员时一并移除指向它的规则', async () => {
    render(<RoutingPage onNotify={vi.fn()} onConfirm={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑 编码主力' }));
    const dialog = screen.getByRole('dialog', { name: '编码主力' });
    fireEvent.click(within(dialog).getByRole('button', { name: '移除 openai/gpt-5' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.upsertRoutingGroup).toHaveBeenCalledWith(expect.objectContaining({ members: ['deepseek/deepseek-chat'], rules: [] })));
  });

  it('删除需确认', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    render(<RoutingPage onNotify={vi.fn()} onConfirm={confirm} />);
    fireEvent.click(await screen.findByRole('button', { name: '删除 编码主力' }));
    await waitFor(() => expect(api.deleteRoutingGroup).toHaveBeenCalledWith('coding'));
  });
});
