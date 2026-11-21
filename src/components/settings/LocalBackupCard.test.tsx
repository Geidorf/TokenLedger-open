import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBackupCard, defaultSections, type LocalBackupPreview, type LocalBackupStatus } from './LocalBackupCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const status: LocalBackupStatus = {
  defaultDir: '/backups',
  auto: { enabled: false, dir: '/backups', intervalHours: 24, keep: 7, lastRunAt: null, lastFile: null, lastError: null, hasPassphrase: false, nextDue: null },
};

const preview: LocalBackupPreview = {
  digest: 'cd'.repeat(32),
  created: '2026-10-23T01:00:00Z',
  appVersion: '2.0.0',
  machine: 'old-pc',
  sameMachine: false,
  gatewayRequestsRestorable: false,
  ledger: { total: 3, new: 2, known: 1, otherComputerPending: 0, first: null, last: null },
  gatewayRequests: { total: 0, new: 0, known: 0, otherComputerPending: 0, first: null, last: null },
  providers: [{ id: 'p1', name: 'P1', status: 'new' }],
  providersWithoutKey: ['p1'],
  routingGroups: [],
  budgets: [{ id: 'daily', name: 'daily', status: 'same' }],
  settings: 'differs',
  prices: 'same',
  quotaAlerts: null,
};

describe('LocalBackupCard', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('两次密码一致且够长才能导出', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'local_backup_export') return { path: '/backups/TokenLedger-1.tlbackup', bytes: 4096, ledgerRows: 3, gatewayRequests: 0, providers: 1, routingGroups: 0 };
      return status;
    });
    render(<LocalBackupCard />);
    const exportButton = await screen.findByRole('button', { name: '导出加密备份' });
    await waitFor(() => expect(screen.getAllByLabelText('备份文件夹')[0]).toHaveValue('/backups'));
    const [pass] = screen.getAllByLabelText('备份密码');
    fireEvent.change(pass, { target: { value: 'long enough' } });
    fireEvent.change(screen.getByLabelText('再输一次密码'), { target: { value: 'long enougX' } });
    expect(exportButton).toBeDisabled();
    expect(screen.getByText('两次输入的密码不一致。')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('再输一次密码'), { target: { value: 'long enough' } });
    fireEvent.click(exportButton);
    expect(await screen.findByText(/已导出到 \/backups\/TokenLedger-1.tlbackup/)).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('local_backup_export', { input: { dir: '/backups', passphrase: 'long enough' } });
    expect(pass).toHaveValue('');
  });

  it('预览后默认只勾有变化的部分，恢复时交回预览摘要', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'local_backup_preview') return preview;
      if (cmd === 'local_backup_apply') {
        return {
          snapshot: '/app/backups/pre-restore-1', ledgerAdded: 2, gatewayAdded: 0, providersAdded: 1, providersReplaced: 0,
          providersNeedKey: ['p1'], groupsAdded: 0, groupsReplaced: 0, groupsSkipped: [], budgetsAdded: 0, budgetsReplaced: 0,
          settingsRestored: true, pricesRestored: false, quotaAlertsRestored: false, restartSuggested: true,
        };
      }
      return status;
    });
    render(<LocalBackupCard />);
    fireEvent.change(await screen.findByLabelText('备份文件'), { target: { value: '/backups/TokenLedger-1.tlbackup' } });
    fireEvent.change(screen.getAllByLabelText('备份密码')[1], { target: { value: 'long enough' } });
    fireEvent.click(screen.getByRole('button', { name: '预览备份' }));
    expect(await screen.findByText('共 3 行，新增 2 行，本机已有 1 行（跳过）')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /用量账本/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /网关请求记账/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /预算/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^设置/ })).toBeChecked();
    expect(screen.getByText(/本机还没有 API key.*p1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复选中的部分' }));
    expect(await screen.findByText(/已恢复：账本 2 行/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出 TokenLedger' })).toBeInTheDocument();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('local_backup_apply', {
      input: {
        path: '/backups/TokenLedger-1.tlbackup',
        passphrase: 'long enough',
        digest: 'cd'.repeat(32),
        sections: defaultSections(preview),
        conflict: 'keepLocal',
      },
    });
  });

  it.each([
    ['导出加密备份', ['备份密码', '再输一次密码']],
    ['预览备份', ['恢复密码']],
    ['保存自动备份设置', ['自动备份密码']],
    [null, ['备份密码', '再输一次密码', '恢复密码', '自动备份密码']],
  ] as const)('清理备份口令草稿（%s 失败或离开）', async (action, labels) => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'local_backup_status') return status;
      throw new Error('模拟备份操作失败');
    });
    const { rerender } = render(<LocalBackupCard />);
    const [dir] = screen.getAllByLabelText('备份文件夹');
    await waitFor(() => expect(dir).toHaveValue('/backups'));
    const path = screen.getByLabelText('备份文件');
    fireEvent.change(dir, { target: { value: '/drafts' } });
    fireEvent.change(path, { target: { value: '/backups/test.tlbackup' } });
    const fields = labels.map((label) => label === '恢复密码'
      ? screen.getAllByLabelText('备份密码')[1]
      : screen.getAllByLabelText(label, { exact: true })[0]);
    fields.forEach((field) => fireEvent.change(field, { target: { value: 'fixture-draft' } }));
    if (action) {
      fireEvent.click(screen.getByRole('button', { name: action }));
      expect(await screen.findByRole('alert')).toHaveTextContent('模拟备份操作失败');
    } else {
      rerender(<LocalBackupCard isActive={false} />);
      rerender(<LocalBackupCard />);
    }
    fields.forEach((field) => expect(field).toHaveValue(''));
    expect(dir).toHaveValue('/drafts');
    expect(path).toHaveValue('/backups/test.tlbackup');
  });

  it('离开再返回后丢弃迟到的恢复预览，保留文件路径', async () => {
    let resolvePreview!: (value: LocalBackupPreview) => void;
    vi.mocked(invoke).mockImplementation(async (command) => command === 'local_backup_preview'
      ? new Promise((resolve) => { resolvePreview = resolve; }) : status);
    const { rerender } = render(<LocalBackupCard />);
    const path = screen.getByLabelText('备份文件');
    fireEvent.change(path, { target: { value: '/backups/test.tlbackup' } });
    const pass = screen.getAllByLabelText('备份密码')[1];
    fireEvent.change(pass, { target: { value: 'fixture-draft' } });
    fireEvent.click(screen.getByRole('button', { name: '预览备份' }));
    rerender(<LocalBackupCard isActive={false} />);
    rerender(<LocalBackupCard />);
    await act(async () => resolvePreview(preview));
    expect(screen.queryByRole('button', { name: '恢复选中的部分' })).not.toBeInTheDocument();
    expect(path).toHaveValue('/backups/test.tlbackup');
    expect(pass).toHaveValue('');
  });

  it('defaultSections 不勾与本机相同或备份里没有的部分', () => {
    expect(defaultSections(preview)).toEqual({
      ledger: true, gatewayRequests: false, providers: true, routingGroups: false,
      budgets: false, settings: true, prices: false, quotaAlerts: false,
    });
  });
});
