import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { behaviorAnalysisForQuery, mockBehaviorLedger } from '../devMockTauri';
import type { BehaviorAnalysisResponse } from '../types';
import { useTheme } from '../utils/useTheme';
import {
  BehaviorAnalysisView,
  formatBehaviorSessionCost,
  formatBehaviorSessionSpan,
  formatBehaviorToolSessions,
  formatBehaviorTopModel,
} from './BehaviorAnalysisView';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../utils/useTheme', () => ({ useTheme: vi.fn(() => ({ effective: 'dark' })) }));

// The per-turn drawer has its own tests; here it only has to open with the
// record the behavior page located.
vi.mock('./SessionAnalysisDrawer', () => ({
  default: ({ record, onClose }: { record: { id: number; sessionId: string; tool: string }; onClose: () => void }) => (
    <div role="dialog" aria-label="逐轮分析">
      <span>{`record ${record.id} · ${record.tool} · ${record.sessionId}`}</span>
      <button type="button" onClick={onClose}>关闭逐轮分析</button>
    </div>
  ),
}));

// Capture every EChart `option` this render passes, keyed by its ariaLabel,
// so we can compare object identity across re-renders without a real
// ECharts instance.
const capturedOptions = new Map<string, unknown>();
// The chart event handlers of the latest render, keyed the same way, so a test
// can play a legend click the way ECharts reports it.
const capturedEvents = new Map<string, Record<string, (params: unknown) => void> | undefined>();

vi.mock('./EChart', () => ({
  EChart: ({ option, ariaLabel, onEvents }: { option: unknown; ariaLabel?: string; onEvents?: Record<string, (params: unknown) => void> }) => {
    if (ariaLabel) { capturedOptions.set(ariaLabel, option); capturedEvents.set(ariaLabel, onEvents); }
    return <div data-testid={`echart-${ariaLabel}`} />;
  },
  default: ({ option, ariaLabel, onEvents }: { option: unknown; ariaLabel?: string; onEvents?: Record<string, (params: unknown) => void> }) => {
    if (ariaLabel) { capturedOptions.set(ariaLabel, option); capturedEvents.set(ariaLabel, onEvents); }
    return <div data-testid={`echart-${ariaLabel}`} />;
  },
}));

function buildData(): BehaviorAnalysisResponse {
  return {
    meta: {
      source: 'local',
      complete: true,
      range: 'today',
      start: '2026-09-24',
      end: '2026-09-24',
      timezone: 'Asia/Shanghai',
      recordCount: 12,
      firstRecordAt: '2026-09-24T00:05:00+08:00',
      lastRecordAt: '2026-09-24T23:00:00+08:00',
      sessionLimit: 100,
      sessionsTruncated: false,
    },
    summary: {
      tokens: 12_000,
      inputTokens: 8_000,
      outputTokens: 4_000,
      cachedTokens: 0,
      requests: 12,
      activeDays: 1,
      toolCount: 1,
      sessionCount: 2,
      modelCount: 1,
    },
    tools: [{ id: 'claude', tokens: 12_000, requests: 12, sessionCount: 2 }],
    sessions: [{ id: 's1', tool: 'claude', tokens: 12_000, requests: 12 }],
    dayHours: [{ date: '2026-09-24', hour: 10, tokens: 5_000, requests: 5 }],
    modelHours: [{ hour: 10, model: 'claude-3', tokens: 5_000, requests: 5 }],
    modelDays: [{ date: '2026-09-24', model: 'claude-3', tokens: 12_000, requests: 12 }],
    requestSizes: [{
      model: 'claude-3',
      requests: 12,
      p50: 800,
      p90: 1_600,
      max: 2_000,
      bins: [{ lower: 0, upper: 1_000, requests: 12 }],
    }],
  };
}

const noop = () => {};

describe('BehaviorAnalysisView chart option stability (T10.150 motion-bug regression)', () => {
  beforeEach(() => {
    capturedOptions.clear();
  });

  // getChartThemeTokens() used to return a brand-new object on every call
  // (`{ ...cachedTokens, reduceMotion }`), so every one of the five chart
  // useMemos here depended on a referentially-unstable value and rebuilt on
  // every render — including a re-render triggered by state that has nothing
  // to do with that chart's own inputs (e.g. picking a drill-down date does
  // not change the hourly/model-hour/request-size aggregates at all). A
  // rebuilt option means EChart's `setOption(..., { notMerge: true })` runs
  // again, which resets legend `selectedMode` and (outside reduced-motion)
  // replays the entrance animation. This test pins the fix: an unrelated
  // re-render must not produce new option references for charts whose real
  // inputs did not change.
  it('keeps every chart option reference stable across a re-render caused by picking a drill-down date', () => {
    const data = buildData();
    render(
      <BehaviorAnalysisView
        data={data}
        loading={false}
        error=""
        scope="local"
        range="today"
        customRange={null}
        onRangeChange={noop}
        onRetry={noop}
        onViewLocal={noop}
      />,
    );

    // Sanity check: every chart actually rendered once before we compare.
    const before = new Map(
      ['每日行为活动', '小时行为活动', '每日模型用量', '模型时段分布', '所选模型账本记录大小分布'].map((label) => {
        const option = capturedOptions.get(label);
        expect(option, `expected an option for "${label}"`).toBeTruthy();
        return [label, option];
      }),
    );

    // Selecting a date from the drill-down dropdown re-renders the view but
    // does not change any of the five charts' own aggregated data.
    const select = screen.getByLabelText('选择下钻日期');
    fireEvent.change(select, { target: { value: '2026-09-24' } });

    for (const [label, option] of before) {
      expect(capturedOptions.get(label)).toBe(option);
    }
  });

  it('sets animation from the live reduced-motion value on every chart, like other panels', () => {
    const data = buildData();
    render(
      <BehaviorAnalysisView
        data={data}
        loading={false}
        error=""
        scope="local"
        range="today"
        customRange={null}
        onRangeChange={noop}
        onRetry={noop}
        onViewLocal={noop}
      />,
    );

    for (const label of ['每日行为活动', '小时行为活动', '每日模型用量', '模型时段分布', '所选模型账本记录大小分布']) {
      const option = capturedOptions.get(label) as { animation?: boolean } | undefined;
      expect(option, `expected an option for "${label}"`).toBeTruthy();
      expect(typeof option?.animation).toBe('boolean');
    }
  });

  it('renders the range quick-picks as a segmented group with a sliding-pill container', () => {
    const data = buildData();
    render(
      <BehaviorAnalysisView
        data={data}
        loading={false}
        error=""
        scope="local"
        range="today"
        customRange={null}
        onRangeChange={noop}
        onRetry={noop}
        onViewLocal={noop}
      />,
    );

    const group = screen.getByRole('group', { name: '行为分析时间范围' });
    expect(group).toHaveClass('segmented');
    expect(group).toHaveClass('tl-seg');
    const todayButton = screen.getByRole('button', { name: '今日' });
    expect(todayButton).toHaveAttribute('aria-pressed', 'true');
  });
});

// ---------------------------------------------------------------------------
// T10.164: honesty notes, refresh state, session cost/span/model and drill-downs.
// ---------------------------------------------------------------------------

type ViewProps = ComponentProps<typeof BehaviorAnalysisView>;

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function richData(patch: {
  meta?: Partial<BehaviorAnalysisResponse['meta']>;
  summary?: Partial<BehaviorAnalysisResponse['summary']>;
  sessions?: BehaviorAnalysisResponse['sessions'];
} = {}): BehaviorAnalysisResponse {
  const base = buildData();
  return {
    ...base,
    meta: { ...base.meta, range: 'week', start: '2026-09-21', end: '2026-09-24', rangeDayLimit: 731, rangeTruncated: false, ...patch.meta },
    summary: { ...base.summary, toolCount: 2, sessionCount: 3, unknownSessionRecords: 0, unknownSessionTokens: 0, totalCost: 1.2, costComplete: true, ...patch.summary },
    tools: [
      { id: 'claude', tokens: 9_000, requests: 9, sessionCount: 2 },
      { id: 'minimax', tokens: 3_000, requests: 3, sessionCount: 1 },
    ],
    sessions: patch.sessions ?? [
      { id: 'claude-session-a', tool: 'claude', tokens: 6_000, requests: 6, cost: 0.27, firstAt: '2026-09-24 08:00:00', lastAt: '2026-09-24 11:15:00', topModel: 'claude-sonnet-4' },
      { id: 'claude-session-b', tool: 'claude', tokens: 3_000, requests: 3, cost: null, firstAt: '2026-09-23 23:10:00', lastAt: '2026-09-24 01:05:00', topModel: 'claude-opus-4' },
      { id: 'minimax-session', tool: 'minimax', tokens: 3_000, requests: 3, cost: 0, firstAt: '2026-09-22 09:00:00', lastAt: '2026-09-22 09:00:00', topModel: 'minimax-m1' },
    ],
  };
}

function renderView(props: Partial<ViewProps> = {}) {
  const handlers = { onRangeChange: vi.fn(), onRetry: vi.fn(), onViewLocal: vi.fn(), onOpenTool: vi.fn(), onOpenSession: vi.fn() };
  const view = render(
    <BehaviorAnalysisView
      data={richData()}
      loading={false}
      error=""
      scope="local"
      range="week"
      customRange={null}
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

/** The live region of the refresh control (visually hidden). */
function refreshAnnouncer(container: HTMLElement): HTMLElement {
  const region = container.querySelector('.behavior-refresh [role="status"]');
  if (!(region instanceof HTMLElement)) throw new Error('no refresh live region');
  return region;
}

function sessionRow(sessionId: string): HTMLElement {
  const list = screen.getByRole('list', { name: /会话排行/ });
  const row = within(list).getAllByRole('listitem').find((item) => item.textContent?.includes(sessionId));
  if (!row) throw new Error(`no session row for ${sessionId}`);
  return row;
}

/** The 逐轮分析 button of a session row; its name reads 定位中… while the session is located. */
function analysisButton(sessionId: string): HTMLElement {
  const button = sessionRow(sessionId).querySelector('.behavior-rank-action');
  if (!(button instanceof HTMLElement)) throw new Error(`no 逐轮分析 for ${sessionId}`);
  return button;
}

describe('BehaviorAnalysisView honesty notes (T10.164)', () => {
  afterEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('notes records without a session ID beside the session KPI and ranking', () => {
    renderView({ data: richData({ summary: { unknownSessionRecords: 3, unknownSessionTokens: 1_290 } }) });
    expect(screen.getByText('另有 3 条记录缺少会话 ID')).toBeInTheDocument();
    expect(screen.getByText(/另有 3 条记录（1\.3K 有效 Token）缺少会话 ID，未计入会话数与本排行/)).toBeInTheDocument();
  });

  it('never shows an unknown session count as 0', () => {
    // contract v1.1 tools[].unknownSessionRecords: equal to the records means 「会话未知」.
    expect(formatBehaviorToolSessions({ requests: 3, sessionCount: 0, unknownSessionRecords: 3 })).toBe('会话未知');
    // An older backend without the field: records but no session can only mean the same.
    expect(formatBehaviorToolSessions({ requests: 3, sessionCount: 0 })).toBe('会话未知');
    // A partial count names the records it leaves out.
    expect(formatBehaviorToolSessions({ requests: 9, sessionCount: 2, unknownSessionRecords: 4 })).toBe('2 会话 · 另 4 条缺少会话 ID');
    expect(formatBehaviorToolSessions({ requests: 9, sessionCount: 2, unknownSessionRecords: 0 })).toBe('2 会话');
    expect(formatBehaviorToolSessions({ requests: 9, sessionCount: 2 })).toBe('2 会话');

    const data = richData({ summary: { sessionCount: 0, unknownSessionRecords: 12, unknownSessionTokens: 12_000 }, sessions: [] });
    data.tools = [
      { id: 'minimax', tokens: 9_000, requests: 9, sessionCount: 0, unknownSessionRecords: 9 },
      { id: 'marvis', tokens: 3_000, requests: 3, sessionCount: 0 },
    ];
    renderView({ data });
    const tools = screen.getByRole('list', { name: /工具排行/ });
    expect(within(tools).getByText('9 条记录 · 会话未知')).toBeInTheDocument();
    expect(within(tools).getByText('3 条记录 · 会话未知')).toBeInTheDocument();
    expect(tools).not.toHaveTextContent('0 会话');
    const kpi = screen.getByText('会话数').closest('.behavior-stat') as HTMLElement;
    expect(within(kpi).getByText('不可得')).toBeInTheDocument();
    expect(within(kpi).getByText('12 条记录缺少会话 ID')).toBeInTheDocument();
    expect(screen.getByText('该区间没有带会话 ID 的记录。')).toBeInTheDocument();
  });

  it('marks a partial tool session count with the records it leaves out', () => {
    const data = richData({ summary: { unknownSessionRecords: 4, unknownSessionTokens: 800 } });
    data.tools = [
      { id: 'claude', tokens: 9_000, requests: 9, sessionCount: 2, unknownSessionRecords: 4 },
      { id: 'minimax', tokens: 3_000, requests: 3, sessionCount: 1, unknownSessionRecords: 0 },
    ];
    renderView({ data });
    const tools = screen.getByRole('list', { name: /工具排行/ });
    expect(within(tools).getByText('9 条记录 · 2 会话 · 另 4 条缺少会话 ID')).toBeInTheDocument();
    expect(within(tools).getByText('3 条记录 · 1 会话')).toBeInTheDocument();
  });

  it('shows 不可得 for the session KPI when an older backend reports records but no session', () => {
    const legacy = richData({ summary: { sessionCount: 0 }, sessions: [] });
    delete legacy.summary.unknownSessionRecords;
    delete legacy.summary.unknownSessionTokens;
    renderView({ data: legacy });
    const kpi = screen.getByText('会话数').closest('.behavior-stat') as HTMLElement;
    expect(within(kpi).getByText('不可得')).toBeInTheDocument();
    expect(within(kpi).getByText('记录缺少会话 ID')).toBeInTheDocument();
    expect(kpi).not.toHaveTextContent(/^会话数0/);
  });

  it('renders the per-tool unknown count of the backend-parity preview as 会话未知', () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const data = behaviorAnalysisForQuery({ range: 'week', timezone }, mockBehaviorLedger('edge')) as BehaviorAnalysisResponse;
    const minimax = data.tools.find((tool) => tool.id === 'minimax');
    expect(minimax?.unknownSessionRecords).toBe(minimax?.requests);
    renderView({ data });
    const tools = screen.getByRole('list', { name: /工具排行/ });
    expect(within(tools).getByText(`${minimax?.requests} 条记录 · 会话未知`)).toBeInTheDocument();
    expect(tools).not.toHaveTextContent(/(^|\D)0 会话/);
    const kpi = screen.getByText('会话数').closest('.behavior-stat') as HTMLElement;
    expect(within(kpi).getByText(`另有 ${data.summary.unknownSessionRecords} 条记录缺少会话 ID`)).toBeInTheDocument();
  });

  it('says nothing about missing session IDs when there are none or the backend does not report them', () => {
    const { unmount } = renderView();
    expect(screen.queryByText(/缺少会话 ID/)).not.toBeInTheDocument();
    unmount();
    const legacy = richData();
    delete legacy.summary.unknownSessionRecords;
    delete legacy.summary.unknownSessionTokens;
    renderView({ data: legacy });
    expect(screen.queryByText(/缺少会话 ID/)).not.toBeInTheDocument();
  });

  it('states that 「全部」 only covers the latest 731 days when older records were left out', () => {
    renderView({ range: 'all', data: richData({ meta: { range: 'all', start: '2024-09-25', end: '2026-09-24', rangeTruncated: true } }) });
    expect(screen.getByText('「全部」在行为分析中只统计最近 731 天（2024-09-25 起）；更早的本机记录未计入本页，从排行打开的专属看板与明细仍按完整「全部」统计。')).toBeInTheDocument();
    expect(screen.getByText(/^全部 · 最近 731 天 · 2024-09-25 至 2026-09-24 · 12 条本机账本记录/)).toBeInTheDocument();
  });

  it('does not claim a cut when 「全部」 covers every local record', () => {
    renderView({ range: 'all', data: richData({ meta: { range: 'all', start: '2026-04-17', end: '2026-09-24', rangeTruncated: false } }) });
    expect(screen.queryByText(/只统计最近/)).not.toBeInTheDocument();
    expect(screen.getByText(/^全部 · 2026-04-17 至 2026-09-24/)).toBeInTheDocument();
  });

  it('names inherited calendar presets instead of describing them as rolling days', () => {
    renderView({ range: 'month', data: richData({ meta: { range: 'month', start: '2026-09-01', end: '2026-09-24' } }) });
    expect(screen.getByText(/^本月 · 2026-09-01 至 2026-09-24/)).toBeInTheDocument();
    expect(screen.queryByText(/近 30 天 ·/)).not.toBeInTheDocument();
    for (const name of ['今日', '近 3 天', '近 7 天', '近 30 天']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('stops calling the same dates 近 7 天 on the next local day (review F10)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 8, 24, 23, 50));
      const props = {
        range: 'custom' as const,
        customRange: { start: '2026-09-18', end: '2026-09-24' },
        data: richData({ meta: { range: 'custom', start: '2026-09-18', end: '2026-09-24' } }),
      };
      const view = renderView(props);
      expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true');
      vi.setSystemTime(new Date(2026, 8, 25, 0, 10));
      // Any later render of the new day (a refresh, a hover state) re-judges the pick.
      view.rerender(<BehaviorAnalysisView loading={false} error="" scope="local" onRangeChange={view.onRangeChange} onRetry={view.onRetry} onViewLocal={view.onViewLocal} {...props} />);
      expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByText(/^自定义区间 · 2026-09-18 至 2026-09-24/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('names a behavior quick pick by its rolling days', () => {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    renderView({
      range: 'custom',
      customRange: { start: localDay(start), end: localDay(end) },
      data: richData({ meta: { range: 'custom', start: localDay(start), end: localDay(end) } }),
    });
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(new RegExp(`^近 7 天 · ${localDay(start)} 至 ${localDay(end)}`))).toBeInTheDocument();
  });
});

describe('BehaviorAnalysisView refresh state (T10.164)', () => {
  it('keeps the shown result while refreshing and says so in text, not only with the spinner', () => {
    const { onRetry, container } = renderView({ refreshing: true, updatedAt: new Date().toISOString() });
    expect(screen.getByText('正在刷新…')).toBeVisible();
    // A background refresh is not announced (review F4).
    expect(refreshAnnouncer(container)).toBeEmptyDOMElement();
    expect(screen.queryByText(/更新于/)).not.toBeInTheDocument();
    expect(screen.getByText('会话数')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '刷新' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button.querySelector('svg')).toHaveClass('animate-spin');
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('shows when the result was received and refreshes on press when idle', () => {
    const received = new Date();
    received.setHours(9, 5, 0, 0);
    const { onRetry } = renderView({ updatedAt: received.toISOString() });
    expect(screen.getByText('更新于 09:05')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '刷新' });
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button.querySelector('svg')).not.toHaveClass('animate-spin');
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the date of a result received on an earlier day', () => {
    // Relative to the real clock, so it holds on any date and in any TZ.
    const earlier = new Date();
    earlier.setDate(earlier.getDate() - 3);
    earlier.setHours(7, 30, 0, 0);
    renderView({ updatedAt: earlier.toISOString() });
    expect(screen.getByText(`更新于 ${earlier.getMonth() + 1}/${earlier.getDate()} 07:30`)).toBeInTheDocument();
  });

  it('announces a refresh the user asked for, and not the background ones after it', () => {
    const at = (hour: number, minute: number) => { const value = new Date(); value.setHours(hour, minute, 0, 0); return value.toISOString(); };
    const view = renderView({ updatedAt: at(9, 5) });
    const live = refreshAnnouncer(view.container);
    const rerender = (props: Partial<ViewProps>) => view.rerender(<BehaviorAnalysisView data={richData()} loading={false} error="" scope="local" range="week" customRange={null} onRangeChange={view.onRangeChange} onRetry={view.onRetry} onViewLocal={view.onViewLocal} {...props} />);
    expect(live).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(view.onRetry).toHaveBeenCalledTimes(1);
    expect(live).toHaveTextContent('正在刷新…');
    rerender({ refreshing: true, updatedAt: at(9, 5) });
    expect(live).toHaveTextContent('正在刷新…');
    rerender({ refreshing: false, updatedAt: at(9, 7) });
    expect(live).toHaveTextContent('已刷新，更新于 09:07');

    // A scan finishing later refreshes quietly; only the visible text changes.
    rerender({ refreshing: true, updatedAt: at(9, 7) });
    expect(live).toBeEmptyDOMElement();
    rerender({ refreshing: false, updatedAt: at(9, 12) });
    expect(live).toBeEmptyDOMElement();
    expect(screen.getByText('更新于 09:12')).toBeInTheDocument();
    expect(refreshAnnouncer(view.container)).toBe(live);
  });

  it('leaves a failed manual refresh to the alert banner', () => {
    const received = new Date();
    received.setHours(9, 5, 0, 0);
    const view = renderView({ updatedAt: received.toISOString() });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    view.rerender(<BehaviorAnalysisView data={richData()} loading={false} refreshing error="" scope="local" range="week" customRange={null} onRangeChange={view.onRangeChange} onRetry={view.onRetry} onViewLocal={view.onViewLocal} updatedAt={received.toISOString()} />);
    view.rerender(<BehaviorAnalysisView data={richData()} loading={false} error="加载本机行为分析失败：database is locked" scope="local" range="week" customRange={null} onRangeChange={view.onRangeChange} onRetry={view.onRetry} onViewLocal={view.onViewLocal} updatedAt={received.toISOString()} />);
    expect(refreshAnnouncer(view.container)).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toHaveTextContent('下方仍是 09:05 取得的结果，不是最新。');
  });

  // T10.164 review N1: the hook keeps `error` until a retry settles, so a retry
  // under the failure banner starts with the error still set.
  const LOCKED = '加载本机行为分析失败：database is locked';
  const todayAt = (hour: number, minute: number) => { const value = new Date(); value.setHours(hour, minute, 0, 0); return value.toISOString(); };
  const rerenderWith = (view: ReturnType<typeof renderView>) => (props: Partial<ViewProps>) => view.rerender(<BehaviorAnalysisView data={richData()} loading={false} error="" scope="local" range="week" customRange={null} onRangeChange={view.onRangeChange} onRetry={view.onRetry} onViewLocal={view.onViewLocal} {...props} />);

  it('announces a retry that succeeds after a failure (review N1)', () => {
    const view = renderView({ error: LOCKED, updatedAt: todayAt(9, 5) });
    const live = refreshAnnouncer(view.container);
    const rerender = rerenderWith(view);
    expect(screen.getByRole('alert')).toHaveTextContent('下方仍是 09:05 取得的结果，不是最新。');

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(view.onRetry).toHaveBeenCalledTimes(1);
    rerender({ refreshing: true, error: LOCKED, updatedAt: todayAt(9, 5) });
    expect(live).toHaveTextContent('正在刷新…');
    rerender({ error: '', updatedAt: todayAt(9, 7) });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(live).toHaveTextContent('已刷新，更新于 09:07');
  });

  it('clears the announcement when a refresh fails after an earlier success, and says a retry failed again (review N1)', () => {
    const view = renderView({ updatedAt: todayAt(9, 5) });
    const live = refreshAnnouncer(view.container);
    const rerender = rerenderWith(view);
    const refresh = () => fireEvent.click(screen.getByRole('button', { name: '刷新' }));

    // An earlier manual refresh succeeded and was announced.
    refresh();
    rerender({ refreshing: true, updatedAt: todayAt(9, 5) });
    rerender({ updatedAt: todayAt(9, 7) });
    expect(live).toHaveTextContent('已刷新，更新于 09:07');

    // The next one fails: the new banner tells it, and the live region no longer claims a refresh.
    refresh();
    rerender({ refreshing: true, updatedAt: todayAt(9, 7) });
    rerender({ error: LOCKED, updatedAt: todayAt(9, 7) });
    expect(live).toBeEmptyDOMElement();
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('下方仍是 09:07 取得的结果，不是最新。');

    // A retry that fails for the same reason leaves the banner unchanged, so the live region says it.
    refresh();
    rerender({ refreshing: true, error: LOCKED, updatedAt: todayAt(9, 7) });
    expect(live).toHaveTextContent('正在刷新…');
    rerender({ error: LOCKED, updatedAt: todayAt(9, 7) });
    expect(live).toHaveTextContent('刷新失败，仍显示 09:07 的结果');
    expect(screen.getByRole('alert')).toBe(banner);
    expect(banner).toHaveTextContent('下方仍是 09:07 取得的结果，不是最新。');

    // A background refresh that fails again stays quiet (review F4).
    rerender({ refreshing: true, error: LOCKED, updatedAt: todayAt(9, 7) });
    expect(live).toBeEmptyDOMElement();
    rerender({ error: LOCKED, updatedAt: todayAt(9, 7) });
    expect(live).toBeEmptyDOMElement();
  });

  it('never claims an earlier result is still shown after a retry turned into a new query that failed (review N1)', () => {
    const view = renderView({ error: LOCKED, updatedAt: todayAt(9, 5) });
    const live = refreshAnnouncer(view.container);
    const rerender = rerenderWith(view);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    rerender({ refreshing: true, error: LOCKED, updatedAt: todayAt(9, 5) });
    // The range changed before the retry settled: the new query drops the shown result and the error.
    rerender({ data: null, loading: true, error: '', updatedAt: null });
    rerender({ data: null, error: LOCKED, updatedAt: null });
    expect(live).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).not.toHaveTextContent('仍是');
  });

  it('never says a result is still shown when the page comes back from cloud with none, after a retry under the banner (T10.179 review P3-1)', () => {
    const CLOUD = '行为分析只提供本机账本聚合；云端模式不支持完整行为分析。';
    const view = renderView({ error: LOCKED, updatedAt: todayAt(9, 5) });
    const rerender = rerenderWith(view);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    rerender({ refreshing: true, error: LOCKED, updatedAt: todayAt(9, 5) });
    expect(refreshAnnouncer(view.container)).toHaveTextContent('正在刷新…');
    // Switched to cloud before the retry settled: the page first renders the new
    // scope with the hook's old state, then the hook's reset drops the result and
    // swaps the error text in one step (no empty error in between).
    rerender({ scope: 'cloud', refreshing: true, error: LOCKED, updatedAt: todayAt(9, 5) });
    rerender({ scope: 'cloud', data: null, error: CLOUD, updatedAt: null });
    expect(screen.getByText('行为分析仅支持本机')).toBeInTheDocument();
    // Back to local: the first render still has the reset state, with no result on screen.
    rerender({ data: null, error: CLOUD, updatedAt: null });
    expect(screen.queryByText('会话数')).not.toBeInTheDocument();
    expect(refreshAnnouncer(view.container)).toBeEmptyDOMElement();
    // The hook then reads the local query again.
    rerender({ data: null, loading: true, error: '', updatedAt: null });
    expect(refreshAnnouncer(view.container)).toBeEmptyDOMElement();
  });

  it('says a failed refresh left the previous result on screen', () => {
    const received = new Date();
    received.setHours(9, 5, 0, 0);
    renderView({ error: '加载本机行为分析失败：database is locked', updatedAt: received.toISOString() });
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('读取失败');
    expect(banner).toHaveTextContent('下方仍是 09:05 取得的结果，不是最新。');
    // One text column, so the banner does not spread title and note apart (review F5).
    expect(banner.children).toHaveLength(1);
    expect(banner.firstElementChild?.tagName).toBe('DIV');
    expect(banner.firstElementChild).toHaveTextContent('读取失败加载本机行为分析失败：database is locked下方仍是 09:05 取得的结果，不是最新。');
    expect(screen.getByText('会话数')).toBeInTheDocument();
  });

  it('does not claim an older result when a failure left nothing on screen', () => {
    renderView({ data: null, error: '加载本机行为分析失败：database is locked' });
    expect(screen.getByRole('alert')).not.toHaveTextContent('仍是');
  });

  it('marks the first load busy without an update time', () => {
    renderView({ data: null, loading: true, updatedAt: null });
    expect(screen.getByText('正在聚合本机账本…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(/更新于/)).not.toBeInTheDocument();
  });

  it('keeps the drill-down selection across a refresh of the same window and resets it for a new window', () => {
    const first = richData();
    const { rerender } = renderView({ data: first });
    fireEvent.change(screen.getByLabelText('选择下钻日期'), { target: { value: '2026-09-23' } });
    const props = { loading: false, error: '', scope: 'local' as const, range: 'week' as const, customRange: null, onRangeChange: vi.fn(), onRetry: vi.fn(), onViewLocal: vi.fn() };
    rerender(<BehaviorAnalysisView {...props} data={{ ...first, summary: { ...first.summary, tokens: 13_000 } }} />);
    expect(screen.getByLabelText('选择下钻日期')).toHaveValue('2026-09-23');
    rerender(<BehaviorAnalysisView {...props} data={richData({ meta: { start: '2026-09-22' } })} />);
    expect(screen.getByLabelText('选择下钻日期')).toHaveValue('');
  });
});

describe('BehaviorAnalysisView keeps the old range while a new one loads (T10.201, T10.181 review open point 7)', () => {
  const CHARTS = ['每日行为活动', '小时行为活动', '每日模型用量', '模型时段分布'];

  it('keeps the previous frame and chart instances instead of unmounting to the skeleton, and says which range is which', () => {
    const view = renderView({ data: richData({ meta: { range: 'week', start: '2026-09-21', end: '2026-09-24' } }), range: 'week' });
    expect(screen.getByText('会话数')).toBeInTheDocument();
    const charts = CHARTS.map((label) => screen.getByTestId(`echart-${label}`));

    // The hook clears its result and sets loading before the new range's data
    // arrives (a real query-identity change, not a refresh of the same query).
    view.rerender(
      <BehaviorAnalysisView data={null} loading error="" scope="local" range="month" customRange={null}
        onRangeChange={view.onRangeChange} onRetry={view.onRetry} onViewLocal={view.onViewLocal} />,
    );
    expect(screen.queryByText('正在聚合本机账本…')).not.toBeInTheDocument();
    expect(screen.getByText('会话数')).toBeInTheDocument();
    CHARTS.forEach((label, index) => expect(screen.getByTestId(`echart-${label}`)).toBe(charts[index]));
    expect(screen.getByText('正在加载「本月」，下方暂为「本周」的数据')).toBeInTheDocument();

    // The new range's result arrives: the notice clears.
    view.rerender(
      <BehaviorAnalysisView data={richData({ meta: { range: 'month', start: '2026-09-01', end: '2026-09-24' } })} loading={false} error="" scope="local" range="month" customRange={null}
        onRangeChange={view.onRangeChange} onRetry={view.onRetry} onViewLocal={view.onViewLocal} />,
    );
    expect(screen.queryByText(/正在加载/)).not.toBeInTheDocument();
  });

  it('does not hold a frame across a genuine failure or a scope switch, only a pure range change', () => {
    const view = renderView({ data: richData(), range: 'week' });
    // A real failure: no held frame, the usual empty/error state applies.
    view.rerender(
      <BehaviorAnalysisView data={null} loading={false} error="加载本机行为分析失败：database is locked" scope="local" range="month" customRange={null}
        onRangeChange={view.onRangeChange} onRetry={view.onRetry} onViewLocal={view.onViewLocal} />,
    );
    expect(screen.queryByText(/正在加载/)).not.toBeInTheDocument();
    expect(screen.queryByText('会话数')).not.toBeInTheDocument();
  });
});

describe('BehaviorAnalysisView refresh keeps the charts (T10.150 QA F9)', () => {
  const CHARTS = ['每日行为活动', '小时行为活动', '每日模型用量', '模型时段分布', '所选模型账本记录大小分布'];
  const legendOf = (label: string) => (capturedOptions.get(label) as { legend?: { selected?: Record<string, boolean> } }).legend?.selected;

  type ShownProps = Partial<ViewProps> & { data: BehaviorAnalysisResponse };

  /** Renders the page, then lets a test feed it the hook's next states with the same handlers. */
  function renderRefreshable(initial: ShownProps) {
    const view = renderView(initial);
    const update = (props: ShownProps) => view.rerender(<BehaviorAnalysisView loading={false} error="" scope="local" range="week" customRange={null} onRangeChange={view.onRangeChange} onRetry={view.onRetry} onViewLocal={view.onViewLocal} {...props} />);
    return { ...view, update };
  }

  it('updates the charts in place through a refresh and keeps hidden legend series', () => {
    capturedOptions.clear();
    const first = richData();
    const view = renderRefreshable({ data: first });
    const charts = CHARTS.map((label) => screen.getByTestId(`echart-${label}`));
    // The user hides a model in both legends; ECharts reports the whole map.
    act(() => {
      capturedEvents.get('每日模型用量')?.legendselectchanged({ name: 'claude-3', selected: { 'claude-3': false } });
      capturedEvents.get('模型时段分布')?.legendselectchanged({ name: 'claude-3', selected: { 'claude-3': false } });
    });

    // Refreshing keeps the result and every chart mounted.
    view.update({ refreshing: true, data: first });
    expect(screen.queryByText('正在聚合本机账本…')).not.toBeInTheDocument();
    CHARTS.forEach((label, index) => expect(screen.getByTestId(`echart-${label}`)).toBe(charts[index]));

    // New content for the same window: rebuilt options, same chart elements,
    // and the hidden series stay hidden.
    const next = { ...first, modelDays: first.modelDays.map((row) => ({ ...row, tokens: row.tokens + 500 })), modelHours: first.modelHours.map((row) => ({ ...row, tokens: row.tokens + 500 })) };
    view.update({ data: next });
    CHARTS.forEach((label, index) => expect(screen.getByTestId(`echart-${label}`)).toBe(charts[index]));
    expect(legendOf('每日模型用量')).toEqual({ 'claude-3': false });
    expect(legendOf('模型时段分布')).toEqual({ 'claude-3': false });

    // A different window starts with every series shown again.
    view.update({ data: richData({ meta: { start: '2026-09-22' } }) });
    expect(legendOf('每日模型用量')).toEqual({});
    expect(legendOf('模型时段分布')).toEqual({});
  });

  it('keeps the charts and says so when a refresh fails', () => {
    const received = new Date();
    received.setHours(9, 5, 0, 0);
    const shown = richData();
    const view = renderRefreshable({ updatedAt: received.toISOString(), data: shown });
    const charts = CHARTS.map((label) => screen.getByTestId(`echart-${label}`));
    view.update({ refreshing: true, updatedAt: received.toISOString(), data: shown });
    view.update({ error: '加载本机行为分析失败：database is locked', updatedAt: received.toISOString(), data: shown });
    CHARTS.forEach((label, index) => expect(screen.getByTestId(`echart-${label}`)).toBe(charts[index]));
    expect(screen.getByRole('alert')).toHaveTextContent('下方仍是 09:05 取得的结果，不是最新。');
    expect(screen.getByText('更新于 09:05')).toBeInTheDocument();
  });
});

describe('BehaviorAnalysisView session ranking (T10.164, D5①)', () => {
  it('formats session cost as an estimate and never shows unknown cost as $0', () => {
    expect(formatBehaviorSessionCost(0.27)).toBe('≈$0.27');
    expect(formatBehaviorSessionCost(1234.5)).toBe('≈$1,234.50');
    expect(formatBehaviorSessionCost(0.004)).toBe('<$0.01');
    expect(formatBehaviorSessionCost(0)).toBe('≈$0.00');
    for (const unknown of [null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(formatBehaviorSessionCost(unknown)).toBe('不可得');
    }
  });

  it('formats the in-range start and end as compact local wall-clock times', () => {
    expect(formatBehaviorSessionSpan('2026-09-24 08:00:00', '2026-09-24 11:15:00', 2026)).toBe('9/24 08:00–11:15');
    expect(formatBehaviorSessionSpan('2026-09-24 08:00:00', '2026-09-24 08:00:59', 2026)).toBe('9/24 08:00');
    expect(formatBehaviorSessionSpan('2026-09-23 23:10:00', '2026-09-24 01:05:00', 2026)).toBe('9/23 23:10 – 9/24 01:05');
    expect(formatBehaviorSessionSpan('2025-12-31 23:50:00', '2026-01-01 00:20:00', 2026)).toBe('2025/12/31 23:50 – 2026/1/1 00:20');
    expect(formatBehaviorSessionSpan('2025-03-02 10:00:00', '2025-03-02 12:00:00', 2026)).toBe('2025/3/2 10:00–12:00');
    expect(formatBehaviorSessionSpan(undefined, undefined, 2026)).toBeNull();
  });

  it('shows each session cost, span and top model, with 不可得 for an unknown cost', () => {
    renderView();
    expect(screen.getByText(/起止为区间内首末记录/)).toBeInTheDocument();
    // Lists keep their semantics under list-style:none in WebKit (review F4).
    for (const name of [/工具排行/, /会话排行/]) expect(screen.getByRole('list', { name })).toHaveAttribute('role', 'list');
    const a = sessionRow('claude-session-a');
    expect(a).toHaveTextContent('claude · claude-sonnet-4 · 9/24 08:00–11:15 · 6 条记录');
    expect(a).toHaveTextContent('≈$0.27');
    const b = sessionRow('claude-session-b');
    expect(b).toHaveTextContent('9/23 23:10 – 9/24 01:05');
    expect(within(b).getByText('不可得')).toBeInTheDocument();
    expect(b).toHaveTextContent('会话预估费用不可得');
    expect(b).not.toHaveTextContent('$0');
    expect(sessionRow('minimax-session')).toHaveTextContent('≈$0.00');
    expect(screen.getByText(/会话预估费用按价格表估算，非账单/)).toBeInTheDocument();
  });

  it('shows a null top model as 不可得 and omits a field an older backend never sent', () => {
    expect(formatBehaviorTopModel('gpt-5-codex')).toBe('gpt-5-codex');
    expect(formatBehaviorTopModel(null)).toBe('主模型不可得');
    expect(formatBehaviorTopModel('  ')).toBe('主模型不可得');
    expect(formatBehaviorTopModel(undefined)).toBeNull();
    const nullModel = { id: 'no-model', tool: 'codex', tokens: 10, requests: 1, cost: 0.1, firstAt: '2026-09-24 08:00:00', lastAt: '2026-09-24 08:00:00', topModel: null };
    renderView({ data: richData({ sessions: [nullModel as unknown as BehaviorAnalysisResponse['sessions'][number]] }) });
    expect(sessionRow('no-model')).toHaveTextContent('codex · 主模型不可得 · 9/24 08:00 · 1 条记录');
  });

  it('keeps legacy sessions without cost fields honest', () => {
    renderView({ data: richData({ sessions: [{ id: 'legacy', tool: 'codex', tokens: 10, requests: 1 }] }) });
    const row = sessionRow('legacy');
    expect(within(row).getByText('不可得')).toBeInTheDocument();
    expect(row).toHaveTextContent('codex · 1 条记录');
  });
});

describe('BehaviorAnalysisView drill-down targets (T10.164, audit Q9)', () => {
  // richData() is 本周 2026-09-21 to 09-24 in Asia/Shanghai. Only Date is faked,
  // so the drill-downs see a fixed "now" while timers stay real.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-24T12:00:00+08:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
  });

  it('opens a tool\'s 专属看板 from its ranking row', () => {
    const { onOpenTool } = renderView();
    const list = screen.getByRole('list', { name: /工具排行/ });
    const button = within(list).getByRole('button', { name: /minimax.*打开专属看板/ });
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);
    expect(onOpenTool).toHaveBeenCalledWith('minimax', null);
  });

  it('opens the details for a session row, keyed by tool and session ID', () => {
    const { onOpenSession } = renderView();
    fireEvent.click(within(sessionRow('claude-session-b')).getByRole('button', { name: /claude-session-b.*查看该会话明细/ }));
    expect(onOpenSession).toHaveBeenCalledWith({
      session: { id: 'claude-session-b', tool: 'claude' },
      filters: { tools: ['claude'], models: [], machines: [], search: 'claude-session-b' },
      range: null,
    });
  });

  it('opens the analysed dates once the calendar has moved past the preset (review F2)', () => {
    // The page kept this week's result into the next Monday without a refresh.
    vi.setSystemTime(new Date('2026-09-28T00:10:00+08:00'));
    const { onOpenTool, onOpenSession } = renderView();
    fireEvent.click(within(screen.getByRole('list', { name: /工具排行/ })).getByRole('button', { name: /minimax.*打开专属看板/ }));
    expect(onOpenTool).toHaveBeenCalledWith('minimax', { start: '2026-09-21', end: '2026-09-24' });
    fireEvent.click(within(sessionRow('claude-session-a')).getByRole('button', { name: /claude-session-a.*查看该会话明细/ }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ range: { start: '2026-09-21', end: '2026-09-24' } }));
  });

  it('offers 逐轮分析 only for Claude and Codex sessions', () => {
    renderView();
    expect(within(sessionRow('claude-session-a')).getByRole('button', { name: '逐轮分析：会话 claude-session-a' })).toBeInTheDocument();
    expect(within(sessionRow('minimax-session')).queryByRole('button', { name: /逐轮分析/ })).not.toBeInTheDocument();
  });

  it('locates a ledger record of the session and opens the per-turn drawer with it', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 'ok', items: [{ id: 77, tool: 'claude', model: 'claude-sonnet-4', inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0, timestamp: '2026-09-24 08:00:00', sessionId: 'claude-session-a', machineId: 'Studio-PC' }],
      nextCursor: null, hasMore: false, totalCount: 1, filteredSummary: {}, availableFilters: { tools: [], models: [], machines: [] }, granularity: 'request',
    });
    renderView();
    await act(async () => {
      fireEvent.click(within(sessionRow('claude-session-a')).getByRole('button', { name: /逐轮分析/ }));
    });
    // Looked up over the analysed dates, not the re-resolved preset (review F2).
    expect(invoke).toHaveBeenCalledWith('get_usage_details', { query: expect.objectContaining({ scope: 'local', range: 'custom', start: '2026-09-21', end: '2026-09-24', timezone: 'Asia/Shanghai', tools: ['claude'], search: 'claude-session-a' }) });
    const drawer = await screen.findByRole('dialog', { name: '逐轮分析' });
    expect(drawer).toHaveTextContent('record 77 · claude · claude-session-a');
    fireEvent.click(within(drawer).getByRole('button', { name: '关闭逐轮分析' }));
    expect(screen.queryByRole('dialog', { name: '逐轮分析' })).not.toBeInTheDocument();
  });

  it('explains instead of opening an empty drawer when the session has no record left', async () => {
    vi.mocked(invoke).mockResolvedValue({ status: 'ok', items: [], nextCursor: null, hasMore: false, totalCount: 0, filteredSummary: {}, availableFilters: { tools: [], models: [], machines: [] }, granularity: 'request' });
    const { container } = renderView();
    // The live region is there, empty, before anything is announced (review F3).
    const live = container.querySelector('.behavior-rank-live') as HTMLElement;
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toBeEmptyDOMElement();
    await act(async () => {
      fireEvent.click(within(sessionRow('claude-session-a')).getByRole('button', { name: /逐轮分析/ }));
    });
    expect(container.querySelector('.behavior-rank-live')).toBe(live);
    expect(live).toHaveTextContent('本次分析的区间（2026-09-21 至 2026-09-24）内已找不到会话 claude-session-a 的明细记录');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the session when its details cannot be read', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('database is locked'));
    const { container } = renderView();
    await act(async () => {
      fireEvent.click(within(sessionRow('claude-session-b')).getByRole('button', { name: /逐轮分析/ }));
    });
    expect(container.querySelector('.behavior-rank-live')).toHaveTextContent('暂时无法读取本机明细来定位会话 claude-session-b，请稍后重试。');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('marks the pressed session busy while it is located and ignores a repeated press', async () => {
    const pending: Array<(value: unknown) => void> = [];
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    renderView();
    const button = () => analysisButton('claude-session-a');
    await act(async () => { fireEvent.click(button()); });
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(button()).toHaveAccessibleName('定位中…：会话 claude-session-a');
    await act(async () => { fireEvent.click(button()); });
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending[0]({ status: 'ok', items: [{ id: 77, tool: 'claude', model: 'm', inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0, timestamp: '2026-09-24 08:00:00', sessionId: 'claude-session-a', machineId: 'Studio-PC' }], nextCursor: null, hasMore: false, totalCount: 1, filteredSummary: {}, availableFilters: { tools: [], models: [], machines: [] }, granularity: 'request' });
    });
    expect(button()).not.toHaveAttribute('aria-busy');
    expect(button()).toHaveAccessibleName('逐轮分析：会话 claude-session-a');
    expect(await screen.findByRole('dialog', { name: '逐轮分析' })).toHaveTextContent('record 77');
  });

  it('lets a press on another session replace a lookup still in flight', async () => {
    const pending: Array<(value: unknown) => void> = [];
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    renderView();
    const page = (id: number, sessionId: string) => ({ status: 'ok', items: [{ id, tool: 'claude', model: 'm', inputTokens: 1, outputTokens: 1, cachedTokens: 0, cost: 0, timestamp: '2026-09-24 08:00:00', sessionId, machineId: 'Studio-PC' }], nextCursor: null, hasMore: false, totalCount: 1, filteredSummary: {}, availableFilters: { tools: [], models: [], machines: [] }, granularity: 'request' });
    await act(async () => { fireEvent.click(analysisButton('claude-session-a')); });
    await act(async () => { fireEvent.click(analysisButton('claude-session-b')); });
    expect(analysisButton('claude-session-a')).not.toHaveAttribute('aria-busy');
    expect(analysisButton('claude-session-b')).toHaveAttribute('aria-busy', 'true');
    // The first lookup answers late: it must not open a drawer any more.
    await act(async () => { pending[0](page(11, 'claude-session-a')); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { pending[1](page(22, 'claude-session-b')); });
    expect(await screen.findByRole('dialog', { name: '逐轮分析' })).toHaveTextContent('record 22 · claude · claude-session-b');
  });

  it('renders plain rows without targets when no drill-down handlers are wired', () => {
    renderView({ onOpenTool: undefined, onOpenSession: undefined });
    const tools = screen.getByRole('list', { name: /工具排行/ });
    expect(within(tools).queryByRole('button')).not.toBeInTheDocument();
    expect(within(sessionRow('claude-session-a')).getAllByRole('button').map((button) => button.textContent)).toEqual(['逐轮分析：会话 claude-session-a']);
  });
});

describe('BehaviorAnalysisView tool colours (T10.178 review P1-1/P2-1)', () => {
  afterEach(() => {
    (useTheme as unknown as Mock).mockReturnValue({ effective: 'dark' });
  });

  // antigravity and gemini both primary to chart-slot 1 (§3.8) — the review's
  // probe P-B found the tool-ranking and session-ranking lists disagreeing
  // with each other on this exact pair once collision-shift only covered one
  // of the two lists.
  function collidingData(): BehaviorAnalysisResponse {
    return {
      ...buildData(),
      tools: [
        { id: 'antigravity', tokens: 9_000, requests: 9, sessionCount: 1 },
        { id: 'gemini', tokens: 3_000, requests: 3, sessionCount: 1 },
      ],
      sessions: [
        { id: 'antigravity-session', tool: 'antigravity', tokens: 9_000, requests: 9 },
        { id: 'gemini-session', tool: 'gemini', tokens: 3_000, requests: 3 },
      ],
    };
  }

  function toolRankDotColor(toolId: string): string {
    const list = screen.getByRole('list', { name: /工具排行/ });
    const button = within(list).getByRole('button', { name: new RegExp(`${toolId}.*打开专属看板`) });
    const dot = button.querySelector('.entity-dot');
    if (!(dot instanceof HTMLElement)) throw new Error(`no tool-rank dot for ${toolId}`);
    return dot.style.color;
  }

  function sessionDotColor(sessionId: string): string {
    const dot = sessionRow(sessionId).querySelector('.entity-dot');
    if (!(dot instanceof HTMLElement)) throw new Error(`no session-rank dot for ${sessionId}`);
    return dot.style.color;
  }

  it('colours antigravity and gemini (same primary slot) differently in the tool-ranking list, and the session-ranking list reuses that exact same per-tool colour', () => {
    renderView({ data: collidingData() });
    const antigravityColor = toolRankDotColor('antigravity');
    const geminiColor = toolRankDotColor('gemini');
    expect(antigravityColor).not.toBe(geminiColor);
    expect(sessionDotColor('antigravity-session')).toBe(antigravityColor);
    expect(sessionDotColor('gemini-session')).toBe(geminiColor);
  });

  it('recomputes tool-ranking and session-ranking colours when the theme toggles (review P2-1: the useMemo dependency array used to omit theme, so a stale colour stuck around after a toggle)', () => {
    // The same data object is passed to both renders on purpose: with a fresh
    // collidingData() the memo would recompute because `data` changed, and the
    // test would pass even if `effective` were missing from the dependency
    // array (T10.178 re-review P2-R2-1).
    const data = collidingData();
    const { rerender } = renderView({ data });
    const beforeAntigravity = toolRankDotColor('antigravity');
    const beforeSessionColor = sessionDotColor('antigravity-session');

    (useTheme as unknown as Mock).mockReturnValue({ effective: 'light' });
    // BehaviorAnalysisView is not memo()-wrapped, so a plain re-render (no new
    // prop references needed) already re-executes the component body and
    // reads the new useTheme() mock value. rerender (not a second render())
    // replaces the same tree instead of mounting a second copy alongside it.
    rerender(
      <BehaviorAnalysisView
        data={data}
        loading={false}
        error=""
        scope="local"
        range="week"
        customRange={null}
        onRangeChange={vi.fn()}
        onRetry={vi.fn()}
        onViewLocal={vi.fn()}
        onOpenTool={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );

    const afterAntigravity = toolRankDotColor('antigravity');
    const afterSessionColor = sessionDotColor('antigravity-session');
    expect(afterAntigravity).not.toBe(beforeAntigravity);
    expect(afterSessionColor).not.toBe(beforeSessionColor);
    expect(afterSessionColor).toBe(afterAntigravity); // still shared between the two lists after the toggle
  });
});

describe('BehaviorAnalysisView 项目维度（TOKE-13）', () => {
  const secret = 'SecretClient';
  const secretKey = 'n:secretclient';

  function withProjects(state: 'disabled' | 'consent_required' | 'ready'): BehaviorAnalysisResponse {
    const base = richData();
    if (state !== 'ready') {
      return { ...base, meta: { ...base.meta, projectDimension: { state } } };
    }
    return {
      ...base,
      meta: {
        ...base.meta,
        projectDimension: { state: 'ready', indexedSessions: 2, pendingSessions: 0, filter: [] },
      },
      projects: [{
        key: secretKey,
        label: secret,
        kind: 'named',
        tokens: 6000,
        requests: 6,
        sessionCount: 1,
        cost: 0.27,
        share: 0.5,
        tools: [{ id: 'claude', tokens: 6000 }],
      }],
      unattributed: {
        tokens: 6000,
        requests: 6,
        sessionCount: 2,
        cost: 0,
        share: 0.5,
        reasons: [{ reason: 'unsupported_source', tokens: 6000, requests: 6, sessionCount: 2, share: 0.5 }],
      },
      sessions: base.sessions.map((session, index) => (
        index === 0
          ? { ...session, project: { key: secretKey, label: secret, kind: 'named' as const } }
          : { ...session, project: null, projectReason: 'unsupported_source' as const }
      )),
    };
  }

  beforeEach(() => {
    window.localStorage.removeItem('tokenledger.hideProjectNames');
  });

  it('没有项目字段时不渲染项目区', () => {
    renderView();
    expect(screen.queryByRole('heading', { name: /^项目/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '了解并开启' })).not.toBeInTheDocument();
  });

  it('关闭时只给出设置入口，不显示项目名', () => {
    const onOpenProjectSettings = vi.fn();
    renderView({ data: withProjects('disabled'), onOpenProjectSettings });
    expect(screen.getByText(/按项目查看用量，默认关闭/)).toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '了解并开启' }));
    expect(onOpenProjectSettings).toHaveBeenCalledTimes(1);
  });

  it('开启后显示项目排行、会话项目，隐藏后名称和键都不进页面', () => {
    const onProjectFilterChange = vi.fn();
    renderView({ data: withProjects('ready'), onProjectFilterChange });
    expect(screen.getByRole('heading', { name: /^项目/ })).toBeInTheDocument();
    expect(screen.getAllByText(secret).length).toBeGreaterThan(0);
    const ranking = screen.getByRole('list', { name: /^项目/ });
    fireEvent.click(within(ranking).getByRole('button', { name: /SecretClient/ }));
    expect(onProjectFilterChange).toHaveBeenCalledWith([secretKey]);

    fireEvent.click(screen.getByRole('switch', { name: '隐藏项目名' }));
    const html = document.body.innerHTML;
    expect(html).not.toContain(secret);
    expect(html).not.toContain(secretKey);
    expect(screen.getAllByText('项目 1').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /未归属，来源不记录工作目录/ }).length).toBeGreaterThan(0);
  });

  it('云端视图说明项目维度不可用', () => {
    renderView({ scope: 'cloud', data: withProjects('ready') });
    expect(screen.getByText(/项目维度仅在本机视图可用/)).toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });
});

describe('BehaviorAnalysisView axis labels (T10.164 review N3)', () => {
  it('labels billions on every token axis with B, the unit the tooltips use', () => {
    capturedOptions.clear();
    renderView();
    for (const label of ['每日行为活动', '小时行为活动', '每日模型用量', '模型时段分布']) {
      const option = capturedOptions.get(label) as { yAxis: { axisLabel: { formatter: (value: number) => string } } } | undefined;
      expect(option, `expected an option for "${label}"`).toBeTruthy();
      expect(option?.yAxis.axisLabel.formatter(2_000_000_000), label).toBe('2B');
      expect(option?.yAxis.axisLabel.formatter(1_500_000), label).toBe('1.5M');
    }
  });
});


describe('BehaviorAnalysisView custom range (T10.300e)', () => {
  it('reveals dates only on custom selection and validates form submission', () => {
    const onRangeChange = vi.fn();
    render(<BehaviorAnalysisView data={buildData()} loading={false} error="" scope="local" range="today" customRange={null} onRangeChange={onRangeChange} onRetry={noop} onViewLocal={noop} />);
    expect(screen.queryByLabelText('自定义起始日期')).not.toBeInTheDocument();
    expect(screen.getByText('已应用 2026-09-24 至 2026-09-24')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name:'自定义' }));
    const start = screen.getByLabelText('自定义起始日期');
    const end = screen.getByLabelText('自定义结束日期');
    fireEvent.change(start, { target:{ value:'2026-09-24' } });
    fireEvent.change(end, { target:{ value:'2026-09-23' } });
    expect(end).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name:'分析区间' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name:'自定义行为分析区间' }));
    expect(onRangeChange).not.toHaveBeenCalled();
    fireEvent.change(end, { target:{ value:'2026-09-25' } });
    expect(end).not.toHaveAttribute('aria-invalid');
    fireEvent.submit(screen.getByRole('form', { name:'自定义行为分析区间' }));
    expect(onRangeChange).toHaveBeenCalledWith('custom', { start:'2026-09-24', end:'2026-09-25' });
    fireEvent.click(screen.getByRole('button', { name:'今日' }));
    expect(screen.queryByLabelText('自定义起始日期')).not.toBeInTheDocument();
  });
});
