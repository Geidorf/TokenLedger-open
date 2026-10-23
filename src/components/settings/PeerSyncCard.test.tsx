import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerSyncCard, type PeerSyncPreview } from './PeerSyncCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const preview: PeerSyncPreview = {
  created: '2026-10-20T08:00:00Z',
  app: 'the peer',
  carriesKeys: true,
  providers: [
    { peerId: 'deepseek', id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', wire: 'chat', models: 1, hasKey: true, enabled: true, exists: false, unsupported: null },
    { peerId: 'claude', id: 'claude', name: 'Claude', baseUrl: '', wire: null, models: 0, hasKey: false, enabled: true, exists: false, unsupported: '没有接口地址（多为订阅登录，不在同步范围内）。' },
  ],
};

describe('PeerSyncCard', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('没有地址和同步密码时不能读取备份；保存只发送填写了的密码', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'peer_sync_save_config') {
        const input = (args as { input: Record<string, string> }).input;
        return { url: input.url, user: input.user, hasPassword: false, hasPassphrase: Boolean(input.passphrase) };
      }
      return { url: '', user: '', hasPassword: false, hasPassphrase: false };
    });
    render(<PeerSyncCard />);
    const read = await screen.findByRole('button', { name: '读取外部网关备份' });
    expect(read).toBeDisabled();
    fireEvent.change(screen.getByLabelText('WebDAV 地址'), { target: { value: 'https://dav.example/dav' } });
    fireEvent.change(screen.getByLabelText('外部网关同步密码'), { target: { value: 'pass' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(read).toBeEnabled());
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('peer_sync_save_config', {
      input: { url: 'https://dav.example/dav', user: '', passphrase: 'pass' },
    });
    expect(screen.getByLabelText('外部网关同步密码')).toHaveValue('');
  });

  it('预览只勾选可导入的供应商，导入后提示结果', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'peer_sync_preview') return preview;
      if (cmd === 'peer_sync_import_providers') return { imported: ['deepseek'], keysSaved: 1, skipped: [] };
      return { url: 'https://dav.example/dav', user: 'me', hasPassword: true, hasPassphrase: true };
    });
    render(<PeerSyncCard />);
    const read = await screen.findByRole('button', { name: '读取外部网关备份' });
    await waitFor(() => expect(read).toBeEnabled());
    fireEvent.click(read);
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '导入选中的 1 个供应商' }));
    expect(await screen.findByText(/已导入 1 个供应商，1 个 API key/)).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('peer_sync_import_providers', { peerIds: ['deepseek'] });
  });

  it('写入外部网关默认不勾选，只发送选中的供应商并提示原文件已保存', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'peer_sync_export_preview') {
        return {
          providers: [
            { id: 'deepseek', name: 'DeepSeek', peerId: 'deepseek', update: true, unsupported: null },
            { id: 'local', name: 'Local', peerId: 'local', update: false, unsupported: '不用 API key 的供应商不写入外部网关。' },
          ],
        };
      }
      if (cmd === 'peer_sync_export_providers') {
        return { added: [], updated: ['deepseek'], skipped: [], savedAs: '2026-10-23-150000-server.peer-backup' };
      }
      return { url: 'https://dav.example/dav', user: 'me', hasPassword: true, hasPassphrase: true };
    });
    render(<PeerSyncCard />);
    const open = await screen.findByRole('button', { name: '写入外部网关…' });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).toBeDisabled();
    expect(screen.getByText('更新外部网关的「deepseek」')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '写入选中的 0 个供应商' })).toBeDisabled();
    fireEvent.click(boxes[0]);
    fireEvent.click(screen.getByRole('button', { name: '写入选中的 1 个供应商' }));
    expect(await screen.findByText(/更新 1 个供应商.*2026-10-23-150000-server/)).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('peer_sync_export_providers', { ids: ['deepseek'] });
  });
});
