import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emit } from '@tauri-apps/api/event';
import { clearProviderDraft, readProviderDraft } from './providerDrafts';
import { balanceEntryHint, ProvidersPage } from './ProvidersPage';
import * as api from './api';
import type { ProviderView } from './types';

vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    listProviders: vi.fn(),
    upsertProvider: vi.fn(),
    setProviderKey: vi.fn(),
    deleteProvider: vi.fn(),
  };
});

const deepseek: ProviderView = { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wire: 'chat', models: ['deepseek-chat'], enabled: true, hasKey: true };
const relay: ProviderView = { id: 'relay', name: '公司中转', baseUrl: 'https://relay.example.com/v1', wire: 'responses', models: [], enabled: true, hasKey: false };

function renderPage(confirm = vi.fn().mockResolvedValue(true)) {
  const notify = vi.fn();
  render(<ProvidersPage onNotify={notify} onConfirm={confirm} />);
  return { notify, confirm };
}

describe('ProvidersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listProviders).mockResolvedValue([deepseek, relay]);
    vi.mocked(api.upsertProvider).mockImplementation(async (record) => [{ ...record, hasKey: false }]);
    vi.mocked(api.setProviderKey).mockResolvedValue(undefined);
    vi.mocked(api.deleteProvider).mockResolvedValue([relay]);
  });

  it('只显示 key 是否已设置，不读取 key 本身', async () => {
    renderPage();
    expect(await screen.findByText('DeepSeek', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText('已设置 key')).toBeInTheDocument();
    expect(screen.getByText('未设置 key')).toBeInTheDocument();
  });

  it('缺 key 提示依据实际认证模式，旧本地记录不会因品牌被豁免', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      { id: 'ollama', name: '旧本地', baseUrl: 'http://127.0.0.1:11434/v1', wire: 'chat', models: [], enabled: true, hasKey: false },
      { id: 'local-none', name: '明确免密', baseUrl: 'http://127.0.0.1:1234/v1', wire: 'chat', models: [], enabled: true, hasKey: true, authMode: 'none' },
    ]);
    renderPage();
    expect(await screen.findByText(/2 个启用 · 1 个未设置 key/)).toBeInTheDocument();
    expect(screen.getByText('无需 key')).toBeInTheDocument();
    expect(screen.getByText('未设置 key')).toBeInTheDocument();
    expect(screen.queryByText('已设置 key')).not.toBeInTheDocument();
  });

  it('本地预设显式保存免密模式，编辑与开关往返保留它', async () => {
    const local: ProviderView = { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', wire: 'chat', models: ['qwen'], enabled: true, hasKey: false, authMode: 'none' };
    vi.mocked(api.listProviders).mockResolvedValueOnce([]).mockResolvedValue([local]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /添加供应商/ }));
    fireEvent.click(screen.getByRole('button', { name: /Ollama/ }));
    expect(screen.getByLabelText(/上游认证/)).toHaveValue('none');
    expect(screen.queryByPlaceholderText('sk-…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.upsertProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'ollama', authMode: 'none' })));
    expect(api.setProviderKey).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /Ollama.*模型/ }));
    expect(screen.getByLabelText(/上游认证/)).toHaveValue('none');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(await screen.findByRole('switch', { name: '启用 Ollama' }));
    await waitFor(() => expect(api.upsertProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'ollama', authMode: 'none', enabled: false })));
  });

  it('从预设添加：写入接口地址与模型，key 只写入钥匙串', async () => {
    vi.mocked(api.listProviders).mockResolvedValueOnce([]).mockResolvedValue([{ ...deepseek, id: 'deepseek' }]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /添加供应商/ }));
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek/ }));
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'sk-secret-1234' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.setProviderKey).toHaveBeenCalledWith('deepseek', 'sk-secret-1234'));
    expect(api.upsertProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      wire: 'chat',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      enabled: true,
    }));
    expect(vi.mocked(api.upsertProvider).mock.calls[0][0]).not.toHaveProperty('key');
    await waitFor(() => expect(screen.queryByPlaceholderText('sk-…')).toBeNull());
  });

  it('编辑时 key 留空则不改动钥匙串', async () => {
    renderPage();
    fireEvent.click(await screen.findByText('DeepSeek', { selector: 'strong' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.upsertProvider).toHaveBeenCalled());
    expect(api.setProviderKey).not.toHaveBeenCalled();
  });

  it('启用开关提交 enabled 变化', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('switch', { name: '启用 DeepSeek' }));
    await waitFor(() => expect(api.upsertProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'deepseek', enabled: false })));
  });

  it('删除 key 需确认并以空字符串调用', async () => {
    const { confirm } = renderPage();
    fireEvent.click(await screen.findByText('DeepSeek', { selector: 'strong' }));
    fireEvent.click(screen.getByRole('button', { name: '删除 key' }));
    await waitFor(() => expect(api.setProviderKey).toHaveBeenCalledWith('deepseek', ''));
    expect(confirm).toHaveBeenCalled();
  });

  it('取消确认则不删除供应商', async () => {
    renderPage(vi.fn().mockResolvedValue(false));
    fireEvent.click(await screen.findByText('DeepSeek', { selector: 'strong' }));
    fireEvent.click(screen.getByRole('button', { name: '删除供应商' }));
    await waitFor(() => expect(api.deleteProvider).not.toHaveBeenCalled());
  });

  it('编辑页给出余额入口：官方余额与中转同源地址分开提示，并跳到额度设置', async () => {
    expect(balanceEntryHint('https://api.deepseek.com/v1')).toContain('官方余额');
    expect(balanceEntryHint('https://openrouter.ai/api/v1')).toContain('官方余额');
    expect(balanceEntryHint('https://relay.example.com/v1')).toContain('同源余额地址');
    renderPage();
    fireEvent.click(await screen.findByText('DeepSeek', { selector: 'strong' }));
    fireEvent.click(screen.getByRole('button', { name: '查看 DeepSeek 余额' }));
    await waitFor(() => expect(emit).toHaveBeenCalledWith('open-settings', { anchor: 'settings-quota' }));
  });
});

describe('供应商草稿与迟到保存', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProviderDraft('new:custom'); clearProviderDraft('edit:relay'); clearProviderDraft('edit:deepseek');
    vi.mocked(api.listProviders).mockResolvedValue([deepseek, relay]);
    vi.mocked(api.upsertProvider).mockImplementation(async (record) => [{ ...record, hasKey: false }]);
    vi.mocked(api.setProviderKey).mockResolvedValue(undefined);
  });
  async function openCustom() {
    fireEvent.click(await screen.findByRole('button', { name: /添加供应商/ }));
    fireEvent.click(screen.getByRole('button', { name: /自定义 OpenAI 兼容/ }));
  }
  it('Escape、返回预设、四页卸载往返保留非敏感草稿，key 不保留，放弃清空', async () => {
    const props = { onNotify: vi.fn(), onConfirm: vi.fn() };
    const view = render(<ProvidersPage {...props} />);
    await openCustom();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '公司草稿' } });
    fireEvent.change(screen.getByLabelText(/^接口地址/), { target: { value: 'https://draft.example/v1' } });
    fireEvent.change(screen.getByLabelText(/^模型只有/), { target: { value: 'model-a\nmodel-b' } });
    fireEvent.change(screen.getByLabelText(/^上游协议/), { target: { value: 'responses' } });
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'secret' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    await openCustom();
    expect(screen.getByLabelText('名称')).toHaveValue('公司草稿'); expect(screen.getByPlaceholderText('sk-…')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    fireEvent.click(screen.getByRole('button', { name: /自定义 OpenAI 兼容/ }));
    expect(screen.getByLabelText(/^模型只有/)).toHaveValue('model-a\nmodel-b');
    for (const page of ['网关', 'Agent', '路由', '用量']) {
      view.rerender(<div>{page}</div>);
      view.rerender(<ProvidersPage {...props} />);
      await openCustom();
      expect(screen.getByLabelText('名称')).toHaveValue('公司草稿');
      expect(screen.getByLabelText(/^接口地址/)).toHaveValue('https://draft.example/v1');
      expect(screen.getByLabelText(/^上游协议/)).toHaveValue('responses');
      expect(screen.getByPlaceholderText('sk-…')).toHaveValue('');
    }
    fireEvent.click(screen.getByRole('button', { name: '放弃草稿' }));
    expect(readProviderDraft('new:custom')).toBeUndefined(); expect(screen.getByLabelText('名称')).toHaveValue('');
  });
  it('保存失败保留名称和地址，但清除 key，重新打开可重试', async () => {
    vi.mocked(api.upsertProvider).mockRejectedValue('暂时失败');
    const { notify } = renderPage();
    await openCustom();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '失败草稿' } });
    fireEvent.change(screen.getByLabelText(/^接口地址/), { target: { value: 'https://fail.example/v1' } });
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('error', '暂时失败'));
    expect(screen.getByPlaceholderText('sk-…')).toHaveValue('');
    fireEvent.keyDown(document, { key: 'Escape' }); await openCustom();
    expect(screen.getByLabelText('名称')).toHaveValue('失败草稿');
    expect(screen.getByLabelText(/^接口地址/)).toHaveValue('https://fail.example/v1');
  });
  it('跨页在途保存锁住重开表单，迟到结果仅清对应草稿，不关闭另一对象', async () => {
    let resolve!: (providers: ProviderView[]) => void;
    vi.mocked(api.upsertProvider).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const props = { onNotify: vi.fn(), onConfirm: vi.fn() };
    const view = render(<ProvidersPage {...props} />);
    fireEvent.click(await screen.findByText('DeepSeek', { selector: 'strong' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '已保存名称' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    view.rerender(<div>Agent 页</div>); view.rerender(<ProvidersPage {...props} />);
    fireEvent.click(await screen.findByText('DeepSeek', { selector: 'strong' }));
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('名称').closest('form')!);
    expect(api.upsertProvider).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(await screen.findByText('公司中转', { selector: 'strong' }));
    await act(async () => { resolve([deepseek, relay]); });
    await waitFor(() => expect(screen.getByRole('dialog', { name: '公司中转' })).toBeInTheDocument());
    expect(screen.getByLabelText('名称')).toHaveValue('公司中转');
    expect(readProviderDraft('edit:deepseek')).toBeUndefined();
    expect(props.onNotify).toHaveBeenCalledWith('success', '已保存名称 已保存');
  });
});
