import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyRestoreCard } from './LegacyRestoreCard';
import { legacyInspect, legacyRestore } from './api';
vi.mock('./api', () => ({ legacyInspect: vi.fn(), legacyRestore: vi.fn(), errorText: (e: unknown) => String(e) }));
const active = { profileCount: 1, receiptId: 'old', state: 'active' as const, configVersion: 'hash', canRestore: true, reason: null };
const onConfirm = vi.fn().mockResolvedValue(true);
const onResolved = vi.fn();
beforeEach(() => { vi.clearAllMocks(); onConfirm.mockResolvedValue(true); vi.mocked(legacyInspect).mockResolvedValue(active); });
const mount = () => render(<LegacyRestoreCard onConfirm={onConfirm} onResolved={onResolved} />);
describe('旧版恢复桥', () => {
  it('无旧数据时不增加常驻面板', async () => {
    vi.mocked(legacyInspect).mockResolvedValue({ ...active, receiptId: null, state: 'none', profileCount: 0 });
    const { container } = mount(); await waitFor(() => expect(legacyInspect).toHaveBeenCalled()); expect(container).toBeEmptyDOMElement();
  });
  it('检查失败提供重试，不能冒充没有旧数据', async () => {
    vi.mocked(legacyInspect).mockRejectedValueOnce('权限不足'); mount(); expect(await screen.findByRole('alert')).toHaveTextContent('权限不足');
    fireEvent.click(screen.getByRole('button', { name: '重新检查' })); expect(await screen.findByRole('button', { name: '恢复旧选择（推荐）' })).toBeEnabled();
  });
  it('恢复携带当前快照，并刷新Codex行', async () => {
    vi.mocked(legacyRestore).mockResolvedValue({ ...active, state: 'restored', canRestore: false }); mount();
    fireEvent.click(await screen.findByRole('button', { name: '恢复旧选择（推荐）' }));
    await waitFor(() => expect(legacyRestore).toHaveBeenCalledWith('old', 'hash', false)); expect(await screen.findByRole('status')).toHaveTextContent('已恢复'); expect(onResolved).toHaveBeenCalledWith(false);
  });
  it('用户取消不写入', async () => {
    onConfirm.mockResolvedValue(false); mount(); fireEvent.click(await screen.findByRole('button', { name: '恢复旧选择（推荐）' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled()); expect(legacyRestore).not.toHaveBeenCalled();
  });
  it('外部漂移只允许显式保留当前，保留结果不称已恢复', async () => {
    vi.mocked(legacyInspect).mockResolvedValue({ ...active, canRestore: false, reason: '选择键漂移' }); vi.mocked(legacyRestore).mockResolvedValue({ ...active, state: 'kept', canRestore: false }); mount();
    expect(await screen.findByRole('button', { name: '恢复旧选择（推荐）' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: '保留当前配置' }));
    expect(await screen.findByRole('status')).toHaveTextContent('已保留当前'); expect(legacyRestore).toHaveBeenCalledWith('old', 'hash', true);
  });
  it('迁移先恢复再让用户选择与预览，不偷偷写供应商', async () => {
    vi.mocked(legacyRestore).mockResolvedValue({ ...active, state: 'restored', canRestore: false }); mount(); fireEvent.click(await screen.findByRole('button', { name: '恢复后选择网关模型' }));
    expect(await screen.findByRole('status')).toHaveTextContent('再预览并确认'); expect(onResolved).toHaveBeenCalledWith(true);
  });
  it('恢复后封存失败保留错误与显式重试', async () => {
    vi.mocked(legacyRestore).mockRejectedValue('配置已处理，凭据未封存'); mount(); fireEvent.click(await screen.findByRole('button', { name: '恢复旧选择（推荐）' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('凭据未封存'); await waitFor(() => expect(legacyInspect).toHaveBeenCalledTimes(2)); expect(onResolved).not.toHaveBeenCalled();
  });
  it('设置里的旧版恢复不依赖开启模型接入，也不诱导直接接入', async () => {
    vi.mocked(legacyRestore).mockResolvedValue({ ...active, state: 'restored', canRestore: false });
    render(<LegacyRestoreCard onConfirm={onConfirm} onResolved={onResolved} allowGatewayChoice={false} />);
    expect(await screen.findByText(/无需开启模型接入/)).toBeVisible();
    expect(screen.queryByRole('button', { name: '恢复后选择网关模型' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复旧选择（推荐）' }));
    await waitFor(() => expect(legacyRestore).toHaveBeenCalledWith('old', 'hash', false));
    expect(onResolved).toHaveBeenCalledWith(false);
  });
});
