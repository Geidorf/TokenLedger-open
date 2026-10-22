import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BusyState } from '../../types';
import { DataHelpSection, getDataSyncGuidance, reclaimableSummary } from './DataHelpSection';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'get_project_dimension_status') {
      return {
        enabled: false,
        state: 'disabled',
        consentVersion: 0,
        requiredConsentVersion: 1,
        gitProbeEnabled: false,
        backfill: { status: 'idle', done: 0, total: 0 },
        indexedSessions: 0,
        namedProjects: 0,
        unresolvedSessions: 0,
        lastFailure: null,
      };
    }
    return null;
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

function idleBusy(): BusyState {
  return {
    scan: false,
    sync: false,
    wallpaper: false,
    auth: false,
    config: false,
    settings: false,
    prices: false,
    db: false,
  };
}

function renderSection(onOpenShareCard?: () => void) {
  return render(
    <DataHelpSection
      dbInfo={null}
      dbInfoError=""
      cloudSetup={{ configured: true, authenticated: true, capabilityVerified: false, firstSyncCompleted: false }}
      cleanupDate=""
      busy={idleBusy()}
      onExport={vi.fn()}
      onOpenShareCard={onOpenShareCard}
      onRefreshDb={vi.fn()}
      onCleanupDateChange={vi.fn()}
      onCleanup={vi.fn()}
      onResetSync={vi.fn()}
      onOpenCloudSection={vi.fn()}
    />,
  );
}

describe('DataHelpSection', () => {
  it('把未同步记录和云端门槛合并为可执行的下一步', () => {
    const onOpenCloudSection = vi.fn();
    render(
      <DataHelpSection
        dbInfo={{ path: '/tmp/tokenboard.db', totalRecords: 12, unsyncedRecords: 12, sizeBytes: 1024, earliest: '2026-07-01', latest: '2026-07-15' }}
        dbInfoError=""
        cloudSetup={{ configured: true, authenticated: true, capabilityVerified: false, firstSyncCompleted: false }}
        cleanupDate=""
        busy={idleBusy()}
        onExport={vi.fn()}
        onRefreshDb={vi.fn()}
        onCleanupDateChange={vi.fn()}
        onCleanup={vi.fn()}
        onResetSync={vi.fn()}
        onOpenCloudSection={onOpenCloudSection}
      />,
    );

    expect(getDataSyncGuidance(
      { configured: true, authenticated: true, capabilityVerified: false, firstSyncCompleted: false },
      12,
    )).toEqual({
      tone: 'attention',
      title: '同步暂不可用',
      message: '先验证 Stats v2，才能同步 12 条本地记录。',
      actionLabel: '去验证 Stats v2',
    });
    expect(screen.getByRole('status')).toHaveTextContent('先验证 Stats v2，才能同步 12 条本地记录。');

    fireEvent.click(screen.getByRole('button', { name: '去验证 Stats v2' }));
    expect(onOpenCloudSection).toHaveBeenCalledTimes(1);
  });

  it('旧的“导出可视化简报”入口已移除（T10.163：已并入分享弹窗；T10.180：调用方也已删除对应入参）', () => {
    renderSection(vi.fn());

    expect(screen.queryByRole('button', { name: /导出可视化简报/ })).not.toBeInTheDocument();
    // 复核修复 P3-5：导出组内留一句指引，避免用户以为这项能力凭空消失了。
    expect(screen.getByText(/HTML 简报在“生成数据战报”弹窗内导出/)).toBeInTheDocument();
  });

  it('导出、维护与危险区分组呈现，HTML 简报指引只在有战报入口时出现（T10.281）', () => {
    const { unmount } = renderSection(vi.fn());
    const exportCard = screen.getByRole('heading', { name: '导出与分享' }).parentElement!;
    expect(within(exportCard).getByRole('button', { name: /生成数据战报/ })).toBeInTheDocument();
    expect(within(exportCard).getByRole('button', { name: '导出 CSV' })).toBeInTheDocument();
    expect(within(exportCard).queryByRole('button', { name: '重置同步' })).not.toBeInTheDocument();

    const maintenanceCard = screen.getByRole('heading', { name: '维护' }).parentElement!;
    for (const name of ['刷新信息', '重置同步']) {
      expect(within(maintenanceCard).getByRole('button', { name })).toHaveClass('secondary-inline');
    }

    const cleanupCard = screen.getByRole('heading', { name: '清理旧数据' }).parentElement!;
    expect(within(cleanupCard).getByLabelText('清理截止日期')).toBeInTheDocument();
    expect(within(cleanupCard).getByRole('button', { name: '清理旧数据' })).toBeDisabled();
    expect(within(cleanupCard).getByText(/不可撤销/)).toBeInTheDocument();
    unmount();

    renderSection();
    expect(screen.queryByText(/HTML 简报在/)).not.toBeInTheDocument();
  });

  it('点击“生成数据战报”触发 onOpenShareCard', () => {
    const onOpenShareCard = vi.fn();
    renderSection(onOpenShareCard);

    fireEvent.click(screen.getByRole('button', { name: /生成数据战报/ }));
    expect(onOpenShareCard).toHaveBeenCalledTimes(1);
  });

  it('未提供 onOpenShareCard 时不渲染生成数据战报按钮', () => {
    renderSection();

    expect(screen.queryByRole('button', { name: /导出可视化简报/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /生成数据战报/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /导出 CSV/ })).toBeInTheDocument();
  });

  it('显示可回收空间并把“回收空间”交给 onReclaimSpace', () => {
    const onReclaimSpace = vi.fn();
    render(
      <DataHelpSection
        dbInfo={{ path: '/tmp/tokenboard.db', totalRecords: 12, unsyncedRecords: 0, sizeBytes: 10_485_760, reclaimableBytes: 7_340_032, earliest: '2026-07-01', latest: '2026-07-15' }}
        dbInfoError=""
        cloudSetup={{ configured: true, authenticated: true, capabilityVerified: true, firstSyncCompleted: true }}
        cleanupDate=""
        busy={idleBusy()}
        onExport={vi.fn()}
        onRefreshDb={vi.fn()}
        onCleanupDateChange={vi.fn()}
        onCleanup={vi.fn()}
        onReclaimSpace={onReclaimSpace}
        onResetSync={vi.fn()}
        onOpenCloudSection={vi.fn()}
      />,
    );

    expect(screen.getByText('7.00 MB')).toBeInTheDocument();
    expect(screen.getByText(/占体积 70%/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '回收空间' }));
    expect(onReclaimSpace).toHaveBeenCalledTimes(1);
  });

  it('空闲页不足 1 MB 或尚未读取时不鼓励回收，也不渲染没有回调的按钮', () => {
    expect(reclaimableSummary(null)).toEqual({ value: '—', hint: '刷新信息后显示清理留下的空闲页' });
    expect(reclaimableSummary({ path: 'x', totalRecords: 1, unsyncedRecords: 0, sizeBytes: 4_194_304, reclaimableBytes: 4096, earliest: '2026-07-01', latest: '2026-07-15' })).toEqual({ value: '不足 1 MB', hint: '无需回收' });
    renderSection();
    expect(screen.queryByRole('button', { name: '回收空间' })).not.toBeInTheDocument();
  });

  it('数据库操作显示当前动作进行中反馈并阻止重复触发', async () => {
    let resolveExport!: () => void;
    const onExport = vi.fn(() => new Promise<void>((resolve) => {
      resolveExport = resolve;
    }));

    render(
      <DataHelpSection
        dbInfo={null}
        dbInfoError=""
        cloudSetup={{ configured: true, authenticated: true, capabilityVerified: false, firstSyncCompleted: false }}
        cleanupDate=""
        busy={idleBusy()}
        onExport={onExport}
        onRefreshDb={vi.fn()}
        onCleanupDateChange={vi.fn()}
        onCleanup={vi.fn()}
        onResetSync={vi.fn()}
        onOpenCloudSection={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    const activeButton = await screen.findByRole('button', { name: '正在导出 CSV' });
    expect(activeButton).toBeDisabled();
    expect(activeButton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '刷新信息' })).toBeDisabled();

    fireEvent.click(activeButton);
    expect(onExport).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveExport();
    });
    expect(screen.getByRole('button', { name: '导出 CSV' })).toBeEnabled();
  });

  it('数据库信息失败时保留可信快照并给出刷新恢复路径', () => {
    render(
      <DataHelpSection
        dbInfo={{ path: '/tmp/tokenboard.db', totalRecords: 12, unsyncedRecords: 12, sizeBytes: 1024, earliest: '2026-07-01', latest: '2026-07-15' }}
        dbInfoError="读取数据库信息失败: database is locked"
        cloudSetup={{ configured: true, authenticated: true, capabilityVerified: true, firstSyncCompleted: true }}
        cleanupDate=""
        busy={idleBusy()}
        onExport={vi.fn()}
        onRefreshDb={vi.fn()}
        onCleanupDateChange={vi.fn()}
        onCleanup={vi.fn()}
        onResetSync={vi.fn()}
        onOpenCloudSection={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('数据库信息失败');
    expect(screen.getByRole('alert')).toHaveTextContent('仍显示上次读取到的本地数据库信息');
    expect(screen.getAllByText('12')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '刷新信息' })).toBeEnabled();
  });

  it('没有数据库快照时明确区分读取失败与空值', () => {
    render(
      <DataHelpSection
        dbInfo={null}
        dbInfoError="读取数据库信息失败: database is locked"
        cloudSetup={{ configured: true, authenticated: true, capabilityVerified: true, firstSyncCompleted: true }}
        cleanupDate=""
        busy={idleBusy()}
        onExport={vi.fn()}
        onRefreshDb={vi.fn()}
        onCleanupDateChange={vi.fn()}
        onCleanup={vi.fn()}
        onResetSync={vi.fn()}
        onOpenCloudSection={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('数据库信息失败');
    expect(screen.queryByText(/仍显示上次读取到/)).not.toBeInTheDocument();
  });
});
