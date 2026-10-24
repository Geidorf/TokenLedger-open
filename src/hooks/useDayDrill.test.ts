import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { clearMocks } from '@tauri-apps/api/mocks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetailFilters } from '../components/LogsTable';
import { installDevMockTauri } from '../devMockTauri';
import type { CustomDateRange, DataScope, RangeKey, StatsData, Tab, UsageDetailsResponse } from '../types';
import {
  dayDrillCopy,
  isDayDrillQuery,
  originFiltersFor,
  useDayDrill,
  type DayDrill,
  type DayDrillOrigin,
} from './useDayDrill';
import { EMPTY_DETAIL_FILTERS, useUsageDetails } from './useUsageDetails';

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const localDay = (timestamp: string) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

// The preview ledger's clock is fixed at 2026-07-15 14:30; every day before it
// carries eleven records.
const DRILL_DAY = '2026-07-10';
// A device filter on purpose: it may come back only within the scope it came from.
const ORIGIN_FILTERS: DetailFilters = { tools: ['codex'], models: [], machines: ['Studio-PC'], search: 'session' };

// T10.185: `useUsageDetails.loadDetails` only calls through for cloud once a
// Stats v2 response has actually arrived (`hasCloudCapability`); local scope
// has no such gate and keeps using `stats: null` below unchanged.
const CLOUD_STATS_STUB: StatsData = {
  summary: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalCost: 0, totalRequests: 0, avgTokensPerReq: 0 },
  tools: {},
  models: {},
  trends: [],
  heatmap: {},
  history: [],
  meta: {
    contractVersion: 2,
    capabilities: { comparison: true, detailPagination: true, entityDashboard: true, multiFilterSearch: true, quotaSnapshots: false },
  },
};

/** App wiring in miniature: the real details hook and the drill hook on shared range and scope state. */
function useAppSlice(initialScope: DataScope) {
  const [scope, setScope] = useState<DataScope>(initialScope);
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [range, setRange] = useState<RangeKey>('month');
  const [customRange, setCustomRange] = useState<CustomDateRange | null>(null);
  const notices = useRef<string[]>([]);
  const commits = useRef<Array<{ scope: DataScope; range: RangeKey; reviewing: boolean }>>([]);
  const details = useUsageDetails({
    dataScope: scope,
    range,
    customRange,
    deviceFilter: 'all_cloud',
    stats: scope === 'cloud' ? CLOUD_STATS_STUB : null,
    statsError: '',
    currentTimezone: timezone,
  });
  const changeRange = useCallback((value: RangeKey, bounds: CustomDateRange | null = null) => {
    setRange(value);
    setCustomRange(value === 'custom' ? bounds : null);
  }, []);
  const changeTab = useCallback((tab: Tab) => setActiveTab(tab), []);
  const onScopeExit = useCallback((notice: string) => { notices.current.push(notice); }, []);
  const drill = useDayDrill({
    scope,
    activeTab,
    range,
    customRange,
    filters: details.detailFilters,
    changeRange,
    setFilters: details.setDetailFilters,
    changeTab,
    onScopeExit,
  });
  // useStats.selectCloudScope / selectLocalScope: switch and clear the device filter.
  const { setDetailFilters } = details;
  const switchScope = useCallback((next: DataScope) => {
    setScope(next);
    setDetailFilters((previous) => ({ ...previous, machines: [] }));
  }, [setDetailFilters]);
  // App's header handler: leave the review first, in the same click.
  const { leaveForScope } = drill;
  const selectScopeFromHeader = useCallback((next: DataScope) => {
    leaveForScope(next);
    switchScope(next);
  }, [leaveForScope, switchScope]);
  // Every committed frame, to prove what the screen and the requests ever saw.
  useEffect(() => {
    commits.current.push({ scope, range, reviewing: drill.dayDrill !== null });
  });
  return {
    activeTab,
    range,
    customRange,
    scope,
    changeRange,
    details,
    drill,
    switchScope,
    selectScopeFromHeader,
    notices: notices.current,
    commits: commits.current,
  };
}

async function loadDetails(result: { current: ReturnType<typeof useAppSlice> }) {
  await act(async () => { await result.current.details.loadDetails(); });
  await waitFor(() => expect(result.current.details.detailsLoading).toBe(false));
  return result.current.details.details as UsageDetailsResponse;
}

describe('overview day drill-down (audit P0-1)', () => {
  beforeEach(() => {
    clearMocks();
    installDevMockTauri();
  });
  afterEach(() => clearMocks());

  const searchMonth = (search: string) => invoke<UsageDetailsResponse>('get_usage_details', {
    query: { scope: 'local', range: 'month', timezone: timezone(), machines: [], tools: [], models: [], search, tokenMode: 'effective', cursor: null, limit: 100 },
  });

  it('reproduces the old bug: a date typed into search never matches a record', async () => {
    expect((await searchMonth(DRILL_DAY)).totalCount).toBe(0);
  });

  it('keeps the preview search on the Rust semantics: four columns, literal, ASCII case-insensitive', async () => {
    // dashboard-stats-v2 §4.1 item 5 and commands/mod.rs `append_search_filter`.
    const everything = await searchMonth('');
    const byMachine = await searchMonth('studio-pc');
    expect(byMachine.totalCount).toBeGreaterThan(0);
    expect(byMachine.items.every((item) => item.machineId === 'Studio-PC')).toBe(true);
    const byTool = await searchMonth('OPENCODE');
    expect(byTool.totalCount).toBeGreaterThan(0);
    expect(byTool.items.every((item) => item.tool === 'opencode')).toBe(true);
    const byModel = await searchMonth('opus-4-1');
    expect(byModel.totalCount).toBeGreaterThan(0);
    expect(byModel.items.every((item) => item.model === 'claude-opus-4-1')).toBe(true);
    const session = everything.items[0].sessionId;
    expect((await searchMonth(session.toUpperCase())).items.map((item) => item.sessionId)).toEqual([session]);
    // `%` and `_` are literals, not SQL wildcards; timestamps and costs are not searchable.
    expect((await searchMonth('%')).totalCount).toBe(0);
    expect((await searchMonth('_')).totalCount).toBe(0);
    expect((await searchMonth('14:')).totalCount).toBe(0);
    // Non-ASCII needles match case-sensitively and literally.
    expect((await searchMonth('Ｓｔｕｄｉｏ')).totalCount).toBe(0);
  });

  it('switches to a single-day range with cleared filters and lands on that day\'s records', async () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => result.current.details.setDetailFilters(ORIGIN_FILTERS));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY); });

    expect(result.current.range).toBe('custom');
    expect(result.current.customRange).toEqual({ start: DRILL_DAY, end: DRILL_DAY });
    expect(result.current.details.detailFilters).toEqual(EMPTY_DETAIL_FILTERS);
    expect(result.current.activeTab).toBe('logs');
    expect(result.current.drill.dayDrill?.origin).toEqual({ scope: 'local', tab: 'dashboard', range: 'month', customRange: null, filters: ORIGIN_FILTERS });

    const page = await loadDetails(result);
    expect(page.totalCount).toBeGreaterThan(0);
    expect(page.items.every((item) => localDay(item.timestamp) === DRILL_DAY)).toBe(true);
    // Every tool and model of that day, not just the ones the old filters kept.
    expect(new Set(page.items.map((item) => item.tool)).size).toBeGreaterThan(1);
  });

  it('narrows the day to the focused Agent when the drill comes from a focused calendar', () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY, { tools: ['codex'], models: [] }); });
    expect(result.current.details.detailFilters).toEqual({ ...EMPTY_DETAIL_FILTERS, tools: ['codex'] });
    expect(result.current.activeTab).toBe('logs');
    // 筛选仍是带进来的那一项时，复盘与「返回原范围」保持有效。
    expect(result.current.drill.dayDrill?.date).toBe(DRILL_DAY);

    // 用户自己改了筛选，复盘才失效。
    act(() => result.current.details.setDetailFilters({ ...EMPTY_DETAIL_FILTERS, tools: ['claude'] }));
    expect(result.current.drill.dayDrill).toBeNull();
  });

  it('narrows the day to the focused account and keeps the drill while that account stays selected', () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY, { tools: [], models: [], providers: ['relay'] }); });
    expect(result.current.details.detailFilters).toEqual({ ...EMPTY_DETAIL_FILTERS, providers: ['relay'] });
    expect(result.current.drill.dayDrill?.date).toBe(DRILL_DAY);

    // 移除账号筛选算用户改了条件，复盘失效。
    act(() => result.current.details.setDetailFilters({ ...EMPTY_DETAIL_FILTERS, providers: [] }));
    expect(result.current.drill.dayDrill).toBeNull();
  });

  it('returns to the remembered range, filters and page', () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => result.current.details.setDetailFilters(ORIGIN_FILTERS));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY); });
    act(() => result.current.drill.returnFromDayDrill());

    expect(result.current.range).toBe('month');
    expect(result.current.customRange).toBeNull();
    expect(result.current.details.detailFilters).toEqual(ORIGIN_FILTERS);
    expect(result.current.activeTab).toBe('dashboard');
    expect(result.current.drill.dayDrill).toBeNull();
  });

  it('forgets the origin for good once the user changes a filter', () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY); });
    act(() => result.current.details.updateDetailFilter('tools', ['claude']));
    expect(result.current.drill.dayDrill).toBeNull();
    // Undoing the change by hand does not bring the return chip back.
    act(() => result.current.details.updateDetailFilter('tools', []));
    expect(result.current.drill.dayDrill).toBeNull();
  });

  it('forgets the origin once the user picks another range', () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY); });
    expect(result.current.drill.dayDrill).not.toBeNull();
    act(() => result.current.changeRange('week'));
    expect(result.current.drill.dayDrill).toBeNull();
    act(() => result.current.changeRange('custom', { start: DRILL_DAY, end: DRILL_DAY }));
    expect(result.current.drill.dayDrill).toBeNull();
  });

  it('keeps the first origin when a drilled view drills again', () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY); });
    act(() => { result.current.drill.drillIntoDay('2026-07-11'); });
    expect(result.current.customRange).toEqual({ start: '2026-07-11', end: '2026-07-11' });
    expect(result.current.drill.dayDrill?.origin.range).toBe('month');
  });

  it('works under cloud scope too, landing on that day\'s cloud records (T10.185)', async () => {
    const { result } = renderHook(() => useAppSlice('cloud'));
    act(() => result.current.details.setDetailFilters(ORIGIN_FILTERS));
    let navigated = false;
    act(() => { navigated = result.current.drill.drillIntoDay(DRILL_DAY); });

    expect(navigated).toBe(true);
    expect(result.current.drill.dayDrillUnavailable).toBeNull();
    expect(result.current.range).toBe('custom');
    expect(result.current.customRange).toEqual({ start: DRILL_DAY, end: DRILL_DAY });
    expect(result.current.details.detailFilters).toEqual(EMPTY_DETAIL_FILTERS);
    expect(result.current.activeTab).toBe('logs');
    expect(result.current.drill.dayDrill?.origin).toEqual({ scope: 'cloud', tab: 'dashboard', range: 'month', customRange: null, filters: ORIGIN_FILTERS });

    const page = await loadDetails(result);
    expect(page.totalCount).toBeGreaterThan(0);
    expect(page.items.every((item) => localDay(item.timestamp) === DRILL_DAY)).toBe(true);
  });
});

describe('day drill and scope switches (T10.185: cloud can express a day too)', () => {
  beforeEach(() => {
    clearMocks();
    installDevMockTauri();
  });
  afterEach(() => clearMocks());

  it('keeps the review when the header switches to cloud in the same click', () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY); });
    act(() => result.current.selectScopeFromHeader('cloud'));

    expect(result.current.scope).toBe('cloud');
    // Cloud can express the day now (T10.185): the review is not interrupted.
    expect(result.current.range).toBe('custom');
    expect(result.current.customRange).toEqual({ start: DRILL_DAY, end: DRILL_DAY });
    expect(result.current.activeTab).toBe('logs');
    expect(result.current.drill.dayDrill?.date).toBe(DRILL_DAY);
    expect(result.current.notices).toHaveLength(0);
    // A committed frame does pair cloud scope with the single-day range now.
    expect(result.current.commits.some((commit) => commit.scope === 'cloud' && commit.range === 'custom' && commit.reviewing)).toBe(true);
  });

  it('keeps the review when the scope changes by any other path', () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY); });
    act(() => result.current.switchScope('cloud'));

    expect(result.current.commits.filter((commit) => commit.scope === 'cloud').every((commit) => commit.reviewing)).toBe(true);
    expect(result.current.range).toBe('custom');
    expect(result.current.drill.dayDrill?.date).toBe(DRILL_DAY);
    expect(result.current.notices).toHaveLength(0);
  });

  it('leaveForScope is a no-op for every scope: nothing refuses a single day any more', () => {
    const { result } = renderHook(() => useAppSlice('local'));
    act(() => { result.current.drill.drillIntoDay(DRILL_DAY); });
    let left = true;
    act(() => { left = result.current.drill.leaveForScope('local'); });
    expect(left).toBe(false);
    act(() => { left = result.current.drill.leaveForScope('cloud'); });
    expect(left).toBe(false);
    expect(result.current.drill.dayDrill?.date).toBe(DRILL_DAY);
    expect(result.current.notices).toHaveLength(0);
  });

  it('restores a device filter only within the scope it came from', () => {
    const origin: DayDrillOrigin = { scope: 'local', tab: 'dashboard', range: 'month', customRange: null, filters: ORIGIN_FILTERS };
    expect(originFiltersFor(origin, 'local')).toEqual(ORIGIN_FILTERS);
    expect(originFiltersFor(origin, 'cloud')).toEqual({ ...ORIGIN_FILTERS, machines: [] });
  });
});

describe('day drill helpers', () => {
  const drill = (range: RangeKey, customRange: CustomDateRange | null = null): DayDrill => ({
    date: '2026-09-12',
    origin: { scope: 'local', tab: 'dashboard', range, customRange, filters: EMPTY_DETAIL_FILTERS },
  });

  it('matches only the exact single day with empty filters', () => {
    const target = drill('month');
    const day = { start: '2026-09-12', end: '2026-09-12' };
    expect(isDayDrillQuery(target, 'custom', day, EMPTY_DETAIL_FILTERS)).toBe(true);
    expect(isDayDrillQuery(target, 'custom', { start: '2026-09-12', end: '2026-09-13' }, EMPTY_DETAIL_FILTERS)).toBe(false);
    expect(isDayDrillQuery(target, 'month', null, EMPTY_DETAIL_FILTERS)).toBe(false);
    expect(isDayDrillQuery(target, 'custom', day, { ...EMPTY_DETAIL_FILTERS, search: 'x' })).toBe(false);
    expect(isDayDrillQuery(target, 'custom', day, { ...EMPTY_DETAIL_FILTERS, machines: ['Studio-PC'] })).toBe(false);
  });

  it('names the day and the way back', () => {
    const now = new Date(2026, 8, 24);
    expect(dayDrillCopy(drill('month'), now)).toEqual({
      day: '9月12日',
      origin: '概览',
      returnLabel: '返回本月',
      returnAriaLabel: '返回本月：回到概览并恢复原筛选',
    });
    expect(dayDrillCopy(drill('all'), now).returnLabel).toBe('返回全部');
    expect(dayDrillCopy(drill('year'), now).returnLabel).toBe('返回今年');
    expect(dayDrillCopy(drill('custom', { start: '2026-08-01', end: '2026-09-30' }), now).returnLabel).toBe('返回8月1日—9月30日');
    expect(dayDrillCopy(drill('month'), new Date(2027, 0, 3)).day).toBe('2026年9月12日');
  });
});
