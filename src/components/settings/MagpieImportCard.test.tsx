import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MagpieImportCard, magpieImportSummary, type MagpieImportMeta } from './MagpieImportCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const meta: MagpieImportMeta = {
  importedAt: '2026-10-20T08:00:00Z',
  counts: { lines: 10, imported: 8, invalid: 0, zeroTokens: 2, rejected: 0, otherComputer: 0, repeated: 0 },
  earliest: '2026-10-01T00:00:00Z',
  latest: '2026-10-20T00:00:00Z',
  duplicateOfGateway: 0,
  matchedScans: 5,
  held: 1,
};

function status(patch: Record<string, unknown> = {}) {
  return {
    sourceFound: true,
    usagePath: '~/.config/gateway/usage.jsonl',
    usageFound: true,
    usageBytes: 100,
    usageModifiedAt: '2026-10-20T00:00:00Z',
    imported: false,
    lastImport: null,
    ...patch,
  };
}

describe('MagpieImportCard', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('没有找到 magpie 时禁用导入', async () => {
    vi.mocked(invoke).mockResolvedValue(status({ sourceFound: false, usageFound: false, usagePath: null }));
    render(<MagpieImportCard />);
    expect(await screen.findByText('这台电脑上没有找到 magpie。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键导入' })).toBeDisabled();
  });

  it('一键导入后显示结果，可移除导入', async () => {
    let imported = false;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'external_ledger_import_run') {
        imported = true;
        return meta;
      }
      if (cmd === 'external_ledger_import_clear') {
        imported = false;
        return null;
      }
      return status(imported ? { imported: true, lastImport: meta } : {});
    });
    render(<MagpieImportCard />);
    const button = await screen.findByRole('button', { name: '一键导入' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText(/已导入 8 次调用/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新导入' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '移除导入' }));
    fireEvent.click(await screen.findByRole('button', { name: '移除' }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith('external_ledger_import_clear'));
    expect(await screen.findByRole('button', { name: '一键导入' })).toBeInTheDocument();
  });

  it('结果文案说明重合与未合并的数量', () => {
    const text = magpieImportSummary(meta);
    expect(text).toContain('5 条与本机日志重合');
    expect(text).toContain('1 次有多条相同用量的本机日志');
  });
});
