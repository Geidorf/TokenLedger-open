import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardTab } from './DashboardTab';
import type { ModelStat, QuotaProviderEnvelope, StatsData } from '../types';

vi.mock('./MetricsGrid', () => ({ MetricsGrid: () => <div data-testid="metrics-grid" /> }));
vi.mock('./TrendPanel', () => ({ TrendPanel: () => <div data-testid="trend-panel" /> }));
vi.mock('./EChart', () => ({ EChart: () => <div data-testid="echart" /> }));

const EMPTY_STATS: StatsData = {
  summary: {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: 0,
    totalRequests: 0,
    avgTokensPerReq: 0,
  },
  tools: {},
  models: {},
  trends: [],
  heatmap: {},
  history: [],
};

// Eleven models; `opus-rare` is 11th by effective tokens and 3rd by cost.
const MODEL_FIXTURE: ModelStat[] = [
  ['codex-main', 380_000, 96], ['sonnet-main', 284_000, 64], ['gemini-pro', 194_000, 36],
  ['minimax', 164_000, 31], ['deepseek', 120_000, 2.8], ['kimi', 96_000, 5.4], ['qwen', 72_000, 3.7],
  ['flash', 60_000, 1.2], ['grok', 40_000, 1.7], ['haiku', 30_000, 1.5], ['opus-rare', 12_000, 39],
].map(([name, tokens, cost]) => ({
  name: name as string,
  tool: 'codex',
  input: tokens as number,
  output: 0,
  cached: 0,
  total: tokens as number,
  cost: cost as number,
  requests: 5,
  displayTotal: tokens as number,
}));

const POPULATED_STATS: StatsData = {
  ...EMPTY_STATS,
  summary: {
    ...EMPTY_STATS.summary,
    totalTokens: MODEL_FIXTURE.reduce((sum, item) => sum + (item.input ?? 0), 0),
    inputTokens: MODEL_FIXTURE.reduce((sum, item) => sum + (item.input ?? 0), 0),
    totalCost: MODEL_FIXTURE.reduce((sum, item) => sum + (item.cost ?? 0), 0),
    totalRequests: 55,
  },
  tools: {
    codex: { name: 'codex', input: 1_452_000, output: 0, cached: 0, total: 1_452_000, cost: 282.3, requests: 55 },
  },
  models: Object.fromEntries(MODEL_FIXTURE.map((item) => [item.name, item])),
};

function renderPopulated(overrides: Partial<ComponentProps<typeof DashboardTab>> = {}) {
  return render(
    <DashboardTab
      stats={POPULATED_STATS}
      statsLoading={false}
      statsError=""
      statsErrorAction={null}
      scanBusy={false}
      syncBusy={false}
      activeTools={Object.values(POPULATED_STATS.tools)}
      topModels={MODEL_FIXTURE.slice(0, 8)}
      allModels={MODEL_FIXTURE}
      showTotalTokens={false}
      scope="local"
      range="month"
      cloudAuthenticated
      cloudCapabilityVerified
      quotaProviders={[]}
      quotaLoading={false}
      quotaError=""
      quotaSyncStatus={{ enabled: false, state: 'disabled' }}
      onQuotaSyncNow={vi.fn()}
      unsyncedRecords={0}
      onScan={vi.fn()}
      onSync={vi.fn()}
      onOpenCloudSettings={vi.fn()}
      onRetryStats={vi.fn()}
      onRelogin={vi.fn()}
      onViewLocal={vi.fn()}
      onRefreshQuotas={vi.fn()}
      onOpenQuotaSettings={vi.fn()}
      onQuotaNotify={vi.fn()}
      refreshCompletedAt=""
      {...overrides}
    />,
  );
}

describe('DashboardTab model cost reports (audit P0-2)', () => {
  it('shows the average Context composition only when the stats carry it', () => {
    const { unmount } = renderPopulated({ stats: POPULATED_STATS });
    expect(screen.queryByRole('region', { name: '平均 Context 构成' })).not.toBeInTheDocument();
    unmount();
    renderPopulated({
      stats: {
        ...POPULATED_STATS,
        contextComposition: {
          requests: 2, promptTokens: 2_000, systemBytes: 100, toolsBytes: 300, historyBytes: 600,
          toolResultsBytes: 0, attachmentsBytes: 0, messages: 4, toolResults: 0, attachments: 0,
        },
      },
    });
    expect(screen.getByRole('region', { name: '平均 Context 构成' })).toHaveTextContent('基于 2 次经网关的请求');
  });

  it('在看板顶部展示与当前 stats 同一份的来源、范围、时区与快照状态', () => {
    const stats: StatsData = {
      ...POPULATED_STATS,
      meta: {
        stale: true,
        generatedAt: '2026-09-30T09:00:00Z',
        query: {
          range: 'month',
          timezone: 'Asia/Shanghai',
          machines: [],
          tools: [],
          models: [],
          search: null,
          tokenMode: 'effective',
        },
      },
    };
    renderPopulated({ stats, scope: 'cloud', range: 'month' });
    const context = screen.getByRole('region', { name: '当前看板上下文' });
    expect(context).toHaveTextContent('云端 · 全部设备');
    expect(context).toHaveTextContent('本月');
    expect(context).toHaveTextContent('Asia/Shanghai');
    expect(context).toHaveTextContent('旧快照');
    expect(context).toHaveTextContent('快照生成于');
  });

  it('feeds the cost distribution every model, so one ranked 9th or lower by tokens still appears', () => {
    renderPopulated();
    const costPanel = screen.getByRole('region', { name: '模型费用分布' });
    const names = [...costPanel.querySelectorAll('.model-cost-row-btn .model-cost-name')].map((node) => node.textContent);
    expect(names.slice(0, 3)).toEqual(['codex-main', 'sonnet-main', 'opus-rare']);
    expect(within(costPanel).queryByText(/无法归属|缺少可归属/)).not.toBeInTheDocument();
    expect(within(costPanel).getByRole('button', { name: '展开全部（11）' })).toBeInTheDocument();
  });

  it('falls back to stats.models when no full list is passed, never to the token top 8', () => {
    renderPopulated({ allModels: undefined });
    const costPanel = screen.getByRole('region', { name: '模型费用分布' });
    expect(within(costPanel).getByText('opus-rare')).toBeInTheDocument();
  });

  it('gives the usage/cost quadrant the full list as well', () => {
    renderPopulated();
    const quadrant = screen.getByRole('region', { name: '模型用量与费用分布' });
    fireEvent.click(within(quadrant).getByRole('button', { name: /模型用量与费用分布/ }));
    expect(within(quadrant).getByText('本期 11 个模型全部进图。')).toBeInTheDocument();
  });
});

describe('DashboardTab day drill-down (audit P0-1)', () => {
  // Month range in Asia/Shanghai, cut off at 2026-06-06 12:00: 06-05 is a
  // completed day bucket far above the median, so it is a drillable spike.
  const SPIKE_STATS: StatsData = {
    ...POPULATED_STATS,
    trends: [
      { date: '2026-06-01', codex: 100_000 },
      { date: '2026-06-02', codex: 110_000 },
      { date: '2026-06-03', codex: 90_000 },
      { date: '2026-06-04', codex: 105_000 },
      { date: '2026-06-05', codex: 1_000_000 },
    ],
    meta: { timezone: 'Asia/Shanghai', generatedAt: '2026-06-06T04:00:00.000Z', range: 'month' },
  };
  // T10.185 review P3-4: this prop shape is no longer produced by any real
  // scope (`useDayDrill`'s `dayDrillUnavailable` always returns null since
  // T10.113/T10.185 — no desktop scope refuses a single day any more). Kept
  // as a synthetic fixture purely to exercise the component's own rendering
  // of a non-null `dateDrillUnavailable` (still part of its prop contract,
  // reserved for a hypothetical future scope that cannot express a day) —
  // the copy is generic on purpose, not a claim about any real scope today.
  const cloudUnavailable = { label: '当日明细暂不可用', description: '当前范围或来源暂不支持单日下钻。' };
  // T10.180：日历用例没有 timeContext（POPULATED_STATS 无 meta），YearHeatmap 退回真实时钟判断
  // “今天”；固定日期为 01-15 时，每年 1 月 1–14 日这一天还是未来日期，按钮不存在会导致测试失败
  // （T10.161 复核「对其他分支的顺带发现」）。固定时钟为下方 HEATMAP_NOW，不再依赖真实时钟。
  const HEATMAP_NOW = new Date('2026-07-15T12:00:00Z');
  const heatmapDay = `${HEATMAP_NOW.getFullYear()}-01-15`;

  it('hands the spike day to the drill handler in local scope', () => {
    const onSelectDate = vi.fn();
    renderPopulated({ stats: SPIKE_STATS, onSelectDate });
    fireEvent.click(screen.getByRole('button', { name: /2026-06-05 消耗 .*点击查看当日明细/ }));
    expect(onSelectDate).toHaveBeenCalledWith('2026-06-05');
  });

  it('shows the spike drill as unavailable with its reason when the prop is set', () => {
    const onSelectDate = vi.fn();
    renderPopulated({ stats: SPIKE_STATS, scope: 'cloud', onSelectDate, dateDrillUnavailable: cloudUnavailable });
    expect(screen.queryByRole('button', { name: /点击查看当日明细/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('当日明细暂不可用'));
    expect(onSelectDate).not.toHaveBeenCalled();
  });

  it('keeps calendar days clickable locally and static under cloud scope', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(HEATMAP_NOW);
    try {
      const stats = { ...POPULATED_STATS, heatmap: { [heatmapDay]: 5_000 } };
      const onSelectDate = vi.fn();
      const { unmount } = renderPopulated({ stats, range: 'year', onSelectDate });
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`${heatmapDay}.*点击查看当日明细`) }));
      expect(onSelectDate).toHaveBeenCalledWith(heatmapDay);
      unmount();

      renderPopulated({ stats, range: 'year', scope: 'cloud', onSelectDate: vi.fn(), dateDrillUnavailable: cloudUnavailable });
      expect(screen.queryByRole('button', { name: new RegExp(heatmapDay) })).not.toBeInTheDocument();
      expect(screen.getByLabelText(`${heatmapDay}: 5.0K Tokens`)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the focused Agent into the day drill when the calendar shows only that Agent', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(HEATMAP_NOW);
    try {
      const stats = {
        ...POPULATED_STATS,
        heatmap: { [heatmapDay]: 5_000 },
        tools: { codex: { ...POPULATED_STATS.tools.codex, heatmap: { [heatmapDay]: 5_000 } } },
      };
      const onSelectDate = vi.fn();
      renderPopulated({ stats, range: 'year', onSelectDate });
      const split = document.querySelector('section.usage-split') as HTMLElement;
      fireEvent.click(within(split).getAllByRole('button', { pressed: false }).find((button) => button.classList.contains('usage-split-pick'))!);
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`${heatmapDay}.*点击查看当日明细`) }));
      expect(onSelectDate).toHaveBeenCalledWith(heatmapDay, { tools: ['codex'], models: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the focused account into the day drill when the calendar shows only that account', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(HEATMAP_NOW);
    try {
      const stats = {
        ...POPULATED_STATS,
        heatmap: { [heatmapDay]: 5_000 },
        providers: { relay: { ...POPULATED_STATS.tools.codex, name: 'relay', heatmap: { [heatmapDay]: 3_000 } } },
      };
      const onSelectDate = vi.fn();
      renderPopulated({ stats, range: 'year', onSelectDate });
      const split = document.querySelector('section.usage-split') as HTMLElement;
      fireEvent.click(within(within(split).getByRole('group', { name: '拆分维度' })).getByRole('button', { name: '账号' }));
      fireEvent.click(within(split).getAllByRole('button', { pressed: false }).find((button) => button.classList.contains('usage-split-pick'))!);
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`${heatmapDay}.*点击查看当日明细`) }));
      expect(onSelectDate).toHaveBeenCalledWith(heatmapDay, { tools: [], models: [], providers: ['relay'] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DashboardTab', () => {
  it('renders zero-log scan diagnostics in local scope when no token records exist', () => {
    const onScan = vi.fn();
    const onOpenQuotaSettings = vi.fn();
    const onOpenCloudSettings = vi.fn();

    render(
      <DashboardTab
        stats={EMPTY_STATS}
        statsLoading={false}
        statsError=""
        statsErrorAction={null}
        scanBusy={false}
        syncBusy={false}
        activeTools={[]}
        topModels={[]}
        showTotalTokens={false}
        scope="local"
        range="today"
        cloudAuthenticated={true}
        cloudCapabilityVerified={true}
        quotaProviders={[]}
        quotaLoading={false}
        quotaError=""
        quotaSyncStatus={{ enabled: true, state: 'active' }}
        onQuotaSyncNow={vi.fn()}
        unsyncedRecords={0}
        onScan={onScan}
        onSync={vi.fn()}
        onOpenCloudSettings={onOpenCloudSettings}
        onRetryStats={vi.fn()}
        onRelogin={vi.fn()}
        onViewLocal={vi.fn()}
        onRefreshQuotas={vi.fn()}
        onOpenQuotaSettings={onOpenQuotaSettings}
        onQuotaNotify={vi.fn()}
        refreshCompletedAt="2026-08-20T14:30:00+08:00"
      />,
    );

    expect(screen.getByText('暂无 Token 记录')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '本地日志扫描诊断与支持目录' })).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('~/.claude')).toBeInTheDocument();
    expect(screen.getByText('Codex CLI')).toBeInTheDocument();
    expect(screen.getByText('~/.codex')).toBeInTheDocument();
    expect(screen.getByText('Antigravity')).toBeInTheDocument();
    expect(screen.getByText('~/.antigravity')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '调整显示' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '配置额度与来源' }));
    expect(onOpenQuotaSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '云端与常规设置' }));
    expect(onOpenCloudSettings).toHaveBeenCalledTimes(1);
  });

  it('renders cloud empty state without local scan directory diagnostics in cloud scope', () => {
    render(
      <DashboardTab
        stats={EMPTY_STATS}
        statsLoading={false}
        statsError=""
        statsErrorAction={null}
        scanBusy={false}
        syncBusy={false}
        activeTools={[]}
        topModels={[]}
        showTotalTokens={false}
        scope="cloud"
        range="today"
        cloudAuthenticated={true}
        cloudCapabilityVerified={true}
        quotaProviders={[]}
        quotaLoading={false}
        quotaError=""
        quotaSyncStatus={{ enabled: true, state: 'active' }}
        onQuotaSyncNow={vi.fn()}
        unsyncedRecords={0}
        onScan={vi.fn()}
        onSync={vi.fn()}
        onOpenCloudSettings={vi.fn()}
        onRetryStats={vi.fn()}
        onRelogin={vi.fn()}
        onViewLocal={vi.fn()}
        onRefreshQuotas={vi.fn()}
        onOpenQuotaSettings={vi.fn()}
        onQuotaNotify={vi.fn()}
        refreshCompletedAt="2026-08-20T14:30:00+08:00"
      />,
    );

    expect(screen.getByText('云端暂无 Token 记录')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '本地日志扫描诊断与支持目录' })).not.toBeInTheDocument();
  });

  it('opens display controls in an empty dashboard and restores focus on Escape', () => {
    render(<DashboardTab stats={EMPTY_STATS} statsLoading={false} statsError="" statsErrorAction={null}
      scanBusy={false} syncBusy={false} activeTools={[]} topModels={[]} showTotalTokens={false} scope="local" range="today"
      cloudAuthenticated cloudCapabilityVerified quotaProviders={[]} quotaLoading={false} quotaError=""
      quotaSyncStatus={{ enabled: false, state: 'disabled' }} onQuotaSyncNow={vi.fn()} unsyncedRecords={0}
      onScan={vi.fn()} onSync={vi.fn()} onOpenCloudSettings={vi.fn()} onRetryStats={vi.fn()} onRelogin={vi.fn()}
      onViewLocal={vi.fn()} onRefreshQuotas={vi.fn()} onOpenQuotaSettings={vi.fn()} onQuotaNotify={vi.fn()} refreshCompletedAt="" />);
    const launcher = screen.getByRole('button', { name: '调整显示' });
    launcher.focus();
    fireEvent.click(launcher);
    expect(screen.getByRole('dialog', { name: '调整显示' })).toBeInTheDocument();
    const moveTrendUp = screen.getByRole('button', { name: '上移卡片：趋势' });
    moveTrendUp.focus();
    fireEvent.click(moveTrendUp);
    expect(moveTrendUp).toHaveFocus();
    fireEvent.click(screen.getByRole('switch', { name: '隐藏卡片：额度详情' }));
    expect(screen.getByRole('switch', { name: '显示卡片：额度详情' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '卡片宽度：趋势' }), { target: { value: 'half' } });
    expect(screen.getByRole('combobox', { name: '卡片宽度：趋势' })).toHaveValue('half');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(screen.getByRole('switch', { name: '隐藏卡片：额度详情' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '卡片宽度：趋势' })).toHaveValue('full');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '调整显示' })).not.toBeInTheDocument();
    expect(launcher).toHaveFocus();
  });
});


describe('首屏额度与显示偏好', () => {
  const quota: QuotaProviderEnvelope = {
    schemaVersion: 1, providerId: 'openai-codex-local', displayName: 'Codex', scope: 'consumer-subscription',
    mode: 'automatic', capability: 'stable', status: 'ok', windows: [{
      providerId: 'openai-codex-local', windowId: 'primary', windowLabel: '5 小时额度', scope: 'consumer-subscription',
      source: 'local-authorized', status: 'ok', unit: 'percent', used: 25, limit: 100, remaining: 75,
      observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), staleAfterSeconds: 900,
    }],
  };
  function preferences(hiddenCardIds: string[], hiddenQuotaSourceIds: string[] = []) {
    act(() => {
      localStorage.setItem('tokenledger:dashboard-display-preferences:v1', JSON.stringify({version:1, hiddenQuotaSourceIds}));
      localStorage.setItem('tokenledger:dashboard-layouts:v2', JSON.stringify({version:2, activeId:'daily', layouts:[{id:'daily', name:'日常', preset:'daily',
        cards: ['metrics', 'quotaHighlights', 'trend', 'quota'].map(id => ({id, visible: !hiddenCardIds.includes(id), width:'full'}))}]}));
      window.dispatchEvent(new StorageEvent('storage', {key:'tokenledger:dashboard-display-preferences:v1'}));
      window.dispatchEvent(new StorageEvent('storage', {key:'tokenledger:dashboard-layouts:v2'}));
    });
  }
  it('摘要位于趋势之前，详情按钮移交焦点；额度要点是独立卡片，可单独隐藏', () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable:true, value:scroll});
    renderPopulated({quotaProviders:[quota]});
    preferences([]);
    const summary = screen.getByRole('region', {name:'首屏额度摘要'});
    expect(summary.compareDocumentPosition(screen.getByTestId('trend-panel')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(summary).getByRole('button'));
    expect(screen.getByLabelText('订阅额度详情')).toHaveFocus();
    expect(scroll).toHaveBeenCalledOnce();
    preferences(['quotaHighlights']);
    expect(screen.queryByRole('region', {name:'首屏额度摘要'})).not.toBeInTheDocument();
    preferences(['metrics']);
    expect(screen.getByRole('region', {name:'首屏额度摘要'})).toBeInTheDocument();
    expect(screen.queryByTestId('metrics-grid')).not.toBeInTheDocument();
    preferences([]);
  });

  it('额度详情在额度子页时，概览只留摘要，点开切到额度子页', () => {
    const onOpenAllowances = vi.fn();
    renderPopulated({quotaProviders:[quota], quotaError:'读取失败', onOpenAllowances});
    preferences([]);
    expect(screen.queryByLabelText('订阅额度详情')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', {name:'额度失败恢复入口'})).not.toBeInTheDocument();
    const summary = screen.getByRole('region', {name:'首屏额度摘要'});
    fireEvent.click(within(summary).getByRole('button'));
    expect(onOpenAllowances).toHaveBeenCalledOnce();
  });
  it('来源隐藏也对摘要生效', () => {
    const other = {...quota, providerId:'anthropic-claude-consumer', windows:quota.windows.map(w=>({...w,providerId:'anthropic-claude-consumer'}))};
    renderPopulated({quotaProviders:[quota, other]});
    preferences([], ['openai-codex-local:consumer-subscription']);
    const summary = screen.getByRole('region', {name:'首屏额度摘要'});
    expect(within(summary).queryByText('Codex')).not.toBeInTheDocument();
    expect(within(summary).getByText('Claude')).toBeInTheDocument();
    preferences([]);
  });
});
