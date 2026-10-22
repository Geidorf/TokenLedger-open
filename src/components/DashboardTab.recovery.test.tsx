import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardTab, statsFailureKind, statsRecoveryActions } from './DashboardTab';
import { classifyCloudFailure } from '../utils/frontendContracts';
import type { StatsData, StatsErrorAction } from '../types';

// T10.200（T10.185 评审 P3-5）：错误面板与恢复横幅按失败种类给动作，而不是每种失败都给「重试加载、
// 重新登录、临时查看本机」。云端错误按 useStats 的写法生成（「标签：Rust 原文」），走的是真实的归类。
vi.mock('./MetricsGrid', () => ({ MetricsGrid: () => <div data-testid="metrics-grid" /> }));
vi.mock('./TrendPanel', () => ({ TrendPanel: () => <div data-testid="trend-panel" /> }));
vi.mock('./EChart', () => ({ EChart: () => <div data-testid="echart" /> }));

const STATS: StatsData = {
  summary: {
    totalTokens: 1_000,
    inputTokens: 1_000,
    outputTokens: 0,
    cachedTokens: 0,
    totalCost: 1,
    totalRequests: 3,
    avgTokensPerReq: 333,
  },
  tools: { codex: { name: 'codex', input: 1_000, output: 0, cached: 0, total: 1_000, cost: 1, requests: 3 } },
  models: {},
  trends: [],
  heatmap: {},
  history: [],
};

/** useStats 写进 statsError 的云端错误：「标签：原文」。 */
function cloudError(raw: string) {
  const failure = classifyCloudFailure(new Error(raw));
  return `${failure.label}：${failure.message}`;
}

type Props = ComponentProps<typeof DashboardTab>;

function renderDashboard(overrides: Partial<Props>) {
  const callbacks = {
    onScan: vi.fn(),
    onRetryStats: vi.fn(),
    onRelogin: vi.fn(),
    onViewLocal: vi.fn(),
    onOpenCloudSettings: vi.fn(),
  };
  const view = render(
    <>
      {/* 顶栏范围控件的替身：「选择预设范围」要把焦点移到这一组的第一个预设上。 */}
      <div role="group" aria-label="统计时间范围">
        <button type="button">今日</button>
        <button type="button">本周</button>
      </div>
      <DashboardTab
        stats={null}
        statsLoading={false}
        statsError=""
        statsErrorAction="load"
        scanBusy={false}
        syncBusy={false}
        activeTools={[]}
        topModels={[]}
        allModels={[]}
        showTotalTokens={false}
        scope="cloud"
        range="today"
        cloudAuthenticated
        cloudCapabilityVerified
        quotaProviders={[]}
        quotaLoading={false}
        quotaError=""
        quotaSyncStatus={{ enabled: false, state: 'disabled' }}
        onQuotaSyncNow={vi.fn()}
        unsyncedRecords={0}
        onSync={vi.fn()}
        onRefreshQuotas={vi.fn()}
        onOpenQuotaSettings={vi.fn()}
        onQuotaNotify={vi.fn()}
        refreshCompletedAt=""
        {...callbacks}
        {...overrides}
      />
    </>,
  );
  return { view, callbacks };
}

type Callback = 'onScan' | 'onRetryStats' | 'onRelogin' | 'onViewLocal' | 'onOpenCloudSettings' | 'focus-range';

interface RecoveryCase {
  type: string;
  scope: 'local' | 'cloud';
  error: string;
  action?: StatsErrorAction;
  /** 按钮文字与点击后该发生的事，第一个是主动作。 */
  actions: Array<[label: string, effect: Callback]>;
}

const CASES: RecoveryCase[] = [
  {
    type: '云端范围受限',
    scope: 'cloud',
    error: cloudError('云端汇总暂不支持自定义日期范围；请切换到“本地机器”或选择预设范围。'),
    actions: [['选择预设范围', 'focus-range'], ['临时查看本机', 'onViewLocal']],
  },
  {
    type: '未登录',
    scope: 'cloud',
    error: cloudError('Please sign in to Supabase first.'),
    actions: [['重新登录', 'onRelogin'], ['临时查看本机', 'onViewLocal']],
  },
  {
    type: '登录过期',
    scope: 'cloud',
    error: cloudError('Supabase session expired. Please sign in again.'),
    actions: [['重新登录', 'onRelogin'], ['临时查看本机', 'onViewLocal']],
  },
  {
    type: '网络中断',
    scope: 'cloud',
    error: cloudError('Cloud RPC request could not be completed.'),
    actions: [['重试加载', 'onRetryStats'], ['临时查看本机', 'onViewLocal']],
  },
  {
    type: '服务端错误',
    scope: 'cloud',
    error: cloudError('Cloud RPC request failed (HTTP 502).'),
    actions: [['重试加载', 'onRetryStats'], ['临时查看本机', 'onViewLocal']],
  },
  {
    type: '云端版本不兼容',
    scope: 'cloud',
    error: cloudError("Cloud capability 'get_dashboard_stats_v2' is unavailable."),
    actions: [['去设置', 'onOpenCloudSettings'], ['临时查看本机', 'onViewLocal']],
  },
  {
    type: '本机读取失败',
    scope: 'local',
    error: '加载本地数据失败: Error: database is locked',
    actions: [['重试加载', 'onRetryStats']],
  },
  {
    type: '本机扫描失败',
    scope: 'local',
    action: 'scan',
    error: '扫描失败: Error: permission denied',
    actions: [['重试扫描', 'onScan']],
  },
];

const EXPECTED_CLASS = (index: number, label: string, variant: 'panel' | 'banner') => {
  if (index === 0) return variant === 'panel' ? 'primary-inline' : 'secondary-inline';
  return label === '临时查看本机' ? 'ghost-inline' : 'secondary-inline';
};

function expectActions(container: HTMLElement, recoveryCase: RecoveryCase, variant: 'panel' | 'banner', callbacks: Record<string, ReturnType<typeof vi.fn>>) {
  const buttons = [...container.querySelectorAll('.cloud-recovery-actions button')] as HTMLButtonElement[];
  expect(buttons.map((button) => button.textContent)).toEqual(recoveryCase.actions.map(([label]) => label));
  recoveryCase.actions.forEach(([label, effect], index) => {
    const button = buttons[index];
    // 键盘可达：原生按钮、在 Tab 序列里、可用；44px 目标来自这三个按钮类（index.css 的触控下限）。
    expect(button.getAttribute('type')).toBe('button');
    expect(button.tabIndex).toBe(0);
    expect(button).toBeEnabled();
    expect(button.className).toBe(EXPECTED_CLASS(index, label, variant));
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    if (effect === 'focus-range') {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '今日' }));
    } else {
      expect(callbacks[effect]).toHaveBeenCalledTimes(1);
    }
  });
  // 这一类用不上的动作一个都不出现。
  const offered = new Set(recoveryCase.actions.map(([label]) => label));
  for (const label of ['重试加载', '重试扫描', '重新登录', '去设置', '临时查看本机', '选择预设范围']) {
    if (!offered.has(label)) expect(within(container).queryByRole('button', { name: label })).not.toBeInTheDocument();
  }
}

describe('看板取数失败按种类给恢复动作（T10.200，T10.185 评审 P3-5）', () => {
  it.each(CASES)('$type：没有可显示的数据时，错误面板给出对应动作', (recoveryCase) => {
    const { callbacks } = renderDashboard({
      scope: recoveryCase.scope,
      statsError: recoveryCase.error,
      statsErrorAction: recoveryCase.action ?? 'load',
    });
    const panel = screen.getByRole('alert');
    expect(panel).toHaveTextContent('看板数据暂时不可用');
    expect(panel).toHaveTextContent(recoveryCase.error);
    expectActions(panel, recoveryCase, 'panel', callbacks);
  });

  it.each(CASES)('$type：还留着最近可信数据时，恢复横幅给出同样的动作', (recoveryCase) => {
    const { callbacks } = renderDashboard({
      stats: STATS,
      activeTools: Object.values(STATS.tools),
      scope: recoveryCase.scope,
      statsError: recoveryCase.error,
      statsErrorAction: recoveryCase.action ?? 'load',
    });
    const banner = screen.getByRole('alert');
    expect(banner).toHaveClass('cloud-recovery-banner');
    expect(banner).toHaveTextContent(recoveryCase.error);
    expectActions(banner, recoveryCase, 'banner', callbacks);
  });

  it('重试进行中：重试按钮显示加载中并禁用，其余动作仍可用', () => {
    renderDashboard({
      statsError: cloudError('Cloud RPC request could not be completed.'),
      statsLoading: true,
      stats: STATS,
      activeTools: Object.values(STATS.tools),
    });
    const banner = screen.getByRole('alert');
    const retry = within(banner).getByRole('button', { name: '正在加载统计数据' });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(retry).toHaveTextContent('加载中…');
    expect(within(banner).getByRole('button', { name: '临时查看本机' })).toBeEnabled();
  });

  it('没有错误文字也没有数据时（理论上不再出现）至少留一个重试', () => {
    renderDashboard({ statsError: '' });
    const panel = screen.getByRole('alert');
    expect(panel).toHaveTextContent('统计服务没有返回数据，请重试。');
    expect([...panel.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['重试加载', '临时查看本机']);
  });

  it('种类判断只看 useStats 写下的标签与动作，本机失败不走云端归类', () => {
    expect(statsFailureKind('cloud', '', 'load')).toBeNull();
    expect(statsFailureKind('local', '加载本地数据失败: Cloud RPC request could not be completed.', 'load')).toBe('local-read');
    expect(statsFailureKind('cloud', '扫描失败: boom', 'scan')).toBe('local-scan');
    expect(statsFailureKind('cloud', cloudError('Supabase session operation was superseded.'), 'load')).toBe('service');
    expect(statsFailureKind('cloud', cloudError('Cloud session is not authorized. Please sign in again.'), 'load')).toBe('session-expired');
    expect(statsRecoveryActions('permission')).toEqual(['open-cloud-settings', 'view-local']);
    expect(statsRecoveryActions('range-unsupported')).not.toContain('retry-load');
    expect(statsRecoveryActions('session-expired')).not.toContain('retry-load');
  });
});
