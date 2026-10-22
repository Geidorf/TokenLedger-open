import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../types';
import { ModelAccessCard } from './ModelAccessCard';
import type { AgentAdapter } from './agents';
import * as api from './api';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, setModelAccess: vi.fn() };
});

function adapter(id: string, name: string, pointsToGateway: boolean, restoreError?: string): AgentAdapter {
  const result: AgentAdapter = {
    id,
    name,
    icon: null,
    monogram: id.slice(0, 2).toUpperCase(),
    inspect: vi.fn().mockResolvedValue({ configPath: `/tmp/${id}`, exists: true, version: 'v1', pointsToGateway, warnings: [] }),
    preview: vi.fn(),
    apply: vi.fn(),
    restore: restoreError
      ? vi.fn().mockRejectedValue(restoreError)
      : vi.fn().mockImplementation(async () => { vi.mocked(result.inspect).mockResolvedValue({ configPath: `/tmp/${id}`, exists: true, version: 'v2', pointsToGateway: false, warnings: [] }); return { configPath: `/tmp/${id}`, removed: false, version: 'v2' }; }),
  };
  return result;
}

function renderCard(agents: AgentAdapter[]) {
  const onChanged = vi.fn();
  const onNotify = vi.fn();
  render(<ModelAccessCard enabled onChanged={onChanged} onNotify={onNotify} agents={agents} />);
  fireEvent.click(screen.getByRole('switch', { name: '模型接入' }));
  return { onChanged, onNotify };
}

describe('ModelAccessCard（U-112）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.setModelAccess).mockImplementation(async (enabled) => ({ ...DEFAULT_SETTINGS, model_access_enabled: enabled }));
  });

  it('没有 Agent 指向网关时直接关闭，不弹确认', async () => {
    const { onChanged } = renderCard([adapter('codex', 'Codex', false)]);
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith(false));
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ model_access_enabled: false }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('列出仍指向网关的 Agent；「恢复原配置并关闭」先恢复再关闭', async () => {
    const codex = adapter('codex', 'Codex', true);
    const pi = adapter('pi', 'Pi', false);
    const opencode = adapter('opencode', 'OpenCode', true);
    const { onChanged } = renderCard([codex, pi, opencode]);
    const dialog = await screen.findByRole('alertdialog', { name: '关闭模型接入' });
    expect(dialog).toHaveTextContent('Codex、OpenCode');
    expect(dialog).not.toHaveTextContent('Pi');
    fireEvent.click(within(dialog).getByRole('button', { name: '恢复原配置并关闭' }));
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith(false));
    expect(codex.restore).toHaveBeenCalledWith(false);
    expect(opencode.restore).toHaveBeenCalledWith(false);
    expect(pi.restore).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('恢复失败时不关闭并说明原因', async () => {
    const { onNotify } = renderCard([adapter('codex', 'Codex', true, '配置已被外部修改')]);
    fireEvent.click(await screen.findByRole('button', { name: '恢复原配置并关闭' }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith(expect.stringContaining('Codex：配置已被外部修改')));
    expect(api.setModelAccess).not.toHaveBeenCalled();
  });

  it('「仅关闭」不动 Agent 配置', async () => {
    const codex = adapter('codex', 'Codex', true);
    renderCard([codex]);
    fireEvent.click(await screen.findByRole('button', { name: '仅关闭' }));
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith(false));
    expect(codex.restore).not.toHaveBeenCalled();
  });

  it('「取消」什么都不改', async () => {
    const codex = adapter('codex', 'Codex', true);
    renderCard([codex]);
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.setModelAccess).not.toHaveBeenCalled();
    expect(codex.restore).not.toHaveBeenCalled();
  });

  it('打开时只切开关，不检查也不改 Agent', async () => {
    const codex = adapter('codex', 'Codex', true);
    const onChanged = vi.fn();
    render(<ModelAccessCard enabled={false} onChanged={onChanged} onNotify={vi.fn()} agents={[codex]} />);
    fireEvent.click(screen.getByRole('switch', { name: '模型接入' }));
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith(true));
    expect(codex.inspect).not.toHaveBeenCalled();
    expect(codex.apply).not.toHaveBeenCalled();
  });

  it('设置未读到时开关不可用', () => {
    render(<ModelAccessCard enabled={undefined} onChanged={vi.fn()} onNotify={vi.fn()} agents={[]} />);
    expect(screen.getByRole('switch', { name: '模型接入' })).toBeDisabled();
  });
});

describe('关闭预检与部分恢复', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.setModelAccess).mockImplementation(async (enabled) => ({ ...DEFAULT_SETTINGS, model_access_enabled: enabled })); });
  it.each(['权限拒绝', '坏 JSONC', '配置过大', '符号链接拒绝'])('检查失败 %s 不自动关闭，可逐项重试', async (reason) => {
    const agent = adapter('bad', 'Bad', false);
    vi.mocked(agent.inspect).mockRejectedValueOnce(reason);
    renderCard([agent]);
    expect(await screen.findByRole('alert')).toHaveTextContent(reason);
    expect(api.setModelAccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '恢复原配置并关闭' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试检查 Bad' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.setModelAccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '仅关闭' }));
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith(false));
  });

  it('三项恢复中间失败：成功明细保留，重试只处理失败项并刷新磁盘', async () => {
    const a = adapter('a', 'First', true);
    const b = adapter('b', 'Second', true, '冲突');
    const c = adapter('c', 'Third', true);
    renderCard([a, b, c]);
    fireEvent.click(await screen.findByRole('button', { name: '恢复原配置并关闭' }));
    await waitFor(() => expect(screen.getByText(/Second · 恢复失败/)).toBeInTheDocument());
    expect(screen.getByText(/First · 已恢复 · 已离开网关/)).toBeInTheDocument();
    expect(screen.getByText(/Third · 已恢复 · 已离开网关/)).toBeInTheDocument();
    expect(api.setModelAccess).not.toHaveBeenCalled();
    vi.mocked(b.restore).mockImplementation(async () => { vi.mocked(b.inspect).mockResolvedValue({ configPath: '/tmp/b', exists: true, version: 'v3', pointsToGateway: false, warnings: [] }); return { configPath: '/tmp/b', removed: false, version: 'v3' }; });
    fireEvent.click(screen.getByRole('button', { name: '重试失败项并关闭' }));
    await waitFor(() => expect(api.setModelAccess).toHaveBeenCalledWith(false));
    expect(a.restore).toHaveBeenCalledTimes(1);
    expect(c.restore).toHaveBeenCalledTimes(1);
    expect(b.restore).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Second · 已恢复 · 已离开网关/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveFocus();
  });
});
