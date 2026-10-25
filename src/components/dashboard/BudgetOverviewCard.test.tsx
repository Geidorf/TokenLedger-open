import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLangPreference } from '../../i18n';
import type { BudgetRule, BudgetSettings, BudgetStatus, BudgetStatusReport } from '../../hooks/useBudget';
import { BudgetOverviewCard } from './BudgetOverviewCard';

const hookState = vi.hoisted(() => ({
  settings: null as BudgetSettings | null,
  settingsLoaded: true,
  settingsReloading: false,
  settingsError: '',
  settingsReload: vi.fn(),
  report: null as BudgetStatusReport | null,
  statusLoading: false,
  statusRefreshing: false,
  statusError: '',
  statusReload: vi.fn(),
}));

vi.mock('../../hooks/useBudget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useBudget')>()),
  useBudgetSettings: () => ({
    settings: hookState.settings,
    loaded: hookState.settingsLoaded,
    loading: hookState.settingsReloading,
    saving: false,
    error: hookState.settingsError,
    reload: hookState.settingsReload,
    save: vi.fn(),
  }),
  useBudgetStatus: () => ({
    report: hookState.report,
    loading: hookState.statusLoading,
    refreshing: hookState.statusRefreshing,
    error: hookState.statusError,
    reload: hookState.statusReload,
  }),
}));

const rule = (id: string, period: BudgetRule['period'], metric: BudgetRule['metric'] = 'cost', limit = 50): BudgetRule => ({
  id,
  enabled: true,
  period,
  metric,
  scopeKind: 'all',
  scopeId: '',
  limit,
  warnPercent: 80,
});

const status = (
  ruleId: string,
  used: number | null,
  percent: number | null,
  level: BudgetStatus['level'] = 'ok',
  limit = 50,
): BudgetStatus => ({ ruleId, periodStart: '2026-10-01', used, limit, percent, level });

const report = (statuses: BudgetStatus[]): BudgetStatusReport => ({
  generatedAt: '2026-10-24T00:00:00Z',
  statuses,
  choices: { tools: [], models: [], providers: [], providersAvailable: false },
  phoneSync: { state: 'off', lastPublishedAt: null, error: null },
});

beforeEach(() => {
  hookState.settings = {
    notify: false,
    syncToPhone: false,
    rules: [rule('day', 'day'), rule('month', 'month', 'tokens', 1000)],
  };
  hookState.settingsLoaded = true;
  hookState.settingsReloading = false;
  hookState.settingsError = '';
  hookState.settingsReload.mockReset();
  hookState.report = report([status('day', 10, 20), status('month', 0, 0, 'ok', 1000)]);
  hookState.statusLoading = false;
  hookState.statusRefreshing = false;
  hookState.statusError = '';
  hookState.statusReload.mockReset();
});

afterEach(() => {
  cleanup();
  setLangPreference('zh');
});

describe('BudgetOverviewCard', () => {
  it('renders every enabled rule with its own period and complete local-ledger source', () => {
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.getByText('按本机账本中的全部设备统计，每条预算使用自身周期；不跟随当前看板范围或筛选。')).toBeInTheDocument();
    expect(screen.getByText('今日 · 全部用量 · 预估费用')).toBeInTheDocument();
    expect(screen.getByText('本月 · 全部用量 · 有效 Token')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: '今日 · 全部用量 · 预估费用已用比例' })).toHaveAttribute('aria-valuenow', '20');
    expect(screen.getByRole('meter', { name: '本月 · 全部用量 · 有效 Token已用比例' })).toHaveAttribute('aria-valuenow', '0');
  });

  it('marks missing and invalid status as unavailable instead of drawing a false zero meter', () => {
    hookState.report = report([status('day', 10, null, 'unavailable')]);
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.queryByRole('meter', { name: /今日/ })).not.toBeInTheDocument();
    const rules = screen.getAllByRole('listitem');
    expect(rules[0]).toHaveTextContent('不可得');
    expect(rules[0]).not.toHaveTextContent('进度数据不一致');
    expect(rules[1]).toHaveTextContent('缺少有效的预算进度');
    expect(screen.queryByRole('meter', { name: /本月/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('不可得').length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a status whose limit disagrees with the current rule', () => {
    hookState.settings = { notify: false, syncToPhone: false, rules: [rule('day', 'day')] };
    hookState.report = report([status('day', 10, 20, 'ok', 60)]);
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.queryByRole('meter', { name: /今日/ })).not.toBeInTheDocument();
    expect(screen.getByText(/进度数据不一致/)).toBeInTheDocument();
  });

  it.each([
    [10, null], [null, 20], [-1, 20], [10, -1], [Number.NaN, 20], [10, Number.POSITIVE_INFINITY],
  ])('does not display invalid usage %s or percentage %s as a real reading', (used, percent) => {
    hookState.settings = { notify: false, syncToPhone: false, rules: [rule('day', 'day')] };
    hookState.report = report([status('day', used, percent)]);
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByRole('listitem')).not.toHaveTextContent(/\d+%/);
  });

  it('caps an over-budget track while preserving the true share in text and aria-valuetext', () => {
    hookState.report = report([status('day', 150, 300, 'over')]);
    render(<BudgetOverviewCard scope="local" />);
    const meter = screen.getByRole('meter', { name: /今日/ });
    expect(meter).toHaveAttribute('aria-valuenow', '100');
    expect(meter).toHaveAttribute('aria-valuetext', expect.stringContaining('已用 ≈$150.00 / ≈$50.00 · 300% · 已超出'));
  });

  it('preserves percentages above 999 in both the visible reading and accessible value', () => {
    hookState.report = report([status('day', 750, 1500, 'over')]);
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', expect.stringContaining('1500%'));
    expect(screen.getByText(/已用.*1500%/)).toBeInTheDocument();
  });

  it('shows enabled rules even when the notification switch is off', () => {
    hookState.settings = { notify: false, syncToPhone: false, rules: [rule('day', 'day')] };
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.getByText('今日 · 全部用量 · 预估费用')).toBeInTheDocument();
  });

  it('retries settings and status read failures', async () => {
    hookState.settingsLoaded = true;
    hookState.settingsError = '读取预算设置失败';
    const view = render(<BudgetOverviewCard scope="local" />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '重试读取预算设置' }));
    expect(hookState.settingsReload).toHaveBeenCalledOnce();
    view.unmount();

    hookState.settingsLoaded = true;
    hookState.settingsError = '';
    hookState.statusError = '预算用量读取失败';
    render(<BudgetOverviewCard scope="local" />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '重试读取预算用量' }));
    expect(hookState.statusReload).toHaveBeenCalledOnce();
  });

  it('keeps loading visible while settings retry even after the first read finished', async () => {
    hookState.settingsLoaded = true;
    hookState.settingsReloading = true;
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.getByRole('status')).toHaveTextContent('读取预算');
    expect(screen.queryByText(/还没有启用的预算/)).not.toBeInTheDocument();
  });

  it('shows loading for status before the first successful report, then missing for a missing row', () => {
    hookState.report = null;
    hookState.statusLoading = true;
    const view = render(<BudgetOverviewCard scope="local" />);
    expect(screen.getAllByText(/读取中/)).toHaveLength(2);
    view.unmount();

    hookState.statusLoading = false;
    hookState.report = report([]);
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.getAllByText(/缺少有效的预算进度/)).toHaveLength(2);
  });

  it('does not keep stale values on a refresh failure', () => {
    hookState.statusRefreshing = true;
    hookState.statusError = '预算用量读取失败';
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('预算用量读取失败');
  });

  it('marks statuses missing from a successful report as unavailable, not loading', () => {
    hookState.settings = { notify: false, syncToPhone: false, rules: [rule('day', 'day')] };
    hookState.report = report([]);
    render(<BudgetOverviewCard scope="local" />);
    expect(screen.getByText(/缺少有效的预算进度/)).toBeInTheDocument();
    expect(screen.queryByText(/读取中/)).not.toBeInTheDocument();
  });

  it('localizes labels and actions in English', () => {
    setLangPreference('en');
    render(<BudgetOverviewCard scope="cloud" onOpenSettings={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Budget' })).toBeInTheDocument();
    expect(screen.getByText(/complete local ledger/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Budget settings' })).toBeInTheDocument();
  });

  it('keeps the settings action and empty state when no budget is enabled', () => {
    hookState.settings = { notify: true, syncToPhone: false, rules: [] };
    render(<BudgetOverviewCard scope="local" onOpenSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: '设置预算' })).toBeInTheDocument();
    expect(screen.getByText(/还没有启用的预算/)).toBeInTheDocument();
  });
});
