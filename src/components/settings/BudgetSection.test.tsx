import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { BudgetSection, budgetReading, budgetRuleTitle, phoneSyncHint } from './BudgetSection';
import { parseBudgetSettings, parseBudgetStatusReport, type BudgetRule } from '../../hooks/useBudget';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const statsListeners: Array<() => void> = [];
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    if (event === 'stats-updated') statsListeners.push(handler);
    return () => {};
  }),
}));

const RULE: BudgetRule = {
  id: 'm1',
  enabled: true,
  period: 'month',
  metric: 'cost',
  scopeKind: 'tool',
  scopeId: 'codex',
  limit: 50,
  warnPercent: 80,
};

let stored: { notify: boolean; syncToPhone: boolean; rules: BudgetRule[] };
let phoneSync: unknown;
let statuses: unknown[];

beforeEach(() => {
  stored = { notify: false, syncToPhone: false, rules: [RULE] };
  phoneSync = { state: 'off', lastPublishedAt: null, error: null };
  statuses = [{ ruleId: 'm1', periodStart: '2026-10-01', used: 42.5, limit: 50, percent: 85, level: 'warn' }];
  statsListeners.length = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    switch (command) {
      case 'get_budget_settings':
        return stored;
      case 'set_budget_settings':
        stored = (args as { settings: typeof stored }).settings;
        return stored;
      case 'get_budget_status':
        return {
          generatedAt: '2026-10-24T00:00:00Z',
          statuses,
          choices: { tools: ['claude', 'codex'], models: ['gpt-5'], providers: [], providersAvailable: false },
          phoneSync,
        };
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe('budget parsing', () => {
  it('drops malformed rules and keeps defaults', () => {
    const parsed = parseBudgetSettings({
      notify: true,
      rules: [
        { id: 'a', period: 'day', metric: 'tokens', scopeKind: 'all', limit: 1000 },
        { id: 'b', period: 'year', metric: 'cost', scopeKind: 'all', limit: 1 },
        { id: '', period: 'day', metric: 'cost', scopeKind: 'all', limit: 1 },
        { id: 'c', period: 'day', metric: 'cost', scopeKind: 'all', limit: -1 },
      ],
    });
    expect(parsed.notify).toBe(true);
    expect(parsed.rules).toEqual([
      { id: 'a', enabled: true, period: 'day', metric: 'tokens', scopeKind: 'all', scopeId: '', limit: 1000, warnPercent: 80 },
    ]);
    expect(parseBudgetSettings(null)).toEqual({ notify: false, syncToPhone: false, rules: [] });
    expect(parseBudgetSettings({ syncToPhone: true }).syncToPhone).toBe(true);
  });

  it('keeps an unavailable reading as null instead of zero', () => {
    const report = parseBudgetStatusReport({
      statuses: [{ ruleId: 'a', used: null, limit: 5, percent: null, level: 'unavailable' }, { ruleId: 'x', level: 'bogus', limit: 1 }],
      choices: { tools: ['codex', 3] },
    });
    expect(report?.statuses).toEqual([{ ruleId: 'a', periodStart: '', used: null, limit: 5, percent: null, level: 'unavailable' }]);
    expect(report?.choices).toEqual({ tools: ['codex'], models: [], providers: [], providersAvailable: false });
    expect(report?.phoneSync).toEqual({ state: 'off', lastPublishedAt: null, error: null });
    expect(parseBudgetStatusReport({ statuses: [], phoneSync: { state: 'not-deployed', error: 3 } })?.phoneSync)
      .toEqual({ state: 'not-deployed', lastPublishedAt: null, error: null });
    expect(parseBudgetStatusReport({})).toBeNull();
  });

  it('titles and readings name the period, scope and metric', () => {
    expect(budgetRuleTitle(RULE)).toBe('本月 · Agent · Codex · 预估费用');
    expect(budgetReading(RULE, { ruleId: 'm1', periodStart: '', used: 42.5, limit: 50, percent: 85.4, level: 'warn' }))
      .toMatch(/^已用 .*42\.50.* \/ .*50\.00.* · 85%$/);
    expect(budgetReading({ ...RULE, scopeKind: 'provider', scopeId: 'relay' }, { ruleId: 'm1', periodStart: '', used: null, limit: 50, percent: null, level: 'unavailable' }))
      .toContain('账号维度需要网关记录');
    expect(budgetReading({ ...RULE, enabled: false }, undefined)).toMatch(/^已停用/);
  });

  it('phone sync hint says what is uploaded and why it is not syncing', () => {
    const off = { state: 'off', lastPublishedAt: null, error: null } as const;
    expect(phoneSyncHint(false, off)).toContain('不上传金额与上限');
    expect(phoneSyncHint(true, { ...off, state: 'signed-out' })).toContain('云同步');
    expect(phoneSyncHint(true, { ...off, state: 'not-deployed' })).toContain('尚未部署');
    expect(phoneSyncHint(true, { ...off, state: 'error', error: 'HTTP 500' })).toContain('HTTP 500');
    expect(phoneSyncHint(true, { ...off, state: 'ok', lastPublishedAt: '2026-10-24T07:00:00Z' })).toMatch(/^已同步，最近一次 /);
  });
});

describe('BudgetSection', () => {
  it('shows each budget with its usage meter and level', async () => {
    render(<BudgetSection />);
    const meter = await screen.findByRole('meter', { name: '本月 · Agent · Codex · 预估费用已用比例' });
    expect(meter).toHaveAttribute('aria-valuenow', '85');
    const row = meter.closest('.budget-rule') as HTMLElement;
    expect(row).toHaveAttribute('data-level', 'warn');
    expect(within(row).getByText('接近上限')).toBeInTheDocument();
  });

  it('adds a budget with the chosen period, scope and limit', async () => {
    render(<BudgetSection />);
    await screen.findByRole('meter');
    fireEvent.change(screen.getByLabelText('预算周期'), { target: { value: 'day' } });
    fireEvent.change(screen.getByLabelText('预算范围'), { target: { value: 'model' } });
    fireEvent.change(screen.getByLabelText('预算模型'), { target: { value: ' gpt-5 ' } });
    fireEvent.change(screen.getByLabelText('预算口径'), { target: { value: 'tokens' } });
    fireEvent.change(screen.getByLabelText('预算上限'), { target: { value: '2000000.4' } });
    fireEvent.change(screen.getByLabelText('接近提醒比例'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: '添加预算' }));
    await waitFor(() => expect(stored.rules).toHaveLength(2));
    expect(stored.rules[1]).toMatchObject({
      enabled: true, period: 'day', metric: 'tokens', scopeKind: 'model', scopeId: 'gpt-5', limit: 2000000, warnPercent: 90,
    });
    expect(stored.rules[1].id).toMatch(/^[a-z0-9]+$/);
  });

  it('rejects an empty limit or scope without saving', async () => {
    render(<BudgetSection />);
    await screen.findByRole('meter');
    fireEvent.click(screen.getByRole('button', { name: '添加预算' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('上限要大于 0');
    fireEvent.change(screen.getByLabelText('预算范围'), { target: { value: 'tool' } });
    fireEvent.change(screen.getByLabelText('预算上限'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: '添加预算' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写Agent');
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === 'set_budget_settings')).toBe(false);
  });

  it('edits, disables and deletes a budget', async () => {
    render(<BudgetSection />);
    await screen.findByRole('meter');
    fireEvent.click(screen.getByRole('button', { name: '编辑 本月 · Agent · Codex · 预估费用' }));
    expect(screen.getByLabelText('预算上限')).toHaveValue('50');
    fireEvent.change(screen.getByLabelText('预算上限'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: '保存预算' }));
    await waitFor(() => expect(stored.rules[0].limit).toBe(80));
    expect(stored.rules).toHaveLength(1);

    fireEvent.click(await screen.findByRole('button', { name: '停用' }));
    await waitFor(() => expect(stored.rules[0].enabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: '删除 本月 · Agent · Codex · 预估费用' }));
    await waitFor(() => expect(stored.rules).toHaveLength(0));
    expect(await screen.findByText('还没有预算')).toBeInTheDocument();
  });

  it('turns notifications on and reloads usage when stats update', async () => {
    render(<BudgetSection />);
    await screen.findByRole('meter');
    fireEvent.click(screen.getByRole('switch', { name: '接近或超出预算时提醒' }));
    await waitFor(() => expect(stored.notify).toBe(true));

    statuses = [{ ruleId: 'm1', periodStart: '2026-10-01', used: 55, limit: 50, percent: 110, level: 'over' }];
    await act(async () => {
      statsListeners.forEach((handler) => handler());
    });
    await waitFor(() => expect(screen.getByText('已超出')).toBeInTheDocument());
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
  });

  it('turns phone sync on and shows the sync state', async () => {
    render(<BudgetSection />);
    await screen.findByRole('meter');
    phoneSync = { state: 'ok', lastPublishedAt: '2026-10-24T07:00:00Z', error: null };
    fireEvent.click(screen.getByRole('switch', { name: '同步到手机' }));
    await waitFor(() => expect(stored.syncToPhone).toBe(true));
    expect(await screen.findByText(/^已同步，最近一次/)).toBeInTheDocument();
  });

  it('rereads usage when the window becomes visible again or the day changes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
    try {
      render(<BudgetSection />);
      await screen.findByRole('meter');
      const statusCalls = () => vi.mocked(invoke).mock.calls.filter(([name]) => name === 'get_budget_status').length;
      // 首次挂载读一次，设置读回后 revision 变了再读一次；meter 可能在第二次读之前就出现，
      // 先等这两次初始读取落定，避免慢 runner 上把第二次初始读取误算成可见性触发的重读。
      await waitFor(() => expect(statusCalls()).toBe(2));
      const before = statusCalls();
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await waitFor(() => expect(statusCalls()).toBe(before + 1));

      vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(statusCalls()).toBe(before + 2));
    } finally {
      vi.useRealTimers();
    }
  });
});
