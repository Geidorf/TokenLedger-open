import { fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseHealthCard, type DatabaseHealthReport } from './DatabaseHealthCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const healthy = { exists: true, ok: true, problems: [], bytes: 2_097_152, walBytes: 0 };
const damaged: DatabaseHealthReport = {
  checkedAt: '2026-10-24T01:00:00Z',
  ok: false,
  ledger: { exists: true, ok: false, problems: ['database disk image is malformed'], bytes: 4_194_304, walBytes: 0 },
  ledgerRows: null,
  gateway: healthy,
  repairPending: false,
  lastRepair: null,
};

describe('DatabaseHealthCard', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('完好时只报告行数与大小，不显示修复按钮', async () => {
    vi.mocked(invoke).mockResolvedValue({ ...damaged, ok: true, ledger: healthy, ledgerRows: 1234 });
    render(<DatabaseHealthCard />);
    fireEvent.click(screen.getByRole('button', { name: '检查数据库' }));
    expect(await screen.findByText('数据库完好：账本 1,234 行，占用 2.0 MB。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '修复' })).not.toBeInTheDocument();
  });

  it('损坏且重建索引不够时，提示退出重开完成修复', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'local_backup_db_repair') return { fixed: false, restartRequired: true, report: { ...damaged, repairPending: true } };
      return damaged;
    });
    render(<DatabaseHealthCard />);
    fireEvent.click(screen.getByRole('button', { name: '检查数据库' }));
    expect(await screen.findByText(/发现损坏：用量账本/)).toBeInTheDocument();
    expect(screen.getByText('database disk image is malformed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '修复' }));
    expect(await screen.findByText(/需要重建数据库/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '退出 TokenLedger' }));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('local_backup_quit');
  });
});
