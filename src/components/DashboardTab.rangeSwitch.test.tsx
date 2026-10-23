import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardTab, dashboardQueryIdentity } from './DashboardTab';
import { useStats, type UseStatsProps } from '../hooks/useStats';
import { cloudStatsIdentity } from '../utils/frontendContracts';
import type { AppSettings, CustomDateRange, ModelStat, RangeKey, StatsData, ToolStat } from '../types';

// T10.181：切到未缓存的范围时 useStats 把 stats 清空、开始加载，数据回来后再给新 stats。下面按
// 「清空、加载、到数」三拍重放 DashboardTab 收到的 props：任何一拍冒出 role=alert 错误面板，或任何一个
// 图表被卸载重建，用例都会失败。T10.200 起 useStats 在清空的同一次渲染里就报加载中，这里仍保留
// 「清空但还没报加载」那一拍，守住 DashboardTab 自己也不把它画成失败。
// R-46：替身把收到的范围写进 DOM，守住“旧数字只配旧范围的标签”；页头提示行写明新旧两段；
// 最后几例接真实的 useStats 跑 A→B→C（范围、口径、设备），并按 App 的写法接 queryIdentity。
const lifecycle = vi.hoisted(() => ({ seq: 0, unmounted: [] as string[] }));
// 只给接真实 useStats 的用例用：get_cached_stats 按「口径:范围@设备」回数，ready 里有的立即回，
// 其余排队等用例放行。
const backend = vi.hoisted(() => ({
  ready: new Map<string, unknown>(),
  waiting: [] as Array<{ key: string; resolve: (value: unknown) => void }>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((command: string, args?: { scope?: unknown; range?: unknown; deviceFilter?: unknown }) => {
    if (command !== 'get_cached_stats') return Promise.reject(new Error(`未模拟的命令：${command}`));
    const key = `${String(args?.scope)}:${String(args?.range)}@${String(args?.deviceFilter ?? 'all_cloud')}`;
    if (backend.ready.has(key)) return Promise.resolve(backend.ready.get(key));
    return new Promise((resolve) => {
      backend.waiting.push({ key, resolve });
    });
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

vi.mock('./EChart', async () => {
  const { useEffect, useState } = await import('react');
  return {
    EChart: ({ ariaLabel }: { ariaLabel?: string }) => {
      const [instance] = useState(() => `chart-${(lifecycle.seq += 1)}`);
      useEffect(() => () => { lifecycle.unmounted.push(instance); }, [instance]);
      return <div data-testid="echart" data-instance={instance} aria-label={ariaLabel} />;
    },
  };
});
// 趋势面板本身很重，这里只留它里面的那张图（同样经过上面的计数替身），外加它收到的范围。
vi.mock('./TrendPanel', async () => {
  const { EChart } = await import('./EChart');
  return {
    TrendPanel: ({ range }: { range: RangeKey }) => (
      <div data-testid="trend-panel" data-range={range}>
        <EChart option={{}} ariaLabel="趋势图替身" />
      </div>
    ),
  };
});
vi.mock('./MetricsGrid', () => ({
  MetricsGrid: ({ summary, range }: { summary: StatsData['summary']; range: RangeKey }) => (
    <div data-testid="metrics-grid" data-range={range}>{summary.inputTokens}</div>
  ),
}));
vi.mock('./HeatmapSection', () => ({
  HeatmapSection: ({ range, customRange }: { range: RangeKey; customRange?: CustomDateRange | null }) => (
    <div data-testid="heatmap" data-range={range} data-bounds={customRange ? `${customRange.start}..${customRange.end}` : ''} />
  ),
}));

function statsWith(codexInput: number): StatsData {
  const claudeInput = codexInput / 2;
  const tools: Record<string, ToolStat> = {
    codex: { name: 'codex', input: codexInput, output: 0, cached: 0, total: codexInput, cost: 2, requests: 6 },
    claude: { name: 'claude', input: claudeInput, output: 0, cached: 0, total: claudeInput, cost: 1, requests: 3 },
  };
  const models: ModelStat[] = [
    { name: 'gpt-5-codex', tool: 'codex', input: codexInput, output: 0, cached: 0, total: codexInput, cost: 2, requests: 6, displayTotal: codexInput },
    { name: 'claude-sonnet', tool: 'claude', input: claudeInput, output: 0, cached: 0, total: claudeInput, cost: 1, requests: 3, displayTotal: claudeInput },
  ];
  return {
    summary: {
      totalTokens: codexInput + claudeInput,
      inputTokens: codexInput + claudeInput,
      outputTokens: 0,
      cachedTokens: 0,
      totalCost: 3,
      totalRequests: 9,
      avgTokensPerReq: Math.round((codexInput + claudeInput) / 9),
    },
    tools,
    models: Object.fromEntries(models.map((model) => [model.name, model])),
    trends: [],
    heatmap: {},
    history: [],
  };
}

const TODAY = statsWith(120_000);
const WEEK = statsWith(840_000);
const MONTH = statsWith(3_000_000);
const YEAR = statsWith(36_000_000);
const STUDIO = statsWith(64_000);
const LAPTOP = statsWith(32_000);

/** 换 Token 口径用：按有效 Token codex 在前，含缓存后 claude 反超（它的缓存读多）。 */
function statsWithCache(): StatsData {
  const tools: Record<string, ToolStat> = {
    codex: { name: 'codex', input: 100_000, output: 0, cached: 0, total: 100_000, cost: 2, requests: 6, models: { 'gpt-5-codex': 100_000 } },
    claude: { name: 'claude', input: 80_000, output: 0, cached: 200_000, total: 280_000, cost: 1, requests: 3, models: { 'claude-sonnet': 80_000 } },
  };
  const models: ModelStat[] = [
    { name: 'gpt-5-codex', tool: 'codex', input: 100_000, output: 0, cached: 0, total: 100_000, cost: 2, requests: 6, displayTotal: 100_000 },
    { name: 'claude-sonnet', tool: 'claude', input: 80_000, output: 0, cached: 200_000, total: 280_000, cost: 1, requests: 3, displayTotal: 80_000 },
  ];
  return {
    summary: {
      totalTokens: 380_000,
      inputTokens: 180_000,
      outputTokens: 0,
      cachedTokens: 200_000,
      totalCost: 3,
      totalRequests: 9,
      avgTokensPerReq: 42_222,
    },
    tools,
    models: Object.fromEntries(models.map((model) => [model.name, model])),
    trends: [],
    heatmap: {},
    history: [],
  };
}
const CACHED = statsWithCache();
/** 这一段一条记录都没有：看板走空状态分支。 */
const EMPTY: StatsData = {
  summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 },
  tools: {},
  models: {},
  trends: [],
  heatmap: {},
  history: [],
};

type Props = ComponentProps<typeof DashboardTab>;

/** useStats 在 stats 为 null 时给出的派生列表都是空数组，这里照搬。 */
function propsFor(stats: StatsData | null, overrides: Partial<Props> = {}): Props {
  const tools = stats ? Object.values(stats.tools) : [];
  const models = stats ? Object.values(stats.models) : [];
  return {
    stats,
    statsLoading: false,
    statsError: '',
    statsErrorAction: null,
    scanBusy: false,
    syncBusy: false,
    activeTools: tools,
    topModels: models,
    allModels: models,
    showTotalTokens: false,
    scope: 'local',
    range: 'today',
    cloudAuthenticated: true,
    cloudCapabilityVerified: true,
    quotaProviders: [],
    quotaLoading: false,
    quotaError: '',
    quotaSyncStatus: { enabled: false, state: 'disabled' },
    onQuotaSyncNow: vi.fn(),
    unsyncedRecords: 0,
    onScan: vi.fn(),
    onSync: vi.fn(),
    onOpenCloudSettings: vi.fn(),
    onRetryStats: vi.fn(),
    onRelogin: vi.fn(),
    onViewLocal: vi.fn(),
    onRefreshQuotas: vi.fn(),
    onOpenQuotaSettings: vi.fn(),
    onQuotaNotify: vi.fn(),
    refreshCompletedAt: '',
    ...overrides,
  };
}

/** A→B→C 用的真实 useStats。props 必须是同一个对象：回调身份一变，useStats 就会重新发起读取。 */
const HOOK_PROPS: UseStatsProps = {
  showMessage: vi.fn(),
  activeCloudConfig: { supabase_url: '', supabase_key: '' },
  cloudStatus: { configured: false, authenticated: false, email: '', userId: '' },
  cloudStatusKnown: false,
  appSettings: {} as AppSettings,
  setCloudSetup: vi.fn(),
  refreshCloudStatus: vi.fn(async () => ({ configured: false, authenticated: false, email: '', userId: '' })),
  loadDbInfo: vi.fn(async () => {}),
  loadQuotaSyncStatus: vi.fn(async () => {}),
  loadSettings: vi.fn(async () => {}),
  loadPrices: vi.fn(async () => {}),
  pricesDirty: false,
  activeTab: 'dashboard',
  loadDetails: vi.fn(async () => {}),
  setDetailFilters: vi.fn(),
  setDetails: vi.fn(),
  setEntitySelection: vi.fn(),
  showTotalTokens: false,
  changeTab: vi.fn(),
  setSettingsAnchor: vi.fn(),
  setBusy: vi.fn(),
  currentTimezone: () => 'Asia/Shanghai',
};

/** 已登录的云端账户（账户 A）；函数都沿用 HOOK_PROPS 的同一批，身份不变。 */
const CLOUD_HOOK_PROPS: UseStatsProps = {
  ...HOOK_PROPS,
  activeCloudConfig: { supabase_url: 'https://example.supabase.co', supabase_key: 'publishable-key' },
  cloudStatus: { configured: true, authenticated: true, email: 'a@example.test', userId: 'user-a' },
  cloudStatusKnown: true,
};
/** 同一项目换成账户 B（App 里 useCloud 的 cloudIdentity 随之改变）。 */
const ACCOUNT_B_HOOK_PROPS: UseStatsProps = {
  ...CLOUD_HOOK_PROPS,
  cloudStatus: { configured: true, authenticated: true, email: 'b@example.test', userId: 'user-b' },
};

/**
 * 接真实 useStats 的看板：queryIdentity 与 App 同一写法（dashboardQueryIdentity + useCloud 的 cloudIdentity），
 * Token 口径与 App 一样既给 useStats 也给 DashboardTab。
 */
function StatsBackedDashboard({ hookProps = HOOK_PROPS, showTotalTokens = false }: { hookProps?: UseStatsProps; showTotalTokens?: boolean }) {
  const hook = useStats(showTotalTokens === hookProps.showTotalTokens ? hookProps : { ...hookProps, showTotalTokens });
  const cloudIdentity = hookProps.cloudStatus.authenticated
    ? cloudStatsIdentity(hookProps.activeCloudConfig.supabase_url, hookProps.cloudStatus.userId)
    : null;
  return (
    <>
      <button type="button" onClick={() => hook.changeRange('week')}>测试：切到本周</button>
      <button type="button" onClick={() => hook.changeRange('month')}>测试：切到本月</button>
      <button type="button" onClick={() => hook.changeRange('year')}>测试：切到今年</button>
      <button type="button" onClick={hook.selectCloudScope}>测试：切到云端</button>
      <button type="button" onClick={hook.selectLocalScope}>测试：切到本机</button>
      <button type="button" onClick={() => hook.changeHeaderDevice('studio-pc')}>测试：选 studio-pc</button>
      <button type="button" onClick={() => hook.changeHeaderDevice('laptop')}>测试：选 laptop</button>
      <button type="button" onClick={() => hook.changeHeaderDevice('all_cloud')}>测试：全部设备</button>
      <DashboardTab
        {...propsFor(hook.stats, {
          statsLoading: hook.statsLoading,
          statsError: hook.statsError,
          statsErrorAction: hook.statsErrorAction,
          activeTools: hook.activeTools,
          topModels: hook.topModels,
          allModels: hook.allModels,
          showTotalTokens,
          range: hook.range,
          customRange: hook.customRange,
          scope: hook.dataScope,
          queryIdentity: dashboardQueryIdentity(hook.dataScope, hook.deviceFilter, cloudIdentity),
        })}
      />
    </>
  );
}

/**
 * 记下每一次插进页面的错误面板与骨架：点击被 act 包住，中间一次渲染即使马上被下一次盖掉，插入也留在记录里
 * （断言只看最终 DOM 会漏掉「闪一下」）。骨架按指标骨架行的插入计数：React 会沿用 .content-stack 根节点，
 * 只改它的属性，根节点本身不算插入。
 */
function watchInsertions() {
  const seen = { alerts: [] as string[], skeletons: 0 };
  const collect = (records: MutationRecord[]) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const alerts = [node, ...node.querySelectorAll('[role="alert"]')].filter((el) => el.getAttribute('role') === 'alert');
        seen.alerts.push(...alerts.map((el) => el.textContent ?? ''));
        const skeletonRow = '[aria-label="正在加载指标概览"]';
        seen.skeletons += (node.matches(skeletonRow) ? 1 : 0) + node.querySelectorAll(skeletonRow).length;
      }
    }
  };
  const observer = new MutationObserver(collect);
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    read() {
      collect(observer.takeRecords());
      const snapshot = { alerts: [...seen.alerts], skeletons: seen.skeletons };
      seen.alerts = [];
      seen.skeletons = 0;
      return snapshot;
    },
    stop: () => observer.disconnect(),
  };
}

const chartInstances = () => screen.queryAllByTestId('echart').map((node) => node.getAttribute('data-instance'));
/** 模型排行在「用量拆分」的模型维度下（对齐 magpie 的 Split by）。 */
const modelRanking = () => {
  const byModel = within(screen.getByRole('group', { name: '拆分维度' })).getByRole('button', { name: '模型' });
  if (byModel.getAttribute('aria-pressed') !== 'true') fireEvent.click(byModel);
  return [...document.querySelectorAll('.usage-split-pick')]
    .map((button) => `${button.querySelector('.usage-split-name > span:last-child')?.textContent} ${button.querySelector('.usage-split-value b')?.textContent}`);
};
const dashboardRoot = () => document.querySelector('.content-stack');
/** 页头标题下常驻的 role="status"：持有旧帧时写明新旧两段，其余时候为空。 */
const heldNotice = () => document.querySelector('.page-heading [role="status"]');

interface HeldExpectation {
  /** 提示里“正在加载”的那一段：与范围控件同一写法。 */
  loading: string;
  /** 提示里“下方暂为”的那一段，也就是旧帧自己的范围。 */
  shown: string;
  /** 各面板收到的范围：必须仍是旧帧的范围，不能换成新范围的名字。 */
  range?: RangeKey;
  stats?: StatsData;
  refreshName?: string;
}

/** 等新范围数据的那几拍：旧图和旧标签原样留着、整页标加载中、页头写明新旧两段，没有错误面板也没有骨架。 */
function expectHeldFrame(
  before: Array<string | null>,
  { loading, shown, range = 'today', stats = TODAY, refreshName = '正在加载本机看板' }: HeldExpectation,
) {
  const contextRangeLabel = ({ '今日': '今日', '本周': '本周', '本月': '本月', '今年': '本年度', '总计': '全部历史' } as Record<string, string>)[loading] ?? loading;
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('看板数据暂时不可用')).not.toBeInTheDocument();
  expect(screen.queryByRole('status', { name: '正在加载看板' })).not.toBeInTheDocument();
  expect(chartInstances()).toEqual(before);
  expect(lifecycle.unmounted).toEqual([]);
  expect(dashboardRoot()).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('button', { name: refreshName })).toHaveTextContent('加载中…');
  expect(screen.getByTestId('metrics-grid').textContent).toBe(String(stats.summary.inputTokens));
  expect(screen.getByTestId('metrics-grid')).toHaveAttribute('data-range', range);
  expect(screen.getByTestId('trend-panel')).toHaveAttribute('data-range', range);
  expect(heldNotice()?.textContent).toBe(`正在加载「${loading}」，下方暂为「${shown}」的数据`);
  expect(screen.getByRole('region', { name: '当前看板上下文' })).toHaveTextContent(`当前选择${contextRangeLabel}（数据未更新）`);
}

/** 不在持有态：页头提示为空、根节点不标忙，面板显示的是这一段自己的数据和范围。 */
function expectSettled(stats: StatsData, range: RangeKey) {
  expect(heldNotice()).toBeEmptyDOMElement();
  expect(dashboardRoot()).not.toHaveAttribute('aria-busy');
  expect(screen.getByTestId('metrics-grid').textContent).toBe(String(stats.summary.inputTokens));
  expect(screen.getByTestId('metrics-grid')).toHaveAttribute('data-range', range);
}

/** 丢掉旧帧：只剩骨架，不留旧数字，也不留“下方暂为”的提示。 */
function expectSkeleton() {
  expect(screen.getByRole('status', { name: '正在加载看板' })).toBeInTheDocument();
  expect(screen.queryByTestId('metrics-grid')).not.toBeInTheDocument();
  expect(screen.queryByText(/正在加载「/)).not.toBeInTheDocument();
}

describe('DashboardTab 切到未缓存的范围（T10.181）', () => {
  beforeEach(() => {
    lifecycle.seq = 0;
    lifecycle.unmounted = [];
    backend.ready.clear();
    backend.waiting = [];
    vi.mocked(invoke).mockClear();
  });

  it('清空、加载、到数三拍都不闪错误面板，图表实例一个都不重建', () => {
    const view = render(<DashboardTab {...propsFor(TODAY)} />);
    const before = chartInstances();
    // 分布面板改成无图表的用量拆分后，剩下的图表实例（趋势等）仍不得重建。
    expect(before.length).toBeGreaterThanOrEqual(1);
    expectSettled(TODAY, 'today');

    view.rerender(<DashboardTab {...propsFor(null, { range: 'week' })} />);
    expectHeldFrame(before, { loading: '本周', shown: '今日' });

    view.rerender(<DashboardTab {...propsFor(null, { range: 'week', statsLoading: true })} />);
    expectHeldFrame(before, { loading: '本周', shown: '今日' });

    view.rerender(<DashboardTab {...propsFor(WEEK, { range: 'week' })} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(chartInstances()).toEqual(before);
    expect(lifecycle.unmounted).toEqual([]);
    expectSettled(WEEK, 'week');
    expect(screen.getByRole('button', { name: '刷新并扫描本地日志' })).toHaveTextContent('刷新扫描');
  });

  it('自定义区间换了起止日期也按范围切换处理，提示写出两段日期', () => {
    const view = render(<DashboardTab {...propsFor(TODAY, { range: 'custom', customRange: { start: '2026-09-01', end: '2026-09-07' } })} />);
    const before = chartInstances();
    view.rerender(<DashboardTab {...propsFor(null, { range: 'custom', customRange: { start: '2026-09-08', end: '2026-09-14' }, statsLoading: true })} />);
    expectHeldFrame(before, { loading: '9月8日—9月14日', shown: '9月1日—9月7日', range: 'custom' });
  });

  it('两个长自定义区间之间切换：日历热力仍按旧区间的起止，到数后才换成新区间', () => {
    const earlier = { start: '2026-06-01', end: '2026-07-31' };
    const later = { start: '2026-08-01', end: '2026-09-15' };
    const view = render(<DashboardTab {...propsFor(TODAY, { range: 'custom', customRange: earlier })} />);
    const before = chartInstances();
    expect(screen.getByTestId('heatmap')).toHaveAttribute('data-bounds', '2026-06-01..2026-07-31');

    view.rerender(<DashboardTab {...propsFor(null, { range: 'custom', customRange: later, statsLoading: true })} />);
    expectHeldFrame(before, { loading: '8月1日—9月15日', shown: '6月1日—7月31日', range: 'custom' });
    expect(screen.getByTestId('heatmap')).toHaveAttribute('data-bounds', '2026-06-01..2026-07-31');

    view.rerender(<DashboardTab {...propsFor(WEEK, { range: 'custom', customRange: later })} />);
    expectSettled(WEEK, 'custom');
    expect(screen.getByTestId('heatmap')).toHaveAttribute('data-bounds', '2026-08-01..2026-09-15');
  });

  it('持有期间再换一次范围：旧帧仍是最初那一段，提示改写成最新的目标；到数后提示消失', () => {
    const view = render(<DashboardTab {...propsFor(TODAY)} />);
    const before = chartInstances();
    view.rerender(<DashboardTab {...propsFor(null, { range: 'week', statsLoading: true })} />);
    expectHeldFrame(before, { loading: '本周', shown: '今日' });

    view.rerender(<DashboardTab {...propsFor(null, { range: 'month', statsLoading: true })} />);
    expectHeldFrame(before, { loading: '本月', shown: '今日' });

    view.rerender(<DashboardTab {...propsFor(MONTH, { range: 'month' })} />);
    expectSettled(MONTH, 'month');
    expect(chartInstances()).toEqual(before);
  });

  it('旧帧是空数据时同样写明两段，空状态留着而不闪错误', () => {
    const view = render(<DashboardTab {...propsFor(EMPTY)} />);
    expect(screen.getByRole('heading', { name: '暂无 Token 记录' })).toBeInTheDocument();
    expect(heldNotice()).toBeEmptyDOMElement();

    view.rerender(<DashboardTab {...propsFor(null, { range: 'all', statsLoading: true })} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '暂无 Token 记录' })).toBeInTheDocument();
    expect(dashboardRoot()).toHaveAttribute('aria-busy', 'true');
    expect(heldNotice()?.textContent).toBe('正在加载「总计」，下方暂为「今日」的数据');

    view.rerender(<DashboardTab {...propsFor(EMPTY, { range: 'all' })} />);
    expect(heldNotice()).toBeEmptyDOMElement();
    expect(dashboardRoot()).not.toHaveAttribute('aria-busy');
  });

  it('新范围真的加载失败时照常报错，不拿旧图顶替，页头提示随旧帧一起消失', () => {
    const view = render(<DashboardTab {...propsFor(TODAY)} />);
    view.rerender(<DashboardTab {...propsFor(null, { range: 'week', statsLoading: true })} />);
    view.rerender(<DashboardTab {...propsFor(null, { range: 'week', statsError: '加载本地数据失败: boom', statsErrorAction: 'load' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('加载本地数据失败: boom');
    expect(screen.queryAllByTestId('echart')).toHaveLength(0);
    expect(screen.queryByText(/正在加载「/)).not.toBeInTheDocument();
  });

  it('换口径不带上一口径的旧图：云端加载时仍是骨架，随后再换范围也不会翻出本机数据', () => {
    const view = render(<DashboardTab {...propsFor(TODAY)} />);
    view.rerender(<DashboardTab {...propsFor(null, { scope: 'cloud', statsLoading: true })} />);
    expect(screen.getByRole('status', { name: '正在加载看板' })).toBeInTheDocument();
    expect(screen.queryAllByTestId('echart')).toHaveLength(0);

    view.rerender(<DashboardTab {...propsFor(null, { scope: 'cloud', range: 'week', statsLoading: true })} />);
    expect(screen.getByRole('status', { name: '正在加载看板' })).toBeInTheDocument();
    expect(screen.queryByTestId('metrics-grid')).not.toBeInTheDocument();
  });

  it('持有期间换到云端（范围不变）立即丢掉本机旧帧，走骨架', () => {
    const view = render(<DashboardTab {...propsFor(TODAY)} />);
    const before = chartInstances();
    view.rerender(<DashboardTab {...propsFor(null, { range: 'week', statsLoading: true })} />);
    expectHeldFrame(before, { loading: '本周', shown: '今日' });

    view.rerender(<DashboardTab {...propsFor(null, { scope: 'cloud', range: 'week', statsLoading: true })} />);
    expectSkeleton();
  });

  it('持有期间切换 Token 口径：旧帧按新口径重排后继续留着，不走骨架，排行与 KPI 同一口径（T10.200）', () => {
    const view = render(<DashboardTab {...propsFor(CACHED)} />);
    const before = chartInstances();
    expect(modelRanking()).toEqual(['gpt-5-codex 100.0K', 'claude-sonnet 80.0K']);
    view.rerender(<DashboardTab {...propsFor(null, { range: 'week', statsLoading: true })} />);
    expectHeldFrame(before, { loading: '本周', shown: '今日', stats: CACHED });

    view.rerender(<DashboardTab {...propsFor(null, { range: 'week', statsLoading: true, showTotalTokens: true })} />);
    expectHeldFrame(before, { loading: '本周', shown: '今日', stats: CACHED });
    expect(modelRanking()).toEqual(['claude-sonnet 280.0K', 'gpt-5-codex 100.0K']);
    expect(screen.getByText(/当前显示/)).toHaveTextContent('总计 380.0K Tokens（包含缓存）');
    expect(screen.getByRole('region', { name: '当前看板上下文' })).toHaveTextContent('旧范围快照');

    // 换回来也一样：还是同一份旧数据，按有效 Token 重排。
    view.rerender(<DashboardTab {...propsFor(null, { range: 'week', statsLoading: true })} />);
    expectHeldFrame(before, { loading: '本周', shown: '今日', stats: CACHED });
    expect(modelRanking()).toEqual(['gpt-5-codex 100.0K', 'claude-sonnet 80.0K']);
  });

  it.each([
    ['设备', 'cloud|studio-mac|account-a'],
    ['账户', 'cloud|all_cloud|account-b'],
  ])('持有期间换了%s（查询身份键不同）：丢掉旧帧走骨架', (_changed, nextIdentity) => {
    const cloud = { scope: 'cloud' as const, queryIdentity: 'cloud|all_cloud|account-a' };
    const view = render(<DashboardTab {...propsFor(TODAY, cloud)} />);
    const before = chartInstances();
    view.rerender(<DashboardTab {...propsFor(null, { ...cloud, range: 'week', statsLoading: true })} />);
    expectHeldFrame(before, { loading: '本周', shown: '今日', refreshName: '正在加载云端看板' });

    view.rerender(<DashboardTab {...propsFor(null, { ...cloud, queryIdentity: nextIdentity, range: 'week', statsLoading: true })} />);
    expectSkeleton();
  });

  it('同一范围下 stats 被清空（如换账户）时也不保留旧帧', () => {
    const view = render(<DashboardTab {...propsFor(TODAY)} />);
    view.rerender(<DashboardTab {...propsFor(null, { statsLoading: true })} />);
    expect(screen.getByRole('status', { name: '正在加载看板' })).toBeInTheDocument();

    view.rerender(<DashboardTab {...propsFor(null, { range: 'week', statsLoading: true })} />);
    expect(screen.getByRole('status', { name: '正在加载看板' })).toBeInTheDocument();
    expect(screen.queryByTestId('metrics-grid')).not.toBeInTheDocument();
  });

  it('A→B→C 接真实 useStats：一直留着 A、提示跟着改写，最终停在 C，B 迟到的响应不覆盖', async () => {
    backend.ready.set('local:today@all_cloud', TODAY);
    render(<StatsBackedDashboard />);
    await settleInitialReads();
    expectSettled(TODAY, 'today');
    const before = chartInstances();

    fireEvent.click(screen.getByRole('button', { name: '测试：切到本月' }));
    expect(waitingKeys()).toEqual(['local:month@all_cloud']);
    expectHeldFrame(before, { loading: '本月', shown: '今日' });

    fireEvent.click(screen.getByRole('button', { name: '测试：切到今年' }));
    expect(waitingKeys()).toEqual(['local:month@all_cloud', 'local:year@all_cloud']);
    expectHeldFrame(before, { loading: '今年', shown: '今日' });

    await resolveWaiting('local:year@all_cloud', YEAR);
    await waitFor(() => expectSettled(YEAR, 'year'));

    await resolveWaiting('local:month@all_cloud', MONTH);
    expectSettled(YEAR, 'year');
    expect(chartInstances()).toEqual(before);
    expect(lifecycle.unmounted).toEqual([]);
    expect(statsReads()).toHaveLength(4);
  });
});

const statsReads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_cached_stats');
const waitingKeys = () => backend.waiting.map(({ key }) => key);

/** 首读与订阅建立后的补偿读取都回来以后再切换；否则补偿读取会晚到并顶掉后面的请求号。 */
async function settleInitialReads() {
  await waitFor(() => expect(statsReads()).toHaveLength(2));
  await screen.findByRole('button', { name: '刷新并扫描本地日志' });
}

async function resolveWaiting(key: string, stats: StatsData) {
  const pending = backend.waiting.find((entry) => entry.key === key);
  if (!pending) throw new Error(`没有排队中的请求：${key}`);
  await act(async () => {
    pending.resolve(stats);
    await Promise.resolve();
  });
}

describe('口径、设备、账户与 Token 口径切换接真实 useStats（T10.200）', () => {
  let insertions: ReturnType<typeof watchInsertions>;

  beforeEach(() => {
    lifecycle.seq = 0;
    lifecycle.unmounted = [];
    backend.ready.clear();
    backend.waiting = [];
    vi.mocked(invoke).mockClear();
    insertions = watchInsertions();
  });

  afterEach(() => insertions.stop());

  it('本机 → 云端 → 本机：没有快照时走骨架，从不插入错误面板；回到本机直接用快照', async () => {
    backend.ready.set('local:today@all_cloud', TODAY);
    render(<StatsBackedDashboard hookProps={CLOUD_HOOK_PROPS} />);
    await settleInitialReads();
    insertions.read();

    fireEvent.click(screen.getByRole('button', { name: '测试：切到云端' }));
    expect(waitingKeys()).toEqual(['cloud:today@all_cloud']);
    expectSkeleton();
    expect(insertions.read()).toEqual({ alerts: [], skeletons: 1 });

    fireEvent.click(screen.getByRole('button', { name: '测试：切到本机' }));
    expect(insertions.read().alerts).toEqual([]);
    await waitFor(() => expectSettled(TODAY, 'today'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('A→B→C 跨口径：本机今日 → 云端今日 → 云端本月，先到的 C 生效，迟到的 B 不覆盖', async () => {
    backend.ready.set('local:today@all_cloud', TODAY);
    render(<StatsBackedDashboard hookProps={CLOUD_HOOK_PROPS} />);
    await settleInitialReads();
    insertions.read();

    fireEvent.click(screen.getByRole('button', { name: '测试：切到云端' }));
    fireEvent.click(screen.getByRole('button', { name: '测试：切到本月' }));
    expect(waitingKeys()).toEqual(['cloud:today@all_cloud', 'cloud:month@all_cloud']);
    // 云端本月没有可留的同口径旧帧：仍是骨架，不拿本机今日的数字顶替。
    expectSkeleton();

    await resolveWaiting('cloud:month@all_cloud', MONTH);
    await waitFor(() => expectSettled(MONTH, 'month'));
    await resolveWaiting('cloud:today@all_cloud', TODAY);
    expectSettled(MONTH, 'month');
    expect(insertions.read().alerts).toEqual([]);
  });

  it('A→B→C 跨设备：全部设备 → studio-pc → laptop，先到的 C 生效，迟到的 B 不覆盖；换回全部设备直接用快照', async () => {
    backend.ready.set('local:today@all_cloud', TODAY);
    backend.ready.set('cloud:today@all_cloud', TODAY);
    render(<StatsBackedDashboard hookProps={CLOUD_HOOK_PROPS} />);
    await settleInitialReads();
    fireEvent.click(screen.getByRole('button', { name: '测试：切到云端' }));
    await waitFor(() => expectSettled(TODAY, 'today'));
    insertions.read();

    fireEvent.click(screen.getByRole('button', { name: '测试：选 studio-pc' }));
    expectSkeleton();
    fireEvent.click(screen.getByRole('button', { name: '测试：选 laptop' }));
    expect(waitingKeys()).toEqual(['cloud:today@studio-pc', 'cloud:today@laptop']);
    expectSkeleton();
    expect(insertions.read().alerts).toEqual([]);

    await resolveWaiting('cloud:today@laptop', LAPTOP);
    await waitFor(() => expectSettled(LAPTOP, 'today'));
    await resolveWaiting('cloud:today@studio-pc', STUDIO);
    expectSettled(LAPTOP, 'today');

    const beforeAll = insertions.read();
    expect(beforeAll.alerts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '测试：全部设备' }));
    // 全部设备今日已有可信快照：立即显示，不走骨架也不报错，后台照常重读。
    expectSettled(TODAY, 'today');
    expect(insertions.read()).toEqual({ alerts: [], skeletons: 0 });
  });

  it.each([
    ['设备', (view: ReturnType<typeof render>) => {
      fireEvent.click(screen.getByRole('button', { name: '测试：选 studio-pc' }));
      return view;
    }],
    ['账户', (view: ReturnType<typeof render>) => {
      view.rerender(<StatsBackedDashboard hookProps={ACCOUNT_B_HOOK_PROPS} />);
      return view;
    }],
  ])('App 接好的 queryIdentity：持有旧帧期间换了%s，立即丢掉旧帧走骨架', async (_changed, change) => {
    backend.ready.set('local:today@all_cloud', TODAY);
    backend.ready.set('cloud:today@all_cloud', TODAY);
    const view = render(<StatsBackedDashboard hookProps={CLOUD_HOOK_PROPS} />);
    await settleInitialReads();
    fireEvent.click(screen.getByRole('button', { name: '测试：切到云端' }));
    await waitFor(() => expectSettled(TODAY, 'today'));
    const before = chartInstances();
    // 本机那一帧的图表在切到云端时已按 §6.5 卸载；这里只看云端这一帧。
    lifecycle.unmounted = [];

    fireEvent.click(screen.getByRole('button', { name: '测试：切到本周' }));
    expectHeldFrame(before, { loading: '本周', shown: '今日', refreshName: '正在加载云端看板' });

    change(view);
    expectSkeleton();
    expect(insertions.read().alerts).toEqual([]);
  });

  it('不在持有态时换 Token 口径：同一份数据重排，不走骨架、不报错、图表不重建', async () => {
    backend.ready.set('local:today@all_cloud', CACHED);
    const view = render(<StatsBackedDashboard />);
    await settleInitialReads();
    const before = chartInstances();
    const reads = statsReads().length;
    insertions.read();

    view.rerender(<StatsBackedDashboard showTotalTokens />);
    expect(modelRanking()).toEqual(['claude-sonnet 280.0K', 'gpt-5-codex 100.0K']);
    view.rerender(<StatsBackedDashboard />);
    expect(modelRanking()).toEqual(['gpt-5-codex 100.0K', 'claude-sonnet 80.0K']);
    expect(chartInstances()).toEqual(before);
    expect(lifecycle.unmounted).toEqual([]);
    expect(statsReads()).toHaveLength(reads);
    expect(insertions.read()).toEqual({ alerts: [], skeletons: 0 });
  });
});
